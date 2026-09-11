import { productPool, type Product } from '@apistend/mock-engine'
import type { Sandbox } from '@prisma/client'
import { readOverlayMap, writeOverlay, type WbCardOverlay, type WbPhotosOverlay } from './store.ts'

/**
 * Запись и чтение карточки контента Wildberries — `POST /content/v2/cards/update`
 * и `POST /content/v2/get/cards/list`.
 *
 * До этой правки `cards/update` отвечал успехом и не сохранял ничего: кнопка
 * «Применить» в разборе карточки (правка названия, описания, характеристик)
 * работала бы на стенде только на вид. Теперь запись уходит в overlay
 * песочницы (см. store.ts) и следующее чтение `cards/list` отдаёт её.
 *
 * Валидация — по объявленным правилам метода в спецификации WB: обязательные
 * nmID/vendorCode/sizes, длина названия и описания, характеристики. Одного
 * известного из спецификации нет — каталога характеристик по каждому из
 * тысяч предметов WB: тут песочница честно ограничена своим небольшим
 * справочником (см. WB_CHARACTERISTICS) вместо того, чтобы утверждать полное
 * покрытие, которого нет.
 */

export interface WbEnvelope {
  readonly status: number
  readonly body: Record<string, unknown>
}

function errorEnvelope(status: number, errorText: string, additionalErrors: unknown = null): WbEnvelope {
  return { status, body: { data: null, error: true, errorText, additionalErrors } }
}

const OK: WbEnvelope = { status: 200, body: { data: null, error: false, errorText: '', additionalErrors: {} } }

/** Наименование — до 60 символов, по объявленному в спецификации maxLength. */
const TITLE_MAX_LENGTH = 60
/**
 * Описание — «максимум зависит от категории: стандарт 2000, минимум 1000,
 * максимум 5000». Минимум не проверяется: он отсекал бы короткие тестовые
 * описания, которые на стенде — обычное дело, а не брак карточки. Верхняя
 * граница одна на все категории, потому что своей категорийной таблицы у
 * песочницы нет.
 */
const DESCRIPTION_MAX_LENGTH = 5000

/**
 * Справочник характеристик, которые понимает песочница.
 *
 * Реальный справочник WB — `GET /content/v2/object/charcs/{subjectId}`,
 * тысячи характеристик, свои для каждого предмета. Заводить их все ради
 * мока значило бы выдумывать данные, которых нет ни в одной спецификации.
 * Поэтому здесь — маленький набор, общий для любого предмета каталога:
 * достаточно, чтобы «неизвестная характеристика» стала проверяемым случаем,
 * не изображая покрытие, которого нет. 14177449 и 14177450 — настоящие ID
 * из примеров спецификации (`Цвет` и характеристика состава); остальные —
 * свои номера песочницы, подобранные в том же диапазоне.
 */
export const WB_CHARACTERISTICS: ReadonlyArray<{
  readonly id: number
  readonly name: string
  /** 1 — массив строк, 4 — число. Как в спецификации `charcType`. */
  readonly type: 1 | 4
  /** 0 — без ограничения. */
  readonly maxCount: number
}> = [
  { id: 14177449, name: 'Цвет', type: 1, maxCount: 1 },
  { id: 14177450, name: 'Состав', type: 1, maxCount: 0 },
  { id: 14208985, name: 'Страна производства', type: 1, maxCount: 1 },
  { id: 14208986, name: 'Материал', type: 1, maxCount: 3 },
  { id: 14208987, name: 'Вес товара, г', type: 4, maxCount: 1 },
  { id: 14208988, name: 'Гарантийный срок', type: 1, maxCount: 1 },
]

const CHARACTERISTIC_BY_ID = new Map(WB_CHARACTERISTICS.map((c) => [c.id, c]))

interface CardInput {
  readonly nmID?: unknown
  readonly vendorCode?: unknown
  readonly sizes?: unknown
  readonly title?: unknown
  readonly description?: unknown
  readonly characteristics?: unknown
}

/** Товар из общего каталога по артикулу — единственный источник «известных» nmID. */
function findProduct(pool: readonly Product[], nmId: number): Product | undefined {
  return pool.find((p) => p.nmId === nmId)
}

/**
 * Проверяет одну карточку из запроса. Возвращает текст ошибки или null,
 * если карточка годна к сохранению.
 */
function validateCard(raw: CardInput, pool: readonly Product[]): string | null {
  if (typeof raw.nmID !== 'number') return 'nmID обязателен и должен быть числом'
  if (typeof raw.vendorCode !== 'string' || raw.vendorCode.length === 0) return 'vendorCode обязателен'
  if (!Array.isArray(raw.sizes) || raw.sizes.length === 0) {
    return 'sizes обязателен: передайте массив размеров даже для безразмерного товара'
  }
  if (!findProduct(pool, raw.nmID)) return `nmID ${raw.nmID} не найден в каталоге продавца`
  if (typeof raw.title === 'string' && raw.title.length > TITLE_MAX_LENGTH) {
    return `Наименование длиннее ${TITLE_MAX_LENGTH} символов`
  }
  if (typeof raw.description === 'string' && raw.description.length > DESCRIPTION_MAX_LENGTH) {
    return `Описание длиннее ${DESCRIPTION_MAX_LENGTH} символов`
  }
  if (Array.isArray(raw.characteristics)) {
    for (const c of raw.characteristics) {
      if (c === null || typeof c !== 'object') return 'characteristics: каждый элемент обязан быть объектом {id, value}'
      const id = (c as { id?: unknown }).id
      const value = (c as { value?: unknown }).value
      if (typeof id !== 'number') return 'characteristics[].id обязателен и должен быть числом'
      const known = CHARACTERISTIC_BY_ID.get(id)
      if (!known) return `характеристика ${id} неизвестна`
      const values = Array.isArray(value) ? value : [value]
      if (known.maxCount > 0 && values.length > known.maxCount) {
        return `характеристика ${id} (${known.name}): допустимо не больше ${known.maxCount} значений`
      }
      if (known.type === 4 && typeof value !== 'number') {
        return `характеристика ${id} (${known.name}): значение должно быть числом`
      }
      if (known.type === 1 && !(Array.isArray(value) || typeof value === 'string')) {
        return `характеристика ${id} (${known.name}): значение должно быть строкой или массивом строк`
      }
    }
  }
  return null
}

