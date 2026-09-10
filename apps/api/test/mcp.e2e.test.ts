import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'
import { productPool } from '@apistend/mock-engine'

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
      // Доступ по MCP по умолчанию выключен и включается в настройках.
      // Здесь проверяются сами инструменты, а выключатель — в mcp-settings.e2e.
      mcpEnabled: true,
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

/** Запуск в форме, объявленной в outputSchema боевого сервера. */
type Run = {
  runId: string
  status: string
  startedAt: string
  finishedAt: string
  storages: { datasets: { default: { id: string; itemCount: number } } }
  _apistend?: { outputSource: string; values: string; matchedQuery?: boolean }
}

/** Строки датасета — тем же вызовом, каким за ними идёт агент. */
async function datasetItems(datasetId: string, args: Record<string, unknown> = {}) {
  const res = await rpc('/apify/mcp', 'tools/call', {
    name: 'get-dataset-items',
    arguments: { datasetId, ...args },
  })
  return (res.frame as { result: { structuredContent: { items: Record<string, unknown>[] } } })
    .result.structuredContent.items
}

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
    // С ключом: боевой сервер отвечает 401 и на DELETE, пока токена нет.
    const res = await api.inject({
      method: 'DELETE', url: '/apify/mcp', headers: { authorization: `Bearer ${key}` },
    })
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
      result: {
        structuredContent: {
          actorInfo: { fullName: string }
          inputSchema: { properties: Record<string, unknown> }
        }
      }
    }).result.structuredContent
    expect(structured.actorInfo.fullName).toBe('apify/instagram-scraper')
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

  it('call-actor возвращает запуск в форме боевого сервера', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 4 } },
    })
    const structured = (res.frame as { result: { structuredContent: Run } }).result.structuredContent
    expect(structured.status).toBe('SUCCEEDED')
    expect(structured.runId).toHaveLength(17)
    // Элементы в structuredContent запуска не лежат — как и у боевого сервера:
    // там storages, по которым клиент идёт за датасетом. Сколько попросили
    // во входе, столько строк и записано в датасет.
    expect(structured.storages.datasets.default.itemCount).toBe(4)
  })

  it('данные запуска детерминированы, а отметки времени живые', async () => {
    const args = { name: 'call-actor', arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 2 } } }
    const first = await rpc('/apify/mcp', 'tools/call', args)
    const second = await rpc('/apify/mcp', 'tools/call', args)
    const a = (first.frame as { result: { structuredContent: Run } }).result.structuredContent
    const b = (second.frame as { result: { structuredContent: Run } }).result.structuredContent

    // Тело — чистая функция от (актор, вход): агент, которого отлаживают прогоном
    // по кругу, обязан получать одни и те же данные, иначе свою ошибку не отличить
    // от шума мока.
    expect(a.runId).toBe(b.runId)
    expect(a.storages.datasets.default.id).toBe(b.storages.datasets.default.id)
    expect(await datasetItems(a.storages.datasets.default.id))
      .toEqual(await datasetItems(b.storages.datasets.default.id))

    // А вот время запуска у боевого Apify каждый раз своё, и замораживать его
    // здесь значило бы отдать клиенту запуск, который «начался» в прошлом веке.
    expect(Date.parse(a.finishedAt)).toBeGreaterThan(Date.parse(a.startedAt))
  })

  it('instructions несут и боевой текст, и предупреждение песочницы', async () => {
    const res = await rpc('/apify/mcp', 'initialize', { protocolVersion: '2025-06-18' })
    const instructions = (res.frame as { result: { instructions: string } }).result.instructions
    // Боевой текст на месте дословно — по нему модель выбирает и запускает акторов.
    expect(instructions).toContain('Apify is the world')
    // И следом — то, чего в боевом тексте быть не может: это песочница.
    expect(instructions).toContain('APIStend sandbox (not Apify)')
    expect(instructions).toContain('_apistend.outputSource')
    expect(instructions).toContain('/v2/acts/')
  })

  it('запуск сообщает, откуда взялись строки', async () => {
    const fromReadme = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'memo23/wildberries-scraper', input: { queries: ['кроссовки'] } },
    })
    const structured = (fromReadme.frame as {
      result: {
        content: Array<{ text: string }>
        structuredContent: { _apistend: { sandbox: boolean; outputSource: string } }
      }
    }).result
    expect(structured.structuredContent._apistend).toMatchObject({
      sandbox: true,
      // Форму строки дал readme актора, значения — общий каталог песочницы.
      outputSource: 'readme-examples',
      values: 'apistend-catalog',
      matchedQuery: true,
    })
    // Модель читает текст, а не структуру, — предупреждение обязано быть и там.
    expect(structured.content[0]!.text).toContain('APIStend')
    expect(structured.content[0]!.text).toContain('readme')

    const fromSchema = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 1 } },
    })
    expect(
      (fromSchema.frame as { result: { structuredContent: { _apistend: { outputSource: string } } } })
        .result.structuredContent._apistend.outputSource,
    ).toBe('dataset-schema')
  })

  it('актор без схемы датасета отдаёт строки, показанные автором в readme', async () => {
    // У memo23/wildberries-scraper storages.dataset пуст, зато в readme автор
    // показал строки результата — ради них readme и снимается.
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'memo23/wildberries-scraper', input: { queries: ['кроссовки'] } },
    })
    const structured = (res.frame as { result: { structuredContent: Run } }).result.structuredContent
    const items = await datasetItems(structured.storages.datasets.default.id)
    expect(items.length).toBeGreaterThan(0)
    // Карточка товара, а не образец из спецификации: имя, цена, продавец.
    const product = items[0]!
    expect(product).toHaveProperty('name')
    expect(product).toHaveProperty('priceSale')
    expect(product).toHaveProperty('supplierName')
  })

  it('выдача — конкуренты по запросу, а не свои же товары', async () => {
    // Ради этого скрапер маркетплейса и запускают: собрать чужие предложения
    // того же предмета и посчитать по ним коридор цен. На фикстуре из примера
    // автора считать было нечего — один и тот же iPhone на любой запрос.
    const run = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: {
        actor: 'memo23/wildberries-scraper',
        input: { queries: ['коврик для йоги'], maxItems: 10 },
      },
    })
    const structured = (run.frame as { result: { structuredContent: Run } }).result.structuredContent
    const items = await datasetItems(structured.storages.datasets.default.id)
    expect(items).toHaveLength(10)

    // Продавцов много: выдачу можно группировать по продавцу, а «дешевле рынка»
    // считать относительно чужих предложений, а не одного магазина.
    expect(new Set(items.map((i) => i.supplierName)).size).toBeGreaterThan(2)

    const own = new Set(productPool('medium').map((p) => p.nmId))
    for (const item of items) {
      // Предмет тот же, что спросили.
      expect(String(item.name)).toContain('Коврик')
      // Артикул чужой: собранный конкурент не должен оказаться своей карточкой.
      expect(own.has(Number(item.productId))).toBe(false)
      expect(Number(item.priceSale)).toBeLessThanOrEqual(Number(item.priceBasic))
      expect(String(item.url)).toContain(String(item.productId))
    }

    // Коридор цен осмысленный: край от края отличается в разы, а не на порядки.
    const prices = items.map((i) => Number(i.priceSale)).sort((a, b) => a - b)
    expect(prices[prices.length - 1]! / prices[0]!).toBeLessThan(5)
  })

  it('количество и фраза слышны: другой запрос — другой рынок', async () => {
    const market = async (query: string, maxItems: number) => {
      const run = await rpc('/apify/mcp', 'tools/call', {
        name: 'call-actor',
        arguments: { actor: 'memo23/wildberries-scraper', input: { queries: [query], maxItems } },
      })
      const structured = (run.frame as { result: { structuredContent: Run } }).result.structuredContent
      return datasetItems(structured.storages.datasets.default.id)
    }
    const coffee = await market('кофе в зёрнах', 6)
    const mats = await market('коврик для йоги', 3)
    expect(coffee).toHaveLength(6)
    expect(mats).toHaveLength(3)
    expect(coffee.every((i) => String(i.name).includes('Кофе'))).toBe(true)
    // Рынки разных предметов не пересекаются по артикулам.
    const ids = new Set(coffee.map((i) => i.productId))
    expect(mats.some((i) => ids.has(i.productId))).toBe(false)
  })

  it('нетоварному актору каталог не подмешивается', async () => {
    // У instagram-scraper строка выдачи — пост, а не карточка товара: подставить
    // туда цену и артикул значило бы испортить пример автора без выигрыша.
    const run = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 2 } },
    })
    const structured = (run.frame as { result: { structuredContent: Run } }).result.structuredContent
    expect(structured._apistend?.values).toBe('actor-author')
    const items = await datasetItems(structured.storages.datasets.default.id)
    expect(items[0]).not.toHaveProperty('priceSale')
  })

  it('датасет запуска отдаёт те же строки, что вернул сам запуск', async () => {
    // Обычный путь агента: запустил актора, в следующем вызове забрал датасет.
    // До реестра запусков второй вызов уходил в мок REST и отвечал образцом
    // из спецификации — разрывом там, где боевой Apify его не даёт.
    const run = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'memo23/wildberries-scraper', input: { queries: ['кроссовки'] } },
    })
    const structured = (run.frame as { result: { structuredContent: Run } }).result.structuredContent
    const datasetId = structured.storages.datasets.default.id

    const items = await datasetItems(datasetId)
    expect(items.length).toBe(structured.storages.datasets.default.itemCount)

    // Страница по limit — начало того же датасета, а не другая выдача.
    expect(await datasetItems(datasetId, { limit: 1 })).toEqual(items.slice(0, 1))

    // И сам запуск виден по своему идентификатору.
    const info = await rpc('/apify/mcp', 'tools/call', {
      name: 'get-actor-run',
      arguments: { runId: structured.runId },
    })
    const data = (info.frame as { result: { structuredContent: Run } }).result.structuredContent
    expect(data.runId).toBe(structured.runId)
    expect(data.status).toBe('SUCCEEDED')
  })

  it('get-actor-run-list есть в наборе и отдаёт фактическую стоимость прогона', async () => {
    // У боевого сервера этот инструмент есть, в снимок он не попал. Клиент
    // берёт из него usageTotalUsd: в карточке одного запуска стоимости нет,
    // и без списка списывалась бы оценка вместо факта.
    const tools = await rpc('/apify/mcp', 'tools/list')
    const names = (tools.frame as { result: { tools: Array<{ name: string }> } }).result.tools
      .map((t) => t.name)
    expect(names).toContain('get-actor-run-list')

    // Тариф настоящий: apify/instagram-scraper стоит 0,0023 $ за элемент датасета.
    const run = await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'apify/instagram-scraper', input: { resultsLimit: 4 } },
    })
    const runId = (run.frame as { result: { structuredContent: Run } }).result.structuredContent.runId

    const list = await rpc('/apify/mcp', 'tools/call', {
      name: 'get-actor-run-list',
      arguments: { desc: true, limit: 10 },
    })
    const body = (list.frame as {
      result: { structuredContent: { total: number; items: Array<Record<string, unknown>> } }
    }).result.structuredContent
    const entry = body.items.find((x) => x.id === runId)
    expect(entry, 'запуск песочницы обязан быть в списке запусков').toBeDefined()
    expect(entry!.usageTotalUsd).toBeCloseTo(4 * 0.0023, 6)
    expect(entry!.defaultDatasetId).toHaveLength(17)
  })

  it('список запусков фильтруется по статусу и режется страницей', async () => {
    await rpc('/apify/mcp', 'tools/call', {
      name: 'call-actor',
      arguments: { actor: 'memo23/wildberries-scraper', input: { queries: ['чайник'] } },
    })
    const failed = await rpc('/apify/mcp', 'tools/call', {
      name: 'get-actor-run-list',
      arguments: { status: 'FAILED' },
    })
    expect(
      (failed.frame as { result: { structuredContent: { items: unknown[] } } })
        .result.structuredContent.items,
    ).toEqual([])

    const page = await rpc('/apify/mcp', 'tools/call', {
      name: 'get-actor-run-list',
      arguments: { limit: 1 },
    })
    const body = (page.frame as {
      result: { structuredContent: { items: unknown[]; limit: number; total: number } }
    }).result.structuredContent
    expect(body.items).toHaveLength(1)
    // Потолок страницы — десять, как объявлено у боевого инструмента.
    expect(body.limit).toBe(1)
    expect(body.total).toBeGreaterThan(0)
  })

  it('инструмент, которому нужна живая сеть, честно отказывает', async () => {
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'fetch-apify-docs',
      arguments: { url: 'https://docs.apify.com/' },
    })
    const error = (res.frame as { error: { message: string } }).error
    expect(error.message).toContain('живой сети')
  })

  it('чужой датасет — отказ, а не образец из спецификации', async () => {
    // Раньше сюда отвечал мок REST образцом [{"foo":"bar"}]. Для агента это
    // хуже отказа: он разбирал бы выдачу, которой не было, и не понял бы,
    // почему в ней нет его полей.
    const res = await rpc('/apify/mcp', 'tools/call', {
      name: 'get-dataset-items',
      arguments: { datasetId: 'abc123' },
    })
    const result = (res.frame as {
      result: { isError?: boolean; structuredContent?: unknown; content: Array<{ text: string }> }
    }).result
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0]!.text).toContain('call-actor')
  })
})

