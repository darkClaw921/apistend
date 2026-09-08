import type { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  B24_APP_KINDS, B24_APP_STATUS_LOCAL, B24_LIFECYCLE_EVENTS, B24_OAUTH_ERRORS,
  B24_PLACEMENTS, B24_REFRESH_TTL_MAX_SECONDS, B24_REFRESH_TTL_MIN_SECONDS, B24_SCOPES,
  B24_TOKEN_TTL_MAX_SECONDS, B24_TOKEN_TTL_MIN_SECONDS, findB24Placement, isB24Scope,
} from '@apistend/shared'
import { prisma } from '../db.ts'
import { requireSandbox } from '../lib/guard.ts'
import { dispatchWebhook } from '../webhooks/dispatcher.ts'
import { BX24_JS_SOURCE, bx24JsEtag } from '../b24/bx24-js.ts'
import {
  bx24JsUrl, clientEndpoint, generateClientId, generateClientSecret, generateHexToken,
  memberIdFor, portalDeals, portalDomain, portalProtocol, portalUser, portalUserName,
  PORTAL_USERS, serverEndpoint,
} from '../b24/portal.ts'
import {
  consumeAuthCode, expireAppTokens, issueAuthCode, issueTokenPair, refreshTokenPair,
  revokeAppTokens, secondsLeft, tokenResponse,
} from '../b24/tokens.ts'

/**
 * Локальные приложения Bitrix24: кабинет, сервер авторизации и библиотека.
 *
 * Три группы маршрутов с разной авторизацией, и смешивать их нельзя:
 *   /api/b24/…   — кабинет, сессионная cookie;
 *   /oauth/…     — сервер авторизации, авторизация по client_secret;
 *   /api/v1/     — библиотека BX24.js, без авторизации вообще (её грузит браузер
 *                  из чужого фрейма, и никакой cookie туда не приедет).
 */

