import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyRequest } from 'fastify'
import { RpcError, RPC, type McpServerDefinition, type McpTool, type McpToolResult } from './transport.ts'
import { engine } from '../gateway.ts'
import { requestId } from '../lib/ids.ts'
import { actorSnapshot, findActor, searchActors, type ActorSnapshotEntry } from './apify-actors.ts'
import { sampleFromActorOutput } from './actor-output.ts'

/**
 * Мок MCP-сервера Apify.
 *
 * Смысл тот же, что у мока REST: клиент меняет адрес `https://mcp.apify.com`
 * на адрес песочницы и продолжает работать. Только «клиент» здесь — ИИ-агент
 * или редактор, а цена настоящего вызова выше обычной: каждый запуск актора
 * у боевого Apify стоит денег и минуты ожидания. Разработчику агента именно это
 * и мешает — гонять свой цикл по кругу, платя за чужие вычисления.
 *
 * Откуда взято ВСЁ, что здесь отдаётся:
 *   • список инструментов, их схемы входа и выхода, serverInfo, capabilities
 *     и instructions — сняты дословно с боевого mcp.apify.com
 *     (specs/apify/mcp-tools.json, scripts/vendor-apify-mcp-tools.sh);
 *   • акторы, их схемы входа и поля датасета — сняты с боевого API
 *     (specs/apify/actors.json, scripts/vendor-apify-actors.mjs);
 *   • ответы инструментов, за которыми стоит метод REST, собирает тот же движок,
 *     что отвечает на REST-вызовы шлюза.
 *
 * Ничего выдуманного здесь нет. Инструмент, которому нужна живая сеть
 * (поиск по документации, загрузка страницы), честно отвечает отказом,
 * а не подсовывает правдоподобный текст: молчаливый выход в интернет
 * превратил бы песочницу в прокси к боевому сервису.
 */

const here = dirname(fileURLToPath(import.meta.url))
const VENDORED = join(here, '../../../../specs/apify/mcp-tools.json')

interface VendoredTools {
  readonly protocolVersion: string
  readonly serverInfo: Record<string, unknown>
  readonly capabilities: Record<string, unknown>
  readonly instructions: string
  readonly tools: readonly McpTool[]
}

const vendored: VendoredTools = JSON.parse(readFileSync(VENDORED, 'utf8')) as VendoredTools

/** Идентификаторы, которые мок выдаёт вместо настоящих: 17 знаков алфавита Apify. */
function mockId(prefix: string, seed: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let h = 2_166_136_261
  for (const ch of `${prefix}:${seed}`) h = Math.imul(h ^ ch.charCodeAt(0), 16_777_619) >>> 0
  let out = ''
  for (let i = 0; i < 17; i++) {
    h = Math.imul(h ^ (h >>> 13), 16_777_619) >>> 0
    out += alphabet[h % alphabet.length]
  }
  return out
}

/** Инструменты, за которыми стоит метод каталога REST. */
const REST_BACKED: Record<string, { method: string; path: (a: Record<string, unknown>) => string }> = {
  'get-actor-run': {
    method: 'GET',
    path: (a) => `/v2/actor-runs/${encodeURIComponent(String(a.runId))}`,
  },
  'get-dataset-items': {
    method: 'GET',
    path: (a) => `/v2/datasets/${encodeURIComponent(String(a.datasetId))}/items`,
  },
  'get-key-value-store-record': {
    method: 'GET',
    path: (a) =>
      `/v2/key-value-stores/${encodeURIComponent(String(a.keyValueStoreId))}` +
      `/records/${encodeURIComponent(String(a.recordKey))}`,
  },
  'abort-actor-run': {
    method: 'POST',
    path: (a) => `/v2/actor-runs/${encodeURIComponent(String(a.runId))}/abort`,
  },
}

/**
 * Инструменты, которым нужна живая сеть.
 *
 * Поиск по документации и загрузка страниц — не мок, а обращение наружу.
 * Песочница обязана работать без интернета, и подсунуть сюда выдуманный текст
 * страницы значило бы отдать агенту данные, которых не существует.
 */
const NEEDS_LIVE_NETWORK = new Set([
  'search-apify-docs',
  'fetch-apify-docs',
  'apify--rag-web-browser',
  'apify--web-fetch',
])

/**
 * Какие инструменты показывать.
 *
 * Параметр `tools` работает как у боевого сервера: через запятую — категории
 * или имена конкретных инструментов. Без параметра отдаётся весь снятый набор.
 */
function selectTools(req: FastifyRequest): readonly McpTool[] {
  const raw = (req.query as Record<string, unknown> | undefined)?.tools
  if (typeof raw !== 'string' || raw.trim().length === 0) return vendored.tools

  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  return vendored.tools.filter((t) => {
    if (wanted.has(t.name)) return true
    // Категории документации Apify: actors, docs, runs, storage, tasks.
    if (wanted.has('actors') && /actor/.test(t.name)) return true
    if (wanted.has('docs') && /docs/.test(t.name)) return true
    if (wanted.has('runs') && /run/.test(t.name)) return true
    if (wanted.has('storage') && /(dataset|key-value)/.test(t.name)) return true
    return false
  })
}

