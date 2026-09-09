import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { env } from '../src/env.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'

/**
 * Сквозные тесты Management API.
 *
 * Здесь проверяется не «отвечает ли маршрут», а те свойства, ошибка в которых
 * стоит дороже всего и не видна на глаз: кого API пускает, что ему разрешено
 * и где кончается его аккаунт. Поэтому центральный блок — изоляция: заводятся
 * два настоящих пользователя, и ключ первого пробует достать каждую сущность
 * второго. Такая ошибка не ломает ни одного экрана и обнаруживается только
 * так — запросом от чужого имени.
 *
 * Данные создаются с случайными именами и удаляются вместе с пользователями,
 * поэтому тесты не зависят ни от порядка выполнения, ни от содержимого базы.
 */

let api: Awaited<ReturnType<typeof buildServer>>

const PASSWORD = 'apistend-mgmt-e2e-2026'
const rnd = () => randomBytes(4).toString('hex')

interface Reply<T = Record<string, unknown>> {
  status: number
  body: T
  headers: Record<string, unknown>
  raw: string
}

/**
 * Один запрос к API. Ключ и cookie передаются раздельно: оба способа входа
 * равноправны, и тест обязан уметь ходить и тем и другим.
 */
async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { key?: string; cookie?: string; body?: unknown; authorization?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {}
  if (options.key) headers.authorization = `Bearer ${options.key}`
  if (options.authorization !== undefined) headers.authorization = options.authorization
  if (options.cookie) headers.cookie = options.cookie

  const response = await api.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  })

  let parsed: unknown = null
  try {
    parsed = response.body.length > 0 ? JSON.parse(response.body) : null
  } catch {
    // Не JSON — это законно для выгрузки в CSV, тело остаётся в raw.
    parsed = null
  }
  return {
    status: response.statusCode,
    body: parsed as T,
    headers: response.headers as Record<string, unknown>,
    raw: response.body,
  }
}

interface IssuedKey {
  id: string
  name: string
  secret: string
}

/** Ключ прямо в базе: маршрут выпуска здесь ещё проверяется, а фикстура нужна до него. */
async function issueKey(
  sandboxId: string,
  options: {
    kind?: 'server' | 'sandbox'
    scopes?: string[]
    status?: 'active' | 'revoked'
    expiresAt?: Date | null
    name?: string
  } = {},
): Promise<IssuedKey> {
  const kind = options.kind ?? 'server'
  const generated = generateKey(kind)
  const row = await prisma.apiKey.create({
    data: {
      sandboxId,
      name: options.name ?? `ключ ${rnd()}`,
      kind,
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: ['bitrix24', 'ozon', 'wildberries'],
      scopes: options.scopes ?? [],
      status: options.status ?? 'active',
      expiresAt: options.expiresAt ?? null,
      ...(options.status === 'revoked' ? { revokedAt: new Date(), revokedBy: 'фикстура' } : {}),
    },
  })
  return { id: row.id, name: row.name, secret: generated.full }
}

/** Аккаунт с песочницей и полнодоступным серверным ключом. */
async function makeAccount(tag: string) {
  const email = `mgmt-${tag}-${rnd()}@test.local`
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      name: `Тест ${tag}`,
      initials: 'ТТ',
    },
  })
  const sandbox = await prisma.sandbox.create({
    data: {
      userId: user.id,
      name: `mgmt-${tag}-${rnd()}`,
      project: 'e2e',
      // Ноль обязателен: по умолчанию песочница отдаёт 5 % случайных ошибок,
      // и они прилетели бы в консоль и в журнал, делая тесты мигающими.
      latencyMs: 0,
      errorRate: 0,
    },
  })
  const key = await issueKey(sandbox.id, { name: `основной ${tag}` })
  return { userId: user.id, email, sandboxId: sandbox.id, key }
}

let alice: Awaited<ReturnType<typeof makeAccount>>
let bob: Awaited<ReturnType<typeof makeAccount>>

/** Сущности второго аккаунта, до которых первый не должен дотянуться. */
const foreign = {
  keyId: '',
  webhookId: '',
  deliveryId: '',
  mockId: '',
  logId: '',
  logPublicId: '',
  appId: '',
  scenarioId: '',
  burstId: '',
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  alice = await makeAccount('alice')
  bob = await makeAccount('bob')

  // Всё хозяйство Бориса заводится в базе напрямую: проверяется чужой доступ
  // к нему, а не то, каким маршрутом оно появилось.
  foreign.keyId = (await issueKey(bob.sandboxId, { name: 'ключ Бориса' })).id

  const webhook = await prisma.webhook.create({
    data: {
      sandboxId: bob.sandboxId,
      serviceCode: 'ozon',
      event: 'TYPE_NEW_POSTING',
      target: 'local',
      targetPath: '/bob',
      secret: `stend_whsec_${randomBytes(8).toString('hex')}`,
    },
  })
  foreign.webhookId = webhook.id

  const delivery = await prisma.webhookDelivery.create({
    data: {
      sandboxId: bob.sandboxId,
      webhookId: webhook.id,
      event: 'TYPE_NEW_POSTING',
      serviceCode: 'ozon',
      state: 'failed',
      targetDisplay: '/bob',
      rawBody: '{"message_type":"TYPE_NEW_POSTING"}',
      contentType: 'application/json',
      requestHeaders: { 'content-type': 'application/json' },
    },
  })
  foreign.deliveryId = delivery.id

  const mock = await prisma.customMock.create({
    data: {
      sandboxId: bob.sandboxId,
      httpMethod: 'GET',
      path: `/custom/bob-${rnd()}`,
      title: 'Мок Бориса',
      responseBody: '{"secret":"боб"}',
      headers: {},
      rules: [],
    },
  })
  foreign.mockId = mock.id

  const log = await prisma.requestLog.create({
    data: {
      sandboxId: bob.sandboxId,
      publicId: `req_${randomBytes(5).toString('hex')}`,
      serviceCode: 'ozon',
      httpMethod: 'POST',
      endpoint: '/v3/posting/fbs/list',
      statusCode: 200,
      durationMs: 41,
      sizeBytes: 128,
      requestHeaders: { 'x-secret-of-bob': 'да' },
      responseHeaders: {},
      requestBody: '{"filter":{}}',
    },
  })
  foreign.logId = log.id
  foreign.logPublicId = log.publicId

  const app24 = await prisma.b24App.create({
    data: {
      sandboxId: bob.sandboxId,
      title: 'Приложение Бориса',
      code: `bob.${rnd()}`,
      kind: 'server_ui',
      scope: ['crm'],
      handlerUrl: 'https://example.invalid/handler',
      clientId: `local.${randomBytes(7).toString('hex')}.12345678`,
      clientSecret: randomBytes(25).toString('hex'),
      applicationToken: randomBytes(16).toString('hex'),
    },
  })
  foreign.appId = app24.id

  const scenario = await prisma.scenario.create({
    data: {
      sandboxId: bob.sandboxId,
      name: 'Сценарий Бориса',
      serviceCode: 'ozon',
      stepsCount: 1,
      steps: [],
    },
  })
  foreign.scenarioId = scenario.id

  const burst = await prisma.eventBurst.create({
    data: {
      sandboxId: bob.sandboxId,
      webhookId: webhook.id,
      event: 'TYPE_NEW_POSTING',
      serviceCode: 'ozon',
      state: 'done',
      count: 1,
      ratePerSec: 1,
      requestedCount: 1,
      requestedRatePerSec: 1,
    },
  })
  foreign.burstId = burst.id

  // Разбор ключей кешируется на 30 секунд; фикстуры созданы в обход маршрутов,
  // и остатки прошлого прогона в кеше сделали бы результат зависящим от истории.
  invalidateKeyCache()
})

