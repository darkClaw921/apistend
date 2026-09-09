import type { Readiness, ServiceCode } from '@apistend/shared'

export interface Me {
  user: { id: string; login: string; email: string | null; name: string; initials: string; planLabel: string }
  usage: { requestsThisMonth: number; hasLimits: boolean }
  /** Счётчики сайдбара. Все — из базы: в вёрстке чисел нет. */
  counts: {
    requestsToday: number
    keys: number
    mocks: number
    webhooks: number
    alerts: number
    catalogMethods: number
  }
  /** Шаги «Первые шаги». Каждый проверен по данным, а не по локальному флажку. */
  onboarding: Array<{ id: string; label: string; href: string; done: boolean }>
  sandboxes: Array<{
    id: string; name: string; project: string; status: string
    dataVolume: 'min' | 'medium' | 'full'; latencyMs: number; errorRate: number; lastResetAt: string
  }>
}

export interface ServiceSummary {
  code: ServiceCode
  title: string
  letter: string
  shortCode: string
  apiVersion: string
  brandToken: string
  replacesUrl: string
  mockBaseUrl: string
  methodsCount: number
  status: 'ok' | 'planned' | 'updating'
  snapshotDate: string | null
  rateLimit: string
  nativeAuth: string
  /**
   * Акторов в снятом снимке магазина. Есть только у Apify; у остальных null —
   * не ноль: акторов у них не бывает как понятия.
   */
  actorsCount?: number | null
  /** Живые счётчики витрины: считаются по журналу запросов, кешируются на 30 секунд. */
  usage?: {
    requestsTotal: number
    requestsDay: number
    /** Разработчиков, обращавшихся к сервису за 30 дней. */
    users: number
    /** Из них те, чей запрос был в последние пять минут. */
    usersOnline: number
  }
}

export interface CatalogListItem {
  id: string
  serviceCode: ServiceCode
  httpMethod: string
  path: string
  title: string
  description: string
  group: string
  tag: string
  version: string
  readiness: Readiness
  deprecated: boolean
}

export interface CatalogResponse {
  total: number
  offset: number
  limit: number
  methods: CatalogListItem[]
  groups: Array<{ serviceCode: ServiceCode; group: string; count: number }>
}

export interface MethodDetail extends CatalogListItem {
  params: Array<{ name: string; in: string; type: string; required: boolean; description: string }>
  scenarios: Array<{ scenario: string; statusCode: number; title: string; isDefault: boolean }>
  latencyMs: number
  responseSource: 'example' | 'schema' | 'generic'
  extraction: 'spec' | 'mirror' | 'parsed'
  sourceUrl: string
  snapshotDate: string
  license: string | null
  upstreamHost: string
  exampleUrl: string
  unifiedUrl: string
  rateLimit: { limit: number; windowMs: number; statusCode: number; description: string }
  nativeAuth: { kind: string; description: string }
}

export interface ApiKeyItem {
  id: string
  name: string
  subtitle: string | null
  kind: 'sandbox' | 'server'
  mask: string
  services: ServiceCode[]
  status: 'active' | 'expiring' | 'revoked'
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  revokedBy: string | null
  requestsPerDay: number
  rotationDays: number
}

export interface KeysResponse {
  keys: ApiKeyItem[]
  summary: { total: number; active: number; revoked: number; note: string; rotationNote: string }
  baseUrls: Array<{
    code: ServiceCode; title: string; letter: string; shortCode: string
    brandToken: string; mockUrl: string; replaces: string
  }>
}

export interface ConsoleResult {
  requestId: string
  status: number
  durationMs: number
  sizeBytes: number
  headers: Record<string, string>
  body: unknown
  scenario: string
  responseSource: string
  readiness: Readiness | null
  upstreamUrl: string | null
  method: { id: string; title: string; group: string } | null
  curl: string
  simulated?: boolean
  note?: string
}

export interface LogRow {
  id: string
  publicId: string
  timestamp: string
  serviceCode: string
  httpMethod: string
  endpoint: string
  statusCode: number
  durationMs: number
  sizeBytes: number
  apiKeyName: string | null
}

export interface LogsResponse {
  summary: { total: number; errorRate: number; avgLatencyMs: number; p95LatencyMs: number }
  hourly: Array<{ hour: string; total: number; errors: number }>
  total: number
  offset: number
  limit: number
  rows: LogRow[]
  /** Доля выборки журнала: под нагрузкой он прореживается, и это должно быть видно. */
  sampling?: { sampleRate: number; sampledOut: number }
}

export interface LogDetail extends LogRow {
  scenario: string
  responseSource: string
  clientIp: string | null
  upstreamUrl: string | null
  requestHeaders: Record<string, unknown> | null
  responseHeaders: Record<string, unknown> | null
  requestBody: string | null
  responseBody: string | null
  responseBodyReproduced: boolean
}

