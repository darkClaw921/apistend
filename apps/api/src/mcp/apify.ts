import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyRequest } from 'fastify'
import { RpcError, RPC, type McpServerDefinition, type McpTool, type McpToolResult } from './transport.ts'
import { engine } from '../gateway.ts'
import { requestId } from '../lib/ids.ts'
import { actorSnapshot, findActor, searchActors, type ActorSnapshotEntry } from './apify-actors.ts'
import { actorOutputSource, sampleFromActorOutput, type ActorOutputSource } from './actor-output.ts'
import { recordedRuns, recordRun, runById, runByDatasetId } from './run-registry.ts'
import { runCost } from './run-cost.ts'

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

/**
 * Инструменты боевого сервера, которых нет в снимке.
 *
 * Снимок `specs/apify/mcp-tools.json` — это набор, который mcp.apify.com отдал
 * на дату снятия по умолчанию. `get-actor-run-list` в него не попал, а у боевого
 * сервера он есть, и клиенты им пользуются: фактическую стоимость прогона
 * (`usageTotalUsd`) отдаёт только список запусков, в карточке одного запуска
 * этого поля нет.
 *
 * Имя, описание и схема входа взяты у боевого сервера дословно, как и всё
 * остальное здесь. Схему выхода он для этого инструмента не объявляет, поэтому
 * её здесь нет: придуманная нами, она стала бы законом для клиента — SDK
 * валидирует ответ по объявленной схеме и отбросил бы законный ответ боевого
 * сервера, если наша догадка разошлась бы с ним хоть в одном поле.
 *
 * При следующем снятии снимка с токеном инструмент придёт из него сам и это
 * объявление можно будет убрать.
 */
