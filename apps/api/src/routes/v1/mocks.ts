import type { FastifyInstance } from 'fastify'
import type { CustomMock } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../db.ts'
import { env } from '../../env.ts'
import { PLACEHOLDER_CATALOG, renderTemplate, seededRandom } from '../../lib/templating.ts'
import {
  MOCKABLE_METHODS, MOCK_PATH_PREFIX, MOCK_STATUSES,
  findMockConflict, importMocksFromSpec, isUniqueViolation, parseSpec, pathParamNames,
} from '../../services/mocks.ts'
import {
  badRequest, conflict, defineRoute, notFound,
  page,
  pageChecked, pageArgs, pageQuery, pageResponse,
} from './_registry.ts'

/**
 * Экран «Свои моки» в виде публичного API.
 *
 * Мок — это пара «метод + путь» внутри /custom/*, тело-шаблон и задержка.
 * Отвечает он только по ключу песочницы (stend_sbx_…): серверным ключом
 * мок настраивают, а вызывают его тем же ключом, каким ходит интеграция.
 */

const statusSchema = z.enum(MOCK_STATUSES)
const methodSchema = z.enum(MOCKABLE_METHODS)

/**
 * Тело ответа в списке не отдаётся: двадцать пять моков по двести килобайт —
 * пять мегабайт на страницу, а листают список ради путей и статусов.
 * За телом, заголовками и правилами идут в GET /mocks/:id.
 */
