import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { PLACEHOLDER_CATALOG, renderTemplate, seededRandom } from '../lib/templating.ts'
import { extractRawKey, resolveApiKey } from '../lib/api-key.ts'
import { enqueueRequestLog } from '../lib/log-buffer.ts'
import { requestId as newRequestId } from '../lib/ids.ts'

/** Экран «Свои моки» и обслуживание созданных пользователем эндпоинтов. */

const upsert = z.object({
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(2).max(300).startsWith('/', 'Путь должен начинаться со слэша'),
  title: z.string().min(2).max(120),
  status: z.enum(['active', 'draft', 'disabled']).default('draft'),
  responseStatusCode: z.number().int().min(100).max(599).default(200),
  contentType: z.string().max(120).default('application/json'),
  delayMs: z.number().int().min(0).max(3_000).default(250),
  templatingEnabled: z.boolean().default(true),
  responseBody: z.string().max(200_000).default(''),
})

export function registerMockRoutes(app: FastifyInstance): void {
  app.get('/api/mocks', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const mocks = await prisma.customMock.findMany({
      where: { sandboxId: ctx.sandbox.id },
      orderBy: { updatedAt: 'desc' },
    })

    return reply.send({
      mocks: mocks.map((m) => ({
        ...m,
        // В макете мета-строка мока — «4 правила · 1 284 вызова · 2 мин назад».
        rulesCount: Array.isArray(m.rules) ? m.rules.length : 0,
      })),
      placeholders: PLACEHOLDER_CATALOG,
      counts: {
        all: mocks.length,
        active: mocks.filter((m) => m.status === 'active').length,
        draft: mocks.filter((m) => m.status === 'draft').length,
        disabled: mocks.filter((m) => m.status === 'disabled').length,
      },
    })
  })

  app.post('/api/mocks', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const parsed = upsert.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const created = await prisma.customMock.create({
      data: { sandboxId: ctx.sandbox.id, ...parsed.data, headers: {}, rules: [] },
    })
    return reply.code(201).send(created)
  })

  app.patch<{ Params: { id: string } }>('/api/mocks/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const parsed = upsert.partial().safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const existing = await prisma.customMock.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })

    const updated = await prisma.customMock.update({ where: { id: existing.id }, data: parsed.data })
    return reply.send(updated)
  })

  app.delete<{ Params: { id: string } }>('/api/mocks/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const { count } = await prisma.customMock.deleteMany({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    return count > 0 ? reply.send({ ok: true }) : reply.code(404).send({ error: 'NOT_FOUND' })
  })

  /**
   * Предпросмотр с подставленными шаблонами — нижний блок редактора.
   * Детерминированный: один и тот же мок выглядит одинаково между открытиями,
   * иначе предпросмотр «плывёт» при каждом нажатии клавиши.
   */
  app.post('/api/mocks/preview', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const { template, sampleBody } = (req.body ?? {}) as { template?: string; sampleBody?: unknown }
    if (typeof template !== 'string') return reply.code(400).send({ error: 'NO_TEMPLATE' })

    const rendered = renderTemplate(template, {
      body: sampleBody ?? { externalId: 'EXT-10422', customer: { id: 'C-77' }, items: [{ sku: '2037841009335' }] },
      query: {},
      params: {},
      now: new Date(),
      random: seededRandom(`${ctx.sandbox.id}:${template.length}`),
    })

    let valid = true
    try {
      JSON.parse(rendered)
    } catch {
      valid = false
    }
    return reply.send({ rendered, validJson: valid })
  })

  /**
   * Обслуживание созданных пользователем эндпоинтов: /custom/*
   * Отдельная ветка от мок-шлюза: здесь маршруты задаёт пользователь, а не спецификация.
   */
  app.all<{ Params: { '*': string } }>('/custom/*', async (req, reply) => {
    const startedAt = process.hrtime.bigint()
    const reqId = newRequestId()
    const path = `/custom/${req.params['*']}`

    const rawKey = extractRawKey(
      req.headers as Record<string, string | string[] | undefined>,
      (req.query ?? {}) as Record<string, unknown>,
      path,
      req.body,
    )
    const resolved = await resolveApiKey(rawKey)
    if (!resolved) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Неверный или отозванный ключ' })
    }

    const mock = await findMock(resolved.sandbox.id, req.method, path)
    if (!mock) {
      return reply.code(404).send({ error: 'MOCK_NOT_FOUND', message: `Мок ${req.method} ${path} не найден` })
    }
    if (mock.status !== 'active') {
      return reply.code(409).send({
        error: 'MOCK_NOT_ACTIVE',
        message: `Мок в статусе «${mock.status === 'draft' ? 'черновик' : 'выключен'}» — опубликуйте его`,
      })
    }

    const body = mock.templatingEnabled
      ? renderTemplate(mock.responseBody, {
          body: parseJson(req.body),
          query: (req.query ?? {}) as Record<string, unknown>,
          params: {},
          now: new Date(),
        })
      : mock.responseBody

    if (mock.delayMs > 0) await new Promise((r) => setTimeout(r, mock.delayMs))

    await prisma.customMock.updateMany({ where: { id: mock.id }, data: { callsCount: { increment: 1 } } })

    enqueueRequestLog({
      sandboxId: resolved.sandbox.id,
      apiKeyId: resolved.apiKey.id,
      publicId: reqId,
      serviceCode: 'custom',
      httpMethod: req.method,
      endpoint: path,
      statusCode: mock.responseStatusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
      sizeBytes: Buffer.byteLength(body),
      upstreamUrl: null,
      clientIp: req.ip,
      scenario: 'success',
      responseSource: 'example',
      requestHeaders: {},
      requestBody: null,
      responseHeaders: {},
      responseBody: null,
    })

    return reply
      .code(mock.responseStatusCode)
      .header('content-type', mock.contentType)
      .header('x-request-id', reqId)
      .header('x-apistend-source', 'custom-mock')
      .send(body)
  })
}

/** Точное совпадение пути, затем шаблонное: /custom/erp/orders/{id} */
async function findMock(sandboxId: string, method: string, path: string) {
  const exact = await prisma.customMock.findFirst({
    where: { sandboxId, httpMethod: method.toUpperCase(), path },
  })
  if (exact) return exact

  const candidates = await prisma.customMock.findMany({
    where: { sandboxId, httpMethod: method.toUpperCase(), path: { contains: '{' } },
  })
  for (const mock of candidates) {
    const pattern = new RegExp(
      `^${mock.path.split('/').map((s) => (s.startsWith('{') && s.endsWith('}') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`,
    )
    if (pattern.test(path)) return mock
  }
  return null
}

function parseJson(body: unknown): unknown {
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      return null
    }
  }
  return body ?? null
}
