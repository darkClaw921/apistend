import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { env } from '../../env.ts'
import { SESSION_COOKIE } from '../../lib/auth.ts'
import {
  MGMT_SCOPES,
  MGMT_SCOPE_LABELS,
  requireMgmt,
  requireMgmtSandbox,
  sendError,
  type MgmtCtx,
  type MgmtSandboxCtx,
  type Scope,
} from '../../lib/mgmt.ts'

/**
 * Реестр маршрутов Management API.
 *
 * Маршрут объявляется один раз — и этим же объявлением проверяется вход,
 * ставится статус ответа и описывается OpenAPI. Документация, собранная
 * из отдельного файла, расходится с кодом на первом же изменении поля;
 * здесь разойтись нечему, потому что источник один и тот же.
 *
 * Путь пишется в форме Fastify (`/sandboxes/:sandboxId/keys`) — в OpenAPI
 * он переводится в `{sandboxId}` при сборке документа.
 */

export const V1_PREFIX = '/api/v1'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type ZodPart = z.ZodObject | undefined
type Parsed<T> = T extends z.ZodType ? z.output<T> : Record<string, never>

export interface RouteInput<P, Q, B> {
  params: Parsed<P>
  query: Parsed<Q>
  body: Parsed<B>
}

export interface RouteSpec<
  P extends ZodPart = undefined,
  Q extends ZodPart = undefined,
  B extends ZodPart = undefined,
  R extends z.ZodType = z.ZodType,
  NS extends boolean = false,
> {
  method: HttpMethod
  /** Без префикса /api/v1. Пустой путь и «/» заняты библиотекой BX24.js. */
  path: string
  scope: Scope
  summary: string
  description?: string
  tags: string[]
  params?: P
  query?: Q
  body?: B
  response: R
  /** Код успешного ответа. По умолчанию 200 — создание объявляет 201 явно. */
  status?: number
  /** true — обработчик получает ctx.sandbox, разрешённую по :sandboxId / ?sandboxId= / ключу. */
  needsSandbox?: NS
  /**
   * Коды отказа, которыми маршрут отвечает помимо общих (400/401/403/404/429).
   *
   * Общие реестр проставляет сам, а 409 и 422 зависят от смысла операции: занятое имя,
   * потолок серий, отзыв уже отозванного ключа. Клиент, сгенерированный по спецификации,
   * знает только объявленные коды — необъявленный 409 у него превращается в необработанную
   * ошибку транспорта вместо понятного «имя занято». 404 объявляется автоматически там,
   * где есть путь с параметром или песочница; маршрутам вроде /usage, которые ищут
   * песочницу сами, его приходится назвать здесь.
   */
  failures?: readonly ('CONFLICT' | 'UNPROCESSABLE' | 'NOT_FOUND')[]
  /**
   * Дополнительные типы содержимого успешного ответа.
   *
   * Почти всё здесь — JSON, но выгрузка журнала при format=csv отдаёт text/csv.
   * Документ, обещающий только application/json, ломает сгенерированный по нему
   * клиент: тот пробует разобрать CSV как JSON.
   */
  responseMedia?: readonly string[]
}

export type RouteHandler<
  P extends ZodPart,
  Q extends ZodPart,
  B extends ZodPart,
  R extends z.ZodType,
  NS extends boolean,
> = (
  ctx: NS extends true ? MgmtSandboxCtx : MgmtCtx,
  input: RouteInput<P, Q, B>,
  req: FastifyRequest,
  reply: FastifyReply,
) => z.input<R> | Promise<z.input<R>>

type AnySpec = RouteSpec<z.ZodObject | undefined, z.ZodObject | undefined, z.ZodObject | undefined, z.ZodType, boolean>
type AnyHandler = (
  ctx: MgmtSandboxCtx,
  input: { params: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> },
  req: FastifyRequest,
  reply: FastifyReply,
) => unknown

/**
 * Ключ — метод и путь, а не порядковый номер: сквозные тесты поднимают сервер
 * заново в том же процессе, и на массиве реестр рос бы с каждым прогоном,
 * а OpenAPI получал бы каждый маршрут по нескольку раз.
 */
