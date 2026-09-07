import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { invalidateAppTokenCache } from '../src/b24/tokens.ts'

/**
 * Локальные приложения Bitrix24.
 *
 * Проверяется не «работает ли раздел», а совпадение с боевым порталом в том,
 * от чего зависит переносимость приложения: состав полей во фрейме, конверт OAuth,
 * одноразовость кода, ротация refresh-токена и правило «до installFinish
 * приложение не установлено — событий нет, виджетов нет».
 */

let api: Awaited<ReturnType<typeof buildServer>>
let apiBase: string
let cookie: string
let sandboxId: string
let userId: string

let receiver: Server
let receiverBase: string
let hits: Array<{ path: string; body: string; contentType: string }> = []

const PASSWORD = 'apistend-e2e-2026'

beforeAll(async () => {
  api = await buildServer()
  await api.listen({ port: 0, host: '127.0.0.1' })
  const addr = api.server.address()
  if (!addr || typeof addr === 'string') throw new Error('нет адреса сервера')
  apiBase = `http://127.0.0.1:${addr.port}`

  // Локальное приложение разработчика: принимает установку и события.
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      hits.push({
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(req.headers['content-type'] ?? ''),
      })
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>ok</body></html>')
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  const rAddr = receiver.address()
  if (!rAddr || typeof rAddr === 'string') throw new Error('нет адреса приложения')
  receiverBase = `http://127.0.0.1:${rAddr.port}`

  const email = `b24app-${randomBytes(4).toString('hex')}@test.local`
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
      name: 'Тест Приложений',
      initials: 'ТП',
    },
  })
  userId = user.id
  const sandbox = await prisma.sandbox.create({
    data: { userId: user.id, name: 'b24app-test', project: 'e2e' },
  })
  sandboxId = sandbox.id

  const login = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  expect(login.status).toBe(200)
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  expect(cookie).toContain('apistend_session')
})

afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()))
  await api.close()
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { sandboxId } })
  await prisma.webhook.deleteMany({ where: { sandboxId } })
  await prisma.b24App.deleteMany({ where: { sandboxId } })
  invalidateAppTokenCache()
  hits = []
})

async function cabinet<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${apiBase}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, data: (await response.json()) as T }
}

