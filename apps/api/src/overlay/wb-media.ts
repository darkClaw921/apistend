import { productPool } from '@apistend/mock-engine'
import type { Sandbox } from '@prisma/client'
import { readOverlay, writeOverlay, type WbPhotosOverlay } from './store.ts'
import type { WbEnvelope } from './wb-content.ts'

/**
 * Медиафайлы карточки Wildberries — `POST /content/v3/media/save` (по ссылкам)
 * и `POST /content/v3/media/file` (файлом). Файлы не хранятся по-настоящему —
 * ни песочнице, ни клиенту, проверяющему «фото добавилось», не нужен байт
 * в байт тот же JPEG, только то, что `cards/list` после записи отдаёт photos
 * непустым и в count, который просили сохранить.
 */

const MAX_IMAGES = 30
const VIDEO_EXTENSIONS = /\.(mp4|mov)(\?|$)/i

function errorEnvelope(status: number, errorText: string): WbEnvelope {
  return { status, body: { data: null, error: true, errorText, additionalErrors: null } }
}

const OK: WbEnvelope = { status: 200, body: { data: {}, error: false, errorText: '', additionalErrors: null } }

/** Обрабатывает `POST /content/v3/media/save`. */
export async function handleMediaSave(sandbox: Sandbox, body: unknown): Promise<WbEnvelope> {
  const nmId = (body as { nmId?: unknown })?.nmId
  const data = (body as { data?: unknown })?.data
  if (typeof nmId !== 'number') return { status: 422, body: { data: null, error: true, errorText: 'nmId is required', additionalErrors: null } }
  if (!Array.isArray(data) || data.length === 0 || !data.every((u) => typeof u === 'string')) {
    return errorEnvelope(400, 'data must be a non-empty array of URLs')
  }
  if (!productPool(sandbox.dataVolume).some((p) => p.nmId === nmId)) {
    return errorEnvelope(400, `nmID ${nmId} не найден в каталоге продавца`)
  }
  const videos = data.filter((u) => VIDEO_EXTENSIONS.test(u))
  const images = data.filter((u) => !VIDEO_EXTENSIONS.test(u))
  if (videos.length > 1) return errorEnvelope(400, 'максимум одно видео для одной карточки товара')
  if (images.length > MAX_IMAGES) return errorEnvelope(400, `максимум изображений для одной карточки товара — ${MAX_IMAGES}`)

  // «Новые медиафайлы полностью заменяют старые» — ровно поэтому запись,
  // а не слияние со старым списком.
  const overlay: WbPhotosOverlay = { photos: images }
  await writeOverlay(sandbox.id, 'wildberries', 'wb-photos', String(nmId), overlay)
  return OK
}

/** Обрабатывает `POST /content/v3/media/file` — заголовки `X-Nm-Id`/`X-Photo-Number`, тело не разбирается. */
export async function handleMediaFile(
  sandbox: Sandbox,
  headers: Record<string, string | string[] | undefined>,
): Promise<WbEnvelope> {
  const nmIdHeader = headers['x-nm-id']
  const numberHeader = headers['x-photo-number']
  const nmId = Number(Array.isArray(nmIdHeader) ? nmIdHeader[0] : nmIdHeader)
  const photoNumber = Number(Array.isArray(numberHeader) ? numberHeader[0] : numberHeader)
  if (!Number.isFinite(nmId)) return { status: 422, body: { data: null, error: true, errorText: 'X-Nm-Id is required', additionalErrors: null } }
  if (!Number.isInteger(photoNumber) || photoNumber < 1) {
    return errorEnvelope(400, 'X-Photo-Number обязателен и начинается с 1')
  }
  if (!productPool(sandbox.dataVolume).some((p) => p.nmId === nmId)) {
    return errorEnvelope(400, `nmID ${nmId} не найден в каталоге продавца`)
  }

  const existing = await readOverlay<WbPhotosOverlay>(sandbox.id, 'wildberries', 'wb-photos', String(nmId))
  const photos = [...(existing?.photos ?? [])]
  if (photoNumber > photos.length + 1) {
    return errorEnvelope(400, 'чтобы добавить изображение к уже загруженным, номер медиафайла должен быть больше количества уже загруженных')
  }
  if (photos.length >= MAX_IMAGES && photoNumber > photos.length) {
    return errorEnvelope(400, `максимум изображений для одной карточки товара — ${MAX_IMAGES}`)
  }
  // Реального файла в песочнице нет — только адрес, детерминированный по
  // артикулу и номеру: два запроса с теми же заголовками дают тот же URL.
  photos[photoNumber - 1] = `https://cdn.apistend.sandbox/media/wb/${nmId}/${photoNumber}.jpg`

  await writeOverlay(sandbox.id, 'wildberries', 'wb-photos', String(nmId), { photos } satisfies WbPhotosOverlay)
  return OK
}
