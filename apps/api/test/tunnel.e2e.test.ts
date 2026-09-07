import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listen } from 'apistend'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey } from '../src/lib/keys.ts'

/**
 * Сквозной тест доставки на localhost.
 *
 * Публичный домен для этого не нужен в принципе: весь трафик инициирует агент.
 * Поднимаем настоящий сервер APIStend, настоящий CLI (через программный API)
 * и фейковое приложение разработчика — всё в одном процессе, порты нулевые.
 */

interface Received {
  path: string
  method: string
  contentType: string
  body: string
  headers: Record<string, string | string[] | undefined>
}

let api: Awaited<ReturnType<typeof buildServer>>
let apiBase: string
let app: Server
let appBase: string
let received: Received[] = []
/** Чем ответит фейковое приложение на следующий запрос. */
let appBehaviour: { status: number; body: string; delayMs?: number } = { status: 200, body: '{"result":true}' }

let sandboxId: string
let serverKey: string

beforeAll(async () => {
  api = await buildServer()
  await api.listen({ port: 0, host: '127.0.0.1' })
  const addr = api.server.address()
  if (!addr || typeof addr === 'string') throw new Error('нет адреса сервера')
  apiBase = `http://127.0.0.1:${addr.port}`

  app = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        method: req.method ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      })
      const reply = () => {
        res.writeHead(appBehaviour.status, { 'content-type': 'application/json' })
        res.end(appBehaviour.body)
      }
      if (appBehaviour.delayMs) setTimeout(reply, appBehaviour.delayMs)
      else reply()
    })
  })
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  const appAddr = app.address()
  if (!appAddr || typeof appAddr === 'string') throw new Error('нет адреса приложения')
  appBase = `127.0.0.1:${appAddr.port}`

  // Отдельный аккаунт под тест: чужие данные не трогаем.
  const user = await prisma.user.create({
    data: {
      email: `tunnel-${randomBytes(4).toString('hex')}@test.local`,
      passwordHash: 'x', name: 'Тест Туннеля', initials: 'ТТ',
    },
  })
  const sandbox = await prisma.sandbox.create({
    data: { userId: user.id, name: 'tunnel-test', project: 'e2e' },
  })
  sandboxId = sandbox.id

  const key = generateKey('server')
  serverKey = key.full
  await prisma.apiKey.create({
    data: {
      sandboxId, name: 'e2e', kind: 'server',
      prefix: key.prefix, suffix: key.suffix, keyHash: key.hash,
      services: ['bitrix24', 'ozon', 'wildberries'],
    },
  })
})

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()))
  await api.close()
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } })
  if (sandbox) await prisma.user.delete({ where: { id: sandbox.userId } })
  await prisma.$disconnect()
})

/**
 * Каждый кейс стартует с чистой очередью.
 *
 * Без этого недоставленные события предыдущего теста (у Ozon и WB есть повторы)
 * досылаются в следующем и ломают его — ровно так же, как сломали бы работу
 * пользователя, если бы очередь не изолировали по песочницам.
 */
beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { sandboxId } })
  await prisma.webhook.deleteMany({ where: { sandboxId } })
  received = []
})

/** Создаёт вебхук с локальной доставкой и возвращает его id. */
async function createLocalWebhook(serviceCode: string, event: string, path: string): Promise<string> {
  const w = await prisma.webhook.create({
    data: {
      sandboxId, serviceCode, event, target: 'local', targetPath: path,
      secret: `stend_whsec_${randomBytes(8).toString('hex')}`,
    },
  })
  return w.id
}