const registry = new Map<string, AnySpec>()

// ─────────────────────────── Ответы об ошибках ───────────────────────────

/** Все возвращают never — чтобы писалось `return notFound(reply, …)` в любом обработчике. */

export function notFound(reply: FastifyReply, message = 'Объект не найден'): never {
  return sendError(reply, 404, 'NOT_FOUND', message)
}

export function badRequest(reply: FastifyReply, message: string, issues?: string[]): never {
  return sendError(reply, 400, 'VALIDATION', message, issues)
}

export function conflict(reply: FastifyReply, message: string): never {
  return sendError(reply, 409, 'CONFLICT', message)
}

export function forbidden(reply: FastifyReply, message: string): never {
  return sendError(reply, 403, 'FORBIDDEN', message)
}

/** Ограничение самого продукта (потолок серии, лимит песочниц), а не частота запросов. */
export function unprocessable(reply: FastifyReply, message: string, issues?: string[]): never {
  return sendError(reply, 422, 'UNPROCESSABLE', message, issues)
}

// ─────────────────────────── Постраничность ───────────────────────────

/**
 * Единый вид для всех списков: курсор — идентификатор последней отданной записи.
 *
 * Смещением (offset) листать нельзя: журнал запросов пополняется во время листания,
 * и страница 2 отдала бы часть страницы 1. Курсор от такого не зависит.
 */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
})

export type PageQuery = z.output<typeof pageQuery>

export function pageResponse<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    /** null — записей больше нет. */
    nextCursor: z.string().nullable(),
  })
}

/**
 * Аргументы Prisma для запроса страницы. Берём limit + 1 запись: наличие лишней
 * и есть ответ на вопрос «есть ли следующая страница», отдельного count не нужно.
 *
 * Курсором служит поле id — оно есть у всех моделей, которые отдаёт этот API.
 */
export function pageArgs(query: PageQuery): { take: number; skip?: number; cursor?: { id: string } } {
  /*
   * Запись курсора НЕ пропускается (skip: 0), хотя в выдачу она не пойдёт.
   *
   * Prisma по несуществующему курсору просто отдаёт пустую выборку, и список
   * возвращал 200 с нулём записей — то есть «данных больше нет» вместо «курсор
   * недействителен». Скрипт, сохранивший курсор между запусками (а записи за это
   * время унёс ретеншен), записал бы пустоту как факт. Забирая саму запись курсора,
   * мы получаем возможность это различить: её отсутствие и означает негодный курсор.
   * Цена — одна лишняя строка в выборке.
   */
  return query.cursor
    ? { take: query.limit + 2, skip: 0, cursor: { id: query.cursor } }
    : { take: query.limit + 1 }
}


export function page<T extends { id: string }, O = T>(
  rows: T[],
  query: PageQuery,
  map?: (row: T) => O,
): { items: O[]; nextCursor: string | null } {
  // Первой строкой идёт сама запись курсора (см. pageArgs) — в страницу она не входит.
  const tail = query.cursor ? rows.slice(1) : rows
  const visible = tail.slice(0, query.limit)
  const last = visible[visible.length - 1]
  return {
    items: map ? visible.map(map) : (visible as unknown as O[]),
    nextCursor: tail.length > query.limit && last ? last.id : null,
  }
}

/**
 * Страница с проверкой курсора.
 *
 * Курсор считается годным, только если запись с таким идентификатором нашлась
 * первой в той же выборке, то есть существует и подходит под фильтры запроса.
 * Иначе — 400 с объяснением, как у каталога: молчаливая пустая страница здесь
 * читается как «данных нет» и обманывает того, кто листает журнал скриптом.
 */
export function pageChecked<T extends { id: string }, O = T>(
  reply: FastifyReply,
  rows: T[],
  query: PageQuery,
  map?: (row: T) => O,
): { items: O[]; nextCursor: string | null } {
  if (query.cursor && rows[0]?.id !== query.cursor) {
    badRequest(reply, `Курсор «${query.cursor}» недействителен: такой записи больше нет или она не подходит под фильтры`, [
      'cursor: запросите первую страницу без курсора',
    ])
  }
  return page(rows, query, map)
}

