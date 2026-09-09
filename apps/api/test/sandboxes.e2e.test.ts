import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { hashPassword } from '../src/lib/keys.ts'

/**
 * Свои песочницы: создание из кабинета и разделение данных между ними.
 *
 * Проверяется не «создаётся ли строка в базе», а то, ради чего песочницы заводят:
 * ключи, вебхуки и журнал одной песочницы не должны быть видны из другой.
 * Кабинет ходит по cookie-сессии, поэтому здесь именно она, а не серверный ключ.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let userId = ''
let cookie = ''
let firstSandboxId = ''

const PASSWORD = 'apistend-sandboxes-2026'

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const login = `sbx-${randomBytes(4).toString('hex')}`
  const user = await prisma.user.create({
    data: { login, passwordHash: await hashPassword(PASSWORD), name: 'Тест песочниц', initials: 'ТП' },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: { userId: user.id, name: 'sandbox-01', project: 'Первый', latencyMs: 0, errorRate: 0 },
  })
  firstSandboxId = sandbox.id

  const res = await api.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password: PASSWORD } })
  const raw = res.headers['set-cookie']
  cookie = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '')
})

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
  await api.close()
})

describe('создание песочницы из кабинета', () => {
  it('кабинет создаёт песочницу по cookie-сессии, без серверного ключа', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { name: 'sandbox-02', project: 'Автотесты' },
    })
    expect(res.statusCode).toBe(201)
    const created = JSON.parse(res.body) as { id: string; name: string; project: string }
    expect(created.name).toBe('sandbox-02')
    expect(created.project).toBe('Автотесты')
  })

  it('имя уникально в пределах аккаунта', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { name: 'sandbox-02' },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('данные принадлежат песочнице', () => {
  it('ключ, созданный в одной, не виден в другой', async () => {
    const second = await prisma.sandbox.findFirstOrThrow({ where: { userId, name: 'sandbox-02' } })

    // Ключ создаётся в первой песочнице — именно её кабинет и передаёт в sandboxId.
    const created = await api.inject({
      method: 'POST',
      url: `/api/keys?sandboxId=${firstSandboxId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { name: 'ключ первой', kind: 'server' },
    })
    expect(created.statusCode).toBe(201)

    const inFirst = await api.inject({ method: 'GET', url: `/api/keys?sandboxId=${firstSandboxId}`, headers: { cookie } })
    const inSecond = await api.inject({ method: 'GET', url: `/api/keys?sandboxId=${second.id}`, headers: { cookie } })

    const first = (JSON.parse(inFirst.body) as { keys: unknown[] }).keys
    const other = (JSON.parse(inSecond.body) as { keys: unknown[] }).keys
    expect(first.length).toBe(1)
    // Ровно это и есть смысл второй песочницы: чужие ключи в ней не видны.
    expect(other.length).toBe(0)
  })

  it('чужая песочница по идентификатору не открывается', async () => {
    const stranger = await prisma.user.create({
      data: {
        login: `alien-${randomBytes(4).toString('hex')}`,
        passwordHash: await hashPassword(PASSWORD),
        name: 'Чужой', initials: 'Ч',
      },
    })
    const alien = await prisma.sandbox.create({
      data: { userId: stranger.id, name: 'sandbox-01', project: 'Чужой' },
    })

    const res = await api.inject({ method: 'GET', url: `/api/keys?sandboxId=${alien.id}`, headers: { cookie } })
    expect(res.statusCode).toBe(404)

    await prisma.user.delete({ where: { id: stranger.id } }).catch(() => undefined)
  })
})