/** Вызов REST портала так, как его делает приложение: токен в теле POST. */
async function rest(
  method: string,
  token: string,
  params: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new URLSearchParams({ auth: token, ...params })
  const response = await fetch(`${apiBase}/rest/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function createApp(overrides: Record<string, unknown> = {}) {
  const { status, data } = await cabinet<{ app: Record<string, unknown> }>('/api/b24/apps', {
    title: 'Тестовое приложение',
    kind: 'server_ui',
    scope: ['crm', 'placement'],
    handlerUrl: `${receiverBase}/handler`,
    installUrl: `${receiverBase}/install`,
    ...overrides,
  })
  expect(status).toBe(201)
  return data.app
}

async function openFrame(appId: string, body: Record<string, unknown> = {}) {
  const { status, data } = await cabinet<{
    appSid: string; action: string; install: boolean; fields: Record<string, string>
  }>(`/api/b24/apps/${appId}/open`, body)
  expect(status).toBe(200)
  return data
}

const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('условие не выполнилось за отведённое время')
}

describe('регистрация приложения', () => {
  it('выдаёт client_id и client_secret в боевом формате', async () => {
    const app = await createApp()
    // local.<14 hex>.<8 цифр> — формат, по которому приложения отличают
    // локальную установку от тиражной.
    expect(app.clientId).toMatch(/^local\.[0-9a-f]{14}\.\d{8}$/)
    expect(String(app.clientSecret)).toHaveLength(50)
    expect(String(app.applicationToken)).toMatch(/^[0-9a-f]{32}$/)
    expect(app.state).toBe('awaiting_install')
  })

  it('требует путь обработчика у приложения с интерфейсом', async () => {
    const { status, data } = await cabinet('/api/b24/apps', {
      title: 'Без обработчика', kind: 'server_ui', scope: ['crm'],
    })
    expect(status).toBe(400)
    expect(JSON.stringify(data)).toContain('путь обработчика')
  })

  it('отвергает неизвестные права', async () => {
    const { status, data } = await cabinet('/api/b24/apps', {
      title: 'Странные права', kind: 'server_ui', scope: ['crm', 'wat'],
      handlerUrl: `${receiverBase}/handler`,
    })
    expect(status).toBe(400)
    expect(JSON.stringify(data)).toContain('wat')
  })
})

describe('открытие во фрейме', () => {
  it('отдаёт ровно тот набор полей, что и боевой портал', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))

    // Первое открытие — мастер установки, а не обработчик.
    expect(opened.install).toBe(true)
    expect(opened.action.startsWith(`${receiverBase}/install`)).toBe(true)

    // Часть параметров боевой портал кладёт в query-строку, часть — в тело.
    const url = new URL(opened.action)
    expect(url.searchParams.get('DOMAIN')).toBeTruthy()
    expect(url.searchParams.get('PROTOCOL')).toBe('0')
    expect(url.searchParams.get('LANG')).toBe('ru')
    expect(url.searchParams.get('APP_SID')).toBe(opened.appSid)

    expect(Object.keys(opened.fields).sort()).toEqual([
      'APPLICATION_SCOPE', 'APPLICATION_TOKEN', 'AUTH_EXPIRES', 'AUTH_ID',
      'PLACEMENT', 'PLACEMENT_OPTIONS', 'REFRESH_ID', 'SERVER_ENDPOINT',
      'member_id', 'status',
    ])
    expect(opened.fields.AUTH_EXPIRES).toBe('3600')
    expect(opened.fields.status).toBe('L')
    expect(opened.fields.PLACEMENT).toBe('DEFAULT')
    // PLACEMENT_OPTIONS приходит СТРОКОЙ с JSON внутри, а не объектом.
    expect(typeof opened.fields.PLACEMENT_OPTIONS).toBe('string')
    expect(JSON.parse(opened.fields.PLACEMENT_OPTIONS!)).toHaveProperty('URI')
  })

  it('после установки открывает обработчик, а не мастер', async () => {
    const app = await createApp()
    const first = await openFrame(String(app.id))
    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: first.appSid })

    const second = await openFrame(String(app.id))
    expect(second.install).toBe(false)
    expect(second.action.startsWith(`${receiverBase}/handler`)).toBe(true)
  })

  it('кладёт контекст карточки в PLACEMENT_OPTIONS', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id), {
      placement: 'CRM_DEAL_DETAIL_TAB',
      placementOptions: { ID: '7405' },
      install: false,
    })
    const options = JSON.parse(opened.fields.PLACEMENT_OPTIONS!) as Record<string, string>
    expect(options.ID).toBe('7405')
    expect(options.URI).toBe('/crm/deal/details/7405/')
  })

  it('отказывает приложению без интерфейса', async () => {
    const app = await createApp({
      kind: 'api_only', handlerUrl: null, installUrl: `${receiverBase}/install`,
    })
    const { status } = await cabinet(`/api/b24/apps/${app.id}/open`, {})
    expect(status).toBe(400)
  })
})

describe('REST в контексте приложения', () => {
  it('app.info показывает INSTALLED: false до installFinish', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))

    const before = await rest('app.info', opened.fields.AUTH_ID!)
    expect((before.body.result as Record<string, unknown>).INSTALLED).toBe(false)
    expect((before.body.result as Record<string, unknown>).STATUS).toBe('L')

    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: opened.appSid })
    invalidateAppTokenCache()

    const after = await rest('app.info', opened.fields.AUTH_ID!)
    expect((after.body.result as Record<string, unknown>).INSTALLED).toBe(true)
  })

  it('отвечает insufficient_scope на метод вне выданных прав', async () => {
    const app = await createApp({ scope: ['crm'] })
    const opened = await openFrame(String(app.id))

    const result = await rest('task.item.list', opened.fields.AUTH_ID!)
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('insufficient_scope')
  })

  it('отвечает expired_token на истёкший токен', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))

    await prisma.b24AppToken.updateMany({
      where: { accessToken: opened.fields.AUTH_ID },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })
    invalidateAppTokenCache()

    const result = await rest('app.info', opened.fields.AUTH_ID!)
    expect(result.status).toBe(401)
    // Именно этой ошибки документация велит дождаться перед обновлением пары.
    expect(result.body.error).toBe('expired_token')
  })

  it('отвечает NO_AUTH_FOUND на неизвестный токен', async () => {
    const result = await rest('app.info', 'a'.repeat(32))
    expect(result.status).toBe(401)
    expect(String(result.body.error)).toBe('NO_AUTH_FOUND')
  })

  it('регистрирует и отдаёт виджеты', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    const token = opened.fields.AUTH_ID!

    const bound = await rest('placement.bind', token, {
      PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
      HANDLER: `${receiverBase}/handler`,
      TITLE: 'Вкладка приложения',
    })
    expect(bound.body.result).toBe(true)

    const list = await rest('placement.get', token)
    const rows = list.body.result as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.placement).toBe('CRM_DEAL_DETAIL_TAB')
    expect(rows[0]!.title).toBe('Вкладка приложения')

    const removed = await rest('placement.unbind', token, { PLACEMENT: 'CRM_DEAL_DETAIL_TAB' })
    // Боевой count считает запись дважды: при поиске и после удаления.
    expect((removed.body.result as Record<string, unknown>).count).toBe(2)
  })

  it('отвергает точку встраивания, право на которую не выдано', async () => {
    const app = await createApp({ scope: ['crm', 'placement'] })
    const opened = await openFrame(String(app.id))

    const bound = await rest('placement.bind', opened.fields.AUTH_ID!, {
      PLACEMENT: 'TASK_VIEW_TAB',
      HANDLER: `${receiverBase}/handler`,
    })
    expect(bound.body.error).toBe('ERROR_PLACEMENT_NOT_FOUND')
  })

  it('выполняет пакетный вызов', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))

    const response = await fetch(`${apiBase}/rest/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        auth: opened.fields.AUTH_ID!,
        halt: '0',
        'cmd[info]': 'app.info',
        'cmd[me]': 'profile',
      }).toString(),
    })
    const body = (await response.json()) as { result: { result: Record<string, unknown> } }
    expect(Object.keys(body.result.result).sort()).toEqual(['info', 'me'])
    expect((body.result.result.me as Record<string, unknown>).ADMIN).toBe(true)
  })

  it('обычные методы по-прежнему отвечает движок', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))

    const result = await rest('crm.deal.list', opened.fields.AUTH_ID!)
    expect(result.status).toBe(200)
    expect(Array.isArray(result.body.result)).toBe(true)
  })
})

