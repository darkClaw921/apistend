import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Транспорт MCP: Streamable HTTP поверх JSON-RPC 2.0.
 *
 * Написан здесь, а не взят из @modelcontextprotocol/sdk, по той же причине,
 * по которой в проекте нет Redis: серверная половина протокола — это разбор
 * JSON-RPC, выдача идентификатора сессии и кадр SSE вокруг ответа. Ради трёх
 * этих вещей тянуть зависимость с собственным жизненным циклом в шлюз,
 * который обязан держать тысячи запросов в секунду, невыгодно.
 *
 * Поведение снято с живого mcp.apify.com, а не выведено из спецификации:
 *
 *   • ответ на запрос с id  — 200, content-type text/event-stream, один кадр
 *     `event: message` / `id: …` / `data: <json>`;
 *   • уведомление без id    — 202 и пустое тело;
 *   • initialize            — выдаёт заголовок mcp-session-id;
 *   • Accept без обоих типов — 406 и ошибка -32000 ОБЫЧНЫМ JSON, не кадром SSE;
 *   • DELETE                — 200;
 *   • неизвестная сессия    — не ошибка: сервер просто заводит новую.
 *
 * Последнее особенно важно повторить: клиент, переживший перезапуск сервера,
 * у боевого Apify продолжает работать, и мок, отвечающий ему 404, сломал бы
 * ровно тот сценарий, ради которого мок и берут.
 */

/** Коды ошибок JSON-RPC 2.0 плюс тот, которым Apify отвечает на неверный Accept. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Ошибка транспорта — так помечен «Not Acceptable» у боевого сервера. */
  TRANSPORT: -32000,
} as const

export interface RpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

export class RpcError extends Error {
  // Поле объявлено явно, а не параметром конструктора: параметр-свойство —
  // синтаксис, который Node не умеет при исполнении .ts без сборки.
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** Описание одного инструмента в том виде, в каком его отдаёт tools/list. */
export interface McpTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema?: Record<string, unknown>
  readonly annotations?: Record<string, unknown>
}

