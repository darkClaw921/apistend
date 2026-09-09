import type { FastifyInstance } from 'fastify'
import type { Sandbox } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../db.ts'
import { env } from '../../env.ts'
import { invalidateKeyCache } from '../../lib/api-key.ts'
import { flushKeyUsage } from '../../lib/key-usage.ts'
import { sendError } from '../../lib/mgmt.ts'
import {
  badRequest,
  conflict,
  defineRoute,
  page,
  pageChecked,
  pageArgs,
  pageQuery,
  pageResponse,
  unprocessable,
} from './_registry.ts'

/**
 * Песочницы в виде публичного API.
 *
 * В кабинете вторую песочницу завести нельзя (переключатель показывает только
 * существующие), а объём данных, задержка и доля ошибок не правятся вообще нигде.
 * Значит, для этих операций Management API — единственный вход, и объяснять
 * последствия приходится здесь: другого экрана с подсказками у пользователя нет.
 */

const dataVolume = z.enum(['min', 'medium', 'full'])

/**
 * Статус — пометка для человека: шлюз его не смотрит, запросы к «paused»
 * песочнице продолжают работать. Перечислением, а не свободной строкой, чтобы
 * в колонке, которую кабинет рисует чипом, не оседали случайные значения.
 */
const sandboxStatus = z.enum(['ok', 'paused'])

const counts = z.object({
  /** Кроме отозванных: ключ со статусом expiring ещё работает — так же считает и кабинет. */
  keys: z.number(),
  webhooks: z.number(),
  mocks: z.number(),
})

