import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogBundle, CatalogMethod } from '@apistend/shared'
import { methodId } from '@apistend/shared'
import {
  cleanText, extractParams, extractResponse, firstSentence, iterateOperations,
  makeResolver, resolveHost, type OpenApiDoc,
} from './openapi.ts'
import { buildScenarios } from './scenarios.ts'

/**
 * Ингест Apify API v2.
 *
 * Единственный источник в проекте, который не пришлось ни обходить, ни зеркалить:
 * вендор сам публикует OpenAPI 3.1 по прямой ссылке, без антибота и без входа.
 * Поэтому extraction здесь — 'spec', а не 'mirror': каталог показывает живую
 * спецификацию сервиса, а не чей-то её снимок.
 *
 * Особенности, из-за которых нельзя взять её совсем «как есть»:
 *
 *  1) servers объявлен как «https://api.apify.com», а версия («/v2») входит
 *     в каждый путь. Для нас это удобно: путь мока совпадает с боевым дословно,
 *     подмена адреса сводится к замене хоста на префикс монтирования.
 *
 *  2) Теги разложены по разделам не через x-tagGroups, а иерархией имён с косой чертой:
 *     «Storage/Datasets/Items». Верхний уровень — раздел, последний — рубрика.
 *
 *  3) Спецификация помечает версией дату сборки (info.version = v2-2026-09-02T…),
 *     и она же служит датой снимка: снимок датируется тем, когда его собрал вендор.
 */

interface ApifySource {
  sourceUrl: string
  specUrl: string
  specVersion: string
  specLicense: string | null
  snapshotDate: string
  methodCount: number
}

export interface ApifyIngestResult {
  bundle: CatalogBundle
  mergedSpec: OpenApiDoc
  warnings: string[]
}

/**
 * Раздел и рубрика из тега.
 *
 * «Storage/Datasets/Items» -> раздел «Storage», рубрика «Datasets · Items».
 * Тег без косой черты сам себе и раздел, и рубрика.
 */
function splitTag(tag: string): { group: string; title: string } {
  const parts = tag.split('/').map((p) => cleanText(p, 60)).filter((p) => p.length > 0)
  if (parts.length === 0) return { group: 'Прочее', title: 'Прочее' }
  const [group, ...rest] = parts
  return { group: group!, title: rest.length > 0 ? rest.join(' · ') : group! }
}

/** Версия из пути: /v2/actors -> v2. */
function versionFromPath(path: string): string {
  const m = /^\/(v\d+)(\/|$)/.exec(path)
  return m?.[1] ?? 'v2'
}

function requestSchemaRef(op: { requestBody?: unknown }): string | null {
  const body = op.requestBody as { content?: Record<string, { schema?: { $ref?: string } }> } | undefined
  const ref = body?.content?.['application/json']?.schema?.$ref
  return typeof ref === 'string' ? ref : null
}

export function ingestApify(specDir: string): ApifyIngestResult {
  const source = JSON.parse(readFileSync(join(specDir, 'SOURCE.json'), 'utf8')) as ApifySource

  const rawSpec = readFileSync(join(specDir, 'openapi.json'), 'utf8')
  const sourceSha256 = createHash('sha256').update(rawSpec).digest('hex')
  const doc = JSON.parse(rawSpec) as OpenApiDoc

  const resolve = makeResolver(doc)

  const methods: CatalogMethod[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const { path, method, op, pathItem } of iterateOperations(doc)) {
    const host = resolveHost(op, pathItem, doc)
    if (!host) {
      warnings.push(`${method} ${path} — не удалось определить боевой хост, метод пропущен`)
      continue
    }

    const id = methodId('apify', method, path)
    if (seen.has(id)) {
      warnings.push(`${method} ${path} — дубль пути`)
      continue
    }
    seen.add(id)

    const { group, title: tagTitle } = splitTag(op.tags?.[0] ?? '')
    const { successStatus, example, schemaPointer, errorStatuses } = extractResponse(op, resolve)
    const summary = cleanText(op.summary, 200)
    const description = firstSentence(op.description ?? op.summary ?? '', 140)

    methods.push({
      id,
      serviceCode: 'apify',
      httpMethod: method,
      path,
      title: summary || `${method} ${path}`,
      description: description || summary,
      group,
      tag: tagTitle,
      upstreamHost: host,
      version: versionFromPath(path),
      readiness: example !== null ? 'ready' : schemaPointer ? 'updating' : 'planned',
      deprecated: op.deprecated === true,
      params: extractParams(op, pathItem, resolve),
      scenarios: buildScenarios(successStatus, errorStatuses),
      // Apify отвечает быстро: у боевого API это единицы десятков миллисекунд
      // на чтение метаданных. Ставим ту же величину, что и остальным сервисам,
      // чтобы задержка не выглядела свойством конкретного мока.
      latencyMs: 120,
      responseSource: example !== null ? 'example' : schemaPointer ? 'schema' : 'generic',
      // Спецификацию отдаёт сам вендор — это не зеркало и не разбор документации.
      extraction: 'spec',
      sourceUrl: op.operationId
        ? `${source.sourceUrl}/${op.operationId}`
        : `${source.sourceUrl}#${method.toLowerCase()}-${path}`,
      snapshotDate: source.snapshotDate,
      license: source.specLicense,
      responseExample: example,
      responseSchemaRef: schemaPointer,
      requestSchemaRef: requestSchemaRef(op),
      successStatus,
    })
  }

  // Сверка с тем, что насчитал скрипт вендоринга: расхождение означает, что
  // спецификацию подменили между скачиванием и сборкой каталога.
  if (methods.length !== source.methodCount) {
    warnings.push(
      `в спецификации ${source.methodCount} операций, в каталог попало ${methods.length} — ` +
      'сверьте specs/apify/SOURCE.json и MANIFEST.tsv',
    )
  }

  methods.sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.path.localeCompare(b.path))

  return {
    bundle: {
      serviceCode: 'apify',
      generatedAt: new Date().toISOString(),
      snapshotDate: source.snapshotDate,
      sourceUrl: source.specUrl,
      sourceSha256,
      license: source.specLicense,
      methodCount: methods.length,
      methods,
    },
    mergedSpec: doc,
    warnings,
  }
}
