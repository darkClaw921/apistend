import { productPool, type Product } from '@apistend/mock-engine'
import type { Sandbox } from '@prisma/client'
import { readOverlayMap, writeOverlay, type OzonPriceOverlay } from './store.ts'
import type { OzonEnvelope } from './ozon-content.ts'

/**
 * Цены Ozon — `POST /v1/product/import/prices` (в отличие от WB, синхронный:
 * ответ сразу несёт результат по каждому товару, без отдельной задачи) и
 * чтение `POST /v5/product/info/prices` / `POST /v3/product/info/list`.
 */

interface PriceInput {
  readonly offer_id?: unknown
  readonly product_id?: unknown
  readonly price?: unknown
  readonly old_price?: unknown
}

function findItem(pool: readonly Product[], raw: PriceInput): Product | undefined {
  // «Если запрос содержит оба параметра — offer_id и product_id, изменения
  // применятся к товару с offer_id» — тот же приоритет и здесь.
  if (typeof raw.offer_id === 'string' && raw.offer_id.length > 0) {
    return pool.find((p) => p.vendorCode === raw.offer_id)
  }
  if (typeof raw.product_id === 'number') return pool.find((p) => p.chrtId === raw.product_id)
  return undefined
}

function toPrice(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Обрабатывает `POST /v1/product/import/prices`. */
export async function handlePriceImport(sandbox: Sandbox, body: unknown): Promise<OzonEnvelope> {
  const prices = (body as { prices?: unknown })?.prices
  if (!Array.isArray(prices) || prices.length === 0) {
    return { status: 400, body: { code: 400, message: 'prices: обязателен непустой массив', details: [] } }
  }
  if (prices.length > 1000) {
    return { status: 400, body: { code: 400, message: 'prices: не более 1000 товаров за запрос', details: [] } }
  }

  const pool = productPool(sandbox.dataVolume)
  const result = []
  for (const raw of prices as PriceInput[]) {
    const product = findItem(pool, raw)
    const offerId = typeof raw.offer_id === 'string' ? raw.offer_id : (product?.vendorCode ?? '')
    const productId = product?.chrtId ?? (typeof raw.product_id === 'number' ? raw.product_id : 0)

    if (!product) {
      result.push({ offer_id: offerId, product_id: productId, updated: false, errors: [{ code: 'NOT_FOUND', message: 'товар не найден' }] })
      continue
    }
    const price = toPrice(raw.price)
    if (price === undefined) {
      result.push({ offer_id: offerId, product_id: productId, updated: false, errors: [{ code: 'INCORRECT_PRICE', message: 'некорректная цена' }] })
      continue
    }
    const oldPrice = raw.old_price !== undefined ? toPrice(raw.old_price) : undefined

    const overlay: OzonPriceOverlay = { price, ...(oldPrice !== undefined ? { oldPrice } : {}) }
    await writeOverlay(sandbox.id, 'ozon', 'ozon-price', product.vendorCode, overlay)
    result.push({ offer_id: offerId, product_id: productId, updated: true, errors: [] })
  }

  return { status: 200, body: { result } }
}

/** Накладывает overlay цены на элемент вида `{ price: <число>, old_price: <число> }` — общая форма обеих читающих ручек. */
function patchPriceFields(target: Record<string, unknown>, patch: OzonPriceOverlay): void {
  if (patch.price !== undefined) target.price = String(patch.price)
  if (patch.oldPrice !== undefined) target.old_price = String(patch.oldPrice)
}

/** `/v5/product/info/prices`: `items[].price.{price, old_price}`. */
export async function applyOzonPriceInfoOverlay(sandboxId: string, body: unknown): Promise<boolean> {
  const items = (body as { items?: unknown })?.items
  if (!Array.isArray(items) || items.length === 0) return false
  const overlay = await readOverlayMap<OzonPriceOverlay>(sandboxId, 'ozon', 'ozon-price')
  if (overlay.size === 0) return false

  let changed = false
  for (const item of items as Array<Record<string, unknown>>) {
    const offerId = item.offer_id
    if (typeof offerId !== 'string') continue
    const patch = overlay.get(offerId)
    if (!patch) continue
    const price = item.price
    if (price !== null && typeof price === 'object') {
      patchPriceFields(price as Record<string, unknown>, patch)
      changed = true
    }
  }
  return changed
}

/** `/v3/product/info/list`: `items[].price`/`items[].old_price` — плоские поля, а не вложенный объект. */
export async function applyOzonPriceListOverlay(sandboxId: string, body: unknown): Promise<boolean> {
  const items = (body as { items?: unknown })?.items
  if (!Array.isArray(items) || items.length === 0) return false
  const overlay = await readOverlayMap<OzonPriceOverlay>(sandboxId, 'ozon', 'ozon-price')
  if (overlay.size === 0) return false

  let changed = false
  for (const item of items as Array<Record<string, unknown>>) {
    const offerId = item.offer_id
    if (typeof offerId !== 'string') continue
    const patch = overlay.get(offerId)
    if (!patch) continue
    patchPriceFields(item, patch)
    changed = true
  }
  return changed
}
