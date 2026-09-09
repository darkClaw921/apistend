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
 * и сотни мегабайт, из которых для отладки нужны единицы. Берём верхушку по
 * популярности — именно с ней и пишут интеграции. Количество задаётся первым
 * аргументом.
 *
 * Токен читается ТОЛЬКО из переменной окружения APIFY_TOKEN и никуда не пишется:
 * ни в снимок, ни в манифест, ни в лог.
 *
 *   APIFY_TOKEN=… node scripts/vendor-apify-actors.mjs [сколько]
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const token = process.env.APIFY_TOKEN
if (!token) {
  console.error('Нужна переменная окружения APIFY_TOKEN. В репозиторий токен не кладём.')
  process.exit(1)
}

const WANTED = Number(process.argv[2] ?? 150)
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

/** Обход списка порциями: /v2/store отдаёт максимум 1000 за раз. */
async function fetchStore(limit) {
  const items = []
  let offset = 0
  while (items.length < limit) {
    const page = await api(`/store?limit=${Math.min(100, limit - items.length)}&offset=${offset}&sortBy=popularity`)
    if (!page.items?.length) break
    items.push(...page.items)
    offset += page.items.length
    if (offset >= page.total) break
  }
  return items.slice(0, limit)
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

console.log(`Снимаю верхние ${WANTED} акторов по популярности…`)
const store = await fetchStore(WANTED)
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
    'Верхушка магазина по популярности, не весь магазин: в нём 57 тысяч акторов, ' +
    'и снимать их целиком — сотни мегабайт ради единиц, с которыми реально пишут ' +
    'интеграции. Схемы входа и выхода взяты из actorDefinition последней сборки. ' +
    'Readme и исходники не снимаются.',
  actorCount: actors.length,
  withInputSchema: withInput,
  withOutputSchema: withOutput,
  actors,
}

mkdirSync(outDir, { recursive: true })
const file = join(outDir, 'actors.json')
const text = `${JSON.stringify(snapshot, null, 2)}\n`
writeFileSync(file, text)

const sha = createHash('sha256').update(text).digest('hex')
appendFileSync(join(outDir, 'MANIFEST.tsv'), `actors.json\t${sha}\t${Buffer.byteLength(text)}\n`)

console.log(`Готово: ${actors.length} акторов, со схемой входа ${withInput}, с описанием выхода ${withOutput}`)
console.log(`  ${file} — ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} МБ`)
if (failures.length > 0) {
  console.log(`  не удалось снять: ${failures.length}`)
  for (const f of failures.slice(0, 5)) console.log(`    ! ${f}`)
}
