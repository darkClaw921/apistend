#!/usr/bin/env node
/**
 * Снимаем акторов Apify Store вместе со схемами их входа и выхода.
 *
 * Зачем это в проекте. Мок REST-методов Apify отвечает на «покажи список
 * акторов» и «покажи запуск», но агент, которого пишет пользователь, работает
 * не с методами, а с КОНКРЕТНЫМИ акторами: он читает input schema, собирает по
 * ней вход, запускает актора и разбирает поля датасета. Без настоящих схем мок
 * проверяет только транспорт, а не то, ради чего агент написан.
 *
 * Что снимается на каждого актора:
 *   • карточка   — GET /v2/acts/{username}~{name};
 *   • сборка     — GET /v2/acts/{id}/builds/{buildId}, из неё actorDefinition:
 *       input                    — схема входа (её же показывает интерфейс Apify),
 *       output                   — схема выхода, если объявлена,
 *       storages.dataset.fields  — схема полей датасета, то есть форма результата.
 *
 * Что НЕ снимается: readme, changelog и исходники сборки. Это мегабайты текста,
 * к интерфейсу актора они отношения не имеют, а readmeSummary карточки для
 * описания достаточно.
 *
 * Все 57 тысяч акторов магазина не снимаются намеренно: это 114 тысяч запросов
 * и сотни мегабайт, из которых для отладки нужны единицы.
 *
 * Выборка складывается из двух частей:
 *   1) верхушка магазина по популярности — с ней пишут интеграции чаще всего;
 *   2) адресный поиск по площадкам, ради которых существует APIStend, — Ozon,
 *      Wildberries, Яндекс Маркет и остальной русский рынок. Без второй части
 *      верхушка отдаёт мировой топ (Instagram, TikTok, Google Maps), и ни одного
 *      актора под задачу российского продавца в снимок бы не попало.
 *
 * Токен читается ТОЛЬКО из переменной окружения APIFY_TOKEN и никуда не пишется:
 * ни в снимок, ни в манифест, ни в лог.
 *
 *   APIFY_TOKEN=… node scripts/vendor-apify-actors.mjs [сколько]
 *
 * Снимок сохраняется сжатым (actors.json.gz): в разжатом виде тысяча акторов —
 * это десятки мегабайт почти целиком из схем входа, а gzip сжимает их в разы.
 * Читает его apps/api/src/mcp/apify-actors.ts, распаковывая при первом обращении.
 */

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const token = process.env.APIFY_TOKEN
if (!token) {
  console.error('Нужна переменная окружения APIFY_TOKEN. В репозиторий токен не кладём.')
  process.exit(1)
}

const WANTED = Number(process.argv[2] ?? 1000)

/**
 * Адресный поиск: площадки, ради которых APIStend и существует.
 *
 * Мировой топ по популярности до них не доходит — там социальные сети и карты.
 * Список неупорядочен: каждый запрос добирает столько, сколько магазин отдаёт
 * по этому слову, а дубли отсеиваются по идентификатору актора.
 */
const RU_QUERIES = [
  'ozon', 'wildberries', 'yandex market', 'yandex', 'avito', 'russia', 'russian',
  'aliexpress russia', 'lamoda', 'dns shop', 'mvideo', 'citilink', 'sbermegamarket',
  'megamarket', 'kazanexpress', 'detmir', 'eldorado', 'vkontakte', 'vk.com',
  'telegram', 'hh.ru', 'headhunter', 'cian', 'domclick', 'auto.ru', 'drom',
  '2gis', 'yandex maps', 'yandex eda', 'delivery club', 'sbermarket', 'ozon seller',
  'wildberries seller', 'marketplace russia', 'rutube', 'kinopoisk', 'ivi',
  'sberbank', 'tinkoff', 'gosuslugi', 'rbc', 'ria', 'moex',
]
const API = 'https://api.apify.com/v2'
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'specs/apify')

/** Одновременных запросов. Базовый лимит Apify — 60 в секунду, держимся заметно ниже. */
const CONCURRENCY = 8

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`${response.status} на ${path}`)
  const json = await response.json()
  return json.data
}

