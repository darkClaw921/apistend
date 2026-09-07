import { createHmac, randomUUID } from 'node:crypto'
import type { Webhook } from '@prisma/client'
import type { ServiceCode } from '@apistend/shared'
import {
  SERVICE_PROFILES, buildEventPayload, findEvent, isDeliverySuccessful,
} from '@apistend/shared'
import { prisma } from '../db.ts'
import { deliveryId } from '../lib/ids.ts'
import { getSession, sendFrame } from '../tunnel/registry.ts'

/**
 * Диспетчер доставки событий.
 *
 * Главный принцип: политика доставки — свойство СЕРВИСА, а не транспорта.
 * Боевой Bitrix24 не повторяет доставку вообще, Ozon повторяет по своей лестнице
 * с автоприостановкой подписки, WB — по своей и удаляет событие после исчерпания.
 * Единая сетка ретраев на всех дала бы разработчику ложную картину ровно в том
 * сценарии, ради которого он пришёл: «что будет, если мой обработчик упал».
 *
 * Очередь — таблица webhook_deliveries, она всё равно нужна панели «Журнал доставок».
 * Онлайн- и офлайн-путь совпадают: пишем строку queued, затем пробуем отдать в сокет.
 */

const PORTAL_DOMAIN = 'demo.bitrix24.ru'
const SELLER_ID = 12345

export interface DispatchOptions {
  sandboxId: string
  webhookId: string
  /** Порядковый номер — делает демо-данные события разными между доставками. */
  index?: number
  isTest?: boolean
}

export interface DispatchResult {
  deliveryId: string
  state: 'queued' | 'dispatched'
  target: string
  transport: 'local' | 'public'
}

/** Минимум полей вебхука, которого хватает, чтобы собрать и отправить доставку. */
export type DeliverableWebhook = Pick<
  Webhook,
  'id' | 'sandboxId' | 'serviceCode' | 'event' | 'httpMethod' | 'target' | 'targetUrl' | 'targetPath' | 'secret'
>

/**
 * Собирает строку доставки, ничего не записывая.
 *
 * Вынесено отдельно ради серий: там на каждое событие нельзя ходить в базу
 * за вебхуком и записывать строки по одной — при сотнях событий в секунду
 * это и есть узкое место.
 */
export function buildDelivery(
  webhook: DeliverableWebhook,
  options: { index: number; now: Date; isTest?: boolean; burstId?: string },
) {
  const event = findEvent(webhook.event)
  const service = webhook.serviceCode as ServiceCode
  const profile = SERVICE_PROFILES[service]
  const id = deliveryId()

  const payload = event
    ? buildEventPayload(event, {
        index: options.index,
        now: options.now,
        portalDomain: PORTAL_DOMAIN,
        applicationToken: webhook.secret.slice(-32),
        sellerId: SELLER_ID,
        requestId: randomUUID(),
        isTest: options.isTest === true,
      })
    : { body: JSON.stringify({ event: webhook.event, test: options.isTest === true }), contentType: 'application/json' }

  return {
    id,
    sandboxId: webhook.sandboxId,
    webhookId: webhook.id,
    burstId: options.burstId ?? null,
    event: webhook.event,
    serviceCode: service,
    state: 'queued' as const,
    attempt: 1,
    // Число попыток берём из профиля сервиса: у Bitrix24 их вообще нет.
    maxAttempts: profile.webhook.retryDelaysMs.length + 1,
    targetDisplay: webhook.target === 'local' ? (webhook.targetPath ?? '/') : (webhook.targetUrl ?? ''),
    rawBody: payload.body,
    contentType: payload.contentType,
    requestHeaders: buildHeaders(service, payload, webhook.secret, id),
  }
}

/**
 * Отдаёт уже собранную доставку, не перечитывая её из базы.
 * Возвращает false, если отдать некому: строка остаётся queued и её подберёт планировщик.
 */
export function sendPrepared(
  row: ReturnType<typeof buildDelivery>,
  webhook: DeliverableWebhook,
): boolean {
  const service = row.serviceCode as ServiceCode
  const profile = SERVICE_PROFILES[service]

  if (webhook.target === 'local') {
    const session = getSession(row.sandboxId)
    if (!session) return false

    const ok = sendFrame(session, {
      v: 1,
      type: 'delivery',
      deliveryId: row.id,
      webhookId: row.webhookId,
      event: row.event,
      service,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      request: {
        method: webhook.httpMethod,
        path: webhook.targetPath ?? '/',
        headers: row.requestHeaders,
        body: row.rawBody,
        contentType: row.contentType,
      },
      timeoutMs: profile.webhook.timeoutMs,
    })
    if (!ok) return false
    session.inflight.set(row.id, { sentAt: Date.now(), timeoutMs: profile.webhook.timeoutMs })
    return true
  }

  void deliverPublic(
    row.id, webhook.targetUrl ?? '', webhook.httpMethod,
    row.requestHeaders, row.rawBody, profile.webhook.timeoutMs,
  )
  return true
}