// ─────────────────────────── Объявление маршрута ───────────────────────────

function fullPath(path: string): string {
  if (path === '' || path === '/') {
    // По этим двум адресам отдаётся библиотека BX24.js (routes/b24-apps.ts).
    throw new Error('Management API: путь «/» занят библиотекой BX24.js, выберите другой')
  }
  if (!path.startsWith('/')) throw new Error(`Management API: путь «${path}» должен начинаться с «/»`)
  return `${V1_PREFIX}${path}`
}

function collectIssues(
  schema: z.ZodObject | undefined,
  raw: unknown,
  where: string,
  issues: string[],
): Record<string, unknown> {
  if (!schema) return {}
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data as Record<string, unknown>
  for (const issue of parsed.error.issues) {
    const at = issue.path.length > 0 ? `${where}.${issue.path.join('.')}` : where
    issues.push(`${at}: ${issue.message}`)
  }
  return {}
}

const WRONG_CONTENT_TYPE =
  'Тело запроса должно быть JSON с заголовком «Content-Type: application/json»'

/**
 * Management API принимает только JSON, но до него тело успевает разобрать
 * кто-то ещё: application/json — Fastify, форму — парсер из server.ts,
 * всё остальное — заглушка, отдающая Buffer (она нужна мок-шлюзу, который
 * обязан принять любое тело). Поэтому строку и Buffer разбираем сами.
 *
 * Отдельный случай — `curl -d '{…}'` без Content-Type: curl объявляет форму,
 * и весь JSON становится ИМЕНЕМ единственного поля. Без этой проверки клиент
 * получал бы «поле title обязательно» на запрос, где title он как раз прислал.
 */
function readJsonBody(req: FastifyRequest): { ok: true; value: unknown } | { ok: false; message: string } {
  const raw = req.body

  if (Buffer.isBuffer(raw) || typeof raw === 'string') {
    const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw).trim()
    if (text.length === 0) return { ok: true, value: {} }
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false, message: WRONG_CONTENT_TYPE }
    }
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw)
    const only = keys[0]
    if (keys.length === 1 && only && /^[{[]/.test(only) && (raw as Record<string, unknown>)[only] === '') {
      return { ok: false, message: `${WRONG_CONTENT_TYPE}. Похоже, JSON ушёл как поле формы` }
    }
  }

  return { ok: true, value: raw }
}

export function defineRoute<
  R extends z.ZodType,
  P extends ZodPart = undefined,
  Q extends ZodPart = undefined,
  B extends ZodPart = undefined,
  NS extends boolean = false,
>(app: FastifyInstance, spec: RouteSpec<P, Q, B, R, NS>, handler: RouteHandler<P, Q, B, R, NS>): void {
  const url = fullPath(spec.path)
  registry.set(`${spec.method} ${spec.path}`, spec as unknown as AnySpec)
  const run = handler as unknown as AnyHandler

  app.route({
    method: spec.method,
    url,
    handler: async (req, reply) => {
      const ctx = spec.needsSandbox
        ? await requireMgmtSandbox(req, reply, spec.scope)
        : await requireMgmt(req, reply, spec.scope)
      if (!ctx) return reply

      /*
       * Помощники ошибок объявлены как never ради `return notFound(…)` в обработчиках,
       * а возвращают null. Здесь, внутри обработчика Fastify, null — это тело ответа,
       * и Fastify отправлял его вторым: клиент получал верную 400, а в журнал на каждую
       * ошибку валидации падал FST_ERR_REP_ALREADY_SENT со статусом 500. Возвращаем reply —
       * для Fastify это признак «ответ уже отправлен вручную».
       */
      const parsedBody = readJsonBody(req)
      if (!parsedBody.ok) {
        badRequest(reply, parsedBody.message)
        return reply
      }

      const issues: string[] = []
      const params = collectIssues(spec.params, req.params, 'params', issues)
      const query = collectIssues(spec.query, req.query, 'query', issues)
      const body = collectIssues(spec.body, parsedBody.value, 'body', issues)
      if (issues.length > 0) {
        badRequest(reply, 'Некорректные данные запроса', issues)
        return reply
      }

      const result = await run(ctx as MgmtSandboxCtx, { params, query, body }, req, reply)
      // Обработчик мог ответить сам — через notFound(), conflict() или напрямую.
      if (reply.sent) return reply
      return reply.code(spec.status ?? 200).send(result)
    },
  })
}

