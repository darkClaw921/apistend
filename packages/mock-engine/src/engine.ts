import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogBundle, CatalogMethod, Scenario, ServiceCode } from '@apistend/shared'
import { SERVICE_PROFILES, buildScenarioError, unknownMethodError } from '@apistend/shared'
import { MockRouter } from './router.ts'
import { Deterministic } from './deterministic.ts'
import { buildFromSchema } from './sampler.ts'
import { LruCache } from './cache.ts'

/**
 * Движок моков.
 *
 * Конвейер: route -> scenario -> assemble -> задержка.
 * Авторизация и лимиты живут выше, в шлюзе: им нужен доступ к базе.
 *
 * Три яруса ответа, по приоритету:
 *   1. пример из спецификации   (responseSource = 'example')
 *   2. схема + датасет          (responseSource = 'schema')
 *   3. generic-конверт сервиса  (responseSource = 'generic')
 */

const here = dirname(fileURLToPath(import.meta.url))
const GENERATED = join(here, '..', 'generated')

export interface ServiceIndex {
  bundle: CatalogBundle
  router: MockRouter
  spec: object | undefined
}

export interface MockRequest {
  service: ServiceCode
  httpMethod: string
  /** Путь без префикса сервиса: /api/v3/orders. */
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string | undefined>
  body: unknown
  /** Идентификатор запроса — уходит в конверт ошибки и в заголовок ответа. */
  requestId: string
  /** Сценарий, выбранный заголовком X-Mock-Scenario. */
  scenario: Scenario
  /** Опорное время: делает ответ воспроизводимым. */
  now: Date
  /**
   * Соль базового датасета — объём демо-данных песочницы (min | medium | full),
   * а НЕ идентификатор песочницы.
   *
   * Базовый датасет общий для всех песочниц и доступен только на чтение: именно это
   * делает создание песочницы операцией O(1), а сброс — удалением её overlay.
   * Побочный, но решающий эффект: ключей кеша получается три десятка сотен,
   * а не «сотни методов × количество аккаунтов».
   */
  salt: string
}

export interface MockResult {
  status: number
  body: unknown
  headers: Record<string, string>
  /** Найденный метод каталога. null, если такого метода нет. */
  method: CatalogMethod | null
  responseSource: 'example' | 'schema' | 'generic' | 'error'
  /** Задержка, которую шлюз обязан выдержать перед отправкой ответа. */
  latencyMs: number
  /**
   * Готовая JSON-строка тела. Шлюз отдаёт её напрямую и не сериализует повторно:
   * под нагрузкой второй JSON.stringify того же объекта — заметная доля процессора.
   */
  serialized: string
}

export class MockEngine {
  private readonly services = new Map<ServiceCode, ServiceIndex>()

  /**
   * Кеш успешных тел ответа.
   *
   * Корректен без оговорок: ответ движка — чистая функция от (метод, сценарий, соль),
   * это же свойство закреплено тестом на детерминизм. Ключей немного —
   * методы × объёмы датасета, — поэтому потолка в 50 000 записей хватает с запасом.
   */
  private readonly bodyCache = new LruCache<{ body: unknown; serialized: string }>(50_000)

  /** Загружает собранные ингестом артефакты. Отсутствующие сервисы просто пропускаются. */
  static load(codes: readonly ServiceCode[]): MockEngine {
    const engine = new MockEngine()
    for (const code of codes) {
      try {
        const bundle = JSON.parse(readFileSync(join(GENERATED, `${code}.catalog.json`), 'utf8')) as CatalogBundle
        let spec: object | undefined
        try {
          spec = JSON.parse(readFileSync(join(GENERATED, `${code}.spec.json`), 'utf8')) as object
        } catch {
          spec = undefined
        }
        engine.services.set(code, { bundle, router: new MockRouter(bundle.methods), spec })
      } catch {
        // Сервис ещё не заведён — это нормальное состояние между волнами.
      }
    }
    return engine
  }

  get loadedServices(): ServiceCode[] {
    return [...this.services.keys()]
  }

  index(service: ServiceCode): ServiceIndex | undefined {
    return this.services.get(service)
  }

  catalog(service: ServiceCode): readonly CatalogMethod[] {
    return this.services.get(service)?.bundle.methods ?? []
  }

