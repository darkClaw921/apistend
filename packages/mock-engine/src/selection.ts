import type { Product } from './dataset.ts'

/**
 * Карточки, о которых спросил клиент.
 *
 * Половина работы с API — это вопросы про КОНКРЕТНЫЙ товар: покажи карточку по
 * артикулу, воронку по этому nmID, остатки по этим двум, цену по артикулу
 * продавца. Пока запрос на конкретную карточку отдавал первую страницу каталога,
 * ответ был «не про то»: клиент спрашивал про рюкзак, получал кофе и делал
 * вывод, что по рюкзаку данных нет.
 *
 * Разбираются все написания, которыми в трёх API называют товар: `nmID`, `nmId`,
 * `nm`, `nmIDs`, `filterNmID`, `imtID`, `chrtID`, `sku`, `vendorCode`,
 * `supplierArticle`, `offerId`, `barcode`, а также `textSearch` — в него
 * продавцы вставляют артикул, и боевой поиск это понимает.
 *
 * Курсор пагинации сюда НЕ попадает: `settings.cursor.nmID` — это «продолжи
 * с этой карточки», а не «покажи эту карточку», и спутать их значит превратить
 * обход каталога в единственную запись.
 */

const NUMBER_KEYS = new Set([
  'nmid', 'nmids', 'nm', 'nms', 'nmidlist', 'filternmid', 'nomenclature', 'nomenclatures',
  'imtid', 'imtids', 'chrtid', 'chrtids', 'sku', 'skus', 'productid', 'productids',
  'itemid', 'itemids',
])

const TEXT_KEYS = new Set([
  'vendorcode', 'vendorcodes', 'supplierarticle', 'offerid', 'offerids', 'article',
  'barcode', 'barcodes', 'textsearch', 'search', 'query',
])

/** Объекты, внутрь которых заходить нельзя: там те же имена значат другое. */
const SKIP_OBJECTS = new Set(['cursor', 'sort', 'order', 'page'])

export function readSelection(
  query: Record<string, string | string[]>,
  body: unknown,
  pool: readonly Product[],
): readonly Product[] {
  if (pool.length === 0) return []
  const numbers = new Set<number>()
  const texts = new Set<string>()
  collect(query, numbers, texts, 0)
  collect(body, numbers, texts, 0)
  if (numbers.size === 0 && texts.size === 0) return []

  const found = pool.filter((p) =>
    numbers.has(p.nmId) || numbers.has(p.imtId) || numbers.has(p.chrtId)
    || texts.has(p.vendorCode.toLowerCase()) || texts.has(p.barcode)
    // Артикул, вставленный в поисковую строку, — обычный способ найти карточку.
    || texts.has(String(p.nmId)),
  )
  // Ограничение сверху то же, что у страницы: запрос со списком в тысячу
  // артикулов не должен превращать ответ в выгрузку базы.
  return found.slice(0, 200)
}

function collect(node: unknown, numbers: Set<number>, texts: Set<string>, depth: number): void {
  if (depth > 4 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collect(item, numbers, texts, depth + 1)
    return
  }
  for (const [rawKey, rawValue] of Object.entries(node as Record<string, unknown>)) {
    const key = rawKey.toLowerCase().replace(/[_\s-]/g, '')
    if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      if (!SKIP_OBJECTS.has(key)) collect(rawValue, numbers, texts, depth + 1)
      continue
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    if (NUMBER_KEYS.has(key)) {
      for (const value of values) {
        const n = typeof value === 'number' ? value : Number(String(value).trim())
        if (Number.isFinite(n) && n > 0) numbers.add(Math.trunc(n))
      }
      continue
    }
    if (TEXT_KEYS.has(key)) {
      for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number') continue
        const text = String(value).trim().toLowerCase()
        if (text.length === 0) continue
        texts.add(text)
        // Поисковая строка с артикулом внутри: «купить 100137617» — тоже адрес
        // конкретной карточки, и боевой поиск отвечает именно ею.
        for (const digits of text.match(/\d{6,}/g) ?? []) {
          const n = Number(digits)
          if (Number.isFinite(n)) numbers.add(n)
        }
      }
    }
  }
}
