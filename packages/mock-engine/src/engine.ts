import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogBundle, CatalogMethod, Scenario, ServiceCode } from '@apistend/shared'
import { SERVICE_PROFILES, buildScenarioError, unknownMethodError } from '@apistend/shared'
import { MockRouter } from './router.ts'
import { Deterministic } from './deterministic.ts'
import type { FillContext } from './sampler.ts'
import { buildFromSchema } from './sampler.ts'
import { projectExample } from './project.ts'
import { productPool } from './dataset.ts'
import { isDefaultPage, readPage } from './page.ts'
import { endOfWindow, readWindow } from './window.ts'
import { eventsInWindow, orderTimeline } from './timeline.ts'
import { advertCampaigns, readAdvertIds, requestedCampaigns } from './adverts.ts'
import { LruCache } from './cache.ts'
import { dayBucket, shiftDatesToToday } from './dates.ts'

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

  /**
   * Второй заход по маршрутам — с путём, приведённым к написанию спецификации.
   *
   * Возвращает метод каталога как есть: и в журнале, и в заголовках честности
   * должен стоять тот метод, чей ответ отдан, а не строка, набранная клиентом.
   */
  private matchAlias(index: ServiceIndex, req: MockRequest, ignoreHttpMethod: boolean) {
    for (const alias of SERVICE_PROFILES[req.service].pathAliases ?? []) {
      if (!alias.from.test(req.path)) continue
      const canonical = req.path.replace(alias.from, alias.to)
      const hit = index.router.match(req.httpMethod, canonical, ignoreHttpMethod)
      if (hit) return hit
    }
    return null
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
    // Каноничный путь ищем первым: алиас — редкое написание, и платить за него
    // лишним проходом по шаблонам на каждом запросе незачем.
    const matched =
      index.router.match(req.httpMethod, req.path, ignoreHttpMethod) ??
      this.matchAlias(index, req, ignoreHttpMethod)
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

    // Страница входит в ключ: ответ зависит от неё так же, как от метода и объёма.
    const page = readPage(req.query, req.body)
    // Сутки — тоже часть ключа: даты фикстур сдвигаются к сегодняшнему дню, и вчерашнее
    // тело завтра стало бы неправдой. Определённость остаётся в тех границах, в которых
    // она возможна: один и тот же вызов в пределах дня даёт один и тот же ответ.
    const cacheKey = `${method.id}|${req.salt}|${page.offset}:${page.limit}|${dayBucket(req.now)}`
    // Кешируем только страницу по умолчанию и только запрос без своего периода.
    // Ключей у произвольной пагинации столько, сколько клиент придумает смещений,
    // а у периода — сколько придумает дат; кеш из полезного превратился бы в способ
    // занять память. Собрать страницу заново стоит доли миллисекунды.
    // Кешируем только запрос без своего периода и без выбранных кампаний:
    // и то и другое меняет тело, а в ключе кеша их нет.
    const cacheable = isDefaultPage(page)
      && !readWindow(req.query, req.body, req.now).explicit
      && readAdvertIds(req.query, req.body).length === 0
    const cached = cacheable ? this.bodyCache.get(cacheKey) : undefined
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
    // Каталог зависит только от объёма датасета: иначе «тот же товар» в двух
    // методах снова оказался бы разными товарами.
    const pool = productPool(req.salt)
    const window = readWindow(req.query, req.body, req.now)
    // Журнал собирается лениво и только для методов, которым он нужен: методов
    // статистики в каталоге десятки, а всего методов — две с половиной тысячи.
    const events = () => eventsInWindow(orderTimeline(req.salt, pool, req.now), window.from, endOfWindow(window))
    // Кампании — тоже лениво: они нужны десятку рекламных методов из двух с
    // половиной тысяч, и собирать их на каждом ответе каталога незачем.
    const campaigns = () => requestedCampaigns(
      advertCampaigns(req.salt, pool, req.now),
      readAdvertIds(req.query, req.body),
    )
    const ctx = { det, now: req.now, pool, page, window, events, campaigns }
    const built = this.buildBody(index, method, ctx)
    // Даты — последним шагом, поверх любого яруса: и пример из документации,
    // и сгенерированное по схеме тело одинаково датированы днём, когда писали
    // спецификацию, а клиент считает витрину за последние 7–90 дней.
    // Ярусы примера и схемы датируются внутри buildBody — до проекции. Здесь
    // остаётся только generic-конверт: он собирается из профиля сервиса и дат
    // документации не содержит вовсе.
    const body = built.dated ? built.body : shiftDatesToToday(built.body, req.now)

    const serialized = JSON.stringify(body ?? null)
    if (cacheable) this.bodyCache.set(cacheKey, { body, serialized })

    return {
      status: method.successStatus,
      body,
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
    ctx: FillContext,
  ): { body: unknown; source: 'example' | 'schema' | 'generic'; dated: boolean } {
    // Ярус 1: пример из спецификации. Форму берём из документации, товары — из каталога
    // песочницы: иначе каталог, заказы и финансы говорили бы про разные артикулы.
    if (method.responseExample !== null && method.responseExample !== undefined) {
      const example = stripStaticTime(index.bundle.serviceCode, method.responseExample)
      // Сдвиг — ДО проекции. Тело из документации датировано днём, когда её писали,
      // и общий сдвиг переносит его в сегодняшний день целиком, сохраняя расстояния.
      // Проекция затем ставит свои даты там, где они значат конкретное: событие
      // журнала, день ряда, границы запрошенного периода. В обратном порядке
      // сдвиг считался бы по нашим же свежим датам, выходил нулевым — и всё, чего
      // проекция не коснулась, оставалось бы в позапрошлом году.
      const projected = projectExample(shiftDatesToToday(example, ctx.now), ctx)
      return { body: projected.value, source: 'example', dated: true }
    }

    // Ярус 2: схема + детерминированный филлер.
    if (method.responseSchemaRef) {
      const schema = method.responseSchemaRef === 'inline'
        ? inlineSchema(index.spec, method)
        : { $ref: method.responseSchemaRef }
      const built = buildFromSchema(schema, index.spec, ctx, method.id)
      // Проекция нужна и здесь. Схема даёт форму и товарные значения, но не знает
      // ни о журнале заказов, ни о запрошенном периоде: сгенерированный по ней
      // временной ряд — это три точки с одной датой, а «лента заказов» — список,
      // где у всех записей один статус. Событиями и днями занимается проекция.
      if (built !== null) {
        const projected = projectExample(shiftDatesToToday(built, ctx.now), ctx)
        return { body: projected.value, source: 'schema', dated: true }
      }
    }

    // Ярус 3: generic. Схемы нет — врать нечем, отдаём честный пустой конверт.
    return { body: genericBody(index.bundle.serviceCode, method), source: 'generic', dated: false }
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
    return {
      // Content-Type — тоже боевой заголовок: у Битрикс24 он с charset, у Ozon и WB
      // без него. Берём из профиля сервиса, а не подставляем один на всех.
      'content-type': SERVICE_PROFILES[req.service].native.contentType,
      // Собственный идентификатор APIStend. Боевое имя заголовка (x-request-id у WB,
      // x-o3-trace-id у Ozon) ставит шлюз: только он знает, есть ли такой заголовок
      // у сервиса вообще, — у Битрикс24 его нет.
      'x-apistend-request-id': req.requestId,
      'x-apistend-source': source,
      'x-apistend-readiness': method.readiness,
      'x-apistend-scenario': req.scenario,
      'x-apistend-upstream': method.upstreamHost,
      'x-apistend-snapshot': method.snapshotDate,
      // X-Ratelimit-* здесь не место: счётчик ведёт шлюз, и он же знает остаток.
      // Движок подставлял сюда среднюю скорость из профиля (у Bitrix24 это 2),
      // затирая выставленную шлюзом ёмкость, — и клиент получал Limit: 2
      // при Remaining: 49. Оба заголовка теперь выставляет один владелец.
    }
  }
}

