import { sample } from 'openapi-sampler'
import { Deterministic } from './deterministic.ts'
import {
  BRAND, CATEGORY, CITY, COMPANY_NAME, COMPANY_PREFIX, FIRST_NAME, LAST_NAME,
  ORDER_STATUS, POSTING_STATUS, PRODUCT, WAREHOUSE,
} from './dictionaries.ts'

/**
 * Второй ярус ответа: схема + датасет.
 *
 * openapi-sampler даёт скелет (он документированно детерминирован и умеет $ref,
 * allOf/oneOf, discriminator). Дальше проходим по скелету и заменяем его заглушки
 * («string», 0) правдоподобными значениями, выведенными из имени поля.
 *
 * Ключ генерации — путь к полю, поэтому значение стабильно между вызовами
 * и одинаково для одного и того же поля в разных методах.
 */

export interface FillContext {
  det: Deterministic
  /** Опорная дата: передаётся снаружи, чтобы ответ не зависел от текущего момента. */
  now: Date
}

const SAMPLER_OPTIONS = { skipReadOnly: false, skipWriteOnly: true, quiet: true } as const

/** Заглушки, которые openapi-sampler ставит при отсутствии example/enum/default. */
function isPlaceholder(value: unknown): boolean {
  return value === 'string' || value === 0 || value === 'string@example.com'
}

function isoDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Что означает «name» — зависит от того, что мы отдаём.
 * У склада это адрес, у товара — название товара, у поставщика — юрлицо.
 * Контекст берём из пути ответа: он содержит и эндпоинт, и цепочку полей.
 */
function byContext(path: string, key: string, det: Deterministic): string {
  const p = path.toLowerCase()
  if (/warehouse|office|store|pickup|склад/.test(p)) return `ул. Складская, ${det.pick(key, CITY)}`
  if (/supplier|seller|company|legal|partner|counterpart/.test(p))
    return `${det.pick(key, COMPANY_PREFIX)} «${det.pick(`${key}#n`, COMPANY_NAME)}»`
  if (/subject|category|parent/.test(p)) return det.pick(key, CATEGORY)
  if (/brand/.test(p)) return det.pick(key, BRAND)
  if (/city|region|address|delivery/.test(p)) return det.pick(key, CITY)
  if (/user|client|buyer|customer|employee/.test(p))
    return `${det.pick(key, FIRST_NAME)} ${det.pick(`${key}#l`, LAST_NAME)}`
  // По умолчанию это карточка товара — самый частый случай во всех трёх API.
  return det.pick(key, PRODUCT)
}

/** Значение по имени поля. Возвращает undefined, если имя ничего не подсказывает. */
function byFieldName(name: string, path: string, ctx: FillContext, type: 'string' | 'number'): unknown {
  const n = name.toLowerCase()
  const { det, now } = ctx
  const key = path

  if (type === 'string') {
    if (/(^|_|\b)(uuid|guid)/.test(n)) return det.uuid(key)
    if (/(created|updated|changed|shipment|delivery|cutoff|order|process|begin|end|last|next)?(date|_at|time)$/.test(n) || n.endsWith('date') || n.endsWith('at'))
      return isoDate(det.date(key, now, 0, 30))
    if (/barcode|ean/.test(n)) return `20${det.hex(key, 0)}${String(det.int(key, 10_000_000_000, 99_999_999_999))}`.slice(0, 13)
    if (/postingnumber|posting_number/.test(n)) return `${det.int(key, 10_000_000, 99_999_999)}-${String(det.int(`${key}#a`, 0, 99)).padStart(4, '0')}-${det.int(`${key}#b`, 1, 9)}`
    if (/warehousename|officename/.test(n)) return det.pick(key, WAREHOUSE)
    if (/(^|_)(name|title)$/.test(n)) return byContext(path, key, det)
    if (/(supplier|company|legal|seller|partner)/.test(n))
      return `${det.pick(key, COMPANY_PREFIX)} «${det.pick(`${key}#n`, COMPANY_NAME)}»`
    if (/city|town|locality/.test(n)) return det.pick(key, CITY)
    if (/brand/.test(n)) return det.pick(key, BRAND)
    if (/(subject|category)/.test(n)) return det.pick(key, CATEGORY)
    if (/productname|goodsname|itemname/.test(n)) return det.pick(key, PRODUCT)
    if (/firstname|clientname|username/.test(n)) return det.pick(key, FIRST_NAME)
    if (/lastname|surname/.test(n)) return det.pick(key, LAST_NAME)
    if (/email/.test(n)) return `user${det.int(key, 1, 999)}@example.ru`
    if (/phone/.test(n)) return `+7 9${det.int(key, 10, 99)} ${det.int(`${key}#1`, 100, 999)}-${det.int(`${key}#2`, 10, 99)}-${det.int(`${key}#3`, 10, 99)}`
    if (/inn/.test(n)) return String(det.int(key, 1_000_000_000, 9_999_999_999))
    if (/address/.test(n)) return `${det.pick(key, CITY)}, ул. Складская, д. ${det.int(`${key}#d`, 1, 90)}`
    if (/url|link|href/.test(n)) return `https://example.ru/${det.hex(key, 8)}`
    if (/currency/.test(n)) return 'RUB'
    if (/(^|_)status$/.test(n)) return det.pick(key, /posting|supply/.test(path.toLowerCase()) ? POSTING_STATUS : ORDER_STATUS)
    if (/(vendorcode|offer_id|offerid|article|sku)/.test(n)) return `ART-${det.int(key, 1000, 9999)}`
    if (/(^|_)(id)$/.test(n)) return String(det.int(key, 1000, 99_999))
    if (/comment|description|text|message/.test(n)) return 'Демо-данные песочницы APIStend'
    return `${name}-${det.hex(key, 6)}`
  }

  if (/(price|total|sum|amount|cost|discount|payout|commission)/.test(n)) return det.int(key, 149, 24_990)
  if (/(quantity|qty|count|stock|present|reserved|available)/.test(n)) return det.int(key, 0, 240)
  if (/(nmid|nm_id)/.test(n)) return det.int(key, 100_000_000, 299_999_999)
  if (/(sku|chrtid|chrt_id)/.test(n)) return det.int(key, 1_000_000_000, 2_999_999_999)
  if (/warehouseid|officeid/.test(n)) return det.int(key, 100, 99_999)
  if (/(rating|rate)$/.test(n)) return det.int(key, 3, 5)
  if (/percent|index/.test(n)) return det.int(key, 0, 100)
  if (/(^|_)(id)$/.test(n)) return det.int(key, 1000, 99_999)
  return det.int(key, 1, 999)
}