describe('сервер авторизации', () => {
  it('проводит полный цикл OAuth и гасит код после обмена', async () => {
    const app = await createApp()

    const authorize = await fetch(
      `${apiBase}/oauth/authorize/?client_id=${app.clientId}&state=st42`,
      { redirect: 'manual' },
    )
    expect(authorize.status).toBe(302)
    const location = new URL(authorize.headers.get('location')!)
    expect(location.searchParams.get('state')).toBe('st42')
    const code = location.searchParams.get('code')!

    const exchanged = await fetch(
      `${apiBase}/oauth/token/?grant_type=authorization_code&client_id=${app.clientId}` +
        `&client_secret=${app.clientSecret}&code=${code}`,
    )
    const tokens = (await exchanged.json()) as Record<string, unknown>
    expect(Object.keys(tokens).sort()).toEqual([
      'access_token', 'client_endpoint', 'domain', 'expires', 'expires_in',
      'member_id', 'refresh_token', 'scope', 'server_endpoint', 'status', 'user_id',
    ])
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.status).toBe('L')

    // Код одноразовый: боевой сервер отвечает на повтор invalid_grant.
    const again = await fetch(
      `${apiBase}/oauth/token/?grant_type=authorization_code&client_id=${app.clientId}` +
        `&client_secret=${app.clientSecret}&code=${code}`,
    )
    expect(((await again.json()) as Record<string, unknown>).error).toBe('invalid_grant')
  })

  it('обновляет пару и гасит прежний refresh_token', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    const oldRefresh = opened.fields.REFRESH_ID!

    const refreshed = await fetch(
      `${apiBase}/oauth/token/?grant_type=refresh_token&client_id=${app.clientId}` +
        `&client_secret=${app.clientSecret}&refresh_token=${oldRefresh}`,
    )
    const pair = (await refreshed.json()) as Record<string, string>
    expect(pair.access_token).not.toBe(opened.fields.AUTH_ID)
    expect(pair.refresh_token).not.toBe(oldRefresh)

    // Документация требует сохранить новый refresh вместо старого — мок, который
    // продолжает принимать старый, скрыл бы ошибку хранения.
    const reused = await fetch(
      `${apiBase}/oauth/token/?grant_type=refresh_token&client_id=${app.clientId}` +
        `&client_secret=${app.clientSecret}&refresh_token=${oldRefresh}`,
    )
    expect(((await reused.json()) as Record<string, unknown>).error).toBe('invalid_grant')
  })

  it('не выдаёт токены по неверному секрету', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    const response = await fetch(
      `${apiBase}/oauth/token/?grant_type=refresh_token&client_id=${app.clientId}` +
        `&client_secret=wrong&refresh_token=${opened.fields.REFRESH_ID}`,
    )
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_client')
  })
})

