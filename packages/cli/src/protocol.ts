/**
 * Кадры протокола туннеля — копия контракта из @apistend/shared.
 *
 * Пакет публикуется в npm отдельно и не должен тянуть за собой воркспейс-зависимости,
 * поэтому типы продублированы. Расхождение ловится контрактным тестом.
 */

export const TUNNEL_SUBPROTOCOL = 'apistend.tunnel.v1'

export const CloseCode = {
  INVALID_SESSION: 4001,
  KEY_REVOKED: 4002,
  /** Сессию вытеснил другой агент. НА ЭТОТ КОД НЕ ПЕРЕПОДКЛЮЧАЕМСЯ. */
  SUPERSEDED: 4003,
  DRAINING: 4009,
} as const

export interface ReadyFrame {
  v: 1
  type: 'ready'
  sessionId: string
  displayId: string
  sandboxName: string
  agentVersion: string
  signingSecret: string
  queued: number
  heartbeatIntervalMs: number
}

export interface DeliveryFrame {
  v: 1
  type: 'delivery'
  deliveryId: string
  webhookId: string
  event: string
  service: string
  attempt: number
  maxAttempts: number
  request: {
    method: string
    /** Только относительный путь: базу подставляет CLI из --forward. */
    path: string
    headers: Record<string, string>
    body: string
    contentType: string
  }
  timeoutMs: number
}

export interface ErrorFrame {
  v: 1
  type: 'error'
  code: string
  message: string
  dropped?: number
}

export type ServerFrame = ReadyFrame | DeliveryFrame | ErrorFrame

/** Разрешены только loopback-адреса: CLI не должен превращаться в открытый прокси. */
export function isLoopbackForward(raw: string): boolean {
  let url: URL
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`)
  } catch {
    return false
  }
  const h = url.hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost')
}

/** `localhost:3000/webhooks` -> `http://localhost:3000/webhooks` */
export function normalizeForward(raw: string): string | null {
  if (!isLoopbackForward(raw)) return null
  const url = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
