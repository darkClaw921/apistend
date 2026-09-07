import type { ServiceCode } from './services.ts'

/**
 * Каталог исходящих событий трёх сервисов.
 *
 * Форматы сняты с официальной документации, а не придуманы. Три сервиса ведут себя
 * принципиально по-разному, и мок обязан это воспроизводить — иначе продукт научит
 * разработчика неверному поведению:
 *
 *   Bitrix24 — form-urlencoded, в теле ТОЛЬКО идентификатор объекта, повторов нет;
 *   Ozon     — JSON, дискриминатор message_type, успех = 200 И тело {"result": true};
 *   WB       — JSON-конверт {sellerId, requestId, events[]}, подпись HMAC в X-Hub-Signature.
 */

export interface EventDefinition {
  /** Код события в номенклатуре сервиса. */
  readonly code: string
  /** Название для интерфейса. */
  readonly title: string
  readonly serviceCode: ServiceCode
  /** Имя из макета APIStend, если оно отличается от боевого. */
  readonly aliasInMockup?: string
  /** Что попадает в тело: генератор получает опорное время и порядковый номер. */
  readonly sample: (n: number, now: Date) => Record<string, unknown>
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

export const EVENTS: readonly EventDefinition[] = [
  // ─────────── Bitrix24 ───────────
  // Ключевой факт: событие несёт ТОЛЬКО идентификатор. Значения полей не передаются,
  // клиент обязан дёрнуть crm.deal.get. Мок, шлющий полный объект, сразу выдаёт себя.
  {
    code: 'ONCRMDEALADD', title: 'Создана сделка', serviceCode: 'bitrix24',
    sample: (n) => ({ FIELDS: { ID: String(7400 + n) } }),
  },
  {
    code: 'ONCRMDEALUPDATE', title: 'Сделка изменена', serviceCode: 'bitrix24',
    // В макете это названо crm.deal.stage.changed. Такого события у Bitrix24 нет:
    // смена стадии внутри воронки приходит как обычное обновление сделки.
    aliasInMockup: 'crm.deal.stage.changed',
    sample: (n) => ({ FIELDS: { ID: String(7400 + n) } }),
  },
  {
    code: 'ONCRMDEALDELETE', title: 'Сделка удалена', serviceCode: 'bitrix24',
    sample: (n) => ({ FIELDS: { ID: String(7400 + n) } }),
  },
  {
    code: 'ONCRMLEADADD', title: 'Создан лид', serviceCode: 'bitrix24',
    aliasInMockup: 'crm.lead.add',
    sample: (n) => ({ FIELDS: { ID: String(3100 + n) } }),
  },
  {
    code: 'ONCRMCONTACTADD', title: 'Создан контакт', serviceCode: 'bitrix24',
    sample: (n) => ({ FIELDS: { ID: String(910 + n) } }),
  },
  {
    code: 'ONTASKADD', title: 'Создана задача', serviceCode: 'bitrix24',
    sample: (n) => ({ FIELDS_AFTER: { ID: String(3800 + n) } }),
  },

  // ─────────── Ozon ───────────
  {
    code: 'TYPE_PING', title: 'Проверка подключения', serviceCode: 'ozon',
    sample: (_n, now) => ({ time: iso(now) }),
  },
  {
    code: 'TYPE_NEW_POSTING', title: 'Новое отправление', serviceCode: 'ozon',
    aliasInMockup: 'posting.created',
    sample: (n, now) => ({
      posting_number: `2421950${n % 10}-00${20 + (n % 9)}-1`,
      products: [{ sku: 1_600_000_000 + n * 137, quantity: 1 + (n % 3) }],
      in_process_at: iso(now),
      warehouse_id: 1_020_000_100_000 + n,
      seller_id: 12345,
    }),
  },
  {
    code: 'TYPE_POSTING_CANCELLED', title: 'Отправление отменено', serviceCode: 'ozon',
    aliasInMockup: 'posting.cancelled',
    sample: (n, now) => ({
      posting_number: `2421950${n % 10}-00${20 + (n % 9)}-1`,
      products: [{ sku: 1_600_000_000 + n * 137, quantity: 1 }],
      old_state: 'awaiting_deliver',
      new_state: 'posting_canceled',
      changed_state_date: iso(now),
      reason: { id: 352, message: 'Покупатель отменил заказ' },
      warehouse_id: 1_020_000_100_000 + n,
      seller_id: 12345,
    }),
  },
  {
    code: 'TYPE_STATE_CHANGED', title: 'Изменился статус отправления', serviceCode: 'ozon',
    sample: (n, now) => ({
      posting_number: `2421950${n % 10}-00${20 + (n % 9)}-1`,
      new_state: 'delivering',
      changed_state_date: iso(now),
      warehouse_id: 1_020_000_100_000 + n,
      seller_id: 12345,
    }),
  },
  {
    code: 'TYPE_STOCKS_CHANGED', title: 'Изменились остатки', serviceCode: 'ozon',
    aliasInMockup: 'stocks.changed',
    // Структура батчевая: одно событие покрывает много товаров и много складов.
    sample: (n, now) => ({
      items: [
        {
          updated_at: iso(now),
          sku: 1_600_000_000 + n * 137,
          product_id: 500_000 + n,
          stocks: [{ warehouse_id: 1_020_000_100_000 + n, present: 40 + (n % 60), reserved: n % 7 }],
        },
      ],
      seller_id: 12345,
    }),
  },
  {
    code: 'TYPE_PRICE_INDEX_CHANGED', title: 'Изменился индекс цены', serviceCode: 'ozon',
    sample: (n, now) => ({
      updated_at: iso(now), sku: 1_600_000_000 + n * 137,
      product_id: 500_000 + n, price_index: Number((0.9 + (n % 20) / 100).toFixed(2)), seller_id: 12345,
    }),
  },
  {
    code: 'TYPE_CREATE_OR_UPDATE_ITEM', title: 'Товар создан или обновлён', serviceCode: 'ozon',
    sample: (n, now) => ({
      offer_id: `ART-${1000 + n}`, product_id: 500_000 + n,
      is_error: false, changed_at: iso(now), seller_id: 12345,
    }),
  },

  // ─────────── Wildberries ───────────
  // У WB события приходят конвертом со списком: после простоя до 100 штук в одном запросе.
  {
    code: 'feedback_updated', title: 'Отзыв обновлён', serviceCode: 'wildberries',
    aliasInMockup: 'feedback.created',
    sample: (n, now) => ({
      feedbackId: `fb-${(1000 + n).toString(16)}`,
      nmId: 194_873_000 + n, productValuation: 3 + (n % 3),
      createdDate: iso(now), idempotencyKey: `idm-${(5000 + n).toString(16)}`,
    }),
  },
  {
    code: 'card_changed', title: 'Карточка товара изменена', serviceCode: 'wildberries',
    sample: (n, now) => ({
      nmID: 194_873_000 + n, vendorCode: `ART-${1000 + n}`,
      updatedAt: iso(now), idempotencyKey: `idm-${(6000 + n).toString(16)}`,
    }),
  },
  {
    code: 'card_creation_error', title: 'Ошибка создания карточки', serviceCode: 'wildberries',
    sample: (n, now) => ({
      vendorCode: `ART-${1000 + n}`, errorText: 'Не указан обязательный характеристик товара',
      updatedAt: iso(now), idempotencyKey: `idm-${(7000 + n).toString(16)}`,
    }),
  },
  {
    code: 'report_generation_complete', title: 'Отчёт сформирован', serviceCode: 'wildberries',
    sample: (n, now) => ({
      reportId: `rep-${(8000 + n).toString(16)}`, status: 'SUCCESS',
      finishedAt: iso(now), idempotencyKey: `idm-${(8000 + n).toString(16)}`,
    }),
  },
  {
    code: 'stocks_changed', title: 'Изменились остатки на складе', serviceCode: 'wildberries',
    aliasInMockup: 'stocks.changed',
    sample: (n, now) => ({
      warehouseId: 507_100 + n, nmId: 194_873_000 + n,
      quantity: 20 + (n % 80), updatedAt: iso(now),
      idempotencyKey: `idm-${(9000 + n).toString(16)}`,
    }),
  },
]

export const EVENTS_BY_SERVICE: Readonly<Record<ServiceCode, readonly EventDefinition[]>> = {
  bitrix24: EVENTS.filter((e) => e.serviceCode === 'bitrix24'),
  ozon: EVENTS.filter((e) => e.serviceCode === 'ozon'),
  wildberries: EVENTS.filter((e) => e.serviceCode === 'wildberries'),
}

export function findEvent(code: string): EventDefinition | undefined {
  return EVENTS.find((e) => e.code === code || e.aliasInMockup === code)
}

/**
 * Собирает тело доставки в НАТИВНОМ для сервиса формате.
 *
 * Это самое важное место всей фичи: если тело отличается от боевого, разработчик
 * напишет разбор, который в проде не заработает.
 */
export function buildEventPayload(
  event: EventDefinition,
  options: {
    readonly index: number
    readonly now: Date
    readonly portalDomain: string
    readonly applicationToken: string
    readonly sellerId: number
    readonly requestId: string
    readonly isTest: boolean
  },
): { body: string; contentType: string } {
  const data = event.sample(options.index, options.now)

  if (event.serviceCode === 'bitrix24') {
    // Дословно как боевой портал: application/x-www-form-urlencoded с PHP-скобками.
    const params = new URLSearchParams()
    params.set('event', event.code)
    params.set('event_handler_id', '975')
    flattenPhp(data, 'data', params)
    params.set('ts', String(Math.floor(options.now.getTime() / 1000)))
    params.set('auth[domain]', options.portalDomain)
    params.set('auth[client_endpoint]', `https://${options.portalDomain}/rest/`)
    params.set('auth[server_endpoint]', 'https://oauth.bitrix24.tech/rest/')
    params.set('auth[member_id]', 'd897063e1ce7c5eb9f04b9751eef5915')
    params.set('auth[application_token]', options.applicationToken)
    return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' }
  }

  if (event.serviceCode === 'ozon') {
    // Единого конверта нет: message_type лежит рядом с полезными полями.
    return {
      body: JSON.stringify({ message_type: event.code, ...data }),
      contentType: 'application/json',
    }
  }

  // Wildberries: конверт со списком событий и ключом идемпотентности у каждого.
  return {
    body: JSON.stringify({
      sellerId: String(options.sellerId),
      requestId: options.requestId,
      events: [{ event: event.code, ...data, ...(options.isTest ? { test: true } : {}) }],
    }),
    contentType: 'application/json',
  }
}

/** Раскладывает вложенный объект в PHP-скобки: data[FIELDS][ID]=7405 */
function flattenPhp(value: unknown, prefix: string, out: URLSearchParams): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'object') {
    out.set(prefix, String(value))
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flattenPhp(v, `${prefix}[${k}]`, out)
  }
}