const sandboxItem = z.object({
  id: z.string(),
  name: z.string(),
  project: z.string(),
  // На чтение — строка: колонка свободная, и в базе могут лежать значения,
  // которых нет в перечислении для записи.
  status: z.string(),
  dataVolume,
  latencyMs: z.number(),
  errorRate: z.number(),
  /** Эту песочницу возьмут запросы без sandboxId — для скрипта это важнее любого счётчика. */
  isDefault: z.boolean(),
  counts,
  lastResetAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

type Counts = z.infer<typeof counts>

const ZERO_COUNTS: Counts = { keys: 0, webhooks: 0, mocks: 0 }

/**
 * Счётчики для набора песочниц — три запроса на любое их количество.
 *
 * include: { _count } в findMany дал бы по подзапросу на каждую песочницу
 * и не умеет исключить отозванные ключи, а нужен именно тот счётчик, который
 * показывает кабинет, иначе одно и то же число в двух местах разойдётся.
 */
async function countsOf(sandboxIds: string[]): Promise<Map<string, Counts>> {
  const result = new Map<string, Counts>(sandboxIds.map((id) => [id, { ...ZERO_COUNTS }]))
  if (sandboxIds.length === 0) return result

  const scope = { sandboxId: { in: sandboxIds } }
  const [keys, webhooks, mocks] = await Promise.all([
    prisma.apiKey.groupBy({ by: ['sandboxId'], where: { ...scope, status: { not: 'revoked' } }, _count: { _all: true } }),
    prisma.webhook.groupBy({ by: ['sandboxId'], where: scope, _count: { _all: true } }),
    prisma.customMock.groupBy({ by: ['sandboxId'], where: scope, _count: { _all: true } }),
  ])

  for (const row of keys) {
    const cell = result.get(row.sandboxId)
    if (cell) cell.keys = row._count._all
  }
  for (const row of webhooks) {
    const cell = result.get(row.sandboxId)
    if (cell) cell.webhooks = row._count._all
  }
  for (const row of mocks) {
    const cell = result.get(row.sandboxId)
    if (cell) cell.mocks = row._count._all
  }
  return result
}

function toItem(sandbox: Sandbox, cells: Counts, defaultSandboxId: string | null): z.input<typeof sandboxItem> {
  return {
    id: sandbox.id,
    name: sandbox.name,
    project: sandbox.project,
    status: sandbox.status,
    dataVolume: sandbox.dataVolume,
    latencyMs: sandbox.latencyMs,
    errorRate: sandbox.errorRate,
    isDefault: sandbox.id === defaultSandboxId,
    counts: cells,
    lastResetAt: sandbox.lastResetAt,
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
  }
}

const nameField = z
  .string()
  .min(2, 'Имя песочницы не короче 2 символов')
  .max(40, 'Имя песочницы не длиннее 40 символов')
const projectField = z.string().min(1, 'Название проекта не может быть пустым').max(80)
const latencyField = z.number().int().min(0).max(3000, 'Задержка не больше 3000 мс')
const errorRateField = z.number().int().min(0).max(50, 'Доля ошибок не больше 50 %')

const SETTINGS_NOTE =
  'dataVolume — размер каталога товаров песочницы (min — 100 артикулов, medium — 300, full — 1000) ' +
  'и одновременно соль генератора: после её смены движок отдаёт другой набор записей, ' +
  'и идентификаторы из прошлых ответов перестают совпадать. latencyMs — потолок задержки шлюза ' +
  '(фактическая равна минимуму из настройки песочницы и задержки самого метода, а заголовок ' +
  'X-Mock-Delay перебивает обе). errorRate — доля запросов, которым шлюз ответит ошибкой вместо ' +
  'успешного сценария.'

export function registerSandboxV1Routes(app: FastifyInstance): void {
  defineRoute(
    app,
    {
      method: 'GET',
      path: '/sandboxes',
      scope: 'sandboxes:read',
      summary: 'Список песочниц',
      description:
        'Все песочницы аккаунта в порядке создания: первая в списке — та, которую берут запросы ' +
        'без sandboxId у сессии кабинета (у серверного ключа умолчание — его собственная песочница, ' +
        'она помечена isDefault). Счётчики ключей, вебхуков и своих моков считаются на лету.',
      tags: ['Песочницы'],
      query: pageQuery,
      response: pageResponse(sandboxItem),
    },
    async (ctx, input, _req, reply) => {
      // По возрастанию createdAt: умолчание для сессии кабинета — первая созданная
      // песочница, и список обязан начинаться с неё же, иначе isDefault выглядит
      // случайной пометкой в середине страницы.
      const rows = await prisma.sandbox.findMany({
        where: { userId: ctx.userId },
        // Второй ключ сортировки нужен курсору: при совпавшем времени порядок
        // иначе не определён, и страница теряет или повторяет запись.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(input.query),
      })

      const cells = await countsOf(rows.map((s) => s.id))
      return pageChecked(reply, rows, input.query, (s) => toItem(s, cells.get(s.id) ?? ZERO_COUNTS, ctx.defaultSandboxId))
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/sandboxes',
      scope: 'sandboxes:write',
      summary: 'Создать песочницу',
      description:
        'Заводит вторую и последующие песочницы — в кабинете этого сделать нельзя. Новая песочница ' +
        'пустая: ключи, вебхуки и моки в неё не переносятся, ключ для неё выпускается отдельно. ' +
        'Имя уникально в пределах аккаунта. ' +
        SETTINGS_NOTE,
      tags: ['Песочницы'],
      status: 201,
      body: z.object({
        name: nameField,
        project: projectField.default('Без названия'),
        dataVolume: dataVolume.default('medium'),
        latencyMs: latencyField.default(250),
        errorRate: errorRateField.default(5),
      }),
      failures: ['CONFLICT', 'UNPROCESSABLE'],
      response: sandboxItem,
    },
    async (ctx, input, _req, reply) => {
      const total = await prisma.sandbox.count({ where: { userId: ctx.userId } })
      if (total >= env.maxSandboxesPerAccount) {
        return unprocessable(
          reply,
          `Больше ${env.maxSandboxesPerAccount} песочниц на аккаунт завести нельзя. ` +
            'Удалите ненужную через DELETE /api/v1/sandboxes/{id} или сбросьте её данные',
        )
      }

      const taken = await prisma.sandbox.findFirst({
        where: { userId: ctx.userId, name: input.body.name },
        select: { id: true },
      })
      if (taken) {
        return conflict(reply, `Песочница с именем «${input.body.name}» у аккаунта уже есть. Выберите другое имя`)
      }

      try {
        const created = await prisma.sandbox.create({ data: { userId: ctx.userId, ...input.body } })
        // Первая песочница аккаунта сразу становится умолчанием для сессии кабинета:
        // до неё defaultSandboxId был пуст, потому что выбирать было не из чего.
        const defaultId = ctx.defaultSandboxId ?? created.id
        return toItem(created, { ...ZERO_COUNTS }, defaultId)
      } catch (err) {
        // Между проверкой имени и вставкой есть окно: два параллельных запроса
        // с одним именем упираются в @@unique([userId, name]). Это тот же конфликт,
        // и отвечать на него 500-й ошибкой было бы враньём.
        if ((err as { code?: unknown }).code === 'P2002') {
          return conflict(reply, `Песочница с именем «${input.body.name}» у аккаунта уже есть. Выберите другое имя`)
        }
        throw err
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/sandboxes/:sandboxId',
      scope: 'sandboxes:read',
      summary: 'Песочница',
      description:
        'Настройки одной песочницы и её счётчики. Чужой или несуществующий идентификатор даёт 404.',
      tags: ['Песочницы'],
      needsSandbox: true,
      params: z.object({ sandboxId: z.string().min(1) }),
      response: sandboxItem,
    },
    async (ctx) => {
      const cells = await countsOf([ctx.sandbox.id])
      return toItem(ctx.sandbox, cells.get(ctx.sandbox.id) ?? ZERO_COUNTS, ctx.defaultSandboxId)
    },
  )

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/sandboxes/:sandboxId',
      scope: 'sandboxes:write',
      summary: 'Изменить настройки песочницы',
      description:
        'Меняются только переданные поля. ' +
        SETTINGS_NOTE +
        ' status — пометка для человека: шлюз его не проверяет, и запросы к песочнице со статусом ' +
        '«paused» продолжают выполняться. Новые значения задержки и доли ошибок начинают ' +
        'действовать сразу, дожидаться истечения кеша ключей не нужно.',
      tags: ['Песочницы'],
      needsSandbox: true,
      params: z.object({ sandboxId: z.string().min(1) }),
      body: z.object({
        name: nameField.optional(),
        project: projectField.optional(),
        dataVolume: dataVolume.optional(),
        latencyMs: latencyField.optional(),
        errorRate: errorRateField.optional(),
        status: sandboxStatus.optional(),
      }),
      failures: ['CONFLICT'],
      response: sandboxItem,
    },
    async (ctx, input, _req, reply) => {
      const patch = input.body
      if (Object.keys(patch).length === 0) {
        // Пустой PATCH почти всегда означает опечатку в имени поля: лишние ключи
        // zod отбрасывает молча, и без этой проверки в ответ пришла бы неизменённая
        // песочница, как будто изменение применилось.
        return badRequest(reply, 'Не передано ни одного поля для изменения', [
          'body: ожидается хотя бы одно из name, project, dataVolume, latencyMs, errorRate, status',
        ])
      }

      if (patch.name !== undefined && patch.name !== ctx.sandbox.name) {
        const taken = await prisma.sandbox.findFirst({
          where: { userId: ctx.userId, name: patch.name, id: { not: ctx.sandbox.id } },
          select: { id: true },
        })
        if (taken) return conflict(reply, `Песочница с именем «${patch.name}» у аккаунта уже есть. Выберите другое имя`)
      }

      const updated = await prisma.sandbox.update({ where: { id: ctx.sandbox.id }, data: patch })

      // Кеш разбора ключей держит копию строки песочницы 30 секунд, поэтому шлюз
      // ещё полминуты отвечал бы со старой задержкой, старой долей ошибок и старым
      // набором данных — а человек в это время смотрел бы на новые значения в ответе.
      if (patch.dataVolume !== undefined || patch.latencyMs !== undefined || patch.errorRate !== undefined) {
        invalidateKeyCache()
      }

      const cells = await countsOf([updated.id])
      return toItem(updated, cells.get(updated.id) ?? ZERO_COUNTS, ctx.defaultSandboxId)
    },
  )

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/sandboxes/:sandboxId',
      scope: 'sandboxes:write',
      summary: 'Удалить песочницу',
      description:
        'Необратимо и с продолжением: вместе с песочницей удаляются её ключи, вебхуки с журналом ' +
        'доставок, сценарии, серии событий, свои моки, журнал запросов, локальные приложения ' +
        'Bitrix24 и личные изменения демо-данных. Ключи этой песочницы перестают работать сразу — ' +
        'и в Management API, и на мок-шлюзе. Чтобы подтвердить намерение, в поле confirmName ' +
        'повторите имя песочницы. Последнюю песочницу аккаунта удалить нельзя. ' +
        'В ответе — сводка того, что было удалено.',
      tags: ['Песочницы'],
      needsSandbox: true,
      params: z.object({ sandboxId: z.string().min(1) }),
      body: z.object({
        confirmName: z.string().min(1, 'Повторите имя песочницы в поле confirmName'),
      }),
      response: z.object({
        ok: z.literal(true),
        id: z.string(),
        name: z.string(),
        removed: z.object({
          /**
           * Все ключи песочницы, включая отозванные. Поле counts.keys в карточке
           * считает иначе — только работающие: там вопрос «сколько ключей действует»,
           * здесь «сколько строк исчезнет».
           */
          keys: z.number(),
          webhooks: z.number(),
          mocks: z.number(),
          scenarios: z.number(),
          bursts: z.number(),
          requestLogs: z.number(),
          b24Apps: z.number(),
          /** Личные изменения демо-данных — то же, что чистит сброс песочницы. */
          overlay: z.number(),
        }),
      }),
    },
    async (ctx, input, _req, reply) => {
      const total = await prisma.sandbox.count({ where: { userId: ctx.userId } })
      if (total <= 1) {
        // Ключи, вебхуки и моки живут только внутри песочницы. Удалив последнюю,
        // пользователь остался бы с аккаунтом, в котором нечему принадлежать,
        // и с ключами, которые нельзя ни выпустить, ни привязать.
        return unprocessable(
          reply,
          'Это последняя песочница аккаунта, удалить её нельзя: ключи, вебхуки и моки существуют ' +
            'только внутри песочницы. Создайте новую через POST /api/v1/sandboxes, перенесите работу ' +
            'в неё и удалите эту. Личные данные текущей песочницы чистит POST /api/v1/sandboxes/:sandboxId/reset',
        )
      }

      if (input.body.confirmName !== ctx.sandbox.name) {
        // Тот же порядок, что при отзыве ключа в кабинете: подтверждение проверяется
        // на сервере, а не только кнопкой в интерфейсе.
        return sendError(
          reply,
          400,
          'CONFIRM_MISMATCH',
          `Удаление необратимо. Повторите имя песочницы в поле confirmName — ожидается «${ctx.sandbox.name}»`,
        )
      }

      // Ключи считаются ВСЕ, включая отозванные: удаление уносит и их.
      // В counts карточки то же поле считается без отозванных — там оно отвечает
      // на вопрос «сколько ключей работает», здесь на вопрос «сколько строк исчезнет».
      const where = { sandboxId: ctx.sandbox.id }
      const [keys, webhooks, mocks, scenarios, bursts, requestLogs, b24Apps, overlay] = await Promise.all([
        prisma.apiKey.count({ where }),
        prisma.webhook.count({ where }),
        prisma.customMock.count({ where }),
        prisma.scenario.count({ where }),
        prisma.eventBurst.count({ where }),
        prisma.requestLog.count({ where }),
        prisma.b24App.count({ where }),
        prisma.sandboxOverlay.count({ where }),
      ])

      // Счётчики использования копятся в памяти и уходят в базу одной транзакцией
      // раз в 10 секунд. Ключи этой песочницы сейчас уедут каскадом, и строка
      // удалённого ключа в буфере уронила бы всю транзакцию — вместе со счётчиками
      // всех остальных ключей за это окно. Сбрасываем, пока ключи ещё существуют.
      await flushKeyUsage()

      // Связанные записи уносит onDelete: Cascade — перечислять их в транзакции незачем.
      await prisma.sandbox.delete({ where: { id: ctx.sandbox.id } })

      // Кеш ключей живёт 30 секунд и ничего не знает об удалении: без сброса
      // ключи удалённой песочницы продолжали бы пускать в API и на шлюз,
      // а шлюз писал бы журнал в песочницу, которой уже нет.
      invalidateKeyCache()

      return {
        ok: true as const,
        id: ctx.sandbox.id,
        name: ctx.sandbox.name,
        removed: { keys, webhooks, mocks, scenarios, bursts, requestLogs, b24Apps, overlay },
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/sandboxes/:sandboxId/reset',
      scope: 'sandboxes:write',
      summary: 'Сбросить данные песочницы',
      description:
        'Возвращает демо-данные к исходному виду: удаляет личные изменения пользователя ' +
        '(созданные, изменённые и удалённые им записи) и переставляет lastResetAt. Базовый набор ' +
        'общий для всех аккаунтов и только на чтение — сбрасывать в нём нечего. Ключи, вебхуки, ' +
        'сценарии, свои моки и журнал запросов сброс не трогает: их удаляет только DELETE песочницы. ' +
        'Отменить сброс нельзя, в ответе — сколько записей удалено.',
      tags: ['Песочницы'],
      needsSandbox: true,
      params: z.object({ sandboxId: z.string().min(1) }),
      response: z.object({
        sandboxId: z.string(),
        /** Столько личных записей удалено. Ноль означает, что менять было нечего. */
        removed: z.number(),
        lastResetAt: z.date(),
      }),
    },
    async (ctx) => {
      const removed = await prisma.sandboxOverlay.deleteMany({ where: { sandboxId: ctx.sandbox.id } })
      const sandbox = await prisma.sandbox.update({
        where: { id: ctx.sandbox.id },
        data: { lastResetAt: new Date() },
        select: { lastResetAt: true },
      })

      return { sandboxId: ctx.sandbox.id, removed: removed.count, lastResetAt: sandbox.lastResetAt }
    },
  )
}
