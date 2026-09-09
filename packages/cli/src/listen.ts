import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import WebSocket from 'ws'
import { apiClient, CliError } from './api.ts'
import { readConfig, writeConfig } from './config.ts'
import { out } from './output.ts'
import {
  CloseCode, TUNNEL_SUBPROTOCOL, normalizeForward,
  type DeliveryFrame, type ReadyFrame, type ServerFrame,
} from './protocol.ts'

/**
 * `apistend listen` — приём событий на локальное приложение.
 *
 * Инвариант, который держит всю схему: сервер присылает ТОЛЬКО относительный путь,
 * базовый адрес берётся из --forward. Поэтому CLI не может быть использован как
 * открытый прокси, а сервер физически не может заставить его пойти в чужую сеть.
 */

export interface ListenOptions {
  apiKey: string
  apiBase?: string
  forward: string
  events?: string[]
  /** Не досылать накопленное за простой. */
  noReplay?: boolean
  /** Перебить таймаут ответа приложения (0 — отключить, для отладки под брейкпоинтом). */
  timeoutMs?: number
  /** Максимум одновременных локальных вызовов. */
  concurrency?: number
  json?: boolean
  version: string
  /** Программная остановка — нужна тестам. */
  signal?: AbortSignal
}

export interface ListenStats {
  sessionId: string
  events: number
  failed: number
  medianMs: number
}

const MAX_BODY_BYTES = 1024 * 1024
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 30_000

