import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listen } from 'apistend'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey } from '../src/lib/keys.ts'
import { isPrivateAddress } from '../src/lib/webhook-target.ts'
import { liveBursts, stopBurst } from '../src/webhooks/burst.ts'

/**
 * Доставка на указанный адрес и серии событий.
 *
 * Второй сквозной путь после доставки на localhost: здесь запрос делает сам сервер
 * APIStend, а не агент. И то, ради чего серии вообще существуют, — нагрузочная
 * проверка: сколько событий заказали, столько и пришло, за время, близкое к расчётному.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let apiBase: string
let receiver: Server
let receiverBase: string
let hits: Array<{ path: string; contentType: string; body: string; signature: string | undefined }> = []

let sandboxId: string
let serverKey: string

beforeAll(async () => {
  api = await buildServer()
  await api.listen({ port: 0, host: '127.0.0.1' })
  const addr = api.server.address()
  if (!addr || typeof addr === 'string') throw new Error('нет адреса сервера')
  apiBase = `http://127.0.0.1:${addr.port}`

  // Приложение разработчика, которому сервер APIStend шлёт события напрямую.
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      hits.push({
        path: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
        signature: req.headers['x-hub-signature'] as string | undefined,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"result":true}')
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  const rAddr = receiver.address()
  if (!rAddr || typeof rAddr === 'string') throw new Error('нет адреса получателя')
  receiverBase = `http://127.0.0.1:${rAddr.port}`

  const user = await prisma.user.create({
    data: {
      email: `burst-${randomBytes(4).toString('hex')}@test.local`,
      passwordHash: 'x', name: 'Тест Серий', initials: 'ТС',
    },
  })
  const sandbox = await prisma.sandbox.create({
    data: { userId: user.id, name: 'burst-test', project: 'e2e' },
  })
  sandboxId = sandbox.id

  const key = generateKey('server')
  serverKey = key.full
  await prisma.apiKey.create({
    data: {
      sandboxId, name: 'e2e-burst', kind: 'server',
      prefix: key.prefix, suffix: key.suffix, keyHash: key.hash,
      services: ['bitrix24', 'ozon', 'wildberries'],
    },
  })
})

afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()))
  await api.close()
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } })
  if (sandbox) await prisma.user.delete({ where: { id: sandbox.userId } })
  await prisma.$disconnect()
})

beforeEach(async () => {
  // Серия предыдущего кейса могла не успеть закончиться: остановим, иначе она
  // продолжит писать доставки к уже удалённому вебхуку.
  for (const b of liveBursts(sandboxId)) stopBurst(b.id)
  // С запасом: остановленная серия ещё пару секунд ждёт последние ответы,
  // и на медленной машине CI пяти секунд не хватало.
  await waitFor(() => liveBursts(sandboxId).length === 0, 20_000)
  await prisma.webhookDelivery.deleteMany({ where: { sandboxId } })
  await prisma.eventBurst.deleteMany({ where: { sandboxId } })
  await prisma.webhook.deleteMany({ where: { sandboxId } })
  hits = []
})

async function createWebhook(
  serviceCode: string, event: string,
  target: 'public' | 'local', where: string,
): Promise<string> {
  const w = await prisma.webhook.create({
    data: {
      sandboxId, serviceCode, event, target,
      targetUrl: target === 'public' ? where : null,
      targetPath: target === 'local' ? where : null,
      secret: `stend_whsec_${randomBytes(8).toString('hex')}`,
    },
  })
  return w.id
}

/**
 * Запросы на конкретный путь.
 *
 * Каждый кейс шлёт на свой путь: у Ozon и WB есть лестница повторов, и доставка
 * предыдущего кейса может долететь уже во время следующего. Счёт по всем hits
 * из-за этого проскакивал мимо точного равенства и висел до таймаута.
 */
const hitsOn = (path: string) => hits.filter((h) => h.path === path)

