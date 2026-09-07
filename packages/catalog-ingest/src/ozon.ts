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
 * Ингест Ozon Seller API.
 *
 * Особенности, из-за которых нельзя взять спеку «как есть»:
 *  1) servers объявлен как «//api-seller.ozon.ru» — без схемы. Разбирается в resolveHost.
 *  2) components.securitySchemes пустой: авторизацию (Client-Id + Api-Key) в спеке
 *     не описали вовсе, она берётся из профиля сервиса.
 *  3) API почти целиком POST-over-HTTP в RPC-стиле: 414 POST против 6 GET.
 *     Это не ошибка разбора, а свойство сервиса.
 */

interface OzonDoc extends OpenApiDoc {
  'x-tagGroups'?: Array<{ name?: string; tags?: string[] }>
}

/** Разделы, которые Ozon помечает как отдельные продукты, а не как часть базового API. */
const SEPARATE_GROUPS = new Set(['Бета-методы', 'Premium-методы', 'Ozon Доставка', 'Приложения'])

/** Человекочитаемые названия разделов по тегу — из x-tagGroups самой спецификации. */
function buildTagIndex(doc: OzonDoc): Map<string, string> {
  const index = new Map<string, string>()
  for (const group of doc['x-tagGroups'] ?? []) {
    const name = group.name
    if (!name) continue
    for (const tag of group.tags ?? []) index.set(tag, name)
  }
  return index
}

/** Подпись тега из components: у Ozon теги описаны в корневом tags[]. */
function buildTagTitles(doc: OpenApiDoc): Map<string, string> {
  const titles = new Map<string, string>()
  const tags = (doc as { tags?: Array<{ name?: string; 'x-displayName'?: string }> }).tags ?? []
  for (const t of tags) {
    if (t.name) titles.set(t.name, cleanText(t['x-displayName'] ?? t.name, 60) || t.name)
  }
  return titles
}

export interface OzonIngestResult {
  bundle: CatalogBundle
  mergedSpec: OpenApiDoc
  warnings: string[]
}

export function ingestOzon(specDir: string): OzonIngestResult {
  const source = JSON.parse(readFileSync(join(specDir, 'SOURCE.json'), 'utf8')) as {
    sourceUrl: string
    specLicense: string | null
    snapshotDate: string
    mirrorMethodCount: number
    liveMethodCount: number
  }

  const rawSpec = readFileSync(join(specDir, 'seller.json'), 'utf8')
  const sourceSha256 = createHash('sha256').update(rawSpec).digest('hex')
  const doc = JSON.parse(rawSpec) as OzonDoc

  const resolve = makeResolver(doc)
  const groupByTag = buildTagIndex(doc)
  const titleByTag = buildTagTitles(doc)

  const methods: CatalogMethod[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const { path, method, op, pathItem } of iterateOperations(doc)) {
    const host = resolveHost(op, pathItem, doc)
    if (!host) {
      warnings.push(`${method} ${path} — не удалось определить боевой хост, метод пропущен`)
      continue
    }

    const id = methodId('ozon', method, path)
    if (seen.has(id)) {
      warnings.push(`${method} ${path} — дубль пути`)
      continue
    }
    seen.add(id)

    const tag = op.tags?.[0] ?? ''
    const groupName = groupByTag.get(tag) ?? 'Базовые методы'
    const tagTitle = titleByTag.get(tag) ?? cleanText(tag, 60) ?? 'Прочее'

    const { successStatus, example, schemaPointer, errorStatuses } = extractResponse(op, resolve)
    const summary = cleanText(op.summary, 200)
    const description = firstSentence(op.description ?? op.summary ?? '', 140)

    methods.push({
      id,
      serviceCode: 'ozon',
      httpMethod: method,
      path,
      title: summary || `${method} ${path}`,
      description: description || summary,
      // Раздел показываем так же, как его показывает сам Ozon: группа плюс тема тега.
      group: SEPARATE_GROUPS.has(groupName) ? `${groupName} · ${tagTitle}` : tagTitle,
      tag: tagTitle,
      upstreamHost: host,
      version: versionFromPath(path),
      readiness: example !== null ? 'ready' : schemaPointer ? 'updating' : 'planned',
      deprecated: op.deprecated === true,
      params: extractParams(op, pathItem, resolve),
      scenarios: buildScenarios(successStatus, errorStatuses),
      latencyMs: 180,
      responseSource: example !== null ? 'example' : schemaPointer ? 'schema' : 'generic',
      extraction: 'mirror',
      sourceUrl: `${source.sourceUrl}#operation/${op.operationId ?? path}`,
      snapshotDate: source.snapshotDate,
      license: source.specLicense,
      responseExample: example,
      responseSchemaRef: schemaPointer,
      requestSchemaRef: requestSchemaRef(op),
      successStatus,
    })
  }

  // Честная пометка: зеркало отстаёт от живой спецификации.
  const missing = source.liveMethodCount - methods.length
  if (missing > 0) {
    warnings.push(
      `зеркало отстаёт от живой спецификации на ${missing} методов ` +
      `(${methods.length} из ${source.liveMethodCount}); разницу закрывает браузерный воркер`,
    )
  }

  methods.sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.path.localeCompare(b.path))

  return {
    bundle: {
      serviceCode: 'ozon',
      generatedAt: new Date().toISOString(),
      snapshotDate: source.snapshotDate,
      sourceUrl: source.sourceUrl,
      sourceSha256,
      license: source.specLicense,
      methodCount: methods.length,
      methods,
    },
    mergedSpec: doc,
    warnings,
  }
}

function requestSchemaRef(op: { requestBody?: unknown }): string | null {
  const body = op.requestBody as { content?: Record<string, { schema?: { $ref?: string } }> } | undefined
  const ref = body?.content?.['application/json']?.schema?.$ref
  return typeof ref === 'string' ? ref : null
}

/** Версия из пути: /v3/posting/fbs/list -> v3. */
function versionFromPath(path: string): string {
  const m = /^\/(v\d+)\//.exec(path)
  return m?.[1] ?? 'v1'
}