function inlineSchema(spec: object | undefined, method: CatalogMethod): unknown {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> } | undefined)?.paths
  const op = paths?.[method.path]?.[method.httpMethod.toLowerCase()] as
    | { responses?: Record<string, unknown> }
    | undefined
  // Ответ бывает записан ссылкой на общий компонент — так у половины методов WB.
  // Без разыменования такой метод молча уезжал на generic-ярус и отдавал пустой
  // объект: именно так «цены и скидки» оказывались пустыми при живой схеме.
  const response = deref(spec, op?.responses?.[String(method.successStatus)]) as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined
  const content = response?.content
  if (!content) return null
  const json = content['application/json'] ?? Object.values(content)[0]
  return deref(spec, json?.schema) ?? null
}

/** Разыменовывает локальный $ref. Схему не раскрывает: с ней справляется сэмплер. */
function deref(spec: object | undefined, node: unknown, depth = 0): unknown {
  if (depth > 8 || node === null || typeof node !== 'object') return node
  const ref = (node as { $ref?: unknown }).$ref
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node
  let cur: unknown = spec
  for (const seg of ref.slice(2).split('/')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return deref(spec, cur, depth + 1)
}

/**
 * Убирает из примера Битрикс24 статичный конверт `time`.
 *
 * В документации он записан датами того дня, когда писали пример, и отдавать его
 * как есть — то же самое, что показывать вчерашние часы. Живой конверт приписывает
 * шлюз: он один знает, сколько запрос выполнялся на самом деле. Здесь же выгодно
 * и по стоимости: тело кешируется без time, и шлюзу остаётся приклеить готовую
 * строку, а не пересобирать объект на каждый вызов.
 */
function stripStaticTime(service: ServiceCode, example: unknown): unknown {
  if (service !== 'bitrix24') return example
  if (example === null || typeof example !== 'object' || Array.isArray(example)) return example
  if (!('time' in example)) return example
  const { time: _static, ...rest } = example as Record<string, unknown>
  return rest
}

/** Пустой, но валидный для сервиса конверт: клиент не должен падать на разборе. */
function genericBody(service: ServiceCode, method: CatalogMethod): unknown {
  if (method.successStatus === 204) return null
  if (service === 'ozon') return { result: {} }
  if (service === 'bitrix24') return { result: [], total: 0 }
  // Apify заворачивает КАЖДЫЙ ответ в конверт data — и одиночный объект, и список.
  // Клиент, читающий response.data, на голом {} получил бы undefined и упал бы
  // не там, где ошибся, а на следующем обращении к полю.
  if (service === 'apify') return { data: {} }
  return {}
}