/** Ставит событие в очередь и пытается отдать его немедленно. */
export async function dispatchWebhook(options: DispatchOptions): Promise<DispatchResult | null> {
  const webhook = await prisma.webhook.findFirst({
    where: { id: options.webhookId, sandboxId: options.sandboxId },
  })
  if (!webhook) return null

  const now = new Date()
  const row = buildDelivery(webhook, {
    index: options.index ?? Math.floor(now.getTime() / 1000) % 97,
    now,
    isTest: options.isTest,
  })

  const delivery = await prisma.webhookDelivery.create({ data: row })
  const sent = await tryDeliver(delivery.id)
  return {
    deliveryId: delivery.id,
    state: sent ? 'dispatched' : 'queued',
    target: row.targetDisplay,
    transport: webhook.target === 'local' ? 'local' : 'public',
  }
}

function buildHeaders(
  service: ServiceCode,
  payload: { body: string; contentType: string },
  secret: string,
  id: string,
): Record<string, string> {
  const profile = SERVICE_PROFILES[service]
  const headers: Record<string, string> = {
    'content-type': payload.contentType,
    'user-agent': 'APIStend-Webhooks/1.0',
    'x-apistend-delivery-id': id,
  }

  if (profile.webhook.signature === 'hmac_sha256' && profile.webhook.signatureHeader) {
    // Как у боевого WB: HMAC-SHA256 от тела запроса ключом вебхука.
    headers[profile.webhook.signatureHeader.toLowerCase()] =
      createHmac('sha256', secret).update(payload.body).digest('hex')
  }
  return headers
}

/**
 * Пытается доставить одну запись.
 * Локальная доставка уходит в сокет CLI, публичная — обычным запросом с сервера.
 */
export async function tryDeliver(id: string): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id },
    include: { webhook: true },
  })
  if (!delivery || delivery.state === 'succeeded' || delivery.state === 'dropped') return false

  // Состояние ставим ДО отправки. Локальный получатель отвечает за миллисекунду,
  // и запись «dispatched» после запроса затирала бы уже пришедший результат.
  await prisma.webhookDelivery.updateMany({ where: { id }, data: { state: 'dispatched' } })

  const sent = sendPrepared(
    {
      id: delivery.id,
      sandboxId: delivery.sandboxId,
      webhookId: delivery.webhookId,
      burstId: delivery.burstId,
      event: delivery.event,
      serviceCode: delivery.serviceCode as ServiceCode,
      state: 'queued',
      attempt: delivery.attempt,
      maxAttempts: delivery.maxAttempts,
      targetDisplay: delivery.targetDisplay,
      rawBody: delivery.rawBody,
      contentType: delivery.contentType,
      requestHeaders: delivery.requestHeaders as Record<string, string>,
    },
    delivery.webhook,
  )
  if (!sent) {
    // Агент не подключён — возвращаем в очередь, чтобы событие ушло при подключении.
    // Условие по state не даёт откатить доставку, на которую уже пришёл ответ.
    await prisma.webhookDelivery.updateMany({
      where: { id, state: 'dispatched' },
      data: { state: 'queued' },
    })
    return false
  }
  return true
}

async function deliverPublic(
  id: string, url: string, method: string,
  headers: Record<string, string>, body: string, timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now()
  let statusCode: number | null = null
  let responseBody = ''
  let errorKind: string | null = null
  let errorMessage: string | null = null

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    statusCode = res.status
    responseBody = (await res.text()).slice(0, 4_000)
  } catch (e) {
    const name = (e as Error).name
    errorKind = name === 'TimeoutError' ? 'timeout' : 'network'
    errorMessage = (e as Error).message
  }

  await recordDeliveryResult(id, {
    statusCode, body: responseBody, durationMs: Date.now() - startedAt, errorKind, errorMessage,
  })
}

export interface DeliveryOutcome {
  statusCode: number | null
  body: string
  durationMs: number
  errorKind: string | null
  errorMessage: string | null
}

/**
 * Записывает исход доставки и планирует повтор по политике СЕРВИСА.
 * Вызывается и из публичной доставки, и из кадра response от CLI.
 */