  handle(req: MockRequest): MockResult {
    const index = this.services.get(req.service)
    if (!index) {
      const err = unknownMethodError(req.service, req.requestId)
      return {
        ...err, headers: { ...err.headers }, method: null,
        responseSource: 'error', latencyMs: 0, serialized: JSON.stringify(err.body),
      }
    }

    const ignoreHttpMethod = SERVICE_PROFILES[req.service].routing === 'path-only'
    const matched = index.router.match(req.httpMethod, req.path, ignoreHttpMethod)
    if (!matched) {
      const err = unknownMethodError(req.service, req.requestId)
      const suggestions = index.router.suggest(req.path)
      return {
        status: err.status,
        body: err.body,
        headers: {
          ...err.headers,
          ...(suggestions.length > 0 ? { 'x-apistend-did-you-mean': suggestions.join(', ') } : {}),
        },
        method: null,
        responseSource: 'error',
        latencyMs: 0,
        serialized: JSON.stringify(err.body),
      }
    }

    const method = matched.method

    // Сценарий ошибки: отдаём конверт в родном для сервиса формате и выходим.
    if (req.scenario !== 'success' && req.scenario !== 'timeout') {
      const err = buildScenarioError(req.service, req.scenario, req.requestId)
      return {
        status: err.status,
        body: err.body,
        headers: { ...err.headers, 'x-apistend-scenario': req.scenario },
        method,
        responseSource: 'error',
        latencyMs: method.latencyMs,
        serialized: JSON.stringify(err.body),
      }
    }

    const cacheKey = `${method.id}|${req.salt}`
    const cached = this.bodyCache.get(cacheKey)
    if (cached) {
      return {
        status: method.successStatus,
        body: cached.body,
        serialized: cached.serialized,
        headers: this.successHeaders(req, method, method.responseSource),
        method,
        responseSource: method.responseSource,
        latencyMs: method.latencyMs,
      }
    }

    const det = new Deterministic(`${req.salt}|${method.id}`)
    const ctx = { det, now: req.now }
    const built = this.buildBody(index, method, ctx)

    const serialized = JSON.stringify(built.body ?? null)
    this.bodyCache.set(cacheKey, { body: built.body, serialized })

    return {
      status: method.successStatus,
      body: built.body,
      serialized,
      headers: this.successHeaders(req, method, built.source),
      method,
      responseSource: built.source,
      latencyMs: method.latencyMs,
    }
  }

  /** Три яруса ответа, по приоритету. Вызывается только при промахе кеша. */
  private buildBody(
    index: ServiceIndex,
    method: CatalogMethod,
    ctx: { det: Deterministic; now: Date },
  ): { body: unknown; source: 'example' | 'schema' | 'generic' } {
    // Ярус 1: пример из спецификации.
    if (method.responseExample !== null && method.responseExample !== undefined) {
      return { body: method.responseExample, source: 'example' }
    }

    // Ярус 2: схема + детерминированный филлер.
    if (method.responseSchemaRef) {
      const schema = method.responseSchemaRef === 'inline'
        ? inlineSchema(index.spec, method)
        : { $ref: method.responseSchemaRef }
      const built = buildFromSchema(schema, index.spec, ctx, method.id)
      if (built !== null) return { body: built, source: 'schema' }
    }

    // Ярус 3: generic. Схемы нет — врать нечем, отдаём честный пустой конверт.
    return { body: genericBody(index.bundle.serviceCode, method), source: 'generic' }
  }

  /** Диагностика для /health: видно, работает ли кеш и не переполнен ли он. */
  cacheStats() {
    return this.bodyCache.stats()
  }

  /**
   * Заголовки честности. Мок обязан быть неотличим по телу и коду ответа,
   * но обязан быть отличим по метаданным — иначе им нельзя пользоваться осознанно.
   */
  private successHeaders(
    req: MockRequest,
    method: CatalogMethod,
    source: 'example' | 'schema' | 'generic',
  ): Record<string, string> {
    const profile = SERVICE_PROFILES[req.service]
    return {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': req.requestId,
      'x-apistend-source': source,
      'x-apistend-readiness': method.readiness,
      'x-apistend-scenario': req.scenario,
      'x-apistend-upstream': method.upstreamHost,
      'x-apistend-snapshot': method.snapshotDate,
      'x-ratelimit-limit': String(profile.rateLimit.limit),
    }
  }
}

function inlineSchema(spec: object | undefined, method: CatalogMethod): unknown {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> } | undefined)?.paths
  const op = paths?.[method.path]?.[method.httpMethod.toLowerCase()] as
    | { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
    | undefined
  return op?.responses?.[String(method.successStatus)]?.content?.['application/json']?.schema ?? null
}

/** Пустой, но валидный для сервиса конверт: клиент не должен падать на разборе. */
function genericBody(service: ServiceCode, method: CatalogMethod): unknown {
  if (method.successStatus === 204) return null
  if (service === 'ozon') return { result: {} }
  if (service === 'bitrix24') return { result: [], total: 0 }
  return {}
}
