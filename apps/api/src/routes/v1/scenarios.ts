import type { FastifyReply, FastifyInstance } from 'fastify'
import type { EventBurst, Scenario, Webhook } from '@prisma/client'
import { z } from 'zod'
import { EVENTS_BY_SERVICE, SERVICE_CODES, findEvent, type ServiceCode } from '@apistend/shared'
import { prisma } from '../../db.ts'
import { env } from '../../env.ts'
import { sendError } from '../../lib/mgmt.ts'
import {
  isScenarioRunning, liveBursts, startBurst, stopBurst,
  type BurstError, type BurstStartResult,
} from '../../webhooks/burst.ts'
import {
  badRequest, conflict, defineRoute, notFound,
  page,
  pageChecked, pageArgs, pageQuery, pageResponse,
} from './_registry.ts'

/**
 * Сценарии симуляции и серии событий в виде публичного API.
 *
 * Обе сущности обслуживает один движок (webhooks/burst.ts): сценарий — это
 * сохранённая заготовка серии, серия — один её запуск. Держать их в разных
 * файлах значило бы дважды описывать один и тот же ответ о запущенной серии.
 *
 * Расписание серий живёт в памяти процесса, а в базу прогресс пишется раз
 * в секунду. Поэтому у идущей серии и sent, и фактическая скорость берутся
 * из памяти: иначе клиент, опрашивающий состояние чаще раза в секунду,
 * видел бы застывший счётчик и решил, что серия встала.
 */

const limitsSchema = z.object({
  maxCount: z.number(),
  maxRatePerSec: z.number(),
  maxConcurrent: z.number(),
})

/** BURST_MAX_COUNT / BURST_MAX_RATE / BURST_MAX_CONCURRENT — потолки инстанса, а не аккаунта. */
const burstLimits = {
  maxCount: env.burstMaxCount,
  maxRatePerSec: env.burstMaxRatePerSec,
  maxConcurrent: env.burstMaxConcurrent,
}

/**
 * serviceCode и event — свободные строки, а не z.enum.
 *
 * В базе они хранятся строками, и справочник событий пополняется быстрее, чем
 * чистятся старые песочницы. Схема ответа, перечисляющая только сегодняшние коды,
 * объявила бы существующие строки невалидными и врала бы в документации.
 */
const eventFields = { serviceCode: z.string(), event: z.string() }

const scenarioItem = z.object({
  id: z.string(),
  name: z.string(),
  ...eventFields,
  stepsCount: z.number(),
  ratePerSec: z.number(),
  errorRate: z.number(),
  /** Интервал между событиями. Хранится ради модели данных дизайна и всегда согласован с ratePerSec. */
  delayMs: z.number(),
  repeats: z.number(),
  status: z.string(),
  progress: z.number(),
  /** Идентификатор идущей серии — им же сценарий и останавливается: POST /bursts/{id}/stop. */
  runningBurstId: z.string().nullable(),
  /** Заполнена, только пока сценарий идёт: у завершённого фактическая скорость остаётся в lastRunNote. */
  actualRatePerSec: z.number().nullable(),
  /** true — приложение не успевало отвечать и серию притормаживали. */
  lagging: z.boolean(),
  lastRunAt: z.date().nullable(),
  lastRunNote: z.string().nullable(),
})

const burstItem = z.object({
  id: z.string(),
  state: z.enum(['running', 'done', 'stopped', 'interrupted']),
  /** sending — ещё шлём, settling — всё отправлено и ждём последние ответы. null у завершённой. */
  phase: z.enum(['sending', 'settling']).nullable(),
  webhookId: z.string(),
  scenarioId: z.string().nullable(),
  ...eventFields,
  count: z.number(),
  ratePerSec: z.number(),
  /** Что просил клиент до обрезки потолками. Отличие от count/ratePerSec и есть обрезка. */
  requestedCount: z.number(),
  requestedRatePerSec: z.number(),
  errorRate: z.number(),
  sent: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  actualRatePerSec: z.number().nullable(),
  /** Такты по 100 мс, пропущенные из-за неотвечающего приложения. null у завершённой: в базу счётчик не пишется. */
  throttledTicks: z.number().nullable(),
  elapsedMs: z.number().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  note: z.string().nullable(),
})