// ─────────────────────────── OpenAPI ───────────────────────────

/**
 * Схема JSON из той же схемы zod, которой проверяется вход.
 *
 * io: 'input' здесь принципиален. Поле с .default() на входе необязательно,
 * а на выходе всегда есть — при io: 'output' документация требовала бы от клиента
 * присылать то, что он присылать не обязан. Ответы описываются тоже по входу:
 * их схема не применяется к данным, значит наружу уходит именно входная форма.
 *
 * unrepresentable: 'any' плюс подмена для дат: Date в JSON Schema не выражается
 * и по умолчанию роняет сборку, а обработчики отдают Date как есть — Fastify
 * сериализует её в ISO-строку. Описываем ровно то, что увидит клиент.
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      const type = (ctx.zodSchema as { _zod?: { def?: { type?: string } } })._zod?.def?.type
      if (type === 'date') {
        const js = ctx.jsonSchema as Record<string, unknown>
        js.type = 'string'
        js.format = 'date-time'
      }
    },
  }) as Record<string, unknown>
}

function rewriteRefs(node: unknown, prefix: string): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item, prefix)
    return
  }
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const ref = obj.$ref
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    obj.$ref = `#/components/schemas/${prefix}_${ref.slice('#/$defs/'.length)}`
  }
  for (const value of Object.values(obj)) rewriteRefs(value, prefix)
}

/**
 * $defs zod складывает внутрь схемы, а ссылки в них абсолютные — «#/$defs/…».
 * Внутри документа OpenAPI такая ссылка указывает в корень и никуда не попадает
 * (это заметно на z.json(), которым описываются JSON-поля Prisma). Поэтому
 * определения поднимаются в components.schemas, а ссылки переписываются.
 */
function convert(schema: z.ZodType, prefix: string, shared: Record<string, unknown>): Record<string, unknown> {
  const js = toJsonSchema(schema)
  delete js.$schema
  const defs = js.$defs as Record<string, unknown> | undefined
  if (defs) {
    delete js.$defs
    for (const [name, def] of Object.entries(defs)) {
      shared[`${prefix}_${name}`] = def
      rewriteRefs(def, prefix)
    }
  }
  rewriteRefs(js, prefix)
  return js
}

