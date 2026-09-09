/**
 * Конверты ошибок трёх сервисов.
 *
 * У каждого сервиса своя форма, и именно по ней клиентские библиотеки отличают ошибку
 * от успеха. Мок, отдающий чужой конверт, выдаёт себя первым же вызовом.
 */

import type { ServiceCode, Scenario } from './services.ts'
import { SERVICE_PROFILES } from './services.ts'

export interface MockErrorResponse {
  readonly status: number
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}

/** Коды ошибок Bitrix24, встречающиеся в документации. */
export const B24_ERRORS = {
  METHOD_NOT_FOUND: ['ERROR_METHOD_NOT_FOUND', 'Method not found!'],
  NO_AUTH_FOUND: ['NO_AUTH_FOUND', 'Wrong authorization data'],
  INVALID_CREDENTIALS: ['INVALID_CREDENTIALS', 'Invalid request credentials'],
  EXPIRED_TOKEN: ['expired_token', 'The access token provided has expired.'],
  INSUFFICIENT_SCOPE: [
    'insufficient_scope',
    'The request requires higher privileges than provided by the webhook token',
  ],
  ACCESS_DENIED: ['ACCESS_DENIED', 'Access denied!'],
  QUERY_LIMIT_EXCEEDED: ['QUERY_LIMIT_EXCEEDED', 'Too many requests'],
  INTERNAL_SERVER_ERROR: ['INTERNAL_SERVER_ERROR', 'Internal server error'],
} as const satisfies Record<string, readonly [string, string]>

export type B24ErrorKey = keyof typeof B24_ERRORS

/** Числовые коды gRPC, которые Ozon отдаёт в поле code конверта rpcStatus. */
const OZON_GRPC = {
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
} as const

/**
 * Типы ошибок Apify.
 *
 * Значения — из живых ответов боевого API и из component-схем его OpenAPI,
 * а не из общих соображений. Отдельно стоит отметить token-not-provided:
 * при полном отсутствии токена Apify отвечает именно им, а invalid-token
 * приходит на токен неверный. Клиент, различающий эти два случая, в моке
 * должен видеть ту же разницу.
 */
export const APIFY_ERRORS = {
  TOKEN_NOT_PROVIDED: ['token-not-provided', 'Authentication token was not provided'],
  INVALID_TOKEN: ['invalid-token', 'Authentication token is not valid.'],
  RECORD_NOT_FOUND: ['record-not-found', 'The requested resource was not found.'],
  RATE_LIMIT_EXCEEDED: ['rate-limit-exceeded', 'You have exceeded the rate limit. Please try again later.'],
  INTERNAL_ERROR: ['internal-error', 'Internal server error occurred.'],
  GATEWAY_TIMEOUT: ['gateway-timeout', 'The request timed out.'],
} as const satisfies Record<string, readonly [string, string]>

export type ApifyErrorKey = keyof typeof APIFY_ERRORS

export function apifyError(key: ApifyErrorKey, status: number): MockErrorResponse {
  const [type, message] = APIFY_ERRORS[key]
  // Конверт ровно такой, как в components.schemas.ErrorResponse: объект error
  // с двумя обязательными полями. Ни requestId, ни кода — их у Apify нет.
  return {
    status,
    body: { error: { type, message } },
    headers: { 'content-type': SERVICE_PROFILES.apify.native.contentType },
  }
}

export function bitrix24Error(key: B24ErrorKey, status: number, description?: string): MockErrorResponse {
  const [code, defaultDescription] = B24_ERRORS[key]
  return {
    status,
    body: { error: code, error_description: description ?? defaultDescription },
    headers: { 'content-type': SERVICE_PROFILES.bitrix24.native.contentType },
  }
}

export function ozonError(status: number, grpcCode: number, message: string): MockErrorResponse {
  // Конверт rpcStatus: {code, message, details}. details почти всегда пустой массив,
  // но поле обязано присутствовать — клиенты на строгих типах падают без него.
  return {
    status,
    body: { code: grpcCode, message, details: [] },
    headers: { 'content-type': SERVICE_PROFILES.ozon.native.contentType },
  }
}

export function wildberriesError(
  status: number,
  title: string,
  detail: string,
  requestId: string,
  origin = 'ag-api',
): MockErrorResponse {
  return {
    status,
    body: {
      title,
      detail,
      code: `${title.replace(/\s+/g, '')}`,
      requestId,
      origin,
      status,
      statusText: title.toLowerCase().replace(/\s+/g, '_'),
      timestamp: new Date().toISOString(),
    },
    headers: { 'content-type': SERVICE_PROFILES.wildberries.native.contentType },
  }
}

/**
 * Единая точка: сценарий + сервис -> ответ в родном для сервиса конверте.
 * Именно этим занимается шаг `scenario` в конвейере резолвера.
 */
