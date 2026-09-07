import type { WebSocket } from 'ws'
import type { DeliveryFrame, ErrorFrame, ReadyFrame } from '@apistend/shared'

/**
 * Реестр живых сессий туннеля.
 *
 * Держим в памяти процесса: сокет и так привязан к конкретному инстансу, вынести
 * его в общее хранилище нельзя. Для нескольких инстансов заготовлена колонка
 * gw_node_id в tunnel_sessions — переход сведётся к пробуждению через LISTEN/NOTIFY,
 * без изменения протокола.
 *
 * Ключ — песочница: одновременно активна ровно одна сессия на песочницу.
 * Второй агент вытесняет первого кодом 4003, и на этот код CLI не переподключается —
 * иначе два терминала бесконечно выбивают друг друга.
 */

export interface LiveSession {
  sandboxId: string
  sessionId: string
  displayId: string
  deviceId: string
  agentVersion: string
  forwardUrl: string
  socket: WebSocket
  connectedAt: Date
  lastSeenAt: Date
  latencyMs: number | null
  eventsLastHour: number
  failedDeliveries: number
  /** Доставки, отданные агенту и ждущие ответа. */
  inflight: Map<string, { sentAt: number; timeoutMs: number }>
}

const sessions = new Map<string, LiveSession>()

export function putSession(session: LiveSession): LiveSession | null {
  const previous = sessions.get(session.sandboxId) ?? null
  sessions.set(session.sandboxId, session)
  return previous
}

export function getSession(sandboxId: string): LiveSession | undefined {
  return sessions.get(sandboxId)
}

export function dropSession(sandboxId: string, socket?: WebSocket): void {
  const current = sessions.get(sandboxId)
  // Сокет мог уже смениться на новый: не удаляем чужую сессию по событию close старой.
  if (current && (!socket || current.socket === socket)) sessions.delete(sandboxId)
}

export function allSessions(): LiveSession[] {
  return [...sessions.values()]
}

export function sendFrame(session: LiveSession, frame: ReadyFrame | DeliveryFrame | ErrorFrame): boolean {
  // readyState 1 — OPEN. Отправка в полумёртвый сокет не бросает, а тихо буферизуется,
  // поэтому проверяем состояние явно.
  if (session.socket.readyState !== 1) return false
  try {
    session.socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

/** Сводка для панели «Доставка на локальное приложение» и для CLI-команды status. */
export function sessionSummary(sandboxId: string) {
  const s = sessions.get(sandboxId)
  if (!s) {
    return {
      connected: false,
      agentVersion: null,
      sessionId: null,
      forwardUrl: null,
      latencyMs: null,
      eventsLastHour: 0,
      failedDeliveries: 0,
    }
  }
  return {
    connected: true,
    agentVersion: s.agentVersion,
    sessionId: s.displayId,
    forwardUrl: s.forwardUrl,
    latencyMs: s.latencyMs,
    eventsLastHour: s.eventsLastHour,
    failedDeliveries: s.failedDeliveries,
  }
}
