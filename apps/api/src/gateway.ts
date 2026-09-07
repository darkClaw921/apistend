import type { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Scenario, ServiceCode } from '@apistend/shared'
import { SCENARIOS, SERVICE_LIST, SERVICE_PROFILES, isServiceCode, buildScenarioError } from '@apistend/shared'
import { MockEngine } from '@apistend/mock-engine'
import { extractRawKey, resolveApiKey } from './lib/api-key.ts'
import { checkRateLimit } from './lib/rate-limit.ts'
import { enqueueRequestLog } from './lib/log-buffer.ts'
import { recordKeyUsage } from './lib/key-usage.ts'
import { requestId as newRequestId } from './lib/ids.ts'
import { unauthorizedError } from '@apistend/shared'

/**
 * Мок-шлюз.
 *
 * Две схемы адресации, обе из макета:
 *   /wb/api/v3/orders            — подстановка вместо боевого адреса (экран «Ключи»)
 *   /v1/wildberries/api/v3/orders — единый префикс (экран «Консоль»)
 *
 * Поддомены с именами сервисов сознательно не используются: доменное имя —
 * способ использования товарного знака (ГК РФ ст. 1484 п. 2 пп. 5).
 *
 * CORS шлюз отдаёт всегда и помечает это заголовком. Боевые Ozon и WB запросы из браузера
 * не разрешают, и полное повторение этого поведения сломало бы собственную консоль APIStend;
 * консоль ходит через серверный прокси, а прямой доступ из браузера оставлен как удобство.
 */

export const engine = MockEngine.load(['bitrix24', 'ozon', 'wildberries'])

const SERVICE_BY_MOUNT = new Map(SERVICE_LIST.map((p) => [p.mountPath.slice(1), p.code]))

