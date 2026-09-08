import { randomUUID } from 'node:crypto'

/**
 * Шаблонизатор ответов для экрана «Свои моки».
 *
 * В плане значился @mockoon/serverless. От него отказались после того, как стал ясен
 * реальный объём: макет фиксирует ровно семь плейсхолдеров, а mockoon тянет собственный
 * рантайм Handlebars с сотнями хелперов, свой формат окружения и faker в рантайме —
 * ради семи подстановок. Здесь они реализованы напрямую, без зависимостей,
 * и ведут себя ровно так, как нарисовано в правой колонке редактора.
 *
 * Поддерживаются: {{uuid}}, {{now}}, {{now +3d}}, {{randomInt a b}},
 * {{faker.company}}, {{faker.city}}, {{request.body.*}}, {{query.*}}.
 */

const COMPANIES = [
  'ООО «Северный кофе»', 'АО «Сфера»', 'ООО «ТехноЛайн»', 'ООО «Байкал Трейд»',
  'АО «Меридиан»', 'ООО «Первая мебельная»', 'ООО «Вектор»', 'АО «Синергия»',
]
const CITIES = [
  'Москва', 'Санкт-Петербург', 'Новосибирск', 'Екатеринбург',
  'Казань', 'Нижний Новгород', 'Краснодар', 'Самара',
]

export interface TemplateContext {
  body: unknown
  query: Record<string, unknown>
  params: Record<string, string>
  now: Date
  /** Детерминированный источник случайности: нужен предпросмотру, чтобы он не «плыл». */
  random?: () => number
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g

export function renderTemplate(template: string, ctx: TemplateContext): string {
  const rand = ctx.random ?? Math.random
  return template.replace(PLACEHOLDER, (match, rawExpr: string) => {
    const expr = rawExpr.trim()

    if (expr === 'uuid') return randomUUID()

    // {{now}} и {{now +3d}} / {{now -12h}}
    const nowMatch = /^now(?:\s*([+-])\s*(\d+)([dhms]))?$/.exec(expr)
    if (nowMatch) {
      let ms = ctx.now.getTime()
      if (nowMatch[1]) {
        const sign = nowMatch[1] === '-' ? -1 : 1
        const amount = Number(nowMatch[2])
        const unit = nowMatch[3]!
        const factor = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000
        ms += sign * amount * factor
      }
      // Дата за пределами допустимого диапазона роняет toISOString с RangeError,
      // а вместе с ним и весь запрос. Неподъёмный сдвиг ведёт себя как любой
      // непонятный плейсхолдер — остаётся в тексте как есть.
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return match
      return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
    }

    const intMatch = /^randomInt\s+(-?\d+)\s+(-?\d+)$/.exec(expr)
    if (intMatch) {
      const min = Number(intMatch[1])
      const max = Number(intMatch[2])
      return String(min + Math.floor(rand() * (max - min + 1)))
    }

    if (expr === 'faker.company') return COMPANIES[Math.floor(rand() * COMPANIES.length)]!
    if (expr === 'faker.city') return CITIES[Math.floor(rand() * CITIES.length)]!

    if (expr.startsWith('request.body.')) {
      const value = readPath(ctx.body, expr.slice('request.body.'.length))
      return value === undefined ? '' : stringify(value)
    }
    if (expr.startsWith('query.')) {
      const value = ctx.query[expr.slice('query.'.length)]
      return value === undefined ? '' : stringify(value)
    }
    if (expr.startsWith('params.')) {
      const value = ctx.params[expr.slice('params.'.length)]
      return value === undefined ? '' : value
    }

    // Неизвестный плейсхолдер оставляем как есть: тихо съедать его нельзя,
    // пользователь должен увидеть опечатку в предпросмотре.
    return match
  })
}

/** Путь вида items.0.sku по вложенной структуре. */
function readPath(source: unknown, path: string): unknown {
  let current = source
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
}

/** Детерминированный ГПСЧ для предпросмотра: один и тот же мок даёт один и тот же вид. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = (h ^= h >>> 16) >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Набор плейсхолдеров для правой колонки редактора — ровно как в макете. */
export const PLACEHOLDER_CATALOG = [
  { code: '{{uuid}}', description: 'уникальный идентификатор' },
  { code: '{{now}}', description: 'текущие дата и время' },
  { code: '{{now +3d}}', description: 'сдвиг даты вперёд' },
  { code: '{{randomInt a b}}', description: 'случайное число' },
  { code: '{{faker.company}}', description: 'название компании' },
  { code: '{{faker.city}}', description: 'город' },
  { code: '{{request.body.*}}', description: 'поле из тела запроса' },
] as const
