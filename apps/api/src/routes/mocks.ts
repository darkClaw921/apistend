import type { FastifyInstance } from 'fastify'
import type { CustomMock } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { PLACEHOLDER_CATALOG, renderTemplate, seededRandom } from '../lib/templating.ts'
import { extractRawKey, resolveApiKey } from '../lib/api-key.ts'
import { enqueueRequestLog } from '../lib/log-buffer.ts'
import { requestId as newRequestId } from '../lib/ids.ts'
import { parse as parseYaml } from 'yaml'
import {
  cleanText, extractResponse, firstSentence, iterateOperations, makeResolver,
  type OpenApiDoc,
} from '@apistend/catalog-ingest'

/** Экран «Свои моки» и обслуживание созданных пользователем эндпоинтов. */

/** Поля мока без значений по умолчанию — общая основа создания и правки. */
const mockShape = {
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  // Ровно /custom/…: по другому адресу мок недостижим — обслуживается только
  // ветка /custom/*. Раньше схема принимала любой путь, и мок молча создавался
  // мёртвым.
  path: z.string().min(2).max(300)
    .startsWith('/custom/', 'Путь мока начинается с /custom/ — по этому адресу его вызывает песочница'),
  title: z.string().min(2).max(120),
  status: z.enum(['active', 'draft', 'disabled']),
  // 1xx — не ответ, а промежуточный сигнал: клиент продолжит ждать тело,
  // которого не будет, и запрос повиснет до таймаута.
  responseStatusCode: z.number().int().min(200).max(599),
  contentType: z.string().max(120),
  delayMs: z.number().int().min(0).max(3_000),
  templatingEnabled: z.boolean(),
  responseBody: z.string().max(200_000),
}

const upsert = z.object({
  ...mockShape,
  status: mockShape.status.default('draft'),
  responseStatusCode: mockShape.responseStatusCode.default(200),
  contentType: mockShape.contentType.default('application/json'),
  delayMs: mockShape.delayMs.default(250),
  templatingEnabled: mockShape.templatingEnabled.default(true),
  responseBody: mockShape.responseBody.default(''),
})

/**
 * Правка: те же поля, но без значений по умолчанию.
 *
 * partial() снимает обязательность, а default() — нет: он подставляет значение
 * даже когда поля в теле не было. Из-за этого «поменять статус» затирало
 * и тело ответа, и задержку, и код — всё, что не прислали.
 */
const patchMock = z.object(mockShape).partial()

/** P2002 — нарушение уникального индекса (sandboxId, httpMethod, path). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'
}

/** Методы, которые умеет обслуживать движок своих моков. */
const MOCKABLE = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

const importSpec = z.object({
  /** Сырой текст файла: JSON или YAML — разберём и то, и другое. */
  document: z.string().min(2).max(5_000_000),
  /**
   * Префикс пути. Внутри /custom — там и только там песочница обслуживает
   * свои моки; префикс вне этой ветки создавал моки, которые нельзя вызвать.
   */
  pathPrefix: z.string().max(100)
    .startsWith('/custom', 'Префикс начинается с /custom')
    .default('/custom/imported'),
  status: z.enum(['active', 'draft', 'disabled']).default('draft'),
  /** Потолок за один импорт: спецификация на тысячу операций забьёт экран. */
  limit: z.number().int().min(1).max(200).default(100),
})

/**
 * OpenAPI приходит и в JSON, и в YAML. Сначала пробуем JSON — он строже
 * и дешевле, и только потом подключаем разбор YAML.
 */
