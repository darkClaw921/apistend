import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { marked, type Token, type Tokens } from 'marked'
import { parseDocBlocks, type DocNode } from './blocks.ts'

/**
 * Источник документации: markdown-файлы в src/content/docs.
 *
 * Читается на сервере во время сборки — страницы документации статические.
 * Дерево навигации, оглавление, соседние страницы и поисковый индекс собираются
 * отсюда же, из фронтматтера и заголовков. Второго, руками написанного списка
 * разделов нет намеренно: он расходится с файлами на первой же новой странице.
 */

const CONTENT_DIR = join(process.cwd(), 'src', 'content', 'docs')

/** Репозиторий и ветка для ссылки «поправить страницу». */
const REPO = 'https://github.com/darkClaw921/apistend'
const BRANCH = 'main'

export interface DocMeta {
  /**
   * Путь в адресе без префикса /docs. Пустая строка — корневая страница /docs.
   * По умолчанию повторяет путь файла, ключ `slug` во фронтматтере его меняет.
   */
  slug: string
  /** Сегменты того же пути: то, что ждёт generateStaticParams. */
  segments: string[]
  title: string
  description: string
  /** Порядок внутри группы и порядок самих групп. Меньше — выше. */
  order: number
  /** Заголовок группы в дереве слева. Пусто — пункт стоит до всех групп. */
  group: string
  /** Страница не показывается в навигации, поиске и в «предыдущая/следующая». */
  hidden: boolean
  /** Путь файла от корня репозитория — для ссылки на GitHub. */
  repoPath: string
}

export interface DocPage extends DocMeta {
  /** Тело страницы без фронтматтера, уже разобранное на блоки-директивы. */
  nodes: DocNode[]
  headings: DocHeading[]
}

export interface DocHeading {
  id: string
  text: string
  level: 2 | 3
}

export interface DocGroup {
  title: string
  items: DocMeta[]
}

/**
 * Якоря заголовков и адреса разделов поиска.
 *
 * Кириллицу не транслитерируем и не выкидываем: заголовки здесь русские, и
 * транслитерация дала бы нечитаемые «nachalo-raboty», а выбрасывание — пустые
 * идентификаторы вида «-1», одинаковые у половины страницы.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Простейший фронтматтер: `ключ: значение` по строке, без вложенности. */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    // Кавычки нужны только там, где значение начинается с двоеточия или решётки.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) data[key] = value
  }
  return { data, body: raw.slice(m[0].length) }
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (entry.endsWith('.md')) acc.push(full)
  }
  return acc
}

/**
 * Заголовки h2/h3 страницы — из них строится оглавление справа и якоря в тексте.
 * Идентификаторы обязаны совпасть с теми, что проставит рендер, поэтому считаются
 * здесь один раз и одной функцией: рендер вызывает её же.
 */
export function collectHeadings(nodes: DocNode[]): DocHeading[] {
  const out: DocHeading[] = []
  const seen = new Map<string, number>()

  function visit(list: DocNode[]) {
    for (const node of list) {
      if (node.kind === 'container') {
        visit(node.children)
        continue
      }
      for (const token of marked.lexer(node.text)) {
        if (token.type !== 'heading') continue
        const h = token as Tokens.Heading
        if (h.depth !== 2 && h.depth !== 3) continue
        const text = plainText([h as Token])
        const base = slugifyHeading(text) || 'razdel'
        // Одинаковые заголовки на странице встречаются («Ответ», «Ошибки»),
        // и без счётчика оглавление вело бы все такие пункты в первый из них.
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        out.push({ id: n === 0 ? base : `${base}-${n + 1}`, text, level: h.depth as 2 | 3 })
      }
    }
  }

  visit(nodes)
  return out
}

/** Текст без разметки: нужен и поиску, и заголовкам (в них бывает `код`). */
export function plainText(tokens: Token[]): string {
  let out = ''
  for (const token of tokens) {
    const any = token as { type: string; text?: string; tokens?: Token[]; items?: Token[] }
    if (any.type === 'code') {
      out += `${any.text ?? ''} `
      continue
    }
    if (Array.isArray(any.tokens) && any.tokens.length > 0) {
      out += `${plainText(any.tokens)} `
      continue
    }
    if (Array.isArray(any.items)) {
      out += `${plainText(any.items)} `
      continue
    }
    if (typeof any.text === 'string') out += `${any.text} `
  }
  return out.replace(/\s+/g, ' ').trim()
}

function readPage(file: string): DocPage {
  const rel = relative(CONTENT_DIR, file)
  const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  /*
    Адрес по умолчанию повторяет путь файла. Ключ `slug` во фронтматтере его
    переопределяет — это нужно файлам, чьё имя в адрес не годится: сегмент
    с кириллицей приходит в маршрут процентно-закодированным и не совпадает
    со списком из generateStaticParams, из-за чего страница отвечает 404.
  */
  const segments = (data.slug ?? rel.slice(0, -'.md'.length).split(sep).join('/'))
    .split('/')
    .filter((s) => s.length > 0)
    // index.md — корневая страница раздела: /docs, а не /docs/index.
    .filter((s, i, arr) => !(s === 'index' && i === arr.length - 1))
  const nodes = parseDocBlocks(body)

  return {
    slug: segments.join('/'),
    segments,
    title: data.title ?? rel,
    description: data.description ?? '',
    order: Number.isFinite(Number(data.order)) && data.order ? Number(data.order) : 1000,
    group: data.group ?? '',
    // README для авторов лежит рядом с содержанием и по адресу открывается,
    // но в дереве разделов ему не место — это служебный файл, а не глава.
    hidden: data.hidden === 'true' || rel.startsWith('README'),
    repoPath: `apps/web/src/content/docs/${rel.split(sep).join('/')}`,
    nodes,
    headings: collectHeadings(nodes),
  }
}