const createApp = z.object({
  title: z.string().min(1, 'Укажите название приложения').max(120),
  code: z.string().regex(/^[a-z0-9._-]{2,60}$/i, 'Код — латиница, цифры, точка, дефис').optional(),
  kind: z.enum(B24_APP_KINDS).default('server_ui'),
  scope: z.array(z.string()).min(1, 'Выберите хотя бы одно право'),
  handlerUrl: z.string().url('Путь обработчика должен быть адресом').nullish(),
  installUrl: z.string().url('Путь установки должен быть адресом').nullish(),
  menuTitle: z.string().max(120).nullish(),
  // Боевой портал срока не настраивает — он всегда час. Настройка нужна, чтобы
  // дождаться expired_token и увидеть, как приложение восстанавливает доступ.
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
 * Правка приложения: тот же набор полей, но без значения по умолчанию у kind.
 *
 * partial() снимает обязательность, а default() — нет. Из-за этого правка
 * одного только названия переводила приложение обратно в вид server_ui,
 * даже если оно было api_only.
 */
const updateApp = createApp.partial().extend({
  kind: z.enum(B24_APP_KINDS).optional(),
})

const openApp = z.object({
  placement: z.string().default('DEFAULT'),
  placementOptions: z.record(z.string(), z.unknown()).default({}),
  install: z.boolean().optional(),
  portalUserId: z.number().int().optional(),
})

export function registerB24AppRoutes(app: FastifyInstance): void {
  // ─────────────────────────── Кабинет ───────────────────────────

  app.get('/api/b24/apps', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const apps = await prisma.b24App.findMany({
      where: { sandboxId: ctx.sandbox.id },
      orderBy: { createdAt: 'desc' },
      include: appCounts,
    })

    return reply.send({
      apps: apps.map(toItem),
      portal: portalInfo(ctx.sandbox.id),
      scopes: B24_SCOPES.map((s) => ({ code: s.code, title: s.title })),
      placements: placementOptions(),
    })
  })

  app.post('/api/b24/apps', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = createApp.safeParse(req.body)
    if (!parsed.success) return validationError(reply, parsed.error.issues)

    const invalid = parsed.data.scope.filter((s) => !isB24Scope(s))
    if (invalid.length > 0) {
      return reply.code(400).send({ error: 'VALIDATION', issues: [`Неизвестные права: ${invalid.join(', ')}`] })
    }
    if (parsed.data.kind === 'server_ui' && !parsed.data.handlerUrl) {
      return reply.code(400).send({ error: 'VALIDATION', issues: ['Для приложения с интерфейсом нужен путь обработчика'] })
    }
    if (parsed.data.kind === 'api_only' && !parsed.data.installUrl) {
      return reply.code(400).send({ error: 'VALIDATION', issues: ['Для приложения без интерфейса нужен путь установки'] })
    }

    const code = (parsed.data.code ?? slugify(parsed.data.title)).toLowerCase()
    const clash = await prisma.b24App.findFirst({ where: { sandboxId: ctx.sandbox.id, code } })
    if (clash) {
      return reply.code(409).send({ error: 'CODE_TAKEN', message: `Приложение с кодом «${code}» уже есть` })
    }

    const created = await prisma.b24App.create({
      data: {
        sandboxId: ctx.sandbox.id,
        title: parsed.data.title,
        code,
        kind: parsed.data.kind,
        scope: parsed.data.scope,
        handlerUrl: parsed.data.handlerUrl ?? null,
        installUrl: parsed.data.installUrl ?? null,
        menuTitle: parsed.data.menuTitle ?? null,
        tokenTtlSeconds: parsed.data.tokenTtlSeconds ?? undefined,
        refreshTtlSeconds: parsed.data.refreshTtlSeconds ?? undefined,
        clientId: generateClientId(),
        clientSecret: generateClientSecret(),
        applicationToken: generateHexToken(),
      },
      include: appDetail,
    })

    return reply.code(201).send({ app: toDetail(created) })
  })

  app.get<{ Params: { id: string } }>('/api/b24/apps/:id', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({
      where: { id: req.params.id, sandboxId: ctx.sandbox.id },
      include: appDetail,
    })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    return reply.send({
      app: toDetail(found),
      portal: portalInfo(ctx.sandbox.id),
      scopes: B24_SCOPES.map((s) => ({ code: s.code, title: s.title })),
      placements: placementOptions(),
    })
  })

  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/update', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const existing = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    const parsed = updateApp.safeParse(req.body)
    if (!parsed.success) return validationError(reply, parsed.error.issues)

    const scope = parsed.data.scope
    if (scope) {
      const invalid = scope.filter((s) => !isB24Scope(s))
      if (invalid.length > 0) {
        return reply.code(400).send({ error: 'VALIDATION', issues: [`Неизвестные права: ${invalid.join(', ')}`] })
      }
    }

    const updated = await prisma.b24App.update({
      where: { id: existing.id },
      data: {
        title: parsed.data.title ?? undefined,
        kind: parsed.data.kind ?? undefined,
        scope: scope ?? undefined,
        handlerUrl: parsed.data.handlerUrl === undefined ? undefined : parsed.data.handlerUrl,
        installUrl: parsed.data.installUrl === undefined ? undefined : parsed.data.installUrl,
        menuTitle: parsed.data.menuTitle === undefined ? undefined : parsed.data.menuTitle,
        tokenTtlSeconds: parsed.data.tokenTtlSeconds,
        refreshTtlSeconds: parsed.data.refreshTtlSeconds,
        // Смена прав или адресов — это новая версия приложения. Боевой портал
        // тоже поднимает VERSION, и приложение по нему понимает, что настройки
        // изменились и стоит перечитать своё окружение.
        version: { increment: 1 },
      },
      include: appDetail,
    })

    return reply.send({ app: toDetail(updated) })
  })

  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/delete', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const existing = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    const notified = await notifyUninstall(existing)
    await revokeAppTokens(existing.id)
    // Подписки снимаются вместе с приложением — так делает и боевой портал.
    // Доставки жизненного цикла остаются в журнале: ссылка на приложение
    // обнуляется, а не каскадит, иначе запись об уходе ONAPPUNINSTALL исчезала бы
    // ровно в тот момент, когда пользователь идёт её проверять.
    await prisma.webhook.deleteMany({
      where: { appId: existing.id, event: { notIn: LIFECYCLE_EVENTS } },
    })
    await prisma.b24App.delete({ where: { id: existing.id } })

    return reply.send({ ok: true, notified })
  })

  /**
   * Подготовка открытия во фрейме.
   *
   * Отдаёт то, из чего страница портала соберёт скрытую POST-форму. Собирать её
   * на сервере нельзя: фрейм грузится в браузере разработчика, и только его
   * браузер может достучаться до localhost:3000.
   */
  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/open', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({
      where: { id: req.params.id, sandboxId: ctx.sandbox.id },
      include: appDetail,
    })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    if (found.kind === 'api_only') {
      return reply.code(400).send({
        error: 'NO_INTERFACE',
        message: 'Приложение работает только через API: интерфейса, который можно открыть, у него нет',
      })
    }

    const parsed = openApp.safeParse(req.body ?? {})
    if (!parsed.success) return validationError(reply, parsed.error.issues)

    const placement = parsed.data.placement.toUpperCase()
    const definition = findB24Placement(placement)
    if (!definition) {
      return reply.code(400).send({ error: 'UNKNOWN_PLACEMENT', message: `Неизвестная точка встраивания «${placement}»` })
    }

    // Мастер установки показывается, пока приложение не завершило установку —
    // и показывается при КАЖДОМ входе, ровно как в бою.
    const showInstall = parsed.data.install ?? (found.state !== 'installed' && Boolean(found.installUrl))
    const target = showInstall ? (found.installUrl ?? found.handlerUrl) : found.handlerUrl
    if (!target) {
      return reply.code(400).send({ error: 'NO_HANDLER', message: 'У приложения не задан путь обработчика' })
    }

    const portalUserId = parsed.data.portalUserId ?? 1
    const token = await issueTokenPair(found, portalUserId)
    const appSid = generateHexToken()

    await prisma.b24AppSession.create({
      data: {
        appId: found.id,
        appSid,
        tokenId: token.id,
        placement,
        placementOptions: parsed.data.placementOptions as Prisma.InputJsonValue,
        isInstall: showInstall,
      },
    })

    const options = { ...parsed.data.placementOptions, URI: uriFor(placement, parsed.data.placementOptions) }

    // DOMAIN, PROTOCOL, LANG и APP_SID боевой портал кладёт в query-строку адреса,
    // остальное — в тело POST. Разделение не косметическое: в теле лежат токены,
    // и в адресной строке фрейма им не место.
    const url = new URL(target)
    url.searchParams.set('DOMAIN', portalDomain())
    url.searchParams.set('PROTOCOL', portalProtocol())
    url.searchParams.set('LANG', 'ru')
    url.searchParams.set('APP_SID', appSid)

    const fields: Record<string, string> = {
      AUTH_ID: token.accessToken,
      // Приложение верит этому полю и по нему решает, когда пора обновляться:
      // константа вместо настроенного срока сделала бы настройку бесполезной.
      AUTH_EXPIRES: String(secondsLeft(token)),
      REFRESH_ID: token.refreshToken,
      SERVER_ENDPOINT: serverEndpoint(),
      APPLICATION_TOKEN: found.applicationToken,
      APPLICATION_SCOPE: found.scope.join(','),
      member_id: memberIdFor(ctx.sandbox.id),
      status: B24_APP_STATUS_LOCAL,
      PLACEMENT: placement,
      PLACEMENT_OPTIONS: JSON.stringify(options),
    }

    return reply.send({
      appSid,
      action: url.toString(),
      install: showInstall,
      fields,
      app: toItem({ ...found, _count: countsOf(found) }),
    })
  })

  /**
   * BX24.installFinish().
   *
   * До него приложение установленным не считается: app.info отвечает INSTALLED: false,
   * события не доставляются, виджеты не показываются. После — портал асинхронно шлёт
   * ONAPPINSTALL на обработчик, и это тоже часть боевого поведения.
   */
  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/install-finish', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    const appSid = (req.body as { appSid?: string } | undefined)?.appSid
    if (appSid) {
      await prisma.b24AppSession.updateMany({
        where: { appId: found.id, appSid, finishedAt: null },
        data: { finishedAt: new Date() },
      })
    }

    const alreadyInstalled = found.state === 'installed'
    const updated = await prisma.b24App.update({
      where: { id: found.id },
      data: { state: 'installed', installedAt: found.installedAt ?? new Date(), lastInstallNote: null },
      include: appDetail,
    })

    // Повторный installFinish события не порождает: боевой портал шлёт ONAPPINSTALL
    // однократно, после первой успешной установки.
    const notified = alreadyInstalled ? null : await notifyInstall(updated)

    return reply.send({ app: toDetail(updated), notified })
  })

  /** Установка приложения без интерфейса: серверный POST с ONAPPINSTALL. */
  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/install', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })
    if (!found.installUrl && !found.handlerUrl) {
      return reply.code(400).send({ error: 'NO_HANDLER', message: 'У приложения не задан адрес установки' })
    }

    const updated = await prisma.b24App.update({
      where: { id: found.id },
      // Приложение без интерфейса завершает установку само фактом доставки события:
      // installFinish вызвать неоткуда — браузера в этом сценарии нет.
      data: { state: 'installed', installedAt: found.installedAt ?? new Date() },
      include: appDetail,
    })
    const notified = await notifyInstall(updated)

    return reply.send({ app: toDetail(updated), notified })
  })

  /** Сброс установки: приложение снова показывает мастер, как после переустановки. */
  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/reinstall', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    await revokeAppTokens(found.id)
    // Виджеты и подписки снимаются вместе с установкой: боевой портал делает
    // ровно это, и приложение обязано зарегистрировать их заново.
    await prisma.b24AppPlacement.deleteMany({ where: { appId: found.id } })
    await prisma.webhook.deleteMany({
      where: { appId: found.id, event: { notIn: LIFECYCLE_EVENTS } },
    })

    const updated = await prisma.b24App.update({
      where: { id: found.id },
      data: { state: 'awaiting_install', installedAt: null, lastInstallNote: null },
      include: appDetail,
    })
    return reply.send({ app: toDetail(updated) })
  })

  /** Новая пара токенов: кнопка в кабинете и команда refreshAuth из библиотеки. */
  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/token', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    const body = (req.body ?? {}) as { appSid?: string; portalUserId?: number }
    const token = await issueTokenPair(found, body.portalUserId ?? 1)
    if (body.appSid) {
      await prisma.b24AppSession.updateMany({
        where: { appId: found.id, appSid: body.appSid },
        data: { tokenId: token.id },
      })
    }

    return reply.send({ token: toToken(token), auth: tokenResponse(found, token, ctx.sandbox.id) })
  })

  /**
   * Немедленное протухание всех действующих пар.
   *
   * Кнопка для проверки восстановления: даже десять секунд ждать при отладке
   * утомительно, а интересует не срок, а поведение приложения после отказа.
   */
  app.post<{ Params: { id: string } }>('/api/b24/apps/:id/expire-tokens', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return
    const found = await prisma.b24App.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Приложение не найдено' })

    const expired = await expireAppTokens(found.id)
    const refreshed = await prisma.b24App.findUniqueOrThrow({
      where: { id: found.id },
      include: appDetail,
    })
    return reply.send({ expired, app: toDetail(refreshed) })
  })

  /** Обстановка демонстрационного портала: меню, сделки, зарегистрированные виджеты. */
  app.get('/api/b24/portal', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const apps = await prisma.b24App.findMany({
      where: { sandboxId: ctx.sandbox.id, state: { not: 'uninstalled' } },
      orderBy: { createdAt: 'asc' },
      include: { placements: true, ...appCounts },
    })

    const widgets: Record<string, unknown[]> = {}
    const menu: unknown[] = []

    for (const item of apps) {
      // Пункт главного меню есть у любого приложения с интерфейсом — он открывает
      // основной адрес и виджетом не является, поэтому placement.bind его не заводит.
      if (item.kind === 'server_ui' && item.handlerUrl) {
        menu.push({
          appId: item.id,
          title: item.menuTitle ?? item.title,
          placement: 'DEFAULT',
          handler: item.handlerUrl,
        })
      }

      // Виджеты показываются только у установленного приложения. Регистрация
      // при этом сохраняется и видна в placement.get — трафика просто нет.
      if (item.state !== 'installed') continue

      for (const row of item.placements) {
        const enriched = { ...toPlacement(row), appId: item.id, appTitle: item.title }
        if (row.placement === 'LEFT_MENU') {
          menu.push({ appId: item.id, title: row.title ?? item.title, placement: 'LEFT_MENU', handler: row.handler })
          continue
        }
        ;(widgets[row.placement] ??= []).push(enriched)
      }
    }

    return reply.send({
      portal: portalInfo(ctx.sandbox.id),
      apps: apps.map(toItem),
      menu,
      deals: await portalDeals(),
      widgets,
    })
  })

  // ─────────────────── Библиотека для приложения ───────────────────

  /**
   * BX24.js.
   *
   * Боевой адрес — //api.bitrix24.tech/api/v1/, наш отличается только хостом.
   * Отдаётся без авторизации и с разрешённым CORS: скрипт грузит браузер
   * из фрейма приложения, и никакой сессии там нет.
   */
  const serveLibrary = async (req: FastifyRequest, reply: FastifyReply) => {
    const etag = `W/"${bx24JsEtag()}"`
    reply
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'public, max-age=60')
      .header('etag', etag)
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply.type('application/javascript; charset=utf-8').send(BX24_JS_SOURCE)
  }
  app.get('/api/v1/', serveLibrary)
  app.get('/api/v1', serveLibrary)

  // ───────────────────── Сервер авторизации ─────────────────────

  /**
   * Выдача авторизационного кода.
   *
   * Боевой портал берёт redirect_uri из карточки приложения и в запросе его
   * не принимает. У локального приложения такого поля в форме нет, поэтому
   * возвращаемся на путь обработчика, а явный redirect_uri принимаем как
   * послабление — иначе полный цикл OAuth негде было бы проверить.
   */
  app.get('/oauth/authorize/', authorize)
  app.get('/oauth/authorize', authorize)

  async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const query = (req.query ?? {}) as Record<string, string>
    const found = await prisma.b24App.findUnique({ where: { clientId: query.client_id ?? '' } })
    if (!found || found.state === 'uninstalled') {
      return reply.code(400).send(B24_OAUTH_ERRORS.invalidClient)
    }

    const redirect = query.redirect_uri ?? found.handlerUrl
    if (!redirect) {
      return reply.code(400).send({
        ...B24_OAUTH_ERRORS.invalidRequest,
        error_description: 'No redirect_uri configured for this application',
      })
    }

    const code = await issueAuthCode(found.id, Number(query.user_id ?? 1), query.state ?? null)
    const target = new URL(redirect)
    target.searchParams.set('code', code)
    if (query.state) target.searchParams.set('state', query.state)
    target.searchParams.set('domain', portalDomain())
    target.searchParams.set('member_id', memberIdFor(found.sandboxId))
    target.searchParams.set('scope', found.scope.join(','))
    target.searchParams.set('server_domain', portalDomain())

    return reply.redirect(target.toString(), 302)
  }

  /** Обмен кода и обновление пары. Боевой сервер принимает и GET, и POST. */
  app.get('/oauth/token/', tokenEndpoint)
  app.get('/oauth/token', tokenEndpoint)
  app.post('/oauth/token/', tokenEndpoint)
  app.post('/oauth/token', tokenEndpoint)

  async function tokenEndpoint(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const query = (req.query ?? {}) as Record<string, string>
    const body = (req.body ?? {}) as Record<string, string>
    const param = (name: string): string => String(body[name] ?? query[name] ?? '')

    reply.header('access-control-allow-origin', '*')

    const grant = param('grant_type')
    const clientId = param('client_id')
    const clientSecret = param('client_secret')

    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      return reply.code(400).send(B24_OAUTH_ERRORS.unsupportedGrantType)
    }

    const found = await prisma.b24App.findUnique({ where: { clientId } })
    if (!found || found.clientSecret !== clientSecret || found.state === 'uninstalled') {
      return reply.code(400).send(B24_OAUTH_ERRORS.invalidClient)
    }

    if (grant === 'authorization_code') {
      const claimed = await consumeAuthCode(param('code'))
      if (!claimed || claimed.app.id !== found.id) {
        return reply.code(400).send(B24_OAUTH_ERRORS.invalidGrant)
      }
      const token = await issueTokenPair(found, claimed.portalUserId)
      return reply.send(tokenResponse(found, token, found.sandboxId))
    }

    const refreshed = await refreshTokenPair(param('refresh_token'))
    if (!refreshed || refreshed.app.id !== found.id) {
      return reply.code(400).send(B24_OAUTH_ERRORS.invalidGrant)
    }
    return reply.send(tokenResponse(refreshed.app, refreshed.token, refreshed.app.sandboxId))
  }
}

