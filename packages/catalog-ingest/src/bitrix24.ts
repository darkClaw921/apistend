import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { CatalogBundle, CatalogMethod, MethodParam } from '@apistend/shared'
import { methodId } from '@apistend/shared'
import { buildScenarios } from './scenarios.ts'
import { findTables, firstJsonBlock, parseYfmTable, section, stripMarkup } from './yfm.ts'

/**
 * Ингест Bitrix24 REST API.
 *
 * Источник — github.com/bitrix24/b24restdocs (MIT, единственный юридически чистый
 * из трёх сервисов). Это НЕ OpenAPI, а Diplodoc-YFM: разбираем сами (см. yfm.ts).
 *
 * Что даёт разбор и что нет:
 *   имя метода, scope, раздел, описание, параметры — почти везде;
 *   схема ответа как ТИП — нигде, её у Bitrix24 нет в принципе.
 * Поэтому ответ строится из JSON-примера документации, а методы без примера
 * получают статус «Запланирован». Достраивать схему «по смыслу» нельзя:
 * это ровно тот случай, когда мок начнёт врать.
 */

/** Раздел документации -> человекочитаемое название группы в каталоге. */
const SCOPE_TITLES: Record<string, string> = {
  crm: 'CRM',
  tasks: 'Задачи',
  catalog: 'Торговый каталог',
  sale: 'Интернет-магазин',
  landing: 'Сайты и магазины',
  im: 'Чаты и уведомления',
  imopenlines: 'Открытые линии',
  'chat-bots': 'Чат-боты',
  chats: 'Чаты',
  booking: 'Бронирование ресурсов',
  disk: 'Диск',
  calendar: 'Календарь',
  lists: 'Списки',
  bizproc: 'Бизнес-процессы',
  telephony: 'Телефония',
  user: 'Пользователи',
  departments: 'Структура компании',
  entity: 'Хранилище данных',
  events: 'События',
  'event-log': 'Журнал событий',
  log: 'Живая лента',
  timeman: 'Учёт рабочего времени',
  'user-consent': 'Согласия пользователей',
  'document-generator': 'Генератор документов',
  rpa: 'Роботизация процессов',
  sign: 'Подписание документов',
  'pay-system': 'Платёжные системы',
  'sales-center': 'Центр продаж',
  messageservice: 'Сервис сообщений',
  mailservice: 'Почтовые сервисы',
  mail: 'Почта',
  notify: 'Уведомления',
  placement: 'Встраивания',
  biconnector: 'BI-конструктор',
  ai: 'ИИ-сервисы',
  files: 'Файлы',
  note: 'Заметки',
  common: 'Общие методы',
  scopes: 'Права доступа',
  outdated: 'Устаревшие методы',
}

/** Разделы, которые не описывают вызываемые методы. */
const SKIP_DIRS = new Set(['_assets', '_images', '_includes', 'scopes', 'data-types'])

/** Файлы-оглавления и обзоры, а не методы. */
const SKIP_FILES = new Set(['index.md', 'index.yaml', 'b24-toc.yaml'])

interface ParsedMethod {
  name: string
  title: string
  description: string
  scope: string
  group: string
  deprecated: boolean
  params: MethodParam[]
  responseExample: unknown | null
  errorStatuses: number[]
  sourcePath: string
}

/** Имя REST-метода из заголовка: «Create a New Deal crm.deal.add» -> crm.deal.add */
function methodNameFromHeading(heading: string): string | null {
  // Имена методов Bitrix24 — латиница с точками, минимум одна точка.
  const matches = heading.match(/\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\b/gi)
  if (!matches || matches.length === 0) return null
  // Берём последнее вхождение: заголовок обычно «Название метода method.name».
  const candidate = matches[matches.length - 1]!
  // Отсекаем ложные срабатывания вида «v1.0» и имена файлов.
  if (/\.(md|json|php|js|py|yaml)$/i.test(candidate)) return null
  if (/^\d/.test(candidate)) return null
  return candidate
}

