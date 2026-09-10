import { Deterministic } from '@apistend/mock-engine'
import type { ActorSnapshotEntry } from './apify-actors.ts'
import { applyOffer, looksLikeProductRow, selectMarket } from './catalog-overlay.ts'

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

/** Откуда взята форма выхода актора. Уходит в ответ инструмента: агенту важно, чему верить. */
export type ActorOutputSource = 'dataset-schema' | 'readme-examples' | 'none'

export function actorOutputSource(actor: ActorSnapshotEntry): ActorOutputSource {
  if (actor.hasNoDataset) return 'none'
  const fields = (actor.datasetFields as { fields?: JsonSchema } | null)?.fields
  if (fields?.properties) return 'dataset-schema'
  return (actor.outputExamples?.length ?? 0) > 0 ? 'readme-examples' : 'none'
}

/** Что получилось: строки и то, откуда взялись их значения. */
export interface ActorOutput {
  readonly items: Record<string, unknown>[]
  /** Подставлены ли значения из общего каталога товаров песочницы. */
  readonly fromCatalog: boolean
  /** Нашлось ли в каталоге хоть что-то по поисковой фразе входа. */
  readonly matchedQuery: boolean
}

/**
 * Элементы датасета, которые отдал бы запуск актора.
 *
 * Форму выхода ищем в двух местах, оба — слова самого автора:
 *   1) схема полей датасета из сборки — по ней и строится образец;
 *   2) примеры строк из readme, если схемы нет.
 *
 * Дальше форма проверяется на «это карточка товара»: название рядом с ценой,
 * артикулом, рейтингом. Если да — строки заполняются рынком конкурентов вокруг
 * каталога песочницы: чужие предложения того же предмета, у каждого свой
 * продавец с реквизитами, а цены сгруппированы вокруг цены своей карточки.
 * Выдача при этом зависит от `queries` и `maxItems`. Иначе (профили соцсетей,
 * точки на карте, вакансии) остаётся то, что показал автор: подменять нечего.
 *
 * Пустой массив означает честное «форму выхода актор не описал» — у 326 акторов
 * снимка нет ни схемы, ни примеров. Придумывать за автора поля его результата —
 * ровно то, чего проект не делает: по такому полю пишут разбор ответа, и
 * несуществующее поле обошлось бы дороже отсутствующего.
 */
export function sampleFromActorOutput(
  actor: ActorSnapshotEntry,
  input: Record<string, unknown>,
  seed: string,
): ActorOutput {
  const empty = { items: [], fromCatalog: false, matchedQuery: false }
  if (actor.hasNoDataset) return empty

  const count = requestedCount(input)
  const fields = (actor.datasetFields as { fields?: JsonSchema } | null)?.fields

  // Форма строки: сгенерированная по схеме либо показанная автором в readme.
  // Из примеров берётся товарный — у скраперов маркетплейсов в readme рядом
  // с карточкой товара лежат ещё отзыв и продавец, а спросили про товары.
  const shape = fields?.properties
    ? buildObject('', fields, new Deterministic(`${seed}|0`), 0)
    : (actor.outputExamples ?? []).find(looksLikeProductRow) ?? null

  if (shape && looksLikeProductRow(shape)) {
    const selection = selectMarket(input, count, seed)
    return {
      items: selection.offers.map((offer) => applyOffer(shape, offer)),
      fromCatalog: true,
      matchedQuery: selection.matched,
    }
  }

  if (!fields?.properties) {
    // Не товар: примеры автора отдаём как есть и не размножаем до запрошенного
    // количества — три показанных автором строки это три строки, а не заготовка,
    // из которой можно нарезать тридцать.
    const examples = actor.outputExamples ?? []
    return { ...empty, items: examples.slice(0, count).map((row) => ({ ...row })) }
  }

  const items: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    // Своя соль на каждый элемент: иначе все элементы выборки одинаковы,
    // и клиент, который дедуплицирует результат, получит один элемент вместо пяти.
    items.push(buildObject('', fields, new Deterministic(`${seed}|${i}`), 0))
  }
  return { ...empty, items }
}