// ─────────────────────────── Помощники ───────────────────────────

/** События жизненного цикла — не подписки: их никто не регистрировал. */
const LIFECYCLE_EVENTS: string[] = [...B24_LIFECYCLE_EVENTS]

const appCounts = {
  _count: {
    select: {
      placements: true,
      tokens: true,
      // Считаем подписки, а не все вебхуки приложения: ONAPPINSTALL никто
      // не регистрировал, и в счётчике «Подписки» ему не место.
      webhooks: { where: { event: { notIn: LIFECYCLE_EVENTS } } },
    },
  },
} as const
const appDetail = {
  ...appCounts,
  placements: { orderBy: { createdAt: 'asc' } },
  tokens: { orderBy: { createdAt: 'desc' }, take: 10 },
  sessions: { orderBy: { createdAt: 'desc' }, take: 12 },
  webhooks: { where: { event: { notIn: LIFECYCLE_EVENTS } }, orderBy: { createdAt: 'asc' } },
} as const

type AppRow = Record<string, unknown>

function countsOf(row: AppRow): { placements: number; tokens: number; webhooks: number } {
  const counts = row._count as { placements?: number; tokens?: number; webhooks?: number } | undefined
  return {
    placements: counts?.placements ?? (row.placements as unknown[] | undefined)?.length ?? 0,
    tokens: counts?.tokens ?? (row.tokens as unknown[] | undefined)?.length ?? 0,
    webhooks: counts?.webhooks ?? (row.webhooks as unknown[] | undefined)?.length ?? 0,
  }
}

