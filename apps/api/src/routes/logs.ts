import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { isServiceCode } from '@apistend/shared'
import { isServiceCode as isService } from '@apistend/shared'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { bufferStats, flushRequestLogs } from '../lib/log-buffer.ts'
import { engine } from '../gateway.ts'
import { requestId as newRequestId } from '../lib/ids.ts'

/** Экран «Логи запросов»: сводка, почасовой график, таблица с фильтрами, деталка. */

const PERIODS: Record<string, number> = { '1h': 1, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }

export function registerLogRoutes(app: FastifyInstance): void {
  app.get('/api/logs', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    // Буфер логов сбрасываем перед чтением: иначе только что сделанный запрос
    // не появится в списке, и это выглядит как потеря данных.
    await flushRequestLogs()

    const q = req.query as Record<string, string | undefined>
    const hours = PERIODS[q.period ?? '24h'] ?? 24
    const since = new Date(Date.now() - hours * 3_600_000)
    const limit = Math.min(Math.max(Number(q.limit ?? 15), 1), 100)
    const offset = Math.max(Number(q.offset ?? 0), 0)

    const where: Prisma.RequestLogWhereInput = { sandboxId: ctx.sandbox.id, timestamp: { gte: since } }
    // `apistend` — собственный MCP-сервер стенда: код сервиса в журнале есть,
    // а в списке мокаемых сервисов его нет и быть не должно.
    if (q.service && (isServiceCode(q.service) || q.service === 'apistend')) where.serviceCode = q.service
    if (q.apiKeyId) where.apiKeyId = q.apiKeyId
    if (q.status && q.status !== 'all') {
      const group = Number(q.status)
      // «4xx» и «5xx» приходят как 400 и 500 — раскрываем в диапазон.
      if (group === 200) where.statusCode = { gte: 200, lt: 300 }
      else if (group === 400) where.statusCode = { gte: 400, lt: 500 }
      else if (group === 500) where.statusCode = { gte: 500 }
      else if (Number.isFinite(group)) where.statusCode = group
    }
    if (q.q && q.q.trim().length > 0) {
      where.endpoint = { contains: q.q.trim(), mode: 'insensitive' }
    }

    const [total, rows, aggregate, errorCount, buckets] = await Promise.all([
      prisma.requestLog.count({ where }),
      prisma.requestLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true, publicId: true, timestamp: true, serviceCode: true, httpMethod: true,
          endpoint: true, statusCode: true, durationMs: true, sizeBytes: true,
          apiKey: { select: { id: true, name: true } },
        },
      }),
      prisma.requestLog.aggregate({ where, _avg: { durationMs: true }, _count: true }),
      // AND, а не перезапись statusCode: при фильтре «5xx» разворот объекта
      // подменял условие {gte: 500} на {gte: 400}, и доля ошибок считалась
      // от чужого знаменателя — на экране стояло «292,9 %».
      prisma.requestLog.count({ where: { AND: [where, { statusCode: { gte: 400 } }] } }),
      hourlyBuckets(ctx.sandbox.id, since),
    ])

    // p95 считаем на выборке длительностей: точный перцентиль в SQL тут избыточен.
    const durations = await prisma.requestLog.findMany({
      where, select: { durationMs: true }, orderBy: { durationMs: 'asc' }, take: 5_000,
    })
    const p95 = durations.length > 0
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]!.durationMs
      : 0

    return reply.send({
      summary: {
        total: aggregate._count,
        errorRate: aggregate._count > 0 ? (errorCount / aggregate._count) * 100 : 0,
        avgLatencyMs: Math.round(aggregate._avg.durationMs ?? 0),
        p95LatencyMs: p95,
      },
      hourly: buckets,
      total,
      offset,
      limit,
      // Под нагрузкой журнал прореживается — пользователь обязан это видеть,
      // иначе решит, что часть запросов не дошла.
      sampling: { sampleRate: bufferStats().sampleRate, sampledOut: bufferStats().sampledOut },
      rows: rows.map((r) => ({
        id: r.id,
        publicId: r.publicId,
        timestamp: r.timestamp,
        serviceCode: r.serviceCode,
        httpMethod: r.httpMethod,
        endpoint: r.endpoint,
        statusCode: r.statusCode,
        durationMs: r.durationMs,
        sizeBytes: r.sizeBytes,
        apiKeyName: r.apiKey?.name ?? null,
      })),
    })
  })

  /**
   * Экспорт CSV. Отдаём потоком построчно, а не собираем всё в память:
   * выгрузка за месяц у активного аккаунта — это сотни тысяч строк.
   */
  app.get('/api/logs/export', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    await flushRequestLogs()

    const q = req.query as Record<string, string | undefined>
    const hours = PERIODS[q.period ?? '24h'] ?? 24
    const where: Prisma.RequestLogWhereInput = {
      sandboxId: ctx.sandbox.id,
      timestamp: { gte: new Date(Date.now() - hours * 3_600_000) },
    }
    // `apistend` — собственный MCP-сервер стенда: код сервиса в журнале есть,
    // а в списке мокаемых сервисов его нет и быть не должно.
    if (q.service && (isServiceCode(q.service) || q.service === 'apistend')) where.serviceCode = q.service

    const stamp = new Date().toISOString().slice(0, 10)
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="apistend-logs-${stamp}.csv"`)

    // BOM — иначе Excel открывает кириллицу как мусор.
    const chunks: string[] = ['\uFEFF' + [
      'Время', 'Сервис', 'Метод', 'Эндпоинт', 'Код', 'Задержка, мс', 'Размер, байт', 'Ключ', 'ID запроса',
    ].join(';') + '\n']

    const PAGE = 1_000
    let cursor: string | undefined
    let exported = 0
    const LIMIT = 100_000

    while (exported < LIMIT) {
      const page = await prisma.requestLog.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true, publicId: true, timestamp: true, serviceCode: true, httpMethod: true,
          endpoint: true, statusCode: true, durationMs: true, sizeBytes: true,
          apiKey: { select: { name: true } },
        },
      })
      if (page.length === 0) break
      for (const r of page) {
        chunks.push([
          r.timestamp.toISOString(),
          r.serviceCode,
          r.httpMethod,
          csvCell(r.endpoint),
          r.statusCode,
          r.durationMs,
          r.sizeBytes,
          csvCell(r.apiKey?.name ?? ''),
          r.publicId,
        ].join(';') + '\n')
      }
      exported += page.length
      cursor = page[page.length - 1]!.id
      if (page.length < PAGE) break
    }

    return reply.send(chunks.join(''))
  })

  app.get<{ Params: { id: string } }>('/api/logs/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    await flushRequestLogs()

    const row = await prisma.requestLog.findFirst({
      where: { sandboxId: ctx.sandbox.id, OR: [{ id: req.params.id }, { publicId: req.params.id }] },
      include: { apiKey: { select: { id: true, name: true } } },
    })
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' })

    // Тела успешных ответов не хранятся: они детерминированы. Восстанавливаем
    // тем же движком, что их сформировал, — результат совпадает байт в байт.
    let responseBody = row.responseBody
    let responseHeaders = row.responseHeaders as Record<string, string> | null
    let reproduced = false
    if (responseBody === null && isService(row.serviceCode)) {
      const sandbox = ctx.sandbox
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
        salt: sandbox.dataVolume,
      })
      if (result.method) {
        responseBody = result.serialized
        responseHeaders = result.headers
        reproduced = true
      }
    }

    return reply.send({
      ...row,
      responseBody,
      responseHeaders,
      /** Признак, что тело восстановлено, а не прочитано из журнала. */
      responseBodyReproduced: reproduced,
      apiKeyName: row.apiKey?.name ?? null,
      apiKey: undefined,
    })
  })
}

/** Экранирование по RFC 4180 с разделителем «;» — его понимает Excel с русской локалью. */
function csvCell(value: string): string {
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Почасовые бакеты для столбчатой диаграммы: всего и сколько из них ошибок. */
async function hourlyBuckets(sandboxId: string, since: Date) {
  const rows = await prisma.$queryRaw<Array<{ hour: Date; total: bigint; errors: bigint }>>`
    SELECT date_trunc('hour', "timestamp") AS hour,
           count(*)                        AS total,
           count(*) FILTER (WHERE "statusCode" >= 400) AS errors
    FROM request_logs
    WHERE "sandboxId" = ${sandboxId} AND "timestamp" >= ${since}
    GROUP BY 1
    ORDER BY 1
  `
  return rows.map((r) => ({
    hour: r.hour.toISOString(),
    total: Number(r.total),
    errors: Number(r.errors),
  }))
}