function parseSpecDocument(raw: string): OpenApiDoc {
  const text = raw.trim()
  if (text.startsWith('{')) return JSON.parse(text) as OpenApiDoc
  return parseYaml(text) as OpenApiDoc
}

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

  /**
   * Импорт своих моков из спецификации OpenAPI 3.x.
   *
   * Разбор берётся из @apistend/catalog-ingest — тем же кодом собран каталог
   * Ozon и Wildberries, и заводить второй разбор ради этой кнопки незачем.
   *
   * Тело ответа для мока — пример из спецификации, если он там есть. Выдумывать
   * ответ по схеме здесь не станем: мок, отдающий придуманное, хуже мока,
   * отдающего пустой объект, — второй хотя бы честен.
   */
  app.post('/api/mocks/import', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = importSpec.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }

    let doc: OpenApiDoc
    try {
      doc = parseSpecDocument(parsed.data.document)
    } catch (e) {
      return reply.code(400).send({
        error: 'PARSE_FAILED',
        message: `Не удалось разобрать файл: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`,
      })
    }
    if (!doc.paths || Object.keys(doc.paths).length === 0) {
      return reply.code(400).send({ error: 'PARSE_FAILED', message: 'В файле нет ни одного пути (paths)' })
    }

    const resolve = makeResolver(doc)
    const prefix = parsed.data.pathPrefix.replace(/\/$/, '')
    const created: string[] = []
    const skipped: string[] = []
    /** Операции, до которых импорт не дошёл из-за потолка. Молчать о них нельзя. */
    let leftOver = 0

    for (const { path, method, op, pathItem } of iterateOperations(doc)) {
      // Мок обслуживает только эти методы: HEAD и OPTIONS движку нечего отдавать.
      if (!MOCKABLE.includes(method as (typeof MOCKABLE)[number])) continue
      if (created.length >= parsed.data.limit) {
        // Раньше здесь стоял break, и остаток спецификации исчезал молча:
        // ответ «создано 100» на файле из 460 операций читается как «всё готово».
        leftOver++
        continue
      }

      const response = extractResponse(op, resolve)
      const mockPath = `${prefix}${path}`
      // Обрезка до 300 символов склеила бы разные операции в один путь,
      // и вторая молча ушла бы в дубли. Такие операции пропускаем.
      if (mockPath.length > 300) {
        skipped.push(`${method} ${mockPath.slice(0, 60)}…`)
        continue
      }
      const title = firstSentence(cleanText(op.summary ?? op.description ?? path), 110) || path

      try {
        await prisma.customMock.create({
          data: {
            sandboxId: ctx.sandbox.id,
            httpMethod: method as (typeof MOCKABLE)[number],
            path: mockPath,
            title: title.slice(0, 120),
            status: parsed.data.status,
            responseStatusCode: response.successStatus,
            contentType: 'application/json',
            delayMs: 250,
            templatingEnabled: true,
            // null в примере равнозначен его отсутствию: строка «null» в теле
            // ответа выглядит как ошибка, а обещали пустой объект.
            responseBody: response.example == null
              ? '{}'
              : JSON.stringify(response.example, null, 2).slice(0, 200_000),
            headers: {},
            rules: [],
          },
        })
        created.push(`${method} ${mockPath}`)
      } catch (e) {
        // Дубль — обычное дело при повторном импорте того же файла: пропускаем,
        // а не роняем весь импорт на середине.
        if (isUniqueViolation(e)) skipped.push(`${method} ${mockPath}`)
        else throw e
      }
    }

    return reply.send({
      created: created.length,
      skipped: skipped.length,
      examples: created.slice(0, 5),
      /** Сколько операций осталось за потолком: пользователь решит, повышать ли limit. */
      leftOver,
      limit: parsed.data.limit,
    })
  })

  app.post('/api/mocks', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const parsed = upsert.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    try {
      const created = await prisma.customMock.create({
        data: { sandboxId: ctx.sandbox.id, ...parsed.data, headers: {}, rules: [] },
      })
      return reply.code(201).send(created)
    } catch (e) {
      // Пара «метод + путь» уникальна в песочнице. Без этой ветки повтор
      // возвращал бы 500 вместо внятного «такой мок уже есть».
      if (isUniqueViolation(e)) {
        return reply.code(409).send({
          error: 'ALREADY_EXISTS',
          message: `Мок ${parsed.data.httpMethod} ${parsed.data.path} уже создан`,
        })
      }
      throw e
    }
  })

  app.patch<{ Params: { id: string } }>('/api/mocks/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const parsed = patchMock.safeParse(req.body)
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
  /**
   * Тест-вызов мока из кабинета.
   *
   * Публичный путь /custom/* требует ключ песочницы, а он показывается ровно
   * один раз при создании — кабинет его не хранит. Поэтому вызов делается
   * по сессии и отдаёт ровно то, что получил бы клиент: код, тип, тело
   * с подставленными плейсхолдерами и заявленную задержку. Саму задержку
   * не выдерживаем: проверяют содержимое ответа, а не секундомер.
   */
  app.post<{ Params: { id: string } }>('/api/mocks/:id/test', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const mock = await prisma.customMock.findFirst({
      where: { id: req.params.id, sandboxId: ctx.sandbox.id },
    })
    if (!mock) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Мок не найден' })

    const { sampleBody, sampleParams } = (req.body ?? {}) as {
      sampleBody?: unknown
      sampleParams?: Record<string, unknown>
    }
    // Параметры пути: присланные вызывающим, а для остальных — образец из имени.
    // Пустой объект оставлял {{params.id}} пустой строкой, и тест-вызов показывал
    // не то, что придёт по настоящему адресу.
    const params: Record<string, string> = {}
    for (const name of pathParamNames(mock.path)) {
      const given = sampleParams?.[name]
      params[name] = given === undefined || given === null ? `sample-${name}` : String(given)
    }

    const body = mock.templatingEnabled
      ? renderTemplate(mock.responseBody, {
          body: sampleBody ?? {},
          query: {},
          params,
          now: new Date(),
        })
      : mock.responseBody

    let validJson = true
    try {
      if (mock.contentType.includes('json')) JSON.parse(body)
    } catch {
      validJson = false
    }

    return reply.send({
      status: mock.responseStatusCode,
      contentType: mock.contentType,
      delayMs: mock.delayMs,
      body,
      validJson,
      // Черновик и выключенный по публичному пути не отвечают — говорим об этом
      // прямо, иначе тест-вызов вводил бы в заблуждение.
      servedPublicly: mock.status === 'active',
      mockStatus: mock.status,
    })
  })

  app.post('/api/mocks/preview', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const { template, sampleBody, sampleParams } = (req.body ?? {}) as {
      template?: string
      sampleBody?: unknown
      sampleParams?: Record<string, unknown>
    }
    if (typeof template !== 'string') return reply.code(400).send({ error: 'NO_TEMPLATE' })

    // Образцы параметров пути: редактор ещё не знает, на каком адресе окажется
    // мок, поэтому имя параметра подставляется само собой понятным значением.
    const params: Record<string, string> = { id: 'sample-id' }
    for (const [name, value] of Object.entries(sampleParams ?? {})) {
      if (value !== undefined && value !== null) params[name] = String(value)
    }

    const rendered = renderTemplate(template, {
      body: sampleBody ?? { externalId: 'EXT-10422', customer: { id: 'C-77' }, items: [{ sku: '2037841009335' }] },
      query: {},
      params,
      now: new Date(),
      // Соль — сам шаблон: один и тот же текст даёт один и тот же предпросмотр
      // при каждом открытии. По длине два разных шаблона совпадали бы солью.
      random: seededRandom(`${ctx.sandbox.id}:${template}`),
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

    const found = await findMock(resolved.sandbox.id, req.method, path)
    if (!found) {
      return reply.code(404).send({ error: 'MOCK_NOT_FOUND', message: `Мок ${req.method} ${path} не найден` })
    }
    const { mock, params } = found
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
          params,
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

/**
 * Точное совпадение пути, затем шаблонное: /custom/erp/orders/{id}
 *
 * Возвращает и значения, подставленные в фигурные скобки. Раньше совпадение
 * шаблона просто отбрасывалось, params всегда был пуст, и {{params.id}}
 * в теле ответа разворачивался в пустую строку — плейсхолдер существовал,
 * но не работал ни разу.
 */
async function findMock(
  sandboxId: string, method: string, path: string,
): Promise<{ mock: CustomMock; params: Record<string, string> } | null> {
  const exact = await prisma.customMock.findFirst({
    where: { sandboxId, httpMethod: method.toUpperCase(), path },
  })
  if (exact) return { mock: exact, params: {} }

  const candidates = await prisma.customMock.findMany({
    where: { sandboxId, httpMethod: method.toUpperCase(), path: { contains: '{' } },
  })
  const actual = path.split('/')
  for (const mock of candidates) {
    const template = mock.path.split('/')
    if (template.length !== actual.length) continue

    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < template.length; i++) {
      const segment = template[i]!
      if (segment.startsWith('{') && segment.endsWith('}') && segment.length > 2) {
        // Пустой сегмент параметром не считается: /custom/orders// — не заказ.
        if (actual[i]!.length === 0) { matched = false; break }
        params[segment.slice(1, -1)] = decodeURIComponent(actual[i]!)
        continue
      }
      if (segment !== actual[i]) { matched = false; break }
    }
    if (matched) return { mock, params }
  }
  return null
}

/** Имена параметров из шаблона пути: /custom/orders/{id}/lines/{line} → [id, line] */
function pathParamNames(path: string): string[] {
  return path.split('/')
    .filter((s) => s.startsWith('{') && s.endsWith('}') && s.length > 2)
    .map((s) => s.slice(1, -1))
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
