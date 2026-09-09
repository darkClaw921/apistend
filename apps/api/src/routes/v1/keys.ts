import type { FastifyInstance } from 'fastify'
import type { ApiKey } from '@prisma/client'
import { z } from 'zod'
import { SERVICE_CODES } from '@apistend/shared'
import { prisma } from '../../db.ts'
import { generateKey, maskOf } from '../../lib/keys.ts'
import { invalidateKeyCache } from '../../lib/api-key.ts'
import { flushKeyUsage } from '../../lib/key-usage.ts'
import { hasScope, scopeSchema, sendError, type MgmtCtx, type Scope } from '../../lib/mgmt.ts'
import {
  badRequest,
  conflict,
  defineRoute,
  forbidden,
  notFound,
  page,
  pageChecked,
  pageArgs,
  pageQuery,
  pageResponse,
  unprocessable,
} from './_registry.ts'

/**
 * Экран «Ключи и токены» в виде публичного API.
 *
 * Полный секрет покидает сервер ровно дважды за жизнь ключа — при выпуске и при
 * ротации: в базе лежит HMAC-хеш, восстановить ключ нечем. Поэтому маршрута
 * «показать ключ ещё раз» здесь нет, а забытый ключ заменяется ротацией.
 */

const keyKind = z.enum(['sandbox', 'server'])
const keyStatus = z.enum(['active', 'expiring', 'revoked'])
const serviceCode = z.enum(SERVICE_CODES)

