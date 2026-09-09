import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { SCENARIOS, SERVICE_CODES, SERVICE_PROFILES, nativeResponseHeaders } from '@apistend/shared'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { engine } from '../gateway.ts'
import { gatewayRequestId } from '../lib/ids.ts'
import { rateSnapshot, withLiveTimeObject } from '../lib/native-response.ts'
import { enqueueRequestLog } from '../lib/log-buffer.ts'
import { checkRateLimit } from '../lib/rate-limit.ts'
import { env } from '../env.ts'
import { maskSecretsInText } from '../lib/keys.ts'
import { maskHeaders } from '../lib/mask-log.ts'

/**
 * Консоль запросов — серверный прокси.
 *
 * Браузерная консоль НЕ ходит в мок напрямую. Причина продуктовая, а не техническая:
 * боевой Ozon с 16.05.2025 запрещает запросы из браузера, а WB не отдаёт CORS вовсе.
 * Если бы мок повторял это поведение буквально, собственная консоль APIStend перестала бы
 * работать. Прокси снимает конфликт и попутно даёт то, что нарисовано в панели деталей
 * лога: IP клиента и полный боевой URL.
 *
 * Произвольный URL сюда передать нельзя — только сервис и путь. Иначе эндпоинт
 * превратился бы в открытый SSRF-прокси.
 */

const executeBody = z.object({
  serviceCode: z.enum(SERVICE_CODES),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  path: z.string().min(1).max(2_000).startsWith('/', 'Путь должен начинаться со слэша'),
  query: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  scenario: z.enum(SCENARIOS).default('success'),
  apiKeyId: z.string().optional(),
  delayMs: z.number().int().min(0).max(3_000).optional(),
})

export function registerConsoleRoutes(app: FastifyInstance): void {
  app.post('/api/console/execute', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = executeBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const input = parsed.data

    // Ключ выбирается с учётом прав: у ключей песочницы разный набор сервисов,
    // и брать просто первый по дате — значит ловить 400 на ровном месте.
    // Явно выбранный пользователем ключ уважаем как есть.
    const apiKey = input.apiKeyId
      ? await prisma.apiKey.findFirst({ where: { id: input.apiKeyId, sandboxId: ctx.sandbox.id } })
      // Любой активный ключ песочницы подходит: ключ открывает все сервисы стенда.
      // Раньше здесь искали ключ с нужным сервисом, и в день появления четвёртого
      // сервиса консоль перестала работать у всех, чьи ключи выданы раньше.
      : await prisma.apiKey.findFirst({
          where: { sandboxId: ctx.sandbox.id, status: { not: 'revoked' }, kind: 'sandbox' },
          orderBy: { createdAt: 'asc' },
        })

    if (!apiKey) {
      return reply.code(400).send({
        error: 'NO_KEY',
        message: 'Нет активного ключа песочницы. Создайте ключ.',
      })
    }

    const reqId = gatewayRequestId(input.serviceCode)
    const startedAt = process.hrtime.bigint()
    const startedMs = Date.now()

    const rate = checkRateLimit(apiKey.id, input.serviceCode, Date.now())
    const scenario = rate.allowed ? input.scenario : 'rate_limit'

    // Таймаут показываем сразу, не занимая соединение на 30 секунд:
    // консоль обязана оставаться отзывчивой.
    if (scenario === 'timeout') {
      return reply.send({
        requestId: reqId,
        status: 504,
        statusText: 'Ответ дольше 30 секунд',
        durationMs: 30_000,
        sizeBytes: 0,
        headers: {},
        body: null,
        scenario,
        simulated: true,
        note: 'Сценарий «Таймаут 30 с»: боевой сервис оборвал бы соединение по времени ожидания',
      })
    }

    const result = engine.handle({
      service: input.serviceCode,
      httpMethod: input.httpMethod,
      path: input.path,
      query: input.query,
      headers: input.headers,
      body: input.body ?? null,
      requestId: reqId,
      scenario,
      now: new Date(),
      salt: ctx.sandbox.dataVolume,
    })

    const delay = input.delayMs ?? Math.min(ctx.sandbox.latencyMs, result.latencyMs)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))

    // Консоль показывает ответ целиком, как его увидит клиентская библиотека:
    // боевые заголовки сервиса поверх служебных заголовков APIStend и живой
    // конверт time у Битрикс24. Иначе один и тот же вызов выглядел бы в консоли
    // и в curl по-разному.
    const headers = {
      ...result.headers,
      ...nativeResponseHeaders(input.serviceCode, {
        requestId: reqId,
        rate:
          scenario === 'rate_limit'
            ? { ...rateSnapshot(rate), remaining: 0 }
            : rateSnapshot(rate),
        limited: scenario === 'rate_limit',
      }),
      'x-apistend-request-id': reqId,
    }
    const body = withLiveTimeObject(
      input.serviceCode,
      result.responseSource === 'error',
      result.body,
      startedMs,
    )
    const payload = JSON.stringify(body ?? null)
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000)
    const upstreamUrl = result.method ? `${result.method.upstreamHost}${input.path}` : null

    enqueueRequestLog({
      sandboxId: ctx.sandbox.id,
      apiKeyId: apiKey.id,
      publicId: reqId,
      serviceCode: input.serviceCode,
      httpMethod: input.httpMethod,
      endpoint: input.path,
      statusCode: result.status,
      durationMs,
      sizeBytes: Buffer.byteLength(payload),
      upstreamUrl,
      clientIp: req.ip,
      scenario,
      responseSource: result.responseSource,
      // Ключ песочницы приезжает и в заголовках, и в теле (у Bitrix24 это
      // штатный параметр auth). Журнал — это данные пользователя, они хранятся,
      // и без маскирования рабочий ключ лежал бы в базе открытым текстом.
      requestHeaders: maskHeaders(input.headers) as Prisma.InputJsonValue,
      requestBody: input.body
        ? maskSecretsInText(JSON.stringify(input.body)).slice(0, 8_000)
        : null,
      responseHeaders: headers,
      // См. комментарий в gateway.ts: детерминированные тела не храним.
      responseBody: result.responseSource === 'error' ? payload.slice(0, 8_000) : null,
    })

    return reply.send({
      requestId: reqId,
      status: result.status,
      durationMs,
      sizeBytes: Buffer.byteLength(payload),
      headers,
      body,
      scenario,
      responseSource: result.responseSource,
      readiness: result.method?.readiness ?? null,
      upstreamUrl,
      method: result.method
        ? { id: result.method.id, title: result.method.title, group: result.method.group }
        : null,
      curl: buildCurl(input, apiKey.prefix, scenario),
    })
  })
}