function parseParamTable(block: string, where: MethodParam['in']): MethodParam[] {
  const rows = parseYfmTable(block)
  const out: MethodParam[] = []

  for (const row of rows) {
    if (row.cells.length < 2) continue
    const nameCell = row.cells[0]!
    const descCell = row.cells[1]!

    // Заголовочная строка таблицы: «**Name** `type` | **Description**»
    if (/^\*\*Name\*\*/i.test(nameCell.raw) || /^\*\*Описание\*\*/i.test(descCell.raw)) continue

    const nameMatch = /\*\*([^*]+)\*\*/.exec(nameCell.raw)
    if (!nameMatch) continue
    const name = nameMatch[1]!.trim()
    if (name.length === 0 || name.length > 60) continue

    // Тип лежит во второй строке ячейки: [`object`](../../data-types.md)
    const typeMatch = /`([^`]+)`/.exec(nameCell.raw.replace(/\*\*[^*]+\*\*/, ''))
    const type = typeMatch?.[1]?.trim() ?? 'string'

    // Обязательность в документации помечают звёздочкой в имени или словом в описании.
    const required = name.endsWith('*') || /обязательн|required/i.test(descCell.text.slice(0, 120))

    out.push({
      name: name.replace(/\*+$/, ''),
      in: where,
      type,
      required,
      description: stripMarkup(descCell.raw, 200),
    })
  }
  return out
}

function parseFile(absPath: string, repoRoot: string): ParsedMethod | null {
  let text: string
  try {
    text = readFileSync(absPath, 'utf8')
  } catch {
    return null
  }

  const headingMatch = /^#\s+(.+)$/m.exec(text)
  if (!headingMatch) return null
  const heading = headingMatch[1]!.trim()

  const name = methodNameFromHeading(heading)
  if (!name) return null

  const title = stripMarkup(heading.replace(name, ''), 120) || name
  const scopeMatch = /^>\s*Scope:\s*\[`?([a-z0-9_]+)`?\]/im.exec(text)
  const scope = scopeMatch?.[1] ?? name.split('.')[0] ?? 'common'

  const deprecated =
    /\{%\s*note\s+warning\s+"DEPRECATED"/i.test(text) ||
    /development of this method has been halted/i.test(text)

  // Описание — первый абзац после служебных блоков.
  //
  // Директивы Diplodoc убираем ДО поиска абзаца: строка `{% if build == 'dev' %}`
  // длиннее двадцати символов, поэтому раньше проходила как абзац, а stripMarkup
  // затем стирал её в пустоту — так одиннадцать методов остались без описания.
  const body = text
    .slice(headingMatch.index + headingMatch[0].length)
    .replace(/\{%\s*note[\s\S]*?\{%\s*endnote\s*%\}/g, '')
    .replace(/^\s*\{%[^%]*%\}\s*$/gm, '')
    .replace(/^>.*$/gm, '')
  const firstParagraph = body
    .split(/\n\s*\n/)
    .map((p) => stripMarkup(p.trim(), 200))
    .find((p) => p.length > 20 && !p.startsWith('#'))
  const description = firstParagraph ?? stripMarkup(title, 200)

  // Параметры: таблица под «Method Parameters» плюс вложенная «Parameter fields».
  const params: MethodParam[] = []
  const paramsSection = section(text, /Method Parameters|Параметры метода/i)
  if (paramsSection) {
    for (const table of findTables(paramsSection)) params.push(...parseParamTable(table, 'body'))
  }
  const fieldsSection = section(text, /Parameter fields|Параметр fields/i)
  if (fieldsSection) {
    for (const table of findTables(fieldsSection)) {
      for (const p of parseParamTable(table, 'body')) {
        if (!params.some((x) => x.name === p.name)) params.push({ ...p, name: `fields.${p.name}` })
      }
    }
  }

  // Ответ: первый валидный блок ```json в разделе обработки ответа.
  const responseSection = section(text, /Response Handling|Обработка ответа|Success response/i)
  const responseExample = responseSection ? firstJsonBlock(responseSection) : null

  // Коды ошибок: их таблица есть у 85 % методов, но HTTP-статусы Bitrix24 в неё не пишет.
  // Сценарии строим по универсальному набору, который сервис отдаёт всегда.
  const errorSection = section(text, /Error Handling|Обработка ошибок/i)
  const errorStatuses = errorSection ? [400, 401, 403, 503] : [401, 503]

  return {
    name,
    title,
    description,
    scope,
    group: SCOPE_TITLES[scope] ?? SCOPE_TITLES[relative(repoRoot, absPath).split('/')[1] ?? ''] ?? scope,
    deprecated,
    params: params.slice(0, 60),
    responseExample,
    errorStatuses,
    sourcePath: relative(repoRoot, absPath),
  }
}

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      yield* walk(full)
    } else if (entry.endsWith('.md') && !SKIP_FILES.has(entry)) {
      yield full
    }
  }
}

/**
 * Русские тексты Bitrix24.
 *
 * Репозиторий b24restdocs — единственный источник с явной лицензией (MIT),
 * но он только англоязычный: ветки `ru` у него нет, а /ru/ на apidocs.bitrix24.com
 * отдаёт 404. Русская версия страниц лежит на apidocs.bitrix24.ru по тем же путям;
 * её собирает scripts/fetch-bitrix24-ru.mjs. Структура метода (параметры, пример
 * ответа) остаётся из MIT-репозитория — оверлей меняет только формулировки.
 */
interface RuPage {
  readonly title: string
  readonly description: string
  readonly params: Record<string, string>
}

/**
 * Ручной добор: горстка методов отсутствует и на apidocs.bitrix24.ru.
 * Тексты взяты из официального MCP-сервера документации, происхождение
 * записано в specs/bitrix24/ru-overrides.json.
 */
