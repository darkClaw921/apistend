import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  B24_APP_KINDS,
  B24_LIFECYCLE_EVENTS,
  B24_REFRESH_TTL_MAX_SECONDS,
  B24_REFRESH_TTL_MIN_SECONDS,
  B24_TOKEN_TTL_MAX_SECONDS,
  B24_TOKEN_TTL_MIN_SECONDS,
  EVENTS_BY_SERVICE,
  EXTRACTION_KINDS,
  READINESS,
  RESPONSE_SOURCES,
  SERVICE_CODES,
  SERVICE_LIST,
  SERVICE_PROFILES,
  buildEventPayload,
  isB24Scope,
  isServiceCode,
  type CatalogMethod,
  type ServiceCode,
} from '@apistend/shared'
import { prisma } from '../../db.ts'
import { env } from '../../env.ts'
import { engine } from '../../gateway.ts'
import {
  clientEndpoint,
  generateClientId,
  generateClientSecret,
  generateHexToken,
  memberIdFor,
  portalDomain,
  serverEndpoint,
} from '../../b24/portal.ts'
import { revokeAppTokens } from '../../b24/tokens.ts'
import { dispatchWebhook } from '../../webhooks/dispatcher.ts'
import { getSession } from '../../tunnel/registry.ts'
import { checkPublicTarget } from '../../lib/webhook-target.ts'
import { sendError } from '../../lib/mgmt.ts'
import {
  badRequest,
  conflict,
  defineRoute,
  notFound,
  page,
  pageChecked,
  pageArgs,
  pageQuery,
  pageResponse,
} from './_registry.ts'

/**
 * Справочники движка (сервисы, методы, события), локальные приложения Bitrix24
 * и состояние туннеля.
 *
 * Справочники не лежат в базе: каталог собирается при сборке и живёт в памяти
 * мок-движка. Отсюда два следствия, которых нет у остальных разделов API:
 * фильтры и постраничность считаются по массиву, а не запросом к PostgreSQL,
 * и содержимое одинаково для всех аккаунтов — песочница этим маршрутам не нужна.
 */

// ─────────────────────────── Общие схемы каталога ───────────────────────────

/**
 * Json из Prisma в поле схемы z.json().
 *
 * Оба типа описывают одно и то же дерево JSON, но каждый своей рекурсией,
 * и структурно они друг к другу не сводятся. Приведение честнее, чем описать
 * поле как unknown: в документации остаётся настоящий JSON.
 */
type JsonOut = z.input<ReturnType<typeof z.json>>

function asJson(value: Prisma.JsonValue): JsonOut {
  return value as JsonOut
}

const serviceCodeSchema = z.enum(SERVICE_CODES)

/**
 * Происхождение метода отдаётся всегда, а не только в карточке.
 *
 * Каталог наполняется волнами: часть методов снята со спецификации, часть
 * разобрана из документации, у части ответ собран по схеме, а не взят примером.
 * Клиент, который строит на моке проверки, обязан видеть эту разницу в том же
 * ответе, где берёт метод, — иначе неполный каталог выдаётся за полный.
 */
const originSchema = z.object({
  responseSource: z.enum(RESPONSE_SOURCES),
  extraction: z.enum(EXTRACTION_KINDS),
  sourceUrl: z.string(),
  snapshotDate: z.string(),
  license: z.string().nullable(),
})

const rateLimitSchema = z.object({
  limit: z.number().int(),
  windowMs: z.number().int(),
  burst: z.number().int(),
  statusCode: z.number().int(),
  retryAfterSeconds: z.number().int().nullable(),
  description: z.string(),
})

const nativeAuthSchema = z.object({
  kind: z.enum(['path', 'headers', 'header']),
  headers: z.array(z.string()).nullable(),
  description: z.string(),
})

const methodItemSchema = z.object({
  id: z.string(),
  serviceCode: serviceCodeSchema,
  httpMethod: z.string(),
  path: z.string(),
  title: z.string(),
  description: z.string(),
  group: z.string(),
  tag: z.string(),
  version: z.string(),
  readiness: z.enum(READINESS),
  deprecated: z.boolean(),
  origin: originSchema,
})