/**
 * Обрабатывает `POST /content/v2/cards/update`.
 *
 * Проверяются ВСЕ карточки запроса до записи хотя бы одной: реальный метод
 * умеет частичный успех через отдельный список ошибок
 * (`/content/v2/cards/error/list`), но заводить эту асинхронную цепочку
 * ради песочницы, где карточки создаются мгновенно, — сложность без
 * выигрыша. Здесь либо сохраняются все карточки батча, либо ни одна —
 * и ошибка называет ровно ту карточку, из-за которой отказ.
 */
export async function handleCardsUpdate(sandbox: Sandbox, body: unknown): Promise<WbEnvelope> {
  if (!Array.isArray(body) || body.length === 0) {
    return errorEnvelope(400, 'Неправильный запрос: тело обязано быть непустым массивом карточек')
  }
  if (body.length > 3000) {
    return errorEnvelope(400, 'Одним запросом можно отредактировать максимум 3000 карточек товаров')
  }

  const pool = productPool(sandbox.dataVolume)
  const additionalErrors: Record<string, string> = {}
  for (const raw of body as CardInput[]) {
    const error = validateCard(raw, pool)
    if (error) {
      const key = typeof raw.vendorCode === 'string' && raw.vendorCode.length > 0
        ? raw.vendorCode
        : `nmID_${String(raw.nmID)}`
      additionalErrors[key] = error
    }
  }
  if (Object.keys(additionalErrors).length > 0) {
    return errorEnvelope(400, 'some items failed validation, please fix them and try again.', additionalErrors)
  }

  for (const raw of body as CardInput[]) {
    const overlay: WbCardOverlay = {
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(Array.isArray(raw.characteristics)
        ? {
            characteristics: (raw.characteristics as Array<{ id: number; value: unknown }>).map((c) => ({
              id: c.id,
              name: CHARACTERISTIC_BY_ID.get(c.id)?.name ?? String(c.id),
              value: c.value,
            })),
          }
        : {}),
    }
    // Пустой overlay (карточка прислана только с nmID/vendorCode/sizes, без
    // правок содержимого) не пишем — записывать нечего, а «применить» без
    // изменений не должно создавать пустую строку overlay.
    if (Object.keys(overlay).length > 0) {
      await writeOverlay(sandbox.id, 'wildberries', 'wb-card', String((raw as { nmID: number }).nmID), overlay)
    }
  }
  return OK
}

/** Пять URL одного размера — форма, в которой `cards/list` показывает фото. */
function photoVariants(url: string): Record<string, string> {
  return { big: url, c246x328: url, c516x688: url, square: url, tm: url }
}

/**
 * Накладывает overlay на список карточек, уже собранный движком моков.
 *
 * Меняются только поля, которые правда были сохранены `cards/update`/
 * media-методами: карточка, для которой overlay не заводили, приходит
 * такой же, как раньше. Тело — то, что отдал движок, мутируется на месте:
 * дешевле, чем второй проход глубокого клонирования по каталогу в тысячу
 * карточек, а после наложения оно уходит прямо на сериализацию.
 */
export async function applyWbCardOverlay(sandboxId: string, body: unknown): Promise<boolean> {
  const cards = (body as { cards?: unknown })?.cards
  if (!Array.isArray(cards) || cards.length === 0) return false

  const [contentOverlay, photosOverlay] = await Promise.all([
    readOverlayMap<WbCardOverlay>(sandboxId, 'wildberries', 'wb-card'),
    readOverlayMap<WbPhotosOverlay>(sandboxId, 'wildberries', 'wb-photos'),
  ])
  if (contentOverlay.size === 0 && photosOverlay.size === 0) return false

  let changed = false
  for (const card of cards as Array<Record<string, unknown>>) {
    const nmId = card.nmID
    if (typeof nmId !== 'number') continue
    const key = String(nmId)
    const content = contentOverlay.get(key)
    if (content) {
      if (content.title !== undefined) card.title = content.title
      if (content.description !== undefined) card.description = content.description
      if (content.characteristics !== undefined) {
        card.characteristics = content.characteristics.map((c) => ({ id: c.id, name: c.name, value: c.value }))
      }
      changed = true
    }
    const photos = photosOverlay.get(key)
    if (photos) {
      card.photos = photos.photos.map(photoVariants)
      changed = true
    }
  }
  return changed
}