/** Обход одной выдачи магазина порциями по сто. */
async function fetchStorePage(limit, query) {
  const items = []
  let offset = 0
  const search = query ? `&search=${encodeURIComponent(query)}&sortBy=relevance` : '&sortBy=popularity'
  while (items.length < limit) {
    const page = await api(`/store?limit=${Math.min(100, limit - items.length)}&offset=${offset}${search}`)
    if (!page.items?.length) break
    items.push(...page.items)
    offset += page.items.length
    if (offset >= page.total) break
  }
  return items.slice(0, limit)
}

/**
 * Доля выборки, отданная мировому топу по популярности.
 *
 * Резерв, а не остаток. Первая версия брала сначала весь адресный поиск, а
 * популярными добирала хвост, — и адресный поиск выбрал всю тысячу целиком,
 * вытеснив даже apify/instagram-scraper, самого запускаемого актора магазина.
 * Русские площадки — причина, по которой снимок собирают, но не единственное
 * его содержимое.
 */
const POPULAR_SHARE = 0.4

/**
 * Итоговая выборка: мировой топ и адресный поиск, каждому своя доля.
 *
 * Сначала берётся топ в пределах своей доли, затем поиск заполняет остальное,
 * и лишь потом, если поиск дал меньше ожидаемого, топ добирает свободное место.
 */
async function fetchSelection(limit) {
  const byId = new Map()

  const popularQuota = Math.round(limit * POPULAR_SHARE)
  const popular = await fetchStorePage(popularQuota, null)
  for (const item of popular) byId.set(item.id, item)
  console.log(`  по популярности: ${byId.size}`)

  const afterPopular = byId.size
  for (const query of RU_QUERIES) {
    if (byId.size >= limit) break
    let found = []
    try {
      found = await fetchStorePage(60, query)
    } catch (error) {
      console.log(`  ! поиск «${query}»: ${error.message}`)
      continue
    }
    for (const item of found) {
      if (byId.size >= limit) break
      if (!byId.has(item.id)) byId.set(item.id, item)
    }
  }
  console.log(`  адресным поиском: ${byId.size - afterPopular}`)

  // Поиск дал меньше своей доли — свободное место отдаём топу, а не теряем.
  if (byId.size < limit) {
    const more = await fetchStorePage(limit - byId.size + popularQuota, null)
    const before = byId.size
    for (const item of more) {
      if (byId.size >= limit) break
      if (!byId.has(item.id)) byId.set(item.id, item)
    }
    if (byId.size > before) console.log(`  добрано популярными: ${byId.size - before}`)
  }

  return [...byId.values()].slice(0, limit)
}

/**
 * Схемы одного актора.
 *
 * Возвращает null, если у актора нет собранной версии: у части акторов магазина
 * taggedBuilds пуст, и придумывать им схему нельзя — в каталоге они честно
 * останутся без неё.
 */
async function fetchActor(item) {
  const fullName = `${item.username}~${item.name}`
  const actor = await api(`/acts/${fullName}`)
  const buildId = actor.taggedBuilds?.latest?.buildId
  if (!buildId) return { actor, definition: null }
  try {
    const build = await api(`/acts/${actor.id}/builds/${buildId}`)
    return { actor, definition: build.actorDefinition ?? null }
  } catch {
    // Сборка приватная или удалена — актор остаётся без схем, но в снимке есть.
    return { actor, definition: null }
  }
}

/** Пул: акторы обрабатываются по CONCURRENCY штук, порядок сохраняется. */
async function mapPool(items, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        out[index] = await worker(items[index], index)
      } catch (error) {
        out[index] = { failed: items[index], reason: String(error.message ?? error) }
      }
    }
  })
  await Promise.all(runners)
  return out
}

console.log(`Собираю выборку до ${WANTED} акторов…`)
const store = await fetchSelection(WANTED)
console.log(`  список получен: ${store.length}`)

let done = 0
const raw = await mapPool(store, async (item) => {
  const result = await fetchActor(item)
  done += 1
  if (done % 25 === 0) console.log(`  схемы: ${done}/${store.length}`)
  return result
})