const methodDetailSchema = methodItemSchema.extend({
  upstreamHost: z.string(),
  successStatus: z.number().int(),
  latencyMs: z.number().int(),
  params: z.array(
    z.object({
      name: z.string(),
      in: z.enum(['query', 'body', 'path', 'header']),
      type: z.string(),
      required: z.boolean(),
      description: z.string(),
    }),
  ),
  scenarios: z.array(
    z.object({
      scenario: z.string(),
      statusCode: z.number().int(),
      title: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  responseExample: z.unknown(),
  responseSchemaRef: z.string().nullable(),
  requestSchemaRef: z.string().nullable(),
  /** Адрес мока в форме сервиса: то, что подставляется вместо боевого хоста. */
  mockUrl: z.string(),
  /** Тот же метод через единый префикс /v1/<сервис> — им ходит консоль. */
  unifiedUrl: z.string(),
  rateLimit: rateLimitSchema,
  nativeAuth: nativeAuthSchema,
})

function originOf(m: CatalogMethod) {
  return {
    responseSource: m.responseSource,
    extraction: m.extraction,
    sourceUrl: m.sourceUrl,
    snapshotDate: m.snapshotDate,
    license: m.license,
  }
}

function toMethodItem(m: CatalogMethod) {
  return {
    id: m.id,
    serviceCode: m.serviceCode,
    httpMethod: m.httpMethod,
    path: m.path,
    title: m.title,
    description: m.description,
    group: m.group,
    tag: m.tag,
    version: m.version,
    readiness: m.readiness,
    deprecated: m.deprecated,
    origin: originOf(m),
  }
}

function nativeAuthOf(code: ServiceCode) {
  const auth = SERVICE_PROFILES[code].nativeAuth
  return {
    kind: auth.kind,
    headers: auth.headers ? [...auth.headers] : null,
    description: auth.description,
  }
}

function rateLimitOf(code: ServiceCode) {
  const rl = SERVICE_PROFILES[code].rateLimit
  return {
    limit: rl.limit,
    windowMs: rl.windowMs,
    burst: rl.burst,
    statusCode: rl.statusCode,
    retryAfterSeconds: rl.retryAfterSeconds,
    description: rl.description,
  }
}

// ─────────────────────────── Приложения Bitrix24 ───────────────────────────

/** События жизненного цикла приходят на адрес из карточки, их никто не подписывал. */
const LIFECYCLE_EVENTS: string[] = [...B24_LIFECYCLE_EVENTS]

const appListInclude = {
  _count: {
    select: {
      placements: true,
      tokens: true,
      // Только подписки приложения: ONAPPINSTALL в счётчике подписок был бы ложью.
      webhooks: { where: { event: { notIn: LIFECYCLE_EVENTS } } },
    },
  },
} as const

const appDetailInclude = {
  ...appListInclude,
  placements: { orderBy: { createdAt: 'asc' } },
} as const

type AppListRow = Prisma.B24AppGetPayload<{ include: typeof appListInclude }>
type AppDetailRow = Prisma.B24AppGetPayload<{ include: typeof appDetailInclude }>

const appKindSchema = z.enum(B24_APP_KINDS)
const appStateSchema = z.enum(['awaiting_install', 'installed', 'uninstalled'])

const appItemSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  kind: appKindSchema,
  state: appStateSchema,
  scope: z.array(z.string()),
  handlerUrl: z.string().nullable(),
  installUrl: z.string().nullable(),
  menuTitle: z.string().nullable(),
  clientId: z.string(),
  version: z.number().int(),
  tokenTtlSeconds: z.number().int(),
  refreshTtlSeconds: z.number().int(),
  installedAt: z.date().nullable(),
  lastInstallNote: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  counts: z.object({
    placements: z.number().int(),
    tokens: z.number().int(),
    subscriptions: z.number().int(),
  }),
})

const appDetailSchema = appItemSchema.extend({
  /**
   * Секрет отдаётся только в карточке и при создании: в списке он не нужен никому,
   * а лог вызова со списком приложений так не превращается в утечку всех паролей
   * сразу. Перевыпуска нет — боевой портал его тоже не умеет, есть удаление
   * и создание заново.
   */
  clientSecret: z.string(),
  /**
   * Токен приложения — тот самый, которым подписаны события и который сверяет
   * обработчик. Секрет по своей роли, поэтому живёт там же, где clientSecret:
   * в карточке и в ответе на создание, но не в списке.
   */
  applicationToken: z.string(),
  /** Адреса демо-портала: без них скрипт не соберёт ни OAuth, ни вызов REST. */
  portal: z.object({
    domain: z.string(),
    memberId: z.string(),
    clientEndpoint: z.string(),
    serverEndpoint: z.string(),
  }),
  placements: z.array(
    z.object({
      id: z.string(),
      placement: z.string(),
      handler: z.string(),
      title: z.string().nullable(),
      options: z.json(),
      createdAt: z.date(),
    }),
  ),
})

function toAppItem(row: AppListRow) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    kind: row.kind,
    state: row.state,
    scope: row.scope,
    handlerUrl: row.handlerUrl,
    installUrl: row.installUrl,
    menuTitle: row.menuTitle,
    clientId: row.clientId,
    version: row.version,
    tokenTtlSeconds: row.tokenTtlSeconds,
    refreshTtlSeconds: row.refreshTtlSeconds,
    installedAt: row.installedAt,
    lastInstallNote: row.lastInstallNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    counts: {
      placements: row._count.placements,
      tokens: row._count.tokens,
      subscriptions: row._count.webhooks,
    },
  }
}

function toAppDetail(row: AppDetailRow, sandboxId: string) {
  return {
    ...toAppItem(row),
    clientSecret: row.clientSecret,
    applicationToken: row.applicationToken,
    portal: {
      domain: portalDomain(),
      memberId: memberIdFor(sandboxId),
      clientEndpoint: clientEndpoint(),
      serverEndpoint: serverEndpoint(),
    },
    placements: row.placements.map((p) => ({
      id: p.id,
      placement: p.placement,
      handler: p.handler,
      title: p.title,
      options: asJson(p.options),
      createdAt: p.createdAt,
    })),
  }
}

