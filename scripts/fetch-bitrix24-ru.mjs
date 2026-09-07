/**
 * Русские тексты Bitrix24: заголовок, описание и подписи параметров.
 *
 * Репозиторий b24restdocs (MIT) — единственный источник с явной лицензией,
 * но он только англоязычный: веток `ru` у него нет, и на apidocs.bitrix24.com
 * пути /ru/ отдают 404. Русская версия тех же страниц живёт на отдельном хосте
 * apidocs.bitrix24.ru с ПОЛНОСТЬЮ СОВПАДАЮЩИМИ путями, поэтому перевод — это
 * подмена хоста в sourceUrl, а не отдельный маппинг.
 *
 * Страница собрана Diplodoc: весь контент лежит в <script id="diplodoc-state">,
 * поэтому HTML не парсим регулярками по вёрстке — берём JSON.
 *
 * Результат кладём в .cache (84 МБ страниц в git не нужны), в репозиторий
 * попадает только собранный каталог.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const catalogPath = join(repoRoot, 'packages/mock-engine/generated/bitrix24.catalog.json')
const outPath = join(repoRoot, '.cache/b24ru/pages.json')

const CONCURRENCY = 8
const LIMIT = Number(process.env.LIMIT ?? 0)

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

const stripTags = (html) =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|li|tr|div|h\d)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()

const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)

/**
 * Описание — первый абзац до первого раздела: служебные блоки (подсказки, scope,
 * DEPRECATED) описанием не являются, как и подпись «Обязательные параметры отмечены».
 */
function firstParagraph(html) {
  const head = html.split(/<h2\b/)[0] ?? html
  const body = head
    .replace(/<div class="yfm-note[\s\S]*?<\/div><\/div>/g, '')
    .replace(/<blockquote>[\s\S]*?<\/blockquote>/g, '')
  const re = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g
  let m
  while ((m = re.exec(body))) {
    if (/class="[^"]*b24-info/.test(m[0])) continue
    const text = stripTags(m[1])
    // Порог низкий: «Метод удаляет счет.» — девятнадцать символов и полноценное описание.
    if (text.length > 10) return text
  }
  return ''
}

/**
 * Таблицы разделов «Параметры метода» и «Параметр fields», и только они:
 * на странице есть ещё таблица кодов ошибок с такими же по виду ключами
 * (ACCESS_DENIED и подобные), и без ограничения по разделу описания
 * параметров подменялись бы текстами ошибок.
 */
function paramSections(html) {
  const out = []
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/g
  const heads = []
  let m
  while ((m = re.exec(html))) heads.push({ title: stripTags(m[1]), from: m.index + m[0].length })
  for (let i = 0; i < heads.length; i += 1) {
    if (!/Параметр/i.test(heads[i].title)) continue
    const to = i + 1 < heads.length ? heads[i + 1].from : html.length
    out.push({ nested: /fields/i.test(heads[i].title), html: html.slice(heads[i].from, to) })
  }
  return out
}

function paramDescriptions(html) {
  const out = {}
  for (const section of paramSections(html)) {
    for (const table of section.html.match(/<table>[\s\S]*?<\/table>/g) ?? []) {
      for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1])
        if (cells.length < 2) continue
        // Первая ячейка — «<strong>имя</strong><br><code>тип</code>»: имя только из strong.
        const strong = /<strong>([\s\S]*?)<\/strong>/.exec(cells[0])
        const bare = stripTags(strong ? strong[1] : cells[0]).replace(/[*^\s]+$/g, '').trim()
        if (!/^[A-Za-z_][\w.]*$/.test(bare)) continue
        // Колонок бывает и три (добавляется «обязательный»): описание — самая длинная.
        const desc = cells.slice(1).map(stripTags).sort((a, b) => b.length - a.length)[0] ?? ''
        const name = section.nested ? `fields.${bare}` : bare
        // Порога длины нет: «Пол», «Факс» — законные описания полей.
        if (desc && !out[name]) out[name] = clip(desc, 200)
      }
    }
  }
  return out
}

function extract(html, methodName) {
  const m = /<script[^>]*id="diplodoc-state"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!m) return null
  let state
  try {
    state = JSON.parse(m[1])
  } catch {
    return null
  }
  const data = state?.data
  if (!data?.html) return null
  const content = decodeEntities(data.html)

  // Заголовок вида «Получить список сделок crm.deal.list» — имя метода убираем.
  const rawTitle = String(data.title ?? '')
  const title = clip(rawTitle.replace(methodName, '').replace(/\s{2,}/g, ' ').trim(), 120)

  return {
    title: title || rawTitle,
    description: clip(firstParagraph(content), 200),
    params: paramDescriptions(content),
  }
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const methods = Array.isArray(catalog) ? catalog : Object.values(catalog).find(Array.isArray)

// Каталог мог быть собран уже с оверлеем — тогда часть ссылок ведёт на .ru.
// Принимаем оба хоста, иначе повторный прогон молча пропустит переведённые методы.
const targets = methods
  .filter((m) => /^https:\/\/apidocs\.bitrix24\.(com|ru)\//.test(m.sourceUrl ?? ''))
  .map((m) => ({
    id: m.id,
    name: m.path.replace('/rest/', ''),
    url: m.sourceUrl.replace('apidocs.bitrix24.com', 'apidocs.bitrix24.ru'),
  }))

const queue = LIMIT > 0 ? targets.slice(0, LIMIT) : targets
mkdirSync(dirname(outPath), { recursive: true })

// Кеш переживает прерывание: повторный запуск дотягивает только недостающее.
const pages = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {}
const pending = queue.filter((t) => !pages[t.id])

let done = 0
let failed = 0
const stats = { title: 0, description: 0, params: 0 }

async function fetchOne(t) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(t.url, {
        headers: { 'accept-language': 'ru', 'user-agent': 'apistend-catalog-ingest' },
        signal: AbortSignal.timeout(25_000),
      })
      if (res.status === 404) return { missing: true }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return extract(await res.text(), t.name) ?? { missing: true }
    } catch (error) {
      if (attempt === 2) return { error: String(error) }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  return { error: 'unreachable' }
}

async function worker(items) {
  for (const t of items) {
    const result = await fetchOne(t)
    if (result.error || result.missing) failed += 1
    else {
      pages[t.id] = result
      if (result.title) stats.title += 1
      if (result.description) stats.description += 1
      if (Object.keys(result.params).length) stats.params += 1
    }
    done += 1
    if (done % 50 === 0) {
      process.stdout.write(`  ${done}/${pending.length}, не найдено ${failed}\n`)
      writeFileSync(outPath, JSON.stringify(pages))
    }
  }
}

process.stdout.write(`Русские страницы Bitrix24: ${pending.length} к загрузке (в кеше ${Object.keys(pages).length})\n`)

const chunks = Array.from({ length: CONCURRENCY }, (_, i) => pending.filter((_, j) => j % CONCURRENCY === i))
await Promise.all(chunks.map(worker))

writeFileSync(outPath, JSON.stringify(pages))
process.stdout.write(
  `Готово: ${Object.keys(pages).length} страниц, ` +
    `заголовок ${stats.title}, описание ${stats.description}, параметры ${stats.params}, недоступно ${failed}\n`,
)
