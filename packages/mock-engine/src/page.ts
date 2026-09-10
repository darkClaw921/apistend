/**
 * Пагинация: какую часть каталога отдаёт метод.
 *
 * Каталог песочницы — сотни артикулов, а ответ обязан оставаться ответом, а не
 * выгрузкой базы. Боевые API решают это одинаково: клиент просит страницу и листает,
 * пока не получит пустой список. Стенд обязан вести себя так же — иначе на нём нельзя
 * проверить ни постраничный обход, ни его завершение, а это ровно тот код клиента,
 * который чаще всего и ломается.
 *
 * Имена параметров у трёх сервисов свои: у WB limit/offset, у Ozon limit и last_id,
 * у Битрикс24 start. Разбираем все написания, которые встречаются в каталоге.
 */

import { indexOfNmId } from './dataset.ts'

export interface Page {
  offset: number
  limit: number
  /**
   * Назвал ли размер страницы сам клиент.
   *
   * Нужно спискам событий: боевая статистика Wildberries отдаёт всё запрошенное
   * окно за раз (потолок — 80 000 записей), и клиент строит по нему график за
   * 30 или 90 дней одним запросом. Отдать ему двадцать записей одного дня —
   * значит показать график из одной точки там, где в бою их девяносто.
   */
  explicitLimit: boolean
}

/** Страница по умолчанию: клиент ничего не просил, отдаём первую и небольшую. */
export const DEFAULT_LIMIT = 20

/**
 * Потолок страницы.
 *
 * Тысяча — столько же, сколько разрешают боевые методы Wildberries со списками
 * (`limit` до 1000 в спецификации). Прежние двести молча обрезали ответ: клиент
 * просил тысячу цен, получал двести и считал, что на остальные карточки цены
 * не заведены — притом что они есть, и постраничный обход их находил.
 */
const MAX_LIMIT = 1_000

/**
 * Потолок карточной выдачи Wildberries.
 *
 * Курсорная форма `settings.cursor.limit` — это метод контента, и у него свой
 * документированный предел в сто карточек. Карточка тяжёлая: характеристики,
 * размеры, фотографии, — и тысяча таких записей превращает ответ в мегабайты
 * там, где боевой сервис их не отдаёт.
 */
const CURSOR_MAX_LIMIT = 100

// «size» и «count» в список не входят намеренно: в товарных запросах так называют
// размер товара и количество штук, а не размер страницы, — один такой параметр
// обрезал бы весь ответ.
const LIMIT_KEYS = new Set(['limit', 'pagesize', 'persize', 'perpage', 'take', 'rows'])
const OFFSET_KEYS = new Set(['offset', 'skip', 'start', 'from', 'lastid'])
const PAGE_KEYS = new Set(['page', 'pagenumber', 'pagenum'])

export function readPage(query: Record<string, string | string[]>, body: unknown): Page {
  const found = new Map<string, number>()
  collect(query, found, 0, false)
  collect(body, found, 0, false)

  const requestedLimit = found.get('limit')
  const ceiling = found.has('cursorLimit') ? CURSOR_MAX_LIMIT : MAX_LIMIT
  const limit = clamp(requestedLimit ?? DEFAULT_LIMIT, 1, ceiling)
  const explicitOffset = found.get('offset')
  const page = found.get('page')
  // Курсор Wildberries: клиент возвращает артикул последней полученной карточки,
  // и сервер обязан продолжить со следующей. Без этого запрос «дай следующую
  // страницу» отдавал ту же самую, и обход каталога не заканчивался никогда —
  // клиенту оставалось выдумывать себе страховку от петли.
  const cursorNmId = found.get('cursorNmId')
  const fromCursor = cursorNmId === undefined ? undefined : indexOfNmId(cursorNmId)
  // Номер страницы и смещение — одно и то же, записанное по-разному. Если клиент
  // прислал номер, смещение считаем от него: иначе page=2 отдавала бы первую страницу.
  const offset = explicitOffset
    ?? (fromCursor !== null && fromCursor !== undefined ? fromCursor + 1 : undefined)
    ?? (page !== undefined && page > 1 ? (page - 1) * limit : 0)
  return { offset: Math.max(0, Math.trunc(offset)), limit, explicitLimit: requestedLimit !== undefined }
}

/** Совпадает ли страница со значением по умолчанию — только такие ответы кешируются. */
export function isDefaultPage(page: Page): boolean {
  return page.offset === 0 && page.limit === DEFAULT_LIMIT
}

/**
 * Ищет параметры страницы в запросе. Заглядывает на уровень вглубь: у Ozon и WB
 * limit лежит рядом с filter, а не внутри него, но встречается и вложенная форма.
 */
function collect(node: unknown, out: Map<string, number>, depth: number, inCursor: boolean): void {
  if (depth > 2 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) return
  for (const [rawKey, rawValue] of Object.entries(node as Record<string, unknown>)) {
    const key = rawKey.toLowerCase().replace(/[_\s-]/g, '')
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
    if (typeof value === 'object' && value !== null) {
      collect(value, out, depth + 1, inCursor || key === 'cursor')
      continue
    }
    const num = toNumber(value)
    if (num === undefined) continue
    // Артикул засчитывается как курсор ТОЛЬКО внутри объекта cursor: тем же именем
    // называют и фильтр «дай карточку по артикулу», и он не про пагинацию.
    if (inCursor && key === 'nmid' && !out.has('cursorNmId')) out.set('cursorNmId', num)
    // Отмечаем курсорную форму: у неё свой потолок страницы.
    else if (inCursor && key === 'limit' && !out.has('cursorLimit')) {
      out.set('cursorLimit', num)
      if (!out.has('limit')) out.set('limit', num)
    }
    else if (LIMIT_KEYS.has(key) && !out.has('limit')) out.set('limit', num)
    else if (OFFSET_KEYS.has(key) && !out.has('offset')) out.set('offset', num)
    else if (PAGE_KEYS.has(key) && !out.has('page')) out.set('page', num)
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