const mockSummary = z.object({
  id: z.string(),
  sandboxId: z.string(),
  httpMethod: z.string(),
  path: z.string(),
  /** Полный адрес вызова — чтобы клиенту не приходилось склеивать его самому. */
  url: z.string(),
  title: z.string(),
  status: statusSchema,
  responseStatusCode: z.number().int(),
  contentType: z.string(),
  delayMs: z.number().int(),
  templatingEnabled: z.boolean(),
  rulesCount: z.number().int(),
  /** Длина шаблона в символах: видно, пустой мок или заполненный, без выкачивания тела. */
  responseBodyLength: z.number().int(),
  callsCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

/** Json-поля Prisma: у z.json() тип строже, чем JsonValue, хотя описывают они одно и то же. */
const jsonField = z.json()
type JsonField = z.input<typeof jsonField>

const mockResource = mockSummary.extend({
  responseBody: z.string(),
  /** Заголовки ответа и правила подбора: хранятся, но движок /custom/* их пока не применяет. */
  headers: jsonField,
  rules: jsonField,
})

function toSummary(m: CustomMock): z.input<typeof mockSummary> {
  return {
    id: m.id,
    sandboxId: m.sandboxId,
    httpMethod: m.httpMethod,
    path: m.path,
    url: `${env.publicOrigin}${m.path}`,
    title: m.title,
    status: m.status,
    responseStatusCode: m.responseStatusCode,
    contentType: m.contentType,
    delayMs: m.delayMs,
    templatingEnabled: m.templatingEnabled,
    rulesCount: Array.isArray(m.rules) ? m.rules.length : 0,
    responseBodyLength: m.responseBody.length,
    callsCount: m.callsCount,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}

function toResource(m: CustomMock): z.input<typeof mockResource> {
  return {
    ...toSummary(m),
    responseBody: m.responseBody,
    headers: m.headers as JsonField,
    rules: m.rules as JsonField,
  }
}

/** Поля мока без значений по умолчанию — общая основа создания и правки. */
const mockShape = {
  httpMethod: methodSchema,
  path: z.string().min(MOCK_PATH_PREFIX.length + 1).max(300)
    .startsWith(MOCK_PATH_PREFIX, `Путь мока начинается с ${MOCK_PATH_PREFIX} — по этому адресу его вызывает песочница`),
  title: z.string().min(2, 'Название не короче 2 символов').max(120),
  status: statusSchema,
  // 1xx — не ответ, а промежуточный сигнал: клиент продолжит ждать тело,
  // которого не будет, и запрос повиснет до таймаута.
  responseStatusCode: z.number().int().min(200).max(599),
  contentType: z.string().min(1).max(120),
  delayMs: z.number().int().min(0).max(3_000),
  templatingEnabled: z.boolean(),
  responseBody: z.string().max(200_000),
  headers: z.record(z.string(), z.string()),
  rules: z.array(z.json()),
}

const createBody = z.object({
  ...mockShape,
  // Черновик по умолчанию: только что созданный мок не должен начать отвечать
  // раньше, чем автор посмотрит, что в нём получилось.
  status: mockShape.status.default('draft'),
  responseStatusCode: mockShape.responseStatusCode.default(200),
  contentType: mockShape.contentType.default('application/json'),
  delayMs: mockShape.delayMs.default(250),
  templatingEnabled: mockShape.templatingEnabled.default(true),
  responseBody: mockShape.responseBody.default(''),
  headers: mockShape.headers.default({}),
  rules: mockShape.rules.default([]),
})

/**
 * Правка: те же поля, но без значений по умолчанию.
 *
 * partial() снимает обязательность, а default() — нет: он подставляет значение
 * даже когда поля в теле не было. С default() «поменять статус» затирало бы
 * и тело ответа, и задержку, и код — всё, что не прислали.
 */
const patchBody = z.object(mockShape).partial()

const placeholderCatalog = z.array(z.object({ code: z.string(), description: z.string() }))

/**
 * Что осталось в тексте после подстановки: renderTemplate оставляет незнакомый
 * плейсхолдер как есть, и опечатка вроде {{uid}} иначе замечается только в проде.
 */
function unresolvedPlaceholders(rendered: string): string[] {
  return [...new Set(rendered.match(/\{\{\s*[^}]+?\s*\}\}/g) ?? [])]
}

export function registerMockV1Routes(app: FastifyInstance): void {
  defineRoute(
    app,
    {
      method: 'GET',
      path: '/mocks',
      scope: 'mocks:read',
      summary: 'Список своих моков',
      description:
        'Моки песочницы, недавно изменённые сверху. Тело ответа, заголовки и правила в список не попадают — ' +
        'за ними идите в GET /mocks/{id}. Фильтры складываются: status, httpMethod и q применяются вместе.',
      tags: ['Свои моки'],
      needsSandbox: true,
      query: pageQuery.extend({
        status: statusSchema.optional(),
        httpMethod: methodSchema.optional(),
        /** Подстрока пути или названия, без учёта регистра. */
        q: z.string().min(1).max(200).optional(),
      }),
      response: pageResponse(mockSummary),
    },
    async (ctx, input, _req, reply) => {
      const { status, httpMethod, q } = input.query
      const rows = await prisma.customMock.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          ...(status ? { status } : {}),
          ...(httpMethod ? { httpMethod } : {}),
          ...(q
            ? {
                OR: [
                  { path: { contains: q, mode: 'insensitive' as const } },
                  { title: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        // id вторым ключом — иначе моки с одинаковым updatedAt (импорт создаёт их
        // пачкой) встают в непредсказуемом порядке, и курсор пропускает записи.
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query, toSummary)
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/mocks',
      scope: 'mocks:write',
      summary: 'Создать свой мок',
      description:
        'Пара «метод + путь» уникальна в песочнице: повтор даёт 409, а не второй мок. ' +
        'Путь обязан начинаться с /custom/ — только эту ветку обслуживает движок своих моков. ' +
        'По умолчанию мок создаётся черновиком и публично не отвечает; включите его через POST /mocks/{id}/enable. ' +
        'Плейсхолдеры в responseBody ({{uuid}}, {{now +3d}}, {{randomInt 1 9}}, {{faker.company}}, {{faker.city}}, ' +
        '{{request.body.поле}}, {{query.поле}}, {{params.id}}) подставляются при вызове, пока templatingEnabled не выключен; ' +
        'полный список и проверку шаблона даёт POST /mocks/preview. ' +
        'Поля headers и rules сохраняются как есть, но движок /custom/* их пока не применяет — он отдаёт тело, код и contentType.',
      tags: ['Свои моки'],
      needsSandbox: true,
      status: 201,
      body: createBody,
      failures: ['CONFLICT'],
      response: mockResource,
    },
    async (ctx, input, _req, reply) => {
      const { httpMethod, path } = input.body
      const busy = await findMockConflict(ctx.sandbox.id, httpMethod, path)
      if (busy) return conflict(reply, `Мок ${httpMethod} ${path} уже создан (${busy.id})`)

      try {
        const created = await prisma.customMock.create({
          data: { sandboxId: ctx.sandbox.id, ...input.body },
        })
        return toResource(created)
      } catch (e) {
        // Между проверкой и вставкой помещается параллельный запрос — тогда
        // о занятости сообщает уникальный индекс, и это по-прежнему 409, а не 500.
        if (isUniqueViolation(e)) return conflict(reply, `Мок ${httpMethod} ${path} уже создан`)
        throw e
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/mocks/:id',
      scope: 'mocks:read',
      summary: 'Мок целиком',
      description:
        'В отличие от списка отдаёт шаблон тела ответа как есть, без подстановки плейсхолдеров: ' +
        'чтобы увидеть результат подстановки, отправьте этот же текст в POST /mocks/preview.',
      tags: ['Свои моки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: mockResource,
    },
    async (ctx, input, _req, reply) => {
      const mock = await prisma.customMock.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!mock) return notFound(reply, 'Мок не найден')
      return toResource(mock)
    },
  )

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/mocks/:id',
      scope: 'mocks:write',
      summary: 'Изменить мок',
      description:
        'Меняются только присланные поля, остальные остаются как были. ' +
        'Смена метода или пути переносит мок на другой адрес: старый перестаёт отвечать сразу, ' +
        'а если новый уже занят другим моком — придёт 409. Счётчик вызовов при переносе не сбрасывается.',
      tags: ['Свои моки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: patchBody,
      failures: ['CONFLICT'],
      response: mockResource,
    },
    async (ctx, input, _req, reply) => {
      if (Object.keys(input.body).length === 0) {
        return badRequest(reply, 'В теле запроса нет ни одного поля для изменения')
      }

      const existing = await prisma.customMock.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!existing) return notFound(reply, 'Мок не найден')

      const httpMethod = input.body.httpMethod ?? existing.httpMethod
      const path = input.body.path ?? existing.path
      if (httpMethod !== existing.httpMethod || path !== existing.path) {
        const busy = await findMockConflict(ctx.sandbox.id, httpMethod, path, existing.id)
        if (busy) return conflict(reply, `Адрес ${httpMethod} ${path} занят другим моком (${busy.id})`)
      }

      try {
        const updated = await prisma.customMock.update({ where: { id: existing.id }, data: input.body })
        return toResource(updated)
      } catch (e) {
        if (isUniqueViolation(e)) return conflict(reply, `Адрес ${httpMethod} ${path} занят другим моком`)
        throw e
      }
    },
  )

  /**
   * Включение и выключение — отдельные маршруты, хотя статус меняется и через PATCH.
   *
   * Так выглядит самый частый сценарий: поднять заглушку перед тестом и погасить
   * после. Запрос без тела не требует от вызывающего ни JSON, ни знания остальных
   * полей — в сценарии CI это одна строка curl. Ответ говорит, что было до вызова:
   * по previousStatus и changed видно, погасил мок этот вызов или он уже был погашен,
   * а PATCH такого не покажет — он вернёт только новое состояние.
   */
  function statusRoute(action: 'enable' | 'disable', next: 'active' | 'disabled'): void {
    defineRoute(
      app,
      {
        method: 'POST',
        path: `/mocks/:id/${action}`,
        scope: 'mocks:write',
        summary: next === 'active' ? 'Включить мок' : 'Выключить мок',
        description: next === 'active'
          ? 'Переводит мок в active — с этого мгновения /custom/… отвечает по нему всем, у кого есть ключ песочницы. ' +
            'Черновик и выключенный мок отвечают 409 MOCK_NOT_ACTIVE. Повторный вызов ничего не меняет и не считается ошибкой.'
          : 'Переводит мок в disabled: адрес перестаёт отвечать, но сам мок, его тело и счётчик вызовов сохраняются. ' +
            'Чтобы убрать мок совсем, нужен DELETE. Повторный вызов ничего не меняет и не считается ошибкой.',
        tags: ['Свои моки'],
        needsSandbox: true,
        params: z.object({ id: z.string().min(1) }),
        response: mockSummary.extend({
          previousStatus: statusSchema,
          /** false — мок уже был в этом состоянии. */
          changed: z.boolean(),
        }),
      },
      async (ctx, input, _req, reply) => {
        const existing = await prisma.customMock.findFirst({
          where: { id: input.params.id, sandboxId: ctx.sandbox.id },
        })
        if (!existing) return notFound(reply, 'Мок не найден')

        // Лишний UPDATE сдвинул бы updatedAt и переставил мок в начало списка,
        // хотя ничего не изменилось.
        const updated = existing.status === next
          ? existing
          : await prisma.customMock.update({ where: { id: existing.id }, data: { status: next } })

        return { ...toSummary(updated), previousStatus: existing.status, changed: existing.status !== next }
      },
    )
  }

  statusRoute('enable', 'active')
  statusRoute('disable', 'disabled')

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/mocks/:id',
      scope: 'mocks:write',
      summary: 'Удалить мок',
      description:
        'Необратимо: шаблон ответа и счётчик вызовов пропадают вместе с моком, восстановить их нечем. ' +
        'Записи журнала запросов остаются — они принадлежат песочнице, а не моку. ' +
        'Если мок нужен только на время, выключайте его через POST /mocks/{id}/disable. ' +
        'В ответе — что именно было удалено, чтобы скрипт мог это записать.',
      tags: ['Свои моки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: z.object({
        ok: z.literal(true),
        id: z.string(),
        httpMethod: z.string(),
        path: z.string(),
        title: z.string(),
        /** Сколько раз мок успел ответить до удаления. */
        callsCount: z.number().int(),
      }),
    },
    async (ctx, input, _req, reply) => {
      // Фильтр по своей песочнице прямо в запросе: чужой идентификатор обязан
      // давать 404, иначе по разнице кодов перебираются чужие моки.
      const mock = await prisma.customMock.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!mock) return notFound(reply, 'Мок не найден')

      const { count } = await prisma.customMock.deleteMany({
        where: { id: mock.id, sandboxId: ctx.sandbox.id },
      })
      if (count === 0) return notFound(reply, 'Мок не найден')

      return {
        ok: true as const,
        id: mock.id,
        httpMethod: mock.httpMethod,
        path: mock.path,
        title: mock.title,
        callsCount: mock.callsCount,
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/mocks/import',
      scope: 'mocks:write',
      summary: 'Импорт моков из OpenAPI',
      description:
        'Создаёт по моку на каждую операцию спецификации (JSON или YAML, 3.x). ' +
        'Тело ответа берётся из примера в спецификации; операции без примера получают {} — ' +
        'придуманный по схеме ответ хуже пустого, потому что выглядит настоящим. ' +
        'Повторный импорт того же файла безопасен: уже существующие пары «метод + путь» попадают в skipped, ' +
        'а не перезаписываются. Операции сверх limit не создаются и считаются в leftOver — ' +
        'если он больше нуля, повторите вызов с бо́льшим limit.',
      tags: ['Свои моки'],
      needsSandbox: true,
      status: 201,
      body: z.object({
        /** Сырой текст файла: JSON или YAML. */
        document: z.string().min(2).max(5_000_000),
        pathPrefix: z.string().max(100)
          .startsWith('/custom', 'Префикс начинается с /custom')
          .default('/custom/imported'),
        status: statusSchema.default('draft'),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      response: z.object({
        createdCount: z.number().int(),
        skippedCount: z.number().int(),
        leftOver: z.number().int(),
        limit: z.number().int(),
        created: z.array(z.object({
          id: z.string(),
          httpMethod: z.string(),
          path: z.string(),
          title: z.string(),
        })),
        skipped: z.array(z.object({
          httpMethod: z.string(),
          path: z.string(),
          reason: z.enum(['duplicate', 'path_too_long']),
        })),
      }),
    },
    async (ctx, input, _req, reply) => {
      const parsed = parseSpec(input.body.document)
      if (!parsed.ok) return badRequest(reply, parsed.message)

      const result = await importMocksFromSpec(parsed.doc, {
        sandboxId: ctx.sandbox.id,
        pathPrefix: input.body.pathPrefix,
        status: input.body.status,
        limit: input.body.limit,
      })

      return {
        createdCount: result.created.length,
        skippedCount: result.skipped.length,
        leftOver: result.leftOver,
        limit: input.body.limit,
        created: result.created,
        skipped: result.skipped,
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/mocks/preview',
      scope: 'mocks:read',
      summary: 'Отрисовать шаблон ответа',
      description:
        'Подставляет плейсхолдеры в присланный текст и ничего не сохраняет — ни мока, ни записи в журнале. ' +
        'Нужен, чтобы проверить шаблон до сохранения: validJson говорит, останется ли результат разбираемым JSON, ' +
        'а unresolved показывает подстановки, которые остались в тексте нетронутыми (обычно это опечатка в имени). ' +
        'Результат детерминированный: один и тот же шаблон и seed дают один и тот же текст, поэтому его можно сравнивать в тестах. ' +
        'Песочница здесь не нужна — отрисовка ничего о ней не знает.',
      tags: ['Свои моки'],
      body: z.object({
        template: z.string().max(200_000),
        /**
         * Путь будущего мока: из него берутся имена параметров, чтобы {{params.id}}
         * подставился образцом, а не пустой строкой.
         */
        path: z.string().max(300).optional(),
        sampleBody: z.json().optional(),
        sampleQuery: z.record(z.string(), z.json()).optional(),
        sampleParams: z.record(z.string(), z.string()).optional(),
        /** Своя соль для {{uuid}}, {{randomInt}} и faker-подстановок. */
        seed: z.string().min(1).max(200).optional(),
      }),
      response: z.object({
        rendered: z.string(),
        /** false — текст после подстановки перестал быть JSON. */
        validJson: z.boolean(),
        unresolved: z.array(z.string()),
        placeholders: placeholderCatalog,
      }),
    },
    async (_ctx, input) => {
      const { template, sampleBody, sampleQuery, sampleParams } = input.body

      // Параметры пути: присланные вызывающим, для остальных — образец из имени.
      // Пустое значение показывало бы не то, что придёт по настоящему адресу.
      const params: Record<string, string> = {}
      for (const name of pathParamNames(input.body.path ?? '')) params[name] = `sample-${name}`
      for (const [name, value] of Object.entries(sampleParams ?? {})) params[name] = value

      const rendered = renderTemplate(template, {
        body: sampleBody ?? {},
        query: sampleQuery ?? {},
        params,
        now: new Date(),
        // Соль по умолчанию — сам шаблон: одинаковый текст даёт одинаковый ответ,
        // и предпросмотр не «плывёт» между вызовами. По длине или по времени
        // два разных шаблона совпадали бы солью.
        random: seededRandom(input.body.seed ?? template),
      })

      let validJson = true
      try {
        JSON.parse(rendered)
      } catch {
        validJson = false
      }

      return {
        rendered,
        validJson,
        unresolved: unresolvedPlaceholders(rendered),
        // Каталог подстановок отдаётся здесь же: это единственное место API,
        // где он нужен, и отдельный запрос за справочником был бы лишним.
        placeholders: [...PLACEHOLDER_CATALOG],
      }
    },
  )
}