/**
 * Сколько РАЗНЫХ событий дошло до получателя.
 *
 * warehouse_id в теле Ozon строится из порядкового номера события, а повтор
 * доставки отправляет ровно то же сохранённое тело. Значит число уникальных
 * значений — это число событий, а не число запросов.
 */
const uniqueEvents = (path: string) =>
  new Set(hitsOn(path).map((h) => (JSON.parse(h.body) as { warehouse_id: number }).warehouse_id)).size

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('условие не наступило за отведённое время')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const startBurst = (event: string, count: number, rate: number) =>
  fetch(`${apiBase}/v1/tunnel/trigger`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serverKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event, count, rate }),
  })

describe('доставка на указанный адрес', () => {
  it('событие уходит на targetUrl запросом самого сервера', async () => {
    await createWebhook('ozon', 'TYPE_NEW_POSTING', 'public', `${receiverBase}/hooks/ozon`)

    const res = await fetch(`${apiBase}/v1/tunnel/trigger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'TYPE_NEW_POSTING' }),
    })
    expect(res.status).toBe(200)
    await waitFor(() => hits.length > 0)

    expect(hits[0]!.path).toBe('/hooks/ozon')
    expect(hits[0]!.contentType).toBe('application/json')
    expect(JSON.parse(hits[0]!.body).message_type).toBe('TYPE_NEW_POSTING')
  })

  it('Wildberries подписывает тело: получатель видит X-Hub-Signature', async () => {
    await createWebhook('wildberries', 'stocks.changed', 'public', `${receiverBase}/hooks/wb`)
    await fetch(`${apiBase}/v1/tunnel/trigger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'stocks.changed' }),
    })
    await waitFor(() => hitsOn('/hooks/wb').length > 0)
    expect(hitsOn('/hooks/wb')[0]!.signature).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('серии событий', () => {
  it('на указанный адрес приходит ровно столько событий, сколько заказано', async () => {
    await createWebhook('ozon', 'TYPE_NEW_POSTING', 'public', `${receiverBase}/hooks/load`)

    const startedAt = Date.now()
    const res = await startBurst('TYPE_NEW_POSTING', 24, 24)
    expect(res.status).toBe(202)
    const accepted = (await res.json()) as { count: number; ratePerSec: number; capped: string[] }
    expect(accepted.count).toBe(24)
    expect(accepted.capped).toEqual([])

    // Ждём РАЗНЫЕ события, а не запросы. Профиль Ozon предусматривает повтор
    // неуспешной доставки, и на загруженной машине один такой повтор законен:
    // получатель не успел ответить в отведённые пять секунд. Повтор шлёт то же
    // сохранённое тело, поэтому среди двух десятков запросов уникальных может
    // оказаться на один меньше — и ждать по их общему числу значит проверять
    // выборку в случайный момент. Настоящий перебор расписания виден как
    // двадцать пятый уникальный warehouse_id и проверяется ниже.
    await waitFor(() => uniqueEvents('/hooks/load') >= 24)
    expect(uniqueEvents('/hooks/load')).toBe(24)
    const elapsed = Date.now() - startedAt
    // 24 события по 24 в секунду — около секунды. Полоса широкая: тест меряет
    // не точность таймера, а то, что скорость вообще соблюдается.
    expect(elapsed).toBeGreaterThan(500)
    expect(elapsed).toBeLessThan(6_000)
  })

  it('скорость меняет длительность: те же события вдвое медленнее идут дольше', async () => {
    await createWebhook('ozon', 'TYPE_NEW_POSTING', 'public', `${receiverBase}/hooks/slow`)
    const startedAt = Date.now()
    await startBurst('TYPE_NEW_POSTING', 12, 6)
    await waitFor(() => hitsOn('/hooks/slow').length >= 12)
    expect(Date.now() - startedAt).toBeGreaterThan(1_200)
  })

  it('серия доходит до локального приложения через агента', async () => {
    const controller = new AbortController()
    await createWebhook('bitrix24', 'ONCRMDEALADD', 'local', '/bitrix/deal')

    const localHits: string[] = []
    const localApp = createServer((req, res) => {
      localHits.push(req.url ?? '')
      res.writeHead(200); res.end('ok')
    })
    await new Promise<void>((r) => localApp.listen(0, '127.0.0.1', r))
    const a = localApp.address()
    if (!a || typeof a === 'string') throw new Error('нет адреса')

    const running = listen({
      apiKey: serverKey, apiBase, forward: `127.0.0.1:${a.port}`,
      version: '1.4.2-test', json: true, signal: controller.signal,
    })
    try {
      await waitFor(async () => {
        const r = await fetch(`${apiBase}/v1/tunnel/status`, { headers: { authorization: `Bearer ${serverKey}` } })
        return ((await r.json()) as { connected: boolean }).connected
      })
      const res = await startBurst('ONCRMDEALADD', 15, 30)
      expect(res.status).toBe(202)
      await waitFor(() => localHits.length >= 15)
      expect(localHits).toHaveLength(15)
      expect(localHits.every((p) => p === '/bitrix/deal')).toBe(true)
    } finally {
      controller.abort()
      await running.catch(() => undefined)
      await new Promise<void>((r) => localApp.close(() => r()))
    }
  })

  it('серия на localhost без агента отклоняется, а не копит очередь', async () => {
    await createWebhook('bitrix24', 'ONCRMDEALADD', 'local', '/bitrix/deal')
    const res = await startBurst('ONCRMDEALADD', 100, 50)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('NO_AGENT')
    expect(await prisma.webhookDelivery.count({ where: { sandboxId } })).toBe(0)
  })

  it('запрос выше потолка обрезается, и об этом сказано прямо', async () => {
    await createWebhook('ozon', 'TYPE_NEW_POSTING', 'public', `${receiverBase}/hooks/cap`)
    const res = await startBurst('TYPE_NEW_POSTING', 5, 9_000)
    expect(res.status).toBe(202)
    const body = (await res.json()) as { ratePerSec: number; capped: string[] }
    expect(body.ratePerSec).toBe(500)
    expect(body.capped.join(' ')).toContain('скорость ограничена')
  })

  /**
   * Сторож гонки: получатель на той же машине отвечает за миллисекунду, и если
   * состояние «отправлено» записывать ПОСЛЕ запроса, оно затирает уже пришедший
   * результат — серия отчитывается нулём успешных при полностью доставленных
   * событиях. Скорость здесь высокая намеренно: на медленной серии гонки не видно.
   */
  it('итог серии записан: отправлено, успешно, фактическая скорость', async () => {
    await createWebhook('ozon', 'TYPE_NEW_POSTING', 'public', `${receiverBase}/hooks/tally`)
    await startBurst('TYPE_NEW_POSTING', 120, 200)
    await waitFor(() => hitsOn('/hooks/tally').length >= 120)
    await waitFor(async () => {
      const b = await prisma.eventBurst.findFirst({ where: { sandboxId } })
      return b?.state === 'done'
    })
    const burst = await prisma.eventBurst.findFirst({ where: { sandboxId } })
    // Ровно столько, сколько заказано: перебор означал бы, что такты расписания
    // наложились друг на друга и оба посчитали одно и то же значение sent.
    expect(burst?.sent).toBe(120)
    expect(uniqueEvents('/hooks/tally')).toBe(120)
    expect(burst?.succeeded).toBe(120)
    expect(burst?.failed).toBe(0)
    expect(burst?.note).toContain('соб/с фактически')
    expect(burst?.note).not.toContain('без ответа')
  })
})

describe('адрес получателя', () => {
  it('внутренние диапазоны распознаются как приватные', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1']) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    // IPv4 в обёртке IPv6 — в обеих записях. Вторую даёт new URL: адрес
    // ::ffff:127.0.0.1 он приводит к ::ffff:7f00:1, и такая запись обходила
    // проверку насквозь.
    for (const a of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1']) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateAddress(a), a).toBe(false)
    }
  })
})
