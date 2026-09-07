/**
 * Разбор OpenAPI 3.x в модель каталога APIStend.
 *
 * Общая часть для Ozon и Wildberries. Специфика сервиса (какие файлы читать,
 * как резолвить хост, как называть группы) живёт в отдельных модулях.
 */

export interface OpenApiDoc {
  openapi?: string
  info?: { title?: string; version?: string; description?: string }
  servers?: Array<{ url?: string; description?: string }>
  paths?: Record<string, PathItem>
  components?: Record<string, Record<string, unknown>>
}

export interface PathItem {
  servers?: Array<{ url?: string }>
  parameters?: unknown[]
  [method: string]: unknown
}

export interface Operation {
  tags?: string[]
  summary?: string
  description?: string
  operationId?: string
  deprecated?: boolean
  parameters?: unknown[]
  requestBody?: unknown
  responses?: Record<string, unknown>
  servers?: Array<{ url?: string }>
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

/** Разыменовывает локальный $ref внутри одного документа. Внешние ссылки не поддерживаются. */
export function makeResolver(doc: OpenApiDoc) {
  const cache = new Map<string, unknown>()

  function resolve<T = unknown>(node: unknown, depth = 0): T {
    if (depth > 32) return node as T
    if (typeof node !== 'object' || node === null) return node as T
    const ref = (node as { $ref?: unknown }).$ref
    if (typeof ref !== 'string') return node as T
    if (cache.has(ref)) return cache.get(ref) as T
    if (!ref.startsWith('#/')) return node as T

    let cur: unknown = doc
    for (const rawPart of ref.slice(2).split('/')) {
      const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
      if (typeof cur !== 'object' || cur === null) return node as T
      cur = (cur as Record<string, unknown>)[part]
      if (cur === undefined) return node as T
    }
    const out = resolve<T>(cur, depth + 1)
    cache.set(ref, out)
    return out
  }

  return resolve
}

/** Убирает HTML и markdown-разметку из описаний: в спеках WB они приходят с версткой. */
export function cleanText(raw: unknown, maxLen = 600): string {
  if (typeof raw !== 'string') return ''
  const text = raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLen) return text
  const cut = text.slice(0, maxLen)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLen)}…`
}

/** Первое предложение описания — идёт в колонку «Описание» списка методов. */
export function firstSentence(raw: string, maxLen = 120): string {
  const text = cleanText(raw, maxLen * 3)
  const m = /^(.+?[.!?])(\s|$)/.exec(text)
  const s = (m?.[1] ?? text).trim()
  return s.length > maxLen ? `${s.slice(0, maxLen - 1).trimEnd()}…` : s
}

export interface ExtractedParam {
  name: string
  in: 'query' | 'body' | 'path' | 'header'
  type: string
  required: boolean
  description: string
}

function schemaType(schema: unknown): string {
  if (typeof schema !== 'object' || schema === null) return 'string'
  const s = schema as Record<string, unknown>
  if (typeof s.type === 'string') {
    if (s.type === 'array') {
      const items = s.items
      const inner = typeof items === 'object' && items !== null ? schemaType(items) : 'any'
      return `${inner}[]`
    }
    return s.type
  }
  if (s.oneOf || s.anyOf) return 'oneOf'
  if (s.allOf) return 'object'
  if (s.properties) return 'object'
  if (s.$ref) return 'object'
  return 'string'
}

/** Собирает параметры операции: path/query/header плюс верхний уровень тела запроса. */
export function extractParams(
  op: Operation,
  pathItem: PathItem,
  resolve: <T>(n: unknown) => T,
): ExtractedParam[] {
  const out: ExtractedParam[] = []
  const seen = new Set<string>()

  const rawParams = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]
  for (const raw of rawParams) {
    const p = resolve<Record<string, unknown>>(raw)
    const name = typeof p?.name === 'string' ? p.name : null
    if (!name || seen.has(name)) continue
    seen.add(name)
    const where = p.in === 'path' || p.in === 'header' || p.in === 'query' ? p.in : 'query'
    out.push({
      name,
      in: where,
      type: schemaType(resolve(p.schema)),
      required: p.required === true || where === 'path',
      description: firstSentence(typeof p.description === 'string' ? p.description : '', 160),
    })
  }

  const body = resolve<Record<string, unknown>>(op.requestBody)
  const bodySchema = resolve<Record<string, unknown>>(
    ((body?.content as Record<string, { schema?: unknown }> | undefined)?.['application/json'])?.schema,
  )
  if (bodySchema && typeof bodySchema === 'object') {
    const props = bodySchema.properties as Record<string, unknown> | undefined
    const required = new Set(Array.isArray(bodySchema.required) ? (bodySchema.required as string[]) : [])
    if (props) {
      for (const [name, rawProp] of Object.entries(props)) {
        if (seen.has(name)) continue
        seen.add(name)
        const prop = resolve<Record<string, unknown>>(rawProp)
        out.push({
          name,
          in: 'body',
          type: schemaType(prop),
          required: required.has(name),
          description: firstSentence(typeof prop?.description === 'string' ? prop.description : '', 160),
        })
      }
    }
  }

  return out
}

export interface ExtractedResponse {
  successStatus: number
  example: unknown | null
  schemaPointer: string | null
  /** Коды ошибок, объявленные в спецификации: из них строится список сценариев. */
  errorStatuses: number[]
}

/** Достаёт пример и схему успешного ответа плюс перечень объявленных ошибок. */
export function extractResponse(op: Operation, resolve: <T>(n: unknown) => T): ExtractedResponse {
  const responses = op.responses ?? {}
  const codes = Object.keys(responses)
    .map((c) => Number.parseInt(c, 10))
    .filter((c) => Number.isFinite(c))

  const successStatus = codes.find((c) => c >= 200 && c < 300) ?? 200
  const errorStatuses = codes.filter((c) => c >= 400).sort((a, b) => a - b)

  const rawSuccess = responses[String(successStatus)]
  const success = resolve<Record<string, unknown>>(rawSuccess)
  const json = (success?.content as Record<string, Record<string, unknown>> | undefined)?.['application/json']

  let example: unknown = null
  let schemaPointer: string | null = null

  if (json) {
    if (json.example !== undefined) {
      example = json.example
    } else if (json.examples && typeof json.examples === 'object') {
      const first = Object.values(json.examples as Record<string, unknown>)[0]
      const unwrapped = resolve<Record<string, unknown>>(first)
      example = unwrapped && 'value' in unwrapped ? unwrapped.value : unwrapped
    }
    // Указатель сохраняем в исходном виде: openapi-sampler сам разрешит его по документу.
    const schemaRef = (json.schema as { $ref?: string } | undefined)?.$ref
    if (typeof schemaRef === 'string') schemaPointer = schemaRef
    else if (json.schema) schemaPointer = 'inline'
  }

  return { successStatus, example, schemaPointer, errorStatuses }
}

/** Каскад: servers операции -> servers пути -> servers документа. Песочницы отсеиваются. */
export function resolveHost(op: Operation, pathItem: PathItem, doc: OpenApiDoc): string | null {
  const candidates = op.servers ?? pathItem.servers ?? doc.servers ?? []
  for (const s of candidates) {
    const url = s?.url
    if (typeof url !== 'string' || url.length === 0) continue
    if (url.includes('sandbox')) continue
    return url.startsWith('//') ? `https:${url}` : url
  }
  return null
}

export function* iterateOperations(
  doc: OpenApiDoc,
): Generator<{ path: string; method: string; op: Operation; pathItem: PathItem }> {
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (op && typeof op === 'object') {
        yield { path, method: method.toUpperCase(), op: op as Operation, pathItem }
      }
    }
  }
}