const keyItem = z.object({
  id: z.string(),
  name: z.string(),
  subtitle: z.string().nullable(),
  kind: keyKind,
  /** stend_sk_7f3a••••••4c21 — всё, что известно о секрете после выпуска. */
  mask: z.string(),
  services: z.array(z.string()),
  scopes: z.array(z.string()),
  /** Полный доступ к Management API. У ключа песочницы всегда false: он сюда не пускается. */
  fullAccess: z.boolean(),
  status: keyStatus,
  rotationDays: z.number().int(),
  /** Счётчик растёт и от вызовов Management API, не только от вызовов моков. */
  requestsPerDay: z.number().int(),
  /** true у ключа, которым сделан этот запрос: чтобы скрипт не отозвал сам себя вслепую. */
  isCurrent: z.boolean(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  revokedBy: z.string().nullable(),
})

/** Пустой список областей — это полный доступ, а не «прав нет». */
function isFullAccess(scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.includes('*')
}

function keyResource(key: ApiKey, ctx: MgmtCtx): z.input<typeof keyItem> {
  return {
    id: key.id,
    name: key.name,
    subtitle: key.subtitle,
    kind: key.kind,
    mask: maskOf(key.prefix, key.suffix),
    services: key.services,
    scopes: key.scopes,
    fullAccess: key.kind === 'server' && isFullAccess(key.scopes),
    status: key.status,
    rotationDays: key.rotationDays,
    requestsPerDay: key.requestsPerDay,
    isCurrent: ctx.apiKeyId === key.id,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    revokedBy: key.revokedBy,
  }
}

/**
 * Области, которых у вызывающего нет, а он их раздаёт.
 *
 * Пустой список проверяется наравне с перечисленным: пустой scopes означает
 * полный доступ, поэтому «выпустить ключ вообще без областей» из ограниченного
 * ключа — та же эскалация, только записанная иначе. Раз проверка сравнивает
 * желаемое с собственными правами, повысить себя PATCH-ем тоже нельзя: своему
 * ключу можно назначить только подмножество того, что у него уже есть.
 */
function scopesBeyond(ctx: MgmtCtx, wanted: readonly string[]): string[] {
  if (isFullAccess(ctx.scopes)) return []
  if (isFullAccess(wanted)) return ['*']
  return wanted.filter((scope) => !hasScope(ctx.scopes, scope as Scope))
}

function listScopes(scopes: readonly string[]): string {
  return scopes.length > 0 ? scopes.map((s) => `«${s}»`).join(', ') : '«полный доступ»'
}

/** Кто отозвал — видно на экране ключей. Способ вызова там же: ключом или руками из кабинета. */
function actorOf(ctx: MgmtCtx): string {
  return ctx.via === 'key' ? `${ctx.user.name} · Management API` : ctx.user.name
}

export function registerKeysV1Routes(app: FastifyInstance): void {
  // ─────────────────────────── Список ───────────────────────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/keys',
      scope: 'keys:read',
      summary: 'Список ключей песочницы',
      description:
        'Ключи одной песочницы, свежие сверху. Секрет не отдаётся никогда — только маска: в базе лежит хеш. ' +
        'Пустой список scopes у серверного ключа означает полный доступ к Management API, поэтому рядом идёт готовый признак fullAccess. ' +
        'Ключ со статусом expiring продолжает работать — не работает только revoked.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      query: pageQuery.extend({
        status: keyStatus.optional(),
        kind: keyKind.optional(),
      }),
      response: pageResponse(keyItem),
    },
    async (ctx, input, _req, reply) => {
      const rows = await prisma.apiKey.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          ...(input.query.status ? { status: input.query.status } : {}),
          ...(input.query.kind ? { kind: input.query.kind } : {}),
        },
        // Второй ключ сортировки нужен курсору: при совпавшем времени порядок
        // иначе не определён, и страница теряет или повторяет запись.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query, (k) => keyResource(k, ctx))
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/keys/:id',
      scope: 'keys:read',
      summary: 'Ключ по идентификатору',
      description:
        'Тот же объект, что и в списке. Ключ ищется только в текущей песочнице: ' +
        'чужой идентификатор даёт 404, а ключ из соседней песочницы — тоже 404, пока не указан её ?sandboxId.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: keyItem,
    },
    async (ctx, input, _req, reply) => {
      const key = await prisma.apiKey.findFirst({ where: { id: input.params.id, sandboxId: ctx.sandbox.id } })
      if (!key) return notFound(reply, 'Ключ не найден')
      return keyResource(key, ctx)
    },
  )

  // ─────────────────────────── Выпуск ───────────────────────────

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/keys',
      scope: 'keys:write',
      summary: 'Выпустить ключ',
      description:
        'Ключ создаётся в текущей песочнице, и поле secret отдаётся ровно в этом ответе — больше его получить неоткуда, ' +
        'забытый ключ заменяется ротацией.\n\n' +
        'kind=sandbox (по умолчанию) — ключ песочницы stend_sbx_…, им ходит код интеграции в моки; ' +
        'kind=server — серверный ключ stend_sk_…, только им работают CLI и этот Management API.\n\n' +
        'scopes задаются только серверному ключу и не могут быть шире прав вызывающего; ' +
        'пустой список — полный доступ, поэтому ограниченный ключ обязан перечислить области явно.\n\n' +
        'rotationDays — срок напоминания о замене, а не срок жизни: сам по себе ключ не протухает.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      status: 201,
      body: z.object({
        name: z.string().min(2, 'Название не короче 2 символов').max(80),
        subtitle: z.string().max(120).optional(),
        kind: keyKind.default('sandbox'),
        /**
         * Принимается ради совместимости и игнорируется: ключ песочницы
         * открывает все сервисы стенда. Деление по сервисам убрано — оно ничего
         * не защищало, а ключ, выданный до появления нового сервиса, оставался
         * без него навсегда. Отвергать поле нельзя: сломались бы клиенты,
         * написанные до этой правки.
         */
        services: z.array(serviceCode).optional(),
        rotationDays: z.number().int().min(1).max(365).default(90),
        scopes: z.array(scopeSchema).optional(),
      }),
      response: keyItem.extend({
        /** Полный ключ. Второй раз его не покажет никто. */
        secret: z.string(),
        warning: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const wanted = input.body.scopes ?? []

      // Ключ песочницы в Management API не принимается вовсе, так что его области
      // ни на что не влияют. Молча их сохранить — значит показывать в списке
      // права, которых на деле нет.
      if (input.body.kind === 'sandbox' && wanted.length > 0) {
        return unprocessable(
          reply,
          'Области доступа задаются только серверному ключу: ключом песочницы Management API не пользуются, его scopes ни на что не влияют. ' +
            'Уберите scopes или укажите kind=server',
        )
      }

      // Эскалация проверяется только у серверных ключей — только они сюда ходят.
      const missing = input.body.kind === 'server' ? scopesBeyond(ctx, wanted) : []
      if (missing.length > 0) {
        return forbidden(
          reply,
          wanted.length === 0
            ? 'Ключ без списка scopes получает полный доступ, а у вызывающего ключа доступ ограничен. ' +
                `Перечислите области явно, не шире выданных: ${listScopes(ctx.scopes)}`
            : `Нельзя выдать области ${listScopes(missing)}: их нет у вызывающего ключа. Выданы: ${listScopes(ctx.scopes)}`,
        )
      }

      const generated = generateKey(input.body.kind)
      const created = await prisma.apiKey.create({
        data: {
          sandboxId: ctx.sandbox.id,
          name: input.body.name,
          subtitle: input.body.subtitle ?? null,
          kind: input.body.kind,
          prefix: generated.prefix,
          suffix: generated.suffix,
          keyHash: generated.hash,
          services: [...SERVICE_CODES],
          rotationDays: input.body.rotationDays,
          scopes: wanted,
        },
      })

      return {
        ...keyResource(created, ctx),
        secret: generated.full,
        warning: 'Сохраните ключ: полностью он показывается только сейчас',
      }
    },
  )

  // ─────────────────────────── Изменение ───────────────────────────

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/keys/:id',
      scope: 'keys:write',
      summary: 'Изменить ключ',
      description:
        'Меняются только настройки: название, подпись, сервисы, срок напоминания о ротации и области доступа. ' +
        'Секрет остаётся прежним — чтобы сменить сам ключ, нужен /keys/{id}/rotate, а чтобы выключить его — /keys/{id}/revoke.\n\n' +
        'Новые scopes не могут быть шире прав вызывающего, поэтому и собственному ключу можно только урезать права, а не добавить. ' +
        'Указывайте хотя бы одно поле: пустое тело ничего не меняет и отвергается.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        name: z.string().min(2, 'Название не короче 2 символов').max(80).optional(),
        /** null — снять подпись. */
        subtitle: z.string().max(120).nullable().optional(),
        /** Принимается ради совместимости и игнорируется — см. создание ключа. */
        services: z.array(serviceCode).optional(),
        rotationDays: z.number().int().min(1).max(365).optional(),
        scopes: z.array(scopeSchema).optional(),
      }),
      response: keyItem,
    },
    async (ctx, input, _req, reply) => {
      const key = await prisma.apiKey.findFirst({ where: { id: input.params.id, sandboxId: ctx.sandbox.id } })
      if (!key) return notFound(reply, 'Ключ не найден')

      // services разбирается, но не применяется: набор сервисов у ключа всегда полный.
      const { name, subtitle, services, rotationDays, scopes } = input.body
      if (name === undefined && subtitle === undefined && services === undefined && rotationDays === undefined && scopes === undefined) {
        return badRequest(reply, 'Не указано ни одного поля для изменения')
      }

      if (scopes !== undefined) {
        if (key.kind === 'sandbox') {
          return unprocessable(
            reply,
            'У ключа песочницы области доступа ни на что не влияют: в Management API он не принимается. Меняйте scopes только у серверных ключей',
          )
        }
        const missing = scopesBeyond(ctx, scopes)
        if (missing.length > 0) {
          return forbidden(
            reply,
            scopes.length === 0
              ? 'Пустой список scopes — это полный доступ, а у вызывающего ключа доступ ограничен. Перечислите области явно'
              : `Нельзя назначить области ${listScopes(missing)}: их нет у вызывающего ключа. Выданы: ${listScopes(ctx.scopes)}`,
          )
        }
      }

      const updated = await prisma.apiKey.update({
        where: { id: key.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(subtitle !== undefined ? { subtitle } : {}),
          ...(rotationDays !== undefined ? { rotationDays } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
        },
      })
      // Разбор ключа кешируется на 30 секунд вместе с services и scopes.
      // Без сброса урезанные права продолжали бы действовать в полном объёме
      // ещё полминуты — то есть ровно тогда, когда их и урезают в спешке.
      invalidateKeyCache()

      return keyResource(updated, ctx)
    },
  )

  // ─────────────────────────── Ротация ───────────────────────────

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/keys/:id/rotate',
      scope: 'keys:write',
      summary: 'Выпустить новый секрет вместо старого',
      description:
        'Старый ключ отзывается в той же транзакции, в которой создаётся новый: прежний секрет перестаёт работать немедленно, ' +
        'а не после переходного периода — если он зашит в работающую интеграцию, она встанет до подстановки нового.\n\n' +
        'Новый ключ наследует название, подпись, вид, сервисы, срок ротации и области доступа, но получает свой идентификатор: ' +
        'старая запись остаётся в списке со статусом revoked и пометкой «ротация».\n\n' +
        'Отозванный ключ не прокручивается — отзыв необратим по замыслу, вместо воскрешения выпускается новый ключ. ' +
        'Прокрутить чужой ключ с более широкими правами, чем у вызывающего, тоже нельзя: ротация выдаёт на руки рабочий секрет.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      status: 201,
      params: z.object({ id: z.string().min(1) }),
      failures: ['CONFLICT'],
      response: keyItem.extend({
        secret: z.string(),
        replaced: z.object({
          id: z.string(),
          mask: z.string(),
          revokedAt: z.date(),
        }),
        /** Прокручен ключ, которым сделан этот вызов: дальше нужен новый секрет. */
        self: z.boolean(),
        warning: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const key = await prisma.apiKey.findFirst({ where: { id: input.params.id, sandboxId: ctx.sandbox.id } })
      if (!key) return notFound(reply, 'Ключ не найден')
      if (key.status === 'revoked') {
        return conflict(reply, `Ключ отозван ${key.revokedAt?.toISOString() ?? ''} и прокрутке не подлежит. Выпустите новый через POST /api/v1/keys`)
      }

      // Ротация возвращает РАБОЧИЙ секрет чужого ключа. Без этой проверки ключ
      // с одним keys:write прокручивал бы ключ с полным доступом и получал его
      // права на руки — обход проверки, которая стоит при выпуске.
      if (key.kind === 'server') {
        const missing = scopesBeyond(ctx, key.scopes)
        if (missing.length > 0) {
          return forbidden(
            reply,
            `Ключ «${key.name}» шире вызывающего: ${listScopes(missing)}. Ротация выдаёт рабочий секрет, поэтому прокрутить можно только ключ не шире собственных прав`,
          )
        }
      }

      const self = ctx.apiKeyId === key.id
      const generated = generateKey(key.kind)
      const [revoked, created] = await prisma.$transaction([
        prisma.apiKey.update({
          where: { id: key.id },
          data: { status: 'revoked', revokedAt: new Date(), revokedBy: 'ротация' },
        }),
        prisma.apiKey.create({
          data: {
            sandboxId: key.sandboxId,
            name: key.name,
            subtitle: key.subtitle,
            kind: key.kind,
            prefix: generated.prefix,
            suffix: generated.suffix,
            keyHash: generated.hash,
            services: key.services,
            rotationDays: key.rotationDays,
            // Кабинет области не переносит, и прокрученный ограниченный ключ
            // получал там полный доступ. Здесь наследуются ровно те же права.
            scopes: key.scopes,
          },
        }),
      ])
      // Иначе старый секрет живёт в кеше разбора ещё до 30 секунд после отзыва.
      invalidateKeyCache()

      return {
        ...keyResource(created, ctx),
        secret: generated.full,
        replaced: {
          id: revoked.id,
          mask: maskOf(revoked.prefix, revoked.suffix),
          revokedAt: revoked.revokedAt ?? new Date(),
        },
        self,
        warning: self
          ? 'Прокручен ключ, которым сделан этот вызов: следующий запрос со старым секретом получит 401. Подставьте secret из этого ответа'
          : 'Сохраните secret: полностью ключ показывается только сейчас. Старый секрет уже не работает',
      }
    },
  )

  // ─────────────────────────── Отзыв ───────────────────────────

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/keys/:id/revoke',
      scope: 'keys:write',
      summary: 'Отозвать ключ',
      description:
        'Ключ перестаёт работать сразу и навсегда: обратной операции нет, статус active уже не вернуть. ' +
        'Запись при этом остаётся — она видна в списке со статусом revoked, датой и именем отозвавшего, ' +
        'а записи журнала запросов сохраняют ссылку на неё. Насовсем стирает ключ только DELETE /keys/{id}.\n\n' +
        'Подтверждение обязательно: confirmName должен точно совпасть с названием ключа — так же, как в кабинете. ' +
        'Отозвать ключ, которым сделан вызов, можно; в ответе это помечено полем self, и следующий запрос с ним получит 401.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        /** Название отзываемого ключа — защита от перепутанного идентификатора. */
        confirmName: z.string().min(1, 'Подтвердите отзыв названием ключа'),
      }),
      failures: ['CONFLICT'],
      response: z.object({
        id: z.string(),
        name: z.string(),
        status: keyStatus,
        revokedAt: z.date(),
        revokedBy: z.string().nullable(),
        self: z.boolean(),
        message: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const key = await prisma.apiKey.findFirst({ where: { id: input.params.id, sandboxId: ctx.sandbox.id } })
      if (!key) return notFound(reply, 'Ключ не найден')
      if (key.status === 'revoked') return conflict(reply, `Ключ «${key.name}» уже отозван`)

      if (input.body.confirmName !== key.name) {
        return sendError(
          reply,
          400,
          'CONFIRM_MISMATCH',
          `Для отзыва передайте confirmName ровно как называется ключ: «${key.name}»`,
        )
      }

      const self = ctx.apiKeyId === key.id
      const updated = await prisma.apiKey.update({
        where: { id: key.id },
        data: { status: 'revoked', revokedAt: new Date(), revokedBy: actorOf(ctx) },
      })
      // Без сброса кеша отзыв «подвисает» на время TTL, и ключ работает после отзыва.
      invalidateKeyCache()

      return {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        revokedAt: updated.revokedAt ?? new Date(),
        revokedBy: updated.revokedBy,
        self,
        message: self
          ? 'Отозван ключ, которым сделан этот вызов: следующий запрос с ним получит 401'
          : 'Ключ отозван, запросы с ним больше не проходят. Запись осталась в списке и в журнале',
      }
    },
  )

  // ─────────────────────────── Удаление ───────────────────────────

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/keys/:id',
      scope: 'keys:write',
      summary: 'Удалить ключ вместе с историей',
      description:
        'Отличие от отзыва: отозванный ключ остаётся записью — он виден в списке, в журнале запросов, ' +
        'и по нему всегда можно ответить, кто и когда им ходил. Удаление стирает саму запись: ' +
        'ключ пропадает из списка, записи журнала теряют привязку к нему (сами записи остаются, но поле apiKeyId обнуляется), ' +
        'а сессии туннеля, выпущенные под этот ключ, удаляются каскадом.\n\n' +
        'Работать ключ перестаёт в обоих случаях. Удаляйте, когда мешает мусор, отзывайте, когда важен след. ' +
        'Подтверждение обязательно: в теле запроса confirmName должен точно совпасть с названием ключа. ' +
        'Удалить ключ, которым сделан вызов, можно; в ответе это помечено полем self.',
      tags: ['Ключи доступа'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        /**
         * В теле, а не в строке запроса: во всём Management API необратимое действие
         * подтверждается полем confirmName в теле (отзыв ключа, удаление песочницы,
         * удаление приложения). Название ключа бывает с пробелами и по-русски — в URL
         * его пришлось бы кодировать вручную, и ошибка кодирования выглядела бы
         * как несовпадение подтверждения.
         */
        confirmName: z.string().min(1, 'Подтвердите удаление названием ключа'),
      }),
      response: z.object({
        id: z.string(),
        name: z.string(),
        ok: z.literal(true),
        /** Записи журнала не удаляются — у них обнуляется ссылка на ключ. */
        logsDetached: z.number().int(),
        tunnelSessionsRemoved: z.number().int(),
        self: z.boolean(),
        message: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const key = await prisma.apiKey.findFirst({ where: { id: input.params.id, sandboxId: ctx.sandbox.id } })
      if (!key) return notFound(reply, 'Ключ не найден')

      if (input.body.confirmName !== key.name) {
        return sendError(
          reply,
          400,
          'CONFIRM_MISMATCH',
          `Для удаления передайте confirmName ровно как называется ключ: «${key.name}»`,
        )
      }

      // Считаем ДО удаления: после него связь с журналом уже разорвана,
      // и сводка «что именно исчезло» стала бы недостижима.
      const [logsDetached, tunnelSessionsRemoved] = await Promise.all([
        prisma.requestLog.count({ where: { apiKeyId: key.id } }),
        prisma.tunnelSession.count({ where: { apiKeyId: key.id } }),
      ])

      const self = ctx.apiKeyId === key.id

      // Счётчики использования копятся в памяти и уходят в базу пачкой раз в
      // 10 секунд ОДНОЙ транзакцией. Если в буфере осталась строка удаляемого
      // ключа, транзакция упадёт целиком и утащит с собой счётчики всех
      // остальных ключей. При удалении своего ключа строка там есть всегда:
      // её записал этот же запрос. Поэтому сбрасываем буфер, пока ключ жив.
      await flushKeyUsage()

      await prisma.apiKey.delete({ where: { id: key.id } })
      invalidateKeyCache()

      return {
        id: key.id,
        name: key.name,
        ok: true as const,
        logsDetached,
        tunnelSessionsRemoved,
        self,
        message: self
          ? 'Удалён ключ, которым сделан этот вызов: следующий запрос с ним получит 401'
          : 'Ключ удалён вместе с записью. Восстановить его нельзя, для этого пришлось бы знать секрет',
      }
    },
  )
}
