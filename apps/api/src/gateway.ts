import type { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Scenario, ServiceCode } from '@apistend/shared'
import { SCENARIOS, SERVICE_LIST, SERVICE_PROFILES, isServiceCode, buildScenarioError, timeoutError } from '@apistend/shared'
import { MockEngine } from '@apistend/mock-engine'
import { extractRawKey, resolveApiKey } from './lib/api-key.ts'
import { checkRateLimit } from './lib/rate-limit.ts'
import { enqueueRequestLog } from './lib/log-buffer.ts'
import { recordKeyUsage } from './lib/key-usage.ts'
import { maskSecretsInText } from './lib/keys.ts'
import { requestId as newRequestId } from './lib/ids.ts'
import { unauthorizedError } from '@apistend/shared'
import { appTokenExpired, resolveAppToken, type AppContext } from './b24/tokens.ts'
import { callAppMethod, buildTimeEnvelope, scopeForMethod } from './b24/app-methods.ts'
import { B24_APP_ERRORS } from '@apistend/shared'
import { expandBracketKeys, runBatch } from './b24/batch.ts'

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
 * Сами заголовки и ответ на предполётный запрос выдаёт CORS-плагин в server.ts:
 * он отвечает в onRequest, до маршрутизации, и обработчик шлюза для OPTIONS
 * попросту не вызывается.
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