function toItem(row: AppRow): Record<string, unknown> {
  const counts = countsOf(row)
  return {
    id: row.id,
    title: row.title,
    code: row.code,
    clientId: row.clientId,
    kind: row.kind,
    state: row.state,
    scope: row.scope,
    handlerUrl: row.handlerUrl,
    installUrl: row.installUrl,
    menuTitle: row.menuTitle,
    applicationToken: row.applicationToken,
    version: row.version,
    tokenTtlSeconds: row.tokenTtlSeconds,
    refreshTtlSeconds: row.refreshTtlSeconds,
    installed: row.state === 'installed',
    installedAt: (row.installedAt as Date | null)?.toISOString() ?? null,
    lastInstallNote: row.lastInstallNote,
    placementsCount: counts.placements,
    handlersCount: counts.webhooks,
    tokensCount: counts.tokens,
    createdAt: (row.createdAt as Date).toISOString(),
  }
}

function toDetail(row: AppRow): Record<string, unknown> {
  return {
    ...toItem(row),
    clientSecret: row.clientSecret,
    placements: ((row.placements ?? []) as AppRow[]).map(toPlacement),
    handlers: ((row.webhooks ?? []) as AppRow[]).map((w) => ({
      id: w.id,
      event: w.event,
      handler: w.targetUrl ?? '',
      authType: 0,
      createdAt: (w.createdAt as Date).toISOString(),
    })),
    tokens: ((row.tokens ?? []) as AppRow[]).map(toToken),
    sessions: ((row.sessions ?? []) as AppRow[]).map((s) => ({
      id: s.id,
      appSid: s.appSid,
      placement: s.placement,
      isInstall: s.isInstall,
      finishedAt: (s.finishedAt as Date | null)?.toISOString() ?? null,
      createdAt: (s.createdAt as Date).toISOString(),
    })),
  }
}