/** Адрес, который откроет браузер портала: javascript: и file: сюда попасть не должны. */
function httpUrl(label: string) {
  return z.string().refine(
    (v) => {
      try {
        const protocol = new URL(v).protocol
        return protocol === 'http:' || protocol === 'https:'
      } catch {
        return false
      }
    },
    `${label} должен быть адресом http или https`,
  )
}

const appCreateSchema = z.object({
  title: z.string().min(1, 'Укажите название приложения').max(120),
  code: z.string().regex(/^[a-z0-9._-]{2,60}$/i, 'Код — латиница, цифры, точка, дефис, 2–60 символов').optional(),
  kind: appKindSchema.default('server_ui'),
  scope: z.array(z.string()).min(1, 'Выберите хотя бы одно право'),
  handlerUrl: httpUrl('Путь обработчика').nullish(),
  installUrl: httpUrl('Путь установки').nullish(),
  menuTitle: z.string().max(120).nullish(),
  tokenTtlSeconds: z.number().int()
    .min(B24_TOKEN_TTL_MIN_SECONDS, `Срок токена — не меньше ${B24_TOKEN_TTL_MIN_SECONDS} секунд`)
    .max(B24_TOKEN_TTL_MAX_SECONDS, 'Срок токена — не больше суток')
    .optional(),
  refreshTtlSeconds: z.number().int()
    .min(B24_REFRESH_TTL_MIN_SECONDS, `Срок refresh_token — не меньше ${B24_REFRESH_TTL_MIN_SECONDS} секунд`)
    .max(B24_REFRESH_TTL_MAX_SECONDS, 'Срок refresh_token — не больше 180 суток')
    .optional(),
})

/**
 * Правка: код приложения не меняется, а kind теряет значение по умолчанию.
 *
 * partial() снимает обязательность, но не default(): без явного переопределения
 * правка одного названия переводила бы приложение обратно в server_ui. Код же
 * попадает в app.info CODE и в ссылки REST_APP_URI, и кабинет его не меняет —
 * менять его здесь значило бы получить два разных поведения у одного объекта.
 */
const appPatchSchema = appCreateSchema.omit({ code: true }).partial().extend({
  kind: appKindSchema.optional(),
})

/** Права проверяются по справочнику: неизвестное право молча ничего не даст. */
function unknownScopes(scope: string[] | undefined): string[] {
  return (scope ?? []).filter((s) => !isB24Scope(s))
}

/**
 * Адреса приложения проверяются тем же правилом, что и адрес вебхука.
 *
 * Событие ONAPPUNINSTALL уходит на адрес приложения обычной публичной доставкой,
 * то есть запросом с нашего сервера. Без этой проверки карточка приложения была бы
 * обходным входом для внутреннего адреса мимо checkPublicTarget, которым закрыт
 * маршрут вебхуков. Диспетчер проверяет адрес ещё раз перед отправкой; здесь —
 * чтобы человек узнал о негодном адресе сразу, а не из журнала доставок.
 */
async function appTargetIssue(handlerUrl: string | null, installUrl: string | null): Promise<string | null> {
  for (const [field, value] of [['handlerUrl', handlerUrl], ['installUrl', installUrl]] as const) {
    if (!value) continue
    const verdict = await checkPublicTarget(value)
    if (!verdict.ok) return `${field}: ${verdict.reason}`
  }
  return null
}

/** Вид приложения определяет, какой адрес обязателен: без него его нечем открыть. */
function missingUrlIssue(kind: 'server_ui' | 'api_only', handlerUrl: string | null, installUrl: string | null): string | null {
  if (kind === 'server_ui' && !handlerUrl) return 'Для приложения с интерфейсом нужен путь обработчика (handlerUrl)'
  if (kind === 'api_only' && !installUrl) return 'Для приложения без интерфейса нужен путь установки (installUrl)'
  return null
}

function slugify(title: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  }
  const slug = title
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48)
  return slug.length >= 2 ? slug : `app.${generateHexToken().slice(0, 6)}`
}

/**
 * ONAPPUNINSTALL уходит на адрес приложения перед удалением записи.
 *
 * Событие идёт через тот же диспетчер и ту же запись Webhook, что и у кабинета:
 * второй путь доставки дал бы приложению два разных конверта одного события
 * и раздвоил бы «Журнал доставок».
 */
