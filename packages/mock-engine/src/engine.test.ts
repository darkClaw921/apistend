import { describe, it, expect, beforeAll } from 'vitest'
import type { ServiceCode } from '@apistend/shared'
import { MockEngine } from './engine.ts'
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

  it('лимит: у Ozon 429 с Retry-After, у Wildberries 429 с X-Ratelimit-*', () => {
    const oz = engine.handle(req({ service: 'ozon', httpMethod: 'POST', path: '/v3/posting/fbs/list', scenario: 'rate_limit' }))
    expect(oz.status).toBe(429)
    expect(oz.headers['retry-after']).toBeDefined()

    const wb = engine.handle(req({ httpMethod: 'GET', path: '/api/v3/warehouses', scenario: 'rate_limit' }))
    expect(wb.status).toBe(429)
    expect(wb.headers['x-ratelimit-retry']).toBeDefined()
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