afterAll(async () => {
  await api.close()
  await prisma.user.deleteMany({ where: { id: { in: [alice?.userId, bob?.userId].filter(Boolean) as string[] } } })
  await prisma.$disconnect()
})

// ─────────────────────────── 1. Аутентификация ───────────────────────────

describe('аутентификация', () => {
  it('без заголовка Authorization отвечает 401', async () => {
    const res = await call('GET', '/api/v1/keys')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('UNAUTHORIZED')
    // Текст обязан называть оба способа входа: скрипт без ключа и браузер без
    // cookie получают одинаковый отказ и должны понять, чего им не хватает.
    expect(String(res.body.message)).toContain('stend_sk_')
  })

  it('пустой Bearer и мусор вместо ключа тоже дают 401', async () => {
    expect((await call('GET', '/api/v1/keys', { authorization: 'Bearer' })).status).toBe(401)
    expect((await call('GET', '/api/v1/keys', { authorization: 'Bearer   ' })).status).toBe(401)
    expect((await call('GET', '/api/v1/keys', { authorization: 'Basic dXNlcjpwYXNz' })).status).toBe(401)

    const notOurKey = await call('GET', '/api/v1/keys', { key: 'sk_live_51H8x' })
    expect(notOurKey.status).toBe(401)
    expect(notOurKey.body.error).toBe('UNAUTHORIZED')
  })

  it('ключ песочницы stend_sbx_ в Management API не принимается', async () => {
    const sandboxKey = await issueKey(alice.sandboxId, { kind: 'sandbox' })
    const res = await call('GET', '/api/v1/keys', { key: sandboxKey.secret })

    expect(res.status).toBe(401)
    // Отдельный код, а не общий UNAUTHORIZED: ключ существует и работает на шлюзе,
    // и клиенту нужно понять, что менять надо ключ, а не искать опечатку.
    expect(res.body.error).toBe('SANDBOX_KEY_NOT_ALLOWED')
    expect(String(res.body.message)).toContain('stend_sbx_')
  })

  it('отозванный ключ перестаёт работать сразу, а не по истечении кеша', async () => {
    const key = await issueKey(alice.sandboxId, { name: `отзыв ${rnd()}` })
    // Сначала успешный вызов: он кладёт разбор ключа в кеш, и без сброса кеша
    // отзыв «подвисал» бы на 30 секунд. Именно это здесь и проверяется.
    expect((await call('GET', '/api/v1/account', { key: key.secret })).status).toBe(200)

    const revoked = await call('POST', `/api/v1/keys/${key.id}/revoke`, {
      key: alice.key.secret,
      body: { confirmName: key.name },
    })
    expect(revoked.status).toBe(200)

    const after = await call('GET', '/api/v1/account', { key: key.secret })
    expect(after.status).toBe(401)
    expect(after.body.error).toBe('UNAUTHORIZED')
  })

  it('просроченный ключ отвергается, а ключ со сроком в будущем работает', async () => {
    const expired = await issueKey(alice.sandboxId, { expiresAt: new Date(Date.now() - 60_000) })
    const alive = await issueKey(alice.sandboxId, { expiresAt: new Date(Date.now() + 3_600_000) })

    expect((await call('GET', '/api/v1/account', { key: expired.secret })).status).toBe(401)
    expect((await call('GET', '/api/v1/account', { key: alive.secret })).status).toBe(200)
  })

  it('годный серверный ключ пускает и сообщает, чем именно вошли', async () => {
    const res = await call<{ id: string; access: Record<string, unknown> }>('GET', '/api/v1/account', {
      key: alice.key.secret,
    })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(alice.userId)
    expect(res.body.access.via).toBe('key')
    expect(res.body.access.apiKeyId).toBe(alice.key.id)
    // Песочница ключа — умолчание для всех маршрутов, где sandboxId не указан.
    expect(res.body.access.defaultSandboxId).toBe(alice.sandboxId)
  })

  it('cookie-сессия кабинета работает наравне с ключом и подчиняется тем же границам аккаунта', async () => {
    const login = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: alice.email, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    const cookie = (login.headers['set-cookie'] as string[] | string | undefined)
    const jar = (Array.isArray(cookie) ? cookie : [cookie ?? '']).map((c) => c.split(';')[0]).join('; ')
    expect(jar).toContain('apistend_session')

    const res = await call<{ id: string; access: Record<string, unknown> }>('GET', '/api/v1/account', { cookie: jar })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(alice.userId)
    expect(res.body.access.via).toBe('session')
    // У сессии кабинета прав ровно столько же, сколько у человека за экраном.
    expect(res.body.access.scopes).toEqual(['*'])

    // Полный доступ — это доступ ко ВСЕМУ СВОЕМУ. У сессии умолчание песочницы
    // считается иначе, чем у ключа, поэтому граница аккаунта проверяется отдельно.
    expect((await call('GET', `/api/v1/keys?sandboxId=${bob.sandboxId}`, { cookie: jar })).status).toBe(404)
    expect((await call('GET', `/api/v1/mocks/${foreign.mockId}`, { cookie: jar })).status).toBe(404)
  })

  it('ключ удалённой песочницы перестаёт работать сразу', async () => {
    // Кеш разбора ключей держит копию песочницы 30 секунд и об удалении не знает:
    // без сброса ключ ещё полминуты пускал бы в аккаунт и на шлюз.
    const sandbox = await prisma.sandbox.create({
      data: { userId: alice.userId, name: `mgmt-tmp-${rnd()}`, project: 'e2e' },
    })
    const key = await issueKey(sandbox.id, { name: `временный ${rnd()}` })
    expect((await call('GET', '/api/v1/account', { key: key.secret })).status).toBe(200)

    const removed = await call('DELETE', `/api/v1/sandboxes/${sandbox.id}`, {
      key: alice.key.secret,
      body: { confirmName: sandbox.name },
    })
    expect(removed.status).toBe(200)
    expect((await call('GET', '/api/v1/account', { key: key.secret })).status).toBe(401)
  })
})

// ─────────────────────── Транспорт: тело, префикс, заголовки ───────────────────────

