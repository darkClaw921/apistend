import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Снимок акторов Apify Store со схемами входа и выхода.
 *
 * Мок REST-методов отвечает на «покажи список акторов», но агент, которого пишет
 * пользователь, работает не с методами, а с конкретными акторами: читает их
 * input schema, собирает по ней вход, запускает и разбирает поля датасета.
 * Поэтому здесь лежат настоящие схемы настоящих акторов — без них мок проверял бы
 * только транспорт, а не то, ради чего агент написан.
 *
 * Снимок собирает scripts/vendor-apify-actors.mjs. Хранится сжатым: тысяча
 * акторов — это около десяти мегабайт почти целиком из схем входа, а gzip
 * сжимает их вчетверо. Распаковывается лениво, при первом обращении: нужен
 * снимок только тем, кто пришёл в MCP, — держать его в памяти обычного шлюза
 * незачем.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = join(here, '../../../../specs/apify/actors.json.gz')

export interface ActorPricing {
  readonly model: string | null
  readonly pricePerUnitUsd: number | null
  readonly trialMinutes: number | null
}

export interface ActorSnapshotEntry {
  readonly id: string
  /** Полное имя вида apify/instagram-scraper. */
  readonly name: string
  readonly title: string
  readonly description: string
  readonly readmeSummary: string | null
  readonly categories: readonly string[]
  readonly isDeprecated: boolean
  readonly isPublic: boolean
  readonly hasNoDataset: boolean
  readonly permissionLevel: string | null
  readonly pricing: readonly ActorPricing[]
  readonly stats: {
    readonly totalRuns: number | null
    readonly totalUsers: number | null
    readonly totalUsers30Days: number | null
    readonly reviewRating: number | null
    readonly lastRunStartedAt: string | null
  }
  readonly defaultRunOptions: Record<string, unknown> | null
  readonly exampleRunInput: Record<string, unknown> | null
  readonly buildNumber: string | null
  /** Схема входа актора — то, по чему агент собирает вызов. */
  readonly inputSchema: Record<string, unknown> | null
  /** Объявленная схема выхода, если актор её описал. */
  readonly outputSchema: Record<string, unknown> | null
  /** Описание полей датасета: форма результата запуска. */
  readonly datasetFields: Record<string, unknown> | null
}

export interface ActorSnapshot {
  readonly capturedAt: string
  readonly sourceUrl: string
  readonly note: string
  readonly actorCount: number
  readonly actors: readonly ActorSnapshotEntry[]
}

let cached: ActorSnapshot | null = null
let loadFailed = false

/**
 * Снимок или null, если его не собирали.
 *
 * Отсутствие файла — не ошибка: собранный каталог REST в репозитории есть всегда,
 * а снимок акторов требует токена Apify и потому опционален. Инструменты, которым
 * он нужен, честно скажут, что снимка нет, вместо того чтобы выдумать акторов.
 */
export function actorSnapshot(): ActorSnapshot | null {
  if (cached) return cached
  if (loadFailed) return null
  try {
    cached = JSON.parse(gunzipSync(readFileSync(SNAPSHOT)).toString('utf8')) as ActorSnapshot
    return cached
  } catch {
    loadFailed = true
    return null
  }
}

export function findActor(name: string): ActorSnapshotEntry | null {
  const snapshot = actorSnapshot()
  if (!snapshot) return null
  // Apify принимает и apify/instagram-scraper, и apify~instagram-scraper, и голый id.
  const normalized = name.trim().replace(/~/g, '/').toLowerCase()
  return (
    snapshot.actors.find((a) => a.name.toLowerCase() === normalized) ??
    snapshot.actors.find((a) => a.id === name.trim()) ??
    null
  )
}

/**
 * Поиск по снимку.
 *
 * Ранжирование — по числу пользователей за 30 дней, как это делает сам магазин
 * (сортировка по популярности). Совпадение ищется по имени, заголовку, описанию
 * и категориям: агент спрашивает «инструмент для инстаграма», а не имя пакета.
 */
export function searchActors(keywords: string, limit: number, offset: number): {
  total: number
  items: readonly ActorSnapshotEntry[]
} {
  const snapshot = actorSnapshot()
  if (!snapshot) return { total: 0, items: [] }

  const terms = keywords.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matched = terms.length === 0
    ? [...snapshot.actors]
    : snapshot.actors.filter((a) => {
        const haystack = [a.name, a.title, a.description, ...a.categories].join(' ').toLowerCase()
        return terms.every((t) => haystack.includes(t))
      })

  matched.sort((a, b) => (b.stats.totalUsers30Days ?? 0) - (a.stats.totalUsers30Days ?? 0))
  return { total: matched.length, items: matched.slice(offset, offset + limit) }
}
