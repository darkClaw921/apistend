import type { FastifyInstance } from 'fastify'
import type { Webhook, WebhookDelivery } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ServiceCode } from '@apistend/shared'
import { SERVICE_CODES, SERVICE_PROFILES, findEvent } from '@apistend/shared'
import { prisma } from '../../db.ts'
import { sendError } from '../../lib/mgmt.ts'
import { checkPublicTarget } from '../../lib/webhook-target.ts'
import { dispatchWebhook, tryDeliver } from '../../webhooks/dispatcher.ts'
import {
  conflict,
  defineRoute,
  notFound,
  page,
  pageChecked,
  pageArgs,
  pageQuery,
  pageResponse,
  unprocessable,
} from './_registry.ts'

/**
 * Вебхуки и журнал доставок.
 *
 * Ресурса здесь два, и разведены они намеренно. Подписка живёт долго и правится;
 * доставка — уже случившийся факт, у которого меняется только состояние. Поэтому
 * список доставок отдаётся без тела запроса и ответа, а целиком доставка видна
 * только в карточке: страница на сто записей по четыре килобайта тела в каждой —
 * это мегабайт на одну прокрутку журнала.
 *
 * Политика доставки — повторы, таймаут, подпись — свойство СЕРВИСА, а не наше:
 * берётся из профиля (packages/shared/src/services.ts). Отсюда же следует, что
 * «повторить» у Bitrix24 не работает вовсе — боевой портал повторов не делает,
 * и мок не имеет права быть добрее.
 */

const HTTP_METHODS = ['POST', 'PUT', 'PATCH'] as const
const WEBHOOK_STATUSES = ['active', 'paused', 'failing', 'disabled'] as const
/** Ставить руками можно только эти два: failing выставляет диспетчер, disabled — снятие приложения. */
const SETTABLE_STATUSES = ['active', 'paused'] as const
const DELIVERY_STATES = ['queued', 'dispatched', 'succeeded', 'failed', 'no_response', 'dropped'] as const
/** Состояния, из которых доставку имеет смысл повторять. */
const RETRYABLE_STATES = ['failed', 'no_response', 'dropped'] as const

// ─────────────────────────── Схемы ресурсов ───────────────────────────

