import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'

/**
 * Инъекция случайных сбоев: выключена по умолчанию, опознаваема, когда включена.
 *
 * Доля ошибок — полезная настройка: включив её, разработчик проверяет, как его
 * код переживает 500. Включённой по умолчанию она делает обратное: стенд отдаёт
 * ошибку примерно на каждом двадцатом вызове, разработчик считает это
 * нестабильностью мока, обкладывает вызовы повторами и уносит их в бой — а там
 * каждый повтор стоит настоящего окна лимита.
 *
 * Поэтому здесь два требования разом: без настройки сбоев нет вовсе, а с
 * настройкой они помечены заголовком, по которому видно, что это стенд, а не
 * сломавшийся мок.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let userId = ''
let quietKey = ''
let noisyKey = ''
let noisySandboxId = ''

const PASSWORD = 'apistend-error-rate-2026'

async function sandboxWithKey(userIdValue: string, errorRate: number) {
  const sandbox = await prisma.sandbox.create({
    data: {
      userId: userIdValue,
      name: `err-${randomBytes(4).toString('hex')}`,
      project: 'e2e',
      latencyMs: 0,
      errorRate,
    },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: `ключ ${errorRate}%`,
      kind: 'server',
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: ['wildberries', 'apify'],
      scopes: [],
      status: 'active',
    },
  })
  return { sandbox, key: generated.full }
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const user = await prisma.user.create({
    data: {
      login: `err-${randomBytes(4).toString('hex')}`,
      passwordHash: await hashPassword(PASSWORD),
      name: 'Тест сбоев',
      initials: 'ТС',
    },
  })
  userId = user.id
  quietKey = (await sandboxWithKey(user.id, 0)).key
  const noisy = await sandboxWithKey(user.id, 50)
  noisyKey = noisy.key
  noisySandboxId = noisy.sandbox.id
  invalidateKeyCache()
  resetRateLimits()
})

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
  await api.close()
})

async function call(url: string, key: string) {
  return api.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } })
}

describe('без настройки сбоев их не бывает', () => {
  it('сто вызовов подряд отвечают успехом, а не «изредка 500»', async () => {
    const codes = new Set<number>()
    for (let i = 0; i < 100; i++) {
      // Лимит сбрасывается: проверяется инъекция сбоев, а не ведро запросов —
      // упереться в 429 на сотне вызовов подряд было бы правильным поведением.
      if (i % 20 === 0) resetRateLimits()
      codes.add((await call('/apify/v2/users/me/limits', quietKey)).statusCode)
    }
    // Ровно та жалоба, ради которой это проверяется: «на двенадцати одинаковых
    // запросах одна ошибка». Клиент ретраит, и на боевом сервисе каждый повтор
    // стоит окна лимита.
    expect([...codes]).toEqual([200])
  })

  it('аналитика Wildberries тоже отвечает без сбоев', async () => {
    const codes = new Set<number>()
    for (let i = 0; i < 40; i++) {
      if (i % 10 === 0) resetRateLimits()
      const res = await api.inject({
        method: 'POST',
        url: '/wb/api/analytics/v3/sales-funnel/products',
        headers: { authorization: `Bearer ${quietKey}` },
        payload: { currentPeriod: { start: '2026-08-01', end: '2026-09-01' } },
      })
      codes.add(res.statusCode)
    }
    expect([...codes]).toEqual([200])
  })

  it('новая песочница заводится без инъекции сбоев', async () => {
    const created = await prisma.sandbox.create({
      data: { userId, name: `def-${randomBytes(4).toString('hex')}`, project: 'e2e' },
    })
    // Значение по умолчанию — часть продукта: его никто не выбирает, и оно
    // не должно приносить ошибки тому, кто о нём не знает.
    expect(created.errorRate).toBe(0)
  })
})

describe('включённая инъекция опознаётся по ответу', () => {
  it('сбой помечен своей долей, а не выдаёт себя за поломку мока', async () => {
    let injected = 0
    let ok = 0
    for (let i = 0; i < 60; i++) {
      if (i % 20 === 0) resetRateLimits()
      const res = await call('/apify/v2/users/me/limits', noisyKey)
      if (res.statusCode === 200) {
        ok += 1
        continue
      }
      injected += 1
      // По этому заголовку разработчик понимает, что «нестабильность» —
      // его собственная настройка, и выключает её одним переключателем.
      expect(res.headers['x-apistend-error-rate']).toBe('50')
      expect(res.headers['x-apistend-scenario']).toBe('server_error')
    }
    expect(injected).toBeGreaterThan(0)
    expect(ok).toBeGreaterThan(0)
  })

  it('выключение доли ошибок через Management API убирает сбои', async () => {
    await prisma.sandbox.update({ where: { id: noisySandboxId }, data: { errorRate: 0 } })
    invalidateKeyCache()
    const codes = new Set<number>()
    for (let i = 0; i < 30; i++) {
      if (i % 20 === 0) resetRateLimits()
      codes.add((await call('/apify/v2/users/me/limits', noisyKey)).statusCode)
    }
    expect([...codes]).toEqual([200])
  })
})