async function notifyUninstall(row: {
  id: string
  sandboxId: string
  handlerUrl: string | null
  installUrl: string | null
  applicationToken: string
}) {
  const target = row.handlerUrl ?? row.installUrl
  if (!target) return null

  // Запись переиспользуется: повторная установка и удаление не должны плодить
  // в журнале несколько «каналов» на один и тот же адрес.
  const existing = await prisma.webhook.findFirst({
    where: { appId: row.id, event: 'ONAPPUNINSTALL', targetUrl: target },
  })
  const webhook = existing ?? (await prisma.webhook.create({
    data: {
      sandboxId: row.sandboxId,
      appId: row.id,
      serviceCode: 'bitrix24',
      event: 'ONAPPUNINSTALL',
      httpMethod: 'POST',
      target: 'public',
      targetUrl: target,
      secret: row.applicationToken,
      status: 'active',
    },
  }))

  const sent = await dispatchWebhook({ sandboxId: row.sandboxId, webhookId: webhook.id })
  if (!sent) return null

  /*
   * Движок доставок называет способ transport, а адрес — target. В ресурсах
   * Management API те же смыслы у полей вебхука: target — способ, targetUrl — адрес.
   * Переименовываем здесь, на границе: одно и то же слово в двух значениях
   * ловится клиентом только через `if (delivery.target === 'public')`, который
   * молча всегда ложен.
   */
  return { deliveryId: sent.deliveryId, state: sent.state, target: sent.transport, targetUrl: sent.target }
}

// ─────────────────────────── Маршруты ───────────────────────────

