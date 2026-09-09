/**
 * Сид демо-данных.
 *
 * Воспроизводит содержимое макета дословно: те же ключи, те же вебхуки, те же числа KPI.
 * Это не украшательство — приёмка требует, чтобы экран визуально совпадал с PNG,
 * а половина экрана это данные.
 *
 * Запуск: pnpm db:seed
 */

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import argon2 from 'argon2'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../../.env'), quiet: true })

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })
const JWT_SECRET = process.env.JWT_SECRET!

const DEMO_LOGIN = 'demo'
const DEMO_EMAIL = 'demo@apistend.ru'
const DEMO_PASSWORD = 'apistend2026'

const hashApiKey = (full: string) => createHmac('sha256', JWT_SECRET).update(full).digest('hex')

/** Собирает ключ так, чтобы маска совпала с нарисованной в макете. */
function keyWithMask(prefix4: string, suffix4: string) {
  const middle = randomBytes(4).toString('hex')
  const body = `${prefix4}${middle}${suffix4}`
  const full = `stend_sbx_${body}`
  return { full, prefix: `stend_sbx_${prefix4}`, suffix: suffix4, keyHash: hashApiKey(full) }
}

/** Детерминированный ГПСЧ: сид одинаковый — логи одинаковые между прогонами. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOW = new Date()
const at = (hours: number, minutes: number, seconds = 0) => {
  const d = new Date(NOW)
  d.setHours(hours, minutes, seconds, 0)
  return d
}
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

async function main() {
  process.stdout.write('Сид APIStend\n')

  // Чистим только демо-аккаунт: чужие данные не трогаем.
  await prisma.user.deleteMany({ where: { login: DEMO_LOGIN } })

  const user = await prisma.user.create({
    data: {
      login: DEMO_LOGIN,
      email: DEMO_EMAIL,
      passwordHash: await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
      name: 'Игорь Герасимов',
      initials: 'ИГ',
      planLabel: 'Бесплатный доступ',
    },
  })

  const sandbox = await prisma.sandbox.create({
    data: {
      userId: user.id,
      name: 'sandbox-01',
      project: 'Интеграция 1С',
      status: 'ok',
      dataVolume: 'medium',
      latencyMs: 250,
      errorRate: 5,
      // «Последний сброс: сегодня, 03:00 (МСК)»
      lastResetAt: at(3, 0),
    },
  })

  // ── Ключи: пять записей из таблицы на экране «Ключи и токены» ──
  const keySpecs = [
    { name: 'Продакшн-интеграция 1С', subtitle: 'Сервер обмена · 1С:УТ 11', p: '7f3a', s: '4c21',
      services: ['bitrix24', 'ozon'], created: daysAgo(179), used: at(14, 32), reqs: 12_480, status: 'active' as const },
    { name: 'CI / автотесты', subtitle: 'GitLab CI · nightly-run', p: '2b8e', s: '91d0',
      services: ['bitrix24', 'ozon', 'wildberries', 'apify'], created: daysAgo(215), used: at(9, 5), reqs: 38_210, status: 'active' as const },
    { name: 'Мобильное приложение', subtitle: 'iOS · сборка 3.4.1', p: 'c40d', s: '7ae5',
      services: ['bitrix24', 'ozon', 'wildberries', 'apify'], created: daysAgo(223), used: new Date(daysAgo(1).setHours(21, 48, 0, 0)), reqs: 4_902, status: 'active' as const },
    { name: 'Демо для клиента', subtitle: 'Витрина · ООО «Сфера»', p: '9e11', s: '33bc',
      services: ['bitrix24'], created: daysAgo(145), used: daysAgo(142), reqs: 860, status: 'expiring' as const, expires: daysAgo(-35) },
    { name: 'Старый ключ подрядчика', subtitle: 'Отозван 21.02.2025 · И. Орлов', p: '5da7', s: '0f48',
      services: ['bitrix24', 'ozon', 'wildberries', 'apify'], created: daysAgo(303), used: daysAgo(198), reqs: 0, status: 'revoked' as const },
  ]

  const keys: Array<{ id: string; name: string; full: string; services: string[]; status: string }> = []
  for (const spec of keySpecs) {
    const k = keyWithMask(spec.p, spec.s)
    const created = await prisma.apiKey.create({
      data: {
        sandboxId: sandbox.id,
        name: spec.name,
        subtitle: spec.subtitle,
        kind: 'sandbox',
        prefix: k.prefix,
        suffix: k.suffix,
        keyHash: k.keyHash,
        services: spec.services,
        status: spec.status,
        createdAt: spec.created,
        lastUsedAt: spec.used,
        expiresAt: 'expires' in spec ? spec.expires : null,
        revokedAt: spec.status === 'revoked' ? daysAgo(198) : null,
        revokedBy: spec.status === 'revoked' ? 'И. Орлов' : null,
        requestsPerDay: spec.reqs,
      },
    })
    keys.push({ id: created.id, name: created.name, full: k.full, services: spec.services, status: spec.status })
  }

  // Серверный ключ для CLI — он нужен экрану «Вебхуки» и команде apistend login.
  const cliBody = randomBytes(16).toString('hex')
  const cliFull = `stend_sk_${cliBody}`
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'CLI · локальная доставка',
      subtitle: 'apistend listen',
      kind: 'server',
      prefix: `stend_sk_${cliBody.slice(0, 4)}`,
      suffix: cliBody.slice(-4),
      keyHash: hashApiKey(cliFull),
      services: ['bitrix24', 'ozon', 'wildberries', 'apify'],
    },
  })

  // ── Уведомления панели «Требуют внимания» ──
  await prisma.alert.createMany({
    data: [
      { sandboxId: sandbox.id, severity: 'danger', icon: 'circle-x',
        title: 'Ozon: ошибки 500 на /v1/analytics/data', meta: '14 срабатываний за последний час', link: '/logs?status=500' },
      { sandboxId: sandbox.id, severity: 'warning', icon: 'refresh-cw',
        title: 'Wildberries: обновление моков до v2', meta: '2 метода временно отдают 503', link: '/catalog?service=wildberries' },
      { sandboxId: sandbox.id, severity: 'info', icon: 'boxes',
        title: 'Ozon: добавлены 4 новых метода', meta: 'Аналитика продаж и остатки на складах', link: '/catalog?service=ozon' },
    ],
  })

  // ── Вебхуки: шесть строк панели «Настроенные вебхуки» ──
  //
  // Коды событий — боевые, а не из макета. В макете были нарисованы posting.created,
  // stocks.changed и crm.deal.stage.changed; таких событий у сервисов нет, а мок,
  // рассылающий несуществующее событие, учит разработчика неправде. Смена стадии
  // сделки в Bitrix24 приходит как ONCRMDEALUPDATE, новое отправление у Ozon —
  // как TYPE_NEW_POSTING. Компоновка панели от этого не меняется.
  const webhookSpecs = [
    { service: 'ozon', event: 'TYPE_NEW_POSTING', target: 'public' as const, url: 'https://api.acme-erp.ru/hooks/ozon/orders', status: 'active' as const, last: at(10, 42, 18) },
    { service: 'ozon', event: 'TYPE_POSTING_CANCELLED', target: 'public' as const, url: 'https://api.acme-erp.ru/hooks/ozon/cancel', status: 'active' as const, last: at(10, 39, 5) },
    // Локальная доставка: хранится ОТНОСИТЕЛЬНЫЙ путь. Базу подставляет CLI из --forward.
    { service: 'wildberries', event: 'stocks_changed', target: 'local' as const, path: '/wb/stocks', status: 'failing' as const, last: at(10, 41, 52) },
    { service: 'wildberries', event: 'feedback_updated', target: 'public' as const, url: 'https://erp.acme.ru/api/v1/wb/feedback', status: 'active' as const, last: at(10, 28, 44) },
    { service: 'bitrix24', event: 'ONCRMDEALUPDATE', target: 'local' as const, path: '/bitrix/deal', status: 'active' as const, last: at(10, 44, 1) },
    { service: 'bitrix24', event: 'ONCRMLEADADD', target: 'public' as const, url: 'https://crm-sync.acme.ru/bitrix/lead', status: 'paused' as const, last: at(9, 57, 12) },
  ]

  const webhooks = []
  for (const w of webhookSpecs) {
    webhooks.push(await prisma.webhook.create({
      data: {
        sandboxId: sandbox.id,
        serviceCode: w.service,
        event: w.event,
        httpMethod: 'POST',
        target: w.target,
        targetUrl: 'url' in w ? w.url : null,
        targetPath: 'path' in w ? w.path : null,
        status: w.status,
        secret: `stend_whsec_${randomBytes(8).toString('hex')}`,
        lastAttemptAt: w.last,
        successRate24h: w.status === 'failing' ? 71.4 : 98.2,
      },
    }))
  }

  // ── Журнал доставок: пять строк из макета ──
  const wbStocks = webhooks[2]!
  const b24Deal = webhooks[4]!
  const ozOrders = webhooks[0]!
  const ozCancel = webhooks[1]!

  await prisma.webhookDelivery.createMany({
    data: [
      { sandboxId: sandbox.id, webhookId: b24Deal.id, event: 'ONCRMDEALUPDATE', serviceCode: 'bitrix24',
        timestamp: at(10, 44, 1), state: 'succeeded', attempt: 1, maxAttempts: 1, statusCode: 200, durationMs: 214,
        targetDisplay: '/bitrix/deal', contentType: 'application/x-www-form-urlencoded',
        rawBody: 'event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=7405&ts=1788775441',
        requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' } },
      { sandboxId: sandbox.id, webhookId: ozOrders.id, event: 'TYPE_NEW_POSTING', serviceCode: 'ozon',
        timestamp: at(10, 42, 18), state: 'succeeded', attempt: 1, maxAttempts: 10, statusCode: 200, durationMs: 186,
        targetDisplay: '/ozon/orders', contentType: 'application/json',
        rawBody: JSON.stringify({ message_type: 'TYPE_NEW_POSTING', posting_number: '24219509-0020-1', seller_id: 12345 }),
        requestHeaders: { 'content-type': 'application/json' } },
      { sandboxId: sandbox.id, webhookId: wbStocks.id, event: 'stocks_changed', serviceCode: 'wildberries',
        timestamp: at(10, 41, 52), state: 'failed', attempt: 3, maxAttempts: 5, statusCode: 500, durationMs: 5_000,
        targetDisplay: '/wb/stocks', contentType: 'application/json',
        rawBody: JSON.stringify({ event: 'stocks_changed', service: 'wildberries',
          payload: { warehouseId: 507124, nmId: 194873261, quantity: 42 },
          delivery: { attempt: 3, status: 'failed', responseCode: 500 } }),
        requestHeaders: { 'content-type': 'application/json' },
        errorKind: 'http_error', errorMessage: 'Приложение ответило 500' },
      { sandboxId: sandbox.id, webhookId: wbStocks.id, event: 'stocks_changed', serviceCode: 'wildberries',
        timestamp: at(10, 41, 20), state: 'failed', attempt: 2, maxAttempts: 5, statusCode: 429, durationMs: 1_240,
        nextRetryAt: at(10, 41, 52), targetDisplay: '/wb/stocks', contentType: 'application/json',
        rawBody: JSON.stringify({ event: 'stocks_changed', service: 'wildberries' }),
        requestHeaders: { 'content-type': 'application/json' } },
      { sandboxId: sandbox.id, webhookId: ozCancel.id, event: 'TYPE_POSTING_CANCELLED', serviceCode: 'ozon',
        timestamp: at(10, 39, 5), state: 'succeeded', attempt: 1, maxAttempts: 10, statusCode: 200, durationMs: 172,
        targetDisplay: '/ozon/cancel', contentType: 'application/json',
        rawBody: JSON.stringify({ message_type: 'TYPE_POSTING_CANCELLED', posting_number: '24219509-0020-1' }),
        requestHeaders: { 'content-type': 'application/json' } },
    ],
  })

  // ── Сценарии симуляции ──
  await prisma.scenario.createMany({
    data: [
      // Сценарии — заготовки нагрузки: сколько событий и с какой скоростью.
      // Событие первого шага должно совпадать с событием заведённого вебхука,
      // иначе запуску некуда слать.
      { sandboxId: sandbox.id, name: 'Пик заказов Ozon', serviceCode: 'ozon', stepsCount: 200, status: 'ready',
        delayMs: 20, ratePerSec: 50, repeats: 1, errorRate: 0, progress: 0, lastRunAt: minutesAgo(1),
        lastRunNote: 'Проверка пика: 200 событий по 50 в секунду',
        steps: [{ event: 'TYPE_NEW_POSTING', ratePerSec: 50, errorRate: 0 }] },
      { sandboxId: sandbox.id, name: 'Отмены и возвраты WB', serviceCode: 'wildberries', stepsCount: 60, status: 'ready',
        delayMs: 100, ratePerSec: 10, repeats: 1, errorRate: 25, progress: 0, lastRunAt: at(9, 41),
        lastRunNote: 'Последний запуск 09:41 · 2 ошибки',
        steps: [{ event: 'stocks_changed', ratePerSec: 10, errorRate: 25 }] },
      // В макете шаг назывался crm.deal.stage.changed — такого события у Bitrix24 нет:
      // смена стадии приходит как ONCRMDEALUPDATE. Ставим реальный код.
      { sandboxId: sandbox.id, name: 'Воронка сделки Bitrix24', serviceCode: 'bitrix24', stepsCount: 500, status: 'ready',
        delayMs: 4, ratePerSec: 250, repeats: 1, errorRate: 0, progress: 0, lastRunAt: at(8, 12),
        lastRunNote: 'Последний запуск 08:12 · без ошибок',
        steps: [{ event: 'ONCRMDEALUPDATE', ratePerSec: 250, errorRate: 0 }] },
    ],
  })

  // ── Свои моки: восемь записей панели «Мои моки» ──
  const ordersBody = `{
  "orderId": "{{uuid}}",
  "externalId": "{{request.body.externalId}}",
  "status": "accepted",
  "createdAt": "{{now}}",
  "customer": {
    "id": "{{request.body.customer.id}}",
    "name": "{{faker.company}}",
    "inn": "{{randomInt 1000000000 9999999999}}"
  },
  "items": [
    {
      "sku": "{{request.body.items.0.sku}}",
      "title": "Кофе в зёрнах, 1 кг",
      "qty": {{randomInt 1 20}},
      "price": 2490
    }
  ],
  "delivery": {
    "warehouse": "{{faker.city}}",
    "eta": "{{now +3d}}"
  },
  "total": {{randomInt 1000 50000}},
  "currency": "RUB"
}`

  const mocks = [
    { m: 'POST', p: '/custom/erp/orders', t: 'Приём заказов из 1С', st: 'active' as const, rules: 4, calls: 1_284, upd: minutesAgo(2), code: 201, body: ordersBody },
    { m: 'GET', p: '/custom/erp/orders/{id}', t: 'Карточка заказа', st: 'active' as const, rules: 2, calls: 640, upd: minutesAgo(60), code: 200, body: '{\n  "orderId": "{{uuid}}",\n  "status": "accepted"\n}' },
    { m: 'GET', p: '/custom/catalog/products', t: 'Каталог товаров ERP', st: 'active' as const, rules: 1, calls: 2_108, upd: minutesAgo(180), code: 200, body: '{\n  "items": [],\n  "total": {{randomInt 100 5000}}\n}' },
    { m: 'PUT', p: '/custom/catalog/products/{sku}', t: 'Обновление карточки товара', st: 'draft' as const, rules: 0, calls: 0, upd: minutesAgo(300), code: 200, body: '{\n  "sku": "{{request.body.sku}}",\n  "updatedAt": "{{now}}"\n}' },
    { m: 'POST', p: '/custom/billing/invoices', t: 'Выставление счёта', st: 'active' as const, rules: 3, calls: 87, upd: daysAgo(1), code: 201, body: '{\n  "invoiceId": "{{uuid}}",\n  "total": {{randomInt 1000 90000}}\n}' },
    { m: 'GET', p: '/custom/logistics/shipments', t: 'Отгрузки со склада', st: 'disabled' as const, rules: 0, calls: 0, upd: daysAgo(4), code: 200, body: '{\n  "shipments": []\n}' },
    { m: 'POST', p: '/custom/crm/leads', t: 'Приём лидов с сайта', st: 'active' as const, rules: 2, calls: 415, upd: daysAgo(1), code: 201, body: '{\n  "leadId": "{{uuid}}",\n  "createdAt": "{{now}}"\n}' },
    { m: 'DELETE', p: '/custom/erp/orders/{id}', t: 'Отмена заказа', st: 'draft' as const, rules: 0, calls: 0, upd: daysAgo(2), code: 204, body: '' },
  ]
  for (const mock of mocks) {
    await prisma.customMock.create({
      data: {
        sandboxId: sandbox.id, httpMethod: mock.m, path: mock.p, title: mock.t, status: mock.st,
        responseStatusCode: mock.code, contentType: 'application/json', delayMs: 250,
        templatingEnabled: true, responseBody: mock.body, headers: {}, rules: [],
        callsCount: mock.calls, updatedAt: mock.upd,
      },
    })
  }

  // ── Логи запросов: наполняем сутки, чтобы сводка и почасовой график были живыми ──
  const rand = rng(20260907)
  const endpoints: Array<[string, string, string]> = [
    ['bitrix24', 'GET', '/rest/crm.deal.list.json'],
    ['bitrix24', 'POST', '/rest/crm.contact.add.json'],
    ['bitrix24', 'GET', '/rest/tasks.task.list'],
    ['bitrix24', 'POST', '/rest/crm.lead.update.json'],
    ['bitrix24', 'DELETE', '/rest/crm.deal.delete.json'],
    ['ozon', 'POST', '/v3/posting/fbs/list'],
    ['ozon', 'GET', '/v2/product/info'],
    ['ozon', 'POST', '/v1/product/import/prices'],
    ['ozon', 'GET', '/v3/finance/transaction/list'],
    ['ozon', 'PATCH', '/v2/products/stocks'],
    ['wildberries', 'GET', '/api/v3/orders/new'],
    ['wildberries', 'PUT', '/api/v3/stocks/12345'],
    ['wildberries', 'GET', '/content/v2/get/cards/list'],
    ['wildberries', 'POST', '/api/v3/orders/status'],
    ['wildberries', 'GET', '/api/v1/supplier/orders'],
  ]
  const activeKeys = keys.filter((_, i) => i < 3)
  const logs = []
  const TOTAL_LOGS = 1_400
  for (let i = 0; i < TOTAL_LOGS; i++) {
    const [service, method, endpoint] = endpoints[Math.floor(rand() * endpoints.length)]!
    // Суточный профиль нагрузки: днём густо, ночью редко — график должен быть похож на правду.
    const hourWeight = rand()
    const hoursBack = hourWeight < 0.7 ? Math.floor(rand() * 12) : 12 + Math.floor(rand() * 12)
    const ts = new Date(NOW.getTime() - hoursBack * 3_600_000 - Math.floor(rand() * 3_600_000))
    const roll = rand()
    const status = roll < 0.031 ? (roll < 0.012 ? 500 : roll < 0.022 ? 429 : roll < 0.027 ? 401 : 404) : roll < 0.05 ? 201 : 200
    const slow = status >= 500 || rand() < 0.03
    const key = activeKeys[Math.floor(rand() * activeKeys.length)]!
    logs.push({
      sandboxId: sandbox.id,
      apiKeyId: key.id,
      publicId: `req_${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0')}${i.toString(16).padStart(3, '0')}`,
      timestamp: ts,
      serviceCode: service,
      httpMethod: method,
      endpoint,
      statusCode: status,
      durationMs: slow ? 900 + Math.floor(rand() * 800) : 38 + Math.floor(rand() * 290),
      sizeBytes: 300 + Math.floor(rand() * 130_000),
      upstreamUrl: null,
      clientIp: '5.61.44.208',
      scenario: status >= 400 ? 'server_error' : 'success',
      responseSource: 'schema',
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: method === 'GET' ? null : JSON.stringify({ limit: 50, offset: 0 }),
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: JSON.stringify({ result: {} }),
    })
  }
  await prisma.requestLog.createMany({ data: logs })

  await prisma.serviceStat.deleteMany({})
  await prisma.serviceStat.createMany({
    data: [
      { serviceCode: 'bitrix24', status: 'planned', methodsCount: 0, eventsCount: 7, snapshotDate: '—' },
      { serviceCode: 'ozon', status: 'planned', methodsCount: 0, eventsCount: 15, snapshotDate: '—' },
      { serviceCode: 'wildberries', status: 'ok', methodsCount: 316, eventsCount: 6, snapshotDate: new Date().toISOString().slice(0, 10) },
    ],
  })

  process.stdout.write(`
Готово.

  Логин:   ${DEMO_LOGIN}
  Пароль:  ${DEMO_PASSWORD}

  Песочница:  ${sandbox.name} (${sandbox.id})
  Ключей:     ${keySpecs.length + 1}
  Логов:      ${TOTAL_LOGS}
  Вебхуков:   ${webhookSpecs.length}
  Своих моков:${mocks.length}

  Ключи песочницы (полностью — только здесь и только сейчас):
${keys.map((k) => `    ${k.full}  ${k.status === 'revoked' ? '[отозван] ' : ''}${k.name} → ${k.services.join(', ')}`).join('\n')}

  Серверный ключ для CLI:
    ${cliFull}
`)
}

main()
  .catch((e) => {
    process.stderr.write(`Сид упал: ${String(e)}\n`)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
