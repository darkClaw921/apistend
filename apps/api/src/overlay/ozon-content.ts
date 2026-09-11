import { productPool, type Product } from '@apistend/mock-engine'
import type { Sandbox } from '@prisma/client'
import { readOverlay, readOverlayMap, writeOverlay, type OzonItemOverlay, type OzonTaskOverlay } from './store.ts'

/**
 * Характеристики и описание товара Ozon — `POST /v1/product/attributes/update`,
 * статус `POST /v1/product/import/info` и чтение `POST /v4/product/info/attributes`
 * / `POST /v3/product/info/list`.
 *
 * Название товара (`name`) этим методом не задаётся — и в бою тоже: `attributes/
 * update` умеет только добавлять и менять характеристики, а `name` — отдельное
 * поле карточки, которое трогает лишь тяжёлый `/v3/product/import` (обязательны
 * `description_category_id`/`type_id`/цена и объёмно-весовые характеристики).
 * Раз в этом заходе он не реализован, `name` через `attributes/update` не
 * меняется — как и в бою.
 *
 * Описание — не отдельное поле карточки Ozon, а характеристика с id 4191
 * («Аннотация»): в снимке спецификации есть настоящий пример с этим id рядом
 * с длинным описательным текстом, оттуда номер и взят, а не выдуман.
 */

export const OZON_DESCRIPTION_ATTRIBUTE_ID = 4191

export interface OzonEnvelope {
  readonly status: number
  readonly body: Record<string, unknown>
}

function rpcError(status: number, message: string): OzonEnvelope {
  return { status, body: { code: status, message, details: [] } }
}

interface AttributeInput {
  readonly id?: unknown
  readonly complex_id?: unknown
  readonly values?: unknown
}

interface ItemInput {
  readonly offer_id?: unknown
  readonly attributes?: unknown
}

function findByOfferId(pool: readonly Product[], offerId: string): Product | undefined {
  return pool.find((p) => p.vendorCode === offerId)
}

function attributeText(values: unknown): string | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined
  const first = values[0] as { value?: unknown } | undefined
  return typeof first?.value === 'string' ? first.value : undefined
}

/** Обрабатывает `POST /v1/product/attributes/update`. Асинхронный в бою — задача заводится и сразу «обработана». */
export async function handleAttributesUpdate(sandbox: Sandbox, body: unknown): Promise<OzonEnvelope> {
  const items = (body as { items?: unknown })?.items
  if (!Array.isArray(items) || items.length === 0) {
    return rpcError(400, 'items: обязателен непустой массив')
  }

  const pool = productPool(sandbox.dataVolume)
  const offerIds: string[] = []
  for (const raw of items as ItemInput[]) {
    if (typeof raw.offer_id !== 'string' || raw.offer_id.length === 0) {
      return rpcError(400, 'offer_id обязателен для каждого товара')
    }
    if (!findByOfferId(pool, raw.offer_id)) {
      return rpcError(404, `товар с offer_id "${raw.offer_id}" не найден`)
    }
    if (raw.attributes !== undefined && !Array.isArray(raw.attributes)) {
      return rpcError(400, 'attributes обязан быть массивом')
    }
    for (const attr of (raw.attributes ?? []) as AttributeInput[]) {
      if (typeof attr.id !== 'number') return rpcError(400, 'attributes[].id обязателен и должен быть числом')
      if (!Array.isArray(attr.values) || attr.values.length === 0) {
        return rpcError(400, `attributes[].values обязателен и не может быть пустым (id ${attr.id})`)
      }
    }
    offerIds.push(raw.offer_id)
  }

  for (const raw of items as ItemInput[]) {
    const attributes = (raw.attributes ?? []) as AttributeInput[]
    const overlay: OzonItemOverlay = {
      attributes: attributes.map((a) => ({ id: a.id as number, values: a.values as unknown[] })),
    }
    await writeOverlay(sandbox.id, 'ozon', 'ozon-item', raw.offer_id as string, overlay)
  }

  const taskId = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  const task: OzonTaskOverlay = { offerIds }
  await writeOverlay(sandbox.id, 'ozon', 'ozon-task', String(taskId), task)

  return { status: 200, body: { task_id: taskId } }
}

/** Обрабатывает `POST /v1/product/import/info`. */
export async function handleImportInfo(sandbox: Sandbox, body: unknown): Promise<OzonEnvelope> {
  const taskId = (body as { task_id?: unknown })?.task_id
  const idStr = typeof taskId === 'string' || typeof taskId === 'number' ? String(taskId) : ''
  const task = idStr ? await readOverlay<OzonTaskOverlay>(sandbox.id, 'ozon', 'ozon-task', idStr) : null
  if (!task) return rpcError(400, `task_id "${String(taskId)}" не найден`)

  const pool = productPool(sandbox.dataVolume)
  const items = task.offerIds.map((offerId) => {
    const product = findByOfferId(pool, offerId)
    return { offer_id: offerId, product_id: product?.chrtId ?? 0, status: 'imported', errors: [] }
  })
  return { status: 200, body: { result: { items, total: items.length } } }
}

/**
 * Накладывает overlay характеристик на ответ, где есть верхнеуровневый `name`
 * и массив `attributes[]` (`/v4/product/info/attributes`) — описание (id 4191)
 * подставляется и туда, и в отдельные поля вроде `description`, если пример
 * автора его показывает: разные читающие методы называют его по-разному,
 * а источник данных один.
 */
export async function applyOzonAttributesOverlay(sandboxId: string, body: unknown): Promise<boolean> {
  const items = (body as { result?: unknown })?.result
  if (!Array.isArray(items) || items.length === 0) return false

  const overlay = await readOverlayMap<OzonItemOverlay>(sandboxId, 'ozon', 'ozon-item')
  if (overlay.size === 0) return false

  let changed = false
  for (const item of items as Array<Record<string, unknown>>) {
    const offerId = item.offer_id
    if (typeof offerId !== 'string') continue
    const patch = overlay.get(offerId)
    if (!patch?.attributes) continue

    const existing = Array.isArray(item.attributes) ? (item.attributes as Array<Record<string, unknown>>) : []
    const byId = new Map(existing.map((a) => [a.id, a]))
    for (const attr of patch.attributes) {
      byId.set(attr.id, { id: attr.id, complex_id: 0, values: attr.values })
    }
    item.attributes = [...byId.values()]

    const description = attributeText(byId.get(OZON_DESCRIPTION_ATTRIBUTE_ID)?.values)
    if (description !== undefined && typeof item.description === 'string') item.description = description
    changed = true
  }
  return changed
}