/**
 * Проверка ответа получателя по правилам сервиса.
 *
 * Ozon единственный валидирует ТЕЛО, а не только код: 200 с пустым телом он считает
 * неуспехом. Валидатор живёт на сервере, потому что только у него есть тело ответа.
 */
export function isDeliverySuccessful(
  service: ServiceCode,
  successRule: 'status_2xx' | 'status_200' | 'status_200_and_body',
  statusCode: number | null,
  body: string,
): { ok: boolean; reason?: string } {
  if (statusCode === null) return { ok: false, reason: 'Ответ не получен' }

  if (successRule === 'status_2xx') {
    return statusCode >= 200 && statusCode < 300
      ? { ok: true }
      : { ok: false, reason: `Код ответа ${statusCode}` }
  }

  if (statusCode !== 200) return { ok: false, reason: `STATUS_CODE_NOT_OK: получен ${statusCode}` }
  if (successRule === 'status_200') return { ok: true }

  // status_200_and_body — правила Ozon.
  if (body.trim().length === 0) return { ok: false, reason: 'EMPTY_BODY: пустое тело ответа' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'INVALID_JSON: не удалось разобрать тело ответа' }
  }
  const obj = parsed as Record<string, unknown> | null
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'INVALID_BODY: ожидался объект' }

  // На TYPE_PING Ozon требует version, name и time; на остальные — result: true.
  if ('version' in obj || 'name' in obj) {
    return 'version' in obj && 'name' in obj && 'time' in obj
      ? { ok: true }
      : { ok: false, reason: 'WRONG_RESULT_FIELD: для TYPE_PING нужны version, name и time' }
  }
  return obj.result === true
    ? { ok: true }
    : { ok: false, reason: 'WRONG_RESULT_FIELD: ожидалось {"result": true}' }
}
