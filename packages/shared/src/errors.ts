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
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
} as const

export function bitrix24Error(key: B24ErrorKey, status: number, description?: string): MockErrorResponse {
  const [code, defaultDescription] = B24_ERRORS[key]
  return {
    status,
    body: { error: code, error_description: description ?? defaultDescription },
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }
}

export function ozonError(status: number, grpcCode: number, message: string): MockErrorResponse {
  // Конверт rpcStatus: {code, message, details}. details почти всегда пустой массив,
  // но поле обязано присутствовать — клиенты на строгих типах падают без него.
  return {
    status,
    body: { code: grpcCode, message, details: [] },
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
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
        return bitrix24Error('INVALID_CREDENTIALS', 401)
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
      case 'rate_limit': {
        const res = ozonError(429, OZON_GRPC.RESOURCE_EXHAUSTED, 'Too Many Requests')
        return { ...res, headers: { ...res.headers, 'retry-after': String(profile.rateLimit.retryAfterSeconds ?? 1) } }
      }
      case 'server_error':
        return ozonError(500, OZON_GRPC.INTERNAL, 'Internal error')
    }
  }

  switch (scenario) {
    case 'invalid_token':
      return wildberriesError(401, 'Unauthorized', 'invalid API access token: empty main token', requestId)
    case 'not_found':
      return wildberriesError(404, 'Not Found', 'path not found', requestId, 'ag-gateway')
    case 'rate_limit': {
      const res = wildberriesError(429, 'Too Many Requests', 'rate limit exceeded', requestId)
      return {
        ...res,
        headers: {
          ...res.headers,
          'x-ratelimit-limit': String(profile.rateLimit.limit),
          'x-ratelimit-remaining': '0',
          'x-ratelimit-retry': String(profile.rateLimit.retryAfterSeconds ?? 20),
          'retry-after': String(profile.rateLimit.retryAfterSeconds ?? 20),
        },
      }
    }
    case 'server_error':
      return wildberriesError(500, 'Internal Server Error', 'internal error', requestId)
  }
}

/** Ошибка «нет такого метода в этой песочнице» в родном конверте сервиса. */
export function unknownMethodError(service: ServiceCode, requestId: string): MockErrorResponse {
  return buildScenarioError(service, 'not_found', requestId)
}

/** Ошибка авторизации: ключ APIStend отсутствует, невалиден или отозван. */
export function unauthorizedError(service: ServiceCode, requestId: string): MockErrorResponse {
  return buildScenarioError(service, 'invalid_token', requestId)
}
