import type { FastifyInstance } from 'fastify'
import type { User } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../db.ts'
import { clearSession, currentSessionHash } from '../../lib/auth.ts'
import { hashPassword, verifyPassword } from '../../lib/keys.ts'
import { invalidateKeyCache } from '../../lib/api-key.ts'
import { sendError } from '../../lib/mgmt.ts'
import { flushKeyUsage } from '../../lib/key-usage.ts'
import { liveBursts, stopBurst } from '../../webhooks/burst.ts'
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
} from './_registry.ts'

/**
 * Аккаунт и сессии кабинета.
 *
 * Единственный домен, где два способа входа отличаются не только удобством.
 * У серверного ключа текущей сессии нет, поэтому смена пароля из скрипта гасит
 * вообще все сессии, а из браузера — все, кроме своей. По той же причине удаление
 * аккаунта из браузера дополнительно спрашивает пароль: cookie остаётся живой
 * в оставленном без присмотра браузере, тогда как серверный ключ сам по себе —
 * секрет уровня всего аккаунта, и требовать к нему ещё и пароль значит просто
 * заставить скрипт хранить пароль рядом с ключом.
 */

/** Те же правила, что при регистрации (routes/auth.ts): «Игорь Герасимов» → «ИГ». */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'AP'
}

/**
 * Короткая подпись сессии: «Chrome на macOS».
 *
 * Полный User-Agent отдаётся рядом, поэтому здесь важна узнаваемость, а не точность:
 * человек ищет в списке свой ноутбук, а не версию движка. Разбираем без библиотеки
 * и без амбиций — строка User-Agent врёт по традиции жанра. Неизвестное остаётся
 * null, а не превращается в «Другое устройство»: выдуманная подпись хуже пустой.
 */
function deviceLabel(userAgent: string | null): string | null {
  if (!userAgent) return null
  // Порядок проверок важен: Edge и Яндекс представляются ещё и Chrome, Chrome — Safari.
  const browser = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bYaBrowser\//.test(userAgent)
      ? 'Яндекс.Браузер'
      : /\bOPR\//.test(userAgent)
        ? 'Opera'
        : /\bFirefox\//.test(userAgent)
          ? 'Firefox'
          : /\bChrome\//.test(userAgent)
            ? 'Chrome'
            : /\bSafari\//.test(userAgent)
              ? 'Safari'
              : /\b(curl|wget|python-requests|node-fetch|axios)\b/i.test(userAgent)
                ? 'скрипт'
                : null

  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null

  if (browser && os) return `${browser} на ${os}`
  return browser ?? os
}

const accountProfile = z.object({
  id: z.string(),
  login: z.string(),
  /** Необязательная почта для связи: вход по ней не идёт. */
  email: z.string().nullable(),
  name: z.string(),
  /** Две буквы для аватара в сайдбаре. */
  initials: z.string(),
  /** Подпись тарифа. Меняется не пользователем, поэтому только на чтение. */
  planLabel: z.string(),
  createdAt: z.date(),
  sandboxCount: z.number().int(),
})

async function profileOf(user: User) {
  return {
    id: user.id,
    login: user.login,
    email: user.email,
    name: user.name,
    initials: user.initials,
    planLabel: user.planLabel,
    createdAt: user.createdAt,
    sandboxCount: await prisma.sandbox.count({ where: { userId: user.id } }),
  }
}

