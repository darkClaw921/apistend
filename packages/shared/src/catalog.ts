/**
 * Модель метода каталога.
 *
 * Поля происхождения (source*, extraction, snapshotDate) обязательны: они позволяют
 * запуститься с неполным каталогом и при этом ничего не обещать сверх того, что есть.
 * Экран «Каталог API» показывает их пользователю как статус готовности мока.
 */

import type { ExtractionKind, Readiness, ResponseSource, ServiceCode } from './services.ts'

export interface MethodParam {
  readonly name: string
  readonly in: 'query' | 'body' | 'path' | 'header'
  readonly type: string
  readonly required: boolean
  readonly description: string
}

export interface MethodScenario {
  readonly scenario: string
  readonly statusCode: number
  /** Подпись в списке сценариев на карточке метода: «Сделка создана, result: 1042». */
  readonly title: string
  readonly isDefault: boolean
}

export interface CatalogMethod {
  /** Стабильный идентификатор: `${service}:${httpMethod}:${path}`. Попадает в URL страницы. */
  readonly id: string
  readonly serviceCode: ServiceCode
  readonly httpMethod: string
  /** Путь без префикса сервиса: /api/v3/orders, /rest/crm.deal.list, /v3/posting/fbs/list. */
  readonly path: string
  readonly title: string
  readonly description: string
  /** Раздел внутри сервиса — заголовок группы в списке методов. */
  readonly group: string
  /** Более мелкая рубрика внутри группы (tag спецификации). */
  readonly tag: string
  /** Боевой хост, который подменяет мок. Показывается в панели деталей лога. */
  readonly upstreamHost: string
  readonly version: string
  readonly readiness: Readiness
  readonly deprecated: boolean
  readonly params: readonly MethodParam[]
  readonly scenarios: readonly MethodScenario[]
  /** Типичная задержка ответа мока, миллисекунды. */
  readonly latencyMs: number

  // --- происхождение ---
  /** Откуда взят ответ по умолчанию. */
  readonly responseSource: ResponseSource
  /** Каким способом метод попал в каталог. */
  readonly extraction: ExtractionKind
  /** Адрес документации боевого сервиса. */
  readonly sourceUrl: string
  /** Дата снимка спецификации в формате YYYY-MM-DD. */
  readonly snapshotDate: string
  /** Лицензия источника, если объявлена. */
  readonly license: string | null

  /** Пример успешного ответа из спецификации, если он там есть. */
  readonly responseExample: unknown | null
  /** Указатель на схему успешного ответа внутри объединённого документа сервиса. */
  readonly responseSchemaRef: string | null
  /** Указатель на схему тела запроса. */
  readonly requestSchemaRef: string | null
  /** Код успешного ответа: у части методов это 201 или 204, а не 200. */
  readonly successStatus: number
}

/** Результат ингеста одного сервиса. Сохраняется как catalog.<service>.json. */
export interface CatalogBundle {
  readonly serviceCode: ServiceCode
  readonly generatedAt: string
  readonly snapshotDate: string
  readonly sourceUrl: string
  readonly sourceSha256: string
  readonly license: string | null
  readonly methodCount: number
  readonly methods: readonly CatalogMethod[]
}

export function methodId(serviceCode: ServiceCode, httpMethod: string, path: string): string {
  return `${serviceCode}:${httpMethod.toUpperCase()}:${path}`
}

/** Слаг для адресной строки: /catalog/wildberries/GET/api/v3/orders. */
export function methodSlug(m: Pick<CatalogMethod, 'serviceCode' | 'httpMethod' | 'path'>): string {
  return `${m.serviceCode}/${m.httpMethod.toUpperCase()}${m.path}`
}
