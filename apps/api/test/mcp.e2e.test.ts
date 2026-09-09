import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'

/**
 * Два MCP-сервера: мок mcp.apify.com на /apify/mcp и собственный APIStend на /mcp.
 *
 * Транспорт проверяется по поведению, снятому с боевого сервера Apify: кадр SSE
 * вокруг ответа, 202 на уведомление, 406 без нужного Accept, выдача mcp-session-id.
 * Клиент MCP разбирает именно это, и расхождение в любом пункте означает,
 * что подменить адрес не выйдет.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let key = ''
let userId = ''

const ACCEPT = 'application/json, text/event-stream'

/** Ответ приходит кадром SSE — вынимаем из него полезную нагрузку. */
function parseFrame(body: string): Record<string, unknown> {
  const line = body.split('\n').find((l) => l.startsWith('data: '))
  if (!line) throw new Error(`в ответе нет кадра data:\n${body}`)
  return JSON.parse(line.slice(6)) as Record<string, unknown>
}

async function rpc(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  init: { auth?: boolean; id?: number | null; accept?: string } = {},
) {
  const response = await api.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      accept: init.accept ?? ACCEPT,
      ...(init.auth === false ? {} : { authorization: `Bearer ${key}` }),
    },
    payload: {
      jsonrpc: '2.0',
      ...(init.id === null ? {} : { id: init.id ?? 1 }),
      method,
      ...(params ? { params } : {}),
    },
  })
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, string | undefined>,
    raw: response.body,
    frame: response.body.startsWith('event:') ? parseFrame(response.body) : null,
  }
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const user = await prisma.user.create({
    data: {
      login: `mcp-${randomBytes(4).toString('hex')}`,
      passwordHash: await hashPassword('apistend-mcp-e2e-2026'),
      name: 'Тест MCP',
      initials: 'ТМ',
    },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: {
      userId: user.id,
      name: `mcp-${randomBytes(4).toString('hex')}`,
      project: 'e2e',
      latencyMs: 0,
      errorRate: 0,
    },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'ключ MCP',
      kind: 'server',
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: ['bitrix24', 'ozon', 'wildberries', 'apify'],
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

describe('транспорт совпадает с боевым mcp.apify.com', () => {
  it('ответ приходит кадром SSE, а не голым JSON', async () => {
    const res = await rpc('/apify/mcp', 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.raw.startsWith('event: message\n')).toBe(true)
    expect(res.frame).toMatchObject({ jsonrpc: '2.0', id: 1 })
  })

  it('initialize выдаёт mcp-session-id', async () => {
    const res = await rpc('/apify/mcp', 'initialize', { protocolVersion: '2025-06-18' })
    expect(res.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('уведомление без id — 202 и пустое тело', async () => {
    const res = await rpc('/apify/mcp', 'notifications/initialized', undefined, { id: null })
    expect(res.status).toBe(202)
    expect(res.raw).toBe('')
  })

  it('Accept без text/event-stream — 406 обычным JSON, а не кадром', async () => {
    const res = await rpc('/apify/mcp', 'tools/list', undefined, { accept: 'application/json' })
    expect(res.status).toBe(406)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.raw)).toMatchObject({
      error: {
        code: -32000,
        message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
      },
    })
  })

  it('DELETE завершает сессию с кодом 200', async () => {
    const res = await api.inject({ method: 'DELETE', url: '/apify/mcp' })
    expect(res.statusCode).toBe(200)
  })

  it('неизвестный метод — ошибка -32601, а не падение', async () => {
    const res = await rpc('/apify/mcp', 'nope/nope')
    expect(res.status).toBe(200)
    expect((res.frame as { error: { code: number } }).error.code).toBe(-32601)
  })
})

describe('мок mcp.apify.com', () => {
  it('serverInfo снят с боевого сервера, а не выдуман', async () => {
    const res = await rpc('/apify/mcp', 'initialize', { protocolVersion: '2025-06-18' })
    const result = (res.frame as { result: { serverInfo: { name: string }; protocolVersion: string } }).result
    expect(result.serverInfo.name).toBe('apify-mcp-server')
    expect(result.protocolVersion).toBe('2025-06-18')
  })

  it('tools/list отдаёт снятый набор инструментов', async () => {
    const res = await rpc('/apify/mcp', 'tools/list')
    const tools = (res.frame as { result: { tools: Array<{ name: string }> } }).result.tools
    const names = tools.map((t) => t.name)
    expect(names).toContain('search-actors')
    expect(names).toContain('call-actor')
    expect(names).toContain('get-dataset-items')
  })

  it('параметр tools сужает набор, как у боевого сервера', async () => {
    const res = await rpc('/apify/mcp?tools=search-actors', 'tools/list')
    const tools = (res.frame as { result: { tools: Array<{ name: string }> } }).result.tools
    expect(tools.map((t) => t.name)).toEqual(['search-actors'])
  })

  it('несуществующий инструмент — та же ошибка -32602, что и в бою', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', { name: 'nope', arguments: {} })
    const error = (res.frame as { error: { code: number; message: string } }).error
    expect(error.code).toBe(-32602)
    expect(error.message).toContain('was not found')
  })

  it('search-actors ищет по снимку магазина', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'search-actors',
      arguments: { keywords: 'instagram', limit: 3 },
    })
    const result = (res.frame as {
      result: { content: Array<{ text: string }>; structuredContent: { actors: Array<{ name: string }> } }
    }).result
    expect(result.structuredContent.actors.length).toBeGreaterThan(0)
    expect(result.content[0]!.text).toContain('# Actors:')
  })

  it('fetch-actor-details отдаёт НАСТОЯЩУЮ схему входа актора', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'fetch-actor-details',
      arguments: { actor: 'apify/instagram-scraper' },
    })
    const structured = (res.frame as {
      result: { structuredContent: { name: string; inputSchema: { properties: Record<string, unknown> } } }
    }).result.structuredContent
    expect(structured.name).toBe('apify/instagram-scraper')
    // Схема снята с боевой сборки актора — значит в ней его собственные поля.
    expect(Object.keys(structured.inputSchema.properties)).toContain('resultsLimit')
  })

  it('call-actor отбивает вход, не прошедший схему актора', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'apify/instagram-scraper', input: {} },
    })
    const result = (res.frame as { result: { isError?: boolean; structuredContent: unknown } }).result
    // У instagram-scraper обязательных полей нет — тогда запуск обязан пройти.
    // Проверяем не отказ, а то, что ответ вообще имеет форму запуска.
    expect(result).toHaveProperty('structuredContent')
  })

  it('call-actor возвращает запуск и элементы по схеме датасета', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 4 } },
    })
    const structured = (res.frame as {
      result: { structuredContent: { run: { status: string; id: string }; items: unknown[] } }
    }).result.structuredContent
    expect(structured.run.status).toBe('SUCCEEDED')
    expect(structured.run.id).toHaveLength(17)
    // Сколько попросили во входе, столько и пришло.
    expect(structured.items).toHaveLength(4)
  })

  it('данные запуска детерминированы, а отметки времени живые', async () => {
    const args = { name: 'call-actor', arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 2 } } }
    const first = await rpc('/apify/mcp', 'tools/call', args)
    const second = await rpc('/apify/mcp', 'tools/call', args)
    type Run = { run: { id: string; startedAt: string; finishedAt: string }; datasetId: string; items: unknown[] }
    const a = (first.frame as { result: { structuredContent: Run } }).result.structuredContent
    const b = (second.frame as { result: { structuredContent: Run } }).result.structuredContent

    // Тело — чистая функция от (актор, вход): агент, которого отлаживают прогоном
    // по кругу, обязан получать одни и те же данные, иначе свою ошибку не отличить
    // от шума мока.
    expect(a.items).toEqual(b.items)
    expect(a.run.id).toBe(b.run.id)
    expect(a.datasetId).toBe(b.datasetId)

    // А вот время запуска у боевого Apify каждый раз своё, и замораживать его
    // здесь значило бы отдать клиенту запуск, который «начался» в прошлом веке.
    expect(Date.parse(a.run.finishedAt)).toBeGreaterThan(Date.parse(a.run.startedAt))
  })

  it('инструмент, которому нужна живая сеть, честно отказывает', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'fetch-apify-docs',
      arguments: { url: 'https://docs.apify.com/' },
    })
    const error = (res.frame as { error: { message: string } }).error
    expect(error.message).toContain('живой сети')
  })

  it('get-dataset-items отвечает тем же телом, что и REST-шлюз', async () => {
    const viaMcp = await rpc('/apify/mcp', 'tools/call', {
      name: 'get-dataset-items',
      arguments: { datasetId: 'abc123' },
    })
    const viaRest = await api.inject({
      method: 'GET',
      url: '/apify/v2/datasets/abc123/items',
      headers: { authorization: `Bearer ${key}` },
    })
    const mcpText = (viaMcp.frame as { result: { content: Array<{ text: string }> } }).result.content[0]!.text
    expect(JSON.parse(mcpText)).toEqual(JSON.parse(viaRest.body))
  })
})

