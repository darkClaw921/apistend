import { productPool } from '@apistend/mock-engine'
import type { Sandbox } from '@prisma/client'
import { readOverlay, readOverlayMap, writeOverlay, type WbPriceOverlay, type WbTaskOverlay } from './store.ts'
import type { WbEnvelope } from './wb-content.ts'

/**
 * Цены и скидки Wildberries — `POST /api/v2/upload/task`,
 * `GET /api/v2/history/tasks` и чтение `GET/POST /api/v2/list/goods/filter`.
 *
 * Боевой метод асинхронный: установка цены создаёт задачу, а не меняет цену
 * тем же ответом. Песочница считает задачу обработанной сразу же — ждать
 * тут решительно нечего, — но форма ответа и статус те же, что у настоящей
 * обработанной загрузки (`status: 3`, «обработана, ошибок нет»), и `uploadID`
 * из ответа действительно можно передать в `history/tasks` и получить его.
 */

interface GoodInput {
  readonly nmID?: unknown
  readonly price?: unknown
  readonly discount?: unknown
}

function errorEnvelope(status: number, errorText: string): WbEnvelope {
  return { status, body: { data: null, error: true, errorText } }
}

function validateGood(raw: GoodInput, known: Set<number>): string | null {
  if (typeof raw.nmID !== 'number') return 'Invalid item No.'
  if (!known.has(raw.nmID)) return 'Invalid item No.'
  const hasPrice = raw.price !== undefined && raw.price !== null
  const hasDiscount = raw.discount !== undefined && raw.discount !== null
  if (!hasPrice && !hasDiscount) return 'Price and discount not specified'
  if (hasPrice) {
    if (typeof raw.price !== 'number' || !Number.isFinite(raw.price)) return 'Invalid price value'
    if (!Number.isInteger(raw.price)) return 'Price should be a whole number'
    if (raw.price < 0) return 'Invalid price value'
  }
  if (hasDiscount) {
    if (typeof raw.discount !== 'number' || !Number.isInteger(raw.discount) || raw.discount < 0 || raw.discount > 99) {
      return 'Invalid discount value'
    }
  }
  return null
}

/** Обрабатывает `POST /api/v2/upload/task`. */
export async function handlePriceUpload(sandbox: Sandbox, body: unknown): Promise<WbEnvelope> {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data) || data.length === 0) return errorEnvelope(400, 'Empty data')
  if (data.length > 1000) return errorEnvelope(400, 'Upload limit exceeded: You can upload a maximum of 1 000 items')

  const known = new Set(productPool(sandbox.dataVolume).map((p) => p.nmId))
  for (const raw of data as GoodInput[]) {
    const error = validateGood(raw, known)
    if (error) return errorEnvelope(400, error)
  }

  const nmIds = (data as GoodInput[]).map((g) => g.nmID as number)
  for (const raw of data as GoodInput[]) {
    const overlay: WbPriceOverlay = {
      ...(typeof raw.price === 'number' ? { price: raw.price } : {}),
      ...(typeof raw.discount === 'number' ? { discount: raw.discount } : {}),
    }
    await writeOverlay(sandbox.id, 'wildberries', 'wb-price', String(raw.nmID), overlay)
  }

  // ID загрузки: время плюс соль запроса — уникальности внутри одной песочницы
  // достаточно, и в отличие от инкремента в базе не нужна отдельная таблица
  // счётчиков ради номера, который существует только для истории обработки.
  const taskId = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  const task: WbTaskOverlay = { nmIds }
  await writeOverlay(sandbox.id, 'wildberries', 'wb-task', String(taskId), task)

  return { status: 200, body: { data: { id: taskId, alreadyExists: false }, error: false, errorText: '' } }
}

/** Обрабатывает `GET /api/v2/history/tasks`. */
export async function handleTaskHistory(sandbox: Sandbox, uploadId: string | undefined): Promise<WbEnvelope> {
  const id = Number(uploadId)
  if (!uploadId || !Number.isFinite(id)) {
    return errorEnvelope(400, 'Invalid request parameters')
  }
  const task = await readOverlay<WbTaskOverlay>(sandbox.id, 'wildberries', 'wb-task', String(id))
  if (!task) return errorEnvelope(400, 'Invalid request parameters')

  return {
    status: 200,
    body: {
      data: {
        uploadID: id,
        // 3 — «обработана, в товарах нет ошибок, цены и скидки обновились»:
        // ровно то, что уже случилось при загрузке в этой же песочнице.
        status: 3,
        uploadDate: new Date().toISOString(),
        activationDate: new Date().toISOString(),
        overAllGoodsNumber: task.nmIds.length,
        successGoodsNumber: task.nmIds.length,
      },
      error: false,
      errorText: '',
    },
  }
}

/**
 * Накладывает overlay цен на ответ `list/goods/filter`.
 *
 * Скидка — плоское поле `discount`; цена и цена со скидкой лежат внутри
 * `sizes[]` (у песочницы один размер на карточку — `techSize: '0'`).
 * Пересчёт `discountedPrice` от новой пары цена/скидка держит карточку
 * согласованной саму с собой: клиент, сравнивающий цену со скидкой и саму
 * скидку, не должен увидеть арифметику, которая не сходится.
 */
export async function applyWbPriceOverlay(sandboxId: string, body: unknown): Promise<boolean> {
  const listGoods = (body as { data?: { listGoods?: unknown } })?.data?.listGoods
  if (!Array.isArray(listGoods) || listGoods.length === 0) return false

  const overlay = await readOverlayMap<WbPriceOverlay>(sandboxId, 'wildberries', 'wb-price')
  if (overlay.size === 0) return false

  let changed = false
  for (const good of listGoods as Array<Record<string, unknown>>) {
    const nmId = good.nmID
    if (typeof nmId !== 'number') continue
    const patch = overlay.get(String(nmId))
    if (!patch) continue

    const sizes = Array.isArray(good.sizes) ? (good.sizes as Array<Record<string, unknown>>) : []
    const currentPrice = typeof sizes[0]?.price === 'number' ? (sizes[0]!.price as number) : 0
    const price = patch.price ?? currentPrice
    const discount = patch.discount ?? (typeof good.discount === 'number' ? (good.discount as number) : 0)
    const discountedPrice = Math.round((price * (100 - discount)) / 100)

    good.discount = discount
    for (const size of sizes) {
      size.price = price
      size.discountedPrice = discountedPrice
      // Скидка WB Клуба поверх обычной — своей правки у неё нет, оставляем
      // прежнее соотношение к цене со скидкой, а не выдумываем новую скидку.
      if (typeof size.clubDiscountedPrice === 'number' && typeof good.clubDiscount === 'number') {
        size.clubDiscountedPrice = Math.round((price * (100 - discount - (good.clubDiscount as number))) / 100)
      }
    }
    changed = true
  }
  return changed
}