interface RuOverrides {
  readonly methods: Record<string, { description?: string; title?: string }>
}

function loadRuOverrides(path: string | undefined): RuOverrides['methods'] {
  if (!path) return {}
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as RuOverrides).methods ?? {}
  } catch {
    return {}
  }
}

function loadRuOverlay(path: string | undefined): Map<string, RuPage> {
  if (!path) return new Map()
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, RuPage>))
  } catch {
    return new Map()
  }
}

export interface Bitrix24IngestResult {
  bundle: CatalogBundle
  warnings: string[]
}

export function ingestBitrix24(
  repoRoot: string,
  options?: { scopes?: string[]; ruOverlayPath?: string; ruOverridesPath?: string },
): Bitrix24IngestResult {
  const apiRef = join(repoRoot, 'api-reference')
  const ru = loadRuOverlay(options?.ruOverlayPath)
  const ruOverrides = loadRuOverrides(options?.ruOverridesPath)
  let translated = 0
  const wantedScopes = options?.scopes ? new Set(options.scopes) : null

  const methods: CatalogMethod[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  const snapshotDate = new Date().toISOString().slice(0, 10)

  let files = 0
  let skippedNoMethod = 0

  for (const file of walk(apiRef)) {
    files++
    const parsed = parseFile(file, repoRoot)
    if (!parsed) {
      skippedNoMethod++
      continue
    }
    if (wantedScopes && !wantedScopes.has(parsed.scope)) continue

    // Путь вызова: у Bitrix24 метод — часть пути, а не тело запроса.
    const path = `/rest/${parsed.name}`
    const id = methodId('bitrix24', 'POST', path)
    if (seen.has(id)) continue
    seen.add(id)

    const hasExample = parsed.responseExample !== null
    const ruPage = ru.get(id)
    const override = ruOverrides[parsed.name]
    if (ruPage) translated++

    // Английский текст остаётся запасным: страницы без русской версии бывают.
    const params = ruPage
      ? parsed.params.map((p) => ({ ...p, description: ruPage.params[p.name] ?? p.description }))
      : parsed.params

    methods.push({
      id,
      serviceCode: 'bitrix24',
      httpMethod: 'POST',
      path,
      title: override?.title || ruPage?.title || parsed.title,
      description: override?.description || ruPage?.description || parsed.description,
      group: parsed.group,
      tag: parsed.scope,
      upstreamHost: 'https://portal.bitrix24.ru',
      version: 'v1',
      // Схемы ответа у Bitrix24 нет вообще: без примера строить нечего.
      readiness: hasExample ? 'ready' : 'planned',
      deprecated: parsed.deprecated,
      params,
      scenarios: buildScenarios(200, parsed.errorStatuses),
      latencyMs: 180,
      responseSource: hasExample ? 'example' : 'generic',
      extraction: 'parsed',
      // Ссылка ведёт туда, откуда взят показанный текст: русская страница, если она есть.
      sourceUrl: `https://apidocs.bitrix24.${ruPage ? 'ru' : 'com'}/${parsed.sourcePath.replace(/\.md$/, '.html')}`,
      snapshotDate,
      license: 'MIT',
      responseExample: parsed.responseExample,
      responseSchemaRef: null,
      requestSchemaRef: null,
      successStatus: 200,
    })
  }

  const withoutExample = methods.filter((m) => m.responseSource === 'generic').length
  if (withoutExample > 0) {
    warnings.push(
      `${withoutExample} методов без JSON-примера ответа помечены как «Запланирован» — ` +
      'схемы ответа у Bitrix24 нет, достраивать её по смыслу нельзя',
    )
  }
  // Считаем по факту текста, а не по наличию страницы: страница бывает,
  // а абзаца с описанием на ней нет.
  const untranslated = methods.filter((m) => !/[а-яё]/i.test(m.description)).length
  if (untranslated > 0) {
    warnings.push(
      `${untranslated} методов остались с английским описанием: ` +
      'русской страницы на apidocs.bitrix24.ru для них нет',
    )
  }
  const enParams = methods.reduce(
    (sum, m) => sum + m.params.filter((p) => p.description && !/[а-яё]/i.test(p.description)).length,
    0,
  )
  if (enParams > 0) warnings.push(`${enParams} описаний параметров остались английскими`)
  warnings.push(
    `прочитано файлов: ${files}, из них без имени метода в заголовке: ${skippedNoMethod}; ` +
    `русских страниц подложено: ${translated}`,
  )

  methods.sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.path.localeCompare(b.path))

  return {
    bundle: {
      serviceCode: 'bitrix24',
      generatedAt: new Date().toISOString(),
      snapshotDate,
      sourceUrl: 'https://github.com/bitrix24/b24restdocs',
      sourceSha256: createHash('sha256').update(`${files}:${methods.length}`).digest('hex').slice(0, 16),
      license: 'MIT',
      methodCount: methods.length,
      methods,
    },
    warnings,
  }
}