/** Ответ инструмента: текст для модели плюс структура для строгого клиента. */
function result(text: string, structured: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  }
}

/** Через движок моков — теми же телами, что отдаёт REST-шлюз. */
function throughEngine(httpMethod: string, path: string, body: unknown): McpToolResult {
  const answer = engine.handle({
    service: 'apify',
    httpMethod,
    path,
    query: {},
    headers: {},
    body: httpMethod === 'GET' ? null : body,
    requestId: requestId(),
    scenario: 'success',
    now: new Date(),
    // Соль датасета фиксирована: у MCP-запроса нет песочницы, а значит и её объёма.
    // Следствие видно снаружи и оно предсказуемо: ответ совпадает с REST-ответом
    // песочницы среднего объёма.
    salt: 'medium',
  })
  return result(answer.serialized, answer.body, answer.responseSource === 'error')
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(RPC.INVALID_PARAMS, `Invalid params: "${name}" is required`)
  }
  return value
}

/** Карточка актора в том виде, в каком её показывает боевой инструмент. */
function actorCard(actor: ActorSnapshotEntry): string {
  const lines = [
    `## [${actor.title}](https://apify.com/${actor.name}) (\`${actor.name}\`)`,
    `- **URL:** https://apify.com/${actor.name}`,
    `- **Description:** ${actor.description}`,
  ]
  if (actor.stats.totalUsers !== null) lines.push(`- **Total users:** ${actor.stats.totalUsers}`)
  if (actor.stats.reviewRating !== null) {
    lines.push(`- **Rating:** ${actor.stats.reviewRating.toFixed(2)}`)
  }
  const pricing = actor.pricing[0]
  if (pricing?.model) lines.push(`- **Pricing model:** ${pricing.model}`)
  if (actor.isDeprecated) lines.push('- **Deprecated:** yes')
  return lines.join('\n')
}

function noSnapshot(): never {
  throw new RpcError(
    RPC.INTERNAL_ERROR,
    'Снимок акторов не собран: запустите APIFY_TOKEN=… node scripts/vendor-apify-actors.mjs. ' +
    'Выдумывать акторов мок не станет.',
  )
}