/** Превью cURL из макета: показывает ровно тот запрос, который уйдёт из кода пользователя. */
function buildCurl(
  input: z.infer<typeof executeBody>,
  keyPrefix: string,
  scenario: string,
): string {
  const profile = SERVICE_PROFILES[input.serviceCode]
  const qs = new URLSearchParams(input.query).toString()
  const url = `${env.publicOrigin}${profile.mountPath}${input.path}${qs ? `?${qs}` : ''}`

  const lines = [`curl -X ${input.httpMethod} \\`, `  '${url}' \\`]
  if (scenario !== 'success') lines.push(`  -H 'X-Mock-Scenario: ${scenario}' \\`)

  // Заголовок авторизации показываем в родном для сервиса виде.
  if (input.serviceCode === 'ozon') {
    lines.push(`  -H 'Client-Id: 123456' \\`, `  -H 'Api-Key: ${keyPrefix}…' \\`)
  } else if (input.serviceCode === 'wildberries') {
    lines.push(`  -H 'Authorization: ${keyPrefix}…' \\`)
  } else if (input.serviceCode === 'apify') {
    // У Apify префикс Bearer обязателен — без него боевой API отвечает
    // token-not-provided, и показывать голый токен значило бы дать нерабочую строку.
    lines.push(`  -H 'Authorization: Bearer ${keyPrefix}…' \\`)
  } else {
    lines.push(`  -H 'X-Mock-Key: ${keyPrefix}…' \\`)
  }

  if (input.body !== undefined && input.httpMethod !== 'GET') {
    lines.push(`  -H 'Content-Type: application/json' \\`, `  -d '${JSON.stringify(input.body)}'`)
  } else {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/ \\$/, '')
  }
  return lines.join('\n')
}