const sessionItem = z.object({
  id: z.string(),
  /** «Chrome на macOS» либо null, если User-Agent не разобрался. */
  device: z.string().nullable(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.date(),
  expiresAt: z.date(),
  /** true — этим запросом пришла именно эта сессия. По ключу таких нет. */
  current: z.boolean(),
})

export function registerAccountV1Routes(app: FastifyInstance): void {
  defineRoute(
    app,
    {
      method: 'GET',
      path: '/account',
      scope: 'account:read',
      summary: 'Профиль аккаунта',
      description:
        'Владелец ключа или сессии, которой пришёл запрос. Блок access отвечает на вопросы, ' +
        'без которых скрипт не может начать работу: чем он аутентифицирован, какие области доступа ' +
        'ему выданы (пустой список означает полный доступ) и какая песочница подставится там, ' +
        'где sandboxId не указан явно.',
      tags: ['Аккаунт'],
      response: accountProfile.extend({
        access: z.object({
          via: z.enum(['key', 'session']),
          apiKeyId: z.string().nullable(),
          scopes: z.array(z.string()),
          defaultSandboxId: z.string().nullable(),
        }),
      }),
    },
    async (ctx) => ({
      ...(await profileOf(ctx.user)),
      access: {
        via: ctx.via,
        apiKeyId: ctx.apiKeyId,
        scopes: ctx.scopes,
        defaultSandboxId: ctx.defaultSandboxId,
      },
    }),
  )

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/account',
      scope: 'account:write',
      summary: 'Изменить профиль',
      description:
        'Имя, инициалы и почту можно менять без подтверждения: почта — способ связи, вход по ней ' +
        'не идёт. Смена ЛОГИНА требует текущего пароля: логин — это вход, и подменивший его ' +
        'получает аккаунт целиком. Тот же логин, что уже стоит у аккаунта, сменой не считается. ' +
        'Сессии и ключи после смены логина продолжают работать: он не участвует в проверке ' +
        'ни того, ни другого.',
      tags: ['Аккаунт'],
      body: z.object({
        name: z.string().trim().min(2, 'Имя не короче 2 символов').max(80).optional(),
        initials: z.string().trim().min(1, 'Инициалы не могут быть пустыми').max(3).optional(),
        login: z
          .string()
          .min(3, 'Логин не короче 3 символов')
          .max(40, 'Логин не длиннее 40 символов')
          .regex(
            /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
            'Логин: латиница, цифры, точка, дефис и подчёркивание',
          )
          .optional(),
        /** null стирает почту: способ связи можно и убрать. */
        email: z.email('Введите корректный адрес почты').max(200).nullable().optional(),
        currentPassword: z.string().min(1).max(200).optional(),
      }),
      failures: ['CONFLICT'],
      response: accountProfile,
    },
    async (ctx, input, _req, reply) => {
      const { name, initials, currentPassword } = input.body
      if (
        name === undefined &&
        initials === undefined &&
        input.body.email === undefined &&
        input.body.login === undefined
      ) {
        return badRequest(reply, 'Нечего менять: укажите хотя бы одно из полей name, initials, login, email')
      }

      // И логин, и почта хранятся в нижнем регистре — так же, как их кладёт
      // регистрация: иначе «Ivan» и «ivan» стали бы разными аккаунтами.
      const login = input.body.login?.toLowerCase()
      const changesLogin = login !== undefined && login !== ctx.user.login
      const email = input.body.email === null ? null : input.body.email?.toLowerCase()
      const changesEmail = email !== undefined && email !== ctx.user.email

      if (changesLogin) {
        if (!currentPassword) {
          return badRequest(reply, 'Смена логина требует поля currentPassword: логин — это вход в аккаунт')
        }
        if (!(await verifyPassword(ctx.user.passwordHash, currentPassword))) {
          return forbidden(reply, 'Текущий пароль указан неверно')
        }
        const taken = await prisma.user.findUnique({ where: { login }, select: { id: true } })
        if (taken) return conflict(reply, `Логин «${login}» уже занят`)
      }

      if (changesEmail && email !== null) {
        const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } })
        if (taken) return conflict(reply, `Почта ${email} уже указана в другом аккаунте`)
      }

      /**
       * Инициалы пересчитываем только у того, кто их не правил руками: при регистрации
       * они выведены из имени, и после переименования «ИГ» у Петра Петрова — мусор.
       * А выставленные вручную (например, «AP» у компании) переименование затирать
       * не должно, поэтому сравниваем с тем, что дало бы старое имя.
       */
      const nextInitials =
        initials ??
        (name !== undefined && initialsOf(ctx.user.name) === ctx.user.initials ? initialsOf(name) : undefined)

      const user = await prisma.user.update({
        where: { id: ctx.userId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(nextInitials !== undefined ? { initials: nextInitials } : {}),
          ...(changesLogin ? { login } : {}),
          ...(changesEmail ? { email } : {}),
        },
      })

      return profileOf(user)
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/account/password',
      scope: 'account:write',
      summary: 'Сменить пароль',
      description:
        'Требует текущего пароля: одной украденной cookie или одного ключа не должно хватать, ' +
        'чтобы отобрать аккаунт. После смены все остальные сессии кабинета гаснут — именно ' +
        'ради этого пароль обычно и меняют. Своя сессия сохраняется, но по серверному ключу ' +
        'своей сессии нет, и тогда гаснут все: в ответе это видно по currentSessionKept. ' +
        'Ключи доступа смена пароля не трогает — это отдельные секреты, они отзываются через /keys.',
      tags: ['Аккаунт'],
      body: z.object({
        currentPassword: z.string().min(1, 'Укажите текущий пароль').max(200),
        newPassword: z.string().min(8, 'Пароль не короче 8 символов').max(200),
      }),
      response: z.object({
        ok: z.literal(true),
        sessionsRevoked: z.number().int(),
        currentSessionKept: z.boolean(),
      }),
    },
    async (ctx, input, req, reply) => {
      if (!(await verifyPassword(ctx.user.passwordHash, input.body.currentPassword))) {
        return forbidden(reply, 'Текущий пароль указан неверно')
      }
      if (input.body.newPassword === input.body.currentPassword) {
        return badRequest(reply, 'Новый пароль совпадает с текущим')
      }

      await prisma.user.update({
        where: { id: ctx.userId },
        data: { passwordHash: await hashPassword(input.body.newPassword) },
      })

      const keep = await currentSessionHash(req)
      const { count } = await prisma.authSession.deleteMany({
        where: { userId: ctx.userId, ...(keep ? { tokenHash: { not: keep } } : {}) },
      })

      return { ok: true as const, sessionsRevoked: count, currentSessionKept: keep !== null }
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/account/sessions',
      scope: 'account:read',
      summary: 'Активные сессии кабинета',
      description:
        'Входы в кабинет, свежие сверху. Просроченные не показываются: они уже не работают, ' +
        'и в списке «где я залогинен» им не место. Это сессии браузера — ключи доступа сюда ' +
        'не попадают, их список отдаёт /keys. Флаг current стоит у сессии, которой пришёл ' +
        'этот запрос; при входе по серверному ключу он не стоит ни у одной.',
      tags: ['Аккаунт'],
      query: pageQuery,
      response: pageResponse(sessionItem),
    },
    async (ctx, input, req, reply) => {
      const current = await currentSessionHash(req)
      const rows = await prisma.authSession.findMany({
        where: { userId: ctx.userId, expiresAt: { gt: new Date() } },
        // Второй ключ сортировки нужен курсору: при совпавшем времени порядок
        // иначе не определён, и страница теряет или повторяет запись.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(input.query),
      })

      return pageChecked(reply, rows, input.query, (s) => ({
        id: s.id,
        device: deviceLabel(s.userAgent),
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        current: current !== null && s.tokenHash === current,
      }))
    },
  )

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/account/sessions/:id',
      scope: 'account:write',
      summary: 'Погасить сессию',
      description:
        'Сессия перестаёт работать сразу: токен проверяется по записи в базе, а не только ' +
        'по подписи. Погасить можно и текущую — это выход из кабинета, cookie в ответе очищается, ' +
        'и следующий запрос по ней получит 401. Идентификатор берётся из GET /account/sessions; ' +
        'чужой или уже погашенный даёт 404.',
      tags: ['Аккаунт'],
      params: z.object({ id: z.string().min(1) }),
      response: z.object({
        ok: z.literal(true),
        id: z.string(),
        /** true — погашена та сессия, которой пришёл запрос. */
        wasCurrent: z.boolean(),
      }),
    },
    async (ctx, input, req, reply) => {
      const current = await currentSessionHash(req)
      // Фильтр по userId прямо в выборке: без него чужой идентификатор отвечал бы
      // не 404, а чем-то другим, и по разнице ответов сессии перебирались бы.
      const session = await prisma.authSession.findFirst({
        where: { id: input.params.id, userId: ctx.userId },
        select: { id: true, tokenHash: true },
      })
      if (!session) return notFound(reply, 'Сессия не найдена')

      await prisma.authSession.delete({ where: { id: session.id } })

      const wasCurrent = current !== null && session.tokenHash === current
      // Оставленная cookie после гашения своей же сессии — это 401 на каждый
      // следующий запрос браузера вместо честного «вы вышли».
      if (wasCurrent) clearSession(reply)

      return { ok: true as const, id: session.id, wasCurrent }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/account/sessions/revoke-all',
      scope: 'account:write',
      summary: 'Погасить все сессии, кроме текущей',
      description:
        'Аварийная кнопка на случай украденного ноутбука: все входы в кабинет становятся ' +
        'недействительны немедленно. Своя сессия остаётся, чтобы не выкидывать из кабинета того, ' +
        'кто нажал кнопку. По серверному ключу своей сессии нет — тогда гаснут все, включая ' +
        'браузер владельца. Пароль при этом не меняется: если он скомпрометирован, начинать ' +
        'надо с POST /account/password, который гасит сессии сам.',
      tags: ['Аккаунт'],
      response: z.object({
        ok: z.literal(true),
        revoked: z.number().int(),
        currentSessionKept: z.boolean(),
      }),
    },
    async (ctx, _input, req) => {
      const keep = await currentSessionHash(req)
      const { count } = await prisma.authSession.deleteMany({
        where: { userId: ctx.userId, ...(keep ? { tokenHash: { not: keep } } : {}) },
      })

      return { ok: true as const, revoked: count, currentSessionKept: keep !== null }
    },
  )

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/account',
      scope: 'account:write',
      summary: 'Удалить аккаунт',
      description:
        'НЕОБРАТИМО. Вместе с аккаунтом каскадом уходят все песочницы, а с ними ключи, журнал ' +
        'запросов, вебхуки и их доставки, сценарии, серии событий, свои моки, локальные приложения ' +
        'Bitrix24 и изменения поверх демо-данных. Восстановления нет: копии данных мы не храним, ' +
        'а тот же адрес почты после удаления можно зарегистрировать заново — это будет пустой аккаунт.\n\n' +
        'Поэтому нужно подтверждение: в поле login присылается точный логин удаляемого аккаунта. ' +
        'При входе по cookie-сессии дополнительно требуется пароль — оставленный без присмотра ' +
        'браузер не должен уметь стереть аккаунт одним запросом. По серверному ключу пароль ' +
        'не нужен: сам ключ уже даёт полный доступ к аккаунту.\n\n' +
        'Ответ — сводка удалённого: что именно и в каком количестве исчезло.',
      tags: ['Аккаунт'],
      body: z.object({
        /** Точный адрес аккаунта. Регистр не важен, опечатка — важна. */
        login: z.string().min(1, 'Подтвердите удаление: пришлите точный логин аккаунта').max(200),
        password: z.string().min(1).max(200).optional(),
      }),
      response: z.object({
        ok: z.literal(true),
        deletedAt: z.date(),
        account: z.object({ id: z.string(), login: z.string() }),
        removed: z.object({
          sandboxes: z.number().int(),
          apiKeys: z.number().int(),
          requestLogs: z.number().int(),
          webhooks: z.number().int(),
          webhookDeliveries: z.number().int(),
          scenarios: z.number().int(),
          eventBursts: z.number().int(),
          customMocks: z.number().int(),
          sandboxOverlays: z.number().int(),
          b24Apps: z.number().int(),
          sessions: z.number().int(),
        }),
        /** Серии, которые шли прямо сейчас и были остановлены перед удалением. */
        stoppedBursts: z.number().int(),
      }),
    },
    async (ctx, input, _req, reply) => {
      if (input.body.login.trim().toLowerCase() !== ctx.user.login) {
        // Тот же код, что у удаления ключа, песочницы и приложения: несовпавшее
        // подтверждение — это не ошибка формата запроса, и отличать её от опечатки
        // в теле клиент должен по коду, а не по тексту.
        return sendError(
          reply,
          400,
          'CONFIRM_MISMATCH',
          `Подтверждение не совпало: в поле login нужен точный логин удаляемого аккаунта (${ctx.user.login})`,
        )
      }
      if (ctx.via === 'session' && !input.body.password) {
        return badRequest(reply, 'Удаление из браузера требует поля password: подтвердите, что аккаунт ваш')
      }
      if (input.body.password && !(await verifyPassword(ctx.user.passwordHash, input.body.password))) {
        return forbidden(reply, 'Пароль указан неверно')
      }

      const sandboxes = await prisma.sandbox.findMany({ where: { userId: ctx.userId }, select: { id: true } })
      const ids = sandboxes.map((s) => s.id)
      const of = { sandboxId: { in: ids } }

      /**
       * Серии событий живут в памяти процесса и шлют запросы наружу. Каскад в базе
       * их не остановит: движок продолжит стучаться по адресу удалённого вебхука,
       * пока не отсчитает своё, — а это трафик на чужой сервер от несуществующего
       * уже аккаунта. Останавливаем до удаления.
       */
      let stoppedBursts = 0
      for (const id of ids) {
        for (const burst of liveBursts(id)) if (stopBurst(burst.id)) stoppedBursts += 1
      }

      // Считаем до удаления: после каскада считать уже нечего, а сводка —
      // единственное, что останется у человека от аккаунта.
      const [apiKeys, requestLogs, webhooks, webhookDeliveries, scenarios, eventBursts, customMocks, sandboxOverlays, b24Apps, sessions] =
        await Promise.all([
          prisma.apiKey.count({ where: of }),
          prisma.requestLog.count({ where: of }),
          prisma.webhook.count({ where: of }),
          prisma.webhookDelivery.count({ where: of }),
          prisma.scenario.count({ where: of }),
          prisma.eventBurst.count({ where: of }),
          prisma.customMock.count({ where: of }),
          prisma.sandboxOverlay.count({ where: of }),
          prisma.b24App.count({ where: of }),
          prisma.authSession.count({ where: { userId: ctx.userId } }),
        ])

      // Буфер счётчиков ключей пишется в базу одной транзакцией, и строка ключа,
      // уехавшего каскадом, уронила бы её целиком — вместе со счётчиками чужих
      // ключей за то же окно. При удалении по ключу такая строка в буфере есть
      // всегда: её записал этот же запрос. Сбрасываем, пока ключи ещё живы.
      await flushKeyUsage()

      await prisma.user.delete({ where: { id: ctx.userId } })

      // Разбор ключей кеширован на 30 секунд. Без сброса удалённые ключи ещё
      // полминуты открывали бы мок-шлюз песочницы, которой уже нет.
      invalidateKeyCache()
      if (ctx.via === 'session') clearSession(reply)

      return {
        ok: true as const,
        deletedAt: new Date(),
        account: { id: ctx.user.id, login: ctx.user.login },
        removed: {
          sandboxes: ids.length,
          apiKeys,
          requestLogs,
          webhooks,
          webhookDeliveries,
          scenarios,
          eventBursts,
          customMocks,
          sandboxOverlays,
          b24Apps,
          sessions,
        },
        stoppedBursts,
      }
    },
  )
}