function operationId(spec: AnySpec): string {
  const tail = spec.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${spec.method.toLowerCase()}_${tail || 'root'}`
}

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function parametersOf(
  schema: z.ZodObject | undefined,
  location: 'path' | 'query',
  prefix: string,
  shared: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!schema) return []
  const js = convert(schema, prefix, shared) as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const required = new Set(js.required ?? [])
  return Object.entries(js.properties ?? {}).map(([name, propertySchema]) => ({
    name,
    in: location,
    // Необязательный параметр пути — это другой маршрут, а не тот же самый.
    required: location === 'path' ? true : required.has(name),
    schema: propertySchema,
  }))
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  }
}

function operationOf(spec: AnySpec, shared: Record<string, unknown>): Record<string, unknown> {
  const id = operationId(spec)
  const parameters = [
    ...parametersOf(spec.params, 'path', `${id}_path`, shared),
    ...parametersOf(spec.query, 'query', `${id}_query`, shared),
  ]

  if (spec.needsSandbox && !parameters.some((p) => p.name === 'sandboxId')) {
    parameters.push({
      name: 'sandboxId',
      in: 'query',
      required: false,
      description: 'Песочница. По умолчанию — песочница ключа, а для сессии кабинета первая песочница аккаунта.',
      schema: { type: 'string' },
    })
  }

  const status = String(spec.status ?? 200)
  const extraMedia = Object.fromEntries(
    (spec.responseMedia ?? []).map((media) => [media, { schema: { type: 'string' } }]),
  )
  const responses: Record<string, unknown> = {
    [status]: {
      description: 'Успешный ответ',
      content: {
        'application/json': { schema: convert(spec.response, `${id}_response`, shared) },
        ...extraMedia,
      },
    },
    401: errorResponse('Нужен серверный ключ stend_sk_… или сессия кабинета'),
    403: errorResponse(`Субъекту не выдана область доступа «${spec.scope}»`),
    429: errorResponse('Превышен лимит запросов к Management API'),
  }
  if (spec.params || spec.query || spec.body) responses['400'] = errorResponse('Ошибка проверки данных запроса')
  if (spec.needsSandbox || spec.params) responses['404'] = errorResponse('Объект не найден или принадлежит другому аккаунту')
  for (const failure of spec.failures ?? []) {
    if (failure === 'CONFLICT') responses['409'] = errorResponse('Конфликт с текущим состоянием: имя занято либо объект уже в этом состоянии')
    if (failure === 'UNPROCESSABLE') responses['422'] = errorResponse('Запрос понятен, но запрещён правилом продукта: потолок, зависимость, необратимость')
    if (failure === 'NOT_FOUND') responses['404'] = errorResponse('Объект не найден или принадлежит другому аккаунту')
  }

  const description = [
    spec.description,
    `Требуемая область доступа: \`${spec.scope}\` — ${MGMT_SCOPE_LABELS[spec.scope]}. Ключ с пустым списком областей имеет полный доступ.`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')

  return {
    operationId: id,
    summary: spec.summary,
    description,
    tags: spec.tags,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(spec.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: convert(spec.body, `${id}_body`, shared) } },
          },
        }
      : {}),
    responses,
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  }
}

export function openApiDocument(origin: string): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    Error: {
      type: 'object',
      required: ['error', 'message'],
      properties: {
        error: { type: 'string', description: 'Машинный код: UNAUTHORIZED, VALIDATION, NOT_FOUND, RATE_LIMITED…' },
        message: { type: 'string', description: 'Объяснение для человека, по-русски' },
        issues: { type: 'array', items: { type: 'string' }, description: 'Разбор ошибок валидации по полям' },
      },
    },
  }

  const paths: Record<string, Record<string, unknown>> = {}
  const tags = new Set<string>()

  for (const spec of [...registry.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const key = openApiPath(spec.path)
    paths[key] ??= {}
    ;(paths[key] as Record<string, unknown>)[spec.method.toLowerCase()] = operationOf(spec, shared)
    for (const tag of spec.tags) tags.add(tag)
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'APIStend Management API',
      version: '1.0.0',
      description:
        'Программный доступ ко всему, что делается в кабинете APIStend: песочницы, ключи, вебхуки, ' +
        'сценарии, серии событий, свои моки, журнал запросов, каталог методов и консоль.\n\n' +
        'Авторизация — серверный ключ `Authorization: Bearer stend_sk_…` либо cookie-сессия кабинета. ' +
        'Ключ песочницы (`stend_sbx_…`) здесь не принимается: им ходит код интеграции, и он утекает легче.\n\n' +
        `Ограничение частоты: ${env.mgmtRateLimitPerMin} запросов в минуту на ключ или сессию. ` +
        'Остаток — в заголовках `X-RateLimit-*`, при превышении приходит 429 с `Retry-After`.',
    },
    servers: [{ url: `${origin}${V1_PREFIX}`, description: 'APIStend' }],
    tags: [...tags].sort().map((name) => ({ name })),
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Серверный ключ: `Authorization: Bearer stend_sk_…`. Права ключа ограничиваются списком областей.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description: 'Сессия кабинета. Тем же API пользуется браузер, поэтому у сессии полный доступ к аккаунту.',
        },
      },
      schemas: shared,
    },
    paths,
    'x-scopes': MGMT_SCOPES.map((scope) => ({ scope, description: MGMT_SCOPE_LABELS[scope] })),
  }
}