export function buildScenarioError(
  service: ServiceCode,
  scenario: Exclude<Scenario, 'success' | 'timeout'>,
  requestId: string,
): MockErrorResponse {
  const profile = SERVICE_PROFILES[service]

  if (service === 'bitrix24') {
    switch (scenario) {
      case 'invalid_token':
        // Именно NO_AUTH_FOUND: так боевой портал отвечает и на неверный
        // access-токен, и на неверный код входящего вебхука. INVALID_CREDENTIALS —
        // это другое и с другим кодом: 403, когда у сотрудника не хватает прав.
        return bitrix24Error('NO_AUTH_FOUND', 401)
      case 'not_found':
        return bitrix24Error('METHOD_NOT_FOUND', 404)
      case 'rate_limit':
        // Ключевой нюанс: у Bitrix24 это 503, а не 429.
        return bitrix24Error('QUERY_LIMIT_EXCEEDED', profile.rateLimit.statusCode)
      case 'server_error':
        return bitrix24Error('INTERNAL_SERVER_ERROR', 500)
    }
  }

  if (service === 'ozon') {
    switch (scenario) {
      case 'invalid_token':
        return ozonError(401, OZON_GRPC.UNAUTHENTICATED, 'Client-Id and Api-Key headers are required')
      case 'not_found':
        return ozonError(404, OZON_GRPC.NOT_FOUND, 'Not Found')
      case 'rate_limit':
        // Retry-After сюда не подставляется: Ozon документирует сам лимит,
        // но не заголовок с паузой, и в живых ответах его нет. Рекомендуемую
        // паузу шлюз отдаёт своим x-apistend-retry-after — там ей и место.
        return ozonError(429, OZON_GRPC.RESOURCE_EXHAUSTED, 'Too Many Requests')
      case 'server_error':
        return ozonError(500, OZON_GRPC.INTERNAL, 'Internal error')
    }
  }

  if (service === 'apify') {
    switch (scenario) {
      case 'invalid_token':
        return apifyError('INVALID_TOKEN', 401)
      case 'not_found':
        return apifyError('RECORD_NOT_FOUND', 404)
      case 'rate_limit':
        return apifyError('RATE_LIMIT_EXCEEDED', 429)
      case 'server_error':
        return apifyError('INTERNAL_ERROR', 500)
    }
  }

  switch (scenario) {
    case 'invalid_token':
      return wildberriesError(401, 'Unauthorized', 'invalid API access token: empty main token', requestId)
    case 'not_found':
      return wildberriesError(404, 'Not Found', 'path not found', requestId, 'ag-gateway')
    case 'rate_limit':
      // X-Ratelimit-* здесь не выставляются: остаток и паузу знает только шлюз,
      // он же ведёт бакет, и он добавляет боевые заголовки к любому ответу WB —
      // и успешному, и этому. Два владельца одного заголовка уже давали
      // Limit: 2 при Remaining: 49.
      return wildberriesError(429, 'Too Many Requests', 'rate limit exceeded', requestId)
    case 'server_error':
      return wildberriesError(500, 'Internal Server Error', 'internal error', requestId)
  }
}

/**
 * Конверт сценария «Таймаут»: HTTP 504.
 *
 * Отдельная функция, а не ветка buildScenarioError, по существу дела: у боевых
 * сервисов таймаут — это ОТСУТСТВИЕ ответа, кода ошибки для него не заведено.
 * Раньше сюда подставлялся конверт server_error, и клиент получал под кодом 504
 * тело, в котором написано 500, — расхождение, которое в бою невозможно.
 *
 * Форма конверта остаётся родной для сервиса, а то, что ответ синтетический,
 * видно по заголовку x-apistend-scenario: timeout.
 */
export function timeoutError(service: ServiceCode, requestId: string): MockErrorResponse {
  if (service === 'bitrix24') {
    // Кода из документации здесь нет и быть не может — портал в этой ситуации
    // просто не отвечает. Конверт портала сохраняем, код помечаем как шлюзовой.
    return {
      status: 504,
      body: { error: 'GATEWAY_TIMEOUT', error_description: 'Gateway timeout' },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }
  }
  if (service === 'ozon') {
    // DEADLINE_EXCEEDED — ровно тот код gRPC, которым описывается невышедший в срок вызов.
    return ozonError(504, OZON_GRPC.DEADLINE_EXCEEDED, 'Deadline exceeded')
  }
  if (service === 'apify') return apifyError('GATEWAY_TIMEOUT', 504)
  return wildberriesError(504, 'Gateway Timeout', 'upstream did not answer in time', requestId, 'ag-gateway')
}

/** Ошибка «нет такого метода в этой песочнице» в родном конверте сервиса. */
export function unknownMethodError(service: ServiceCode, requestId: string): MockErrorResponse {
  return buildScenarioError(service, 'not_found', requestId)
}

/**
 * Ошибка авторизации: ключ APIStend отсутствует, невалиден или отозван.
 *
 * `keyPresent` различает «токена не прислали» и «токен не тот». Разница видна
 * только там, где её делает боевой сервис: Apify на пустой запрос отвечает
 * token-not-provided, а на неверный токен — invalid-token, и клиент, который
 * по этому различает «не залогинен» и «протух ключ», в моке обязан увидеть то же.
 * Остальным трём сервисам различие безразлично — у них один конверт на оба случая.
 */
export function unauthorizedError(
  service: ServiceCode,
  requestId: string,
  keyPresent = true,
): MockErrorResponse {
  if (service === 'apify' && !keyPresent) return apifyError('TOKEN_NOT_PROVIDED', 401)
  return buildScenarioError(service, 'invalid_token', requestId)
}
