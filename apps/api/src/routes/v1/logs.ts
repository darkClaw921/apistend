import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { SCENARIOS, SERVICE_CODES, SERVICE_PROFILES, isServiceCode } from '@apistend/shared'
import { prisma } from '../../db.ts'
import { engine } from '../../gateway.ts'
import { requestId as newRequestId } from '../../lib/ids.ts'
import { maskOf, maskSecretsInText } from '../../lib/keys.ts'
import { maskHeaders, maskJson, maskText, type JsonLike } from '../../lib/mask-log.ts'
import { bufferStats, enqueueRequestLog, flushRequestLogs } from '../../lib/log-buffer.ts'
import { checkRateLimit } from '../../lib/rate-limit.ts'
import { retentionStats } from '../../lib/retention.ts'
import { checkHeavyRate, sendError } from '../../lib/mgmt.ts'
import {
  badRequest,
  defineRoute,
  notFound,
  page,
  pageChecked,
  pageArgs,
  pageQuery,
  pageResponse,
} from './_registry.ts'

/**
 * Журнал запросов, сводка использования, уведомления и консоль.
 *
 * Экраны кабинета (routes/logs.ts, overview.ts, console.ts) отдают то же самое,
 * но собранным под вёрстку: почасовые столбики графика, подписи ключей, готовый
 * cURL. Здесь отдаётся ресурс, из которого клиент нарисует что угодно сам.
 * Расчёты при этом те же: одна доля ошибок, одно восстановление тела ответа,
 * один выбор ключа в консоли — иначе цифры в кабинете и в API разошлись бы.
 */

const RETENTION_DAYS = retentionStats().retentionDays

// ─────────────────────────── Секреты в выдаче ───────────────────────────

/**
 * Шлюз прячет заголовок авторизации ещё при записи (sanitizeHeaders в gateway.ts),
 * но не всё попадает в журнал через шлюз: консоль кабинета кладёт заголовки и тело
 * как есть, а у Bitrix24 ключ ходит ещё и параметром auth внутри тела. Читающих
 * маршрутов меньше, чем пишущих, поэтому чистим здесь — так гарантия не зависит
 * от того, кто и когда добавит очередной источник записей.
 */

// ─────────────────────────── Журнал запросов ───────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

/** «404» — точный код, «5xx» — весь класс. Один параметр вместо пары status и statusClass. */
const statusParam = z
  .string()
  .regex(/^[1-5](?:\d{2}|xx)$/i, 'Ожидается код ответа «404» или класс «5xx»')

const logFilters = z.object({
  service: z.enum(SERVICE_CODES).optional(),
  method: z.enum(HTTP_METHODS).optional(),
  status: statusParam.optional(),
  apiKeyId: z.string().min(1).optional(),
  /** Подстрока пути, без учёта регистра. */
  endpoint: z.string().min(1).max(500).optional(),
  // offset: true — иначе «2026-09-08T00:00:00+03:00» не примется, и клиенту
  // пришлось бы пересчитывать своё время в UTC руками.
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
})

type LogFilters = z.output<typeof logFilters>

function logWhere(sandboxId: string, filters: LogFilters): Prisma.RequestLogWhereInput {
  const where: Prisma.RequestLogWhereInput = { sandboxId }
  if (filters.service) where.serviceCode = filters.service
  if (filters.method) where.httpMethod = filters.method
  if (filters.apiKeyId) where.apiKeyId = filters.apiKeyId
  if (filters.endpoint) where.endpoint = { contains: filters.endpoint, mode: 'insensitive' }
  if (filters.status) {
    const base = Number(filters.status[0]) * 100
    where.statusCode = /^\d{3}$/.test(filters.status)
      ? Number(filters.status)
      : { gte: base, lt: base + 100 }
  }
  if (filters.from || filters.to) {
    where.timestamp = {
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to ? { lte: new Date(filters.to) } : {}),
    }
  }
  return where
}

/** Пустой период — это опечатка в запросе, а не «ничего не нашлось»: отвечаем ошибкой. */
function periodIssue(filters: LogFilters): string | null {
  return filters.from && filters.to && new Date(filters.from) > new Date(filters.to)
    ? 'query.from: начало периода позже его конца'
    : null
}

/**
 * id обязан быть последним ключом сортировки: курсор постраничности — это он,
 * а у записей одной миллисекунды порядок иначе не определён, и соседние страницы
 * то повторяли бы строку, то теряли её.
 */
const LOG_ORDER: Prisma.RequestLogOrderByWithRelationInput[] = [{ timestamp: 'desc' }, { id: 'desc' }]