export async function recordDeliveryResult(id: string, outcome: DeliveryOutcome): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id }, include: { webhook: true } })
  if (!delivery) return

  const service = delivery.serviceCode as ServiceCode
  const profile = SERVICE_PROFILES[service]

  const verdict = isDeliverySuccessful(
    service, profile.webhook.successRule, outcome.statusCode, outcome.body,
  )

  if (verdict.ok) {
    // updateMany, а не update: между findUnique и записью доставку могли удалить
    // (сброс демо-данных, ретеншен, повторный ответ агента). update бросил бы P2025
    // и уронил обработчик кадра, updateMany просто ничего не изменит.
    await prisma.$transaction([
      prisma.webhookDelivery.updateMany({
        where: { id },
        data: {
          state: 'succeeded',
          statusCode: outcome.statusCode,
          durationMs: outcome.durationMs,
          responseBody: outcome.body.slice(0, 4_000),
          nextRetryAt: null,
          errorKind: null,
          errorMessage: null,
        },
      }),
      prisma.webhook.updateMany({
        where: { id: delivery.webhookId },
        data: { lastAttemptAt: new Date(), status: 'active' },
      }),
    ])
    return
  }

  const retryDelays = profile.webhook.retryDelaysMs
  const nextIndex = delivery.attempt - 1
  const canRetry = nextIndex < retryDelays.length
  const nextRetryAt = canRetry ? new Date(Date.now() + retryDelays[nextIndex]!) : null

  await prisma.$transaction([
    prisma.webhookDelivery.updateMany({
      where: { id },
      data: {
        // Ответа не было вовсе — это отдельное терминальное состояние, иначе доставка
        // навсегда зависает в «попытка 1/5».
        state: outcome.statusCode === null && !canRetry ? 'no_response' : canRetry ? 'queued' : 'failed',
        statusCode: outcome.statusCode,
        durationMs: outcome.durationMs,
        responseBody: outcome.body.slice(0, 4_000),
        nextRetryAt,
        errorKind: outcome.errorKind ?? 'http_error',
        errorMessage: outcome.errorMessage ?? verdict.reason ?? null,
      },
    }),
    prisma.webhook.updateMany({
      where: { id: delivery.webhookId },
      data: {
        lastAttemptAt: new Date(),
        // Ozon и WB приостанавливают подписку после серии неудач, Bitrix24 — нет.
        status: !canRetry && profile.webhook.suspendsAfterFailures ? 'failing' : delivery.webhook.status,
      },
    }),
  ])
}

/**
 * Планировщик повторов и уборщик зависших доставок.
 *
 * Второе важнее первого: доставка, отданная агенту и оставшаяся без ответа
 * (агент умер, сеть пропала), иначе висит в «dispatched» вечно и выглядит
 * в интерфейсе как «в процессе» — худший класс багов для инструмента,
 * где человек сидит и ждёт событие.
 */
export function startWebhookScheduler(log: (msg: string) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const due = await prisma.webhookDelivery.findMany({
          where: { state: 'queued', OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] },
          orderBy: { timestamp: 'asc' },
          take: 50,
        })
        for (const d of due) {
          if (d.nextRetryAt) {
            await prisma.webhookDelivery.updateMany({
              where: { id: d.id },
              data: { attempt: { increment: 1 }, nextRetryAt: null },
            })
          }
          await tryDeliver(d.id)
        }

        const reaped = await reapStalled()
        if (reaped > 0) log(`доставки без ответа переведены в no_response: ${reaped}`)
      } catch (e) {
        log(`планировщик вебхуков: ${String(e)}`)
      }
    })()
  }, 2_000)
  timer.unref()
  return timer
}

/** Доставка отдана, но ответа нет дольше таймаута сервиса плюс запас. */
async function reapStalled(): Promise<number> {
  const now = Date.now()
  const stalled = await prisma.webhookDelivery.findMany({
    where: { state: 'dispatched' },
    include: { webhook: true },
    take: 100,
  })

  let reaped = 0
  for (const d of stalled) {
    const profile = SERVICE_PROFILES[d.serviceCode as ServiceCode]
    const deadline = d.timestamp.getTime() + profile.webhook.timeoutMs + 15_000
    if (now < deadline) continue
    await recordDeliveryResult(d.id, {
      statusCode: null,
      body: '',
      durationMs: profile.webhook.timeoutMs,
      errorKind: 'no_response',
      errorMessage: 'Ответ не получен в отведённое время',
    })
    reaped++
  }
  return reaped
}