export const apifyMcpServer: McpServerDefinition = {
  protocolVersion: vendored.protocolVersion,
  // serverInfo и capabilities сняты с боевого сервера: по ним клиент решает,
  // что сервер умеет, и подменённое здесь имя сломало бы совместимость сразу.
  serverInfo: vendored.serverInfo,
  capabilities: vendored.capabilities,
  instructions: vendored.instructions,

  tools: (req) => selectTools(req),

  call(req, name, args) {
    const available = selectTools(req)
    if (!available.some((t) => t.name === name)) {
      // Формулировка и код — как у боевого сервера: клиент, разбирающий текст
      // ошибки, не должен увидеть здесь другую фразу.
      throw new RpcError(
        RPC.INVALID_PARAMS,
        `MCP error ${RPC.INVALID_PARAMS}: Tool "${name}" was not found.\n` +
        `Available tools: ${available.map((t) => t.name).join(', ')}.\n` +
        'Please verify the tool name is correct. You can list all available tools using the tools/list request.',
      )
    }

    if (NEEDS_LIVE_NETWORK.has(name)) {
      throw new RpcError(
        RPC.INTERNAL_ERROR,
        `Инструмент «${name}» обращается к живой сети (документация apify.com либо ` +
        'загрузка страницы), и в песочнице он не выполняется: подставить сюда ' +
        'правдоподобный текст значило бы отдать агенту данные, которых нет. ' +
        'Инструменты работы с акторами, запусками и хранилищами работают полностью.',
      )
    }

    switch (name) {
      case 'search-actors': {
        if (!actorSnapshot()) noSnapshot()
        const keywords = typeof args.keywords === 'string' ? args.keywords : ''
        const limit = Math.min(Number(args.limit ?? 10) || 10, 100)
        const offset = Number(args.offset ?? 0) || 0
        const found = searchActors(keywords, limit, offset)
        const text = [
          '# Search results:',
          `- **Search query:** ${keywords}`,
          `- **Number of Actors found:** ${found.items.length}`,
          '',
          '# Actors:',
          '',
          ...found.items.map(actorCard),
        ].join('\n')
        return result(text, {
          total: found.total,
          actors: found.items.map((a) => ({
            id: a.id,
            name: a.name,
            title: a.title,
            description: a.description,
            url: `https://apify.com/${a.name}`,
            categories: a.categories,
            stats: a.stats,
            pricing: a.pricing,
          })),
        })
      }

      case 'fetch-actor-details': {
        if (!actorSnapshot()) noSnapshot()
        const wanted = requireString(args, 'actor')
        const actor = findActor(wanted)
        if (!actor) {
          // Боевой Apify на неизвестного актора отвечает ошибкой, а не пустотой,
          // и агент, обрабатывающий этот случай, обязан увидеть здесь то же самое.
          return result(
            `Actor "${wanted}" was not found.`,
            { error: { type: 'record-not-found', message: `Actor "${wanted}" was not found.` } },
            true,
          )
        }
        const text = [
          actorCard(actor),
          '',
          '### Input schema',
          '```json',
          JSON.stringify(actor.inputSchema ?? { note: 'у актора нет собранной версии со схемой входа' }, null, 2),
          '```',
          ...(actor.readmeSummary ? ['', '### Summary', actor.readmeSummary] : []),
        ].join('\n')
        return result(text, {
          id: actor.id,
          name: actor.name,
          title: actor.title,
          description: actor.description,
          inputSchema: actor.inputSchema,
          outputSchema: actor.outputSchema,
          datasetFields: actor.datasetFields,
          defaultRunOptions: actor.defaultRunOptions,
          exampleRunInput: actor.exampleRunInput,
          pricing: actor.pricing,
          stats: actor.stats,
        })
      }

      case 'call-actor': {
        if (!actorSnapshot()) noSnapshot()
        const wanted = requireString(args, 'actor')
        const actor = findActor(wanted)
        if (!actor) {
          return result(
            `Actor "${wanted}" was not found.`,
            { error: { type: 'record-not-found', message: `Actor "${wanted}" was not found.` } },
            true,
          )
        }
        const input = (args.input ?? {}) as Record<string, unknown>
        // Вход проверяется по НАСТОЯЩЕЙ схеме актора: именно здесь мок и полезен —
        // агент, собравший вход неверно, узнаёт об этом бесплатно и сразу,
        // а не после платного запуска.
        const missing = requiredInputMissing(actor, input)
        if (missing.length > 0) {
          return result(
            `Invalid input: missing required field(s): ${missing.join(', ')}.`,
            {
              error: {
                type: 'invalid-input',
                message: `Missing required field(s): ${missing.join(', ')}`,
                requiredFields: missing,
              },
            },
            true,
          )
        }

        const seed = `${actor.name}|${JSON.stringify(input)}`
        const runId = mockId('run', seed)
        const datasetId = mockId('dataset', seed)
        const items = sampleFromActorOutput(actor, input, seed)
        const now = new Date()
        const run = {
          id: runId,
          actId: actor.id,
          status: 'SUCCEEDED',
          startedAt: new Date(now.getTime() - 12_000).toISOString(),
          finishedAt: now.toISOString(),
          defaultDatasetId: datasetId,
          defaultKeyValueStoreId: mockId('kvs', seed),
          buildNumber: actor.buildNumber ?? '0.0.1',
        }
        const text = [
          `Actor \`${actor.name}\` finished with status SUCCEEDED.`,
          `- **Run ID:** ${runId}`,
          `- **Dataset ID:** ${datasetId}`,
          `- **Items:** ${items.length}`,
          '',
          '```json',
          JSON.stringify(items.slice(0, 3), null, 2),
          '```',
        ].join('\n')
        return result(text, { run, datasetId, items })
      }

      case 'report-problem': {
        // Обращение в поддержку Apify. Наружу оно из песочницы не уходит —
        // и делать вид, что ушло, нельзя: пользователь ждал бы ответа.
        requireString(args, 'message')
        return result(
          'Обращение принято песочницей APIStend и в поддержку Apify НЕ отправлено: ' +
          'мок наружу не ходит. В бою этот инструмент создаёт обращение.',
          { delivered: false, sandbox: true },
        )
      }

      default: {
        const backing = REST_BACKED[name]
        if (backing) {
          for (const required of (vendored.tools.find((t) => t.name === name)?.inputSchema
            .required ?? []) as string[]) {
            requireString(args, required)
          }
          return throughEngine(backing.method, backing.path(args), args)
        }
        throw new RpcError(RPC.METHOD_NOT_FOUND, `Tool "${name}" не реализован в песочнице`)
      }
    }
  },
}

/**
 * Обязательные поля входа, которых в вызове нет.
 *
 * Проверяется только верхний уровень и только required: полная валидация по
 * JSON Schema — работа клиента, а мок обязан ловить ровно ту ошибку, которую
 * в бою ловит сам Apify, отказываясь запускать актора.
 */
function requiredInputMissing(actor: ActorSnapshotEntry, input: Record<string, unknown>): string[] {
  const schema = actor.inputSchema as { required?: unknown } | null
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : []
  return required.filter((field) => input[field] === undefined)
}
