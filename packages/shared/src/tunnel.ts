/**
 * Протокол туннеля между сервером APIStend и агентом `apistend listen`.
 *
 * Инвариант, который нельзя нарушать: в протоколе НЕТ абсолютных URL.
 * Сервер шлёт только относительный путь, базу подставляет CLI из флага --forward.
 * Поэтому подписка на локальную доставку хранит targetPath (`/wb/stocks`), а не targetUrl —
 * иначе склейка даёт http://localhost:3000/webhooks/webhooks/wb/stocks.
 */

export const TUNNEL_SUBPROTOCOL = 'apistend.tunnel.v1'
export const TUNNEL_PROTOCOL_VERSION = 1

/** Коды закрытия WebSocket. Разные причины должны различаться — от этого зависит поведение CLI. */
export const TunnelCloseCode = {
  /** Сессионный токен невалиден или протух. CLI пересоздаёт сессию. */
  INVALID_SESSION: 4001,
  /** Ключ stend_sk_ отозван. CLI печатает «запустите apistend login» и выходит. */
  KEY_REVOKED: 4002,
  /** Сессию вытеснил другой агент. НА ЭТОТ КОД НЕ РЕТРАИМ — иначе два терминала будут
   *  бесконечно выбивать друг друга. */
  SUPERSEDED: 4003,
  /** Сервер уходит на перезапуск. CLI ждёт retryAfterMs и переподключается. */
  DRAINING: 4009,
} as const

export type TunnelCloseCodeValue = (typeof TunnelCloseCode)[keyof typeof TunnelCloseCode]

/** Сервер -> CLI: сессия установлена. */
export interface ReadyFrame {
  readonly v: 1
  readonly type: 'ready'
  readonly sessionId: string
  /** Короткий идентификатор для интерфейса: tnl-8f21. */
  readonly displayId: string
  readonly sandboxName: string
  readonly agentVersion: string
  /** Секрет для проверки подписи X-APIStend-Signature на стороне приложения. */
  readonly signingSecret: string
  /** Сколько событий накопилось за простой и будет отправлено следом. */
  readonly queued: number
  readonly heartbeatIntervalMs: number
}

/** Сервер -> CLI: доставить событие в локальное приложение. */
export interface DeliveryFrame {
  readonly v: 1
  readonly type: 'delivery'
  readonly deliveryId: string
  readonly webhookId: string
  readonly event: string
  readonly service: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly request: {
    readonly method: string
    /** Только относительный путь. Базу даёт --forward. */
    readonly path: string
    readonly headers: Readonly<Record<string, string>>
    /** Сырое тело как строка: у Bitrix24 это form-urlencoded, а не JSON. */
    readonly body: string
    readonly contentType: string
  }
  /** Сколько ждать ответ приложения. Берётся из профиля сервиса, а не из транспорта. */
  readonly timeoutMs: number
}

/** CLI -> сервер: кадр принят, начинаю локальный вызов. Продлевает таймер переотправки. */
export interface AckFrame {
  readonly v: 1
  readonly type: 'ack'
  readonly deliveryId: string
  readonly receivedAt: number
}

/** CLI -> сервер: локальное приложение ответило (или не ответило). */
export interface ResponseFrame {
  readonly v: 1
  readonly type: 'response'
  readonly deliveryId: string
  readonly statusCode: number | null
  readonly headers: Readonly<Record<string, string>>
  /** Тело ответа, обрезанное до лимита. */
  readonly body: string
  readonly durationMs: number
  /** Заполняется, когда приложение недоступно или не ответило вовремя. */
  readonly error: { readonly kind: 'econnrefused' | 'timeout' | 'network' | 'too_large'; readonly message: string } | null
}

/** Сервер -> CLI: нештатная ситуация, соединение при этом может остаться живым. */
export interface ErrorFrame {
  readonly v: 1
  readonly type: 'error'
  readonly code: string
  readonly message: string
  /** Сколько доставок выброшено из очереди по переполнению. */
  readonly dropped?: number
}

export type ServerFrame = ReadyFrame | DeliveryFrame | ErrorFrame
export type ClientFrame = AckFrame | ResponseFrame
export type TunnelFrame = ServerFrame | ClientFrame

export function isServerFrame(v: unknown): v is ServerFrame {
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { type?: unknown }).type
  return t === 'ready' || t === 'delivery' || t === 'error'
}

export function isClientFrame(v: unknown): v is ClientFrame {
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { type?: unknown }).type
  return t === 'ack' || t === 'response'
}

/** Разрешены только loopback-адреса. Проверяется и в CLI, и на сервере. */
export function isLoopbackForward(raw: string): boolean {
  let url: URL
  try {
    // Пользователь пишет `localhost:3000/webhooks` без схемы — нормализуем.
    url = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`)
  } catch {
    return false
  }
  const h = url.hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost')
}

/** Приводит `localhost:3000/webhooks` к абсолютному базовому адресу без хвостового слэша. */
export function normalizeForward(raw: string): string | null {
  if (!isLoopbackForward(raw)) return null
  const url = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`)
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}