const failures = []
const actors = []
for (const entry of raw) {
  if (entry?.failed) {
    failures.push(`${entry.failed.username}/${entry.failed.name}: ${entry.reason}`)
    continue
  }
  const { actor, definition } = entry
  actors.push({
    id: actor.id,
    name: `${actor.username}/${actor.name}`,
    title: actor.title ?? actor.name,
    description: actor.description ?? '',
    readmeSummary: actor.readmeSummary ?? null,
    categories: actor.categories ?? [],
    isDeprecated: actor.isDeprecated === true,
    isPublic: actor.isPublic === true,
    hasNoDataset: actor.hasNoDataset === true,
    permissionLevel: actor.actorPermissionLevel ?? null,
    pricing: (actor.pricingInfos ?? []).map((p) => ({
      model: p.pricingModel ?? null,
      pricePerUnitUsd: p.pricePerUnitUsd ?? null,
      trialMinutes: p.trialMinutes ?? null,
    })),
    stats: {
      totalRuns: actor.stats?.totalRuns ?? null,
      totalUsers: actor.stats?.totalUsers ?? null,
      totalUsers30Days: actor.stats?.totalUsers30Days ?? null,
      reviewRating: actor.stats?.actorReviewRating ?? null,
      lastRunStartedAt: actor.stats?.lastRunStartedAt ?? null,
    },
    defaultRunOptions: actor.defaultRunOptions ?? null,
    // Пример входа с карточки: он же подставляется в интерфейсе Apify по кнопке.
    exampleRunInput: actor.exampleRunInput ?? null,
    buildNumber: actor.taggedBuilds?.latest?.buildNumber ?? null,
    // Схема входа: то, по чему агент собирает вызов.
    inputSchema: definition?.input ?? null,
    // Схема выхода: объявленная явно и/или выведенная из полей датасета.
    outputSchema: definition?.output ?? null,
    datasetFields: definition?.storages?.dataset ?? null,
  })
}

const withInput = actors.filter((a) => a.inputSchema !== null).length
const withOutput = actors.filter((a) => a.outputSchema !== null || a.datasetFields !== null).length

const snapshot = {
  capturedAt: new Date().toISOString(),
  sourceUrl: 'https://api.apify.com/v2/store',
  sortedBy: 'popularity',
  note:
    'Адресный поиск по русским площадкам плюс добор верхушкой магазина по ' +
    'популярности. Весь магазин (57 тысяч акторов) не снимается: это сотни ' +
    'мегабайт ради единиц, с которыми реально пишут интеграции. Схемы входа ' +
    'и выхода взяты из actorDefinition последней сборки. Readme и исходники ' +
    'не снимаются.',
  searchQueries: RU_QUERIES,
  actorCount: actors.length,
  withInputSchema: withInput,
  withOutputSchema: withOutput,
  actors,
}

mkdirSync(outDir, { recursive: true })
const file = join(outDir, 'actors.json.gz')
// Без отступов: файл читает программа, а не человек, а разница в объёме заметная.
const text = JSON.stringify(snapshot)
const packed = gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
writeFileSync(file, packed)

const sha = createHash('sha256').update(packed).digest('hex')
writeManifestRow(join(outDir, 'MANIFEST.tsv'), 'actors.json.gz', sha, packed.length)

console.log(`Готово: ${actors.length} акторов, со схемой входа ${withInput}, с описанием выхода ${withOutput}`)
console.log(`  ${file} — ${(packed.length / 1024 / 1024).toFixed(1)} МБ сжато из ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} МБ`)
if (failures.length > 0) {
  console.log(`  не удалось снять: ${failures.length}`)
  for (const f of failures.slice(0, 5)) console.log(`    ! ${f}`)
}

/**
 * Строка манифеста для одного файла: заменяется, а не дописывается.
 *
 * Дописывание давало по строке на каждый запуск, и манифест переставал отвечать
 * на единственный вопрос, ради которого существует, — какой sha256 у того файла,
 * что лежит рядом прямо сейчас.
 */
function writeManifestRow(path, file, sha256, bytes) {
  const header = 'file\tsha256\tbytes'
  const rows = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() && l !== header && !l.startsWith(`${file}\t`))
    : []
  rows.push(`${file}\t${sha256}\t${bytes}`)
  rows.sort()
  writeFileSync(path, `${header}\n${rows.join('\n')}\n`)
}
