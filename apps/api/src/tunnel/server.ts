import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AckFrame, ResponseFrame } from '@apistend/shared'
import { TUNNEL_SUBPROTOCOL, TunnelCloseCode, isClientFrame } from '@apistend/shared'
import { prisma } from '../db.ts'
import { recordDeliveryResult, tryDeliver } from '../webhooks/dispatcher.ts'
import { allSessions, dropSession, getSession, putSession, sendFrame, type LiveSession } from './registry.ts'

/**
 * WebSocket-туннель для команды `apistend listen`.
 *
 * Живёт внутри основного HTTP-сервера через ws в режиме noServer: отдельный процесс
 * тут ничего не даёт, а стоит лишней подвижной части. Сотня соединений — единицы
 * мегабайт. Разделены не процессы, а роли: транспорт (этот файл), диспетчер
 * и планировщик повторов (webhooks/dispatcher.ts).
 *
 * Почему это не SSRF: запрос на localhost делает CLI на машине пользователя,
 * сервер лишь передаёт относительный путь и тело. Абсолютных адресов в протоколе нет.
 */

const HEARTBEAT_MS = 20_000
const SESSION_TOKEN_TTL_MS = 10 * 60 * 1000

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Одноразовый токен подключения. Живёт в базе, а не в памяти: иначе деплой выбивает всех агентов. */
export function newSessionToken(): { token: string; hash: string } {
  const token = `tnlt_${randomBytes(24).toString('hex')}`
  return { token, hash: hashToken(token) }
}

export const SESSION_TOKEN_TTL = SESSION_TOKEN_TTL_MS

export function registerTunnel(app: FastifyInstance, log: (msg: string) => void): void {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => TUNNEL_SUBPROTOCOL })

  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/v1/tunnel/connect') return

    const auth = request.headers.authorization
    const token = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] : undefined

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    void (async () => {
      const record = await prisma.tunnelSession.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { sandbox: true, apiKey: true },
      })

      if (!record || record.expiresAt < new Date()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      if (record.apiKey.status === 'revoked') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        void onConnected(ws, record.id, log)
      })
    })()
  })

  const heartbeat = setInterval(() => {
    for (const session of allSessions()) {
      if (Date.now() - session.lastSeenAt.getTime() > HEARTBEAT_MS * 2) {
        // terminate, а не close: иначе полумёртвый сокет остаётся «Подключено» в интерфейсе.
        session.socket.terminate()
        dropSession(session.sandboxId, session.socket)
        void prisma.tunnelSession.updateMany({
          where: { sandboxId: session.sandboxId, connected: true },
          data: { connected: false },
        })
        continue
      }
      try {
        session.socket.ping()
      } catch {
        /* сокет уже мёртв, его снимет следующий проход */
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()
}

async function onConnected(ws: WebSocket, sessionRowId: string, log: (msg: string) => void): Promise<void> {
  const record = await prisma.tunnelSession.findUnique({ where: { id: sessionRowId }, include: { sandbox: true } })
  if (!record) {
    ws.close(TunnelCloseCode.INVALID_SESSION, 'session gone')
    return
  }

  const session: LiveSession = {
    sandboxId: record.sandboxId,
    sessionId: record.id,
    displayId: record.displayId,
    deviceId: record.deviceId,
    agentVersion: record.agentVersion,
    forwardUrl: record.forwardUrl,
    socket: ws,
    connectedAt: new Date(),
    lastSeenAt: new Date(),
    latencyMs: null,
    eventsLastHour: 0,
    failedDeliveries: 0,
    inflight: new Map(),
  }

  // Одна сессия на песочницу. Предыдущего агента вытесняем явным кодом,
  // на который CLI по контракту НЕ переподключается.
  const previous = putSession(session)
  if (previous && previous.socket !== ws) {
    try {
      previous.socket.close(TunnelCloseCode.SUPERSEDED, 'superseded by another agent')
    } catch { /* уже закрыт */ }
  }

  await prisma.tunnelSession.update({
    where: { id: record.id },
    data: { connected: true, connectedAt: new Date(), lastSeenAt: new Date() },
  })

  // Сколько событий накопилось за простой — агент должен это увидеть,
  // молча досылать нельзя.
  // Считаем только то, что ждёт ИМЕННО агента: доставки на публичный адрес
  // отправляет сам сервер, и обещать их пользователю в строке «отправляю» — неправда.
  const queued = await prisma.webhookDelivery.count({
    where: { sandboxId: record.sandboxId, state: 'queued', webhook: { target: 'local' } },
  })

  sendFrame(session, {
    v: 1,
    type: 'ready',
    sessionId: record.id,
    displayId: record.displayId,
    sandboxName: record.sandbox.name,
    agentVersion: record.agentVersion,
    signingSecret: record.signingSecret,
    queued,
    heartbeatIntervalMs: HEARTBEAT_MS,
  })

  log(`туннель: агент подключён, сессия ${record.displayId}, в очереди ${queued}`)

  // Догоняем очередь: онлайн- и офлайн-путь совпадают.
  void drainQueue(record.sandboxId)

  ws.on('pong', () => { session.lastSeenAt = new Date() })

  ws.on('message', (raw) => {
    session.lastSeenAt = new Date()
    let frame: unknown
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      return // мусор игнорируем, соединение не рвём
    }
    if (!isClientFrame(frame)) return

    if (frame.type === 'ack') {
      handleAck(session, frame)
      return
    }
    void handleResponse(session, frame)
  })

  ws.on('close', () => {
    dropSession(session.sandboxId, ws)
    void prisma.tunnelSession.updateMany({
      where: { id: record.id, connected: true },
      data: { connected: false },
    })
    log(`туннель: агент отключён, сессия ${record.displayId}`)
  })

  ws.on('error', () => { /* закрытие обработает close */ })
}

function handleAck(session: LiveSession, frame: AckFrame): void {
  const inflight = session.inflight.get(frame.deliveryId)
  if (!inflight) return
  // ack не отменяет ожидание, а продлевает его: обрыв между ack и response
  // не должен терять доставку.
  inflight.sentAt = Date.now()
  session.latencyMs = Math.max(0, Date.now() - frame.receivedAt)
}

async function handleResponse(session: LiveSession, frame: ResponseFrame): Promise<void> {
  session.inflight.delete(frame.deliveryId)
  session.eventsLastHour++
  if (frame.error || (frame.statusCode !== null && frame.statusCode >= 400)) session.failedDeliveries++

  await recordDeliveryResult(frame.deliveryId, {
    statusCode: frame.statusCode,
    body: frame.body ?? '',
    durationMs: frame.durationMs,
    errorKind: frame.error?.kind ?? null,
    errorMessage: frame.error?.message ?? null,
  })
}

/** Досылает всё, что накопилось в очереди этой песочницы. */
async function drainQueue(sandboxId: string): Promise<void> {
  const queued = await prisma.webhookDelivery.findMany({
    where: { sandboxId, state: 'queued', webhook: { target: 'local' } },
    orderBy: { timestamp: 'asc' },
    take: 200,
  })
  for (const d of queued) {
    if (!getSession(sandboxId)) return
    await tryDeliver(d.id)
  }
}
