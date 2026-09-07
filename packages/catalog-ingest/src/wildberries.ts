import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { CatalogBundle, CatalogMethod } from '@apistend/shared'
import { methodId } from '@apistend/shared'
import {
  cleanText, extractParams, extractResponse, firstSentence, iterateOperations,
  makeResolver, resolveHost, type OpenApiDoc,
} from './openapi.ts'
import { buildScenarios } from './scenarios.ts'

/**
 * Ингест Wildberries.
 *
 * Две мины, из-за которых каталог собирается пустым, если их не обработать:
 *  1) корневой servers пуст в 13 из 14 файлов — хост объявлен на уровне пути;
 *  2) рядом с боевыми хостами лежат *-sandbox, их надо отсеять.
 * Обе закрыты в resolveHost().
 */

/** Файл спецификации -> название группы в каталоге. Совпадает с info.title, но зафиксировано явно. */
const GROUP_TITLES: Record<string, string> = {
  '01-general': 'Общее',
  '02-items': 'Товары',
  '03-orders-fbs': 'Заказы FBS',
  '04-orders-dbw': 'Заказы DBW',
  '05-dbs': 'Заказы DBS',
  '06-in-store-pickup': 'Самовывоз',
  '07-orders-fbw': 'Поставки FBW',
  '08-promotion': 'Маркетинг и продвижение',
  '09-communications': 'Общение с покупателями',
  '10-rates': 'Тарифы',
  '11-analytics': 'Аналитика и данные',
  '12-reports': 'Отчёты',
  '13-finances': 'Документы и бухгалтерия',
  '14-wbd': 'Wildberries Цифровой',
}

/**
 * Wildberries Цифровой живёт на другом хосте и требует токена другой категории.
 * Показываем отдельной группой, а не подмешиваем к остальным 294 методам.
 */
const SEPARATE_PRODUCT = new Set(['14-wbd'])

/** Уникальный префикс компонентов для каждого файла: имена схем между файлами пересекаются. */
function namespaceRefs(doc: OpenApiDoc, fileId: string): OpenApiDoc {
  const prefix = fileId.replace(/-/g, '_')
  const json = JSON.stringify(doc).replace(
    /"#\/components\/([A-Za-z0-9_]+)\/([^"]+)"/g,
    (_m, kind: string, name: string) => `"#/components/${kind}/${prefix}__${name}"`,
  )
  const next = JSON.parse(json) as OpenApiDoc
  if (next.components) {
    const renamed: Record<string, Record<string, unknown>> = {}
    for (const [kind, entries] of Object.entries(next.components)) {
      renamed[kind] = {}
      for (const [name, value] of Object.entries(entries)) {
        renamed[kind][`${prefix}__${name}`] = value
      }
    }
    next.components = renamed
  }
  return next
}

export interface IngestResult {
  bundle: CatalogBundle
  /** Объединённый документ: нужен движку моков, чтобы разрешать $ref при генерации ответа. */
  mergedSpec: OpenApiDoc
  warnings: string[]
}

export function ingestWildberries(specDir: string): IngestResult {
  const source = JSON.parse(readFileSync(join(specDir, 'SOURCE.json'), 'utf8')) as {
    sourceUrl: string
    mirrorUrl: string
    mirrorLicense: string | null
    specLicense: string | null
    snapshotDate: string
  }
  const manifest = readFileSync(join(specDir, 'MANIFEST.tsv'), 'utf8')
  const sourceSha256 = hashOfManifest(manifest)

  const files = readdirSync(specDir).filter((f) => f.endsWith('.yaml')).sort()
  const methods: CatalogMethod[] = []
  const warnings: string[] = []
  const merged: OpenApiDoc = { openapi: '3.0.1', info: { title: 'Wildberries (объединённая спека)' }, paths: {}, components: {} }
  const seenIds = new Set<string>()

  for (const file of files) {
    const fileId = file.replace(/\.yaml$/, '')
    const raw = parseYaml(readFileSync(join(specDir, file), 'utf8')) as OpenApiDoc
    const doc = namespaceRefs(raw, fileId)
    const resolve = makeResolver(doc)
    const group = GROUP_TITLES[fileId] ?? doc.info?.title ?? fileId

    for (const [kind, entries] of Object.entries(doc.components ?? {})) {
      merged.components![kind] = { ...(merged.components![kind] ?? {}), ...entries }
    }

    for (const { path, method, op, pathItem } of iterateOperations(doc)) {
      const host = resolveHost(op, pathItem, doc)
      if (!host) {
        warnings.push(`${fileId}: ${method} ${path} — не удалось определить боевой хост, метод пропущен`)
        continue
      }

      const id = methodId('wildberries', method, path)
      if (seenIds.has(id)) {
        warnings.push(`${fileId}: ${method} ${path} — дубль, уже добавлен из другого файла`)
        continue
      }
      seenIds.add(id)

      const { successStatus, example, schemaPointer, errorStatuses } = extractResponse(op, resolve)
      const summary = cleanText(op.summary, 200)
      const description = firstSentence(op.description ?? op.summary ?? '', 140)

      methods.push({
        id,
        serviceCode: 'wildberries',
        httpMethod: method,
        path,
        title: summary || `${method} ${path}`,
        description: description || summary,
        group: SEPARATE_PRODUCT.has(fileId) ? `${group} (отдельный продукт)` : group,
        tag: cleanText(op.tags?.[0], 80) || group,
        upstreamHost: host,
        version: versionFromPath(path),
        // Готовность честная: есть пример -> готов; есть только схема -> в работе;
        // нет ни того ни другого -> запланирован.
        readiness: example !== null ? 'ready' : schemaPointer ? 'updating' : 'planned',
        deprecated: op.deprecated === true,
        params: extractParams(op, pathItem, resolve),
        scenarios: buildScenarios(successStatus, errorStatuses),
        latencyMs: 180,
        responseSource: example !== null ? 'example' : schemaPointer ? 'schema' : 'generic',
        extraction: 'mirror',
        sourceUrl: `${source.sourceUrl}${fileId}.yaml`,
        snapshotDate: source.snapshotDate,
        license: source.specLicense,
        responseExample: example,
        responseSchemaRef: schemaPointer,
        requestSchemaRef: requestSchemaRef(op),
        successStatus,
      })

      merged.paths![path] = { ...(merged.paths![path] ?? {}), ...pathItem }
    }
  }

  methods.sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.path.localeCompare(b.path))

  return {
    bundle: {
      serviceCode: 'wildberries',
      generatedAt: new Date().toISOString(),
      snapshotDate: source.snapshotDate,
      sourceUrl: source.sourceUrl,
      sourceSha256,
      license: source.specLicense,
      methodCount: methods.length,
      methods,
    },
    mergedSpec: merged,
    warnings,
  }
}

function requestSchemaRef(op: { requestBody?: unknown }): string | null {
  const body = op.requestBody as { content?: Record<string, { schema?: { $ref?: string } }> } | undefined
  const ref = body?.content?.['application/json']?.schema?.$ref
  return typeof ref === 'string' ? ref : null
}

/** Версия из пути: /api/v3/orders -> v3, /content/v2/... -> v2. */
function versionFromPath(path: string): string {
  const m = /\/(v\d+)(\/|$)/.exec(path)
  return m?.[1] ?? 'v1'
}

/** Хеш манифеста фиксирует состав снимка целиком: посчитан по sha256 каждого файла. */
function hashOfManifest(manifest: string): string {
  return createHash('sha256').update(manifest).digest('hex')
}