const webhookItem = z.object({
  id: z.string(),
  serviceCode: z.enum(SERVICE_CODES),
  event: z.string(),
  httpMethod: z.enum(HTTP_METHODS),
  target: z.enum(['public', 'local']),
  /** Заполнен у target = public. */
  targetUrl: z.string().nullable(),
  /** Заполнен у target = local: относительный путь, базу подставляет apistend listen. */
  targetPath: z.string().nullable(),
  status: z.enum(WEBHOOK_STATUSES),
  /** Не null — это подписка локального приложения Bitrix24, заведённая через event.bind. */
  appId: z.string().nullable(),
  lastAttemptAt: z.date().nullable(),
  successRate24h: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const webhookDetail = webhookItem.extend({
  secret: z.string(),
  /** Профиль сервиса: по нему видно, сколько попыток будет и чем подписывается доставка. */
  delivery: z.object({
    contentType: z.string(),
    timeoutMs: z.number().int(),
    maxAttempts: z.number().int(),
    retryDelaysMs: z.array(z.number().int()),
    successRule: z.enum(['status_2xx', 'status_200', 'status_200_and_body']),
    signature: z.enum(['none', 'application_token', 'hmac_sha256']),
    signatureHeader: z.string().nullable(),
    notes: z.string(),
  }),
})

const deliveryItem = z.object({
  id: z.string(),
  webhookId: z.string(),
  event: z.string(),
  serviceCode: z.enum(SERVICE_CODES),
  timestamp: z.date(),
  state: z.enum(DELIVERY_STATES),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  statusCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  nextRetryAt: z.date().nullable(),
  targetDisplay: z.string(),
  errorKind: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Серия, в которой создана доставка. null — одиночная отправка или тест. */
  burstId: z.string().nullable(),
})

const deliveryDetail = deliveryItem.extend({
  contentType: z.string(),
  /** Заголовки запроса как они ушли получателю, включая подпись. */
  requestHeaders: z.record(z.string(), z.string()),
  rawBody: z.string(),
  responseBody: z.string().nullable(),
  retryPolicy: z.object({
    retriesAllowed: z.boolean(),
    retryDelaysMs: z.array(z.number().int()),
    timeoutMs: z.number().int(),
  }),
})

// ─────────────────────────── Преобразование записей ───────────────────────────

/**
 * serviceCode и httpMethod лежат в базе строковыми колонками, а не перечислениями:
 * их набор задан профилями сервисов, а не схемой базы. Приведение к перечислению
 * ответа собрано здесь одним местом, чтобы в маршрутах его не было вовсе.
 */
function webhookOf(w: Webhook) {
  return {
    id: w.id,
    serviceCode: w.serviceCode as ServiceCode,
    event: w.event,
    httpMethod: w.httpMethod as (typeof HTTP_METHODS)[number],
    target: w.target,
    targetUrl: w.targetUrl,
    targetPath: w.targetPath,
    status: w.status,
    appId: w.appId,
    lastAttemptAt: w.lastAttemptAt,
    successRate24h: w.successRate24h,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
}

function webhookDetailOf(w: Webhook) {
  const profile = SERVICE_PROFILES[w.serviceCode as ServiceCode].webhook
  return {
    ...webhookOf(w),
    secret: w.secret,
    delivery: {
      contentType: profile.contentType,
      timeoutMs: profile.timeoutMs,
      // Первая попытка плюс лестница повторов — ровно то же число пишет диспетчер
      // в maxAttempts доставки.
      maxAttempts: profile.retryDelaysMs.length + 1,
      retryDelaysMs: [...profile.retryDelaysMs],
      successRule: profile.successRule,
      signature: profile.signature,
      signatureHeader: profile.signatureHeader,
      notes: profile.notes,
    },
  }
}

function deliveryOf(d: WebhookDelivery) {
  return {
    id: d.id,
    webhookId: d.webhookId,
    event: d.event,
    serviceCode: d.serviceCode as ServiceCode,
    timestamp: d.timestamp,
    state: d.state,
    attempt: d.attempt,
    maxAttempts: d.maxAttempts,
    statusCode: d.statusCode,
    durationMs: d.durationMs,
    nextRetryAt: d.nextRetryAt,
    targetDisplay: d.targetDisplay,
    errorKind: d.errorKind,
    errorMessage: d.errorMessage,
    burstId: d.burstId,
  }
}

// ─────────────────────────── Проверки цели и события ───────────────────────────

interface Problem {
  code: string
  message: string
}

/**
 * Событие принадлежит сервису: ONCRMDEALADD не бывает у Ozon. Без этой проверки
 * заводится вебхук, который не сработает никогда, — findEvent ищет по коду среди
 * всех сервисов сразу.
 */
function eventProblem(serviceCode: ServiceCode, event: string): Problem | null {
  const found = findEvent(event)
  if (!found) return { code: 'UNKNOWN_EVENT', message: `Событие «${event}» не поддерживается` }
  if (found.serviceCode !== serviceCode) {
    return {
      code: 'EVENT_SERVICE_MISMATCH',
      message: `Событие «${event}» принадлежит сервису ${found.serviceCode}, а не ${serviceCode}`,
    }
  }
  return null
}

/**
 * Запрос по публичному адресу делает сервер APIStend от своего имени, поэтому адрес
 * проверяется и здесь, а не только в кабинете: иначе Management API оказался бы
 * дырой в обход той же самой проверки на соседнем экране.
 */
async function targetProblem(
  target: 'public' | 'local',
  targetUrl: string | null | undefined,
  targetPath: string | null | undefined,
): Promise<Problem | null> {
  if (target === 'public') {
    if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
      return { code: 'VALIDATION', message: 'Для публичной доставки нужен targetUrl — полный адрес вида https://…' }
    }
    const verdict = await checkPublicTarget(targetUrl)
    return verdict.ok ? null : { code: 'TARGET_NOT_ALLOWED', message: verdict.reason }
  }
  if (!targetPath || !targetPath.startsWith('/')) {
    return {
      code: 'VALIDATION',
      message: 'Для локальной доставки нужен targetPath, начинающийся со слэша: базовый адрес задаёт apistend listen',
    }
  }
  return null
}

function newSecret(): string {
  return `stend_whsec_${randomBytes(8).toString('hex')}`
}

export function registerWebhookV1Routes(app: FastifyInstance): void {
  // ─────────────────────────── Подписки ───────────────────────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/webhooks',
      scope: 'webhooks:read',
      summary: 'Список вебхуков песочницы',
      description:
        'Подписки в порядке создания — тот же порядок, что на экране «Вебхуки и сценарии». ' +
        'Секрет подписи в списке не отдаётся: он нужен поштучно и не должен попадать в лог целой страницей — ' +
        'за ним идите в GET /webhooks/{id}. Подписки с заполненным appId заведены приложением Bitrix24 через event.bind.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      query: pageQuery.extend({
        status: z.enum(WEBHOOK_STATUSES).optional(),
        serviceCode: z.enum(SERVICE_CODES).optional(),
        event: z.string().min(2).max(80).optional(),
      }),
      response: pageResponse(webhookItem),
    },
    async (ctx, input, _req, reply) => {
      const rows = await prisma.webhook.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          ...(input.query.status ? { status: input.query.status } : {}),
          ...(input.query.serviceCode ? { serviceCode: input.query.serviceCode } : {}),
          ...(input.query.event ? { event: input.query.event } : {}),
        },
        // Второй ключ сортировки нужен курсору: у подписок, созданных одной
        // миграцией демо-данных, createdAt совпадает до миллисекунды, и без id
        // страницы могли бы разъехаться.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query, webhookOf)
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/webhooks',
      scope: 'webhooks:write',
      summary: 'Создать вебхук',
      description:
        'Событие должно принадлежать указанному сервису. Публичный адрес проверяется до создания: ' +
        'запрос по нему делает сервер APIStend, поэтому внутренние адреса отклоняются кодом TARGET_NOT_ALLOWED ' +
        '(для своей машины есть target = local и apistend listen). Секрет можно прислать свой — иначе он выдаётся, ' +
        'и ответ на создание единственный, где он приходит вместе со всей карточкой.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      status: 201,
      body: z.object({
        serviceCode: z.enum(SERVICE_CODES),
        event: z.string().min(2).max(80),
        target: z.enum(['public', 'local']),
        targetUrl: z.string().max(2_000).optional(),
        targetPath: z.string().max(500).optional(),
        httpMethod: z.enum(HTTP_METHODS).default('POST'),
        status: z.enum(SETTABLE_STATUSES).default('active'),
        secret: z.string().min(16).max(200).optional(),
      }),
      response: webhookDetail,
    },
    async (ctx, input, _req, reply) => {
      const bad = eventProblem(input.body.serviceCode, input.body.event)
      if (bad) return sendError(reply, 400, bad.code, bad.message)

      const badTarget = await targetProblem(input.body.target, input.body.targetUrl, input.body.targetPath)
      if (badTarget) return sendError(reply, 400, badTarget.code, badTarget.message)

      const created = await prisma.webhook.create({
        data: {
          sandboxId: ctx.sandbox.id,
          serviceCode: input.body.serviceCode,
          event: input.body.event,
          httpMethod: input.body.httpMethod,
          target: input.body.target,
          // Неиспользуемая половина цели обнуляется: иначе в карточке остаётся
          // адрес, по которому уже ничего не уходит, и он читается как рабочий.
          targetUrl: input.body.target === 'public' ? input.body.targetUrl! : null,
          targetPath: input.body.target === 'local' ? input.body.targetPath! : null,
          status: input.body.status,
          secret: input.body.secret ?? newSecret(),
        },
      })
      return webhookDetailOf(created)
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/webhooks/:id',
      scope: 'webhooks:read',
      summary: 'Карточка вебхука',
      description:
        'В отличие от списка отдаёт секрет подписи и профиль доставки сервиса: сколько будет попыток, ' +
        'какой таймаут, чем подписывается тело. Этими значениями проверяется подпись в обработчике, ' +
        'поэтому секрет доступен и после создания, а не только один раз.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: webhookDetail,
    },
    async (ctx, input, _req, reply) => {
      const webhook = await prisma.webhook.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!webhook) return notFound(reply, 'Вебхук не найден')
      return webhookDetailOf(webhook)
    },
  )

  defineRoute(
    app,
    {
      method: 'PATCH',
      path: '/webhooks/:id',
      scope: 'webhooks:write',
      summary: 'Изменить вебхук',
      description:
        'Меняются цель, событие, метод, состояние и секрет; сервис не меняется — событие и формат тела у другого ' +
        'сервиса другие, для этого заводится новая подписка. Состояние принимает только active и paused: ' +
        'failing выставляет диспетчер после серии неудач, и снимается оно тем же переводом в active — ' +
        'сама по себе успешная доставка паузу не снимает, ровно как в бою. Смена секрета необратима: ' +
        'подписи, посчитанные старым, перестанут сходиться. Ответ перечисляет изменённые поля в changed.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        event: z.string().min(2).max(80).optional(),
        target: z.enum(['public', 'local']).optional(),
        targetUrl: z.string().max(2_000).optional(),
        targetPath: z.string().max(500).optional(),
        httpMethod: z.enum(HTTP_METHODS).optional(),
        status: z.enum(SETTABLE_STATUSES).optional(),
        secret: z.string().min(16).max(200).optional(),
        /** Выдать новый секрет вместо присланного. Явное намерение: старый перестанет подходить. */
        rotateSecret: z.boolean().optional(),
      }),
      response: webhookDetail.extend({ changed: z.array(z.string()) }),
    },
    async (ctx, input, _req, reply) => {
      const webhook = await prisma.webhook.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!webhook) return notFound(reply, 'Вебхук не найден')

      const body = input.body
      const wantsSecret = body.secret !== undefined || body.rotateSecret === true
      if (body.secret !== undefined && body.rotateSecret === true) {
        return sendError(
          reply,
          400,
          'VALIDATION',
          'Одновременно secret и rotateSecret не принимаются: либо свой секрет, либо выданный',
        )
      }
      if (wantsSecret && webhook.appId) {
        // У подписки приложения секрет — это его application_token: приложение сверяет
        // одно значение и во фрейме установки, и в событии. Смена рассинхронизировала бы их.
        return conflict(
          reply,
          'Это подписка локального приложения Bitrix24: её секрет — application_token приложения ' +
            'и меняется только вместе с ним',
        )
      }

      const nextTarget = body.target ?? webhook.target
      const nextUrl = body.targetUrl ?? webhook.targetUrl
      const nextPath = body.targetPath ?? webhook.targetPath
      const targetTouched =
        body.target !== undefined || body.targetUrl !== undefined || body.targetPath !== undefined

      if (targetTouched) {
        const badTarget = await targetProblem(nextTarget, nextUrl, nextPath)
        if (badTarget) return sendError(reply, 400, badTarget.code, badTarget.message)
      }
      if (body.event !== undefined) {
        const bad = eventProblem(webhook.serviceCode as ServiceCode, body.event)
        if (bad) return sendError(reply, 400, bad.code, bad.message)
      }

      const changed: string[] = []
      if (body.event !== undefined && body.event !== webhook.event) changed.push('event')
      if (body.httpMethod !== undefined && body.httpMethod !== webhook.httpMethod) changed.push('httpMethod')
      if (body.status !== undefined && body.status !== webhook.status) changed.push('status')
      if (targetTouched) changed.push('target')
      if (wantsSecret) changed.push('secret')
      if (changed.length === 0) {
        return sendError(reply, 400, 'VALIDATION', 'Нечего менять: укажите хотя бы одно поле с новым значением')
      }

      const updated = await prisma.webhook.update({
        where: { id: webhook.id },
        data: {
          ...(body.event !== undefined ? { event: body.event } : {}),
          ...(body.httpMethod !== undefined ? { httpMethod: body.httpMethod } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(targetTouched
            ? {
                target: nextTarget,
                targetUrl: nextTarget === 'public' ? nextUrl : null,
                targetPath: nextTarget === 'local' ? nextPath : null,
              }
            : {}),
          ...(body.secret !== undefined ? { secret: body.secret } : {}),
          ...(body.rotateSecret === true ? { secret: newSecret() } : {}),
        },
      })
      return { ...webhookDetailOf(updated), changed }
    },
  )

  defineRoute(
    app,
    {
      method: 'DELETE',
      path: '/webhooks/:id',
      scope: 'webhooks:write',
      summary: 'Удалить вебхук',
      description:
        'Вместе с подпиской каскадом уходят её доставки из журнала и записи серий — восстановить их нечем. ' +
        'Поэтому при непустом журнале запрос отклоняется с кодом CONFLICT, пока не передан withDeliveries=true: ' +
        'это подтверждение, а не переключатель, доставки удаляются в любом случае. Временно выключить подписку, ' +
        'ничего не теряя, можно через PATCH со status=paused. Ответ — сводка удалённого.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      query: z.object({
        withDeliveries: z.enum(['true', 'false']).optional(),
      }),
      response: z.object({
        ok: z.literal(true),
        id: z.string(),
        event: z.string(),
        deletedDeliveries: z.number().int(),
        deletedBursts: z.number().int(),
        /**
         * Сколько серий шло в момент удаления. Записи этих серий уходят каскадом
         * вместе с подпиской, поэтому пометки на них не остаётся — это число и есть
         * единственный след того, что удаление прервало работу.
         */
        interruptedBursts: z.number().int(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const webhook = await prisma.webhook.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!webhook) return notFound(reply, 'Вебхук не найден')

      const [deliveries, bursts, running] = await Promise.all([
        prisma.webhookDelivery.count({ where: { webhookId: webhook.id } }),
        prisma.eventBurst.count({ where: { webhookId: webhook.id } }),
        prisma.eventBurst.count({ where: { webhookId: webhook.id, state: 'running' } }),
      ])

      if (deliveries > 0 && input.query.withDeliveries !== 'true') {
        return conflict(
          reply,
          `Журнал вебхука не пуст, доставок в нём: ${deliveries}. Они удалятся вместе с подпиской. ` +
            'Повторите запрос с ?withDeliveries=true, либо переведите вебхук в paused, если нужен только простой',
        )
      }

      // Идущая серия остановится сама: движок ловит нарушение внешнего ключа
      // и прекращает отправку. Записи серий при этом уходят каскадом вместе
      // с подпиской, поэтому в ответе возвращается их число — больше о них
      // нигде не узнать.
      await prisma.webhook.deleteMany({ where: { id: webhook.id, sandboxId: ctx.sandbox.id } })

      return {
        ok: true as const,
        id: webhook.id,
        event: webhook.event,
        deletedDeliveries: deliveries,
        deletedBursts: bursts,
        interruptedBursts: running,
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/webhooks/:id/test',
      scope: 'webhooks:write',
      summary: 'Отправить тестовое событие',
      description:
        'То же, что кнопка «Тест» в кабинете: одно событие с демонстрационным телом уходит получателю ' +
        'и попадает в журнал доставок обычной записью. Состояние queued означает, что отдавать некому — ' +
        'у локальной доставки не подключён apistend listen; событие уйдёт само, как только агент появится. ' +
        'Пауза отправке теста не мешает: проверять адрес нужно как раз на выключенной подписке.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      status: 202,
      params: z.object({ id: z.string().min(1) }),
      response: z.object({
        deliveryId: z.string(),
        webhookId: z.string(),
        state: z.enum(['queued', 'dispatched']),
        /** Те же значения и тот же смысл, что у поля target самой подписки. */
        target: z.enum(['local', 'public']),
        /** Куда ушло: полный адрес для public, путь агента для local. */
        targetUrl: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const result = await dispatchWebhook({
        sandboxId: ctx.sandbox.id,
        webhookId: input.params.id,
        isTest: true,
      })
      if (!result) return notFound(reply, 'Вебхук не найден')
      // Движок зовёт способ доставки transport, а адрес — target. В ресурсах API
      // target — это способ (как в самой подписке), поэтому переименовываем здесь:
      // иначе одно слово значило бы «public» у подписки и «https://…» у доставки.
      return {
        deliveryId: result.deliveryId,
        webhookId: input.params.id,
        state: result.state,
        target: result.transport,
        targetUrl: result.target,
      }
    },
  )

  // ─────────────────────────── Журнал доставок ───────────────────────────

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/webhooks/:id/deliveries',
      scope: 'webhooks:read',
      summary: 'Журнал доставок вебхука',
      description:
        'Свежие сверху. Записи без тел запроса и ответа — они отдаются поштучно в GET /deliveries/{id}. ' +
        'Состояние queued означает «ждёт отправки или повтора» (время повтора — в nextRetryAt), ' +
        'dispatched — «отправлено, ответа ещё нет», no_response — ответ так и не пришёл в отведённое время.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      query: pageQuery.extend({ state: z.enum(DELIVERY_STATES).optional() }),
      response: pageResponse(deliveryItem),
    },
    async (ctx, input, _req, reply) => {
      // Пустой список чужого вебхука неотличим от пустого журнала своего — поэтому
      // существование подписки проверяется отдельно.
      const webhook = await prisma.webhook.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
        select: { id: true },
      })
      if (!webhook) return notFound(reply, 'Вебхук не найден')

      const rows = await prisma.webhookDelivery.findMany({
        where: {
          webhookId: webhook.id,
          sandboxId: ctx.sandbox.id,
          ...(input.query.state ? { state: input.query.state } : {}),
        },
        // Серия создаёт сотни доставок в одну миллисекунду: без id вторым ключом
        // курсор листал бы их в непредсказуемом порядке.
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        ...pageArgs(input.query),
      })
      return pageChecked(reply, rows, input.query, deliveryOf)
    },
  )

  defineRoute(
    app,
    {
      method: 'GET',
      path: '/deliveries/:id',
      scope: 'webhooks:read',
      summary: 'Карточка доставки',
      description:
        'Всё, что ушло получателю и что он ответил: сырое тело в нативном для сервиса формате ' +
        '(у Bitrix24 это form-urlencoded, а не JSON), заголовки вместе с подписью, тело ответа и причина отказа. ' +
        'Истории попыток по одной записи нет: строка журнала переписывается на каждой попытке, ' +
        'видны только её номер (attempt из maxAttempts) и время следующей. Доставка ищется в текущей песочнице — ' +
        'для другой укажите sandboxId.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: deliveryDetail,
    },
    async (ctx, input, _req, reply) => {
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!delivery) return notFound(reply, 'Доставка не найдена')

      const profile = SERVICE_PROFILES[delivery.serviceCode as ServiceCode].webhook
      return {
        ...deliveryOf(delivery),
        contentType: delivery.contentType,
        // Json-колонка: диспетчер кладёт в неё плоский набор заголовков и читает
        // обратно тем же приведением (webhooks/dispatcher.ts, tryDeliver).
        requestHeaders: delivery.requestHeaders as Record<string, string>,
        rawBody: delivery.rawBody,
        responseBody: delivery.responseBody,
        retryPolicy: {
          retriesAllowed: profile.retryDelaysMs.length > 0,
          retryDelaysMs: [...profile.retryDelaysMs],
          timeoutMs: profile.timeoutMs,
        },
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/deliveries/:id/retry',
      scope: 'webhooks:write',
      summary: 'Повторить доставку',
      description:
        'Возвращает доставку в очередь с первой попытки и сразу пробует отдать её получателю. ' +
        'Исход прошлой попытки при этом затирается — журнал хранит только последнюю. ' +
        'Повторяются только доставки в состояниях failed, no_response и dropped: успешную повторять нечем, ' +
        'а ждущую отправки — незачем. Сервисам без повторов (Bitrix24) отказывается кодом UNPROCESSABLE: ' +
        'боевой портал доставку не повторяет, и мок не должен создавать другое впечатление — ' +
        'новое событие туда отправляется через POST /webhooks/{id}/test.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      params: z.object({ id: z.string().min(1) }),
      response: z.object({
        id: z.string(),
        webhookId: z.string(),
        state: z.enum(['queued', 'dispatched']),
        attempt: z.number().int(),
        maxAttempts: z.number().int(),
        target: z.string(),
      }),
    },
    async (ctx, input, _req, reply) => {
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: input.params.id, sandboxId: ctx.sandbox.id },
      })
      if (!delivery) return notFound(reply, 'Доставка не найдена')

      if (!(RETRYABLE_STATES as readonly string[]).includes(delivery.state)) {
        return conflict(
          reply,
          delivery.state === 'succeeded'
            ? 'Доставка уже прошла успешно. Чтобы отправить событие ещё раз, используйте POST /api/v1/webhooks/{id}/test'
            : `Доставка в состоянии ${delivery.state} — она ещё в работе, дождитесь исхода`,
        )
      }

      const profile = SERVICE_PROFILES[delivery.serviceCode as ServiceCode].webhook
      if (profile.retryDelaysMs.length === 0) {
        return unprocessable(
          reply,
          `${SERVICE_PROFILES[delivery.serviceCode as ServiceCode].title} повторных отправок не делает вовсе: ` +
            'сбой фиксируется, но событие не переотправляется. Повторять его здесь значило бы учить интеграцию ' +
            'поведению, которого в бою нет — отправьте новое событие через POST /api/v1/webhooks/{id}/test',
        )
      }

      await prisma.webhookDelivery.updateMany({
        where: { id: delivery.id },
        // Счётчик попыток обнуляется: это ручной повтор, а не продолжение лестницы,
        // и получателю должна достаться полная серия повторов сервиса.
        data: { state: 'queued', attempt: 1, nextRetryAt: null },
      })
      const sent = await tryDeliver(delivery.id)

      return {
        id: delivery.id,
        webhookId: delivery.webhookId,
        state: sent ? ('dispatched' as const) : ('queued' as const),
        attempt: 1,
        maxAttempts: delivery.maxAttempts,
        target: delivery.targetDisplay,
      }
    },
  )

  defineRoute(
    app,
    {
      method: 'POST',
      path: '/webhooks/retry-failed',
      scope: 'webhooks:write',
      summary: 'Повторить неудачные доставки',
      description:
        'Возвращает в очередь доставки в состояниях failed и no_response, свежие первыми. ' +
        'Отправляет их планировщик — в течение пары секунд, поэтому ответ говорит о поставленном в очередь, ' +
        'а не о доставленном. Доставки сервисов без повторов (Bitrix24) пропускаются: их коды перечислены ' +
        'в skippedServices. Исход прошлой попытки у поставленных в очередь затирается.',
      tags: ['Вебхуки'],
      needsSandbox: true,
      body: z.object({
        /** Ограничить одной подпиской. По умолчанию — все доставки песочницы. */
        webhookId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      response: z.object({
        scanned: z.number().int(),
        queued: z.number().int(),
        skipped: z.number().int(),
        /** Сервисы, доставки которых пропущены: повторов у них нет по профилю. */
        skippedServices: z.array(z.string()),
        /**
         * Остались ли неудачные доставки за пределом limit.
         * Без этого поля ответ «просмотрено 50, поставлено 50» читается как «готово»,
         * хотя в очереди может ждать ещё триста строк, и скрипт «повторить все неудачные»
         * заканчивал бы работу на первой полусотне.
         */
        hasMore: z.boolean(),
        deliveryIds: z.array(z.string()),
      }),
    },
    async (ctx, input, _req, reply) => {
      if (input.body.webhookId) {
        const webhook = await prisma.webhook.findFirst({
          where: { id: input.body.webhookId, sandboxId: ctx.sandbox.id },
          select: { id: true },
        })
        if (!webhook) return notFound(reply, 'Вебхук не найден')
      }

      // limit + 1 строка: лишняя и есть ответ на вопрос «осталось ли ещё»,
      // отдельный count ради этого не нужен.
      const found = await prisma.webhookDelivery.findMany({
        where: {
          sandboxId: ctx.sandbox.id,
          state: { in: ['failed', 'no_response'] },
          ...(input.body.webhookId ? { webhookId: input.body.webhookId } : {}),
        },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        take: input.body.limit + 1,
      })
      const hasMore = found.length > input.body.limit
      const failed = found.slice(0, input.body.limit)

      const retryable = failed.filter(
        (d) => SERVICE_PROFILES[d.serviceCode as ServiceCode].webhook.retryDelaysMs.length > 0,
      )
      const skippedServices = [
        ...new Set(failed.filter((d) => !retryable.includes(d)).map((d) => d.serviceCode)),
      ]

      if (retryable.length > 0) {
        // Одним запросом, а не по строке: при limit = 200 это двести раундов до базы
        // ради одинакового набора полей.
        await prisma.webhookDelivery.updateMany({
          where: { id: { in: retryable.map((d) => d.id) } },
          data: { state: 'queued', attempt: 1, nextRetryAt: null },
        })
      }

      return {
        scanned: failed.length,
        queued: retryable.length,
        skipped: failed.length - retryable.length,
        skippedServices,
        hasMore,
        deliveryIds: retryable.map((d) => d.id),
      }
    },
  )
}