describe('события приложения', () => {
  it('шлёт ONAPPINSTALL с рабочим токеном в auth[]', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: opened.appSid })

    await waitFor(() => hits.some((h) => h.body.includes('ONAPPINSTALL')))
    const hit = hits.find((h) => h.body.includes('ONAPPINSTALL'))!
    expect(hit.contentType).toContain('application/x-www-form-urlencoded')

    const params = new URLSearchParams(hit.body)
    expect(params.get('event')).toBe('ONAPPINSTALL')
    expect(params.get('auth[application_token]')).toBe(app.applicationToken)
    // Приложению без интерфейса это единственный источник авторизации, поэтому
    // ONAPPINSTALL — единственное событие, которое несёт ещё и refresh_token.
    expect(params.get('auth[access_token]')).toMatch(/^[a-z0-9]{32}$/)
    expect(params.get('auth[refresh_token]')).toMatch(/^[a-z0-9]{32}$/)
    expect(params.get('auth[client_endpoint]')).toContain('/rest/')
    expect(params.get('data[INSTALLED]')).toBe('Y')
  })

  it('доставляет событие подписки, созданной через event.bind', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    const token = opened.fields.AUTH_ID!

    const bound = await rest('event.bind', token, {
      event: 'ONCRMDEALUPDATE',
      handler: `${receiverBase}/events`,
    })
    expect(bound.body.result).toBe(true)

    const listed = await rest('event.get', token)
    expect((listed.body.result as unknown[]).length).toBe(1)

    const webhook = await prisma.webhook.findFirstOrThrow({ where: { appId: String(app.id) } })
    await fetch(`${apiBase}/api/webhooks/${webhook.id}/test`, { method: 'POST', headers: { cookie } })

    await waitFor(() => hits.some((h) => h.path === '/events'))
    const params = new URLSearchParams(hits.find((h) => h.path === '/events')!.body)
    expect(params.get('event')).toBe('ONCRMDEALUPDATE')
    expect(params.get('auth[access_token]')).toMatch(/^[a-z0-9]{32}$/)
    // У обычного события refresh_token не приходит — так же, как в бою.
    expect(params.get('auth[refresh_token]')).toBeNull()
  })

  it('шлёт ONAPPUNINSTALL без токенов при удалении', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: opened.appSid })
    await waitFor(() => hits.some((h) => h.body.includes('ONAPPINSTALL')))

    await cabinet(`/api/b24/apps/${app.id}/delete`, {})
    await waitFor(() => hits.some((h) => h.body.includes('ONAPPUNINSTALL')))

    const params = new URLSearchParams(hits.find((h) => h.body.includes('ONAPPUNINSTALL'))!.body)
    // Права уже сняты: обращаться к API от имени приложения нельзя, и токенов нет.
    expect(params.get('auth[access_token]')).toBeNull()
    expect(params.get('auth[application_token]')).toBe(app.applicationToken)

    // Запись об уходе события обязана пережить удаление приложения: за ней
    // пользователь и приходит в журнал сразу после удаления.
    const logged = await prisma.webhookDelivery.findMany({
      where: { sandboxId, event: { in: ['ONAPPINSTALL', 'ONAPPUNINSTALL'] } },
    })
    expect(logged.map((d) => d.event).sort()).toEqual(['ONAPPINSTALL', 'ONAPPUNINSTALL'])
  })

  it('не показывает события жизненного цикла среди подписок', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: opened.appSid })
    await waitFor(() => hits.some((h) => h.body.includes('ONAPPINSTALL')))

    // ONAPPINSTALL приходит на адрес из карточки, а не на подписку: приложение
    // его не регистрировало, и event.get о нём знать не должен.
    const listed = await rest('event.get', opened.fields.AUTH_ID!)
    expect(listed.body.result).toEqual([])

    const { data } = await cabinet<{ app: { handlersCount: number; handlers: unknown[] } }>(
      `/api/b24/apps/${app.id}`,
    )
    expect(data.app.handlersCount).toBe(0)
    expect(data.app.handlers).toEqual([])
  })
})