export async function listen(options: ListenOptions): Promise<ListenStats> {
  const forwardBase = normalizeForward(options.forward)
  if (!forwardBase) {
    throw new CliError(
      `Адрес пересылки должен быть локальным: получено ${options.forward}`,
      0,
      'Разрешены localhost, 127.0.0.1 и ::1',
    )
  }

  const config = readConfig()
  const deviceId = config.deviceId ?? randomBytes(8).toString('hex')
  if (!config.deviceId) writeConfig({ ...config, deviceId })

  const sessionRequest = {
    deviceId,
    deviceName: hostname(),
    agentVersion: `apistend-cli ${options.version}`,
    forward: forwardBase,
  }
  let session = await apiClient.createSession(options.apiKey, options.apiBase, sessionRequest)

  if (!options.json) {
    out.banner(options.version, session.account ?? session.sandbox, session.sandbox)
  }

  const durations: number[] = []
  let events = 0
  let failed = 0
  // Дедупликация: сервер обязан гарантировать доставку хотя бы раз,
  // а значит может доставить дважды.
  const seen = new Set<string>()
  let attempt = 0
  let stopped = false
  let socket: WebSocket | null = null
  let inflight = 0
  const pending: DeliveryFrame[] = []

  const stop = () => {
    stopped = true
    socket?.close(1000, 'client shutdown')
  }
  options.signal?.addEventListener('abort', stop, { once: true })

  await new Promise<void>((resolve) => {
    const connect = () => {
      if (stopped) { resolve(); return }

      socket = new WebSocket(session.connectUrl, TUNNEL_SUBPROTOCOL, {
        headers: { authorization: `Bearer ${session.sessionToken}` },
      })

      socket.on('open', () => { attempt = 0 })

      socket.on('message', (raw) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(raw.toString()) as ServerFrame
        } catch {
          return
        }

        if (frame.type === 'ready') {
          onReady(frame)
          return
        }
        if (frame.type === 'error') {
          out.error(frame.message)
          return
        }
        if (frame.type !== 'delivery') return

        if (seen.has(frame.deliveryId)) return
        seen.add(frame.deliveryId)
        if (seen.size > 5_000) seen.delete(seen.values().next().value!)

        if (options.events && options.events.length > 0 && !options.events.includes(frame.event)) return

        pending.push(frame)
        pump()
      })

      socket.on('close', (code) => {
        if (stopped) { resolve(); return }

        // Вытеснение другим агентом — терминальное состояние. Ретрай здесь
        // превратил бы два открытых терминала в бесконечную борьбу за сессию.
        if (code === CloseCode.SUPERSEDED) {
          out.error('Сессия занята другим агентом', 'Закройте другой apistend listen или используйте другую песочницу')
          resolve()
          return
        }
        if (code === CloseCode.KEY_REVOKED) {
          out.error('Ключ отозван', 'Запустите: apistend login --api-key stend_sk_…')
          resolve()
          return
        }

        attempt++
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
        if (!options.json) out.reconnecting(attempt)
        setTimeout(reconnect, delay).unref?.()
      })

      socket.on('error', () => { /* обработается в close */ })
    }

    /**
     * Переподключение начинается с НОВОЙ сессии, а не с повтора старого токена.
     *
     * Токен подключения одноразовый: сервер гасит его в момент первого upgrade
     * (tunnel/server.ts, условие usedAt: null) и живёт он всего десять минут.
     * Повторное подключение тем же токеном не могло завершиться успехом никогда —
     * агент после первого же обрыва связи молчал до перезапуска руками, продолжая
     * печатать «переподключаюсь». Худший вид отказа для инструмента, у которого
     * человек сидит и ждёт событие.
     */
    const reconnect = () => {
      if (stopped) { resolve(); return }
      apiClient
        .createSession(options.apiKey, options.apiBase, sessionRequest)
        .then((fresh) => {
          session = fresh
          connect()
        })
        .catch(() => {
          // Сервис недоступен или ключ отозван: пробуем снова по той же лестнице.
          // Отзыв ключа отдельно разбирается в обработчике close, когда соединение
          // всё-таки поднимется.
          attempt++
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
          if (!options.json) out.reconnecting(attempt)
          setTimeout(reconnect, delay).unref?.()
        })
    }

    const onReady = (frame: ReadyFrame) => {
      if (attempt > 0) {
        if (!options.json) out.reconnected(frame.displayId, frame.queued)
      } else if (!options.json) {
        out.ready(frame.displayId, forwardBase, frame.signingSecret, options.noReplay ? 0 : frame.queued)
      }
    }

    const pump = () => {
      const limit = options.concurrency ?? 16
      while (inflight < limit && pending.length > 0) {
        const frame = pending.shift()!
        inflight++
        void deliver(frame).finally(() => {
          inflight--
          pump()
        })
      }
    }

    const deliver = async (frame: DeliveryFrame) => {
      const url = `${forwardBase}${frame.request.path}`
      const startedAt = Date.now()

      if (!options.json) out.delivery(frame.event, frame.deliveryId)
      send({ v: 1, type: 'ack', deliveryId: frame.deliveryId, receivedAt: Date.now() })

      const timeout = options.timeoutMs === 0 ? undefined : (options.timeoutMs ?? frame.timeoutMs)

      try {
        const res = await fetch(url, {
          method: frame.request.method,
          headers: { ...frame.request.headers, 'content-type': frame.request.contentType },
          body: frame.request.body,
          // Редиректы не следуем: приложение разработчика должно отвечать само.
          redirect: 'manual',
          ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
        })

        const buffer = await res.arrayBuffer()
        const truncated = buffer.byteLength > MAX_BODY_BYTES
        const body = Buffer.from(buffer.slice(0, MAX_BODY_BYTES)).toString('utf8')
        const ms = Date.now() - startedAt

        durations.push(ms)
        events++
        if (res.status >= 400) failed++

        if (!options.json) out.response(res.status, frame.request.method, url, ms, frame.deliveryId)
        else out.json({ type: 'response', event: frame.event, status: res.status, durationMs: ms, deliveryId: frame.deliveryId })

        send({
          v: 1, type: 'response', deliveryId: frame.deliveryId,
          statusCode: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body,
          durationMs: ms,
          error: truncated ? { kind: 'too_large', message: 'Ответ обрезан по лимиту 1 МБ' } : null,
        })
      } catch (e) {
        const ms = Date.now() - startedAt
        failed++
        const err = e as Error & { cause?: { code?: string } }
        const isTimeout = err.name === 'TimeoutError'
        const refused = err.cause?.code === 'ECONNREFUSED'
        const message = isTimeout
          ? `превышен таймаут ${Math.round((timeout ?? 0) / 1000)} с`
          : refused
            ? 'соединение отклонено (ECONNREFUSED)'
            : err.message

        if (!options.json) out.deliveryError(url, message, null, frame.deliveryId)

        send({
          v: 1, type: 'response', deliveryId: frame.deliveryId,
          statusCode: null, headers: {}, body: '', durationMs: ms,
          error: { kind: isTimeout ? 'timeout' : refused ? 'econnrefused' : 'network', message },
        })
      }
    }

    const send = (frame: unknown) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(frame))
        } catch { /* сокет умер, доставку подберёт reaper на сервере */ }
      }
    }

    connect()
  })

  durations.sort((a, b) => a - b)
  const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : 0
  const stats: ListenStats = { sessionId: session.displayId, events, failed, medianMs: median }

  if (!options.json) out.summary(stats.sessionId, events, failed, median)
  return stats
}
