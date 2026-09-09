import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'

/**
 * Заголовки ответа мок-шлюза.
 *
 * Обещание продукта — «поменял базовый адрес, и рабочая интеграция продолжила
 * работать». Тело ответа этому давно удовлетворяет, а вот заголовки клиентская
 * библиотека читает молча: по ним она считает остаток лимита, кладёт в лог
 * идентификатор запроса, решает, разбирать ли тело как JSON. Поэтому здесь
 * проверяется не «есть ли заголовки», а совпадение НАБОРА с боевым:
 * лишний чужой заголовок так же неверен, как отсутствующий свой.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let key = ''
let userId = ''

const PASSWORD = 'apistend-headers-e2e-2026'

async function callGateway(url: string, headers: Record<string, string> = {}) {
  const response = await api.inject({
    method: 'GET',
    url,
    headers: { 'x-mock-key': key, ...headers },
  })
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, string | undefined>,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : null,
  }
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const user = await prisma.user.create({
    data: {
      login: `headers-${randomBytes(4).toString('hex')}`,
      passwordHash: await hashPassword(PASSWORD),
      name: 'Тест заголовков',
      initials: 'ТЗ',
    },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: {
      userId: user.id,
      name: `headers-${randomBytes(4).toString('hex')}`,
      project: 'e2e',
      // Иначе песочница подмешивает 5 % случайных ошибок, и тест мигает.
      latencyMs: 0,
      errorRate: 0,
    },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'ключ заголовков',
      kind: 'server',
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: ['bitrix24', 'ozon', 'wildberries'],
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

describe('набор заголовков совпадает с боевым сервисом', () => {
  it('Wildberries: голый application/json, X-Request-Id и X-Ratelimit-*', async () => {
    const res = await callGateway('/wb/api/v3/warehouses')
    expect(res.status).toBe(200)

    // Без charset: именно так отвечает боевой WB.
    expect(res.headers['content-type']).toBe('application/json')
    // Спецификация WB называет поле requestId в теле ошибки дубликатом этого
    // заголовка, а пример значения — 32 шестнадцатеричных знака.
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{32}$/)
    expect(Number(res.headers['x-ratelimit-limit'])).toBeGreaterThan(0)
    expect(res.headers['x-ratelimit-remaining']).toBeDefined()
    expect(res.headers['x-ratelimit-reset']).toBeDefined()
    // Чужой заголовок соседнего сервиса появляться не должен.
    expect(res.headers['x-o3-trace-id']).toBeUndefined()
  })

  it('Ozon: x-o3-trace-id и никаких заголовков лимита', async () => {
    const res = await callGateway('/oz/v1/actions')
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.headers['x-o3-trace-id']).toMatch(/^[0-9a-f]{16}$/)
    // Ozon документирует сам лимит, но не заголовки с остатком: приписывать их —
    // учить клиента читать то, чего в бою не будет.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined()
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined()
    expect(res.headers['x-request-id']).toBeUndefined()
  })

  it('Битрикс24: charset в Content-Type, ни идентификатора запроса, ни лимитов', async () => {
    const res = await callGateway('/b24/rest/crm.deal.list')
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.headers['x-request-id']).toBeUndefined()
    expect(res.headers['x-o3-trace-id']).toBeUndefined()
    expect(res.headers['x-ratelimit-limit']).toBeUndefined()
  })

  it('собственный идентификатор APIStend есть всегда, и по нему запрос ищется в журнале', async () => {
    const res = await callGateway('/b24/rest/crm.deal.list')
    const own = res.headers['x-apistend-request-id']
    expect(own).toBeTruthy()

    // У WB и Ozon боевой заголовок несёт то же самое значение: разработчик
    // приносит в поддержку то число, которое увидела его библиотека.
    const wb = await callGateway('/wb/api/v3/warehouses')
    expect(wb.headers['x-apistend-request-id']).toBe(wb.headers['x-request-id'])

    const oz = await callGateway('/oz/v1/actions')
    expect(oz.headers['x-apistend-request-id']).toBe(oz.headers['x-o3-trace-id'])
  })
})

describe('лимит выглядит так же, как в бою', () => {
  it('WB: 429 с X-Ratelimit-Retry и нулевым остатком', async () => {
    const res = await callGateway('/wb/api/v3/warehouses', { 'x-mock-scenario': 'rate_limit' })
    expect(res.status).toBe(429)
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
    expect(Number(res.headers['x-ratelimit-retry'])).toBeGreaterThan(0)
    // Тело — родной конверт WB, и requestId в нём совпадает с заголовком.
    expect(res.body?.requestId).toBe(res.headers['x-request-id'])
  })

  it('Ozon: 429 без выдуманного Retry-After, пауза — в заголовке APIStend', async () => {
    const res = await callGateway('/oz/v1/actions', { 'x-mock-scenario': 'rate_limit' })
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(Number(res.headers['x-apistend-retry-after'])).toBeGreaterThan(0)
  })

  it('Битрикс24: 503 QUERY_LIMIT_EXCEEDED, а не 429', async () => {
    const res = await callGateway('/b24/rest/crm.deal.list', { 'x-mock-scenario': 'rate_limit' })
    expect(res.status).toBe(503)
    expect(res.body?.error).toBe('QUERY_LIMIT_EXCEEDED')
  })
})

describe('конверт time Битрикс24', () => {
  it('приходит с каждым успешным ответом и описывает этот вызов', async () => {
    // bitrix24-php-sdk и другие библиотеки разбирают time как обязательное поле:
    // без него интеграция, работавшая в бою, падала бы на разборе ответа мока.
    const res = await callGateway('/b24/rest/crm.deal.list')
    const time = res.body?.time as Record<string, number> | undefined
    expect(time).toBeDefined()
    expect(time!.duration).toBeGreaterThanOrEqual(0)
    // Заголовков лимита у Битрикс24 нет — остаток ресурсоёмкости живёт здесь.
    expect(time!.operating_reset_at).toBeGreaterThan(0)
    expect(new Date(String(time!.date_start)).getTime()).toBeGreaterThan(0)
  })

  it('время каждого вызова своё, а не переписанное из примера документации', async () => {
    const first = await callGateway('/b24/rest/crm.deal.list')
    const second = await callGateway('/b24/rest/crm.deal.list')
    const a = (first.body?.time as Record<string, number>).start
    const b = (second.body?.time as Record<string, number>).start
    expect(b).toBeGreaterThanOrEqual(a)
    // При этом само тело осталось детерминированным — кеш движка не сломан.
    expect({ ...first.body, time: null }).toEqual({ ...second.body, time: null })
  })
})