describe('транспорт', () => {
  it('адреса библиотеки BX24.js остались за ней', async () => {
    // /api/v1 и /api/v1/ отдают BX24.js. Маршрут Management API с пустым путём
    // перекрыл бы её и сломал все приложения, подключающие библиотеку.
    for (const url of ['/api/v1', '/api/v1/']) {
      const res = await api.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(String(res.headers['content-type']), url).toContain('javascript')
      expect(res.body, url).toContain('BX24')
    }
  })

  it('спецификация и справка отдаются без авторизации', async () => {
    // За спецификацией клиент идёт до того, как у него появился ключ.
    expect((await call('GET', '/api/v1/openapi.json')).status).toBe(200)
    expect((await call('GET', '/api/v1/meta')).status).toBe(200)
  })

  it('пустое тело при Content-Type: application/json считается за {}', async () => {
    // fetch и curl ставят заголовок по привычке даже там, где телу взяться неоткуда.
    const key = await issueKey(alice.sandboxId, { name: `пустое тело ${rnd()}` })
    const res = await api.inject({
      method: 'POST',
      url: `/api/v1/keys/${key.id}/rotate`,
      headers: { authorization: `Bearer ${alice.key.secret}`, 'content-type': 'application/json' },
      payload: '',
    })
    expect(res.statusCode).toBe(201)
  })

  it('JSON, ушедший формой, объясняется по-человечески, а битый JSON — кодом INVALID_JSON', async () => {
    const asForm = await api.inject({
      method: 'POST',
      url: '/api/v1/mocks',
      headers: {
        authorization: `Bearer ${alice.key.secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: JSON.stringify({ httpMethod: 'GET', path: '/custom/form', title: 'Форма' }),
    })
    expect(asForm.statusCode).toBe(400)
    // Без этой ветки клиент получал бы «поле title обязательно» на запрос,
    // где title он как раз прислал.
    expect(JSON.parse(asForm.body).message).toContain('форм')

    const broken = await api.inject({
      method: 'POST',
      url: '/api/v1/mocks',
      headers: { authorization: `Bearer ${alice.key.secret}`, 'content-type': 'application/json' },
      payload: '{"нет',
    })
    expect(broken.statusCode).toBe(400)
    expect(JSON.parse(broken.body).error).toBe('INVALID_JSON')
  })

  it('остаток лимита виден на успешном ответе', async () => {
    const key = await issueKey(alice.sandboxId, { name: `заголовки ${rnd()}` })
    const res = await call('GET', '/api/v1/account', { key: key.secret })
    expect(res.status).toBe(200)
    expect(Number(res.headers['x-ratelimit-limit'])).toBe(env.mgmtRateLimitPerMin)
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(env.mgmtRateLimitPerMin - 1)
    expect(res.headers['x-ratelimit-reset']).toBe('0')
  })

  it('выгрузка в CSV уходит как text/csv с BOM и точкой с запятой', async () => {
    // Excel с русской локалью без BOM портит кириллицу, а без «;» кладёт строку
    // в одну колонку. Тип ответа тут отличается от остального API — это проверяется
    // отдельно, потому что в openapi.json он описан как JSON.
    const res = await call('GET', '/api/v1/logs/export?format=csv', { key: alice.key.secret })
    expect(res.status).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/csv')
    expect(String(res.headers['content-disposition'])).toContain('attachment')
    expect(res.raw.startsWith('﻿')).toBe(true)
    expect(res.raw.split('\n')[0]).toContain(';')
  })

  it('листание курсором отдаёт каждую запись ровно один раз', async () => {
    const key = alice.key.secret
    const created: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const res = await call<{ id: string }>('POST', '/api/v1/mocks', {
        key,
        body: { httpMethod: 'GET', path: `/custom/page-${i}-${rnd()}`, title: `Страница ${i}` },
      })
      expect(res.status).toBe(201)
      created.push(res.body.id)
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const url: string = `/api/v1/mocks?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const res = await call<{ items: Array<{ id: string }>; nextCursor: string | null }>('GET', url, { key })
      expect(res.status).toBe(200)
      seen.push(...res.body.items.map((m) => m.id))
      cursor = res.body.nextCursor
      if (!cursor) break
    }

    // Курсор — идентификатор последней отданной записи: смещением журнал листать
    // нельзя, страница 2 повторяла бы часть страницы 1.
    expect(new Set(seen).size).toBe(seen.length)
    for (const id of created) expect(seen).toContain(id)

    for (const id of created) await call('DELETE', `/api/v1/mocks/${id}`, { key })
  })
})

// ─────────────────────────── 2. Области доступа ───────────────────────────

describe('области доступа', () => {
  it('ключ только на чтение не может писать', async () => {
    const readOnly = await issueKey(alice.sandboxId, { scopes: ['keys:read', 'mocks:read'] })

    expect((await call('GET', '/api/v1/keys', { key: readOnly.secret })).status).toBe(200)
    expect((await call('GET', '/api/v1/mocks', { key: readOnly.secret })).status).toBe(200)

    const write = await call('POST', '/api/v1/mocks', {
      key: readOnly.secret,
      body: { httpMethod: 'GET', path: `/custom/readonly-${rnd()}`, title: 'Не должно создаться' },
    })
    expect(write.status).toBe(403)
    expect(write.body.error).toBe('FORBIDDEN')
    expect(String(write.body.message)).toContain('mocks:write')
  })

  it('чужая область даёт 403 даже на чтение', async () => {
    const narrow = await issueKey(alice.sandboxId, { scopes: ['mocks:read'] })
    const res = await call('GET', '/api/v1/webhooks', { key: narrow.secret })
    expect(res.status).toBe(403)
    expect(String(res.body.message)).toContain('webhooks:read')
  })

  it('право на запись включает право на чтение того же ресурса', async () => {
    // Иначе ключу, которому доверено менять вебхуки, пришлось бы отдельно
    // выписывать право их видеть — лишний повод ошибиться при выдаче.
    const writer = await issueKey(alice.sandboxId, { scopes: ['webhooks:write'] })
    expect((await call('GET', '/api/v1/webhooks', { key: writer.secret })).status).toBe(200)
  })

  it('ограниченный ключ не выдаёт ключ шире себя', async () => {
    const limited = await issueKey(alice.sandboxId, { scopes: ['keys:write'] })

    const wider = await call('POST', '/api/v1/keys', {
      key: limited.secret,
      body: {
        name: 'Слишком широкий',
        kind: 'server',
        services: ['bitrix24'],
        scopes: ['keys:write', 'account:write'],
      },
    })
    expect(wider.status).toBe(403)
    expect(String(wider.body.message)).toContain('account:write')

    // Пустой scopes — это полный доступ, то есть та же эскалация другими словами.
    const noScopes = await call('POST', '/api/v1/keys', {
      key: limited.secret,
      body: { name: 'Без областей', kind: 'server', services: ['bitrix24'] },
    })
    expect(noScopes.status).toBe(403)

    const star = await call('POST', '/api/v1/keys', {
      key: limited.secret,
      body: { name: 'Звёздочка', kind: 'server', services: ['bitrix24'], scopes: ['*'] },
    })
    expect(star.status).toBe(403)

    // Подмножество собственных прав выдать можно — иначе ключ был бы бесполезен.
    const allowed = await call<{ id: string; scopes: string[] }>('POST', '/api/v1/keys', {
      key: limited.secret,
      body: { name: 'Ровно по правам', kind: 'server', services: ['bitrix24'], scopes: ['keys:read'] },
    })
    expect(allowed.status).toBe(201)
    expect(allowed.body.scopes).toEqual(['keys:read'])
  })

  it('ключ не может расширить сам себя правкой', async () => {
    const limited = await issueKey(alice.sandboxId, { scopes: ['keys:write'] })

    const up = await call('PATCH', `/api/v1/keys/${limited.id}`, {
      key: limited.secret,
      body: { scopes: ['keys:write', 'sandboxes:write'] },
    })
    expect(up.status).toBe(403)

    const toFull = await call('PATCH', `/api/v1/keys/${limited.id}`, {
      key: limited.secret,
      body: { scopes: [] },
    })
    expect(toFull.status).toBe(403)

    // Урезать себя можно, и новые права действуют со следующего запроса,
    // а не после истечения кеша разбора ключей.
    const down = await call<{ scopes: string[] }>('PATCH', `/api/v1/keys/${limited.id}`, {
      key: limited.secret,
      body: { scopes: ['keys:read'] },
    })
    expect(down.status).toBe(200)
    expect(down.body.scopes).toEqual(['keys:read'])

    const afterNarrowing = await call('POST', '/api/v1/keys', {
      key: limited.secret,
      body: { name: 'Уже нельзя', kind: 'server', services: ['bitrix24'], scopes: ['keys:read'] },
    })
    expect(afterNarrowing.status).toBe(403)
  })

  it('ограниченный ключ не прокручивает ключ с более широкими правами', async () => {
    // Ротация отдаёт на руки рабочий секрет, то есть обходила бы проверку выдачи.
    const limited = await issueKey(alice.sandboxId, { scopes: ['keys:write'] })
    const full = await issueKey(alice.sandboxId, { scopes: [], name: `полный ${rnd()}` })

    const res = await call('POST', `/api/v1/keys/${full.id}/rotate`, { key: limited.secret })
    expect(res.status).toBe(403)
    expect(String(res.body.message)).toContain('шире')

    // Ключ не шире собственных прав прокручивается, и права переезжают в новый.
    const sibling = await issueKey(alice.sandboxId, { scopes: ['keys:read'] })
    const ok = await call<{ scopes: string[]; secret: string }>('POST', `/api/v1/keys/${sibling.id}/rotate`, {
      key: limited.secret,
    })
    expect(ok.status).toBe(201)
    expect(ok.body.scopes).toEqual(['keys:read'])

    // Наследование областей проверяется не по полю в ответе, а работой ключа:
    // потеря scopes при ротации превращает ограниченный ключ в полнодоступный,
    // и заметить это по одному лишь списку ключей нельзя.
    expect((await call('GET', '/api/v1/keys', { key: ok.body.secret })).status).toBe(200)
    expect((await call('GET', '/api/v1/webhooks', { key: ok.body.secret })).status).toBe(403)
    expect(
      (await call('POST', '/api/v1/keys', {
        key: ok.body.secret,
        body: { name: 'Из прокрученного', kind: 'server', services: ['bitrix24'] },
      })).status,
    ).toBe(403)
  })

  it('ключу песочницы области доступа не назначаются', async () => {
    const res = await call('POST', '/api/v1/keys', {
      key: alice.key.secret,
      body: { name: 'Песочный со scopes', kind: 'sandbox', services: ['bitrix24'], scopes: ['logs:read'] },
    })
    // Молча сохранённые scopes показывали бы в списке права, которых нет.
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('UNPROCESSABLE')
  })
})

// ─────────────────────────── 3. Изоляция аккаунтов ───────────────────────────

describe('изоляция аккаунтов', () => {
  /**
   * Чужой объект обязан отвечать 404, а не 403: по разнице кодов чужие
   * идентификаторы перебираются на существование, и «нет доступа» рассказало бы
   * ровно то, что скрывается.
   */
  const alien = (res: Reply, what: string): void => {
    expect(res.status, `${what}: ожидался 404`).toBe(404)
    expect(['NOT_FOUND', 'SANDBOX_NOT_FOUND']).toContain(res.body.error)
  }

  it('в списках видно только своё', async () => {
    const sandboxes = await call<{ items: Array<{ id: string }> }>('GET', '/api/v1/sandboxes?limit=100', {
      key: alice.key.secret,
    })
    expect(sandboxes.status).toBe(200)
    expect(sandboxes.body.items.map((s) => s.id)).toContain(alice.sandboxId)
    expect(sandboxes.body.items.map((s) => s.id)).not.toContain(bob.sandboxId)

    for (const path of ['/api/v1/keys', '/api/v1/webhooks', '/api/v1/mocks', '/api/v1/logs', '/api/v1/scenarios', '/api/v1/bursts', '/api/v1/apps']) {
      const res = await call<{ items: Array<{ id: string }> }>('GET', `${path}?limit=100`, { key: alice.key.secret })
      expect(res.status, path).toBe(200)
      const ids = res.body.items.map((i) => i.id)
      expect(ids, path).not.toContain(foreign.keyId)
      expect(ids, path).not.toContain(foreign.webhookId)
      expect(ids, path).not.toContain(foreign.mockId)
      expect(ids, path).not.toContain(foreign.logId)
      expect(ids, path).not.toContain(foreign.scenarioId)
      expect(ids, path).not.toContain(foreign.burstId)
      expect(ids, path).not.toContain(foreign.appId)
    }
  })

  it('чужая песочница не читается, не меняется и не удаляется', async () => {
    const key = alice.key.secret
    alien(await call('GET', `/api/v1/sandboxes/${bob.sandboxId}`, { key }), 'GET песочницы')
    alien(
      await call('PATCH', `/api/v1/sandboxes/${bob.sandboxId}`, { key, body: { errorRate: 50 } }),
      'PATCH песочницы',
    )
    alien(
      await call('DELETE', `/api/v1/sandboxes/${bob.sandboxId}`, { key, body: { confirmName: 'mgmt-bob' } }),
      'DELETE песочницы',
    )
    alien(await call('POST', `/api/v1/sandboxes/${bob.sandboxId}/reset`, { key }), 'сброс песочницы')

    const still = await prisma.sandbox.findUnique({ where: { id: bob.sandboxId } })
    expect(still).not.toBeNull()
    expect(still?.errorRate).toBe(0)
  })

  it('чужая песочница не подставляется через ?sandboxId=', async () => {
    // Самый вероятный способ перепутать аккаунты: идентификатор приезжает
    // параметром, а не путём, и проверка владельца тут одна на весь API.
    const key = alice.key.secret
    for (const path of ['/api/v1/keys', '/api/v1/webhooks', '/api/v1/mocks', '/api/v1/logs', '/api/v1/logs/export', '/api/v1/alerts', '/api/v1/apps', '/api/v1/scenarios', '/api/v1/bursts', '/api/v1/tunnel/status']) {
      alien(await call('GET', `${path}?sandboxId=${bob.sandboxId}`, { key }), path)
    }
    alien(
      await call('POST', `/api/v1/logs/clear?sandboxId=${bob.sandboxId}`, { key, body: { confirm: true } }),
      'очистка чужого журнала',
    )
    alien(
      await call('POST', `/api/v1/console/execute?sandboxId=${bob.sandboxId}`, {
        key,
        body: { serviceCode: 'ozon', httpMethod: 'GET', path: '/v1/warehouse/list' },
      }),
      'консоль в чужой песочнице',
    )

    expect(await prisma.requestLog.count({ where: { sandboxId: bob.sandboxId } })).toBe(1)
  })

  it('чужой ключ не читается, не меняется, не отзывается и не удаляется', async () => {
    const key = alice.key.secret
    alien(await call('GET', `/api/v1/keys/${foreign.keyId}`, { key }), 'GET ключа')
    alien(await call('PATCH', `/api/v1/keys/${foreign.keyId}`, { key, body: { name: 'Перехвачено' } }), 'PATCH ключа')
    alien(await call('POST', `/api/v1/keys/${foreign.keyId}/rotate`, { key }), 'ротация ключа')
    alien(
      await call('POST', `/api/v1/keys/${foreign.keyId}/revoke`, { key, body: { confirmName: 'ключ Бориса' } }),
      'отзыв ключа',
    )
    alien(
      await call('DELETE', `/api/v1/keys/${foreign.keyId}`, { key, body: { confirmName: 'ключ Бориса' } }),
      'удаление ключа',
    )

    const untouched = await prisma.apiKey.findUnique({ where: { id: foreign.keyId } })
    expect(untouched?.status).toBe('active')
    expect(untouched?.name).toBe('ключ Бориса')
  })

  it('чужой вебхук и его доставки недоступны', async () => {
    const key = alice.key.secret
    alien(await call('GET', `/api/v1/webhooks/${foreign.webhookId}`, { key }), 'GET вебхука')
    alien(
      await call('PATCH', `/api/v1/webhooks/${foreign.webhookId}`, { key, body: { status: 'paused' } }),
      'PATCH вебхука',
    )
    alien(await call('POST', `/api/v1/webhooks/${foreign.webhookId}/test`, { key }), 'тест вебхука')
    alien(await call('GET', `/api/v1/webhooks/${foreign.webhookId}/deliveries`, { key }), 'журнал доставок')
    alien(
      await call('DELETE', `/api/v1/webhooks/${foreign.webhookId}?withDeliveries=true`, { key }),
      'удаление вебхука',
    )
    alien(await call('GET', `/api/v1/deliveries/${foreign.deliveryId}`, { key }), 'карточка доставки')
    alien(await call('POST', `/api/v1/deliveries/${foreign.deliveryId}/retry`, { key }), 'повтор доставки')

    // Массовый повтор в своей песочнице не должен захватывать чужие доставки.
    const bulk = await call<{ scanned: number; deliveryIds: string[] }>('POST', '/api/v1/webhooks/retry-failed', {
      key,
      body: {},
    })
    expect(bulk.status).toBe(200)
    expect(bulk.body.deliveryIds).not.toContain(foreign.deliveryId)

    const webhook = await prisma.webhook.findUnique({ where: { id: foreign.webhookId } })
    expect(webhook?.status).toBe('active')
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: foreign.deliveryId } })
    expect(delivery?.state).toBe('failed')
    expect(await prisma.webhookDelivery.count({ where: { sandboxId: bob.sandboxId } })).toBe(1)
  })

  it('чужой мок не читается и не удаляется', async () => {
    const key = alice.key.secret
    alien(await call('GET', `/api/v1/mocks/${foreign.mockId}`, { key }), 'GET мока')
    alien(await call('PATCH', `/api/v1/mocks/${foreign.mockId}`, { key, body: { title: 'Перехвачено' } }), 'PATCH мока')
    alien(await call('POST', `/api/v1/mocks/${foreign.mockId}/enable`, { key }), 'включение мока')
    alien(await call('POST', `/api/v1/mocks/${foreign.mockId}/disable`, { key }), 'выключение мока')
    alien(await call('DELETE', `/api/v1/mocks/${foreign.mockId}`, { key }), 'удаление мока')

    const mock = await prisma.customMock.findUnique({ where: { id: foreign.mockId } })
    expect(mock?.title).toBe('Мок Бориса')
    expect(mock?.status).toBe('draft')
  })

  it('чужая запись журнала не открывается ни по id, ни по публичному номеру', async () => {
    const key = alice.key.secret
    alien(await call('GET', `/api/v1/logs/${foreign.logId}`, { key }), 'GET по id')
    // publicId уникален глобально — тут проще всего забыть про фильтр по песочнице.
    alien(await call('GET', `/api/v1/logs/${foreign.logPublicId}`, { key }), 'GET по publicId')
  })

  it('чужое приложение Bitrix24 недоступно', async () => {
    const key = alice.key.secret
    const app24 = await prisma.b24App.findUnique({ where: { id: foreign.appId } })
    alien(await call('GET', `/api/v1/apps/${foreign.appId}`, { key }), 'GET приложения')
    alien(await call('PATCH', `/api/v1/apps/${foreign.appId}`, { key, body: { title: 'Перехвачено' } }), 'PATCH приложения')
    alien(
      await call('DELETE', `/api/v1/apps/${foreign.appId}`, { key, body: { confirmName: app24?.code ?? 'x' } }),
      'удаление приложения',
    )

    const after = await prisma.b24App.findUnique({ where: { id: foreign.appId } })
    expect(after?.title).toBe('Приложение Бориса')
    // client_secret не должен был утечь ни одним ответом.
    expect(after?.clientSecret).toBe(app24?.clientSecret)
  })

  it('чужой сценарий и чужая серия событий недоступны', async () => {
    const key = alice.key.secret
    alien(await call('GET', `/api/v1/scenarios/${foreign.scenarioId}`, { key }), 'GET сценария')
    alien(await call('PATCH', `/api/v1/scenarios/${foreign.scenarioId}`, { key, body: { name: 'Перехвачено' } }), 'PATCH сценария')
    alien(await call('POST', `/api/v1/scenarios/${foreign.scenarioId}/run`, { key }), 'запуск сценария')
    alien(await call('DELETE', `/api/v1/scenarios/${foreign.scenarioId}`, { key }), 'удаление сценария')
    alien(await call('GET', `/api/v1/bursts/${foreign.burstId}`, { key }), 'GET серии')
    alien(await call('POST', `/api/v1/bursts/${foreign.burstId}/stop`, { key }), 'остановка серии')

    // Серию нельзя завести и на чужой вебхук, указав его идентификатор в теле.
    const onForeignWebhook = await call('POST', '/api/v1/bursts', {
      key,
      body: { webhookId: foreign.webhookId, count: 1, ratePerSec: 1 },
    })
    expect(onForeignWebhook.status).toBe(404)

    const scenario = await prisma.scenario.findUnique({ where: { id: foreign.scenarioId } })
    expect(scenario?.name).toBe('Сценарий Бориса')
    expect(await prisma.eventBurst.count({ where: { sandboxId: bob.sandboxId } })).toBe(1)
  })

  it('сводка и профиль считают только свой аккаунт', async () => {
    const usage = await call<{ sandboxes: Array<{ id: string }> }>('GET', '/api/v1/usage', { key: alice.key.secret })
    expect(usage.status).toBe(200)
    expect(JSON.stringify(usage.body)).not.toContain(bob.sandboxId)

    const account = await call<{ id: string; email: string }>('GET', '/api/v1/account', { key: alice.key.secret })
    expect(account.body.id).toBe(alice.userId)
    expect(account.body.email).not.toBe(bob.email)
  })

  it('созданное одним аккаунтом не появляется у другого', async () => {
    const created = await call<{ id: string }>('POST', '/api/v1/mocks', {
      key: alice.key.secret,
      body: { httpMethod: 'GET', path: `/custom/alice-${rnd()}`, title: 'Мок Алисы' },
    })
    expect(created.status).toBe(201)

    const bobSees = await call<{ items: Array<{ id: string }> }>('GET', '/api/v1/mocks?limit=100', {
      key: bob.key.secret,
    })
    expect(bobSees.body.items.map((m) => m.id)).not.toContain(created.body.id)
    alien(await call('GET', `/api/v1/mocks/${created.body.id}`, { key: bob.key.secret }), 'мок Алисы у Бориса')

    await call('DELETE', `/api/v1/mocks/${created.body.id}`, { key: alice.key.secret })
  })
})

