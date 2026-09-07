import { resolveApiBase } from './config.ts'

/** HTTP-клиент к APIStend. Ничего лишнего: в Node 20+ fetch глобальный. */

export class CliError extends Error {
  readonly status: number
  readonly hint: string | undefined

  constructor(message: string, status = 0, hint?: string) {
    super(message)
    this.name = 'CliError'
    this.status = status
    this.hint = hint
  }
}

export interface SessionResponse {
  sessionToken: string
  sessionId: string
  displayId: string
  signingSecret: string
  sandbox: string
  account: string
  connectUrl: string
  expiresIn: number
}

export interface StatusResponse {
  account: string
  sandbox: string
  keyName: string
  connected: boolean
  agentVersion: string | null
  sessionId: string | null
  forwardUrl: string | null
  latencyMs: number | null
  eventsLastHour: number
  failedDeliveries: number
}

async function call<T>(
  path: string, apiKey: string, apiBase: string | undefined, init?: RequestInit,
): Promise<T> {
  const base = resolveApiBase(apiBase)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    })
  } catch (e) {
    throw new CliError(
      `Не удалось связаться с ${base}: ${(e as Error).message}`,
      0,
      'Проверьте адрес в --api-base и доступность сети',
    )
  }

  const text = await res.text()
  const data = text ? safeJson(text) : null

  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; message?: string; available?: string[] }
    let hint: string | undefined
    if (body.error === 'WRONG_KEY_KIND') hint = 'Возьмите серверный ключ в разделе «Ключи и токены»'
    if (body.error === 'NO_WEBHOOK' && body.available?.length) {
      hint = `Доступные события: ${body.available.join(', ')}`
    }
    throw new CliError(body.message ?? `HTTP ${res.status}`, res.status, hint)
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const apiClient = {
  createSession: (apiKey: string, apiBase: string | undefined, body: Record<string, unknown>) =>
    call<SessionResponse>('/v1/tunnel/sessions', apiKey, apiBase, { method: 'POST', body: JSON.stringify(body) }),

  status: (apiKey: string, apiBase?: string) =>
    call<StatusResponse>('/v1/tunnel/status', apiKey, apiBase),

  trigger: (apiKey: string, apiBase: string | undefined, event: string) =>
    call<{ deliveryId: string; state: string; target: string; transport: string }>(
      '/v1/tunnel/trigger', apiKey, apiBase, { method: 'POST', body: JSON.stringify({ event }) },
    ),

  /** Серия: сколько событий и с какой скоростью. Сервер отвечает сразу, серия идёт в фоне. */
  burst: (
    apiKey: string, apiBase: string | undefined,
    input: { event: string; count: number; rate: number; errorRate?: number },
  ) =>
    call<BurstAccepted>('/v1/tunnel/trigger', apiKey, apiBase, {
      method: 'POST',
      body: JSON.stringify({
        event: input.event, count: input.count, rate: input.rate, errorRate: input.errorRate,
      }),
    }),

  bursts: (apiKey: string, apiBase?: string) =>
    call<BurstProgress>('/v1/tunnel/bursts', apiKey, apiBase),
}

export interface BurstAccepted {
  burstId: string
  event: string
  serviceCode: string
  transport: 'local' | 'public'
  target: string
  count: number
  ratePerSec: number
  /** Что обрезано потолками сервера. Пусто — приняли как просили. */
  capped: string[]
  estimatedSeconds: number
}

export interface BurstProgress {
  running: Array<{
    id: string
    event: string
    sent: number
    count: number
    ratePerSec: number
    actualRatePerSec: number
    throttledTicks: number
    elapsedMs: number
  }>
  recent: Array<{
    id: string
    state: string
    sent: number
    count: number
    succeeded: number
    failed: number
    note: string | null
  }>
}