export interface LocalAgent {
  connected: boolean
  agentVersion: string | null
  sessionId: string | null
  forwardUrl: string | null
  latencyMs: number | null
  eventsLastHour: number
  failedDeliveries: number
}

export interface WebhookItem {
  id: string
  serviceCode: ServiceCode
  event: string
  httpMethod: string
  target: 'public' | 'local'
  targetUrl: string | null
  /** Для локальной доставки — ОТНОСИТЕЛЬНЫЙ путь: базу подставляет apistend listen. */
  targetPath: string | null
  status: 'active' | 'paused' | 'failing' | 'disabled'
  lastAttemptAt: string | null
  successRate24h: number
}

export interface DeliveryItem {
  id: string
  event: string
  serviceCode: ServiceCode
  timestamp: string
  state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'no_response' | 'dropped'
  attempt: number
  maxAttempts: number
  statusCode: number | null
  durationMs: number | null
  targetDisplay: string
  contentType: string
  rawBody: string
  errorMessage: string | null
}

export interface ScenarioItem {
  id: string
  name: string
  serviceCode: ServiceCode
  /** Код события, которое рассылает сценарий. */
  event: string
  /** Сколько событий отправляет запуск. */
  stepsCount: number
  status: string
  /** Заказанная скорость, событий в секунду. */
  ratePerSec: number
  errorRate: number
  progress: number
  /** Фактическая скорость идущего запуска. null — сценарий не идёт. */
  actualRatePerSec: number | null
  /** Приложение не успевает отвечать, серия притормаживает. */
  lagging: boolean
  lastRunAt: string | null
  lastRunNote: string | null
}

export interface WebhooksResponse {
  localAgent: LocalAgent
  webhooks: WebhookItem[]
  deliveries: DeliveryItem[]
  deliveryStats: { succeeded: number; failed: number; retried: number }
  scenarios: ScenarioItem[]
  burstLimits: { maxRatePerSec: number; maxCount: number; maxConcurrent: number }
  forwardBase: string
}

export interface EventsResponse {
  services: Array<{
    code: ServiceCode
    title: string
    webhook: {
      contentType: string
      timeoutMs: number
      retries: number
      successRule: string
      signature: string
      notes: string
    }
    events: Array<{ code: string; title: string; aliasInMockup: string | null }>
  }>
}

export interface CustomMockItem {
  id: string
  httpMethod: string
  path: string
  title: string
  status: 'active' | 'draft' | 'disabled'
  responseStatusCode: number
  contentType: string
  delayMs: number
  templatingEnabled: boolean
  responseBody: string
  callsCount: number
  rulesCount?: number
  updatedAt: string
}

export interface MocksResponse {
  mocks: CustomMockItem[]
  placeholders: Array<{ code: string; description: string }>
  counts: { all: number; active: number; draft: number; disabled: number }
}

export interface RecentRequest {
  id: string
  timestamp: string
  serviceCode: string
  httpMethod: string
  endpoint: string
  statusCode: number
  durationMs: number
  apiKeyName: string | null
}

/** Уведомление песочницы. Приходит и в обзоре, и отдельно — для шапки. */
export interface AlertItem {
  id: string
  /** danger | warning | info — так же, как в design-handoff/03-data-model.md. */
  severity: string
  title: string
  meta: string
  icon: string
  /** Куда ведёт уведомление: обычно фильтр журнала запросов. */
  link: string | null
}

/** GET /api/alerts */
export interface AlertsResponse {
  alerts: AlertItem[]
}

export interface OverviewResponse {
  kpi: {
    requests24h: number
    requestsGrowthPercent: number | null
    avgLatencyMs: number
    errorRatePercent: number
    activeKeys: number
  }
  recent: RecentRequest[]
  alerts: AlertItem[]
  services: Array<{ code: string; title: string; methodsCount: number; snapshotDate: string | null; status: string }>
  totalMethods: number
}

export interface SearchResult {
  id: string
  serviceCode: string
  httpMethod: string
  path: string
  title: string
  description: string
  readiness: string
}

export interface SearchResponse {
  query: string
  total: number
  results: SearchResult[]
}

export interface PreviewResponse {
  method: { id: string; httpMethod: string; path: string; title: string; serviceCode: string; readiness: string }
  request: Record<string, unknown> | null
  response: unknown
  statusCode: number
  durationMs: number
  sizeBytes: number
  responseSource: string
}

/** POST /api/mocks/:id/test — тест-вызов из кабинета. */
export interface MockTestResult {
  status: number
  contentType: string
  delayMs: number
  body: string
  validJson: boolean
  /** false — мок черновик или выключен: по публичному адресу он не отвечает. */
  servedPublicly: boolean
  mockStatus: string
}