const burstAccepted = z.object({
  id: z.string(),
  scenarioId: z.string().nullable(),
  webhookId: z.string(),
  ...eventFields,
  /** Способ доставки — те же значения, что у поля target самой подписки. */
  target: z.enum(['local', 'public']),
  /** Куда пойдут события: полный адрес для public, путь на машине разработчика для local. */
  targetUrl: z.string(),
  count: z.number(),
  ratePerSec: z.number(),
  errorRate: z.number(),
  requestedCount: z.number(),
  requestedRatePerSec: z.number(),
  /** Пусто — приняли как просили. Иначе список того, что обрезано потолками. */
  capped: z.array(z.string()),
  estimatedSeconds: z.number(),
  limits: limitsSchema,
})

// ─────────────────────────── Отказы движка серий ───────────────────────────

/**
 * Коды отказа разведены по причинам: «нет вебхука», «вебхук на паузе»
 * и «агент не подключён» чинятся разными действиями, и клиенту нужно знать какими.
 *
 * TOO_MANY_BURSTS отвечает 422, хотя кабинет отвечает 429. В Management API
 * код 429 занят ограничением частоты запросов и приходит с Retry-After —
 * если бы им же отвечал потолок одновременных серий, клиент с обычной
 * логикой «429 → подождать Retry-After и повторить» уходил бы в бесконечный
 * повтор. Потолок продукта — это 422.
 */
const BURST_REFUSALS = {
  NO_WEBHOOK: [404, 'Вебхук не найден в этой песочнице'],
  WEBHOOK_PAUSED: [409, 'Вебхук на паузе или выключен — включите его перед запуском серии'],
  NO_AGENT: [409, 'Вебхук доставляет на localhost, а агент не подключён. Запустите apistend listen и повторите'],
  TOO_MANY_BURSTS: [
    422,
    `Уже идёт максимум серий для этой песочницы (${env.burstMaxConcurrent}). Дождитесь конца или остановите одну через POST /api/v1/bursts/{id}/stop`,
  ],
  BAD_PARAMS: [400, 'Количество и скорость должны быть положительными числами'],
} as const satisfies Record<BurstError, readonly [number, string]>

function refuseBurst(reply: FastifyReply, code: BurstError): never {
  const [status, message] = BURST_REFUSALS[code]
  return sendError(reply, status, code, message)
}

// ─────────────────────────── Общие помощники ───────────────────────────

type LiveBurst = ReturnType<typeof liveBursts>[number]

/** Событие сценария лежит первым шагом: цепочка шагов заложена моделью данных. */
function firstEvent(steps: unknown): string {
  const first = Array.isArray(steps) ? steps[0] : null
  return first && typeof first === 'object' && 'event' in first ? String((first as { event: unknown }).event) : ''
}

/**
 * Событие и его псевдоним в макете — один и тот же код с точки зрения поиска вебхука.
 *
 * Вебхук мог быть создан под любым из двух написаний (findEvent принимает оба),
 * и запуск серии по событию не должен зависеть от того, какое написание выбрал
 * тот, кто заводил подписку.
 */
function eventAliases(code: string): string[] {
  const def = findEvent(code)
  if (!def) return [code]
  return def.aliasInMockup ? [def.code, def.aliasInMockup] : [def.code]
}

/**
 * Вебхук, которому пойдут события заданного события.
 * Активный имеет приоритет: иначе при двух подписках на одно событие серия
 * упиралась бы в отказ WEBHOOK_PAUSED, хотя рабочая подписка есть.
 */