function toPlacement(row: AppRow): Record<string, unknown> {
  const definition = findB24Placement(String(row.placement))
  return {
    id: row.id,
    placement: row.placement,
    title: row.title ?? null,
    handler: row.handler,
    options: row.options ?? {},
    known: Boolean(definition),
    surface: definition?.surface ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
  }
}

function toToken(row: AppRow): Record<string, unknown> {
  const expiresAt = row.expiresAt as Date
  return {
    id: row.id,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    portalUserId: row.portalUserId,
    scope: row.scope,
    expiresAt: expiresAt.toISOString(),
    expired: expiresAt.getTime() <= Date.now(),
    // Отрицательное значит «истёк столько-то секунд назад»: интерфейсу нужен
    // и этот случай, иначе обратный отсчёт замирает на нуле.
    expiresInSeconds: Math.round((expiresAt.getTime() - Date.now()) / 1000),
    revokedAt: (row.revokedAt as Date | null)?.toISOString() ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
  }
}

function portalInfo(sandboxId: string): Record<string, unknown> {
  const admin = portalUser(1)
  return {
    domain: portalDomain(),
    protocol: portalProtocol(),
    lang: 'ru',
    memberId: memberIdFor(sandboxId),
    restUrl: clientEndpoint(),
    oauthUrl: serverEndpoint(),
    bx24JsUrl: bx24JsUrl(),
    currentUser: { id: admin.id, name: portalUserName(admin), isAdmin: admin.isAdmin },
    users: PORTAL_USERS.map((u) => ({ id: u.id, name: portalUserName(u), position: u.position, isAdmin: u.isAdmin })),
  }
}

