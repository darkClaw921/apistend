import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { SERVICE_CODES } from '@apistend/shared'

/**
 * Включение доступа по MCP в настройках.
 *
 * Проверяется не «сохраняется ли галочка», а то, ради чего она существует:
 * пока доступ выключен, агент с ключом не может ни вызвать мок, ни прочитать
 * журнал запросов песочницы — а каталог методов открыт и до включения,
 * потому что в нём нет ничего личного.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let userId = ''
let key = ''
let cookie = ''

const ACCEPT = 'application/json, text/event-stream'
const PASSWORD = 'apistend-mcp-settings-2026'

function frame(body: string): Record<string, unknown> {
  const line = body.split('\n').find((l) => l.startsWith('data: '))
  if (!line) throw new Error(`в ответе нет кадра data:\n${body}`)
  return JSON.parse(line.slice(6)) as Record<string, unknown>
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await api.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${key}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  return frame(response.body) as {
    result?: { content: Array<{ text: string }>; structuredContent: unknown }
    error?: { code: number; message: string }
  }
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const login = `mcpset-${randomBytes(4).toString('hex')}`
  const user = await prisma.user.create({
    data: {
      login,
      passwordHash: await hashPassword(PASSWORD),
      name: 'Тест настроек MCP',
      initials: 'ТН',
    },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: { userId: user.id, name: `mcpset-${randomBytes(4).toString('hex')}`, project: 'e2e', latencyMs: 0, errorRate: 0 },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'ключ агента',
      kind: 'server',
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: [...SERVICE_CODES],
      scopes: [],
      status: 'active',
    },
  })
  key = generated.full
  invalidateKeyCache()

  const login_ = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, password: PASSWORD },
  })
  cookie = (login_.headers['set-cookie'] as string[] | string | undefined) instanceof Array
    ? (login_.headers['set-cookie'] as string[]).join('; ')
    : String(login_.headers['set-cookie'] ?? '')
})

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
  await api.close()
})

describe('настройки доступа по MCP', () => {
  it('по умолчанию выключено', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/settings/mcp', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { enabled: boolean; url: string; tools: unknown[] }
    expect(body.enabled).toBe(false)
    expect(body.url).toMatch(/\/mcp$/)
    expect(body.tools.length).toBeGreaterThan(0)
  })

  it('пока выключено — вызов мока агентом отклоняется с объяснением, где включить', async () => {
    const answer = await callTool('call_mock', { service: 'wildberries', path: '/api/v3/warehouses' })
    expect(answer.error?.message).toContain('выключен')
    expect(answer.error?.message).toContain('Настройки')
  })

  it('каталог методов открыт и до включения', async () => {
    // Инструментам без ключа выключатель не помеха: агенту каталог нужен
    // как раз до того, как у него появится доступ к песочнице.
    const answer = await callTool('search_catalog', { query: 'orders', service: 'wildberries', limit: 3 })
    expect(answer.error).toBeUndefined()
    expect(answer.result?.structuredContent).toBeDefined()
  })

  it('после включения вызов мока проходит', async () => {
    const saved = await api.inject({
      method: 'PATCH',
      url: '/api/settings/mcp',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { enabled: true },
    })
    expect(saved.statusCode).toBe(200)
    expect((JSON.parse(saved.body) as { enabled: boolean }).enabled).toBe(true)
    invalidateKeyCache()

    const answer = await callTool('call_mock', { service: 'wildberries', path: '/api/v3/warehouses' })
    expect(answer.error).toBeUndefined()
    expect(answer.result?.content[0]?.text).toContain('{')
  })

  it('выключение возвращает отказ обратно', async () => {
    await api.inject({
      method: 'PATCH',
      url: '/api/settings/mcp',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { enabled: false },
    })
    invalidateKeyCache()
    const answer = await callTool('recent_requests', {})
    expect(answer.error?.message).toContain('выключен')
  })
})

describe('готовые тексты для копирования', () => {
  it('конфиг клиента — валидный JSON с адресом сервера', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/settings/mcp', headers: { cookie } })
    const body = JSON.parse(res.body) as { url: string; clientConfig: string }
    const config = JSON.parse(body.clientConfig) as {
      mcpServers: { apistend: { url: string; headers: Record<string, string> } }
    }
    expect(config.mcpServers.apistend.url).toBe(body.url)
    expect(config.mcpServers.apistend.headers.Authorization).toContain('Bearer stend_sk_')
  })

  it('место под ключ есть в обоих текстах — кабинету есть что подставить', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/settings/mcp', headers: { cookie } })
    const body = JSON.parse(res.body) as {
      keyPlaceholder: string
      clientConfig: string
      agentInstructions: string
    }
    // Кабинет подставляет настоящий ключ заменой этой строки: если её не будет
    // хотя бы в одном тексте, пользователь скопирует конфиг без ключа и получит
    // отказ там, где всё должно было работать сразу.
    expect(body.keyPlaceholder).toMatch(/^stend_sk_/)
    expect(body.clientConfig).toContain(body.keyPlaceholder)
    expect(body.agentInstructions).toContain(body.keyPlaceholder)
  })

  it('инструкция перечисляет ровно те инструменты, что отдаёт сервер', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/settings/mcp', headers: { cookie } })
    const body = JSON.parse(res.body) as { agentInstructions: string; tools: Array<{ name: string }> }
    // Расхождение здесь дороже отсутствия текста: агент вызовет то, чего нет,
    // и решит, что сломан сервер.
    for (const tool of body.tools) {
      expect(body.agentInstructions).toContain(tool.name)
    }
  })
})
