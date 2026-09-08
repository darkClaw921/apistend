import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  EVENTS_BY_SERVICE, SERVICE_CODES, SERVICE_PROFILES, findEvent, normalizeForward,
} from '@apistend/shared'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { dispatchWebhook } from '../webhooks/dispatcher.ts'
import { liveBursts, startBurst, stopBurst } from '../webhooks/burst.ts'
import { checkPublicTarget } from '../lib/webhook-target.ts'
import { sessionSummary } from '../tunnel/registry.ts'
import { SESSION_TOKEN_TTL, newSessionToken } from '../tunnel/server.ts'
import { tunnelDisplayId } from '../lib/ids.ts'
import { hashApiKey } from '../lib/keys.ts'
import { env } from '../env.ts'

/** Экран «Вебхуки и сценарии» плюс серверная часть команды `apistend listen`. */

/** ws(s)://<хост запроса>/v1/tunnel/connect */
function tunnelConnectUrl(req: { headers: Record<string, unknown>; protocol?: string }): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
  if (host.length === 0) return `${env.publicOrigin.replace(/^http/, 'ws')}/v1/tunnel/connect`
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http')
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}/v1/tunnel/connect`
}

const createWebhook = z.object({
  serviceCode: z.enum(SERVICE_CODES),
  event: z.string().min(2).max(80),
  target: z.enum(['public', 'local']),
  targetUrl: z.string().max(2_000).optional(),
  targetPath: z.string().max(500).optional(),
  // Список, а не свободная строка: пустое значение и мусор доходили до журнала
  // доставок и до самого запроса.
  httpMethod: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
})

const burstInput = z.object({
  count: z.number().int().min(1).max(1_000_000),
  ratePerSec: z.number().int().min(1).max(10_000),
  errorRate: z.number().int().min(0).max(100).optional(),
})

/** Коды отказа серии разведены, потому что чинятся по-разному. */
const BURST_ERRORS = {
  NO_WEBHOOK: [404, 'Вебхук не найден'],
  WEBHOOK_PAUSED: [409, 'Вебхук на паузе — включите его перед запуском серии'],
  NO_AGENT: [409, 'Локальный агент не подключён. Запустите apistend listen и повторите'],
  TOO_MANY_BURSTS: [429, 'Уже идёт максимум серий для этой песочницы'],
  BAD_PARAMS: [400, 'Количество и скорость должны быть положительными числами'],
} as const satisfies Record<string, readonly [number, string]>

const burstErrorStatus = (code: keyof typeof BURST_ERRORS) => BURST_ERRORS[code][0]
const burstErrorBody = (code: keyof typeof BURST_ERRORS) => ({ error: code, message: BURST_ERRORS[code][1] })

/** Событие сценария лежит первым шагом: модель данных дизайна описывает цепочку шагов. */
function firstEvent(steps: unknown): string {
  const first = Array.isArray(steps) ? steps[0] : null
  return first && typeof first === 'object' && 'event' in first ? String((first as { event: unknown }).event) : ''
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  /** Справочник событий для формы создания вебхука. */
  app.get('/api/events', async (_req, reply) =>
    reply.send({
      services: SERVICE_CODES.map((code) => ({
        code,
        title: SERVICE_PROFILES[code].title,
        webhook: {
          contentType: SERVICE_PROFILES[code].webhook.contentType,
          timeoutMs: SERVICE_PROFILES[code].webhook.timeoutMs,
          retries: SERVICE_PROFILES[code].webhook.retryDelaysMs.length,
          successRule: SERVICE_PROFILES[code].webhook.successRule,
          signature: SERVICE_PROFILES[code].webhook.signature,
          notes: SERVICE_PROFILES[code].webhook.notes,
        },
        events: EVENTS_BY_SERVICE[code].map((e) => ({
          code: e.code,
          title: e.title,
          aliasInMockup: e.aliasInMockup ?? null,
        })),
      })),
    }),
  )

  app.get('/api/webhooks', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const [webhooks, deliveries, scenarios] = await Promise.all([
      prisma.webhook.findMany({ where: { sandboxId: ctx.sandbox.id }, orderBy: { createdAt: 'asc' } }),
      prisma.webhookDelivery.findMany({
        where: { sandboxId: ctx.sandbox.id },
        orderBy: { timestamp: 'desc' },
        take: 30,
      }),
      prisma.scenario.findMany({ where: { sandboxId: ctx.sandbox.id }, orderBy: { name: 'asc' } }),
    ])

    const running = liveBursts(ctx.sandbox.id)
    const runningRows = running.length > 0
      ? await prisma.eventBurst.findMany({
          where: { id: { in: running.map((b) => b.id) } },
          select: { id: true, scenarioId: true },
        })
      : []
    const runningByScenario = new Map(
      runningRows.filter((r) => r.scenarioId).map((r) => [r.scenarioId!, r.id]),
    )

    const stats = deliveries.reduce(
      (acc, d) => {
        if (d.state === 'succeeded') acc.succeeded++
        else if (d.state === 'failed' || d.state === 'no_response') acc.failed++
        else if (d.attempt > 1) acc.retried++
        return acc
      },
      { succeeded: 0, failed: 0, retried: 0 },
    )

    return reply.send({
      // Состояние локального агента — полоса «Доставка на локальное приложение».
      localAgent: sessionSummary(ctx.sandbox.id),
      webhooks: webhooks.map((w) => ({
        id: w.id,
        serviceCode: w.serviceCode,
        event: w.event,
        httpMethod: w.httpMethod,
        target: w.target,
        // Для локальной доставки в модели лежит относительный путь: базу даёт CLI.
        targetUrl: w.targetUrl,
        targetPath: w.targetPath,
        status: w.status,
        lastAttemptAt: w.lastAttemptAt,
        successRate24h: w.successRate24h,
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        event: d.event,
        serviceCode: d.serviceCode,
        timestamp: d.timestamp,
        state: d.state,
        attempt: d.attempt,
        maxAttempts: d.maxAttempts,
        statusCode: d.statusCode,
        durationMs: d.durationMs,
        targetDisplay: d.targetDisplay,
        contentType: d.contentType,
        rawBody: d.rawBody,
        errorMessage: d.errorMessage,
      })),
      deliveryStats: stats,
      scenarios: scenarios.map((s) => {
        // Прогресс идущей серии берём из памяти: в базу он пишется раз в секунду,
        // а полоса на экране должна двигаться, а не прыгать.
        const live = running.find((b) => b.id === runningByScenario.get(s.id))
        return {
          id: s.id, name: s.name, serviceCode: s.serviceCode, event: firstEvent(s.steps),
          stepsCount: s.stepsCount, status: live ? 'running' : s.status,
          ratePerSec: s.ratePerSec, errorRate: s.errorRate,
          progress: live ? live.sent : s.progress,
          actualRatePerSec: live?.actualRatePerSec ?? null,
          lagging: live ? live.throttledTicks > 0 : false,
          lastRunAt: s.lastRunAt, lastRunNote: s.lastRunNote,
        }
      }),
      burstLimits: {
        maxRatePerSec: env.burstMaxRatePerSec,
        maxCount: env.burstMaxCount,
        maxConcurrent: env.burstMaxConcurrent,
      },
      forwardBase: env.publicOrigin,
    })
  })

  app.post('/api/webhooks', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = createWebhook.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const input = parsed.data

    const event = findEvent(input.event)
    if (!event) {
      return reply.code(400).send({ error: 'UNKNOWN_EVENT', message: `Событие «${input.event}» не поддерживается` })
    }
    // Событие принадлежит сервису: ONCRMDEALADD не бывает у Ozon. Без этой
    // проверки создавался вебхук, который никогда не сработает, — событие
    // ищется по коду среди всех сервисов сразу.
    if (event.serviceCode !== input.serviceCode) {
      return reply.code(400).send({
        error: 'EVENT_SERVICE_MISMATCH',
        message: `Событие «${input.event}» принадлежит сервису ${event.serviceCode}, а не ${input.serviceCode}`,
      })
    }

    if (input.target === 'public') {
      if (!input.targetUrl || !/^https?:\/\//.test(input.targetUrl)) {
        return reply.code(400).send({ error: 'VALIDATION', message: 'Укажите полный адрес получателя' })
      }
      // Запрос по этому адресу сделает сервер APIStend — значит адрес нужно проверить.
      const verdict = await checkPublicTarget(input.targetUrl)
      if (!verdict.ok) {
        return reply.code(400).send({ error: 'TARGET_NOT_ALLOWED', message: verdict.reason })
      }
    } else if (!input.targetPath?.startsWith('/')) {
      return reply.code(400).send({
        error: 'VALIDATION',
        message: 'Для локальной доставки укажите путь, начинающийся со слэша — базовый адрес задаёт apistend listen',
      })
    }

    const created = await prisma.webhook.create({
      data: {
        sandboxId: ctx.sandbox.id,
        serviceCode: input.serviceCode,
        event: input.event,
        httpMethod: input.httpMethod,
        target: input.target,
        targetUrl: input.target === 'public' ? input.targetUrl! : null,
        targetPath: input.target === 'local' ? input.targetPath! : null,
        secret: `stend_whsec_${randomBytes(8).toString('hex')}`,
      },
    })
    return reply.code(201).send({ id: created.id, secret: created.secret })
  })

  /** Кнопка «Тест» в строке вебхука. */
  app.post<{ Params: { id: string } }>('/api/webhooks/:id/test', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const result = await dispatchWebhook({
      sandboxId: ctx.sandbox.id,
      webhookId: req.params.id,
      isTest: true,
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(result)
  })

  app.post<{ Params: { id: string } }>('/api/webhooks/:id/toggle', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const w = await prisma.webhook.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!w) return reply.code(404).send({ error: 'NOT_FOUND' })
    const updated = await prisma.webhook.update({
      where: { id: w.id },
      data: { status: w.status === 'paused' ? 'active' : 'paused' },
    })
    return reply.send({ id: updated.id, status: updated.status })
  })

  /** «Повторить ошибочные» — доступно только для сервисов, которые вообще делают повторы. */
  app.post('/api/webhooks/retry-failed', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const failed = await prisma.webhookDelivery.findMany({
      where: { sandboxId: ctx.sandbox.id, state: { in: ['failed', 'no_response'] } },
      take: 50,
    })
    let queued = 0
    for (const d of failed) {
      const profile = SERVICE_PROFILES[d.serviceCode as keyof typeof SERVICE_PROFILES]
      // Боевой Bitrix24 повторов не делает вовсе — мок не должен быть добрее.
      if (profile.webhook.retryDelaysMs.length === 0) continue
      await prisma.webhookDelivery.update({
        where: { id: d.id },
        data: { state: 'queued', attempt: 1, nextRetryAt: null },
      })
      queued++
    }
    return reply.send({ queued, skipped: failed.length - queued })
  })

  // ─────────── Сценарии симуляции ───────────

  const scenarioInput = z.object({
    name: z.string().min(1).max(80),
    serviceCode: z.enum(SERVICE_CODES),
    event: z.string().min(2).max(80),
    stepsCount: z.number().int().min(1).max(1_000_000),
    ratePerSec: z.number().int().min(1).max(10_000),
    errorRate: z.number().int().min(0).max(100).default(0),
  })

  app.post('/api/scenarios', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const parsed = scenarioInput.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const input = parsed.data
    if (!findEvent(input.event)) {
      return reply.code(400).send({ error: 'UNKNOWN_EVENT', message: `Событие «${input.event}» не поддерживается` })
    }
    const created = await prisma.scenario.create({
      data: {
        sandboxId: ctx.sandbox.id,
        name: input.name,
        serviceCode: input.serviceCode,
        stepsCount: input.stepsCount,
        ratePerSec: input.ratePerSec,
        // delayMs держим согласованным со скоростью: поле осталось от модели данных дизайна.
        delayMs: Math.max(1, Math.round(1_000 / input.ratePerSec)),
        errorRate: input.errorRate,
        steps: [{ event: input.event, ratePerSec: input.ratePerSec, errorRate: input.errorRate }],
      },
    })
    return reply.code(201).send({ id: created.id })
  })

  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const { count } = await prisma.scenario.deleteMany({
      where: { id: req.params.id, sandboxId: ctx.sandbox.id },
    })
    return count > 0 ? reply.send({ deleted: true }) : reply.code(404).send({ error: 'NOT_FOUND' })
  })

  /** Запуск сценария — та же серия, только помеченная сценарием. */
  app.post<{ Params: { id: string } }>('/api/scenarios/:id/run', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const scenario = await prisma.scenario.findFirst({
      where: { id: req.params.id, sandboxId: ctx.sandbox.id },
    })
    if (!scenario) return reply.code(404).send({ error: 'NOT_FOUND' })

    const event = firstEvent(scenario.steps)
    const webhook = await prisma.webhook.findFirst({
      where: { sandboxId: ctx.sandbox.id, serviceCode: scenario.serviceCode, event },
    })
    if (!webhook) {
      return reply.code(409).send({
        error: 'NO_WEBHOOK_FOR_EVENT',
        message: `Нет вебхука на событие «${event}» — создайте его, иначе событиям некуда идти`,
      })
    }

    const result = await startBurst({
      sandboxId: ctx.sandbox.id,
      webhookId: webhook.id,
      count: scenario.stepsCount,
      ratePerSec: scenario.ratePerSec,
      errorRate: scenario.errorRate,
      scenarioId: scenario.id,
    })
    if (typeof result === 'string') return reply.code(burstErrorStatus(result)).send(burstErrorBody(result))
    return reply.code(202).send(result)
  })

  app.post<{ Params: { id: string } }>('/api/scenarios/:id/stop', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const burst = await prisma.eventBurst.findFirst({
      where: { sandboxId: ctx.sandbox.id, scenarioId: req.params.id, state: 'running' },
    })
    if (!burst) return reply.code(404).send({ error: 'NOT_RUNNING' })
    return reply.send({ stopped: stopBurst(burst.id) })
  })

  // ─────────── Серии событий: нагрузочное тестирование ───────────

  /**
   * Запуск серии: сколько событий и с какой скоростью.
   * Отвечает 202: серия принята и идёт в фоне, за прогрессом — GET /api/bursts.
   */
  app.post<{ Params: { id: string } }>('/api/webhooks/:id/burst', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = burstInput.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }

    const result = await startBurst({
      sandboxId: ctx.sandbox.id,
      webhookId: req.params.id,
      count: parsed.data.count,
      ratePerSec: parsed.data.ratePerSec,
      errorRate: parsed.data.errorRate,
    })
    if (typeof result === 'string') return reply.code(burstErrorStatus(result)).send(burstErrorBody(result))
    return reply.code(202).send(result)
  })

  /** Идущие серии — из памяти, завершённые — из базы. */
  app.get('/api/bursts', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const recent = await prisma.eventBurst.findMany({
      where: { sandboxId: ctx.sandbox.id, state: { not: 'running' } },
      orderBy: { startedAt: 'desc' },
      take: 10,
    })
    return reply.send({
      running: liveBursts(ctx.sandbox.id),
      recent: recent.map((b) => ({
        id: b.id,
        event: b.event,
        serviceCode: b.serviceCode,
        state: b.state,
        count: b.count,
        ratePerSec: b.ratePerSec,
        sent: b.sent,
        succeeded: b.succeeded,
        failed: b.failed,
        startedAt: b.startedAt,
        finishedAt: b.finishedAt,
        note: b.note,
      })),
      limits: {
        maxRatePerSec: env.burstMaxRatePerSec,
        maxCount: env.burstMaxCount,
        maxConcurrent: env.burstMaxConcurrent,
      },
    })
  })

  app.post<{ Params: { id: string } }>('/api/bursts/:id/stop', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const burst = await prisma.eventBurst.findFirst({
      where: { id: req.params.id, sandboxId: ctx.sandbox.id },
    })
    if (!burst) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({ stopped: stopBurst(burst.id) })
  })

  // ─────────── Серверная часть CLI ───────────

  /**
   * Создание сессии туннеля. Авторизация — серверным ключом stend_sk_.
   * В ответ одноразовый токен с TTL 10 минут, которым CLI поднимает WebSocket.
   */
  app.post('/v1/tunnel/sessions', async (req, reply) => {
    const auth = req.headers.authorization
    const raw = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? auth.trim() : null
    if (!raw) return reply.code(401).send({ error: 'NO_KEY', message: 'Требуется серверный ключ stend_sk_' })

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(raw) },
      include: { sandbox: true },
    })
    if (!apiKey || apiKey.status === 'revoked') {
      return reply.code(401).send({ error: 'INVALID_KEY', message: 'Ключ не найден или отозван' })
    }
    if (apiKey.kind !== 'server') {
      return reply.code(400).send({
        error: 'WRONG_KEY_KIND',
        message: 'Это ключ песочницы. Для CLI нужен серверный ключ stend_sk_ — создайте его в разделе «Ключи и токены».',
      })
    }

    const body = (req.body ?? {}) as { deviceId?: string; deviceName?: string; agentVersion?: string; forward?: string }
    const deviceId = body.deviceId ?? randomBytes(8).toString('hex')
    const forward = normalizeForward(body.forward ?? 'localhost:3000')
    if (!forward) {
      return reply.code(400).send({
        error: 'FORWARD_NOT_LOCAL',
        message: 'Адрес пересылки должен быть локальным: localhost, 127.0.0.1 или ::1',
      })
    }

    const { token, hash } = newSessionToken()
    const session = await prisma.tunnelSession.create({
      data: {
        sandboxId: apiKey.sandboxId,
        apiKeyId: apiKey.id,
        // Идентификатор стабилен для устройства: при обрыве связи в интерфейсе ничего не мигает.
        displayId: tunnelDisplayId(deviceId),
        tokenHash: hash,
        deviceId,
        deviceName: body.deviceName ?? null,
        agentVersion: body.agentVersion ?? 'apistend-cli',
        forwardUrl: forward,
        signingSecret: `stend_whsec_${randomBytes(8).toString('hex')}`,
        expiresAt: new Date(Date.now() + SESSION_TOKEN_TTL),
      },
    })

    return reply.code(201).send({
      sessionToken: token,
      sessionId: session.id,
      displayId: session.displayId,
      signingSecret: session.signingSecret,
      sandbox: apiKey.sandbox.name,
      // Баннер CLI показывает проект, а не дублирует имя песочницы.
      account: apiKey.sandbox.project,
      // Адрес берём из самого запроса, а не из конфигурации: за прокси и в тестах
      // публичный origin и фактический хост различаются, а агент должен вернуться
      // ровно на тот инстанс, который выдал сессию.
      connectUrl: tunnelConnectUrl(req),
      expiresIn: Math.floor(SESSION_TOKEN_TTL / 1000),
    })
  })

  /** Состояние агента — команда `apistend status`. */
  app.get('/v1/tunnel/status', async (req, reply) => {
    const auth = req.headers.authorization
    const raw = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? auth.trim() : null
    if (!raw) return reply.code(401).send({ error: 'NO_KEY' })

    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) }, include: { sandbox: true } })
    if (!apiKey || apiKey.status === 'revoked') return reply.code(401).send({ error: 'INVALID_KEY' })

    return reply.send({
      account: apiKey.sandbox.project,
      sandbox: apiKey.sandbox.name,
      keyName: apiKey.name,
      ...sessionSummary(apiKey.sandboxId),
    })
  })

  /** Команда `apistend trigger <event>` — то же, что кнопка «Тест». */
  app.post('/v1/tunnel/trigger', async (req, reply) => {
    const auth = req.headers.authorization
    const raw = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? auth.trim() : null
    if (!raw) return reply.code(401).send({ error: 'NO_KEY' })

    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } })
    if (!apiKey || apiKey.status === 'revoked') return reply.code(401).send({ error: 'INVALID_KEY' })

    const { event } = (req.body ?? {}) as { event?: string }
    if (!event) return reply.code(400).send({ error: 'NO_EVENT', message: 'Укажите событие' })

    const webhook = await prisma.webhook.findFirst({
      where: { sandboxId: apiKey.sandboxId, event },
    })
    if (!webhook) {
      const known = await prisma.webhook.findMany({
        where: { sandboxId: apiKey.sandboxId },
        select: { event: true },
      })
      return reply.code(404).send({
        error: 'NO_WEBHOOK',
        message: `Нет вебхука на событие «${event}»`,
        available: known.map((w) => w.event),
      })
    }

    // Без count/rate — одиночная отправка, как кнопка «Тест».
    const body = (req.body ?? {}) as { count?: number; rate?: number; errorRate?: number }
    if (!body.count && !body.rate) {
      const result = await dispatchWebhook({ sandboxId: apiKey.sandboxId, webhookId: webhook.id, isTest: true })
      return reply.send(result)
    }

    const burst = await startBurst({
      sandboxId: apiKey.sandboxId,
      webhookId: webhook.id,
      count: body.count ?? body.rate ?? 1,
      ratePerSec: body.rate ?? 1,
      errorRate: body.errorRate,
    })
    if (typeof burst === 'string') return reply.code(burstErrorStatus(burst)).send(burstErrorBody(burst))
    return reply.code(202).send(burst)
  })

  /** Прогресс серий для `apistend trigger --watch`: авторизация серверным ключом. */
  app.get('/v1/tunnel/bursts', async (req, reply) => {
    const auth = req.headers.authorization
    const raw = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? auth.trim() : null
    if (!raw) return reply.code(401).send({ error: 'NO_KEY' })
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } })
    if (!apiKey || apiKey.status === 'revoked') return reply.code(401).send({ error: 'INVALID_KEY' })

    const running = liveBursts(apiKey.sandboxId)
    const finished = await prisma.eventBurst.findMany({
      where: { sandboxId: apiKey.sandboxId, state: { not: 'running' } },
      orderBy: { startedAt: 'desc' },
      take: 5,
    })
    return reply.send({
      running,
      recent: finished.map((b) => ({
        id: b.id, state: b.state, sent: b.sent, count: b.count,
        succeeded: b.succeeded, failed: b.failed, note: b.note,
      })),
    })
  })
}