const LOG_SELECT = {
  id: true,
  publicId: true,
  timestamp: true,
  serviceCode: true,
  httpMethod: true,
  endpoint: true,
  statusCode: true,
  durationMs: true,
  sizeBytes: true,
  scenario: true,
  responseSource: true,
  apiKeyId: true,
  apiKey: { select: { name: true } },
} satisfies Prisma.RequestLogSelect

type LogRow = Prisma.RequestLogGetPayload<{ select: typeof LOG_SELECT }>

const logItem = z.object({
  id: z.string(),
  /** req_8f3c21a0d7 — то, что видно в заголовке X-Request-Id ответа мока. */
  publicId: z.string(),
  timestamp: z.date(),
  serviceCode: z.string(),
  httpMethod: z.string(),
  endpoint: z.string(),
  statusCode: z.number(),
  durationMs: z.number(),
  sizeBytes: z.number(),
  scenario: z.string(),
  /** example | schema | generic | error | app-context — откуда взят ответ. */
  responseSource: z.string(),
  apiKeyId: z.string().nullable(),
  apiKeyName: z.string().nullable(),
})

function toLogItem(row: LogRow): z.input<typeof logItem> {
  return {
    id: row.id,
    publicId: row.publicId,
    timestamp: row.timestamp,
    serviceCode: row.serviceCode,
    httpMethod: row.httpMethod,
    endpoint: maskSecretsInText(row.endpoint),
    statusCode: row.statusCode,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
    scenario: row.scenario,
    responseSource: row.responseSource,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKey?.name ?? null,
  }
}

const logDetail = logItem.extend({
  sandboxId: z.string(),
  /** Боевой адрес, который был бы вызван без APIStend. */
  upstreamUrl: z.string().nullable(),
  clientIp: z.string().nullable(),
  requestHeaders: z.json(),
  requestBody: z.string().nullable(),
  responseHeaders: z.json(),
  responseBody: z.string().nullable(),
  /** true — тело собрано движком заново, а не прочитано из журнала. */
  responseBodyReproduced: z.boolean(),
})

/** Экранирование по RFC 4180. Разделитель «;» — его понимает Excel с русской локалью. */
function csvCell(value: string | number): string {
  const text = String(value)
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const CSV_HEADER = [
  'Время',
  'Сервис',
  'Метод',
  'Эндпоинт',
  'Код',
  'Задержка, мс',
  'Размер, байт',
  'Сценарий',
  'Ключ',
  'ID запроса',
]

/**
 * Выборка для выгрузки — страницами по id.
 *
 * Одним findMany на сто тысяч строк Prisma собрала бы весь ответ в памяти процесса
 * до того, как отдаст его нам; страницами пиковая память держится в пределах пачки.
 */
async function collectForExport(where: Prisma.RequestLogWhereInput, limit: number): Promise<LogRow[]> {
  const PAGE = 1_000
  const rows: LogRow[] = []
  let cursor: string | undefined

  while (rows.length < limit) {
    const batch = await prisma.requestLog.findMany({
      where,
      orderBy: { id: 'asc' },
      take: Math.min(PAGE, limit - rows.length),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: LOG_SELECT,
    })
    if (batch.length === 0) break
    rows.push(...batch)
    cursor = batch[batch.length - 1]!.id
    if (batch.length < PAGE) break
  }

  return rows
}

/**
 * Удаление пачками, как в lib/retention.ts: одна большая DELETE по журналу держит
 * блокировки и мешает записывать новые вызовы — шлюз в это время тормозит.
 */
async function purgeLogs(where: Prisma.RequestLogWhereInput): Promise<number> {
  const BATCH = 5_000
  let deleted = 0

  for (;;) {
    const batch = await prisma.requestLog.findMany({ where, select: { id: true }, take: BATCH })
    if (batch.length === 0) break
    const { count } = await prisma.requestLog.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } })
    deleted += count
    if (batch.length < BATCH) break
  }

  return deleted
}

// ─────────────────────────── Сводка использования ───────────────────────────

const usageWindow = z.object({
  requests: z.number(),
  errors: z.number(),
  errorRatePercent: z.number(),
  avgLatencyMs: z.number(),
})

function windowOf(requests: number, errors: number, avgMs: number | null): z.input<typeof usageWindow> {
  return {
    requests,
    errors,
    // Два знака после запятой: доля ошибок в 0,04 % и 0 % — разные новости.
    errorRatePercent: requests > 0 ? Math.round((errors / requests) * 10_000) / 100 : 0,
    avgLatencyMs: Math.round(avgMs ?? 0),
  }
}