export function registerCatalogV1Routes(app: FastifyInstance): void {
  // ─────────── Каталог ───────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/services',
      scope: 'catalog:read',
      summary: 'Сервисы, которые умеет подменять APIStend',
      description:
        'Число методов и дата снимка берутся из самого каталога, а не из настроек: сервис со статусом ' +
        '«planned» заведён, но методов у него пока нет, и обещать их нельзя. mockBaseUrl — префикс, ' +
        'который подставляется вместо боевого адреса из replacesUrl.',
      tags: ['Каталог'],
      response: z.object({
        services: z.array(
          z.object({
            code: serviceCodeSchema,
            title: z.string(),
            apiVersion: z.string(),
            /** Боевой адрес, который подменяет песочница. */
            replacesUrl: z.string(),
            mockBaseUrl: z.string(),
            methodsCount: z.number().int(),
            status: z.enum(['ok', 'planned']),
            snapshotDate: z.string().nullable(),
            /** Значим ли HTTP-глагол при поиске метода: у Bitrix24 имя метода лежит в пути. */
            routing: z.enum(['method-and-path', 'path-only']),
            rateLimit: rateLimitSchema,
            nativeAuth: nativeAuthSchema,
          }),
        ),
        totalMethods: z.number().int(),
      }),
    },
    async () => {
      const services = SERVICE_LIST.map((profile) => {
        const methods = engine.catalog(profile.code)
        return {
          code: profile.code,
          title: profile.title,
          apiVersion: profile.apiVersion,
          replacesUrl: profile.replacesUrl,
          mockBaseUrl: `${env.publicOrigin}${profile.mountPath}/`,
          methodsCount: methods.length,
          status: methods.length === 0 ? ('planned' as const) : ('ok' as const),
          snapshotDate: methods[0]?.snapshotDate ?? null,
          routing: profile.routing,
          rateLimit: rateLimitOf(profile.code),
          nativeAuth: nativeAuthOf(profile.code),
        }
      })
      return { services, totalMethods: services.reduce((sum, s) => sum + s.methodsCount, 0) }
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/methods',
      scope: 'catalog:read',
      summary: 'Поиск метода в каталоге',
      description:
        'Фильтры складываются по «И». Поиск q идёт по пути, названию и описанию, регистр не важен. ' +
        'Порядок методов задан снимком спецификации и между запросами не меняется, поэтому курсор ' +
        'указывает на конкретную запись — но он действителен только при том же наборе фильтров: ' +
        'с другими фильтрами запись в выборку не попадёт и придёт 400. Полное описание метода вместе ' +
        'с параметрами и сценариями отдаёт GET /methods/{id}.',
      tags: ['Каталог'],
      query: pageQuery.extend({
        service: serviceCodeSchema.optional(),
        /** Раздел внутри сервиса — то же значение, что в поле group ответа. */
        group: z.string().min(1).optional(),
        readiness: z.enum(READINESS).optional(),
        q: z.string().min(2, 'Строка поиска — не короче 2 символов').max(100).optional(),
      }),
      response: pageResponse(methodItemSchema).extend({
        /** Сколько методов подошло под фильтры целиком, а не на этой странице. */
        total: z.number().int(),
      }),
    },
    async (_ctx, input, _req, reply) => {
      const codes: readonly ServiceCode[] = input.query.service ? [input.query.service] : SERVICE_CODES
      let methods = codes.flatMap((code) => [...engine.catalog(code)])

      if (input.query.group) {
        methods = methods.filter((m) => m.group === input.query.group)
      }
      if (input.query.readiness) {
        methods = methods.filter((m) => m.readiness === input.query.readiness)
      }
      const needle = input.query.q?.trim().toLowerCase()
      if (needle) {
        methods = methods.filter(
          (m) =>
            m.path.toLowerCase().includes(needle) ||
            m.title.toLowerCase().includes(needle) ||
            m.description.toLowerCase().includes(needle),
        )
      }

      let start = 0
      if (input.query.cursor) {
        const at = methods.findIndex((m) => m.id === input.query.cursor)
        // Молча начать с начала нельзя: клиент в цикле «пока есть nextCursor»
        // получил бы бесконечную первую страницу.
        if (at < 0) {
          return badRequest(
            reply,
            `Курсор «${input.query.cursor}» не относится к этой выборке: он действителен только при тех же фильтрах`,
          )
        }
        start = at + 1
      }

      const window = methods.slice(start, start + input.query.limit + 1)
      return { ...page(window, input.query, toMethodItem), total: methods.length }
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/methods/:id',
      scope: 'catalog:read',
      summary: 'Карточка метода каталога',
      description:
        'Идентификатор — «сервис:ГЛАГОЛ:/путь», и его нужно кодировать целиком (encodeURIComponent): ' +
        'двоеточия и слэши внутри пути иначе разъедутся по сегментам адреса. ' +
        'Кроме параметров и сценариев ответ несёт происхождение метода: по нему видно, снят ли ответ ' +
        'с примера из спецификации или собран по схеме.',
      tags: ['Каталог'],
      params: z.object({ id: z.string().min(1) }),
      response: methodDetailSchema,
    },
    async (_ctx, input, _req, reply) => {
      // Fastify декодирует сегмент сам, но клиент мог закодировать дважды —
      // для строки без процентов повторное декодирование ничего не меняет.
      // Одиночный процент в идентификаторе (100%zz) при этом бросает URIError:
      // без перехвата клиент получал 500 вместо честного «метод не найден».
      let id = input.params.id
      try {
        id = decodeURIComponent(id)
      } catch {
        return notFound(reply, `Метод «${input.params.id}» не найден в каталоге`)
      }
      const serviceCode = id.split(':')[0]
      if (!isServiceCode(serviceCode)) return notFound(reply, `Метод «${id}» не найден в каталоге`)

      const found = engine.catalog(serviceCode).find((m) => m.id === id)
      if (!found) return notFound(reply, `Метод «${id}» не найден в каталоге`)

      const profile = SERVICE_PROFILES[serviceCode]
      return {
        ...toMethodItem(found),
        upstreamHost: found.upstreamHost,
        successStatus: found.successStatus,
        latencyMs: found.latencyMs,
        params: found.params.map((p) => ({
          name: p.name,
          in: p.in,
          type: p.type,
          required: p.required,
          description: p.description,
        })),
        scenarios: found.scenarios.map((s) => ({
          scenario: s.scenario,
          statusCode: s.statusCode,
          title: s.title,
          isDefault: s.isDefault,
        })),
        responseExample: found.responseExample,
        responseSchemaRef: found.responseSchemaRef,
        requestSchemaRef: found.requestSchemaRef,
        mockUrl: `${env.publicOrigin}${profile.mountPath}${found.path}`,
        unifiedUrl: `${env.publicOrigin}/v1/${serviceCode}${found.path}`,
        rateLimit: rateLimitOf(serviceCode),
        nativeAuth: nativeAuthOf(serviceCode),
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/events',
      scope: 'catalog:read',
      summary: 'События вебхуков по сервисам',
      description:
        'Справочник для подписок: коды событий, правила доставки сервиса и пример тела. ' +
        'Пример показан целиком, вместе с конвертом сервиса, — у Bitrix24 это form-urlencoded ' +
        'с PHP-скобками, у Wildberries JSON со списком events[], и обработчик, написанный ' +
        'под «просто полезные поля», в бою не заработает. Значения в примере демонстрационные: ' +
        'токен и requestId в настоящей доставке будут другими.',
      tags: ['Каталог'],
      response: z.object({
        services: z.array(
          z.object({
            code: serviceCodeSchema,
            title: z.string(),
            webhook: z.object({
              contentType: z.string(),
              timeoutMs: z.number().int(),
              /** Сколько повторов делает сервис. 0 — не повторяет вовсе, как боевой Bitrix24. */
              retries: z.number().int(),
              retryDelaysMs: z.array(z.number().int()),
              successRule: z.enum(['status_2xx', 'status_200', 'status_200_and_body']),
              expectedResponseBody: z.record(z.string(), z.unknown()).nullable(),
              signature: z.enum(['none', 'application_token', 'hmac_sha256']),
              signatureHeader: z.string().nullable(),
              maxBatchSize: z.number().int(),
              /** Ставит ли сервис подписку на паузу после серии неудач. */
              suspendsAfterFailures: z.boolean(),
              notes: z.string(),
            }),
            events: z.array(
              z.object({
                code: z.string(),
                title: z.string(),
                /** Имя из макета APIStend, если оно отличается от боевого кода события. */
                aliasInMockup: z.string().nullable(),
                sampleContentType: z.string(),
                sampleBody: z.string(),
              }),
            ),
          }),
        ),
      }),
    },
    async () => {
      const now = new Date()
      return {
        services: SERVICE_CODES.map((code) => {
          const profile = SERVICE_PROFILES[code].webhook
          return {
            code,
            title: SERVICE_PROFILES[code].title,
            webhook: {
              contentType: profile.contentType,
              timeoutMs: profile.timeoutMs,
              retries: profile.retryDelaysMs.length,
              retryDelaysMs: [...profile.retryDelaysMs],
              successRule: profile.successRule,
              expectedResponseBody: profile.expectedResponseBody,
              signature: profile.signature,
              signatureHeader: profile.signatureHeader,
              maxBatchSize: profile.maxBatchSize,
              suspendsAfterFailures: profile.suspendsAfterFailures,
              notes: profile.notes,
            },
            events: EVENTS_BY_SERVICE[code].map((event) => {
              const sample = buildEventPayload(event, {
                index: 1,
                now,
                portalDomain: portalDomain(),
                applicationToken: 'demo_application_token',
                sellerId: 12345,
                requestId: 'demo-request-id',
                isTest: false,
                appAuth: null,
              })
              return {
                code: event.code,
                title: event.title,
                aliasInMockup: event.aliasInMockup ?? null,
                sampleContentType: sample.contentType,
                sampleBody: sample.body,
              }
            }),
          }
        }),
      }
    },
  )

  // ─────────── Локальные приложения Bitrix24 ───────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/apps',
      scope: 'apps:read',
      summary: 'Приложения Bitrix24 песочницы',
      description:
        'Свежие сверху. client_secret в списке не отдаётся — он есть в карточке GET /apps/{id} ' +
        'и в ответе на создание.',
      tags: ['Приложения B24'],
      needsSandbox: true,
      query: pageQuery.extend({
        state: appStateSchema.optional(),
        kind: appKindSchema.optional(),
      }),
      response: pageResponse(appItemSchema),
    },
    async (ctx, input, _req, reply) => {
      const rows = await prisma.b24App.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          ...(input.query.state ? { state: input.query.state } : {}),
          ...(input.query.kind ? { kind: input.query.kind } : {}),
        },
        // Второй ключ сортировки нужен курсору: при совпавшем времени порядок
        // иначе не определён, и страница теряет или повторяет запись.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: appListInclude,
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query, toAppItem)
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/apps',
      scope: 'apps:write',
      summary: 'Создать приложение',
      description:
        'client_id и client_secret выдаются один раз и потом не меняются — как в боевом портале, ' +
        'где перевыпуска нет. Приложение создаётся в состоянии awaiting_install: пока его не открыли ' +
        'во фрейме (или, для api_only, пока не доставлен ONAPPINSTALL), app.info отвечает INSTALLED: false. ' +
        'Код (code) при отсутствии собирается из названия и потом не меняется.',
      tags: ['Приложения B24'],
      needsSandbox: true,
      status: 201,
      body: appCreateSchema,
      failures: ['CONFLICT'],
      response: appDetailSchema,
    },
    async (ctx, input, _req, reply) => {
      const invalid = unknownScopes(input.body.scope)
      if (invalid.length > 0) {
        return badRequest(reply, 'Неизвестные права приложения', [`scope: ${invalid.join(', ')}`])
      }

      const handlerUrl = input.body.handlerUrl ?? null
      const installUrl = input.body.installUrl ?? null
      const missing = missingUrlIssue(input.body.kind, handlerUrl, installUrl)
      if (missing) return badRequest(reply, 'Некорректные данные запроса', [`body: ${missing}`])

      const blocked = await appTargetIssue(handlerUrl, installUrl)
      if (blocked) return badRequest(reply, 'Адрес приложения недоступен для доставки', [`body: ${blocked}`])

      const code = (input.body.code ?? slugify(input.body.title)).toLowerCase()
      const clash = await prisma.b24App.findFirst({ where: { sandboxId: ctx.sandbox.id, code } })
      if (clash) return conflict(reply, `Приложение с кодом «${code}» в этой песочнице уже есть`)

      const created = await prisma.b24App.create({
        data: {
          sandboxId: ctx.sandbox.id,
          title: input.body.title,
          code,
          kind: input.body.kind,
          scope: input.body.scope,
          handlerUrl,
          installUrl,
          menuTitle: input.body.menuTitle ?? null,
          tokenTtlSeconds: input.body.tokenTtlSeconds ?? undefined,
          refreshTtlSeconds: input.body.refreshTtlSeconds ?? undefined,
          clientId: generateClientId(),
          clientSecret: generateClientSecret(),
          applicationToken: generateHexToken(),
        },
        include: appDetailInclude,
      })

      return toAppDetail(created, ctx.sandbox.id)
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/apps/:id',
      scope: 'apps:read',
      summary: 'Карточка приложения',
      description:
        'В отличие от списка отдаёт client_secret, зарегистрированные виджеты (placement.bind) ' +
        'и адреса демо-портала, по которым приложение проходит OAuth и вызывает REST.',
      tags: ['Приложения B24'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: appDetailSchema,
    },
    async (ctx, input, _req, reply) => {
      const found = await prisma.b24App.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
        include: appDetailInclude,
      })
      if (!found) return notFound(reply, 'Приложение не найдено')
      return toAppDetail(found, ctx.sandbox.id)
    },
  )

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/apps/:id',
      scope: 'apps:write',
      summary: 'Изменить приложение',
      description:
        'Меняются только переданные поля. Любая правка поднимает version: боевой портал делает так же, ' +
        'и приложение по изменившемуся номеру понимает, что настройки пора перечитать. ' +
        'Код приложения (code), client_id и client_secret не меняются никогда. ' +
        'Установку правка не сбрасывает — приложение остаётся в том же состоянии.',
      tags: ['Приложения B24'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: appPatchSchema,
      response: appDetailSchema,
    },
    async (ctx, input, _req, reply) => {
      const existing = await prisma.b24App.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!existing) return notFound(reply, 'Приложение не найдено')

      const invalid = unknownScopes(input.body.scope)
      if (invalid.length > 0) {
        return badRequest(reply, 'Неизвестные права приложения', [`scope: ${invalid.join(', ')}`])
      }

      // Проверять надо итог правки, а не присланные поля: смена вида на server_ui
      // без обработчика оставила бы приложение, которое нечем открыть.
      const kind = input.body.kind ?? existing.kind
      const handlerUrl = input.body.handlerUrl === undefined ? existing.handlerUrl : input.body.handlerUrl ?? null
      const installUrl = input.body.installUrl === undefined ? existing.installUrl : input.body.installUrl ?? null
      const missing = missingUrlIssue(kind, handlerUrl, installUrl)
      if (missing) return badRequest(reply, 'Некорректные данные запроса', [`body: ${missing}`])

      const blocked = await appTargetIssue(
        input.body.handlerUrl === undefined ? null : handlerUrl,
        input.body.installUrl === undefined ? null : installUrl,
      )
      if (blocked) return badRequest(reply, 'Адрес приложения недоступен для доставки', [`body: ${blocked}`])

      const updated = await prisma.b24App.update({
        where: { id: existing.id },
        data: {
          title: input.body.title ?? undefined,
          kind: input.body.kind ?? undefined,
          scope: input.body.scope ?? undefined,
          handlerUrl: input.body.handlerUrl === undefined ? undefined : handlerUrl,
          installUrl: input.body.installUrl === undefined ? undefined : installUrl,
          menuTitle: input.body.menuTitle === undefined ? undefined : input.body.menuTitle ?? null,
          tokenTtlSeconds: input.body.tokenTtlSeconds,
          refreshTtlSeconds: input.body.refreshTtlSeconds,
          version: { increment: 1 },
        },
        include: appDetailInclude,
      })

      return toAppDetail(updated, ctx.sandbox.id)
    },
  )

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/apps/:id',
      scope: 'apps:write',
      summary: 'Удалить приложение',
      description:
        'Необратимо: запись удаляется целиком вместе с client_id, client_secret, токенами и виджетами. ' +
        'Состояние uninstalled из модели здесь не используется — надгробие держало бы занятым код ' +
        'приложения (он уникален внутри песочницы), и создать заново приложение с тем же кодом ' +
        'стало бы нельзя; в боевом портале удаление тоже не оставляет ничего, а повторное добавление ' +
        'выдаёт НОВУЮ пару client_id/client_secret. Перед удалением на адрес приложения уходит ' +
        'ONAPPUNINSTALL — как в бою, без токенов в auth[]. Записи журнала доставок остаются: ' +
        'подтверждение того, что событие ушло, нужно как раз после удаления. ' +
        'Подтверждение обязательно: confirmName — код приложения (поле code). Он не совпадёт, если ' +
        'в адрес попал идентификатор соседней записи, а «удалить не то приложение» здесь необратимо.',
      tags: ['Приложения B24'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        // Имя и место те же, что у остальных необратимых действий Management API
        // (удаление ключа и песочницы): поле confirmName в теле запроса. У приложения
        // роль названия играет код — он уникален внутри песочницы и виден в списке.
        // Сообщение задано и на отсутствие поля: по умолчанию клиент получил бы
        // «expected string, received undefined» — про подтверждение там ни слова.
        confirmName: z.string({ error: 'Подтвердите удаление: confirmName — код приложения' }).min(1),
      }),
      response: z.object({
        ok: z.literal(true),
        app: z.object({ id: z.string(), code: z.string(), title: z.string() }),
        /** Сколько действующих пар токенов отозвано. */
        tokensRevoked: z.number().int(),
        /** Сколько подписок приложения на события снято. */
        subscriptionsRemoved: z.number().int(),
        placementsRemoved: z.number().int(),
        /** null — адреса у приложения не было, слать ONAPPUNINSTALL некуда. */
        uninstallDelivery: z.object({
          deliveryId: z.string(),
          state: z.enum(['queued', 'dispatched']),
          /** Как и у вебхука: способ доставки, а не адрес. Адрес — в targetUrl. */
          target: z.enum(['local', 'public']),
          targetUrl: z.string(),
        }).nullable(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const existing = await prisma.b24App.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!existing) return notFound(reply, 'Приложение не найдено')

      if (input.body.confirmName !== existing.code) {
        // Код CONFIRM_MISMATCH, а не VALIDATION: тем же кодом отвечают удаление
        // ключа и песочницы, и клиенту не приходится различать их по тексту.
        return sendError(
          reply,
          400,
          'CONFIRM_MISMATCH',
          `Удаление не подтверждено: у приложения «${existing.title}» код «${existing.code}». ` +
            `Повторите запрос с confirmName: «${existing.code}»`,
        )
      }

      // Считаем до удаления: после каскада считать будет нечего, а сводка нужна
      // именно про необратимое действие.
      const [tokensRevoked, subscriptionsRemoved, placementsRemoved] = await Promise.all([
        prisma.b24AppToken.count({ where: { appId: existing.id, revokedAt: null } }),
        prisma.webhook.count({ where: { appId: existing.id, event: { notIn: LIFECYCLE_EVENTS } } }),
        prisma.b24AppPlacement.count({ where: { appId: existing.id } }),
      ])

      const uninstallDelivery = await notifyUninstall(existing)
      await revokeAppTokens(existing.id)
      // Подписки снимаются вместе с приложением — так делает и боевой портал.
      await prisma.webhook.deleteMany({
        where: { appId: existing.id, event: { notIn: LIFECYCLE_EVENTS } },
      })
      /*
       * Служебная подписка жизненного цикла остаётся, но выключается.
       *
       * Удалить её нельзя: журнал доставок связан с вебхуком каскадом, и вместе
       * с записью исчезло бы то самое уведомление об удалении, которое мы только что
       * отправили и вернули в ответе. Оставить активной — тоже нельзя: связь с
       * приложением обнуляется (onDelete: SetNull), и в песочнице оставалась
       * работающая подписка на адрес удалённого приложения, по которой можно
       * запустить серию событий. Выключенную серия не принимает (burst.ts).
       */
      await prisma.webhook.updateMany({
        where: { appId: existing.id, event: { in: LIFECYCLE_EVENTS } },
        data: { status: 'disabled' },
      })
      await prisma.b24App.delete({ where: { id: existing.id } })

      return {
        ok: true as const,
        app: { id: existing.id, code: existing.code, title: existing.title },
        tokensRevoked,
        subscriptionsRemoved,
        placementsRemoved,
        uninstallDelivery,
      }
    },
  )

  // ─────────── Туннель ───────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/tunnel/status',
      scope: 'tunnel:read',
      summary: 'Состояние туннеля песочницы',
      description:
        'Слушает ли кто-то события локально: agent заполнен, пока держится соединение команды ' +
        '`apistend listen`, и обнуляется сразу после обрыва. lastSession — последняя выданная сессия ' +
        'подключения, она остаётся в базе и после отключения: по ней видно, кто и когда подключался ' +
        'в последний раз. queuedDeliveries — доставки на локальный адрес, которые ждут агента: ' +
        'пока его нет, события не теряются, а копятся.',
      tags: ['Туннель'],
      needsSandbox: true,
      response: z.object({
        sandboxId: z.string(),
        connected: z.boolean(),
        agent: z.object({
          sessionId: z.string(),
          agentVersion: z.string(),
          deviceId: z.string(),
          /** Куда агент пересылает события на машине разработчика. */
          forwardUrl: z.string(),
          connectedAt: z.date(),
          lastSeenAt: z.date(),
          latencyMs: z.number().int().nullable(),
          eventsLastHour: z.number().int(),
          failedDeliveries: z.number().int(),
          /** Отдано агенту и ждёт ответа. */
          inflight: z.number().int(),
        }).nullable(),
        lastSession: z.object({
          sessionId: z.string(),
          deviceName: z.string().nullable(),
          agentVersion: z.string(),
          forwardUrl: z.string(),
          connectedAt: z.date().nullable(),
          lastSeenAt: z.date().nullable(),
          createdAt: z.date(),
        }).nullable(),
        queuedDeliveries: z.number().int(),
      }),
    },
    async (ctx) => {
      const live = getSession(ctx.sandbox.id)
      const [lastSession, queuedDeliveries] = await Promise.all([
        prisma.tunnelSession.findFirst({
          where: { sandboxId: ctx.sandbox.id },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.webhookDelivery.count({
          where: { sandboxId: ctx.sandbox.id, state: 'queued', webhook: { target: 'local' } },
        }),
      ])

      return {
        sandboxId: ctx.sandbox.id,
        connected: Boolean(live),
        agent: live
          ? {
              sessionId: live.displayId,
              agentVersion: live.agentVersion,
              deviceId: live.deviceId,
              forwardUrl: live.forwardUrl,
              connectedAt: live.connectedAt,
              lastSeenAt: live.lastSeenAt,
              latencyMs: live.latencyMs,
              eventsLastHour: live.eventsLastHour,
              failedDeliveries: live.failedDeliveries,
              inflight: live.inflight.size,
            }
          : null,
        lastSession: lastSession
          ? {
              sessionId: lastSession.displayId,
              deviceName: lastSession.deviceName,
              agentVersion: lastSession.agentVersion,
              forwardUrl: lastSession.forwardUrl,
              connectedAt: lastSession.connectedAt,
              lastSeenAt: lastSession.lastSeenAt,
              createdAt: lastSession.createdAt,
            }
          : null,
        queuedDeliveries,
      }
    },
  )
}
