/**
 * Заголовки ответа в том виде, в каком их отдаёт боевой сервис.
 *
 * Смысл всего продукта — «поменял базовый адрес, и рабочая интеграция продолжила
 * работать». Тело ответа этому обещанию удовлетворяет давно, а заголовки до сих пор
 * шли общим для всех набором: X-Ratelimit-* приписывались даже сервисам, у которых
 * их нет, а Content-Type приходил с charset там, где боевой сервис отдаёт голый
 * application/json. Клиентская библиотека такое обычно переживает, но учится
 * неправде: код, написанный на моке, в бою читает заголовок, которого нет.
 *
 * Отсюда правило: набор заголовков — свойство сервиса (профиль `native`), а не шлюза.
 * Собственные заголовки APIStend живут отдельно и все начинаются с x-apistend-:
 * их ни один боевой клиент не читает, а увидеть, что перед тобой мок, они позволяют.
 */

import type { ServiceCode } from './services.ts'
import { SERVICE_PROFILES } from './services.ts'

/** Состояние лимита на момент ответа. Значения те же, что у боевых заголовков. */
export interface RateSnapshot {
  /** Ёмкость всплеска: сколько запросов сервис пропускает подряд. */
  readonly limit: number
  /** Сколько ещё пропустит прямо сейчас. */
  readonly remaining: number
  /** Секунды до полного восстановления всплеска — это и есть X-Ratelimit-Reset. */
  readonly resetInSeconds: number
  /** Секунды до следующего разрешённого запроса — это X-Ratelimit-Retry. */
  readonly retryInSeconds: number
}

export interface NativeHeadersInput {
  /** Идентификатор запроса в родном для сервиса формате. */
  readonly requestId: string | null
  readonly rate?: RateSnapshot | null
  /** Ответ отдан из-за превышения лимита: добавляется заголовок паузы. */
  readonly limited?: boolean
}

/**
 * Полный набор боевых заголовков сервиса. Всё, чего у сервиса нет, не появляется:
 * пустые значения не подставляются, чужие заголовки не добавляются.
 */
export function nativeResponseHeaders(
  service: ServiceCode,
  input: NativeHeadersInput,
): Record<string, string> {
  const native = SERVICE_PROFILES[service].native
  const headers: Record<string, string> = { 'content-type': native.contentType }

  if (native.requestIdHeader && input.requestId) {
    headers[native.requestIdHeader] = input.requestId
  }

  if (input.rate) {
    // Отдаём ровно те из трёх, которые сервис отдаёт в бою: у Wildberries все три,
    // у Apify только limit, у Ozon и Битрикс24 ни одного.
    for (const part of native.rateLimitHeaders) {
      if (part === 'limit') headers['x-ratelimit-limit'] = String(input.rate.limit)
      if (part === 'remaining') headers['x-ratelimit-remaining'] = String(input.rate.remaining)
      if (part === 'reset') headers['x-ratelimit-reset'] = String(input.rate.resetInSeconds)
    }
  }

  if (input.limited && native.retryHeader && input.rate) {
    headers[native.retryHeader] = String(input.rate.retryInSeconds)
  }

  return headers
}

/**
 * Имена всех заголовков, которые шлюз когда-либо отдаёт.
 *
 * Нужны CORS: браузер не показывает коду страницы ни одного заголовка ответа,
 * кроме перечисленных в Access-Control-Expose-Headers. Без этого списка
 * библиотека, читающая остаток лимита, в браузере получала бы undefined —
 * то самое «поломалось после подмены адреса», от которого мы и уходим.
 */
export function allGatewayResponseHeaders(): readonly string[] {
  const names = new Set<string>([
    'x-apistend-request-id',
    'x-apistend-source',
    'x-apistend-readiness',
    'x-apistend-scenario',
    'x-apistend-upstream',
    'x-apistend-snapshot',
    'x-apistend-did-you-mean',
    'x-apistend-error',
    'x-apistend-cors',
    'x-apistend-key-services',
    'x-apistend-app',
    'x-apistend-retry-after',
  ])
  for (const code of Object.keys(SERVICE_PROFILES) as ServiceCode[]) {
    const native = SERVICE_PROFILES[code].native
    if (native.requestIdHeader) names.add(native.requestIdHeader)
    if (native.retryHeader) names.add(native.retryHeader)
    for (const part of native.rateLimitHeaders) names.add(`x-ratelimit-${part}`)
    if (native.paginationHeaderPrefix) {
      for (const field of PAGINATION_FIELDS) names.add(`${native.paginationHeaderPrefix}${field}`)
    }
  }
  return [...names]
}

/**
 * Поля конверта пагинации, которые сервис дублирует в заголовки.
 *
 * Набор — из живого ответа Apify: те же пять имён перечислены и в его собственном
 * Access-Control-Expose-Headers, то есть читать их из браузера предполагается.
 */
export const PAGINATION_FIELDS = ['total', 'offset', 'count', 'limit', 'desc'] as const

/**
 * Заголовки пагинации по УЖЕ СОБРАННОМУ телу ответа.
 *
 * Источник значений — само тело: заголовок, разошедшийся с конвертом `data`,
 * был бы хуже отсутствующего, потому что клиент, листающий по заголовку,
 * ушёл бы в бесконечный цикл. Поэтому здесь ничего не вычисляется —
 * только переносится то, что в теле уже есть.
 */
export function paginationHeaders(service: ServiceCode, body: unknown): Record<string, string> {
  const prefix = SERVICE_PROFILES[service].native.paginationHeaderPrefix
  if (!prefix) return {}
  if (body === null || typeof body !== 'object') return {}
  const data = (body as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}

  const out: Record<string, string> = {}
  for (const field of PAGINATION_FIELDS) {
    const value = (data as Record<string, unknown>)[field]
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[`${prefix}${field}`] = String(value)
    }
  }
  // Ответ не списковый — ни одного из полей нет, и заголовков быть не должно.
  return out
}