function placementOptions(): Array<Record<string, unknown>> {
  return B24_PLACEMENTS.filter((p) => p.code !== 'DEFAULT').map((p) => ({
    code: p.code,
    title: p.title,
    scope: p.scope,
    surface: p.surface,
  }))
}

/**
 * URI в PLACEMENT_OPTIONS — путь страницы портала, с которой открыт виджет.
 * Боевой портал добавляет его к любой точке; приложения по нему понимают контекст.
 */
function uriFor(placement: string, options: Record<string, unknown>): string {
  const id = options.ID ?? options.taskId
  if (placement.startsWith('CRM_DEAL') && id) return `/crm/deal/details/${String(id)}/`
  if (placement.startsWith('CRM_LEAD') && id) return `/crm/lead/details/${String(id)}/`
  if (placement.startsWith('CRM_CONTACT') && id) return `/crm/contact/details/${String(id)}/`
  if (placement.startsWith('TASK') && id) return `/company/personal/user/1/tasks/task/view/${String(id)}/`
  if (placement === 'LEFT_MENU') return '/'
  return '/'
}

/** ONAPPINSTALL уходит на адрес обработчика — так же, как в боевом портале. */
async function notifyInstall(row: { id: string; sandboxId: string; handlerUrl: string | null; installUrl: string | null; applicationToken: string }) {
  const target = row.handlerUrl ?? row.installUrl
  if (!target) return null
  return dispatchAppEvent(row, 'ONAPPINSTALL', target)
}