// ─────────────────────────── 4. Жизненный цикл ───────────────────────────

describe('жизненный цикл мока', () => {
  it('создать, прочитать, изменить, удалить — и после удаления 404', async () => {
    const key = alice.key.secret
    const path = `/custom/lifecycle-${rnd()}`

    const created = await call<{ id: string; status: string; path: string; responseBody: string }>(
      'POST',
      '/api/v1/mocks',
      { key, body: { httpMethod: 'POST', path, title: 'Жизненный цикл', responseBody: '{"ok":true}' } },
    )
    expect(created.status).toBe(201)
    // Свежий мок не отвечает публично, пока автор не посмотрел, что получилось.
    expect(created.body.status).toBe('draft')
    const id = created.body.id

    const read = await call<{ id: string; responseBody: string }>('GET', `/api/v1/mocks/${id}`, { key })
    expect(read.status).toBe(200)
    expect(read.body.responseBody).toBe('{"ok":true}')

    const patched = await call<{ title: string; delayMs: number; responseBody: string }>(
      'PATCH',
      `/api/v1/mocks/${id}`,
      { key, body: { title: 'Изменённый', delayMs: 0 } },
    )
    expect(patched.status).toBe(200)
    expect(patched.body.title).toBe('Изменённый')
    // Непереданные поля не должны затираться значениями по умолчанию.
    expect(patched.body.responseBody).toBe('{"ok":true}')

    const enabled = await call<{ status: string; changed: boolean }>('POST', `/api/v1/mocks/${id}/enable`, { key })
    expect(enabled.body.status).toBe('active')
    expect(enabled.body.changed).toBe(true)
    const again = await call<{ changed: boolean }>('POST', `/api/v1/mocks/${id}/enable`, { key })
    expect(again.body.changed).toBe(false)

    // Повтор пары «метод + путь» — конфликт, а не второй мок по тому же адресу.
    const duplicate = await call('POST', '/api/v1/mocks', {
      key,
      body: { httpMethod: 'POST', path, title: 'Дубль' },
    })
    expect(duplicate.status).toBe(409)

    const deleted = await call<{ ok: boolean; id: string }>('DELETE', `/api/v1/mocks/${id}`, { key })
    expect(deleted.status).toBe(200)
    expect(deleted.body.ok).toBe(true)

    expect((await call('GET', `/api/v1/mocks/${id}`, { key })).status).toBe(404)
    expect((await call('PATCH', `/api/v1/mocks/${id}`, { key, body: { title: 'После смерти' } })).status).toBe(404)
    expect((await call('DELETE', `/api/v1/mocks/${id}`, { key })).status).toBe(404)
    expect(await prisma.customMock.findUnique({ where: { id } })).toBeNull()
  })

  it('вебхук проходит тот же путь, и удаление с непустым журналом требует подтверждения', async () => {
    const key = alice.key.secret

    const created = await call<{ id: string; secret: string; status: string }>('POST', '/api/v1/webhooks', {
      key,
      body: { serviceCode: 'bitrix24', event: 'ONCRMDEALADD', target: 'local', targetPath: '/lifecycle' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id

    const read = await call<{ id: string; event: string }>('GET', `/api/v1/webhooks/${id}`, { key })
    expect(read.status).toBe(200)
    expect(read.body.event).toBe('ONCRMDEALADD')

    const paused = await call<{ status: string }>('PATCH', `/api/v1/webhooks/${id}`, {
      key,
      body: { status: 'paused' },
    })
    expect(paused.body.status).toBe('paused')

    // Тестовая отправка на локальную доставку без агента остаётся в очереди —
    // сеть в тесте не задействована, а запись в журнале доставок появляется.
    const sent = await call<{ deliveryId: string; state: string }>('POST', `/api/v1/webhooks/${id}/test`, { key })
    expect(sent.status).toBe(202)
    expect(sent.body.state).toBe('queued')

    const guarded = await call(`DELETE`, `/api/v1/webhooks/${id}`, { key })
    expect(guarded.status).toBe(409)

    const removed = await call<{ ok: boolean; deletedDeliveries: number }>(
      'DELETE',
      `/api/v1/webhooks/${id}?withDeliveries=true`,
      { key },
    )
    expect(removed.status).toBe(200)
    expect(removed.body.deletedDeliveries).toBeGreaterThan(0)

    expect((await call('GET', `/api/v1/webhooks/${id}`, { key })).status).toBe(404)
    expect(await prisma.webhookDelivery.count({ where: { webhookId: id } })).toBe(0)
  })
})

// ─────────────────────────── 5. Секрет ключа ───────────────────────────

describe('секрет ключа', () => {
  it('выдаётся при создании и при ротации, а в остальных ответах только маска', async () => {
    const key = alice.key.secret
    const name = `секретный ${rnd()}`

    const created = await call<{ id: string; secret: string; mask: string; warning: string }>('POST', '/api/v1/keys', {
      key,
      body: { name, kind: 'server', services: ['bitrix24'] },
    })
    expect(created.status).toBe(201)
    expect(created.body.secret).toMatch(/^stend_sk_[0-9a-f]{32}$/)
    expect(created.body.mask).toContain('••••••')
    const id = created.body.id
    const firstSecret = created.body.secret

    // Выданный секрет обязан работать — иначе «показали один раз» ничего не стоит.
    expect((await call('GET', '/api/v1/account', { key: firstSecret })).status).toBe(200)

    const single = await call<{ mask: string }>('GET', `/api/v1/keys/${id}`, { key })
    expect(single.status).toBe(200)
    expect(single.raw).not.toContain(firstSecret)
    expect(single.body).not.toHaveProperty('secret')
    expect(single.body.mask).toBe(created.body.mask)

    const list = await call('GET', '/api/v1/keys?limit=100', { key })
    expect(list.raw).not.toContain(firstSecret)
    // Ключ в списке узнаётся по маске, и она — единственный его след.
    expect(list.raw).toContain(created.body.mask)

    const rotated = await call<{ id: string; secret: string; self: boolean; replaced: { id: string } }>(
      'POST',
      `/api/v1/keys/${id}/rotate`,
      { key },
    )
    expect(rotated.status).toBe(201)
    expect(rotated.body.secret).toMatch(/^stend_sk_[0-9a-f]{32}$/)
    expect(rotated.body.secret).not.toBe(firstSecret)
    expect(rotated.body.replaced.id).toBe(id)
    expect(rotated.body.self).toBe(false)

    // Старый секрет умирает в тот же миг, новый работает.
    expect((await call('GET', '/api/v1/account', { key: firstSecret })).status).toBe(401)
    expect((await call('GET', '/api/v1/account', { key: rotated.body.secret })).status).toBe(200)

    const afterRotate = await call('GET', `/api/v1/keys/${rotated.body.id}`, { key })
    expect(afterRotate.raw).not.toContain(rotated.body.secret)
  })

  it('секрет подписи вебхука не уходит целой страницей списка', async () => {
    const key = alice.key.secret
    const created = await call<{ id: string; secret: string }>('POST', '/api/v1/webhooks', {
      key,
      body: { serviceCode: 'wildberries', event: 'stocks_changed', target: 'local', targetPath: `/s-${rnd()}` },
    })
    expect(created.status).toBe(201)
    expect(created.body.secret).toMatch(/^stend_whsec_/)

    const list = await call('GET', '/api/v1/webhooks?limit=100', { key })
    expect(list.raw).not.toContain(created.body.secret)

    // В карточке секрет есть намеренно: им проверяют подпись в обработчике.
    const card = await call('GET', `/api/v1/webhooks/${created.body.id}`, { key })
    expect(card.body.secret).toBe(created.body.secret)

    await call('DELETE', `/api/v1/webhooks/${created.body.id}`, { key })
  })

  it('консоль не оставляет ключ песочницы в журнале открытым текстом', async () => {
    // Журнал живёт 30 дней и отдаётся этим же API: попавший в него рабочий ключ
    // означал бы, что чтение логов равно выдаче ключа.
    const key = alice.key.secret
    const sandboxKey = await issueKey(alice.sandboxId, { kind: 'sandbox', name: `консоль ${rnd()}` })

    const executed = await call<{ requestId: string }>('POST', '/api/v1/console/execute', {
      key,
      body: {
        serviceCode: 'ozon',
        httpMethod: 'POST',
        path: '/v3/posting/fbs/list',
        headers: { 'api-key': sandboxKey.secret },
        body: { auth: sandboxKey.secret, filter: {} },
      },
    })
    expect(executed.status).toBe(200)

    const card = await call('GET', `/api/v1/logs/${executed.body.requestId}`, { key })
    expect(card.status).toBe(200)
    expect(card.raw).not.toContain(sandboxKey.secret)
    // Начало и хвост остаются: свой ключ надо узнавать в списке.
    expect(card.raw).toContain(`${sandboxKey.secret.slice(0, 14)}••••${sandboxKey.secret.slice(-4)}`)

    await call('POST', '/api/v1/logs/clear', { key, body: { confirm: true } })
  })

  it('секрета нет и в журнале использования: запись хранит только ссылку на ключ', async () => {
    const key = alice.key.secret
    const created = await call<{ id: string; secret: string }>('POST', '/api/v1/keys', {
      key,
      body: { name: `в базе ${rnd()}`, kind: 'server', services: ['bitrix24'] },
    })
    const row = await prisma.apiKey.findUnique({ where: { id: created.body.id } })
    // В базе лежит HMAC, восстановить ключ нечем — потому и «показать ещё раз» нет.
    expect(row?.keyHash).not.toContain(created.body.secret)
    expect(JSON.stringify(row)).not.toContain(created.body.secret)
  })
})

// ─────────────────────────── 6. Ограничение частоты ───────────────────────────

describe('ограничение частоты', () => {
  it('на превышении отвечает 429 с Retry-After и заголовками остатка', async () => {
    // Ведро принадлежит ключу, поэтому лимит выбирается отдельным ключом
    // и остальные тесты этого файла его не замечают — в каком бы порядке
    // они ни выполнялись.
    const victim = await issueKey(alice.sandboxId, { name: `лимит ${rnd()}` })
    const limit = env.mgmtRateLimitPerMin

    const first = await call('GET', '/api/v1/account', { key: victim.secret })
    expect(first.status).toBe(200)
    expect(Number(first.headers['x-ratelimit-limit'])).toBe(limit)
    expect(Number(first.headers['x-ratelimit-remaining'])).toBeLessThan(limit)

    let limited: Reply | null = null
    // Потолок итераций с запасом: ведро пополняется во время самого перебора.
    for (let i = 0; i < limit * 2 + 20; i += 1) {
      const res = await call('GET', '/api/v1/account', { key: victim.secret })
      if (res.status === 429) {
        limited = res
        break
      }
      expect(res.status).toBe(200)
    }

    expect(limited, 'лимит частоты так и не сработал').not.toBeNull()
    expect(limited!.body.error).toBe('RATE_LIMITED')
    const retryAfter = Number(limited!.headers['retry-after'])
    expect(Number.isFinite(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(Number(limited!.headers['x-ratelimit-remaining'])).toBe(0)
  })

  it('исчерпанный ключ не мешает соседнему: ведро считается по субъекту', async () => {
    const neighbour = await issueKey(alice.sandboxId, { name: `сосед ${rnd()}` })
    const res = await call('GET', '/api/v1/account', { key: neighbour.secret })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────── 7. OpenAPI ───────────────────────────

/** Все маршруты, объявленные в routes/v1. Расхождение с документом — ошибка. */
const DECLARED_OPERATIONS = [
  'GET /account', 'PATCH /account', 'DELETE /account',
  'POST /account/password', 'GET /account/sessions',
  'DELETE /account/sessions/{id}', 'POST /account/sessions/revoke-all',
  'GET /sandboxes', 'POST /sandboxes', 'GET /sandboxes/{sandboxId}',
  'PATCH /sandboxes/{sandboxId}', 'DELETE /sandboxes/{sandboxId}',
  'POST /sandboxes/{sandboxId}/reset',
  'GET /keys', 'POST /keys', 'GET /keys/{id}', 'PATCH /keys/{id}',
  'DELETE /keys/{id}', 'POST /keys/{id}/rotate', 'POST /keys/{id}/revoke',
  'GET /webhooks', 'POST /webhooks', 'GET /webhooks/{id}', 'PATCH /webhooks/{id}',
  'DELETE /webhooks/{id}', 'POST /webhooks/{id}/test', 'GET /webhooks/{id}/deliveries',
  'POST /webhooks/retry-failed', 'GET /deliveries/{id}', 'POST /deliveries/{id}/retry',
  'GET /scenarios', 'POST /scenarios', 'GET /scenarios/{id}', 'PATCH /scenarios/{id}',
  'DELETE /scenarios/{id}', 'POST /scenarios/{id}/run',
  'GET /bursts', 'POST /bursts', 'GET /bursts/{id}', 'POST /bursts/{id}/stop',
  'GET /mocks', 'POST /mocks', 'GET /mocks/{id}', 'PATCH /mocks/{id}', 'DELETE /mocks/{id}',
  'POST /mocks/{id}/enable', 'POST /mocks/{id}/disable', 'POST /mocks/import', 'POST /mocks/preview',
  'GET /logs', 'GET /logs/export', 'GET /logs/{id}', 'POST /logs/clear',
  'GET /usage', 'GET /alerts', 'POST /alerts/{id}/read', 'POST /console/execute',
  'GET /services', 'GET /methods', 'GET /methods/{id}', 'GET /events',
  'GET /apps', 'POST /apps', 'GET /apps/{id}', 'PATCH /apps/{id}', 'DELETE /apps/{id}',
  'GET /tunnel/status',
] as const

describe('openapi.json', () => {
  interface OpenApiDoc {
    openapi: string
    info: { title: string; version: string }
    servers: Array<{ url: string }>
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }
    paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown>; parameters?: Array<{ name: string; in: string }> }>>
  }

  const load = async (): Promise<OpenApiDoc> => {
    const res = await call<OpenApiDoc>('GET', '/api/v1/openapi.json')
    expect(res.status).toBe(200)
    return res.body
  }

  it('отдаётся без авторизации: клиент идёт за спецификацией до того, как у него есть ключ', async () => {
    const doc = await load()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toContain('APIStend')
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth')
    expect(doc.components.securitySchemes).toHaveProperty('cookieAuth')
    expect(doc.servers[0]?.url.endsWith('/api/v1')).toBe(true)
  })

  it('содержит ровно те маршруты, которые объявлены в коде', async () => {
    const doc = await load()
    const operations: string[] = []
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) operations.push(`${method.toUpperCase()} ${path}`)
    }

    expect([...operations].sort()).toEqual([...DECLARED_OPERATIONS].sort())

    // Реестр — единственный источник и для документа, и для счётчика в /meta:
    // расхождение означало бы, что какой-то маршрут не попал в один из них.
    const meta = await call<{ routes: number; prefix: string }>('GET', '/api/v1/meta')
    expect(meta.status).toBe(200)
    expect(meta.body.routes).toBe(operations.length)
    expect(meta.body.prefix).toBe('/api/v1')
  })

  it('не занимает адреса библиотеки BX24.js', async () => {
    const doc = await load()
    // Пустой путь и «/» отдают BX24.js; маршрут с таким путём перекрыл бы её.
    expect(Object.keys(doc.paths)).not.toContain('')
    expect(Object.keys(doc.paths)).not.toContain('/')
  })

  it('ни одной битой ссылки $ref', async () => {
    const doc = await load()
    const refs: Array<{ where: string; target: string }> = []
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${where}[${i}]`))
        return
      }
      if (!node || typeof node !== 'object') return
      for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
        if (name === '$ref' && typeof value === 'string') refs.push({ where, target: value })
        else walk(value, `${where}.${name}`)
      }
    }
    walk(doc, '$')

    expect(refs.length).toBeGreaterThan(0)
    const broken = refs.filter((ref) => {
      if (!ref.target.startsWith('#/components/schemas/')) return true
      return !(ref.target.slice('#/components/schemas/'.length) in doc.components.schemas)
    })
    // Ссылки вида «#/$defs/…» zod складывает внутрь схемы, и в документе OpenAPI
    // они указывают в корень, то есть в никуда: генератор клиента на такой падает.
    expect(broken.map((b) => `${b.where} -> ${b.target}`)).toEqual([])
  })

  it('у каждой операции уникальный operationId, описанные ошибки и параметры пути', async () => {
    const doc = await load()
    const ids: string[] = []

    for (const [path, item] of Object.entries(doc.paths)) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
      for (const [method, operation] of Object.entries(item)) {
        const at = `${method.toUpperCase()} ${path}`
        expect(operation.operationId, at).toBeTruthy()
        ids.push(operation.operationId)

        // Без 401/403/429 в спецификации сгенерированный клиент не отличит
        // «нет прав» от «сервер сломался».
        for (const code of ['401', '403', '429']) expect(Object.keys(operation.responses), at).toContain(code)
        const success = Object.keys(operation.responses).filter((c) => c.startsWith('2'))
        expect(success.length, at).toBe(1)

        const declared = (operation.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name)
        for (const name of inPath) expect(declared, `${at}: параметр ${name}`).toContain(name)
      }
    }

    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })
})

describe('правки по итогам ревью', () => {
  it('негодный курсор отвечает 400, а не пустой страницей', async () => {
    const ok = await call('GET', '/api/v1/keys?limit=1', { key: alice.key.secret })
    expect(ok.status).toBe(200)

    const bad = await call('GET', '/api/v1/keys?cursor=нет-такого-ключа', { key: alice.key.secret })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('VALIDATION')

    // Чужой курсор неотличим от несуществующего — и это важнее краткости ответа:
    // иначе по коду ответа можно было бы проверять существование чужих записей.
    const foreignCursor = await call('GET', `/api/v1/keys?cursor=${foreign.keyId}`, { key: alice.key.secret })
    expect(foreignCursor.status).toBe(400)
  })

  it('годный курсор листает без потерь и повторов', async () => {
    const names = ['курсор-1', 'курсор-2', 'курсор-3']
    for (const name of names) await issueKey(alice.sandboxId, { name })

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const url: string = `/api/v1/keys?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const page = await call<{ items: { id: string }[]; nextCursor: string | null }>('GET', url, {
        key: alice.key.secret,
      })
      expect(page.status).toBe(200)
      seen.push(...page.body.items.map((k) => k.id))
      cursor = page.body.nextCursor
      if (!cursor) break
    }

    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBeGreaterThanOrEqual(names.length)
  })

  it('уведомление помечается прочитанным один раз', async () => {
    const alert = await prisma.alert.create({
      data: {
        sandboxId: alice.sandboxId,
        severity: 'warning',
        title: 'Тестовое уведомление',
        meta: 'для проверки прочитанности',
        icon: 'key',
      },
    })

    const unreadBefore = await call<{ items: { id: string }[] }>(
      'GET', '/api/v1/alerts?unreadOnly=true', { key: alice.key.secret },
    )
    expect(unreadBefore.body.items.map((a) => a.id)).toContain(alert.id)

    const first = await call<{ readAt: string; alreadyRead: boolean }>(
      'POST', `/api/v1/alerts/${alert.id}/read`, { key: alice.key.secret },
    )
    expect(first.status).toBe(200)
    expect(first.body.alreadyRead).toBe(false)

    const again = await call<{ readAt: string; alreadyRead: boolean }>(
      'POST', `/api/v1/alerts/${alert.id}/read`, { key: alice.key.secret },
    )
    expect(again.body.alreadyRead).toBe(true)
    // Время первого прочтения не переписывается: иначе опрос в цикле стирал бы его.
    expect(again.body.readAt).toBe(first.body.readAt)

    const unreadAfter = await call<{ items: { id: string }[] }>(
      'GET', '/api/v1/alerts?unreadOnly=true', { key: alice.key.secret },
    )
    expect(unreadAfter.body.items.map((a) => a.id)).not.toContain(alert.id)

    // Чужое уведомление недоступно даже по точному идентификатору.
    const foreignRead = await call('POST', `/api/v1/alerts/${alert.id}/read`, { key: bob.key.secret })
    expect(foreignRead.status).toBe(404)
  })

  it('приложение с внутренним адресом не заводится', async () => {
    const allowed = env.allowPrivateWebhookTargets
    if (allowed) {
      // В разработке приватные адреса разрешены намеренно (приложение живёт на localhost),
      // и проверять здесь нечего: запрет включается только в общем сервисе.
      return
    }
    const created = await call('POST', '/api/v1/apps', {
      key: alice.key.secret,
      body: {
        title: 'SSRF',
        kind: 'server_ui',
        scope: ['crm'],
        handlerUrl: 'http://169.254.169.254/latest/meta-data/',
      },
    })
    expect(created.status).toBe(400)
  })

  it('ротация ключа из кабинета не расширяет права', async () => {
    const limited = await call<{ id: string }>('POST', '/api/v1/keys', {
      key: alice.key.secret,
      body: {
        name: `ограниченный ${rnd()}`,
        kind: 'server',
        services: ['ozon'],
        scopes: ['logs:read'],
      },
    })
    expect(limited.status).toBe(201)

    const source = await prisma.apiKey.findUniqueOrThrow({ where: { id: limited.body.id } })
    expect(source.scopes).toEqual(['logs:read'])

    // Кабинетная ротация идёт по сессии, поэтому проверяем через сам маршрут кабинета.
    const login = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: alice.email, password: PASSWORD },
    })
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0]
    const cabinet = await call<{ key: { id: string } }>(
      'POST', `/api/keys/${limited.body.id}/rotate`, { cookie },
    )
    expect(cabinet.status).toBe(201)

    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: cabinet.body.key.id } })
    expect(after.scopes).toEqual(['logs:read'])
  })
})