async function webhookForEvent(sandboxId: string, event: string, serviceCode?: string): Promise<Webhook | null> {
  const candidates = await prisma.webhook.findMany({
    where: {
      sandboxId,
      event: { in: eventAliases(event) },
      ...(serviceCode ? { serviceCode } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })
  return candidates.find((w) => w.status === 'active') ?? candidates[0] ?? null
}

/**
 * Проверка пары «сервис + событие».
 *
 * Событие ищется по коду среди всех сервисов сразу, поэтому без сверки
 * с serviceCode сохранялся бы сценарий, которому никогда не найдётся вебхука:
 * ONCRMDEALADD у Ozon не бывает.
 *
 * Возвращает канонический код (в шаг сценария кладём его, а не псевдоним
 * из макета) либо готовый отказ — отвечать помощник не должен, иначе
 * обработчику пришлось бы гадать, ушёл ответ или нет.
 */
function checkEvent(
  serviceCode: ServiceCode,
  event: string,
): { code: string } | { error: string; issues?: string[] } {
  const def = findEvent(event)
  if (!def) {
    return {
      error: `Событие «${event}» не поддерживается`,
      // Пустой список — у сценария из старой песочницы сервис мог остаться
      // такой, какого в справочнике больше нет; падать на подсказке незачем.
      issues: (EVENTS_BY_SERVICE[serviceCode] ?? []).map((e) => `${e.code} — ${e.title}`),
    }
  }
  if (def.serviceCode !== serviceCode) {
    return { error: `Событие «${event}» принадлежит сервису ${def.serviceCode}, а не ${serviceCode}` }
  }
  return { code: def.code }
}

/** delayMs и ratePerSec описывают одно и то же — расходиться им нельзя. */
function delayFor(ratePerSec: number): number {
  return Math.max(1, Math.round(1_000 / ratePerSec))
}

function scenarioView(s: Scenario, live: LiveBurst | undefined) {
  return {
    id: s.id,
    name: s.name,
    serviceCode: s.serviceCode,
    event: firstEvent(s.steps),
    stepsCount: s.stepsCount,
    ratePerSec: s.ratePerSec,
    errorRate: s.errorRate,
    delayMs: s.delayMs,
    repeats: s.repeats,
    // Состояние и прогресс идущей серии — из памяти: в базу они попадают раз в секунду.
    status: live ? 'running' : s.status,
    progress: live ? live.sent : s.progress,
    runningBurstId: live?.id ?? null,
    actualRatePerSec: live?.actualRatePerSec ?? null,
    lagging: live ? live.throttledTicks > 0 : false,
    lastRunAt: s.lastRunAt,
    lastRunNote: s.lastRunNote,
  }
}

/**
 * Фактическая скорость завершённой серии.
 *
 * Считается по всему времени жизни, включая ожидание последних ответов, поэтому
 * получается чуть ниже той, что видна во время отправки. Точное значение на момент
 * отправки движок записывает в note.
 */
function finishedRate(row: EventBurst): number | null {
  if (!row.finishedAt) return null
  const seconds = (row.finishedAt.getTime() - row.startedAt.getTime()) / 1000
  return seconds > 0.2 ? Math.round(row.sent / seconds) : null
}

function burstView(row: EventBurst, live: LiveBurst | undefined) {
  return {
    id: row.id,
    state: row.state,
    phase: live?.phase ?? null,
    webhookId: row.webhookId,
    scenarioId: row.scenarioId,
    serviceCode: row.serviceCode,
    event: row.event,
    count: row.count,
    ratePerSec: row.ratePerSec,
    requestedCount: row.requestedCount,
    requestedRatePerSec: row.requestedRatePerSec,
    errorRate: row.errorRate,
    sent: live ? live.sent : row.sent,
    succeeded: row.succeeded,
    failed: row.failed,
    actualRatePerSec: live ? live.actualRatePerSec : finishedRate(row),
    throttledTicks: live ? live.throttledTicks : null,
    elapsedMs: live
      ? live.elapsedMs
      : row.finishedAt
        ? row.finishedAt.getTime() - row.startedAt.getTime()
        : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    note: row.note,
  }
}

function acceptedView(
  started: BurstStartResult,
  extra: { webhookId: string; scenarioId: string | null; errorRate: number; requestedCount: number; requestedRatePerSec: number },
) {
  return {
    id: started.burstId,
    scenarioId: extra.scenarioId,
    webhookId: extra.webhookId,
    serviceCode: started.serviceCode,
    event: started.event,
    // Движок зовёт способ доставки transport, а адрес — target; в ресурсах API
    // target — это способ (как в подписке), адрес — targetUrl.
    target: started.transport,
    targetUrl: started.target,
    count: started.count,
    ratePerSec: started.ratePerSec,
    errorRate: extra.errorRate,
    requestedCount: extra.requestedCount,
    requestedRatePerSec: extra.requestedRatePerSec,
    capped: started.capped,
    estimatedSeconds: started.estimatedSeconds,
    limits: burstLimits,
  }
}

/** Идущие серии песочницы, разложенные по идентификатору сценария. */
async function liveByScenario(sandboxId: string): Promise<Map<string, LiveBurst>> {
  const live = liveBursts(sandboxId)
  if (live.length === 0) return new Map()
  const rows = await prisma.eventBurst.findMany({
    where: { id: { in: live.map((b) => b.id) } },
    select: { id: true, scenarioId: true },
  })
  const byScenario = new Map<string, LiveBurst>()
  for (const row of rows) {
    const burst = row.scenarioId ? live.find((b) => b.id === row.id) : undefined
    if (row.scenarioId && burst) byScenario.set(row.scenarioId, burst)
  }
  return byScenario
}

export function registerScenarioV1Routes(app: FastifyInstance): void {
  // ─────────────────────────── Сценарии ───────────────────────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/scenarios',
      scope: 'scenarios:read',
      summary: 'Список сценариев',
      description:
        'Сценарии песочницы по алфавиту. У идущего сценария status = running, ' +
        'а progress и actualRatePerSec берутся из памяти процесса, поэтому опрос чаще раза в секунду ' +
        'показывает движение, а не последнее записанное значение.',
      tags: ['Сценарии'],
      needsSandbox: true,
      query: pageQuery,
      response: pageResponse(scenarioItem),
    },
    async (ctx, input, _req, reply) => {
      const [rows, live] = await Promise.all([
        prisma.scenario.findMany({
          where: { sandboxId: ctx.sandbox.id },
          // Имя не уникально, поэтому вторым ключом идёт id: без него порядок
          // одноимённых сценариев не определён, и курсор мог бы перескочить запись.
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          ...pageArgs(input.query),
        }),
        liveByScenario(ctx.sandbox.id),
      ])
      return pageChecked(reply, rows, input.query, (s) => scenarioView(s, live.get(s.id)))
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/scenarios',
      scope: 'scenarios:write',
      summary: 'Создать сценарий',
      description:
        'Сценарий — сохранённая заготовка серии: событие, сколько его слать и с какой скоростью. ' +
        'Сам по себе он ничего не отправляет, запуск — POST /scenarios/{id}/run. ' +
        'Событие должно принадлежать указанному сервису, иначе вебхука для него не найдётся никогда.',
      tags: ['Сценарии'],
      needsSandbox: true,
      status: 201,
      body: z.object({
        name: z.string().min(1, 'Название не может быть пустым').max(80),
        serviceCode: z.enum(SERVICE_CODES),
        event: z.string().min(2).max(80),
        stepsCount: z.number().int().min(1).max(1_000_000),
        ratePerSec: z.number().int().min(1).max(10_000),
        errorRate: z.number().int().min(0).max(100).default(0),
      }),
      response: scenarioItem,
    },
    async (ctx, input, _req, reply) => {
      const checked = checkEvent(input.body.serviceCode, input.body.event)
      if ('error' in checked) return badRequest(reply, checked.error, checked.issues)

      const created = await prisma.scenario.create({
        data: {
          sandboxId: ctx.sandbox.id,
          name: input.body.name,
          serviceCode: input.body.serviceCode,
          stepsCount: input.body.stepsCount,
          ratePerSec: input.body.ratePerSec,
          delayMs: delayFor(input.body.ratePerSec),
          errorRate: input.body.errorRate,
          steps: [{ event: checked.code, ratePerSec: input.body.ratePerSec, errorRate: input.body.errorRate }],
        },
      })
      return scenarioView(created, undefined)
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/scenarios/:id',
      scope: 'scenarios:read',
      summary: 'Сценарий по идентификатору',
      description: 'Тот же объект, что и в списке. Годится для опроса прогресса запущенного сценария.',
      tags: ['Сценарии'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: scenarioItem,
    },
    async (ctx, input, _req, reply) => {
      const scenario = await prisma.scenario.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!scenario) return notFound(reply, 'Сценарий не найден')
      const live = await liveByScenario(ctx.sandbox.id)
      return scenarioView(scenario, live.get(scenario.id))
    },
  )

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/scenarios/:id',
      scope: 'scenarios:write',
      summary: 'Изменить сценарий',
      description:
        'Меняются только переданные поля. Идущий сценарий изменить нельзя: количество событий и скорость ' +
        'уже отданы в расписание, и правка расходилась бы с тем, что показывает прогресс. ' +
        'Остановите серию через POST /bursts/{id}/stop и повторите. ' +
        'Изменение ratePerSec пересчитывает delayMs, изменение события переписывает шаг сценария.',
      tags: ['Сценарии'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        name: z.string().min(1).max(80).optional(),
        serviceCode: z.enum(SERVICE_CODES).optional(),
        event: z.string().min(2).max(80).optional(),
        stepsCount: z.number().int().min(1).max(1_000_000).optional(),
        ratePerSec: z.number().int().min(1).max(10_000).optional(),
        errorRate: z.number().int().min(0).max(100).optional(),
      }),
      failures: ['CONFLICT'],
      response: scenarioItem,
    },
    async (ctx, input, _req, reply) => {
      if (Object.keys(input.body).length === 0) {
        return badRequest(reply, 'Тело запроса пустое: укажите хотя бы одно поле для изменения')
      }

      const scenario = await prisma.scenario.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!scenario) return notFound(reply, 'Сценарий не найден')
      if (isScenarioRunning(scenario.id)) {
        return conflict(reply, 'Сценарий выполняется — остановите серию и повторите')
      }

      const serviceCode = input.body.serviceCode ?? (scenario.serviceCode as ServiceCode)
      const event = input.body.event ?? firstEvent(scenario.steps)
      const ratePerSec = input.body.ratePerSec ?? scenario.ratePerSec
      const errorRate = input.body.errorRate ?? scenario.errorRate

      // Сверяем пару, только если её тронули: иначе переименование сценария
      // со старым, уже исчезнувшим из справочника событием стало бы невозможным.
      let stepEvent = event
      if (input.body.serviceCode || input.body.event) {
        const checked = checkEvent(serviceCode, event)
        if ('error' in checked) return badRequest(reply, checked.error, checked.issues)
        stepEvent = checked.code
      }

      const updated = await prisma.scenario.update({
        where: { id: scenario.id },
        data: {
          name: input.body.name ?? scenario.name,
          serviceCode,
          stepsCount: input.body.stepsCount ?? scenario.stepsCount,
          ratePerSec,
          delayMs: delayFor(ratePerSec),
          errorRate,
          steps: [{ event: stepEvent, ratePerSec, errorRate }],
        },
      })
      return scenarioView(updated, undefined)
    },
  )

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/scenarios/:id',
      scope: 'scenarios:write',
      summary: 'Удалить сценарий',
      description:
        'Необратимо. Записи о прошлых запусках остаются в /bursts, но теряют связь со сценарием — ' +
        'сколько их, сказано в ответе. Идущий сценарий удаляется только с force=true: ' +
        'иначе серия продолжила бы слать события, а следить за ней было бы уже нечем. ' +
        'С force=true серия сначала останавливается.',
      tags: ['Сценарии'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      query: z.object({
        force: z
          .enum(['true', 'false'])
          .default('false')
          .describe('true — остановить идущую серию и всё равно удалить сценарий'),
      }),
      response: z.object({
        ok: z.literal(true),
        id: z.string(),
        name: z.string(),
        /** Серии, оставшиеся без сценария. */
        detachedRuns: z.number(),
        /** Серия, остановленная ради удаления, — только при force=true. */
        stoppedBurstId: z.string().nullable(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const scenario = await prisma.scenario.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!scenario) return notFound(reply, 'Сценарий не найден')

      const running = (await liveByScenario(ctx.sandbox.id)).get(scenario.id) ?? null
      if (running && input.query.force !== 'true') {
        return conflict(
          reply,
          `Сценарий выполняется (серия ${running.id}, отправлено ${running.sent} из ${running.count}). ` +
            'Остановите её через POST /api/v1/bursts/{id}/stop или повторите с ?force=true',
        )
      }
      if (running) stopBurst(running.id)

      // Считаем до удаления: связь EventBurst → Scenario описана как SetNull,
      // после DELETE эти строки уже не найти по scenarioId.
      const detachedRuns = await prisma.eventBurst.count({ where: { scenarioId: scenario.id } })
      await prisma.scenario.delete({ where: { id: scenario.id } })

      return {
        ok: true as const,
        id: scenario.id,
        name: scenario.name,
        detachedRuns,
        stoppedBurstId: running?.id ?? null,
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/scenarios/:id/run',
      scope: 'scenarios:write',
      summary: 'Запустить сценарий',
      description:
        'Отвечает 202: серия принята и идёт в фоне, за прогрессом — GET /bursts/{id} или GET /scenarios/{id}. ' +
        'Вебхук подбирается по паре «сервис + событие» сценария, приоритет у активного. ' +
        'Сценарий не запускается поверх самого себя: две серии с одним scenarioId писали бы прогресс друг поверх друга. ' +
        'Если stepsCount или ratePerSec выше потолков инстанса, они обрезаются, и обрезка перечислена в capped.',
      tags: ['Сценарии'],
      needsSandbox: true,
      status: 202,
      params: z.object({ id: z.string().min(1) }),
      failures: ['CONFLICT', 'NOT_FOUND', 'UNPROCESSABLE'],
      response: burstAccepted,
    },
    async (ctx, input, _req, reply) => {
      const scenario = await prisma.scenario.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!scenario) return notFound(reply, 'Сценарий не найден')

      if (isScenarioRunning(scenario.id)) {
        return sendError(
          reply,
          409,
          'SCENARIO_RUNNING',
          'Сценарий уже выполняется — дождитесь конца или остановите серию',
        )
      }

      const event = firstEvent(scenario.steps)
      const webhook = await webhookForEvent(ctx.sandbox.id, event, scenario.serviceCode)
      if (!webhook) {
        return sendError(
          reply,
          409,
          'NO_WEBHOOK_FOR_EVENT',
          `Нет вебхука на событие «${event}» сервиса ${scenario.serviceCode} — событиям некуда идти. Создайте подписку и повторите`,
        )
      }

      const started = await startBurst({
        sandboxId: ctx.sandbox.id,
        webhookId: webhook.id,
        count: scenario.stepsCount,
        ratePerSec: scenario.ratePerSec,
        errorRate: scenario.errorRate,
        scenarioId: scenario.id,
      })
      if (typeof started === 'string') return refuseBurst(reply, started)

      return acceptedView(started, {
        webhookId: webhook.id,
        scenarioId: scenario.id,
        errorRate: scenario.errorRate,
        requestedCount: scenario.stepsCount,
        requestedRatePerSec: scenario.ratePerSec,
      })
    },
  )

  // ─────────────────────────── Серии событий ───────────────────────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/bursts',
      scope: 'bursts:read',
      summary: 'Серии событий',
      description:
        'Идущие и завершённые серии одним списком, свежие сверху. У идущей серии sent и actualRatePerSec ' +
        'берутся из памяти процесса и обновляются каждые 100 мс; у завершённой actualRatePerSec посчитана ' +
        'за всё время жизни серии, включая ожидание последних ответов, поэтому она чуть ниже — ' +
        'точное значение на момент отправки записано в note. ' +
        'Состояние interrupted означает серию, которую застал перезапуск сервера: расписание живёт в памяти и не переживает рестарт.',
      tags: ['Серии событий'],
      needsSandbox: true,
      query: pageQuery.extend({
        state: z.enum(['running', 'done', 'stopped', 'interrupted']).optional(),
        webhookId: z.string().min(1).optional(),
        scenarioId: z.string().min(1).optional(),
      }),
      response: pageResponse(burstItem).extend({ limits: limitsSchema }),
    },
    async (ctx, input, _req, reply) => {
      const rows = await prisma.eventBurst.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          ...(input.query.state ? { state: input.query.state } : {}),
          ...(input.query.webhookId ? { webhookId: input.query.webhookId } : {}),
          ...(input.query.scenarioId ? { scenarioId: input.query.scenarioId } : {}),
        },
        // id вторым ключом: две серии, запущенные в одну миллисекунду, иначе
        // встали бы в произвольном порядке и курсор мог бы пропустить одну из них.
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(input.query),
      })

      const live = new Map(liveBursts(ctx.sandbox.id).map((b) => [b.id, b]))
      return { ...pageChecked(reply, rows, input.query, (row) => burstView(row, live.get(row.id))), limits: burstLimits }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/bursts',
      scope: 'bursts:write',
      summary: 'Запустить серию событий',
      description:
        'Нагрузочная отправка: count событий со скоростью ratePerSec на один вебхук. Отвечает 202 — ' +
        'серия идёт в фоне, за прогрессом ходить в GET /bursts/{id}. ' +
        'Получателя задают либо webhookId, либо event (тогда вебхук ищется по событию, приоритет у активного) — ровно одно из двух. ' +
        'Значения выше потолков инстанса обрезаются, а не отвергаются: что именно обрезано, перечислено в capped, ' +
        'сами потолки — в limits. errorRate — доля доставок, которым сервер имитирует сбой отправки, ' +
        'чтобы проверить ветку обработки ошибок в приложении.',
      tags: ['Серии событий'],
      needsSandbox: true,
      status: 202,
      body: z.object({
        webhookId: z.string().min(1).optional(),
        event: z.string().min(2).max(80).optional(),
        // Потолки схемы намеренно выше потолков инстанса: обрезка должна быть
        // видна в capped, а не выглядеть ошибкой в теле запроса.
        count: z.number().int().min(1).max(1_000_000),
        ratePerSec: z.number().int().min(1).max(10_000),
        errorRate: z.number().int().min(0).max(100).default(0),
      }),
      failures: ['CONFLICT', 'NOT_FOUND', 'UNPROCESSABLE'],
      response: burstAccepted,
    },
    async (ctx, input, _req, reply) => {
      const { webhookId, event, count, ratePerSec, errorRate } = input.body
      if (Boolean(webhookId) === Boolean(event)) {
        return badRequest(
          reply,
          webhookId
            ? 'Укажите либо webhookId, либо event: при обоих непонятно, какой из них главный'
            : 'Укажите, куда слать события: webhookId или event',
        )
      }

      const webhook = webhookId
        ? await prisma.webhook.findFirst({ where: { id: webhookId, sandboxId: ctx.sandbox.id } })
        : await webhookForEvent(ctx.sandbox.id, event!)
      if (!webhook) {
        return webhookId
          ? notFound(reply, 'Вебхук не найден')
          : sendError(reply, 404, 'NO_WEBHOOK', `Нет вебхука на событие «${event}» — создайте подписку и повторите`)
      }

      const started = await startBurst({
        sandboxId: ctx.sandbox.id,
        webhookId: webhook.id,
        count,
        ratePerSec,
        errorRate,
      })
      if (typeof started === 'string') return refuseBurst(reply, started)

      return acceptedView(started, {
        webhookId: webhook.id,
        scenarioId: null,
        errorRate,
        requestedCount: count,
        requestedRatePerSec: ratePerSec,
      })
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/bursts/:id',
      scope: 'bursts:read',
      summary: 'Состояние серии',
      description:
        'Тот же объект, что и в списке. Пока серия идёт, phase показывает, шлём мы ещё события (sending) ' +
        'или уже ждём последние ответы (settling), а throttledTicks — сколько тактов по 100 мс серию ' +
        'притормаживали из-за того, что приложение не успевало отвечать.',
      tags: ['Серии событий'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: burstItem,
    },
    async (ctx, input, _req, reply) => {
      const row = await prisma.eventBurst.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!row) return notFound(reply, 'Серия не найдена')
      return burstView(row, liveBursts(ctx.sandbox.id).find((b) => b.id === row.id))
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/bursts/:id/stop',
      scope: 'bursts:write',
      summary: 'Остановить серию',
      description:
        'Останавливает отправку. Уже отправленные события не отзываются — доставки останутся в журнале, ' +
        'а серия перейдёт в состояние stopped в течение секунды, дописав итог в note. ' +
        'В ответе — сколько событий успело уйти к моменту остановки. ' +
        'Завершённая серия даёт 409: останавливать в ней нечего.',
      tags: ['Серии событий'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      failures: ['CONFLICT'],
      response: z.object({
        id: z.string(),
        stopped: z.literal(true),
        /** Отправлено на момент остановки. */
        sent: z.number(),
        count: z.number(),
        scenarioId: z.string().nullable(),
        note: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const row = await prisma.eventBurst.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!row) return notFound(reply, 'Серия не найдена')

      // Память, а не поле state: строка остаётся running ещё секунду после того,
      // как серия фактически закончилась, — итог пишется в базу по завершении.
      const live = liveBursts(ctx.sandbox.id).find((b) => b.id === row.id)
      if (!live) return conflict(reply, `Серия уже не идёт: состояние «${row.state}»`)
      stopBurst(row.id)

      return {
        id: row.id,
        stopped: true as const,
        sent: live.sent,
        count: live.count,
        scenarioId: row.scenarioId,
        note: `Отправка прекращена на ${live.sent} событии из ${live.count}. Уже отправленное отозвать нельзя`,
      }
    },
  )
}