/**
 * Адрес, по которому клиент реально пришёл.
 *
 * В servers документа должен стоять он, а не env.publicOrigin: за nginx в спецификацию
 * уехал бы localhost, и сгенерированный по ней клиент ходил бы в никуда. `trustProxy`
 * в server.ts включён, поэтому req.protocol и req.host уже учитывают X-Forwarded-Proto
 * и X-Forwarded-Host — разбирать заголовки руками не нужно. Запрос без Host бывает
 * только в HTTP/1.0, для него остаётся настройка.
 */
function originOf(req: FastifyRequest): string {
  return req.host ? `${req.protocol}://${req.host}` : env.publicOrigin
}

/**
 * Спецификация и краткая справка — без авторизации.
 *
 * Оба маршрута описывают только форму запросов и ничего не рассказывают про данные
 * аккаунта, а клиенту генератора кода ключ взять неоткуда: за спецификацией он идёт
 * до того, как ключ появился. Документ собирается на каждый запрос — реестр к этому
 * моменту заполнен целиком, и порядок регистрации доменов перестаёт иметь значение.
 */
export function registerOpenApiRoute(app: FastifyInstance): void {
  /*
   * Документ собирается один раз на адрес и дальше отдаётся из памяти.
   *
   * Сборка — это преобразование схем zod всех шестидесяти с лишним маршрутов в JSON Schema;
   * маршрут открыт без авторизации, и цикл curl по нему выедал бы процессор у того же
   * процесса, который обслуживает мок-шлюз. Набор маршрутов между перезапусками не меняется,
   * поэтому ключом достаточно адреса: за прокси он приходит из заголовков запроса.
   */
  const documentCache = new Map<string, Record<string, unknown>>()

  app.get(`${V1_PREFIX}/openapi.json`, async (req, reply) => {
    const origin = originOf(req)
    const cached = documentCache.get(origin) ?? openApiDocument(origin)
    documentCache.set(origin, cached)
    return reply.send(cached)
  })

  /**
   * Точка, с которой начинают знакомство: что за версия, чем авторизоваться,
   * какие бывают области доступа и где предел частоты. Без неё каждый клиент
   * добывал бы эти числа из документации, то есть из чужой памяти.
   */
  app.get(`${V1_PREFIX}/meta`, async (req, reply) => {
    const origin = originOf(req)
    return reply.send({
      version: '1.0.0',
      prefix: V1_PREFIX,
      routes: registry.size,
      auth: {
        bearer: 'Authorization: Bearer stend_sk_…',
        cookie: SESSION_COOKIE,
        note:
          'Ключ песочницы (stend_sbx_…) здесь не принимается: им ходит код интеграции, ' +
          'а Management API умеет удалять данные и выпускать ключи.',
      },
      rateLimit: {
        perMinute: env.mgmtRateLimitPerMin,
        subject: 'ключ, а для браузера — сессия кабинета',
        headers: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
      },
      pagination: {
        limitDefault: 25,
        limitMax: 100,
        cursor: 'идентификатор последней отданной записи, передаётся в ?cursor=',
        response: '{ items, nextCursor }',
      },
      errors: {
        envelope: '{ error, message, issues? }',
        // Общие для всего API. Отдельные маршруты добавляют к ним свои коды —
        // они перечислены в описании маршрута в openapi.json.
        codes: [
          'UNAUTHORIZED', 'SANDBOX_KEY_NOT_ALLOWED', 'FORBIDDEN', 'SANDBOX_NOT_FOUND',
          'NOT_FOUND', 'VALIDATION', 'INVALID_JSON', 'CONFIRM_MISMATCH', 'CONFLICT',
          'UNPROCESSABLE', 'RATE_LIMITED', 'INTERNAL',
        ],
      },
      scopes: MGMT_SCOPES.map((scope) => ({ scope, description: MGMT_SCOPE_LABELS[scope] })),
      docs: { openapi: `${origin}${V1_PREFIX}/openapi.json` },
    })
  })
}

export type { MgmtCtx, MgmtSandboxCtx, Scope }