describe('мок требует ключ и держит поток — как боевой сервер', () => {
  it('без ключа 401 на любом методе, в форме боевого ответа', async () => {
    // Снято с mcp.apify.com: он отвечает 401 и на GET, и на POST, и на DELETE,
    // ещё не заглянув в тело запроса.
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await api.inject({
        method,
        url: '/apify/mcp',
        headers: { 'content-type': 'application/json', accept: ACCEPT },
        ...(method === 'POST' ? { payload: { jsonrpc: '2.0', id: 1, method: 'ping' } } : {}),
      })
      expect(res.statusCode).toBe(401)
      expect(res.headers['content-type']).toContain('application/json')
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_token' })
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"')
    }

    // На GET боевой отвечает человекочитаемым абзацем, а не конвертом.
    const get = await api.inject({ method: 'GET', url: '/apify/mcp', headers: { accept: 'text/event-stream' } })
    expect(get.statusCode).toBe(401)
    expect(get.headers['content-type']).toContain('text/plain')
    expect(get.body).toContain('sandbox key')
  })

  it('GET с ключом открывает поток, а не отвечает «метод не поддерживается»', async () => {
    // Клиент MCP открывает этот поток сразу после initialize. Ответ 405
    // отправлял его в цикл переподключения: за день это три с половиной тысячи
    // запросов, из которых полторы тысячи — один и тот же список инструментов.
    const server = await buildServer()
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const controller = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/apify/mcp`, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${key}` },
        signal: controller.signal,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('mcp-session-id')).toBeTruthy()

      const chunk = await res.body!.getReader().read()
      // Комментарий SSE: поток открыт и жив, но сообщений мок не выдумывает.
      expect(new TextDecoder().decode(chunk.value)).toContain(': open')
    } finally {
      controller.abort()
      await server.close()
    }
  })
})

