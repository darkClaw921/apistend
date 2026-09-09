import { Deterministic } from '@apistend/mock-engine'
import type { ActorSnapshotEntry } from './apify-actors.ts'

/**
 * Результат запуска актора — по его собственному описанию выхода.
 *
 * Источник значений, по убыванию правдивости:
 *   1. `examples` конкретного поля в схеме датасета. Их пишет автор актора,
 *      и это буквально те значения, которые он показывает в своей документации;
 *   2. `default` поля;
 *   3. детерминированная заглушка по типу поля.
 *
 * Первый ярус закрывает большинство: авторы популярных акторов заполняют examples
 * почти везде, потому что по ним строится предпросмотр результата в интерфейсе Apify.
 * Это ровно тот же принцип, что и в движке моков, — сначала пример из спецификации,
 * потом схема, и только потом заглушка.
 *
 * Значения детерминированы: одинаковый актор и одинаковый вход дают одинаковую
 * выдачу. Иначе агент, которого отлаживают прогоном по кругу, каждый раз получал бы
 * другие данные, и отличить свою ошибку от шума мока стало бы нечем.
 */

/** Сколько элементов отдаём, если вход не просит иного. */
const DEFAULT_ITEMS = 3
const MAX_ITEMS = 50

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  examples?: unknown[]
  default?: unknown
  enum?: unknown[]
  format?: string
  description?: string
}

/** Первый непустой тип: в схемах датасета тип почти всегда объявлен как ["string","null"]. */
function primaryType(schema: JsonSchema): string {
  const t = schema.type
  if (Array.isArray(t)) return t.find((x) => x !== 'null') ?? 'string'
  return typeof t === 'string' ? t : 'string'
}

/**
 * Значение по типу поля.
 *
 * Ключ детерминизма — ПУТЬ к полю, а не его имя: два поля `id` на разных уровнях
 * вложенности должны получить разные значения, иначе результат выглядит склеенным.
 */
function fallbackValue(path: string, schema: JsonSchema, det: Deterministic, depth: number): unknown {
  const name = path.slice(path.lastIndexOf('.') + 1)
  switch (primaryType(schema)) {
    case 'integer':
      return det.int(path, 1, 10_000)
    case 'number':
      return det.float(path, 1, 999)
    case 'boolean':
      return det.bool(path)
    case 'array': {
      const item = schema.items
      return item ? [buildValue(`${path}[0]`, item, det, depth + 1)] : []
    }
    case 'object':
      return schema.properties ? buildObject(path, schema, det, depth + 1) : {}
    default: {
      if (schema.format === 'date-time') return new Date(0).toISOString()
      if (schema.format === 'uri' || /url$/i.test(name)) return `https://example.com/${name.toLowerCase()}`
      return `${name}-${det.int(path, 1000, 9999)}`
    }
  }
}

function buildValue(path: string, schema: JsonSchema, det: Deterministic, depth: number): unknown {
  // Пример автора актора — самое правдивое, что есть.
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[det.int(path, 0, schema.examples.length - 1)]
  }
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[det.int(path, 0, schema.enum.length - 1)]
  }
  // Глубже третьего уровня не спускаемся: схемы датасетов бывают рекурсивными,
  // и полный обход даёт мегабайтные элементы там, где нужен образец формы.
  if (depth > 3) return null
  return fallbackValue(path, schema, det, depth)
}

function buildObject(
  path: string,
  schema: JsonSchema,
  det: Deterministic,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    out[name] = buildValue(path ? `${path}.${name}` : name, prop, det, depth)
  }
  return out
}

/**
 * Сколько элементов просил вход.
 *
 * У акторов нет единого имени для этого поля, но три встречаются постоянно:
 * resultsLimit, maxItems и maxResults. Уважить их важно — агент, попросивший
 * пять элементов и получивший три, решит, что данные кончились.
 */
function requestedCount(input: Record<string, unknown>): number {
  for (const field of ['resultsLimit', 'maxItems', 'maxResults', 'limit']) {
    const value = input[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.min(Math.floor(value), MAX_ITEMS)
    }
  }
  return DEFAULT_ITEMS
}

/**
 * Элементы датасета, которые отдал бы запуск актора.
 *
 * Пустой массив означает честное «форму выхода актор не описал»: у части акторов
 * в сборке нет ни схемы датасета, ни схемы выхода, и придумывать за автора поля
 * его результата — ровно то, чего проект не делает.
 */
export function sampleFromActorOutput(
  actor: ActorSnapshotEntry,
  input: Record<string, unknown>,
  seed: string,
): Record<string, unknown>[] {
  if (actor.hasNoDataset) return []

  const fields = (actor.datasetFields as { fields?: JsonSchema } | null)?.fields
  if (!fields?.properties) return []

  const count = requestedCount(input)
  const items: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    // Своя соль на каждый элемент: иначе все элементы выборки одинаковы,
    // и клиент, который дедуплицирует результат, получит один элемент вместо пяти.
    items.push(buildObject('', fields, new Deterministic(`${seed}|${i}`), 0))
  }
  return items
}