// ─────────────────────────── Консоль ───────────────────────────

const consoleBody = z.object({
  serviceCode: z.enum(SERVICE_CODES),
  httpMethod: z.enum(HTTP_METHODS),
  path: z.string().min(1).max(2_000).startsWith('/', 'Путь должен начинаться со слэша'),
  query: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  scenario: z.enum(SCENARIOS).default('success'),
  /** Ключ песочницы, от имени которого выполнить вызов. По умолчанию подбирается по сервису. */
  apiKeyId: z.string().min(1).optional(),
  delayMs: z.number().int().min(0).max(3_000).optional(),
})

export function registerV1LogsRoutes(app: FastifyInstance): void {
  // ── Журнал ──

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/logs',
      scope: 'logs:read',
      summary: 'Журнал запросов',
      description:
        'Вызовы мок-шлюза и консоли, свежие сверху. Фильтры складываются по «и».\n\n' +
        'Период задаётся полями `from` и `to` в ISO 8601. Без них отдаётся всё, что есть в журнале, ' +
        `а есть последние ${RETENTION_DAYS} дней: старше записи удаляет ретеншен.\n\n` +
        'Тела запросов и ответов в списке не отдаются — за ними идти в `GET /logs/{id}`. ' +
        'Если под нагрузкой журнал прореживался, доля выборки видна в `GET /usage`: ' +
        'список молчит об этом, потому что прореженной записи в нём просто нет.',
      tags: ['Журнал запросов'],
      needsSandbox: true,
      query: pageQuery.extend(logFilters.shape),
      response: pageResponse(logItem),
    },
    async (ctx, input, _req, reply) => {
      const issue = periodIssue(input.query)
      if (issue) return badRequest(reply, 'Некорректный период', [issue])

      // Буфер сбрасываем перед чтением: только что сделанный вызов обязан быть
      // в ответе, иначе клиент решит, что запрос не дошёл. Так же поступает кабинет.
      await flushRequestLogs()

      const rows = await prisma.requestLog.findMany({
        where: logWhere(ctx.sandbox.id, input.query),
        orderBy: LOG_ORDER,
        select: LOG_SELECT,
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query, toLogItem)
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/logs/export',
      scope: 'logs:read',
      summary: 'Выгрузка журнала',
      description:
        'Те же фильтры, что у `GET /logs`, но без постраничности и без тел: одна выгрузка за раз.\n\n' +
        '`format=json` (по умолчанию) отдаёт `{ rows: [...] }` тем же составом полей, что и список. ' +
        '`format=csv` отдаёт `text/csv` вложением: разделитель «;» и BOM в начале — иначе Excel ' +
        'с русской локалью раскладывает строку в одну колонку и портит кириллицу.\n\n' +
        'Больше `limit` записей не отдаётся; в этом случае в JSON приходит `truncated: true`, ' +
        'а в CSV — заголовок `X-Truncated: true`, потому что в самом файле сказать об этом негде. ' +
        'Забрать остальное можно, сузив период полями `from` и `to`.\n\n' +
        'У маршрута отдельное ограничение частоты — несколько выгрузок в минуту: каждая читает ' +
        'десятки тысяч записей, и общая норма Management API для неё слишком мягкая.',
      tags: ['Журнал запросов'],
      needsSandbox: true,
      responseMedia: ['text/csv'],
      query: logFilters.extend({
        format: z.enum(['json', 'csv']).default('json'),
        limit: z.coerce.number().int().min(1).max(100_000).default(10_000),
      }),
      response: z.union([
        z.object({
          format: z.literal('json'),
          generatedAt: z.date(),
          count: z.number(),
          /** true — упёрлись в limit, часть записей осталась в журнале. */
          truncated: z.boolean(),
          rows: z.array(logItem),
        }),
        /** format=csv: тело уходит как text/csv, а не как JSON. */
        z.string(),
      ]),
    },
    async (ctx, input, _req, reply) => {
      const issue = periodIssue(input.query)
      if (issue) return badRequest(reply, 'Некорректный период', [issue])

      /*
       * Выгрузка считается по отдельному, куда более строгому счётчику.
       *
       * Одна выгрузка читает до ста тысяч записей и собирает их в памяти процесса,
       * который обслуживает ещё и мок-шлюз. На общей минутной норме десяток
       * параллельных выгрузок кладёт сервис, формально не нарушив ни одного лимита.
       */
      const rate = checkHeavyRate(`export:${ctx.apiKeyId ?? ctx.userId}`)
      if (!rate.allowed) {
        reply.header('retry-after', String(rate.resetInSeconds))
        return sendError(
          reply,
          429,
          'RATE_LIMITED',
          `Выгрузок журнала не больше ${rate.limit} в минуту. Повторите через ${rate.resetInSeconds} с ` +
            'или сузьте период полями from и to',
        )
      }

      await flushRequestLogs()

      // На одну запись больше лимита: её наличие и есть ответ на вопрос,
      // осталось ли что-то в журнале, — иначе выгрузка ровно в limit строк
      // всегда выглядела бы усечённой.
      const found = await collectForExport(logWhere(ctx.sandbox.id, input.query), input.query.limit + 1)
      const truncated = found.length > input.query.limit
      const rows = found.slice(0, input.query.limit)

      if (input.query.format === 'json') {
        return {
          format: 'json' as const,
          generatedAt: new Date(),
          count: rows.length,
          truncated,
          rows: rows.map(toLogItem),
        }
      }

      const stamp = new Date().toISOString().slice(0, 10)
      const lines = ['﻿' + CSV_HEADER.join(';')]
      for (const row of rows) {
        const item = toLogItem(row)
        lines.push(
          [
            item.timestamp.toISOString(),
            item.serviceCode,
            item.httpMethod,
            csvCell(item.endpoint),
            item.statusCode,
            item.durationMs,
            item.sizeBytes,
            item.scenario,
            csvCell(item.apiKeyName ?? ''),
            item.publicId,
          ].join(';'),
        )
      }

      const csv = lines.join('\n') + '\n'
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="apistend-logs-${stamp}.csv"`)
        // В CSV нет места для поля truncated, а знать об усечении надо: без заголовка
        // выгрузка ровно в limit строк выглядит полной.
        .header('x-truncated', String(truncated))
        .send(csv)
      return csv
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/logs/:id',
      scope: 'logs:read',
      summary: 'Карточка запроса',
      description:
        'Полная запись журнала: заголовки и тело запроса, заголовки и тело ответа. ' +
        'Идентификатором служит и внутренний `id` из списка, и публичный `publicId` (`req_…`) ' +
        'из заголовка `X-Request-Id` — искать по тому, что оказалось под рукой.\n\n' +
        'Тело успешного ответа в журнале не хранится: оно детерминировано и восстанавливается ' +
        'тем же движком, что его сформировал, — байт в байт. Такой ответ помечен ' +
        '`responseBodyReproduced: true`. Если метод к этому времени выбыл из каталога, ' +
        'восстановить нечего и `responseBody` останется `null`.\n\n' +
        'Ключи в заголовках и телах маскируются: `stend_sk_1a2b••••7f9c`.',
      tags: ['Журнал запросов'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: logDetail,
    },
    async (ctx, input, _req, reply) => {
      await flushRequestLogs()

      const row = await prisma.requestLog.findFirst({
        where: {
          sandboxId: ctx.sandbox.id,
          OR: [{ id: input.params.id }, { publicId: input.params.id }],
        },
        include: { apiKey: { select: { name: true } } },
      })
      if (!row) return notFound(reply, `Запрос «${input.params.id}» не найден в журнале песочницы`)

      let responseBody = row.responseBody
      let responseHeaders: unknown = row.responseHeaders
      let reproduced = false

      if (responseBody === null && isServiceCode(row.serviceCode)) {
        // Сценарий берём успешный, а не сохранённый: тела сбойных сценариев журнал
        // хранит сам (в них есть requestId и метка времени, они невоспроизводимы),
        // значит сюда попадают только успешные вызовы.
        const result = engine.handle({
          service: row.serviceCode,
          httpMethod: row.httpMethod,
          path: row.endpoint,
          query: {},
          headers: {},
          body: null,
          requestId: newRequestId(),
          scenario: 'success',
          now: row.timestamp,
          salt: ctx.sandbox.dataVolume,
        })
        if (result.method) {
          responseBody = result.serialized
          responseHeaders = result.headers
          reproduced = true
        }
      }

      return {
        ...toLogItem({ ...row, apiKey: row.apiKey }),
        sandboxId: row.sandboxId,
        upstreamUrl: row.upstreamUrl,
        clientIp: row.clientIp,
        requestHeaders: maskHeaders(row.requestHeaders),
        requestBody: maskText(row.requestBody),
        responseHeaders: maskHeaders(responseHeaders),
        responseBody: maskText(responseBody),
        responseBodyReproduced: reproduced,
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/logs/clear',
      scope: 'logs:write',
      summary: 'Очистить журнал песочницы',
      description:
        'Удаляет записи журнала безвозвратно — восстановить их нечем, тела успешных ответов ' +
        'в журнале и не лежали. Поэтому требуется явное `confirm: true`.\n\n' +
        'Без `before` удаляются все записи песочницы; с `before` — только сделанные раньше ' +
        'указанного момента, это способ подчистить историю, не теряя свежую отладку. ' +
        'Сужение по сервису работает так же, как фильтр списка.\n\n' +
        'Записи удаляются пачками, поэтому на большом журнале ответ приходит не мгновенно; ' +
        'в ответе — сколько строк удалено на самом деле.',
      tags: ['Журнал запросов'],
      needsSandbox: true,
      body: z.object({
        confirm: z.literal(true, 'Очистка журнала необратима: передайте confirm: true'),
        before: z.iso.datetime({ offset: true }).optional(),
        service: z.enum(SERVICE_CODES).optional(),
      }),
      response: z.object({
        deleted: z.number(),
        sandboxId: z.string(),
        before: z.date().nullable(),
        service: z.string().nullable(),
      }),
    },
    async (ctx, input) => {
      const before = input.body.before ? new Date(input.body.before) : null
      const where: Prisma.RequestLogWhereInput = { sandboxId: ctx.sandbox.id }
      if (before) where.timestamp = { lt: before }
      if (input.body.service) where.serviceCode = input.body.service

      // Сначала на диск, потом удалять: иначе буфер допишет в журнал вызовы,
      // сделанные до очистки, и он окажется «непустым сразу после очистки».
      await flushRequestLogs()

      return {
        deleted: await purgeLogs(where),
        sandboxId: ctx.sandbox.id,
        before,
        service: input.body.service ?? null,
      }
    },
  )

  // ── Сводка ──

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/usage',
      // Сводка целиком собрана из журнала запросов и имён песочниц, ничего из профиля
      // в ней нет. Область logs:read — естественный выбор для ключа «читать свою статистику»;
      // требовать ради неё доступ к аккаунту значило бы просить больше, чем нужно.
      scope: 'logs:read',
      summary: 'Сводка использования',
      description:
        'Счётчики по всем песочницам аккаунта сразу; `sandboxId` сужает их до одной.\n\n' +
        '«Сегодня» — с начала суток по часовому поясу сервера, ровно как счётчик в кабинете. ' +
        '«30 дней» — скользящее окно, а не календарный месяц; оно же совпадает со сроком ' +
        `хранения журнала (${RETENTION_DAYS} дней), поэтому цифры за окно не «стареют» скачком.\n\n` +
        'Разбивка по сервисам и по песочницам считается за те же 30 дней. Песочница без вызовов ' +
        'остаётся в списке с нулём — иначе её отсутствие читалось бы как ошибка доступа.\n\n' +
        'Блок `logSampling` — про честность цифр: выше порога нагрузки журнал пишет не все ' +
        'успешные вызовы, а долю (`sampleRate`), и тогда `requests` меньше реального числа ' +
        'запросов. Ошибки не прореживаются никогда. Счётчики берутся из процесса, который ' +
        'обслуживает этот запрос, считаются с его запуска и относятся ко всем аккаунтам сразу — ' +
        'это показатель нагрузки на APIStend, а не ваш личный расход.',
      tags: ['Журнал запросов'],
      query: z.object({ sandboxId: z.string().min(1).optional() }),
      failures: ['NOT_FOUND'],
      response: z.object({
        generatedAt: z.date(),
        sandboxIds: z.array(z.string()),
        today: usageWindow,
        last30d: usageWindow,
        byService: z.array(
          z.object({
            serviceCode: z.string(),
            title: z.string(),
            requests: z.number(),
            errors: z.number(),
            avgLatencyMs: z.number(),
          }),
        ),
        bySandbox: z.array(
          z.object({
            sandboxId: z.string(),
            name: z.string(),
            project: z.string(),
            requests: z.number(),
          }),
        ),
        logSampling: z.object({
          sampleRate: z.number(),
          sampledOut: z.number(),
          dropped: z.number(),
          /** false — часть вызовов в журнал не попала, счётчики выше занижены. */
          complete: z.boolean(),
        }),
        retentionDays: z.number(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const sandboxes = await prisma.sandbox.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, project: true },
      })

      const wanted = input.query.sandboxId
      const scoped = wanted ? sandboxes.filter((s) => s.id === wanted) : sandboxes
      // Чужая песочница — тот же 404 и тот же код, что у остальных маршрутов:
      // по разнице ответов чужие идентификаторы перебираются на существование.
      if (wanted && scoped.length === 0) {
        return sendError(reply, 404, 'SANDBOX_NOT_FOUND', `Песочница «${wanted}» не найдена`)
      }

      await flushRequestLogs()

      const now = new Date()
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const monthStart = new Date(now.getTime() - 30 * 86_400_000)
      const inScope = { sandboxId: { in: scoped.map((s) => s.id) } }
      const today = { ...inScope, timestamp: { gte: dayStart } }
      const month = { ...inScope, timestamp: { gte: monthStart } }

      // Восемь агрегатов одним заходом: последовательно они складывались бы
      // в задержку, заметную на глаз, а зависимостей между ними нет.
      const [todayAgg, todayErrors, monthAgg, monthErrors, byService, byServiceErrors, bySandbox] =
        await Promise.all([
          prisma.requestLog.aggregate({ where: today, _count: { _all: true }, _avg: { durationMs: true } }),
          prisma.requestLog.count({ where: { ...today, statusCode: { gte: 400 } } }),
          prisma.requestLog.aggregate({ where: month, _count: { _all: true }, _avg: { durationMs: true } }),
          prisma.requestLog.count({ where: { ...month, statusCode: { gte: 400 } } }),
          prisma.requestLog.groupBy({
            by: ['serviceCode'],
            where: month,
            _count: { _all: true },
            _avg: { durationMs: true },
          }),
          prisma.requestLog.groupBy({
            by: ['serviceCode'],
            where: { ...month, statusCode: { gte: 400 } },
            _count: { _all: true },
          }),
          prisma.requestLog.groupBy({ by: ['sandboxId'], where: month, _count: { _all: true } }),
        ])

      const errorsByService = new Map(byServiceErrors.map((r) => [r.serviceCode, r._count._all]))
      const requestsBySandbox = new Map(bySandbox.map((r) => [r.sandboxId, r._count._all]))
      const stats = bufferStats()

      return {
        generatedAt: now,
        sandboxIds: scoped.map((s) => s.id),
        today: windowOf(todayAgg._count._all, todayErrors, todayAgg._avg.durationMs),
        last30d: windowOf(monthAgg._count._all, monthErrors, monthAgg._avg.durationMs),
        byService: byService
          .map((row) => ({
            serviceCode: row.serviceCode,
            title: isServiceCode(row.serviceCode) ? SERVICE_PROFILES[row.serviceCode].title : row.serviceCode,
            requests: row._count._all,
            errors: errorsByService.get(row.serviceCode) ?? 0,
            avgLatencyMs: Math.round(row._avg.durationMs ?? 0),
          }))
          .sort((a, b) => b.requests - a.requests),
        bySandbox: scoped.map((s) => ({
          sandboxId: s.id,
          name: s.name,
          project: s.project,
          requests: requestsBySandbox.get(s.id) ?? 0,
        })),
        logSampling: {
          sampleRate: stats.sampleRate,
          sampledOut: stats.sampledOut,
          dropped: stats.dropped,
          complete: stats.sampleRate === 1 && stats.sampledOut === 0 && stats.dropped === 0,
        },
        retentionDays: RETENTION_DAYS,
      }
    },
  )

  // ── Уведомления ──

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/alerts',
      scope: 'logs:read',
      summary: 'Уведомления песочницы',
      description:
        'То, что показывает колокольчик в кабинете: истекающие ключи, сбои доставки вебхуков, ' +
        'всплески ошибок. Свежие сверху.\n\n' +
        'Прочитанность хранится временем, а не флагом: `readAt` пуст, пока уведомление не ' +
        'разобрали. Фильтр `unreadOnly=true` оставляет только непрочитанные, а пометить ' +
        'прочитанным можно через POST /api/v1/alerts/{id}/read. Кабинет прочитанность пока ' +
        'не показывает — колокольчик там всегда полный.',
      tags: ['Уведомления'],
      needsSandbox: true,
      query: pageQuery.extend({
        severity: z.enum(['info', 'warning', 'danger']).optional(),
        unreadOnly: z.stringbool().optional(),
      }),
      response: pageResponse(
        z.object({
          id: z.string(),
          sandboxId: z.string(),
          severity: z.string(),
          title: z.string(),
          /** Вторая строка в карточке: «ключ stend_sbx_7f3a••••4c21, осталось 3 дня». */
          meta: z.string(),
          icon: z.string(),
          /** Экран кабинета, на котором это чинится. */
          link: z.string().nullable(),
          /** null — уведомление ещё не прочитано. */
          readAt: z.date().nullable(),
          createdAt: z.date(),
        }),
      ),
    },
    async (ctx, input, _req, reply) => {
      const rows = await prisma.alert.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          ...(input.query.severity ? { severity: input.query.severity } : {}),
          ...(input.query.unreadOnly ? { readAt: null } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query)
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/alerts/:id/read',
      scope: 'logs:write',
      summary: 'Пометить уведомление прочитанным',
      description:
        'Проставляет `readAt`. Повторный вызов время не меняет: «прочитано» — это момент, ' +
        'когда уведомление разобрали в первый раз, и переписывать его при каждом опросе ' +
        'значило бы терять этот момент.\n\n' +
        'Снять пометку нельзя: уведомление — это запись о случившемся, а не задача.',
      tags: ['Уведомления'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: z.object({
        id: z.string(),
        readAt: z.date(),
        alreadyRead: z.boolean(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const alert = await prisma.alert.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!alert) return notFound(reply, `Уведомление «${input.params.id}» не найдено в этой песочнице`)
      if (alert.readAt) return { id: alert.id, readAt: alert.readAt, alreadyRead: true }

      const updated = await prisma.alert.update({
        where: { id: alert.id },
        data: { readAt: new Date() },
        select: { id: true, readAt: true },
      })
      return { id: updated.id, readAt: updated.readAt ?? new Date(), alreadyRead: false }
    },
  )

  // ── Консоль ──

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/console/execute',
      scope: 'console:write',
      summary: 'Выполнить запрос к мок-шлюзу',
      description:
        'Тот же серверный прокси, которым работает консоль кабинета: APIStend вызывает мок ' +
        'сам и возвращает ответ целиком. Через браузер так не сделать — боевые Ozon и ' +
        'Wildberries запросы из браузера не разрешают, и мок повторяет это поведение.\n\n' +
        'Произвольный адрес сюда передать нельзя, только сервис и путь: иначе маршрут стал бы ' +
        'открытым прокси для чужих серверов.\n\n' +
        'Вызов идёт от имени ключа ПЕСОЧНИЦЫ, а не того серверного ключа, которым вы ' +
        'авторизовались: он попадает в журнал и в лимит частоты сервиса. Без `apiKeyId` ключ ' +
        'подбирается по сервису — брать первый попавшийся нельзя, у ключей разный набор ' +
        'сервисов, и вызов упирался бы в 400 на ровном месте.\n\n' +
        'Сценарий `timeout` возвращается сразу и в журнал не пишется: держать соединение ' +
        'тридцать секунд ради предсказуемого ответа незачем. Остальные сценарии выполняются ' +
        'по-настоящему и в журнале видны — с `X-Request-Id` из поля `requestId`.\n\n' +
        'Если ключ песочницы упёрся в лимит частоты своего сервиса, сценарий подменяется ' +
        'на `rate_limit`: так же, как это сделал бы боевой сервис.',
      tags: ['Консоль'],
      needsSandbox: true,
      body: consoleBody,
      failures: ['UNPROCESSABLE'],
      response: z.object({
        requestId: z.string(),
        status: z.number(),
        durationMs: z.number(),
        sizeBytes: z.number(),
        headers: z.record(z.string(), z.string()),
        body: z.unknown(),
        /** Сценарий, который выполнился: он мог быть подменён лимитом частоты. */
        scenario: z.string(),
        responseSource: z.string(),
        readiness: z.string().nullable(),
        upstreamUrl: z.string().nullable(),
        /** true — ответ смоделирован без вызова движка (сценарий «Таймаут»). */
        simulated: z.boolean(),
        note: z.string().nullable(),
        apiKey: z.object({ id: z.string(), name: z.string(), mask: z.string() }),
        method: z
          .object({ id: z.string(), title: z.string(), group: z.string() })
          .nullable(),
      }),
    },
    async (ctx, input, req, reply) => {
      const body = input.body

      const apiKey = body.apiKeyId
        // Отозванный ключ не должен «ожить» от того, что его назвали явно:
        // отзыв объявлен необратимым, а вызов лёг бы в журнал как запрос этого ключа.
        ? await prisma.apiKey.findFirst({
            where: { id: body.apiKeyId, sandboxId: ctx.sandbox.id, status: { not: 'revoked' } },
          })
        : await prisma.apiKey.findFirst({
            where: {
              sandboxId: ctx.sandbox.id,
              status: { not: 'revoked' },
              kind: 'sandbox',
              services: { has: body.serviceCode },
            },
            orderBy: { createdAt: 'asc' },
          })

      const service = SERVICE_PROFILES[body.serviceCode].title

      if (!apiKey) {
        if (body.apiKeyId) {
          return notFound(reply, `Ключ «${body.apiKeyId}» не найден в этой песочнице или отозван`)
        }
        // Не 400: запрос составлен верно, выполнить его мешает состояние песочницы.
        // Разделяем «ключей нет вовсе» и «ключи есть, но не для этого сервиса» —
        // это разные действия пользователя, и коды разные, как в кабинете.
        const anyKey = await prisma.apiKey.findFirst({
          where: { sandboxId: ctx.sandbox.id, status: { not: 'revoked' }, kind: 'sandbox' },
        })
        return anyKey
          ? sendError(
              reply,
              422,
              'NO_KEY_FOR_SERVICE',
              `Ни один ключ песочницы не открыт для сервиса ${service}. Добавьте сервис ключу или создайте новый.`,
            )
          : sendError(reply, 422, 'NO_KEY', 'В песочнице нет активного ключа. Создайте ключ через POST /api/v1/keys.')
      }

      if (!apiKey.services.includes(body.serviceCode)) {
        return sendError(reply, 422, 'KEY_SCOPE', `Ключ «${apiKey.name}» не даёт доступ к сервису ${service}`)
      }

      const reqId = newRequestId()
      const startedAt = process.hrtime.bigint()
      const keyCard = { id: apiKey.id, name: apiKey.name, mask: maskOf(apiKey.prefix, apiKey.suffix) }

      const rate = checkRateLimit(apiKey.id, body.serviceCode, Date.now())
      const scenario = rate.allowed ? body.scenario : 'rate_limit'

      if (scenario === 'timeout') {
        return {
          requestId: reqId,
          status: 504,
          durationMs: 30_000,
          sizeBytes: 0,
          headers: {},
          body: null,
          scenario,
          responseSource: 'error',
          readiness: null,
          upstreamUrl: null,
          simulated: true,
          note: 'Сценарий «Таймаут 30 с»: боевой сервис оборвал бы соединение по времени ожидания',
          apiKey: keyCard,
          method: null,
        }
      }

      const result = engine.handle({
        service: body.serviceCode,
        httpMethod: body.httpMethod,
        path: body.path,
        query: body.query,
        headers: body.headers,
        body: body.body ?? null,
        requestId: reqId,
        scenario,
        now: new Date(),
        salt: ctx.sandbox.dataVolume,
      })

      // Задержка честная: консоль должна показывать то же время ответа, которое
      // получит код пользователя, — иначе она врёт про производительность.
      const delay = body.delayMs ?? Math.min(ctx.sandbox.latencyMs, result.latencyMs)
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

      const payload = result.serialized
      const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000)
      const upstreamUrl = result.method ? `${result.method.upstreamHost}${body.path}` : null

      enqueueRequestLog({
        sandboxId: ctx.sandbox.id,
        apiKeyId: apiKey.id,
        publicId: reqId,
        serviceCode: body.serviceCode,
        httpMethod: body.httpMethod,
        endpoint: body.path,
        statusCode: result.status,
        durationMs,
        sizeBytes: Buffer.byteLength(payload),
        upstreamUrl,
        clientIp: req.ip,
        scenario,
        responseSource: result.responseSource,
        // Заголовки и тело приходят от клиента: ключ он мог положить куда угодно,
        // а журнал хранится 30 дней и отдаётся этим же API.
        requestHeaders: maskHeaders(body.headers) as Prisma.InputJsonValue,
        requestBody: body.body ? maskSecretsInText(JSON.stringify(body.body)).slice(0, 8_000) : null,
        responseHeaders: result.headers,
        // Детерминированное тело не храним, его восстановит GET /logs/{id}.
        responseBody: result.responseSource === 'error' ? payload.slice(0, 8_000) : null,
      })

      return {
        requestId: reqId,
        status: result.status,
        durationMs,
        sizeBytes: Buffer.byteLength(payload),
        headers: result.headers,
        body: result.body,
        scenario,
        responseSource: result.responseSource,
        readiness: result.method?.readiness ?? null,
        upstreamUrl,
        simulated: false,
        note: rate.allowed ? null : `Лимит сервиса ${service} исчерпан, сценарий заменён на rate_limit`,
        apiKey: keyCard,
        method: result.method
          ? { id: result.method.id, title: result.method.title, group: result.method.group }
          : null,
      }
    },
  )
}
