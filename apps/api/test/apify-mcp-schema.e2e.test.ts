import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'

/**
 * Ответ каждого инструмента против его СОБСТВЕННОЙ объявленной схемы.
 *
 * Проверка нужна отдельным файлом, потому что ломается тихо и целиком. Клиент
 * на официальном MCP SDK валидирует structuredContent по outputSchema, которую
 * сервер сам же отдал в tools/list, и при расхождении отбрасывает ответ —
 * вызывающий код получает ошибку «Structured content does not match the tool's
 * output schema», хотя данные в ответе есть. Ни один тест «по смыслу» этого не
 * ловит: тело правильное, форма — нет.
 *
 * Схемы берутся из того же снимка, что уходит клиенту, а не переписываются
 * здесь: сверять ответ с копией объявления бессмысленно, если копия своя.
 */

const here = dirname(fileURLToPath(import.meta.url))
const vendored = JSON.parse(
  readFileSync(join(here, '../../../specs/apify/mcp-tools.json'), 'utf8'),
) as { tools: Array<{ name: string; outputSchema?: Record<string, unknown> }> }

/**
 * Спецификация REST того же Apify.
 *
 * Список запусков отдаёт записи в форме RunShort, и проверять их надо по ней:
 * своя копия формы разошлась бы с боевой ровно там, где это важнее всего, —
 * в поле фактической стоимости.
 */
const openapi = JSON.parse(
  readFileSync(join(here, '../../../specs/apify/openapi.json'), 'utf8'),
) as Record<string, unknown>

const ACCEPT = 'application/json, text/event-stream'
let api: Awaited<ReturnType<typeof buildServer>>
let key = ''
let userId = ''

// strict выключен: схемы сняты с боевого сервера как есть, и придираться к их
// оформлению не наша задача — наша задача им соответствовать.
const ajv = new Ajv({ strict: false, allErrors: true })
ajv.addSchema(openapi, 'apify-openapi')

interface Frame {
  result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> }
  error?: { message: string }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Frame> {
  const response = await api.inject({
    method: 'POST',
    url: '/apify/mcp',
    headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${key}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  const line = response.body.split('\n').find((l) => l.startsWith('data: '))
  if (!line) throw new Error(`в ответе нет кадра data:\n${response.body}`)
  return JSON.parse(line.slice(6)) as Frame
}

/** Проверяет ответ инструмента по его объявленной схеме и объясняет расхождение. */
function expectMatchesSchema(toolName: string, structured: unknown): void {
  const schema = vendored.tools.find((t) => t.name === toolName)?.outputSchema
  expect(schema, `у инструмента ${toolName} нет объявленной outputSchema`).toBeDefined()
  const validate = ajv.compile(schema!)
  const ok = validate(structured)
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ')
  expect(ok, `${toolName}: ответ не соответствует своей outputSchema — ${errors}`).toBe(true)
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const user = await prisma.user.create({
    data: {
      login: `apify-schema-${randomBytes(4).toString('hex')}`,
      passwordHash: await hashPassword('apistend-apify-schema-2026'),
      name: 'Тест схем MCP',
      initials: 'ТС',
    },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: {
      userId: user.id,
      name: `apify-schema-${randomBytes(4).toString('hex')}`,
      project: 'e2e',
      latencyMs: 0,
      errorRate: 0,
    },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'ключ схем',
      kind: 'server',
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: ['apify'],
      scopes: [],
      status: 'active',
    },
  })
  key = generated.full
  invalidateKeyCache()
  resetRateLimits()
})

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
  await api.close()
})

describe('ответы мока совпадают с объявленными outputSchema', () => {
  it('search-actors', async () => {
    const frame = await callTool('search-actors', { keywords: 'wildberries', limit: 3 })
    expectMatchesSchema('search-actors', frame.result?.structuredContent)
  })

  it('fetch-actor-details', async () => {
    const frame = await callTool('fetch-actor-details', { actor: 'memo23/wildberries-scraper' })
    expectMatchesSchema('fetch-actor-details', frame.result?.structuredContent)
  })

  it('call-actor, get-actor-run, get-dataset-items и abort-actor-run — вся цепочка запуска', async () => {
    const run = await callTool('call-actor', {
      actor: 'memo23/wildberries-scraper',
      input: { queries: ['кроссовки'] },
    })
    const structured = run.result?.structuredContent as {
      runId: string
      storages: { datasets: { default: { id: string } } }
    }
    expectMatchesSchema('call-actor', structured)

    // Идентификатор датасета клиент берёт именно из storages.datasets.default.id.
    const datasetId = structured.storages.datasets.default.id
    expect(datasetId).toHaveLength(17)

    const items = await callTool('get-dataset-items', { datasetId })
    expectMatchesSchema('get-dataset-items', items.result?.structuredContent)

    const info = await callTool('get-actor-run', { runId: structured.runId })
    expectMatchesSchema('get-actor-run', info.result?.structuredContent)

    const aborted = await callTool('abort-actor-run', { runId: structured.runId })
    expectMatchesSchema('abort-actor-run', aborted.result?.structuredContent)
  })

  it('get-key-value-store-record', async () => {
    const frame = await callTool('get-key-value-store-record', {
      keyValueStoreId: 'abc123',
      recordKey: 'INPUT',
    })
    expectMatchesSchema('get-key-value-store-record', frame.result?.structuredContent)
  })

  it('report-problem', async () => {
    const frame = await callTool('report-problem', { message: 'мок вернул не то' })
    expectMatchesSchema('report-problem', frame.result?.structuredContent)
  })

  it('get-actor-run-list отдаёт записи в форме RunShort из спецификации Apify', async () => {
    await callTool('call-actor', { actor: 'apify/instagram-scraper', input: { resultsLimit: 4 } })
    const list = await callTool('get-actor-run-list', { desc: true, limit: 5 })
    const body = list.result?.structuredContent as { items: Record<string, unknown>[] }
    expect(body.items.length).toBeGreaterThan(0)

    const validate = ajv.compile({ $ref: 'apify-openapi#/components/schemas/RunShort' })
    for (const item of body.items) {
      const ok = validate(item)
      const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
      expect(ok, `запись списка не соответствует RunShort — ${errors}`).toBe(true)
    }
  })

  it('отказ приходит без structuredContent, а не с конвертом чужой формы', async () => {
    // Схемы на неудачу не существует, и структура в отказе была бы отброшена
    // клиентом вместе с текстом, который ему как раз и нужно прочитать.
    const unknownActor = await callTool('call-actor', { actor: 'нет/такого', input: {} })
    expect(unknownActor.result?.isError).toBe(true)
    expect(unknownActor.result?.structuredContent).toBeUndefined()
    expect(unknownActor.result?.content?.[0]?.text).toContain('not found')

    const alienDataset = await callTool('get-dataset-items', { datasetId: 'notFromSandbox' })
    expect(alienDataset.result?.isError).toBe(true)
    expect(alienDataset.result?.structuredContent).toBeUndefined()
  })
})