/** Поднимает агента, ждёт условия, останавливает. */
async function withAgent(fn: () => Promise<void>, forwardPath = '/webhooks'): Promise<void> {
  const controller = new AbortController()
  const running = listen({
    apiKey: serverKey,
    apiBase,
    forward: `${appBase}${forwardPath}`,
    version: '1.4.2-test',
    json: true,
    signal: controller.signal,
  })
  // Даём сессии установиться.
  await waitFor(async () => {
    const res = await fetch(`${apiBase}/v1/tunnel/status`, { headers: { authorization: `Bearer ${serverKey}` } })
    return ((await res.json()) as { connected: boolean }).connected
  })
  try {
    await fn()
  } finally {
    controller.abort()
    await running.catch(() => undefined)
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('условие не наступило за отведённое время')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const triggerDelivery = (webhookId: string) =>
  fetch(`${apiBase}/api/webhooks/${webhookId}/test`, { method: 'POST' })

describe('доставка на localhost', () => {
  it('событие Bitrix24 приходит в приложение в form-urlencoded, а не JSON', async () => {
    received = []
    appBehaviour = { status: 200, body: 'ok' }
    const id = await createLocalWebhook('bitrix24', 'ONCRMDEALADD', '/bitrix/deal')

    await withAgent(async () => {
      const { dispatchWebhook } = await import('../src/webhooks/dispatcher.ts')
      await dispatchWebhook({ sandboxId, webhookId: id, isTest: true })
      await waitFor(() => received.length > 0)
    })

    const got = received[0]!
    expect(got.path).toBe('/webhooks/bitrix/deal')
    expect(got.contentType).toBe('application/x-www-form-urlencoded')
    // Дословно как боевой портал: PHP-скобки и только идентификатор объекта.
    expect(got.body).toContain('event=ONCRMDEALADD')
    expect(got.body).toContain('data%5BFIELDS%5D%5BID%5D=')
    expect(got.body).toContain('auth%5Bapplication_token%5D=')
    // Значений полей сделки в событии нет — клиент обязан дёрнуть crm.deal.get.
    expect(got.body).not.toContain('TITLE')
  })

  it('событие Ozon приходит JSON с дискриминатором message_type', async () => {
    received = []
    appBehaviour = { status: 200, body: '{"result":true}' }
    const id = await createLocalWebhook('ozon', 'TYPE_NEW_POSTING', '/ozon/orders')

    await withAgent(async () => {
      const { dispatchWebhook } = await import('../src/webhooks/dispatcher.ts')
      await dispatchWebhook({ sandboxId, webhookId: id, isTest: true })
      await waitFor(() => received.length > 0)
    })

    const got = received[0]!
    expect(got.contentType).toBe('application/json')
    const body = JSON.parse(got.body) as Record<string, unknown>
    expect(body.message_type).toBe('TYPE_NEW_POSTING')
    expect(body.posting_number).toBeTypeOf('string')
    expect(body.seller_id).toBe(12345)
  })

  it('событие Wildberries приходит конвертом с events[] и подписью X-Hub-Signature', async () => {
    received = []
    appBehaviour = { status: 200, body: 'ok' }
    const id = await createLocalWebhook('wildberries', 'feedback_updated', '/wb/feedback')

    await withAgent(async () => {
      const { dispatchWebhook } = await import('../src/webhooks/dispatcher.ts')
      await dispatchWebhook({ sandboxId, webhookId: id, isTest: true })
      await waitFor(() => received.length > 0)
    })

    const got = received[0]!
    const body = JSON.parse(got.body) as { sellerId: string; requestId: string; events: unknown[] }
    expect(body.sellerId).toBeTypeOf('string')
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events).toHaveLength(1)
    expect(got.headers['x-hub-signature']).toBeTypeOf('string')
  })

  it('Ozon считает успехом только 200 И тело {"result": true}', async () => {
    received = []
    // Код 200, но тело неверное — боевой Ozon это неуспехом и считает.
    appBehaviour = { status: 200, body: '{"ok":1}' }
    const id = await createLocalWebhook('ozon', 'TYPE_STATE_CHANGED', '/ozon/state')

    let deliveryId = ''
    await withAgent(async () => {
      const { dispatchWebhook } = await import('../src/webhooks/dispatcher.ts')
      const r = await dispatchWebhook({ sandboxId, webhookId: id, isTest: true })
      deliveryId = r!.deliveryId
      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
        return d !== null && d.state !== 'dispatched' && d.state !== 'queued' ? true : (d?.errorMessage ?? null) !== null
      })
    })

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
    expect(delivery!.statusCode).toBe(200)
    expect(delivery!.state).not.toBe('succeeded')
    expect(delivery!.errorMessage).toContain('WRONG_RESULT_FIELD')
  })

  it('Bitrix24 не повторяет доставку — как боевой сервис', async () => {
    received = []
    appBehaviour = { status: 500, body: 'boom' }
    const id = await createLocalWebhook('bitrix24', 'ONCRMLEADADD', '/bitrix/lead')

    let deliveryId = ''
    await withAgent(async () => {
      const { dispatchWebhook } = await import('../src/webhooks/dispatcher.ts')
      const r = await dispatchWebhook({ sandboxId, webhookId: id, isTest: true })
      deliveryId = r!.deliveryId
      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
        return d?.state === 'failed'
      })
    })

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
    // Дословно из документации: «Повторных отправок нет».
    expect(delivery!.maxAttempts).toBe(1)
    expect(delivery!.state).toBe('failed')
    expect(delivery!.nextRetryAt).toBeNull()
    expect(received).toHaveLength(1)
  })

  it('события, накопленные при отключённом агенте, досылаются при подключении', async () => {
    received = []
    appBehaviour = { status: 200, body: 'ok' }
    const id = await createLocalWebhook('wildberries', 'card_changed', '/wb/card')

    // Агент не запущен: доставка обязана лечь в очередь, а не потеряться.
    const { dispatchWebhook } = await import('../src/webhooks/dispatcher.ts')
    const r = await dispatchWebhook({ sandboxId, webhookId: id, isTest: true })
    const queued = await prisma.webhookDelivery.findUnique({ where: { id: r!.deliveryId } })
    expect(queued!.state).toBe('queued')
    expect(received).toHaveLength(0)

    await withAgent(async () => {
      await waitFor(() => received.length > 0)
    })
    expect(received[0]!.path).toBe('/webhooks/wb/card')
  })

  it('второй агент вытесняет первого, а не встаёт рядом', async () => {
    const first = new AbortController()
    const second = new AbortController()

    const a = listen({ apiKey: serverKey, apiBase, forward: `${appBase}/webhooks`, version: 'a', json: true, signal: first.signal })
    await waitFor(async () => {
      const res = await fetch(`${apiBase}/v1/tunnel/status`, { headers: { authorization: `Bearer ${serverKey}` } })
      return ((await res.json()) as { connected: boolean }).connected
    })

    const b = listen({ apiKey: serverKey, apiBase, forward: `${appBase}/webhooks`, version: 'b', json: true, signal: second.signal })
    // Первый агент должен завершиться сам: на код 4003 переподключаться нельзя.
    await expect(a).resolves.toBeTruthy()

    second.abort()
    first.abort()
    await b.catch(() => undefined)
  })
})