/**
 * Поля, которые обязаны различаться между элементами списка.
 *
 * Схемы часто несут example на уровне поля, и сэмплер честно подставляет его в каждый
 * элемент массива. Для описания одного объекта это правильно, для списка — нет:
 * выдача, где у всех записей id = 1, ломает любого клиента, который кладёт их в словарь
 * по ключу, и сразу выдаёт мок. Такие поля перегенерируем по индексу элемента.
 */
const IDENTITY_TOKENS = new Set([
  'id', 'ids', 'uuid', 'guid', 'number', 'code', 'sku', 'barcode',
  'article', 'nmid', 'chrtid', 'offerid', 'vendorcode', 'postingnumber', 'rid', 'srid',
])

/** Последний токен имени поля: warehouseId -> id, offer_id -> id, nmID -> id. */
function lastToken(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return parts[parts.length - 1] ?? name.toLowerCase()
}

function isIdentityField(name: string): boolean {
  return IDENTITY_TOKENS.has(lastToken(name)) || IDENTITY_TOKENS.has(name.toLowerCase())
}

/** Рекурсивно заменяет заглушки сэмплера правдоподобными значениями. */
function fill(node: unknown, path: string, key: string, ctx: FillContext, depth = 0, inArray = false): unknown {
  if (depth > 24) return node

  if (Array.isArray(node)) {
    // У массива-примера сэмплер даёт один элемент. Размножаем его детерминированно,
    // чтобы списки в интерфейсе не выглядели пустыми.
    if (node.length === 0) return node
    const count = ctx.det.int(`${path}#len`, 2, 4)
    const first = node[0]
    return Array.from({ length: count }, (_, i) => fill(first, `${path}[${i}]`, key, ctx, depth + 1, true))
  }

  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = fill(v, `${path}.${k}`, k, ctx, depth + 1, inArray)
    }
    return out
  }

  const identityInList = inArray && key.length > 0 && isIdentityField(key)

  if (typeof node === 'string' && (isPlaceholder(node) || identityInList)) {
    return byFieldName(key, path, ctx, 'string')
  }
  if (typeof node === 'number' && (isPlaceholder(node) || identityInList)) {
    return byFieldName(key, path, ctx, 'number')
  }
  return node
}

/**
 * Строит ответ из схемы. Возвращает null, если схему не удалось разобрать —
 * тогда вызывающая сторона уходит на третий ярус (generic-конверт).
 */
export function buildFromSchema(
  schema: unknown,
  spec: object | undefined,
  ctx: FillContext,
  pathSalt: string,
): unknown | null {
  if (!schema || typeof schema !== 'object') return null
  try {
    const skeleton = sample(schema as never, SAMPLER_OPTIONS, spec)
    if (skeleton === undefined) return null
    return fill(skeleton, pathSalt, '', ctx)
  } catch {
    // Битая схема или циклический $ref, который сэмплер не осилил.
    return null
  }
}