describe('портал', () => {
  it('не показывает виджеты, пока установка не завершена', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    await rest('placement.bind', opened.fields.AUTH_ID!, {
      PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
      HANDLER: `${receiverBase}/handler`,
      TITLE: 'Вкладка',
    })

    const before = await cabinet<{ widgets: Record<string, unknown[]> }>('/api/b24/portal')
    // Регистрация прошла и видна в placement.get, но трафика нет — ровно как в бою.
    expect(before.data.widgets.CRM_DEAL_DETAIL_TAB).toBeUndefined()

    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: opened.appSid })

    const after = await cabinet<{ widgets: Record<string, unknown[]> }>('/api/b24/portal')
    expect(after.data.widgets.CRM_DEAL_DETAIL_TAB).toHaveLength(1)
  })

  it('сбрасывает установку вместе с виджетами и подписками', async () => {
    const app = await createApp()
    const opened = await openFrame(String(app.id))
    await rest('placement.bind', opened.fields.AUTH_ID!, {
      PLACEMENT: 'CRM_DEAL_DETAIL_TAB', HANDLER: `${receiverBase}/handler`,
    })
    await cabinet(`/api/b24/apps/${app.id}/install-finish`, { appSid: opened.appSid })

    const { data } = await cabinet<{ app: Record<string, unknown> }>(`/api/b24/apps/${app.id}/reinstall`, {})
    expect(data.app.state).toBe('awaiting_install')
    expect(data.app.placementsCount).toBe(0)
    expect(await prisma.b24AppPlacement.count({ where: { appId: String(app.id) } })).toBe(0)
  })
})

describe('библиотека BX24.js', () => {
  it('отдаётся без авторизации и с разрешённым CORS', async () => {
    const response = await fetch(`${apiBase}/api/v1/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')

    const source = await response.text()
    // Поверхность, на которую опирается любое приложение Bitrix24.
    for (const method of ['callMethod', 'callBatch', 'installFinish', 'fitWindow', 'placement']) {
      expect(source).toContain(method)
    }
  })
})