/**
 * Кэш на модуль. Файлы читаются один раз за процесс: при сборке это десятки
 * страниц, и перечитывать их на каждый generateStaticParams незачем.
 *
 * В разработке кэша нет. Правка markdown не трогает этот модуль, Next его
 * не перезагружает — и страница показывала прежний текст до перезапуска
 * сервера, что выглядело как «правка не применилась».
 */
const CACHE_ENABLED = process.env.NODE_ENV === 'production'
let cache: DocPage[] | null = null

export function getAllDocs(): DocPage[] {
  if (cache && CACHE_ENABLED) return cache
  cache = walk(CONTENT_DIR)
    .map(readPage)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'))
  return cache
}

export function getDoc(slug: string): DocPage | null {
  return getAllDocs().find((d) => d.slug === slug) ?? null
}

/** Страницы навигации в порядке чтения — по ним же считаются «назад/вперёд». */
export function getNavPages(): DocMeta[] {
  return getAllDocs().filter((d) => !d.hidden)
}

/**
 * Дерево слева. Группы упорядочены по наименьшему order своих страниц:
 * отдельного списка групп нет, иначе он разошёлся бы с файлами.
 */
export function getNavTree(): DocGroup[] {
  const groups = new Map<string, DocMeta[]>()
  for (const page of getNavPages()) {
    const list = groups.get(page.group)
    if (list) list.push(page)
    else groups.set(page.group, [page])
  }
  return [...groups.entries()]
    .map(([title, items]) => ({ title, items }))
    .sort((a, b) => Math.min(...a.items.map((i) => i.order)) - Math.min(...b.items.map((i) => i.order)))
}

export function getNeighbours(slug: string): { prev: DocMeta | null; next: DocMeta | null } {
  const pages = getNavPages()
  const at = pages.findIndex((p) => p.slug === slug)
  if (at === -1) return { prev: null, next: null }
  return { prev: pages[at - 1] ?? null, next: pages[at + 1] ?? null }
}

export function editUrl(repoPath: string): string {
  return `${REPO}/edit/${BRANCH}/${repoPath}`
}

/** Строка адреса страницы документации. */
export function docHref(slug: string): string {
  return slug ? `/docs/${slug}` : '/docs'
}

export interface SearchEntry {
  href: string
  /** Название страницы — показывается над найденным разделом. */
  page: string
  group: string
  /** Заголовок раздела. Для начала страницы совпадает с названием. */
  section: string
  /** Текст раздела в нижнем регистре: по нему идёт поиск на клиенте. */
  body: string
}

/**
 * Индекс поиска. Собирается при сборке и уезжает в клиентский компонент пропсом —
 * внешних служб поиск не использует.
 *
 * Дробим не по страницам, а по разделам h2: попадание в конкретный раздел
 * длинной страницы полезнее, чем «эта страница где-то упоминает слово».
 */
export function getSearchIndex(): SearchEntry[] {
  const out: SearchEntry[] = []

  for (const page of getAllDocs()) {
    if (page.hidden) continue
    const href = docHref(page.slug)
    let section: SearchEntry = {
      href,
      page: page.title,
      group: page.group,
      section: page.title,
      body: `${page.title} ${page.description}`,
    }
    // Идентификаторы берём из уже посчитанных заголовков страницы, а не считаем
    // заново: второй счётчик однажды разошёлся бы с рендером, и ссылка из поиска
    // вела бы на несуществующий якорь.
    const anchors = page.headings.filter((h) => h.level === 2).map((h) => h.id)
    let anchorAt = 0

    function flush() {
      section.body = section.body.toLowerCase().replace(/\s+/g, ' ').trim()
      out.push(section)
    }

    function visit(list: DocNode[]) {
      for (const node of list) {
        if (node.kind === 'container') {
          // Название вкладки — тоже текст страницы: по «docker compose» должно искаться.
          if (node.arg) section.body += ` ${node.arg}`
          visit(node.children)
          continue
        }
        for (const token of marked.lexer(node.text)) {
          if (token.type === 'heading' && (token as Tokens.Heading).depth === 2) {
            const text = plainText([token])
            const anchor = anchors[anchorAt++] ?? slugifyHeading(text)
            flush()
            section = {
              href: `${href}#${anchor}`,
              page: page.title,
              group: page.group,
              section: text,
              body: text,
            }
            continue
          }
          section.body += ` ${plainText([token])}`
        }
      }
    }

    visit(page.nodes)
    flush()
  }

  return out
}
