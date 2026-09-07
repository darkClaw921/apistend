import type { FastifyInstance } from 'fastify'
import { SERVICE_LIST, isServiceCode } from '@apistend/shared'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { flushRequestLogs } from '../lib/log-buffer.ts'
import { engine } from '../gateway.ts'

/** Экран «Обзор»: KPI, последние запросы, уведомления, сводка по сервисам. */

export function registerOverviewRoutes(app: FastifyInstance): void {
  app.get('/api/overview', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    await flushRequestLogs()

    const now = Date.now()
    const since24h = new Date(now - 24 * 3_600_000)
    const since48h = new Date(now - 48 * 3_600_000)
    const where = { sandboxId: ctx.sandbox.id, timestamp: { gte: since24h } }

    const [total, errors, latency, previousTotal, activeKeys, recent, alerts] = await Promise.all([
      prisma.requestLog.count({ where }),
      prisma.requestLog.count({ where: { ...where, statusCode: { gte: 400 } } }),
      prisma.requestLog.aggregate({ where, _avg: { durationMs: true } }),
      prisma.requestLog.count({
        where: { sandboxId: ctx.sandbox.id, timestamp: { gte: since48h, lt: since24h } },
      }),
      prisma.apiKey.count({ where: { sandboxId: ctx.sandbox.id, status: { not: 'revoked' } } }),
      prisma.requestLog.findMany({
        where: { sandboxId: ctx.sandbox.id },
        orderBy: { timestamp: 'desc' },
        take: 8,
        select: {
          id: true, timestamp: true, serviceCode: true, httpMethod: true, endpoint: true,
          statusCode: true, durationMs: true, apiKey: { select: { name: true } },
        },
      }),
      prisma.alert.findMany({ where: { sandboxId: ctx.sandbox.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ])

    const avg = Math.round(latency._avg.durationMs ?? 0)
    const errorRate = total > 0 ? (errors / total) * 100 : 0
    const growth = previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : null

    const services = SERVICE_LIST.map((p) => {
      const methods = engine.catalog(p.code)
      return {
        code: p.code,
        title: p.title,
        methodsCount: methods.length,
        snapshotDate: methods[0]?.snapshotDate ?? null,
        status: methods.length === 0 ? 'planned' : 'ok',
      }
    })

    return reply.send({
      kpi: {
        requests24h: total,
        requestsGrowthPercent: growth,
        avgLatencyMs: avg,
        errorRatePercent: errorRate,
        activeKeys,
      },
      recent: recent.map((r) => ({
        id: r.id, timestamp: r.timestamp, serviceCode: r.serviceCode, httpMethod: r.httpMethod,
        endpoint: r.endpoint, statusCode: r.statusCode, durationMs: r.durationMs,
        apiKeyName: r.apiKey?.name ?? null,
      })),
      alerts,
      services,
      totalMethods: services.reduce((n, s) => n + s.methodsCount, 0),
    })
  })

  /**
   * Поиск по всем демо-API сразу — ключевой блок «Обзора».
   * Ищет по названию метода, пути и описанию во всех сервисах одновременно.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(req.query.limit ?? 8), 1), 30)
    if (q.length < 2) return reply.send({ query: q, total: 0, results: [] })

    const results: Array<{
      id: string; serviceCode: string; httpMethod: string; path: string
      title: string; description: string; readiness: string; score: number
    }> = []

    for (const profile of SERVICE_LIST) {
      for (const m of engine.catalog(profile.code)) {
        const path = m.path.toLowerCase()
        const title = m.title.toLowerCase()
        const description = m.description.toLowerCase()
        // Совпадение в пути ценнее, чем в описании: разработчик чаще ищет эндпоинт.
        const score = path.includes(q) ? 3 : title.includes(q) ? 2 : description.includes(q) ? 1 : 0
        if (score === 0) continue
        results.push({
          id: m.id, serviceCode: m.serviceCode, httpMethod: m.httpMethod, path: m.path,
          title: m.title, description: m.description, readiness: m.readiness, score,
        })
      }
    }

    results.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    return reply.send({ query: q, total: results.length, results: results.slice(0, limit) })
  })

  /**
   * Предпросмотр обмена в правой колонке «Обзора»: что уходит и что приходит.
   * Без ухода с экрана и без записи в журнал — это витрина, а не вызов.
   */
  app.get<{ Params: { id: string } }>('/api/search/preview/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const id = decodeURIComponent(req.params.id)
    const serviceCode = id.split(':')[0]
    if (!isServiceCode(serviceCode)) return reply.code(404).send({ error: 'NOT_FOUND' })

    const method = engine.catalog(serviceCode).find((m) => m.id === id)
    if (!method) return reply.code(404).send({ error: 'NOT_FOUND' })

    const started = process.hrtime.bigint()
    const result = engine.handle({
      service: serviceCode,
      httpMethod: method.httpMethod,
      path: method.path.replace(/\{[^}]+\}/g, '12345'),
      query: {},
      headers: {},
      body: null,
      requestId: 'req_preview',
      scenario: 'success',
      now: new Date(),
      salt: ctx.sandbox.dataVolume,
    })

    const requestExample = method.params
      .filter((p) => p.in === 'body')
      .slice(0, 4)
      .reduce<Record<string, unknown>>((acc, p) => {
        acc[p.name] = p.type.includes('[]') ? [] : p.type === 'integer' || p.type === 'number' ? 0 : ''
        return acc
      }, {})

    return reply.send({
      method: {
        id: method.id, httpMethod: method.httpMethod, path: method.path,
        title: method.title, serviceCode: method.serviceCode, readiness: method.readiness,
      },
      request: Object.keys(requestExample).length > 0 ? requestExample : null,
      response: result.body,
      statusCode: result.status,
      durationMs: Math.max(1, Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)),
      sizeBytes: Buffer.byteLength(result.serialized),
      responseSource: result.responseSource,
    })
  })
}