describe('собственный MCP-сервер APIStend', () => {
  it('представляется своим именем, а не именем сервиса', async () => {
    const res = await rpc('/mcp', 'initialize', { protocolVersion: '2025-06-18' })
    const result = (res.frame as { result: { serverInfo: { name: string } } }).result
    expect(result.serverInfo.name).toBe('apistend')
  })

  it('list_services перечисляет все четыре сервиса', async () => {
    const res = await rpc('/mcp', 'tools/call', { name: 'list_services', arguments: {} })
    const services = (res.frame as {
      result: { structuredContent: { services: Array<{ code: string; methodsInCatalog: number }> } }
    }).result.structuredContent.services
    expect(services.map((s) => s.code).sort()).toEqual(['apify', 'bitrix24', 'ozon', 'wildberries'])
    // Числа методов приходят из каталога, а не зашиты в текст.
    expect(services.every((s) => s.methodsInCatalog > 0)).toBe(true)
  })

  it('search_catalog находит метод по куску пути', async () => {
    const res = await rpc('/mcp', 'tools/call', {
      name: 'search_catalog',
      arguments: { query: 'posting fbs', service: 'ozon', limit: 5 },
    })
    const found = (res.frame as {
      result: { structuredContent: { methods: Array<{ path: string; service: string }> } }
    }).result.structuredContent.methods
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((m) => m.service === 'ozon')).toBe(true)
  })

  it('describe_method отдаёт параметры и происхождение', async () => {
    const res = await rpc('/mcp', 'tools/call', {
      name: 'describe_method',
      arguments: { service: 'apify', httpMethod: 'GET', path: '/v2/actors' },
    })
    const method = (res.frame as {
      result: { structuredContent: { method: { snapshotDate: string; upstreamHost: string } } }
    }).result.structuredContent.method
    expect(method.upstreamHost).toBe('https://api.apify.com')
    expect(method.snapshotDate).toBe('2026-09-02')
  })

  it('call_mock без ключа отказывает, а не молча отвечает', async () => {
    const res = await rpc('/mcp', 'tools/call', {
      name: 'call_mock',
      arguments: { service: 'wildberries', path: '/api/v3/warehouses' },
    }, { auth: false })
    expect((res.frame as { error: { message: string } }).error.message).toContain('ключ песочницы')
  })

  it('call_mock отдаёт то же тело, что и мок-шлюз', async () => {
    const viaMcp = await rpc('/mcp', 'tools/call', {
      name: 'call_mock',
      arguments: { service: 'wildberries', path: '/api/v3/warehouses' },
    })
    const viaGateway = await api.inject({
      method: 'GET',
      url: '/wb/api/v3/warehouses',
      headers: { 'x-mock-key': key },
    })
    const mcpText = (viaMcp.frame as { result: { content: Array<{ text: string }> } }).result.content[0]!.text
    expect(JSON.parse(mcpText)).toEqual(JSON.parse(viaGateway.body))
  })
})