/**
 * Бросок кубика для «доли случайных ошибок» песочницы.
 *
 * Здесь случайность настоящая, и это осознанно: настройка называется «доля
 * случайных ошибок», её смысл — чтобы клиент на одном и том же вызове иногда
 * получал сбой. Детерминированный бросок дал бы либо всегда ошибку, либо
 * никогда, и проверять обработку сбоев стало бы нечем. Детерминизм в продукте
 * относится к ТЕЛУ успешного ответа — оно закреплено тестом и кешируется.
 */
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
    const code = SERVICE_BY_MOUNT.get(mount.slice(1))!
    app.all<{ Params: { '*': string } }>(`${mount}/*`, async (req, reply) =>
      handle(req, reply, code, `/${req.params['*']}`),
    )
    // Сам корень монтирования — /wb без слэша. Без этого маршрута ответ приходил
    // не от сервиса, а от Fastify: конверт {statusCode, error, message}, по которому
    // клиентская библиотека сервиса не умеет ничего. Отдаём родной 404 сервиса.
    app.all(mount, async (req, reply) => handle(req, reply, code, '/'))
  }

  // Портал Bitrix24 в корне.
  //
  // Приложению портал сообщает DOMAIN — голый хост, без пути, — и приложение
  // склеивает адрес REST само: <схема>://<DOMAIN>/rest/<метод>. Без этого маршрута
  // разработчик, ничего не менявший в своём коде, получил бы 404 на первом же вызове.
  app.all<{ Params: { '*': string } }>('/rest/*', async (req, reply) =>
    handle(req, reply, 'bitrix24', `/rest/${req.params['*']}`),
  )
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

  // Открытый доступ из браузера — отличие песочницы от боя, и оно помечается.
  // Access-Control-* ставит CORS-плагин (см. isGatewayPath в server.ts).
  reply.header('x-apistend-cors', 'added-by-sandbox')

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
  // Локальное приложение приходит со своим OAuth-токеном: ключа песочницы у него
  // взять неоткуда — боевой портал такого понятия не знает, и приложение,
  // написанное для боя, шлёт ровно то, что получило при установке.
  const appCtx = resolved !== null || service !== 'bitrix24' ? null : await resolveAppToken(rawKey)

  if (!resolved && !appCtx) {
    // Тело обязано совпадать с боевым до последнего поля, поэтому причина уходит
    // в служебный заголовок: иначе отладка превращается в гадание.
    const err = unauthorizedError(service, reqId)
    reply.headers(err.headers).header('x-request-id', reqId)
    reply.header('x-apistend-error', rawKey ? 'key-unknown-or-revoked' : 'key-missing')
    return reply.code(err.status).send(err.body)
  }

  const sandbox = resolved ? resolved.sandbox : appCtx!.sandbox
  // Лимит считается на субъект запроса: у ключа это сам ключ, у приложения — приложение.
  const rateSubject = resolved ? resolved.apiKey.id : `app:${appCtx!.app.id}`

  if (resolved) {
    // Счётчики ключа обновляются пачкой раз в 10 секунд, а не запросом к базе на вызов.
    recordKeyUsage(resolved.apiKey.id)

    if (!resolved.apiKey.services.includes(service)) {
      const err = buildScenarioError(service, 'invalid_token', reqId)
      reply.headers(err.headers).header('x-request-id', reqId)
      // В заголовке — только код: HTTP разрешает в значениях лишь ASCII, и русский
      // текст ронял ответ целиком (ERR_INVALID_CHAR), подменяя конверт ошибки
      // сервиса внутренней ошибкой Fastify. Подробности — в теле и в журнале.
      reply.header('x-apistend-error', 'key-scope')
      reply.header('x-apistend-key-services', resolved.apiKey.services.join(','))
      return reply.code(err.status).send(err.body)
    }
  }

  // Путь Bitrix24 несёт две вещи, которых нет в каталоге:
  //   1) секрет входящего вебхука — /rest/{user_id}/{code}/{method}.json
  //   2) суффикс формата ответа — .json (по умолчанию) или .xml
  // Отрезаем оба до маршрутизации.
  const path =
    service === 'bitrix24'
      ? rawPath.replace(/^\/rest\/\d+\/[^/]+\//, '/rest/').replace(/\.(json|xml)$/, '')
      : rawPath

  const rate = checkRateLimit(rateSubject, service, Date.now())
  reply.header('x-ratelimit-limit', String(rate.limit))
  reply.header('x-ratelimit-remaining', String(rate.remaining))

  let scenario = parseScenario(req.headers['x-mock-scenario'] as string | undefined)
  if (!rate.allowed) scenario = 'rate_limit'
  else if (scenario === 'success' && rollRandomError(sandbox.errorRate)) scenario = 'server_error'

  // Контекст приложения: состояние портала, а не сгенерированные данные.
  // app.info обязан отвечать про ЭТО приложение, placement.get — про виджеты,
  // которые оно зарегистрировало минуту назад. Движок так не умеет и не должен.
  if (appCtx && scenario === 'success') {
    const answer = await respondAsApp(appCtx, path, query, parsedBody, Date.now())
    if (answer) {
      const payload = JSON.stringify(answer.body)
      reply
        .header('x-request-id', reqId)
        .header('x-apistend-source', 'app-context')
        .header('x-apistend-app', appCtx.app.clientId)
      enqueueRequestLog({
        sandboxId: sandbox.id,
        apiKeyId: null,
        publicId: reqId,
        serviceCode: service,
        httpMethod: req.method,
        endpoint: path,
        statusCode: answer.status,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
        sizeBytes: Buffer.byteLength(payload),
        upstreamUrl: `https://${appCtx.app.clientId}.bitrix24.ru${path}`,
        clientIp: req.ip,
        scenario,
        responseSource: 'app-context',
        requestHeaders: sanitizeHeaders(req.headers as Record<string, unknown>),
        requestBody: parsedBody ? maskSecretsInText(JSON.stringify(parsedBody)).slice(0, 8_000) : null,
        responseHeaders: {},
        // Ответ зависит от состояния портала и движком не восстанавливается — храним.
        responseBody: payload.slice(0, 8_000),
      })
      return reply.code(answer.status).type('application/json; charset=utf-8').send(payload)
    }
  }

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
    const err = timeoutError(service, reqId)
    const timeoutPayload = JSON.stringify(err.body)
    reply.headers(err.headers).header('x-request-id', reqId).header('x-apistend-scenario', 'timeout')
    // Таймаут — тоже вызов, и в журнале он нужен больше остальных: именно его
    // ищут, когда разбираются, почему интеграция висела полминуты. Раньше эта
    // ветка выходила до записи, и вызова в журнале не было вовсе.
    enqueueRequestLog({
      sandboxId: sandbox.id,
      apiKeyId: resolved?.apiKey.id ?? null,
      publicId: reqId,
      serviceCode: service,
      httpMethod: req.method,
      endpoint: path,
      statusCode: err.status,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
      sizeBytes: Buffer.byteLength(timeoutPayload),
      upstreamUrl: result.method ? `${result.method.upstreamHost}${path}` : `${profile.replacesUrl}${path}`,
      clientIp: req.ip,
      scenario,
      responseSource: 'error',
      requestHeaders: sanitizeHeaders(req.headers as Record<string, unknown>),
      requestBody: parsedBody ? maskSecretsInText(JSON.stringify(parsedBody)).slice(0, 8_000) : null,
      responseHeaders: {},
      responseBody: timeoutPayload,
    })
    return reply.code(err.status).type('application/json; charset=utf-8').send(timeoutPayload)
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
    apiKeyId: resolved?.apiKey.id ?? null,
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
    requestBody: parsedBody ? maskSecretsInText(JSON.stringify(parsedBody)).slice(0, 8_000) : null,
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

/**
 * Ответ в контексте локального приложения.
 *
 * Возвращает null, если метод обычный: тогда его отдаёт движок моков, и приложение
 * получает те же данные, что и любой другой клиент песочницы. Отличается только
 * авторизация и то, что состояние портала (установка, виджеты, подписки) живёт
 * в базе, а не выводится из спецификации.
 */
async function respondAsApp(
  ctx: AppContext,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
  startedMs: number,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const method = path.replace(/^\/rest\//, '').replace(/^\//, '')
  if (method.length === 0) return null

  // Истёкший токен — это 401 expired_token на ЛЮБОЙ метод, а не только на «живые».
  // Документация прямо предписывает приложению дождаться этой ошибки и только
  // после неё идти обновлять пару; мок с вечным токеном научил бы обратному.
  if (appTokenExpired(ctx.token)) {
    return { status: 401, body: { ...B24_APP_ERRORS.expiredToken.body } }
  }

  const flat: Record<string, unknown> = { ...query }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    Object.assign(flat, body as Record<string, unknown>)
  }
  delete flat.auth
  const params = expandBracketKeys(flat)

  if (method.toLowerCase() === 'batch') {
    const packed = await runBatch(params, async (name, commandParams) => {
      const inner = await respondAsAppMethod(ctx, name, commandParams)
      if (inner) return inner
      return runThroughEngine(ctx, name, commandParams)
    })
    return withTime(packed, startedMs)
  }

  const answer = await respondAsAppMethod(ctx, method, params)
  return answer ? withTime(answer, startedMs) : null
}

/** Проверки контекста и «живые» методы. null — метод обычный. */
async function respondAsAppMethod(
  ctx: AppContext,
  method: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const required = scopeForMethod(method)
  if (required !== null && !ctx.app.scope.includes(required)) {
    return { status: 403, body: { ...B24_APP_ERRORS.insufficientScope.body } }
  }
  return callAppMethod(ctx, method, params)
}

/** Одна команда пакета, которую отрабатывает движок моков. */
function runThroughEngine(
  ctx: AppContext,
  method: string,
  params: Record<string, unknown>,
): { status: number; body: Record<string, unknown> } {
  const result = engine.handle({
    service: 'bitrix24',
    httpMethod: 'POST',
    path: `/rest/${method}`,
    query: {},
    headers: {},
    body: params,
    requestId: newRequestId(),
    scenario: 'success',
    now: new Date(),
    salt: ctx.sandbox.dataVolume,
  })
  try {
    return { status: result.status, body: JSON.parse(result.serialized) as Record<string, unknown> }
  } catch {
    return { status: 500, body: { error: 'ERROR_UNEXPECTED_ANSWER', error_description: 'Unexpected answer' } }
  }
}

/** Боевой портал прикладывает конверт time к каждому ответу, включая пакетный. */
function withTime(
  answer: { status: number; body: Record<string, unknown> },
  startedMs: number,
): { status: number; body: Record<string, unknown> } {
  if (answer.body.time !== undefined || typeof answer.body.error === 'string') return answer
  return { status: answer.status, body: { ...answer.body, time: buildTimeEnvelope(startedMs) } }
}