async function notifyUninstall(row: { id: string; sandboxId: string; handlerUrl: string | null; installUrl: string | null; applicationToken: string }) {
  const target = row.handlerUrl ?? row.installUrl
  if (!target) return null
  return dispatchAppEvent(row, 'ONAPPUNINSTALL', target)
}

/**
 * Разовая доставка события приложению.
 *
 * Идёт через тот же диспетчер, что и подписки пользователя: событию нужен журнал
 * доставок, а заводить второй путь ради двух событий жизненного цикла — значит
 * получить два несовпадающих журнала.
 */
async function dispatchAppEvent(
  row: { id: string; sandboxId: string; applicationToken: string },
  event: string,
  target: string,
) {
  // Запись переиспользуется между установками: повторная установка не должна
  // плодить в журнале несколько «каналов» на один и тот же адрес.
  const existing = await prisma.webhook.findFirst({
    where: { appId: row.id, event, targetUrl: target },
  })
  const webhook = existing ?? (await prisma.webhook.create({
    data: {
      sandboxId: row.sandboxId,
      appId: row.id,
      serviceCode: 'bitrix24',
      event,
      httpMethod: 'POST',
      target: 'public',
      targetUrl: target,
      secret: row.applicationToken,
      status: 'active',
    },
  }))

  return dispatchWebhook({ sandboxId: row.sandboxId, webhookId: webhook.id })
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

function validationError(reply: FastifyReply, issues: Array<{ message: string }>): unknown {
  return reply.code(400).send({ error: 'VALIDATION', issues: issues.map((i) => i.message) })
}