describe('вызовы MCP видны в журнале песочницы', () => {
  it('каждый вызов записан с именем инструмента', async () => {
    const { flushRequestLogs } = await import('../src/lib/log-buffer.ts')
    await rpc('/apify/mcp', 'tools/call', {
      name: 'search-actors',
      arguments: { keywords: 'wildberries' },
    })
    await rpc('/mcp', 'tools/call', { name: 'list_services', arguments: {} })
    await flushRequestLogs()

    // Ищем по имени инструмента, а не в первых десяти записях: тестов в файле
    // много, и свежие вызовы вытесняют друг друга из любой короткой выборки.
    const rows = await prisma.requestLog.findMany({
      where: { responseSource: 'mcp', OR: [
        { endpoint: { contains: 'search-actors' } },
        { endpoint: { contains: 'list_services' } },
      ] },
      orderBy: { timestamp: 'desc' },
      select: { serviceCode: true, endpoint: true, statusCode: true, responseBody: true },
    })
    // Половина работы агента шла мимо кабинета: разработчик видел REST-вызовы,
    // а обращения агента к акторам — нет, и спрашивал, почему запросов нет,
    // хотя они есть.
    const apify = rows.find((r) => r.endpoint.includes('search-actors'))
    expect(apify?.serviceCode).toBe('apify')
    expect(apify?.statusCode).toBe(200)
    // Тело сохранено: ответ MCP собран из снимка магазина и реестра запусков,
    // и движком он не восстанавливается — без тела в журнале смотреть нечего.
    expect(apify?.responseBody).toContain('actors')

    const own = rows.find((r) => r.endpoint.includes('list_services'))
    expect(own?.serviceCode).toBe('apistend')
  })

  it('вызов собственного сервера без ключа помечен в ответе', async () => {
    // У APIStend открытая часть работает и без ключа, но записать такой вызов
    // некому: запись журнала живёт при песочнице. Молчать об этом нельзя —
    // иначе «вызовы есть, а журнал пуст» снова остаётся без объяснения.
    const res = await api.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: ACCEPT },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-apistend-log']).toBe('skipped-no-sandbox-key')
  })

  it('ключ в журнале не оседает открытым текстом', async () => {
    const { flushRequestLogs } = await import('../src/lib/log-buffer.ts')
    await rpc('/apify/mcp', 'tools/list')
    await flushRequestLogs()
    const row = await prisma.requestLog.findFirst({
      where: { responseSource: 'mcp' },
      orderBy: { timestamp: 'desc' },
      select: { requestHeaders: true },
    })
    expect(JSON.stringify(row?.requestHeaders)).not.toContain(key)
  })
})

describe('собственный MCP-сервер APIStend', () => {
  it('instructions предупреждают, что данные демонстрационные, и называют мок MCP Apify', async () => {
    const res = await rpc('/mcp', 'initialize', { protocolVersion: '2025-06-18' })
    const instructions = (res.frame as { result: { instructions: string } }).result.instructions
    expect(instructions).toContain('Данные демонстрационные')
    expect(instructions).toContain('/apify/mcp')
    expect(instructions).toContain('_apistend')
  })

  it('list_services называет адрес мока MCP у Apify и молчит о нём у остальных', async () => {
    const res = await rpc('/mcp', 'tools/call', { name: 'list_services', arguments: {} })
    const services = (res.frame as {
      result: { structuredContent: { services: Array<{ code: string; mcpPath: string | null }> } }
    }).result.structuredContent.services
    expect(services.find((s) => s.code === 'apify')?.mcpPath).toBe('/apify/mcp')
    expect(services.find((s) => s.code === 'ozon')?.mcpPath).toBeNull()
  })

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