const EXTRA_TOOLS: readonly McpTool[] = [
  {
    name: 'get-actor-run-list',
    inputSchema: {
      type: 'object',
      properties: {
        offset: {
          type: 'number',
          default: 0,
          description:
            'Number of array elements that should be skipped at the start. The default value is 0.',
        },
        limit: {
          type: 'number',
          default: 10,
          maximum: 10,
          description:
            'Maximum number of array elements to return. The default value (as well as the maximum) is 10.',
        },
        desc: {
          type: 'boolean',
          default: false,
          description:
            'If true or 1 then the runs are sorted by the startedAt field in descending order. ' +
            'Default: sorted in ascending order.',
        },
        status: {
          type: 'string',
          enum: [
            'READY', 'RUNNING', 'SUCCEEDED', 'FAILED',
            'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED',
          ],
          description: 'Return only runs with the provided status.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    description:
      'List Actor runs for the authenticated user with optional filtering and sorting.\n' +
      'The results will include run details (including defaultDatasetId and defaultKeyValueStoreId) ' +
      'and can be filtered by status.\n' +
      'Valid statuses: READY (not allocated), RUNNING (executing), SUCCEEDED (finished), ' +
      'FAILED (failed), TIMING-OUT, TIMED-OUT, ABORTING, ABORTED.\n\n' +
      'USAGE:\n' +
      '- Use when you need to browse or filter recent Actor runs.\n\n' +
      'USAGE EXAMPLES:\n' +
      '- user_input: List my last 10 runs (newest first)\n' +
      '- user_input: Show only SUCCEEDED runs',
  },
]

/**
 * Сколько «длился» запуск песочницы.
 *
 * Запуска не было, но время нужно: из него считаются compute units, а из них —
 * стоимость. Двенадцать секунд — правдоподобная длительность короткого прогона
 * скрапера, и она постоянна, чтобы стоимость одного и того же вызова не плавала.
 */
const RUN_TIME_SECS = 12

/** Потолок страницы списка запусков — как объявлено у боевого инструмента. */
const RUN_LIST_LIMIT = 10

/** Идентификатор «пользователя» песочницы: у боевых записей запуска он есть. */
const SANDBOX_USER_ID = 'apistendSandbox0'

/** Полный набор инструментов песочницы: снимок плюс то, чего в нём не оказалось. */
const ALL_TOOLS: readonly McpTool[] = [...vendored.tools, ...EXTRA_TOOLS]

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
  if (typeof raw !== 'string' || raw.trim().length === 0) return ALL_TOOLS

  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  return ALL_TOOLS.filter((t) => {
    if (wanted.has(t.name)) return true
    // Категории документации Apify: actors, docs, runs, storage, tasks.
    if (wanted.has('actors') && /actor/.test(t.name)) return true
    if (wanted.has('docs') && /docs/.test(t.name)) return true
    if (wanted.has('runs') && /run/.test(t.name)) return true
    if (wanted.has('storage') && /(dataset|key-value)/.test(t.name)) return true
    return false
  })
}

/**
 * Приписка к ответу запуска: откуда взялись строки.
 *
 * Пишется словами и в текст для модели, а не только в структуру: агент читает
 * именно текст, и без этой строки пустой результат он объяснит себе сам —
 * решит, что по запросу ничего не нашлось, и начнёт менять вход, которого
 * менять не нужно.
 */
const OUTPUT_SOURCE_NOTE: Record<ActorOutputSource, string> = {
  'dataset-schema':
    '_APIStend: это песочница, настоящего запуска не было. Строки собраны по схеме полей ' +
    'датасета из последней сборки актора — значения взяты из `examples`, которые написал ' +
    'его автор. Форма настоящая, значения демонстрационные._',
  'readme-examples':
    '_APIStend: это песочница, настоящего запуска не было. Строки — примеры результата, ' +
    'которые автор актора показал в readme: схему полей датасета он не объявил. ' +
    'Их ровно столько, сколько показал автор, — это не «данные кончились»._',
  none:
    '_APIStend: это песочница, настоящего запуска не было. Форму результата автор актора ' +
    'не описал ни схемой полей датасета, ни примером в readme, поэтому список пуст. ' +
    'Это не пустая выдача по запросу и не ошибка входа: менять вход бессмысленно._',
}

/**
 * Ответ инструмента: текст для модели плюс структура для строгого клиента.
 *
 * `structuredContent` обязан соответствовать `outputSchema` инструмента — той
 * самой, что снята с боевого сервера и уходит клиенту в tools/list. Официальный
 * MCP SDK валидирует ответ по ней и при расхождении ОТБРАСЫВАЕТ его целиком:
 * данные в ответе есть, а до вызывающего кода не доходят. Поэтому форма здесь
 * не «удобная», а объявленная, и её держит тест на всех инструментах разом.
 */
function result(text: string, structured: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  }
}

/**
 * Отказ инструмента.
 *
 * Без `structuredContent`: у неудачи нет формы, объявленной в `outputSchema`,
 * и конверт ошибки, положенный в это поле, клиент отверг бы вместе с текстом,
 * который ему как раз и нужно прочитать.
 */
function failure(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Карточка актора в форме, объявленной в outputSchema инструментов поиска. */
function actorInfo(actor: ActorSnapshotEntry): Record<string, unknown> {
  const [username = ''] = actor.name.split('/')
  const pricing = actor.pricing[0]
  return {
    title: actor.title,
    url: `https://apify.com/${actor.name}`,
    id: actor.id,
    fullName: actor.name,
    developer: {
      username,
      isOfficialApify: username === 'apify',
      url: `https://apify.com/${username}`,
    },
    description: actor.description,
    categories: [...actor.categories],
    isDeprecated: actor.isDeprecated,
    ...(pricing?.model ? { pricing: { model: pricing.model } } : {}),
    stats: {
      ...(actor.stats.totalUsers !== null ? { totalUsers: actor.stats.totalUsers } : {}),
      ...(actor.stats.totalUsers30Days !== null ? { monthlyUsers: actor.stats.totalUsers30Days } : {}),
    },
    ...(actor.stats.reviewRating !== null ? { rating: { average: actor.stats.reviewRating } } : {}),
  }
}

/**
 * Метаданные хранилищ запуска — блок `storages`, обязательный в схеме запуска.
 *
 * Ключ `default` есть всегда: так объявлено у боевого сервера, и клиент берёт
 * идентификатор датасета именно оттуда.
 */
function runStorages(
  datasetId: string,
  keyValueStoreId: string,
  items: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const fields = [...new Set(items.flatMap((item) => Object.keys(item)))]
  return {
    datasets: {
      default: {
        id: datasetId,
        itemCount: items.length,
        ...(fields.length > 0 ? { fields } : {}),
      },
    },
    keyValueStores: { default: { id: keyValueStoreId, keyCount: 0, keys: [] } },
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

/** Число из аргументов инструмента: клиенты присылают и `2`, и `"2"`. */
function numberArg(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
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
    'Снимок акторов не собран: запустите node scripts/vendor-apify-actors.mjs. ' +
    'Выдумывать акторов мок не станет.',
  )
}

/**
 * Что песочница дописывает к дословным instructions боевого сервера.
 *
 * Боевой текст не трогаем: по нему модель решает, как выбирать акторов и как
 * их запускать, и переписанный «близко к тексту» он перестал бы быть тем же
 * интерфейсом. Но молчать о подмене нельзя: агент, не знающий, что запуска
 * не было, объяснит демонстрационные строки себе сам — и запишет их в выводы
 * о рынке или начнёт чинить вход, с которым всё в порядке.
 *
 * Раздел идёт последним и подписан, чтобы его нельзя было спутать со словами
 * Apify.
 */
const SANDBOX_INSTRUCTIONS = [
  '',
  '---',
  '',
  '# APIStend sandbox (not Apify)',
  '',
  'This server is a sandbox that answers INSTEAD of `mcp.apify.com`. Nothing here',
  'touches the real Apify platform: no Actor is executed, no credits are spent,',
  'no request leaves the sandbox. Treat every value below as a demonstration of',
  'SHAPE, never as a fact about the real world — do not quote prices, ratings or',
  'counts from it as if they were scraped today.',
  '',
  '## Where the data comes from',
  '- Actors, their input schemas and dataset fields are a dated snapshot of the',
  '  real Apify Store, not invented listings.',
  '- `call-actor` validates the input against the actor\u2019s real input schema, so a',
  '  malformed call fails here exactly as it would in production — that is the',
  '  cheapest thing this sandbox gives you.',
  '- Run output comes from what the actor\u2019s author described, in this order:',
  '  the dataset field schema of the latest build; the example rows the author',
  '  showed in the readme; otherwise an EMPTY list. Every run reports which one',
  '  it used in `_apistend.outputSource`.',
  '- An empty `items` means "the author never described the output", not "the',
  '  query found nothing". Changing the input will not fill it.',
  '',
  '## Runs and datasets',
  'A run made with `call-actor` is remembered: `get-dataset-items` for its',
  '`datasetId` and `get-actor-run` for its `runId` return that same run, and',
  '`get-actor-run-list` lists the runs of this sandbox. Ids not produced here are',
  'refused rather than answered with a generic sample.',
  'The actual cost of a run (`usageTotalUsd`) is only in the run list, as in',
  'production; it is computed from the real store price of the Actor.',
  '',
  '## What refuses',
  'Tools that need the live network (`search-apify-docs`, `fetch-apify-docs`,',
  '`apify--rag-web-browser`, `apify--web-fetch`) refuse instead of inventing page',
  'text. `report-problem` is accepted locally and never reaches Apify support.',
  '',
  '## The REST API is mocked too',
  'The same sandbox serves `api.apify.com` v2 over HTTP under `/apify`, with the',
  'same paths and auth: `Authorization: Bearer <sandbox key>` or `?token=`. Both',
  '`/v2/acts/...` and `/v2/actors/...` work, as they do in production.',
].join('\n')

export const apifyMcpServer: McpServerDefinition = {
  // Вызовы этого сервера попадают в журнал песочницы как вызовы Apify: для
  // разработчика это тот же сервис, только другой протокол.
  requiresKey: true,
  logServiceCode: 'apify',
  upstreamUrl: 'https://mcp.apify.com',
  protocolVersion: vendored.protocolVersion,
  // serverInfo и capabilities сняты с боевого сервера: по ним клиент решает,
  // что сервер умеет, и подменённое здесь имя сломало бы совместимость сразу.
  serverInfo: vendored.serverInfo,
  capabilities: vendored.capabilities,
  // Дословные instructions боевого сервера плюс раздел о том, что это песочница.
  instructions: vendored.instructions + SANDBOX_INSTRUCTIONS,

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
          actors: found.items.map(actorInfo),
          query: keywords,
          count: found.items.length,
          instructions:
            'Результаты отдала песочница APIStend вместо mcp.apify.com: это снимок ' +
            'магазина Apify, а не живой поиск. Запуск актора здесь тоже не выполняется.',
        })
      }

      case 'fetch-actor-details': {
        if (!actorSnapshot()) noSnapshot()
        const wanted = requireString(args, 'actor')
        const actor = findActor(wanted)
        if (!actor) {
          // Боевой Apify на неизвестного актора отвечает ошибкой, а не пустотой,
          // и агент, обрабатывающий этот случай, обязан увидеть здесь то же самое.
          return failure(`Actor "${wanted}" was not found.`)
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
          actorInfo: actorInfo(actor),
          ...(actor.readmeSummary ? { readme: actor.readmeSummary } : {}),
          ...(actor.inputSchema ? { inputSchema: actor.inputSchema } : {}),
          ...(actor.outputSchema ? { outputSchema: actor.outputSchema } : {}),
        })
      }

      case 'call-actor': {
        if (!actorSnapshot()) noSnapshot()
        const wanted = requireString(args, 'actor')
        const actor = findActor(wanted)
        if (!actor) {
          return failure(`Actor "${wanted}" was not found.`)
        }
        const input = (args.input ?? {}) as Record<string, unknown>
        // Вход проверяется по НАСТОЯЩЕЙ схеме актора: именно здесь мок и полезен —
        // агент, собравший вход неверно, узнаёт об этом бесплатно и сразу,
        // а не после платного запуска.
        const missing = requiredInputMissing(actor, input)
        if (missing.length > 0) {
          return failure(`Invalid input: missing required field(s): ${missing.join(', ')}.`)
        }

        const seed = `${actor.name}|${JSON.stringify(input)}`
        const runId = mockId('run', seed)
        const datasetId = mockId('dataset', seed)
        const keyValueStoreId = mockId('kvs', seed)
        const output = sampleFromActorOutput(actor, input, seed)
        const items = output.items
        const now = new Date()
        const source = actorOutputSource(actor)
        const startedAt = new Date(now.getTime() - RUN_TIME_SECS * 1000).toISOString()
        const cost = runCost({ actor, itemCount: items.length, runTimeSecs: RUN_TIME_SECS })
        const run = {
          runId,
          actorId: actor.id,
          actorName: actor.name,
          status: 'SUCCEEDED',
          startedAt,
          finishedAt: now.toISOString(),
          stats: { runTimeSecs: RUN_TIME_SECS, computeUnits: cost.computeUnits },
          storages: runStorages(datasetId, keyValueStoreId, items),
          summary:
            `Actor ${actor.name} finished with status SUCCEEDED and produced ` +
            `${items.length} item(s) in dataset ${datasetId}.`,
          nextStep: `Call get-dataset-items with datasetId "${datasetId}" to read the results.`,
          // Служебное поле песочницы. Имя с подчёркиванием — чтобы клиент, читающий
          // боевую форму ответа, не принял его за поле Apify.
          _apistend: {
            sandbox: true,
            outputSource: source,
            // Значения полей: из общего каталога товаров песочницы или из того,
            // что показал автор актора.
            values: output.fromCatalog ? 'apistend-catalog' : 'actor-author',
            ...(output.fromCatalog ? { matchedQuery: output.matchedQuery } : {}),
          },
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
          '',
          OUTPUT_SOURCE_NOTE[source],
          ...(output.fromCatalog
            ? [
                output.matchedQuery
                  ? '_Значения полей — из общего каталога товаров APIStend, отобранного по ' +
                    'поисковой фразе запроса. Те же артикулы отдают моки Wildberries и Ozon._'
                  : '_Значения полей — из общего каталога товаров APIStend. По поисковой фразе ' +
                    'запроса в нём совпадений не нашлось, поэтому товары взяты произвольные._',
              ]
            : []),
        ].join('\n')
        // Тот же запуск в форме RunShort из OpenAPI Apify: её отдаёт список
        // запусков, и только там есть фактическая стоимость прогона.
        const short = {
          id: runId,
          actId: actor.id,
          userId: SANDBOX_USER_ID,
          actorTaskId: null,
          status: 'SUCCEEDED',
          startedAt,
          finishedAt: now.toISOString(),
          buildId: mockId('build', seed),
          buildNumber: actor.buildNumber ?? '0.0.1',
          meta: { origin: 'API' },
          usageTotalUsd: cost.usageTotalUsd,
          defaultKeyValueStoreId: keyValueStoreId,
          defaultDatasetId: datasetId,
          defaultRequestQueueId: mockId('queue', seed),
        }
        // Запуск запоминается: следующий вызов агента — get-dataset-items по
        // этому датасету, и он обязан вернуть те же строки, а не образец REST.
        recordRun({ run, short, datasetId, items })
        return result(text, run)
      }

      case 'report-problem': {
        // Обращение в поддержку Apify. Наружу оно из песочницы не уходит —
        // и делать вид, что ушло, нельзя: пользователь ждал бы ответа.
        requireString(args, 'message')
        // reported объявлено как «always true», но здесь оно честно false:
        // обращение никуда не ушло, и соврать в единственном поле ответа значило бы
        // оставить пользователя ждать ответа, которого не будет.
        return result(
          'Обращение принято песочницей APIStend и в поддержку Apify НЕ отправлено: ' +
          'мок наружу не ходит. В бою этот инструмент создаёт обращение.',
          { reported: false },
        )
      }

      case 'get-actor-run': {
        const recorded = runById(requireString(args, 'runId'))
        if (recorded) return result(JSON.stringify(recorded.run, null, 2), recorded.run)
        // Идентификатор не из этой песочницы: запуска с такими данными не было,
        // и придумывать ему хранилища значило бы отдать агенту ссылку в никуда.
        return failure(
          `Run "${String(args.runId)}" was not started in this sandbox. ` +
          'Start one with call-actor and use the runId it returns.',
        )
      }

      case 'get-dataset-items': {
        const datasetId = requireString(args, 'datasetId')
        const recorded = runByDatasetId(datasetId)
        if (!recorded) {
          return failure(
            `Dataset "${datasetId}" does not belong to a run made in this sandbox. ` +
            'Start one with call-actor and use the datasetId it returns.',
          )
        }
        // offset и limit — как у боевого инструмента: их и передаёт клиент,
        // разбирающий выдачу по частям.
        const offset = numberArg(args.offset) ?? 0
        const limit = numberArg(args.limit) ?? recorded.items.length
        const page = recorded.items.slice(offset, offset + limit)
        return result(JSON.stringify(page, null, 2), {
          datasetId,
          items: page,
          itemCount: page.length,
          totalItemCount: recorded.items.length,
          offset,
          limit,
          summary: `Returned ${page.length} of ${recorded.items.length} item(s) from dataset ${datasetId}.`,
          nextStep:
            offset + page.length < recorded.items.length
              ? `Call get-dataset-items again with offset ${offset + page.length}.`
              : 'All items were returned; no further calls are needed.',
        })
      }

      case 'abort-actor-run': {
        const recorded = runById(requireString(args, 'runId'))
        if (!recorded) {
          return failure(
            `Run "${String(args.runId)}" was not started in this sandbox. ` +
            'Start one with call-actor and use the runId it returns.',
          )
        }
        // Запуск в песочнице завершается мгновенно, прерывать нечего — и боевой
        // Apify на прерывание завершённого запуска отвечает тем же: его текущим
        // состоянием, а не выдуманным ABORTED.
        const aborted = {
          ...recorded.run,
          summary: `Run ${recorded.run.runId} had already finished; nothing to abort.`,
          nextStep: `Call get-dataset-items with datasetId "${recorded.datasetId}" to read the results.`,
        }
        return result(JSON.stringify(aborted, null, 2), aborted)
      }

      case 'get-actor-run-list': {
        // Запуски этой песочницы, в форме RunShort из OpenAPI Apify — с
        // фактической стоимостью, которой в карточке одного запуска нет.
        const status = typeof args.status === 'string' ? args.status : null
        const all = recordedRuns()
          .map((entry) => entry.short)
          .filter((entry) => (status ? entry.status === status : true))
        // По умолчанию — по возрастанию startedAt, как и объявлено во входе.
        const sorted = args.desc === true || args.desc === 1 ? [...all].reverse() : all
        const offset = numberArg(args.offset) ?? 0
        const limit = Math.min(numberArg(args.limit) ?? RUN_LIST_LIMIT, RUN_LIST_LIMIT)
        const page = sorted.slice(offset, offset + limit)
        const body = { total: sorted.length, offset, limit, desc: args.desc === true, count: page.length, items: page }
        return result(JSON.stringify(body, null, 2), body)
      }

      case 'get-key-value-store-record': {
        const storeId = requireString(args, 'keyValueStoreId')
        const key = requireString(args, 'recordKey')
        const answer = throughEngine(
          'GET',
          `/v2/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`,
          args,
        )
        const value = answer.structuredContent
        return result(answer.content[0]?.text ?? '', {
          keyValueStoreId: storeId,
          key,
          value,
          contentType: 'application/json',
          summary: `Returned record "${key}" from key-value store ${storeId}.`,
        })
      }

      default: {
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