function parseScenario(raw: string | undefined): Scenario {
  if (!raw) return 'success'
  const v = raw.trim().toLowerCase()
  return (SCENARIOS as readonly string[]).includes(v) ? (v as Scenario) : 'success'
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

/** Детерминированный бросок кубика для «доли случайных ошибок» песочницы. */
function rollRandomError(errorRatePercent: number): boolean {
  return errorRatePercent > 0 && Math.random() * 100 < errorRatePercent
}

export function registerGateway(app: FastifyInstance): void {
  // Единый префикс: /v1/{service}/*
  app.all<{ Params: { service: string; '*': string } }>('/v1/:service/*', async (req, reply) => {
    const service = req.params.service
    if (!isServiceCode(service)) {
      return reply.code(404).send({ error: 'UNKNOWN_SERVICE', error_description: `Сервис «${service}» не поддерживается` })
    }
    return handle(req, reply, service, `/${req.params['*']}`)
  })

  // Подстановка вместо боевого адреса: /wb/*, /oz/*, /b24/*
  for (const profile of SERVICE_LIST) {
    const mount = profile.mountPath
    app.all<{ Params: { '*': string } }>(`${mount}/*`, async (req, reply) => {
      const code = SERVICE_BY_MOUNT.get(mount.slice(1))!
      return handle(req, reply, code, `/${req.params['*']}`)
    })
  }
}

async function handle(
  req: FastifyRequest,
  reply: FastifyReply,
  service: ServiceCode,
  rawPath: string,
): Promise<unknown> {
  const startedAt = process.hrtime.bigint()
  const reqId = newRequestId()
  const profile = SERVICE_PROFILES[service]

  // Браузерная консоль ходит через серверный прокси, но прямые запросы из браузера
  // тоже не должны упираться в CORS: это песочница, а не боевой контур.
  reply.header('access-control-allow-origin', '*')
  reply.header('access-control-expose-headers', 'x-request-id, x-apistend-source, x-apistend-readiness, x-apistend-scenario, x-apistend-upstream, x-ratelimit-limit, x-ratelimit-remaining, retry-after')
  reply.header('x-apistend-cors', 'added-by-sandbox')

  if (req.method === 'OPTIONS') {
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    reply.header('access-control-allow-headers', '*')
    return reply.code(204).send()
  }

  const query = (req.query ?? {}) as Record<string, unknown>
  // Тело парсится до авторизации: Bitrix24 разрешает класть ключ внутрь JSON-тела.
  const parsedBody = parseBody(req)
  const rawKey = extractRawKey(
    req.headers as Record<string, string | string[] | undefined>,
    query,
    rawPath,
    parsedBody,
  )
  const resolved = await resolveApiKey(rawKey)

  if (!resolved) {
    // Тело обязано совпадать с боевым до последнего поля, поэтому причина уходит
    // в служебный заголовок: иначе отладка превращается в гадание.
    const err = unauthorizedError(service, reqId)
    reply.headers(err.headers).header('x-request-id', reqId)
    reply.header('x-apistend-error', rawKey ? 'key-unknown-or-revoked' : 'key-missing')
    return reply.code(err.status).send(err.body)
  }

  const { apiKey, sandbox } = resolved
  // Счётчики ключа обновляются пачкой раз в 10 секунд, а не запросом к базе на вызов.
  recordKeyUsage(apiKey.id)

  if (!apiKey.services.includes(service)) {
    const err = buildScenarioError(service, 'invalid_token', reqId)
    reply.headers(err.headers).header('x-request-id', reqId)
    reply.header('x-apistend-error', `key-scope: ключ «${apiKey.name}» открыт для ${apiKey.services.join(', ')}`)
    return reply.code(err.status).send(err.body)
  }

  // Путь Bitrix24 несёт две вещи, которых нет в каталоге:
  //   1) секрет входящего вебхука — /rest/{user_id}/{code}/{method}.json
  //   2) суффикс формата ответа — .json (по умолчанию) или .xml
  // Отрезаем оба до маршрутизации.
  const path =
    service === 'bitrix24'
      ? rawPath.replace(/^\/rest\/\d+\/[^/]+\//, '/rest/').replace(/\.(json|xml)$/, '')
      : rawPath

  const rate = checkRateLimit(apiKey.id, service, Date.now())
  reply.header('x-ratelimit-limit', String(rate.limit))
  reply.header('x-ratelimit-remaining', String(rate.remaining))

  let scenario = parseScenario(req.headers['x-mock-scenario'] as string | undefined)
  if (!rate.allowed) scenario = 'rate_limit'
  else if (scenario === 'success' && rollRandomError(sandbox.errorRate)) scenario = 'server_error'

  const result = engine.handle({
    service,
    httpMethod: req.method,
    path,
    query: query as Record<string, string | string[]>,
    headers: req.headers as Record<string, string | undefined>,
    body: parsedBody,
    requestId: reqId,
    scenario,
    now: new Date(),
    // Базовый датасет общий для всех песочниц — солью служит объём данных.
    // Персональные изменения пользователя лежат в overlay и накладываются отдельно.
    salt: sandbox.dataVolume,
  })

  // Сценарий «Таймаут 30 с» из макета: соединение держим и не отвечаем в срок.
  if (scenario === 'timeout') {
    await sleep(30_000)
    reply.header('x-request-id', reqId)
    return reply.code(504).send(buildScenarioError(service, 'server_error', reqId).body)
  }

  // Задержка: явный X-Mock-Delay > задержка метода > настройка песочницы.
  const headerDelay = Number(req.headers['x-mock-delay'])
  const delay = Number.isFinite(headerDelay)
    ? Math.min(Math.max(headerDelay, 0), 3_000)
    : Math.min(sandbox.latencyMs, result.latencyMs)
  await sleep(delay)

  // Движок уже отдал готовую строку — второй JSON.stringify под нагрузкой лишний.
  const payload = result.serialized
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

  enqueueRequestLog({
    sandboxId: sandbox.id,
    apiKeyId: apiKey.id,
    publicId: reqId,
    serviceCode: service,
    httpMethod: req.method,
    endpoint: path,
    statusCode: result.status,
    durationMs: Math.round(durationMs),
    sizeBytes: Buffer.byteLength(payload),
    upstreamUrl: result.method ? `${result.method.upstreamHost}${path}` : `${profile.replacesUrl}${path}`,
    clientIp: req.ip,
    scenario,
    responseSource: result.responseSource,
    requestHeaders: sanitizeHeaders(req.headers as Record<string, unknown>),
    // Тело запроса — данные пользователя, восстановить их неоткуда, храним (усечённо).
    requestBody: parsedBody ? JSON.stringify(parsedBody).slice(0, 8_000) : null,
    // Заголовки ответа генерирует сам шлюз — они выводятся из метода и сценария,
    // хранить их построчно незачем. Восстанавливаются вместе с телом.
    responseHeaders: {},
    // Тело успешного ответа НЕ храним: оно детерминировано и восстанавливается движком
    // по (метод, объём датасета) — см. reproduceResponseBody в routes/logs.ts.
    // Иначе журнал писал бы десятки мегабайт в секунду ради данных, которые
    // и так вычисляются за микросекунды. Ошибки храним: в их конверте есть
    // requestId и метка времени, они невоспроизводимы.
    responseBody: result.responseSource === 'error' ? payload.slice(0, 8_000) : null,
  })

  reply.headers(result.headers).header('x-request-id', reqId)
  // Отдаём готовую строку: Fastify не будет сериализовать объект ещё раз.
  return reply.code(result.status).type('application/json; charset=utf-8').send(payload)
}

/**
 * Тело запроса.
 *
 * Content-type парсер шлюза отдаёт Buffer для всего неизвестного: мок обязан принять
 * что угодно, а не падать с 415 на неожиданном типе. JSON разбираем здесь и мягко:
 * невалидное тело не должно ронять запрос до того, как отработает авторизация.
 */
function parseBody(req: FastifyRequest): unknown {
  const body = req.body
  if (body === undefined || body === null) return null
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8').trim()
    if (text.length === 0) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return body
}

/** Из логов убираем сам ключ: он не должен оседать в базе в открытом виде. */
function sanitizeHeaders(headers: Record<string, unknown>): Prisma.InputJsonValue {
  const out: Record<string, Prisma.InputJsonValue> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    out[k] = lower === 'authorization' || lower === 'x-mock-key' || lower === 'api-key'
      ? '••••••'
      : (v as Prisma.InputJsonValue)
  }
  return out
}