/** Результат вызова инструмента в форме, которую ждёт клиент MCP. */
export interface McpToolResult {
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface McpServerDefinition {
  /** serverInfo из ответа initialize. */
  readonly serverInfo: Record<string, unknown>
  readonly protocolVersion: string
  readonly capabilities: Record<string, unknown>
  /** Текст instructions. Пустая строка означает «поля нет». */
  readonly instructions?: string
  /** Список инструментов для конкретного запроса: он зависит от параметра tools. */
  tools(req: FastifyRequest): Promise<readonly McpTool[]> | readonly McpTool[]
  /** Вызов инструмента. Бросает RpcError, если инструмента нет или аргументы неверны. */
  call(
    req: FastifyRequest,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> | McpToolResult
}

/** Кадр SSE вокруг одного ответа — ровно та форма, в которой отвечает mcp.apify.com. */
function sseFrame(sessionId: string, payload: unknown): string {
  const eventId = `${sessionId}/${randomUUID()}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return `event: message\nid: ${eventId}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Принимает ли клиент оба типа ответа.
 *
 * Боевой сервер требует именно оба и отказывает с 406, если хотя бы одного нет.
 * Требование не формальность: ответ приходит кадром SSE, а ошибка транспорта —
 * обычным JSON, и клиент обязан уметь разобрать оба.
 */
function acceptsBoth(accept: string | undefined): boolean {
  if (!accept) return false
  const value = accept.toLowerCase()
  if (value.includes('*/*')) return true
  return value.includes('application/json') && value.includes('text/event-stream')
}

/**
 * Обработчик одного HTTP-запроса к MCP-серверу.
 *
 * Возвращает то, что нужно отдать наружу; сам reply не закрывает — этим
 * занимается вызывающая сторона, которой ещё нужно дописать свои заголовки.
 */
export async function handleMcpRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  server: McpServerDefinition,
): Promise<unknown> {
  if (req.method === 'DELETE') {
    // Завершение сессии. Состояния между запросами мок не держит вовсе,
    // поэтому удалять нечего — но код ответа обязан совпадать с боевым.
    return reply.code(200).send()
  }

  if (req.method !== 'POST') {
    // GET открывает поток «сервер → клиент». Мок инициативных сообщений
    // не шлёт, и держать ради этого висящее соединение незачем.
    reply.header('allow', 'POST, DELETE')
    return reply.code(405).type('application/json').send({
      jsonrpc: '2.0',
      error: { code: RPC.TRANSPORT, message: 'Method Not Allowed: use POST or DELETE' },
      id: null,
    })
  }

  if (!acceptsBoth(req.headers.accept)) {
    // Дословно как боевой сервер: обычным JSON, а не кадром SSE, — клиент,
    // не объявивший text/event-stream, кадра и не разберёт.
    return reply.code(406).type('application/json').send({
      jsonrpc: '2.0',
      error: {
        code: RPC.TRANSPORT,
        message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
      },
      id: null,
    })
  }

  const sessionId = sessionOf(req)
  reply.header('mcp-session-id', sessionId)
  reply.header('mcp-protocol-version', server.protocolVersion)

  const message = parseMessage(req.body)
  if (message === null) {
    return reply.code(400).type('application/json').send({
      jsonrpc: '2.0',
      error: { code: RPC.PARSE_ERROR, message: 'Parse error' },
      id: null,
    })
  }

  // Уведомление — сообщение без id. Ответа у него нет по определению протокола.
  if (message.id === undefined || message.id === null) {
    return reply.code(202).send()
  }

  let result: unknown
  try {
    result = await dispatch(req, server, message)
  } catch (error) {
    const rpc = error instanceof RpcError
      ? { code: error.code, message: error.message }
      : { code: RPC.INTERNAL_ERROR, message: (error as Error).message }
    return reply
      .code(200)
      .type('text/event-stream')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .send(sseFrame(sessionId, { jsonrpc: '2.0', id: message.id, error: rpc }))
  }

  return reply
    .code(200)
    .type('text/event-stream')
    .header('cache-control', 'no-cache, no-transform')
    .header('x-accel-buffering', 'no')
    // Порядок ключей тот же, что у боевого сервера: result, jsonrpc, id.
    .send(sseFrame(sessionId, { result, jsonrpc: '2.0', id: message.id }))
}

async function dispatch(
  req: FastifyRequest,
  server: McpServerDefinition,
  message: RpcRequest,
): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: server.protocolVersion,
        capabilities: server.capabilities,
        serverInfo: server.serverInfo,
        ...(server.instructions ? { instructions: server.instructions } : {}),
      }

    case 'ping':
      // Пустой объект — весь ответ по спецификации.
      return {}

    case 'tools/list':
      return { tools: await server.tools(req) }

    case 'tools/call': {
      const name = message.params?.name
      if (typeof name !== 'string') {
        throw new RpcError(RPC.INVALID_PARAMS, 'Invalid params: "name" is required')
      }
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>
      return await server.call(req, name, args)
    }

    // Ресурсы и подсказки объявлены в capabilities пустыми объектами —
    // это же делает боевой сервер, — поэтому список пуст, но метод существует.
    case 'resources/list':
      return { resources: [] }
    case 'prompts/list':
      return { prompts: [] }

    default:
      throw new RpcError(RPC.METHOD_NOT_FOUND, `Method not found: ${String(message.method)}`)
  }
}

/** Тело приходит уже разобранным Fastify либо Buffer'ом от парсера шлюза. */
function parseMessage(body: unknown): RpcRequest | null {
  if (body === null || body === undefined) return null
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8')) as RpcRequest
    } catch {
      return null
    }
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as RpcRequest
    } catch {
      return null
    }
  }
  if (typeof body === 'object' && !Array.isArray(body)) return body as RpcRequest
  return null
}

/**
 * Идентификатор сессии: присланный клиентом либо новый.
 *
 * Незнакомый идентификатор не отвергается — так же ведёт себя боевой сервер:
 * после DELETE тот же самый идентификатор продолжает работать, сервер просто
 * заводит сессию заново. Состояния за сессией у нас всё равно нет.
 */
function sessionOf(req: FastifyRequest): string {
  const raw = req.headers['mcp-session-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : randomUUID()
}

/** Заголовки, которые обязаны быть видны из браузера. Имена — из живого ответа Apify. */
export const MCP_EXPOSED_HEADERS = [
  'Mcp-Session-Id',
  'WWW-Authenticate',
  'Last-Event-Id',
  'Mcp-Protocol-Version',
] as const
