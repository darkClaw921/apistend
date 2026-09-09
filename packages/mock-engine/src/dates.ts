/**
 * Даты фикстур — относительно сегодняшнего дня, а не дня, когда писали документацию.
 *
 * Это не косметика. Примеры ответов в спецификациях датированы тем днём, когда их
 * написали: заказы Wildberries — 4 марта 2022 года, воронка продаж отвечает за период
 * с июня 2023 по март 2024, тариф коробов действует до февраля 2024. Схемы ведут себя
 * так же: значение `example` у поля-даты сохраняется дословно.
 *
 * Клиент при этом почти всегда считает витрину за последние 7, 30 или 90 дней — и не
 * находит в этом окне ничего. Данные приходят, форма верна, но выручка, заказы, ДРР,
 * маржа и оборачиваемость выводятся прочерками. Проверить на таком стенде можно
 * транспорт, но не то, ради чего интеграцию и пишут.
 *
 * ## Как сдвигаем
 *
 * Не «каждой дате своё случайное сегодня»: тогда рассыпается то, что в примере было
 * согласовано, — заказ окажется позже своей продажи, а период воронки вывернется
 * наизнанку. Сдвигаем ВСЕ даты тела на одну и ту же величину, сохраняя расстояния
 * между ними.
 *
 * Величина считается по опорной дате: берём самую позднюю дату среди полей,
 * которые описывают прошлое, и приравниваем её к «сейчас». Поля, которые по имени
 * описывают будущее (`till`, `expiresAt`, `dtNextBox`), в выбор опоры не входят —
 * иначе срок действия подписки схлопнулся бы в сегодня, и она оказалась бы
 * «активной и одновременно просроченной». При общем сдвиге такие поля уезжают
 * в будущее сами, потому что в документации они и стояли позже остальных.
 *
 * ## Что не трогаем
 *
 * Дату снимка спецификации, версии, идентификаторы и всё, что не разбирается как
 * дата. Формат сохраняется дословно: `2022-03-04` остаётся десятью знаками,
 * `2022-03-04T12:30:00.123Z` сохраняет и миллисекунды, и Z, а смещение `+03:00`
 * остаётся смещением — клиент, разбирающий ответ строгим парсером, не должен
 * заметить подмены ничем, кроме самой даты.
 */

/** Дата без времени: 2022-03-04. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
/** Дата со временем: 2022-03-04T12:30:00, с необязательными долями и зоной. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * Поля, которые описывают будущее.
 *
 * Список именно имён, а не догадок по значению: дата в будущем встречается и там,
 * где это ошибка данных, а нам нужно знать смысл поля, а не его текущее значение.
 * Имена собраны из спецификаций Wildberries, Ozon и Apify.
 */
const FUTURE_FIELDS = [
  'till', 'until', 'expire', 'expiry', 'expires', 'expiresat', 'expiredat',
  'validuntil', 'validtill', 'endsat', 'nextbox', 'dtnextbox', 'dtnextdelivery',
  'dttillmax', 'nextrun', 'nextat', 'deadline', 'duedate', 'renewat', 'renewsat',
]

function isFutureField(name: string): boolean {
  const n = name.toLowerCase().replace(/[_-]/g, '')
  return FUTURE_FIELDS.some((f) => n === f || n.endsWith(f))
}

interface Parsed {
  readonly ms: number
  /** Дата без времени печатается обратно без времени. */
  readonly dateOnly: boolean
  /** Хвост исходной строки: доли секунды и зона — возвращаем их дословно. */
  readonly fraction: string
  readonly zone: string
  /** Разделитель даты и времени: боевые API пишут и «T», и пробел. */
  readonly separator: string
}

