import { productPool } from '@apistend/mock-engine'
import type { Sandbox } from '@prisma/client'
import { readOverlayMap, writeOverlay, type OzonImagesOverlay } from './store.ts'
import type { OzonEnvelope } from './ozon-content.ts'

/** Изображения Ozon — `POST /v1/product/pictures/import` и чтение `POST /v3/product/info/list`. */

const MAX_IMAGES = 30

function rpcError(status: number, message: string): OzonEnvelope {
  return { status, body: { code: status, message, details: [] } }
}

/** Обрабатывает `POST /v1/product/pictures/import`. */
export async function handlePicturesImport(sandbox: Sandbox, body: unknown): Promise<OzonEnvelope> {
  const productId = (body as { product_id?: unknown })?.product_id
  const images = (body as { images?: unknown })?.images
  if (typeof productId !== 'number') return rpcError(400, 'product_id обязателен и должен быть числом')
  if (!Array.isArray(images) || images.length === 0 || !images.every((u) => typeof u === 'string')) {
    return rpcError(400, 'images обязателен: непустой массив ссылок')
  }
  if (images.length > MAX_IMAGES) return rpcError(400, `images: не более ${MAX_IMAGES} ссылок`)

  const product = productPool(sandbox.dataVolume).find((p) => p.chrtId === productId)
  if (!product) return rpcError(404, `товар с product_id ${productId} не найден`)

  const overlay: OzonImagesOverlay = { images }
  await writeOverlay(sandbox.id, 'ozon', 'ozon-images', product.vendorCode, overlay)

  // «Предварительный результат»: в бою состояние картинки становится
  // окончательным только через отдельный /v1/product/pictures/info секунд
  // через десять. Песочница обрабатывает мгновенно, но форму ответа держит
  // ту же, что и «предварительный» боевой ответ, — imported, не uploaded.
  return {
    status: 200,
    body: {
      result: {
        pictures: images.map((url, i) => ({
          product_id: productId,
          url,
          is_primary: i === 0,
          is_360: false,
          is_color: false,
          state: 'imported',
        })),
      },
    },
  }
}

/** `/v3/product/info/list`: `items[].images` — полностью заменяются, «предыдущие сотрутся», как и в бою. */
export async function applyOzonImagesOverlay(sandboxId: string, body: unknown): Promise<boolean> {
  const items = (body as { items?: unknown })?.items
  if (!Array.isArray(items) || items.length === 0) return false
  const overlay = await readOverlayMap<OzonImagesOverlay>(sandboxId, 'ozon', 'ozon-images')
  if (overlay.size === 0) return false

  let changed = false
  for (const item of items as Array<Record<string, unknown>>) {
    const offerId = item.offer_id
    if (typeof offerId !== 'string') continue
    const patch = overlay.get(offerId)
    if (!patch) continue
    item.images = patch.images
    item.primary_image = patch.images[0] ?? null
    changed = true
  }
  return changed
}
