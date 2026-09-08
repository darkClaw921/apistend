/**
 * Форматирование по правилам design-handoff/04-content-ru.md.
 *
 * Пункт чек-листа приёмки: «Числа с неразрывными пробелами разрядов и десятичной запятой».
 * Intl для ru-RU в свежих ICU ставит узкий неразрывный пробел (U+202F), а в макете обычный
 * неразрывный (U+00A0) — поэтому разделители расставляем сами, а не полагаемся на локаль.
 */

/** Неразрывный пробел U+00A0. */
export const NBSP = ' '

/** Разделитель мета-строк: пробел, средняя точка, пробел. */
export const META_SEP = ` · `

/** 128940 -> «128 940» */
export function formatInt(value: number): string {
  const sign = value < 0 ? '-' : ''
  const digits = Math.abs(Math.trunc(value)).toString()
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += NBSP
    out += digits[i]
  }
  return sign + out
}

/** 1.8 -> «1,8»; 4.25 при digits=1 -> «4,3» */
export function formatDecimal(value: number, digits = 1): string {
  const fixed = Math.abs(value).toFixed(digits)
  const [intPart = '0', frac] = fixed.split('.')
  const sign = value < 0 ? '-' : ''
  const head = formatInt(Number(intPart))
  return frac ? `${sign}${head},${frac}` : `${sign}${head}`
}

/** 1.8 -> «1,8 %» */
export function formatPercent(value: number, digits = 1): string {
  return `${formatDecimal(value, digits)}${NBSP}%`
}

/** 84 -> «84 мс»; 1240 -> «1 240 мс» */
export function formatMs(value: number): string {
  return `${formatInt(value)}${NBSP}мс`
}

/** 1234 -> «1,2 КБ»; 128940 -> «125,9 КБ»; 4300000 -> «4,1 МБ» */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatInt(bytes)}${NBSP}Б`
  const kb = bytes / 1024
  if (kb < 1024) return `${formatDecimal(kb, 1)}${NBSP}КБ`
  return `${formatDecimal(kb / 1024, 1)}${NBSP}МБ`
}

/** Дельта со знаком: +12 -> «+12 %», -6 -> «−6 мс» (минус — типографский U+2212). */
export function formatDelta(value: number, unit: string, digits = 0): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  const body = digits > 0 ? formatDecimal(Math.abs(value), digits) : formatInt(Math.abs(value))
  return unit ? `${sign}${body}${NBSP}${unit}` : `${sign}${body}`
}

const TZ = 'Europe/Moscow'

/** «12:04:31» — моноширинным. */
export function formatTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ,
  }).format(date)
}

/** «12:41:05.912» — в логах видно миллисекунды. */
export function formatTimeMs(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const ms = date.getMilliseconds().toString().padStart(3, '0')
  return `${formatTime(date)}.${ms}`
}

/** «12.03.2025» */
export function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ,
  }).format(date)
}

/** «07.09.2026, 12:41:05.912» — заголовок в панели деталей запроса. */
export function formatDateTimeMs(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return `${formatDate(date)}, ${formatTimeMs(date)}`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** «2 мин назад», «5 ч назад», «вчера», «сегодня, 14:32». */
export function formatRelative(d: Date | string, now: Date = new Date()): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diffSec < 45) return 'только что'
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60)
    return `${m} ${plural(m, 'мин', 'мин', 'мин')} назад`
  }
  if (diffSec < 86_400) {
    const h = Math.floor(diffSec / 3600)
    return `${h} ${plural(h, 'ч', 'ч', 'ч')} назад`
  }
  const days = Math.floor(diffSec / 86_400)
  if (days === 1) return 'вчера'
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`
  return formatDate(date)
}

/** «сегодня, 14:32» / «вчера, 21:48» / «18.04.2025, 09:12» — колонка «Последний запрос». */
export function formatDayTime(d: Date | string, now: Date = new Date()): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const time = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  }).format(date)
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000)

  if (date >= startOfToday) return `сегодня, ${time}`
  if (date >= startOfYesterday) return `вчера, ${time}`
  return `${formatDate(date)}, ${time}`
}

/** «4 правила · 1 284 вызова · 2 мин назад» — мета-строка своего мока. */
export function formatCalls(n: number): string {
  return `${formatInt(n)} ${plural(n, 'вызов', 'вызова', 'вызовов')}`
}

export function formatRules(n: number): string {
  return `${formatInt(n)} ${plural(n, 'правило', 'правила', 'правил')}`
}

export function formatMethods(n: number): string {
  return `${formatInt(n)} ${plural(n, 'метод', 'метода', 'методов')}`
}

export function formatEvents(n: number): string {
  return `${formatInt(n)} ${plural(n, 'событие', 'события', 'событий')}`
}

/** Маска ключа: stend_sbx_7f3a••••••4c21 */
export function maskKey(prefix: string, suffix: string, dots = 6): string {
  return `${prefix}${'•'.repeat(dots)}${suffix}`
}

/** Собирает мета-строку через « · », пропуская пустые части. */
export function meta(...parts: Array<string | number | null | undefined | false>): string {
  return parts.filter((p): p is string | number => p !== null && p !== undefined && p !== false && p !== '').join(META_SEP)
}
