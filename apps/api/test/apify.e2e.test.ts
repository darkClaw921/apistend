import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'

/**
 * Мок Apify API v2.
 *
 * Проверяется ровно то, чем Apify отличается от трёх остальных сервисов, — и всё
 * это снято с живых ответов боевого api.apify.com, а не выведено из общих правил:
 *
 *   • Content-Type с charset, как у Битрикс24, а не голый как у Ozon и WB;
 *   • из заголовков лимита есть ТОЛЬКО x-ratelimit-limit — ни остатка, ни сброса;
 *   • сам лимит зависит от эндпоинта: 60 на карточку актора, 400 на запуски;
 *   • идентификатора запроса нет вовсе;
 *   • списковые ответы дублируют конверт data в x-apify-pagination-*;
 *   • CORS у Apify боевой, а не добавленный песочницей;
 *   • «токена не прислали» и «токен не тот» — разные типы ошибки.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let key = ''
let userId = ''

const PASSWORD = 'apistend-apify-e2e-2026'

async function call(
  url: string,
  init: { headers?: Record<string, string>; method?: string; auth?: boolean } = {},
) {
  const auth = init.auth === false ? {} : { authorization: `Bearer ${key}` }
  const response = await api.inject({
    method: (init.method ?? 'GET') as 'GET',
    url,
    headers: { ...auth, ...(init.headers ?? {}) },
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
      login: `apify-${randomBytes(4).toString('hex')}`,
      passwordHash: await hashPassword(PASSWORD),
      name: 'Тест Apify',
      initials: 'ТА',
    },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: {
      userId: user.id,
      name: `apify-${randomBytes(4).toString('hex')}`,
      project: 'e2e',
      latencyMs: 0,
      errorRate: 0,
    },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'ключ Apify',
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

describe('каталог и адресация', () => {
  it('подмена базового адреса: путь мока совпадает с боевым дословно', async () => {
    const res = await call('/apify/v2/actors')
    expect(res.status).toBe(200)
    // Боевой хост из спецификации, а не выдуманный.
    expect(res.headers['x-apistend-upstream']).toBe('https://api.apify.com')
    expect(res.headers['x-apistend-snapshot']).toBe('2026-09-02')
  })

  it('единый префикс /v1/apify/* ведёт к тому же методу', async () => {
    const viaMount = await call('/apify/v2/actors')
    const viaPrefix = await call('/v1/apify/v2/actors')
    expect(viaPrefix.status).toBe(200)
    expect(viaPrefix.body).toEqual(viaMount.body)
  })

  it('несуществующий путь — родной конверт Apify, а не чужой', async () => {
    const res = await call('/apify/v2/this-does-not-exist')
    expect(res.status).toBe(404)
    // {"error":{"type","message"}} — форма из components.schemas.ErrorResponse.
    expect(res.body).toEqual({
      error: { type: 'record-not-found', message: 'The requested resource was not found.' },
    })
  })
})

describe('нативная авторизация', () => {
  it('Authorization: Bearer — основной способ из спецификации', async () => {
    const res = await call('/apify/v2/actors')
    expect(res.status).toBe(200)
  })

  it('token= в адресе — второй способ, объявленный в securitySchemes', async () => {
    const res = await call(`/apify/v2/actors?token=${key}`, { auth: false })
    expect(res.status).toBe(200)
  })

  it('без токена — token-not-provided, а не invalid-token', async () => {
    const res = await call('/apify/v2/actors', { auth: false })
    expect(res.status).toBe(401)
    // Боевой Apify различает эти два случая, и клиент, который по ним отличает
    // «не залогинен» от «ключ протух», в моке обязан увидеть ту же разницу.
    expect((res.body as { error: { type: string } }).error.type).toBe('token-not-provided')
    expect(res.headers['x-apistend-error']).toBe('key-missing')
  })

  it('неизвестный токен — invalid-token', async () => {
    const res = await call('/apify/v2/actors', {
      auth: false,
      headers: { authorization: 'Bearer stend_sk_00000000000000000000000000000000' },
    })
    expect(res.status).toBe(401)
    expect((res.body as { error: { type: string } }).error.type).toBe('invalid-token')
    expect(res.headers['x-apistend-error']).toBe('key-unknown-or-revoked')
  })
})

describe('набор заголовков совпадает с живым ответом api.apify.com', () => {
  it('Content-Type приходит с charset', async () => {
    const res = await call('/apify/v2/actors')
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('из заголовков лимита есть только limit — ни remaining, ни reset', async () => {
    const res = await call('/apify/v2/actors')
    expect(res.headers['x-ratelimit-limit']).toBeDefined()
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined()
    expect(res.headers['x-ratelimit-reset']).toBeUndefined()
  })

  it('идентификатора запроса Apify не отдаёт, а свой APIStend отдаёт всегда', async () => {
    const res = await call('/apify/v2/actors')
    expect(res.headers['x-request-id']).toBeUndefined()
    expect(res.headers['x-o3-trace-id']).toBeUndefined()
    expect(res.headers['x-apistend-request-id']).toMatch(/^req_[0-9a-f]{10}$/)
  })

  it('CORS помечен как боевой: Apify разрешает вызовы из браузера сам', async () => {
    const res = await call('/apify/v2/actors')
    expect(res.headers['x-apistend-cors']).toBe('native')
  })
})

describe('лимит зависит от эндпоинта, а не от сервиса', () => {
  it('карточка актора — базовые 60, как в живом ответе', async () => {
    const res = await call('/apify/v2/acts/apify~instagram-scraper')
    expect(res.headers['x-ratelimit-limit']).toBe('60')
  })

  it('профиль пользователя — 90', async () => {
    const res = await call('/apify/v2/users/me')
    expect(res.headers['x-ratelimit-limit']).toBe('90')
  })

  it('элементы датасета — 400', async () => {
    const res = await call('/apify/v2/datasets/abc123/items')
    expect(res.headers['x-ratelimit-limit']).toBe('400')
  })

  it('записи key-value store — 200', async () => {
    const res = await call('/apify/v2/key-value-stores/abc123/keys')
    expect(res.headers['x-ratelimit-limit']).toBe('200')
  })
})

describe('превышение лимита', () => {
  it('429 в родном конверте, без Retry-After — его Apify не отдаёт', async () => {
    const res = await call('/apify/v2/actors', { headers: { 'x-mock-scenario': 'rate_limit' } })
    expect(res.status).toBe(429)
    expect(res.body).toEqual({
      error: {
        type: 'rate-limit-exceeded',
        message: 'You have exceeded the rate limit. Please try again later.',
      },
    })
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.headers['x-ratelimit-retry']).toBeUndefined()
    // Паузу подсказываем от своего имени: подделывать чужой заголовок нельзя,
    // а оставить клиента без ориентира при 429 — бесполезно.
    expect(res.headers['x-apistend-retry-after']).toBeDefined()
  })
})

describe('заголовки пагинации', () => {
  it('списковый ответ дублирует конверт data в x-apify-pagination-*', async () => {
    const res = await call('/apify/v2/actors')
    const data = (res.body as { data?: Record<string, unknown> }).data
    // Проверяем не наличие само по себе, а СОВПАДЕНИЕ с телом: заголовок,
    // разошедшийся с конвертом, увёл бы листающего клиента в бесконечный цикл.
    if (typeof data?.total === 'number') {
      expect(res.headers['x-apify-pagination-total']).toBe(String(data.total))
      expect(res.headers['x-apify-pagination-limit']).toBe(String(data.limit))
      expect(res.headers['x-apify-pagination-offset']).toBe(String(data.offset))
    } else {
      throw new Error('ожидался списковый конверт data с полем total')
    }
  })

  it('у одиночного объекта полей пагинации нет — значит нет и заголовков', async () => {
    const res = await call('/apify/v2/users/me')
    expect(res.headers['x-apify-pagination-total']).toBeUndefined()
  })
})
