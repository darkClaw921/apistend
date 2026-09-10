import { describe, it, expect, beforeAll } from 'vitest'
import type { ServiceCode } from '@apistend/shared'
import { MockEngine } from './engine.ts'
import { competitorsFor } from './competitors.ts'
import { productPool } from './dataset.ts'
import { DEFAULT_LIMIT } from './page.ts'
import type { MockRequest } from './engine.ts'

const NOW = new Date('2026-09-07T12:00:00.000Z')

function req(partial: Partial<MockRequest> & Pick<MockRequest, 'httpMethod' | 'path'>): MockRequest {
  return {
    service: 'wildberries',
    query: {},
    headers: {},
    body: null,
    requestId: 'req_test0000',
    scenario: 'success',
    now: NOW,
    salt: 'medium',
    ...partial,
  }
}

/** Подставляет в шаблонный путь конкретное значение: /orders/{id} -> /orders/777 */
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, '777')

let engine: MockEngine
const LOADED: ServiceCode[] = []

beforeAll(() => {
  engine = MockEngine.load(['bitrix24', 'ozon', 'wildberries'])
  LOADED.push(...engine.loadedServices)
})

describe('загрузка каталога', () => {
  it('загружены Wildberries и Ozon', () => {
    expect(LOADED).toContain('wildberries')
    expect(LOADED).toContain('ozon')
  })

  it('в каталоге сотни методов', () => {
    expect(engine.catalog('wildberries').length).toBeGreaterThan(280)
    expect(engine.catalog('ozon').length).toBeGreaterThan(400)
  })

  it('маршрутизатор не нашёл коллизий путей ни в одном сервисе', () => {
    for (const code of LOADED) {
      expect(engine.index(code)!.router.collisions, `коллизии в ${code}`).toEqual([])
    }
  })

  it('каждый метод несёт поля происхождения и боевой хост без песочницы', () => {
    for (const code of LOADED) {
      for (const m of engine.catalog(code)) {
        expect(m.sourceUrl, m.id).toMatch(/^https:\/\//)
        expect(m.snapshotDate, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(['spec', 'mirror', 'parsed']).toContain(m.extraction)
        expect(m.upstreamHost, m.id).toMatch(/^https:\/\//)
        // Песочные хосты сервисов не должны просачиваться в каталог.
        expect(m.upstreamHost, m.id).not.toContain('sandbox')
      }
    }
  })

  it('Ozon — почти целиком POST-over-HTTP, это свойство сервиса, а не ошибка разбора', () => {
    const ozon = engine.catalog('ozon')
    const posts = ozon.filter((m) => m.httpMethod === 'POST').length
    expect(posts / ozon.length).toBeGreaterThan(0.95)
  })
})

describe('маршрутизация', () => {
  it('находит точный путь', () => {
    const r = engine.handle(req({ httpMethod: 'GET', path: '/api/v3/warehouses' }))
    expect(r.method?.path).toBe('/api/v3/warehouses')
    expect(r.status).toBeLessThan(300)
  })

  it('находит шаблонный путь и возвращает параметры', () => {
    const index = engine.index('wildberries')!
    const templated = engine.catalog('wildberries').find((m) => m.path.includes('{'))!
    const match = index.router.match(templated.httpMethod, concrete(templated.path))
    expect(match?.method.path).toBe(templated.path)
    expect(Object.values(match!.params)).toContain('777')
  })

  it('неизвестный путь отдаёт 404 в конверте WB и подсказку', () => {
    const r = engine.handle(req({ httpMethod: 'GET', path: '/api/v3/warehousez' }))
    expect(r.status).toBe(404)
    const body = r.body as Record<string, unknown>
    expect(body.title).toBe('Not Found')
    expect(body.origin).toBe('ag-gateway')
    expect(r.headers['x-apistend-did-you-mean']).toContain('/api/v3/warehouses')
  })
})

describe('конверты ошибок различаются по сервисам', () => {
  it('Wildberries — {title, detail, code, requestId, origin, status}', () => {
    const r = engine.handle(req({ httpMethod: 'GET', path: '/api/v3/warehouses', scenario: 'invalid_token' }))
    expect(r.status).toBe(401)
    const b = r.body as Record<string, unknown>
    expect(b).toHaveProperty('title')
    expect(b).toHaveProperty('detail')
    expect(b).toHaveProperty('requestId')
    expect(b).toHaveProperty('origin')
  })

  it('Ozon — rpcStatus {code, message, details} с числовым gRPC-кодом', () => {
    const r = engine.handle(req({
      service: 'ozon', httpMethod: 'POST', path: '/v3/posting/fbs/list', scenario: 'invalid_token',
    }))
    expect(r.status).toBe(401)
    const b = r.body as Record<string, unknown>
    // 16 — UNAUTHENTICATED в номенклатуре gRPC, которую использует Ozon.
    expect(b.code).toBe(16)
    expect(b.message).toBeTypeOf('string')
    expect(Array.isArray(b.details)).toBe(true)
  })

  it('лимит: у Ozon и Wildberries 429, у Битрикс24 — 503', () => {
    const oz = engine.handle(req({ service: 'ozon', httpMethod: 'POST', path: '/v3/posting/fbs/list', scenario: 'rate_limit' }))
    expect(oz.status).toBe(429)

    const wb = engine.handle(req({ httpMethod: 'GET', path: '/api/v3/warehouses', scenario: 'rate_limit' }))
    expect(wb.status).toBe(429)

    // Заголовков лимита движок не ставит никому: остаток знает только шлюз,
    // он же ведёт ведро. Два владельца одного заголовка уже давали
    // Limit: 2 при Remaining: 49.
    expect(oz.headers['x-ratelimit-limit']).toBeUndefined()
    expect(wb.headers['x-ratelimit-limit']).toBeUndefined()

    const b24 = engine.handle(req({ service: 'bitrix24', httpMethod: 'POST', path: '/rest/crm.deal.list', scenario: 'rate_limit' }))
    expect(b24.status).toBe(503)
  })

  it('Content-Type — как у боевого сервиса, а не один на всех', () => {
    // Битрикс24 отдаёт charset, Ozon и WB — голый application/json. Клиентские
    // библиотеки сверяют этот заголовок, и «почти такой же» тут не считается.
    const b24 = engine.handle(req({ service: 'bitrix24', httpMethod: 'POST', path: '/rest/crm.deal.list' }))
    expect(b24.headers['content-type']).toBe('application/json; charset=utf-8')

    const wb = engine.handle(req({ httpMethod: 'GET', path: '/api/v3/warehouses' }))
    expect(wb.headers['content-type']).toBe('application/json')
  })

  it('статичный конверт time из примеров Битрикс24 в ответ не попадает', () => {
    // В документации он записан датами того дня, когда писали пример. Живой
    // конверт приписывает шлюз — он один знает, сколько шёл запрос.
    const examples = engine.catalog('bitrix24').filter((m) => m.responseSource === 'example').slice(0, 200)
    expect(examples.length).toBeGreaterThan(0)
    for (const m of examples) {
      const r = engine.handle(req({ service: 'bitrix24', httpMethod: m.httpMethod, path: concrete(m.path) }))
      if (r.body !== null && typeof r.body === 'object' && !Array.isArray(r.body)) {
        expect(r.body, m.id).not.toHaveProperty('time')
      }
    }
  })
})

describe('детерминизм — главное свойство движка', () => {
  it('один и тот же запрос всегда даёт байт-в-байт одинаковый ответ', () => {
    for (const code of LOADED) {
      const methods = engine.catalog(code).filter((m) => m.responseSource === 'schema').slice(0, 40)
      for (const m of methods) {
        const a = engine.handle(req({ service: code, httpMethod: m.httpMethod, path: concrete(m.path) }))
        const b = engine.handle(req({ service: code, httpMethod: m.httpMethod, path: concrete(m.path) }))
        expect(a.serialized, m.id).toBe(b.serialized)
      }
    }
  })

  it('базовый датасет общий для песочниц одного объёма', () => {
    // Это не упрощение, а конструкция: базовый набор данных read-only и одинаков
    // для всех песочниц — именно поэтому создание песочницы стоит O(1),
    // а кеш ответов не зависит от числа аккаунтов.
    const m = engine.catalog('wildberries').find((x) => x.responseSource === 'schema')!
    const a = engine.handle(req({ httpMethod: m.httpMethod, path: concrete(m.path), salt: 'medium' }))
    const b = engine.handle(req({ httpMethod: m.httpMethod, path: concrete(m.path), salt: 'medium' }))
    expect(a.serialized).toBe(b.serialized)
  })

  it('разный объём демо-данных даёт разные наборы', () => {
    const m = engine.catalog('wildberries').find((x) => x.responseSource === 'schema')!
    const min = engine.handle(req({ httpMethod: m.httpMethod, path: concrete(m.path), salt: 'min' }))
    const full = engine.handle(req({ httpMethod: m.httpMethod, path: concrete(m.path), salt: 'full' }))
    expect(min.serialized).not.toBe(full.serialized)
  })

  it('сериализованное тело совпадает с объектом', () => {
    for (const code of LOADED) {
      for (const m of engine.catalog(code).slice(0, 60)) {
        const r = engine.handle(req({ service: code, httpMethod: m.httpMethod, path: concrete(m.path) }))
        expect(r.serialized, m.id).toBe(JSON.stringify(r.body ?? null))
      }
    }
  })

  it('кеш ответов не меняет результат', () => {
    const m = engine.catalog('ozon').find((x) => x.responseSource === 'schema')!
    const fresh = MockEngine.load(['ozon'])
    const cached = engine.handle(req({ service: 'ozon', httpMethod: m.httpMethod, path: concrete(m.path) }))
    const uncached = fresh.handle(req({ service: 'ozon', httpMethod: m.httpMethod, path: concrete(m.path) }))
    expect(cached.serialized).toBe(uncached.serialized)
  })
})

describe('весь каталог отвечает без падений', () => {
  it('каждый метод отдаёт сериализуемый ответ, а не исключение', () => {
    const failures: string[] = []
    for (const code of LOADED) {
      for (const m of engine.catalog(code)) {
        try {
          const r = engine.handle(req({ service: code, httpMethod: m.httpMethod, path: concrete(m.path) }))
          if (r.responseSource === 'error') failures.push(`${code} ${m.httpMethod} ${m.path} -> ${r.status}`)
          JSON.parse(r.serialized)
        } catch (e) {
          failures.push(`${code} ${m.httpMethod} ${m.path} -> ${(e as Error).message}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})

/**
 * Каталог товаров — то, ради чего стенд отличается от песочницы площадки.
 *
 * У WB в песочнице методы отвечают верно по форме, но про разные товары: каталог про
 * один артикул, воронка про другой, остатки про третий, а цены не отдаются вовсе.
 * Транспорт на таком стенде проверить можно, экономику — нет. Эти тесты закрепляют
 * обратное свойство: все методы говорят про один и тот же каталог, и цифры внутри
 * товара сходятся между собой.
 */
describe('общий каталог товаров', () => {
  const nmIds = (node: unknown, acc = new Set<number>()): Set<number> => {
    if (Array.isArray(node)) node.forEach((x) => nmIds(x, acc))
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (/^nm_?id$/i.test(k) && typeof v === 'number') acc.add(v)
        else nmIds(v, acc)
      }
    }
    return acc
  }

  const call = (
    httpMethod: string,
    path: string,
    query: Record<string, string> = {},
    salt = 'medium',
  ) => engine.handle(req({ httpMethod, path, query, salt })).body

  const cards = (query: Record<string, string> = {}) =>
    (call('POST', '/content/v2/get/cards/list', query) as {
      cards: Array<Record<string, unknown>>
      cursor: Record<string, unknown>
    })

  it('цены и скидки отдаются: без них не посчитать ни маржу, ни коридор цен', () => {
    // Схема ответа записана ссылкой на общий компонент. Пока ссылку не разыменовывали,
    // метод молча уезжал на generic-ярус и отдавал пустой объект.
    const r = engine.handle(req({ httpMethod: 'GET', path: '/api/v2/list/goods/filter' }))
    expect(r.responseSource).toBe('schema')
    const goods = (r.body as { data: { listGoods: Array<Record<string, unknown>> } }).data.listGoods
    expect(goods.length).toBeGreaterThan(1)
    for (const g of goods) {
      const size = (g.sizes as Array<{ price: number; discountedPrice: number }>)[0]!
      expect(size.price).toBeGreaterThan(0)
      expect(size.discountedPrice).toBeLessThanOrEqual(size.price)
    }
  })

  it('воронка, заказы, остатки и финансы отвечают про товары из каталога', () => {
    const pool = new Set(productPool('medium').map((p) => p.nmId))
    const paths: Array<[string, string]> = [
      ['POST', '/content/v2/get/cards/list'],
      ['GET', '/api/v2/list/goods/filter'],
      ['POST', '/api/analytics/v3/sales-funnel/products'],
      ['POST', '/api/analytics/v1/order-feed'],
      ['POST', '/api/analytics/v1/stocks-report/wb-warehouses'],
      ['POST', '/api/analytics/v1/stocks-report/seller-warehouses'],
      ['GET', '/api/v1/supplier/orders'],
      ['GET', '/api/v1/supplier/sales'],
      ['POST', '/api/finance/v1/sales-reports/detailed'],
    ]
    for (const [httpMethod, path] of paths) {
      const ids = [...nmIds(call(httpMethod, path))]
      expect(ids.length, path).toBeGreaterThan(0)
      expect(ids.filter((id) => !pool.has(id)), path).toEqual([])
    }
  })

  it('поля одной записи описывают один товар, а не собранного из кусков', () => {
    const byNm = new Map(productPool('medium').map((p) => [p.nmId, p]))
    const page = cards().cards
    expect(page.length).toBe(DEFAULT_LIMIT)
    for (const card of page) {
      const p = byNm.get(card.nmID as number)!
      expect(p, String(card.nmID)).toBeDefined()
      expect(card.vendorCode).toBe(p.vendorCode)
      expect(card.brand).toBe(p.brand)
      expect(card.title).toBe(p.title)
      expect(card.imtID).toBe(p.imtId)
    }
  })

  it('воронка убывает: показы -> корзина -> заказы -> выкупы', () => {
    for (const p of productPool('medium')) {
      expect(p.openCount).toBeGreaterThanOrEqual(p.cartCount)
      expect(p.cartCount).toBeGreaterThanOrEqual(p.orderCount)
      expect(p.orderCount).toBeGreaterThanOrEqual(p.buyoutCount)
      expect(p.orderCount - p.buyoutCount).toBe(p.cancelCount)
      expect(p.orderSum).toBe(p.orderCount * p.discountedPrice)
      expect(p.discountedPrice).toBe(Math.round((p.price * (100 - p.discountPercent)) / 100))
    }
  })

  it('в каталоге не меньше сотни товаров при любом объёме датасета', () => {
    for (const salt of ['min', 'medium', 'full']) {
      const pool = productPool(salt)
      expect(pool.length, salt).toBeGreaterThanOrEqual(100)
      // Артикулы и коды не должны совпадать: на каталоге в сотни позиций случайные
      // числа сталкиваются, и два разных товара получают один nmID.
      expect(new Set(pool.map((p) => p.nmId)).size, salt).toBe(pool.length)
      expect(new Set(pool.map((p) => p.vendorCode)).size, salt).toBe(pool.length)
      expect(new Set(pool.map((p) => p.barcode)).size, salt).toBe(pool.length)
      expect(new Set(pool.map((p) => p.chrtId)).size, salt).toBe(pool.length)
    }
  })

  it('предмет и категория товара не расходятся', () => {
    // Пока это были два независимых списка, «Портативная колонка» попадала
    // в «Продукты питания»: списки цикличны и расходятся на первом же обороте.
    const byTitle = new Map<string, string>()
    for (const p of productPool('full')) {
      const base = p.title.split(',')[0]!
      const seen = byTitle.get(base)
      if (seen === undefined) byTitle.set(base, p.category)
      else expect(p.category, p.title).toBe(seen)
    }
    expect(byTitle.size).toBeGreaterThan(20)
  })

  it('каталог отдаётся страницами, а не целиком', () => {
    const pool = productPool('medium')
    expect(cards().cards.length).toBe(DEFAULT_LIMIT)
    expect(cards({ limit: '5' }).cards.length).toBe(5)
    // Общее количество — размер всего каталога: по нему клиент считает число страниц.
    expect(cards().cursor.total).toBe(pool.length)

    const first = cards({ limit: '10' }).cards.map((c) => c.nmID)
    const second = cards({ limit: '10', offset: '10' }).cards.map((c) => c.nmID)
    expect(second).not.toEqual(first)
    expect(first.filter((id) => second.includes(id))).toEqual([])
    // Страница за концом каталога пуста — так клиент узнаёт, что обход закончен.
    expect(cards({ limit: '10', offset: String(pool.length) }).cards).toEqual([])
  })

  it('страница одна на все методы: отчёты сходятся по артикулам', () => {
    const query = { limit: '10', offset: '30' }
    const fromCards = new Set(cards(query).cards.map((c) => c.nmID as number))
    const fromGoods = nmIds(call('GET', '/api/v2/list/goods/filter', query))
    const fromFunnel = nmIds(call('POST', '/api/analytics/v3/sales-funnel/products', query))
    expect([...fromGoods]).toEqual([...fromCards])
    expect([...fromFunnel]).toEqual([...fromCards])
  })

  it('объём датасета меняет размер каталога, но не его устройство', () => {
    expect(productPool('min').length).toBeLessThan(productPool('medium').length)
    expect(productPool('medium').length).toBeLessThan(productPool('full').length)
    // Каталог зависит только от объёма: иначе «тот же товар» в двух методах
    // снова оказался бы разными товарами.
    expect(productPool('medium')).toBe(productPool('medium'))
  })
})

describe('даты фикстур живут относительно сегодняшнего дня', () => {
  const DATE = /\b(19|20)\d\d-\d\d-\d\d/g
  const datesOf = (body: string): string[] => [...new Set(body.match(DATE) ?? [])].sort()
  const today = (now: Date) => now.toISOString().slice(0, 10)

  const call = (path: string, httpMethod = 'GET', now = new Date()) =>
    engine.handle({
      service: 'wildberries', httpMethod, path, query: {}, headers: {}, body: null,
      requestId: 'r', scenario: 'success', now, salt: 'medium',
    })

  it('самая свежая дата ответа — сегодняшняя, а не из документации', () => {
    const now = new Date()
    const res = call('/api/v1/supplier/orders', 'GET', now)
    const dates = datesOf(res.serialized)
    expect(dates.length).toBeGreaterThan(0)
    // В документации Wildberries эти заказы датированы 4 марта 2022 года.
    // Клиент считает витрину за последние 30 дней и не нашёл бы в ней ничего.
    expect(dates.some((d) => d.startsWith('2022'))).toBe(false)
    expect(dates[dates.length - 1]).toBe(today(now))
  })

  it('расстояния между датами сохраняются', () => {
    // В примере отзывы датированы 12 и 20 августа и 26 сентября: разрыв в восемь
    // и в тридцать семь суток. Сдвиг общий, поэтому разрывы обязаны остаться теми же.
    const dates = datesOf(call('/api/v1/feedbacks').serialized).map((d) => Date.parse(d))
    const gaps = dates.slice(1).map((d, i) => Math.round((d - dates[i]!) / 86_400_000))
    expect(gaps).toEqual([8, 37])
  })

  it('срок действия уезжает в будущее, а не схлопывается в сегодня', () => {
    // Подписка отвечала state: active при till в прошлом — то есть была
    // активной и одновременно просроченной. Опору выбираем среди дат прошлого,
    // поэтому till остаётся позже неё.
    const now = new Date()
    const res = call('/api/common/v1/subscriptions', 'GET', now)
    const body = JSON.parse(res.serialized) as Record<string, unknown>
    const till = JSON.stringify(body).match(/"till":"([^"]+)"/)?.[1]
    expect(till).toBeDefined()
    expect(Date.parse(till!)).toBeGreaterThan(now.getTime())
  })

  it('ответ остаётся определённым в пределах суток', () => {
    const now = new Date('2026-05-05T10:00:00Z')
    const a = call('/api/v1/supplier/orders', 'GET', now)
    const b = call('/api/v1/supplier/orders', 'GET', new Date('2026-05-05T23:59:00Z'))
    expect(a.serialized).toBe(b.serialized)
  })

  it('назавтра даты уезжают ровно на сутки', () => {
    const a = call('/api/v1/supplier/orders', 'GET', new Date('2026-05-05T10:00:00Z'))
    const b = call('/api/v1/supplier/orders', 'GET', new Date('2026-05-06T10:00:00Z'))
    expect(a.serialized).not.toBe(b.serialized)
    const last = (s: string) => datesOf(s)[datesOf(s).length - 1]!
    expect(Date.parse(last(b.serialized)) - Date.parse(last(a.serialized))).toBe(86_400_000)
  })

  it('формат даты сохраняется дословно', () => {
    // Клиент разбирает ответ строгим парсером: подмена «даты без времени»
    // на дату со временем ломает его так же надёжно, как неверное значение.
    const res = call('/api/v1/supplier/orders')
    const withTime = res.serialized.match(/"date":"([^"]+)"/)?.[1]
    expect(withTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('справочники и постраничный обход', () => {
  const wb = (path: string, httpMethod: string, body: unknown = null) => JSON.parse(
    engine.handle({
      service: 'wildberries', httpMethod, path, query: {}, headers: {}, body,
      requestId: 'r', scenario: 'success', now: new Date(), salt: 'medium',
    }).serialized,
  ) as Record<string, any>

  it('комиссии приходят по предметам каталога, а не по предмету из документации', () => {
    const report = wb('/api/v1/tariffs/commission', 'GET').report as Array<Record<string, unknown>>
    const cards = wb('/content/v2/get/cards/list', 'POST').cards as Array<Record<string, unknown>>

    const subjects = new Set(report.map((r) => r.subjectID))
    // Пустое пересечение означало, что ставку не к чему подобрать и юнит-экономика
    // не считается — ровно это и было, пока в справочнике стоял единственный предмет.
    expect(cards.every((c) => subjects.has(c.subjectID))).toBe(true)
    expect(report.length).toBeGreaterThan(1)
  })

  it('широкая категория в справочнике — из каталога, а не из примера', () => {
    const report = wb('/api/v1/tariffs/commission', 'GET').report as Array<Record<string, unknown>>
    // Пара parentID/parentName обязана быть согласованной: имя из каталога
    // рядом с номером из документации — это разные категории в одной строке.
    const pairs = new Map<unknown, unknown>()
    for (const row of report) pairs.set(row.parentID, row.parentName)
    expect(pairs.size).toBeGreaterThan(1)
    expect([...pairs.values()].every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
  })

  it('курсор Wildberries ведёт по каталогу, а не возвращает ту же страницу', () => {
    let body = wb('/content/v2/get/cards/list', 'POST', { settings: { cursor: { limit: 5 } } })
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      const page = (body.cards as Array<Record<string, number>>).map((c) => c.nmID!)
      if (page.length === 0) break
      seen.push(...page)
      body = wb('/content/v2/get/cards/list', 'POST', {
        settings: { cursor: { limit: 5, updatedAt: body.cursor.updatedAt, nmID: body.cursor.nmID } },
      })
    }
    expect(seen).toHaveLength(20)
    // Повтор означал бы, что курсор стоит на месте: обход каталога не закончится,
    // и клиенту придётся выдумывать себе страховку от петли.
    expect(new Set(seen).size).toBe(20)
  })

  it('курсор указывает на последнюю запись страницы', () => {
    const body = wb('/content/v2/get/cards/list', 'POST', { settings: { cursor: { limit: 5 } } })
    const cards = body.cards as Array<Record<string, number>>
    // На первой записи шаг был бы в одну карточку на запрос.
    expect(body.cursor.nmID).toBe(cards[cards.length - 1]!.nmID)
  })

  it('описание карточки различается и говорит о товаре', () => {
    const cards = wb('/content/v2/get/cards/list', 'POST').cards as Array<Record<string, string>>
    const descriptions = new Set(cards.map((c) => c.description))
    expect(descriptions.size).toBeGreaterThan(1)
    expect(cards[0]!.description).not.toBe('Тестовое описание')
  })

  it('имя характеристики принадлежит характеристике, а не товару', () => {
    const cards = wb('/content/v2/get/cards/list', 'POST').cards as Array<Record<string, any>>
    const characteristic = cards[0]!.characteristics?.[0]
    expect(characteristic).toBeDefined()
    // Проекция каталога подменяла имя характеристики названием карточки.
    expect(characteristic.name).not.toBe(cards[0]!.title)
  })
})


describe('журнал заказов: события во времени, а не одна дата', () => {
  const now = new Date()
  const wb = (path: string, httpMethod: string, query: Record<string, string> = {}, body: unknown = null) =>
    JSON.parse(
      engine.handle({
        service: 'wildberries', httpMethod, path, query, headers: {}, body,
        requestId: 'r', scenario: 'success', now, salt: 'medium',
      }).serialized,
    ) as any

  const day = (offset: number) =>
    new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10)

  it('заказы разложены по дням окна, а не стоят одной датой', () => {
    const orders = wb('/api/v1/supplier/orders', 'GET', { dateFrom: day(89) }) as Array<Record<string, string>>
    const days = new Set(orders.map((o) => o.date!.slice(0, 10)))
    // В примере из документации все заказы датированы 4 марта 2022 года: витрина
    // за последние 90 дней строилась по одной точке.
    expect(orders.length).toBeGreaterThan(50)
    expect(days.size).toBeGreaterThan(30)
    expect([...days].every((d) => d >= day(90))).toBe(true)
  })

  it('dateFrom сужает выдачу, а не игнорируется', () => {
    const wide = wb('/api/v1/supplier/orders', 'GET', { dateFrom: day(89) }) as unknown[]
    const narrow = wb('/api/v1/supplier/orders', 'GET', { dateFrom: day(7) }) as unknown[]
    const narrower = wb('/api/v1/supplier/orders', 'GET', { dateFrom: day(2) }) as unknown[]
    // Три разных значения давали один и тот же ответ — инкрементальную выгрузку
    // на таком стенде проверить нечем.
    expect(wide.length).toBeGreaterThan(narrow.length)
    expect(narrow.length).toBeGreaterThan(narrower.length)
  })

  it('исходы смешанные: без выкупов не считается процент выкупа', () => {
    const orders = wb('/api/v1/supplier/orders', 'GET', { dateFrom: day(30) }) as Array<Record<string, boolean>>
    const cancels = orders.filter((o) => o.isCancel === true).length
    expect(cancels).toBeGreaterThan(0)
    // Раньше isCancel: true стоял у всех — половина воронки не считалась вовсе.
    expect(cancels).toBeLessThan(orders.length)
  })

  it('в продажи попадают выкупы и возвраты, но не отмены', () => {
    const sales = wb('/api/v1/supplier/sales', 'GET', { dateFrom: day(60) }) as Array<Record<string, any>>
    expect(sales.length).toBeGreaterThan(0)
    // Возврат уносит выплату обратно и нумеруется с R — по этому клиент его и узнаёт.
    expect(sales.some((s) => Number(s.forPay) < 0)).toBe(true)
    expect(sales.some((s) => Number(s.forPay) > 0)).toBe(true)
    expect(sales.every((s) => Number(s.forPay) !== 0)).toBe(true)
    expect(sales.some((s) => String(s.saleID).startsWith('R'))).toBe(true)
  })

  it('лента заказов знает все свои статусы, а не один', () => {
    const feed = wb('/api/analytics/v1/order-feed', 'POST', {}, {})
    const statuses = new Set((feed.data.orders as Array<Record<string, string>>).map((o) => o.status))
    expect(statuses.size).toBeGreaterThan(1)
    expect([...statuses].every((s) => ['created', 'buyout', 'cancel', 'return'].includes(String(s)))).toBe(true)
  })

  it('заказы покрывают каталог, а не первые двадцать карточек', () => {
    const orders = wb('/api/v1/supplier/orders', 'GET', { dateFrom: day(89) }) as Array<Record<string, number>>
    const nmIds = new Set(orders.map((o) => o.nmId))
    const cards = wb('/content/v2/get/cards/list', 'POST', {}, { settings: { cursor: { limit: 100 } } })
      .cards as Array<Record<string, number>>
    // Товар из каталога должен находиться и в статистике: иначе юнит-экономику
    // по своей карточке не посчитать.
    expect(nmIds.size).toBeGreaterThan(100)
    expect(cards.filter((c) => nmIds.has(c.nmID!)).length).toBeGreaterThan(cards.length / 2)
  })

  it('журнал детерминирован в пределах суток', () => {
    const a = engine.handle({
      service: 'wildberries', httpMethod: 'GET', path: '/api/v1/supplier/orders',
      query: { dateFrom: day(10) }, headers: {}, body: null, requestId: 'r',
      scenario: 'success', now: new Date('2026-05-05T09:00:00Z'), salt: 'medium',
    }).serialized
    const b = engine.handle({
      service: 'wildberries', httpMethod: 'GET', path: '/api/v1/supplier/orders',
      query: { dateFrom: day(10) }, headers: {}, body: null, requestId: 'r',
      scenario: 'success', now: new Date('2026-05-05T21:30:00Z'), salt: 'medium',
    }).serialized
    expect(a).toBe(b)
  })
})

describe('аналитика отвечает за запрошенный период', () => {
  const now = new Date()
  const wb = (path: string, body: unknown) => JSON.parse(
    engine.handle({
      service: 'wildberries', httpMethod: 'POST', path, query: {}, headers: {}, body,
      requestId: 'r', scenario: 'success', now, salt: 'medium',
    }).serialized,
  ) as any

  const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10)

  it('воронка возвращает период запроса, а не интервал из документации', () => {
    const body = wb('/api/analytics/v3/sales-funnel/products', {
      currentPeriod: { start: day(30), end: day(0) },
    })
    const period = body.data.products[0].statistic.selected.period
    // Отвечала интервалом 2023-06-01…2024-03-01 независимо от запроса.
    expect(period.start.slice(0, 10)).toBe(day(30))
    expect(period.end.slice(0, 10)).toBe(day(0))
  })

  it('чем шире период, тем больше заказов', () => {
    const forDays = (days: number) => wb('/api/analytics/v3/sales-funnel/products', {
      currentPeriod: { start: day(days), end: day(0) },
    }).data.products[0].statistic.selected.orderCount as number
    const week = forDays(7)
    const quarter = forDays(90)
    // Пока цифры брались из карточки товара, неделя и квартал давали одно число,
    // и выбор периода на витрине проверить было нечем.
    expect(quarter).toBeGreaterThan(week)
  })

  it('история отдаёт ряд по дням, а не три точки с одной датой', () => {
    const body = wb('/api/analytics/v3/sales-funnel/products/history', {
      period: { start: day(14), end: day(0) },
      nmIDs: [],
    })
    const history = body[0].history as Array<Record<string, any>>
    const dates = history.map((h) => h.date as string)
    expect(new Set(dates).size).toBe(dates.length)
    expect(dates.length).toBeGreaterThan(10)
    // Ряд с одинаковыми числами графиком не является.
    expect(new Set(history.map((h) => h.orderCount)).size).toBeGreaterThan(1)
  })

  it('реклама считает позиции по товарам кабинета и по дням окна', () => {
    const stats = JSON.parse(engine.handle({
      service: 'wildberries', httpMethod: 'GET', path: '/adv/v3/fullstats',
      query: { ids: '1', begin: day(14), end: day(0) }, headers: {}, body: null,
      requestId: 'r', scenario: 'success', now, salt: 'medium',
    }).serialized) as Array<Record<string, any>>

    const pool = new Set(
      (JSON.parse(engine.handle({
        service: 'wildberries', httpMethod: 'POST', path: '/content/v2/get/cards/list',
        query: {}, headers: {}, body: { settings: { cursor: { limit: 200 } } },
        requestId: 'r', scenario: 'success', now, salt: 'medium',
      }).serialized).cards as Array<Record<string, number>>).map((c) => c.nmID),
    )
    // Позиции считались по nm 221725278, которого в кабинете нет.
    const booster = stats[0]!.boosterStats as Array<Record<string, number>>
    expect(booster.every((b) => pool.has(b.nm!))).toBe(true)
    const days = (stats[0]!.days as Array<Record<string, string>>).map((d) => d.date!.slice(0, 10))
    expect(days.every((d) => d >= day(14) && d <= day(0))).toBe(true)
  })
})


describe('рынок конкурентов вокруг каталога', () => {
  const pool = productPool('medium')

  it('у карточки есть чужие предложения того же предмета', () => {
    const product = pool[0]!
    const market = competitorsFor(product, 'medium')
    expect(market.length).toBeGreaterThan(5)
    expect(market.every((c) => c.subjectName === product.subjectName)).toBe(true)
    // Продавцов несколько: рынок из одного магазина рынком не является.
    expect(new Set(market.map((c) => c.sellerName)).size).toBeGreaterThan(2)
  })

  it('цены конкурентов группируются вокруг своей, а не по всему прайсу', () => {
    const product = pool[3]!
    const market = competitorsFor(product, 'medium')
    for (const c of market) {
      // Разброс в пределах трети в обе стороны: коридор цен, а не «айфон против коврика».
      expect(c.price).toBeGreaterThan(product.price * 0.6)
      expect(c.price).toBeLessThan(product.price * 1.45)
      expect(c.discountedPrice).toBeLessThanOrEqual(c.price)
    }
  })

  it('артикулы конкурентов не пересекаются с каталогом продавца', () => {
    const own = new Set(pool.map((p) => p.nmId))
    const market = pool.slice(0, 20).flatMap((p) => competitorsFor(p, 'medium'))
    // Иначе собранный «конкурент» окажется собственной карточкой, и наценка
    // будет считаться относительно самого себя.
    expect(market.some((c) => own.has(c.nmId))).toBe(false)
  })

  it('ИНН и ОГРН проходят проверку контрольной суммы', () => {
    const market = pool.slice(0, 12).flatMap((p) => competitorsFor(p, 'medium'))
    const checksum = (digits: number[], weights: number[]) =>
      (weights.reduce((acc, w, i) => acc + w * digits[i]!, 0) % 11) % 10

    for (const c of market) {
      const digits = [...c.inn].map(Number)
      if (digits.length === 10) {
        expect(digits[9]).toBe(checksum(digits.slice(0, 9), [2, 4, 10, 3, 5, 9, 4, 6, 8]))
      } else {
        expect(digits).toHaveLength(12)
        expect(digits[10]).toBe(checksum(digits.slice(0, 10), [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]))
        expect(digits[11]).toBe(checksum(digits.slice(0, 11), [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]))
      }
      // ОГРН: последняя цифра — остаток от деления числа без неё.
      const divisor = c.ogrn.length === 13 ? 11n : 13n
      expect(Number(c.ogrn.slice(-1))).toBe(Number(BigInt(c.ogrn.slice(0, -1)) % divisor) % 10)
    }
  })

  it('рынок детерминирован: тот же товар — те же предложения', () => {
    const a = competitorsFor(pool[7]!, 'medium')
    const b = competitorsFor(pool[7]!, 'medium')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('цена — свойство предмета, а не случайное число', () => {
  it('товары одного предмета стоят одного порядка', () => {
    const pool = productPool('medium')
    const bySubject = new Map<string, number[]>()
    for (const p of pool) {
      bySubject.set(p.subjectName, [...(bySubject.get(p.subjectName) ?? []), p.price])
    }
    for (const [subject, prices] of bySubject) {
      const min = Math.min(...prices)
      const max = Math.max(...prices)
      // Коврик для йоги стоил то 563 ₽, то 21 869 ₽ — медиана по такой категории
      // считается по величинам, которые вместе не встречаются.
      expect(max / min, `${subject}: ${min}..${max}`).toBeLessThan(12)
    }
  })
})
