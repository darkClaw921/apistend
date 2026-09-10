import { TIMELINE_DAYS, startOfDay } from './timeline.ts'

/**
 * Период, за который клиент просит данные.
 *
 * Мок обязан его слышать. Пока `dateFrom` ни на что не влияет, три разных запроса
 * дают один ответ, и проверить нечего: ни инкрементальную выгрузку («что нового
 * с прошлого раза»), ни выбор периода на витрине, ни пустой ответ за окно, в
 * котором ничего не происходило. Клиент, который это умеет, на таком стенде
 * выглядит работающим ровно до боя.
 *
 * Имена параметров у методов разные, и разбираются все написания, которые
 * встречаются в каталоге: `dateFrom`/`dateTo` у статистики, `period.start`/`end`
 * и `currentPeriod` у аналитики, `begin`/`end` у рекламы.
 */

export interface Window {
  readonly from: Date
  readonly to: Date
  /** Назвал ли период сам клиент. Если нет — отдаём глубину журнала. */
  readonly explicit: boolean
}

const FROM_KEYS = new Set([
  'datefrom', 'from', 'begin', 'start', 'startdate', 'begindate', 'dtfrom', 'datebegin', 'periodstart',
])
const TO_KEYS = new Set([
  'dateto', 'to', 'end', 'enddate', 'finish', 'dtto', 'dateend', 'periodend',
])

/** Объекты, внутри которых лежит именно запрошенный период. */
const PERIOD_OBJECTS = new Set(['period', 'currentperiod', 'selectedperiod', 'interval', 'dates', 'filter'])

export function readWindow(
  query: Record<string, string | string[]>,
  body: unknown,
  now: Date,
): Window {
  const found = new Map<'from' | 'to', Date>()
  collect(query, found, 0)
  collect(body, found, 0)

  const to = found.get('to') ?? now
  const from = found.get('from')
  if (!from) {
    return { from: startOfDay(new Date(to.getTime() - (TIMELINE_DAYS - 1) * 86_400_000)), to, explicit: false }
  }
  // Конец окна не может быть раньше начала: клиент, приславший такую пару,
  // получил бы пустой ответ и решил, что данных нет.
  return { from, to: to.getTime() < from.getTime() ? now : to, explicit: true }
}

function collect(node: unknown, out: Map<'from' | 'to', Date>, depth: number): void {
  if (depth > 3 || node === null || typeof node !== 'object') return
  // Тело запроса бывает массивом: статистика медиакампаний принимает список
  // «кампания и её период». Не заглянув внутрь, метод отвечал бы за своё окно.
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, depth + 1)
    return
  }
  for (const [rawKey, rawValue] of Object.entries(node as Record<string, unknown>)) {
    const key = rawKey.toLowerCase().replace(/[_\s-]/g, '')
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
    // Пара дат массивом: статистика медиакампаний принимает период именно так —
    // `dates: ["2026-09-04", "2026-09-10"]`. Без разбора этой формы метод
    // отвечал за свой интервал, а не за тот, что спросили.
    if (Array.isArray(rawValue) && (key === 'dates' || key === 'period' || key === 'interval')) {
      const parsed = rawValue.map(toDate).filter((d): d is Date => d !== null).sort(
        (a, b) => a.getTime() - b.getTime(),
      )
      if (parsed.length > 0) {
        if (!out.has('from')) out.set('from', parsed[0]!)
        if (!out.has('to')) out.set('to', parsed[parsed.length - 1]!)
      }
      continue
    }
    if (value !== null && typeof value === 'object') {
      // Внутрь заходим только там, где период и лежит: `filter.dateFrom` — период,
      // а `settings.cursor.updatedAt` — курсор пагинации, и путать их нельзя.
      if (PERIOD_OBJECTS.has(key)) collect(value, out, depth + 1)
      continue
    }
    const parsed = toDate(value)
    if (!parsed) continue
    if (FROM_KEYS.has(key) && !out.has('from')) out.set('from', parsed)
    else if (TO_KEYS.has(key) && !out.has('to')) out.set('to', parsed)
  }
}

/**
 * Дата запроса.
 *
 * Принимается и `2026-06-01`, и `2026-06-01 12:00:00`, и полный ISO — все три
 * формы Wildberries принимает сам. Дата без времени в конце окна означает конец
 * дня: иначе `dateTo=2026-06-01` отсекал бы всё, что случилось в этот день.
 */
function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null
  const parsed = new Date(text.includes('T') || text.includes(' ') ? text.replace(' ', 'T') : `${text}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Конец дня для дат без времени: `dateTo=2026-06-01` включает весь день. */
export function endOfWindow(window: Window): Date {
  const to = window.to
  const midnight = to.getUTCHours() === 0 && to.getUTCMinutes() === 0 && to.getUTCSeconds() === 0
  return midnight ? new Date(to.getTime() + 86_399_999) : to
}