/** Разбирает строку, если это дата. Всё остальное — не наше дело. */
function parseDate(value: string): Parsed | null {
  if (value.length < 10 || value.length > 35) return null

  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) {
    const ms = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(ms) ? { ms, dateOnly: true, fraction: '', zone: '', separator: 'T' } : null
  }

  const m = DATE_TIME.exec(value)
  if (!m) return null
  // Разбираем как UTC независимо от зоны: сдвиг всё равно целыми сутками,
  // а собственная зона строки возвращается на место как есть.
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  if (!Number.isFinite(ms)) return null
  return {
    ms,
    dateOnly: false,
    fraction: m[7] ?? '',
    zone: m[8] ?? '',
    separator: value.includes('T') ? 'T' : ' ',
  }
}

/** Собирает строку обратно в том же формате, в котором она пришла. */
function format(parsed: Parsed, ms: number): string {
  const d = new Date(ms)
  const iso = d.toISOString()
  if (parsed.dateOnly) return iso.slice(0, 10)
  return `${iso.slice(0, 10)}${parsed.separator}${iso.slice(11, 19)}${parsed.fraction}${parsed.zone}`
}

/**
 * Сутки — шаг сдвига.
 *
 * Ровно сутки, а не «до миллисекунды сейчас»: время внутри дня в примере несёт
 * смысл (заказ в 12:30, отгрузка в 18:00), и стирать его, приравнивая всё к моменту
 * запроса, значило бы потерять то немногое, что в примере было правдой.
 */
const DAY = 86_400_000

/** Обход тела: собирает все даты, помечая те, что описывают будущее. */
function collect(node: unknown, key: string, out: { ms: number; future: boolean }[], depth = 0): void {
  if (depth > 24) return
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out, depth + 1)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) collect(v, k, out, depth + 1)
    return
  }
  if (typeof node !== 'string') return
  const parsed = parseDate(node)
  if (parsed) out.push({ ms: parsed.ms, future: isFutureField(key) })
}

function shiftNode(node: unknown, delta: number, depth = 0): unknown {
  if (depth > 24) return node
  if (Array.isArray(node)) return node.map((item) => shiftNode(item, delta, depth + 1))
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = shiftNode(v, delta, depth + 1)
    return out
  }
  if (typeof node !== 'string') return node
  const parsed = parseDate(node)
  return parsed ? format(parsed, parsed.ms + delta) : node
}

/**
 * Сдвигает даты тела так, чтобы самая свежая из них пришлась на сегодня.
 *
 * Возвращает тело как есть, если дат в нём нет или сдвиг вышел нулевым, — тогда
 * не тратим ни обход, ни новый объект.
 */
export function shiftDatesToToday(body: unknown, now: Date): unknown {
  const found: { ms: number; future: boolean }[] = []
  collect(body, '', found)
  if (found.length === 0) return body

  // Опора — самая поздняя дата из описывающих прошлое. Если таких нет вовсе
  // (ответ состоит из одних сроков действия), опираемся на самую раннюю:
  // приравнять к сегодня последнюю значило бы сделать срок уже истёкшим.
  const past = found.filter((d) => !d.future)
  const anchor = past.length > 0
    ? Math.max(...past.map((d) => d.ms))
    : Math.min(...found.map((d) => d.ms))

  // Сегодняшняя полночь UTC: сдвиг целыми сутками сохраняет время внутри дня.
  const today = Math.floor(now.getTime() / DAY) * DAY
  const anchorDay = Math.floor(anchor / DAY) * DAY
  const delta = today - anchorDay
  if (delta === 0) return body

  return shiftNode(body, delta)
}

/**
 * Метка суток для ключа кеша.
 *
 * Тело со сдвинутыми датами перестаёт быть чистой функцией от метода и объёма:
 * завтра оно обязано быть другим. Метка суток возвращает определённость в тех
 * границах, в которых она вообще возможна, — один и тот же вызов в пределах дня
 * даёт один и тот же ответ, а назавтра даты уезжают на сутки вперёд.
 */
export function dayBucket(now: Date): number {
  return Math.floor(now.getTime() / DAY)
}
