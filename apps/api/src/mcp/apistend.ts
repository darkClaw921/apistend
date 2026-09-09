import type { FastifyRequest } from 'fastify'
import { SERVICE_LIST, SERVICE_PROFILES, isServiceCode, type ServiceCode } from '@apistend/shared'
import { RpcError, RPC, type McpServerDefinition, type McpTool, type McpToolResult } from './transport.ts'
import { engine } from '../gateway.ts'
import { extractRawKey, resolveApiKey } from '../lib/api-key.ts'
import { gatewayRequestId } from '../lib/ids.ts'
import { prisma } from '../db.ts'

/**
 * Собственный MCP-сервер APIStend.
 *
 * Отдельная сущность от мока Apify, и путать их не нужно. Мок Apify отвечает
 * ВМЕСТО mcp.apify.com. Этот сервер — про сам APIStend: он даёт ИИ-агенту то же,
 * что кабинет даёт человеку, — найти метод в каталоге, дёрнуть мок, посмотреть,
 * что записалось в журнал.
 *
 * Зачем это нужно. Разработчик всё чаще пишет интеграцию не руками, а с агентом,
 * и агенту негде узнать, какие у Ozon есть методы и что они возвращают: живую
 * документацию он не откроет (антибот), а гадать по названиям — то самое, от чего
 * этот проект и уводит. Каталог APIStend уже содержит 2400 разобранных методов
 * с примерами ответов; MCP делает его доступным агенту напрямую.
 *
 * Авторизация — тем же ключом песочницы `stend_sk_…`, что и мок-шлюз: заголовком
 * Authorization: Bearer. Отдельного вида токена не заводится намеренно — у ключа
 * уже есть и песочница, и список разрешённых сервисов, и отзыв.
 */

const TOOLS: readonly McpTool[] = [
  {
    name: 'list_services',
    title: 'Список сервисов',
    description:
      'Возвращает сервисы, которые мокает APIStend: код, боевой адрес, префикс пути ' +
      'песочницы, схему авторизации, лимиты и политику вебхуков. С этого стоит начинать: ' +
      'здесь видно, чем именно подменяется боевой адрес.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'search_catalog',
    title: 'Поиск метода в каталоге',
    description:
      'Ищет методы по названию, пути и описанию. Возвращает готовность мока и то, ' +
      'откуда взят ответ: example — пример из документации сервиса, schema — генерация ' +
      'по схеме, generic — пустой валидный конверт.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Слова для поиска: часть пути, имени метода или описания' },
        service: {
          type: 'string',
          enum: [...SERVICE_LIST.map((s) => s.code)],
          description: 'Ограничить одним сервисом',
        },
        limit: { type: 'integer', description: 'Сколько методов вернуть, по умолчанию 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe_method',
    title: 'Карточка метода',
    description:
      'Возвращает полное описание метода: параметры, сценарии ошибок, боевой хост, ' +
      'дату снимка спецификации и пример успешного ответа.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: [...SERVICE_LIST.map((s) => s.code)] },
        httpMethod: { type: 'string', description: 'GET, POST и так далее' },
        path: { type: 'string', description: 'Путь без префикса сервиса, например /v3/posting/fbs/list' },
      },
      required: ['service', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_mock',
    title: 'Вызов мока',
    description:
      'Вызывает метод мока и возвращает тело ответа вместе с боевыми заголовками сервиса. ' +
      'Это тот же ответ, который получит клиентская библиотека, подменившая базовый адрес.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: [...SERVICE_LIST.map((s) => s.code)] },
        httpMethod: { type: 'string', description: 'По умолчанию GET' },
        path: { type: 'string', description: 'Путь без префикса сервиса' },
        body: { type: 'object', description: 'Тело запроса для POST и PUT' },
        scenario: {
          type: 'string',
          enum: ['success', 'invalid_token', 'not_found', 'rate_limit', 'server_error'],
          description: 'Какой сценарий отработать. По умолчанию success',
        },
      },
      required: ['service', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'recent_requests',
    title: 'Журнал запросов песочницы',
    description:
      'Последние запросы к моку этой песочницы: метод, код ответа, длительность и сценарий. ' +
      'Нужен агенту, чтобы увидеть, что именно ушло в шлюз из отлаживаемого кода.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Сколько записей вернуть, по умолчанию 20' },
        service: { type: 'string', enum: [...SERVICE_LIST.map((s) => s.code)] },
      },
      required: [],
      additionalProperties: false,
    },
  },
]

/** Ключ песочницы из запроса. Тот же разбор, что у мок-шлюза. */
async function sandboxOf(req: FastifyRequest) {
  const rawKey = extractRawKey(
    req.headers as Record<string, string | string[] | undefined>,
    (req.query ?? {}) as Record<string, unknown>,
    '',
    null,
  )
  if (!rawKey) {
    throw new RpcError(
      RPC.INVALID_PARAMS,
      'Нужен ключ песочницы: заголовок Authorization: Bearer stend_sk_… ' +
      'Ключ создаётся на экране «Ключи и токены».',
    )
  }
  const resolved = await resolveApiKey(rawKey)
  if (!resolved) {
    throw new RpcError(RPC.INVALID_PARAMS, 'Ключ неизвестен или отозван.')
  }
  if (!resolved.sandbox.mcpEnabled) {
    // Отказ намеренно объясняет, где включить: агент передаст это человеку,
    // а «доступ запрещён» без продолжения заставило бы искать причину вслепую.
    throw new RpcError(
      RPC.INVALID_PARAMS,
      'Доступ по MCP для этой песочницы выключен. Включите его в кабинете APIStend, ' +
      'раздел «Настройки» → «Доступ для ИИ-агента». Открытая часть — каталог методов — ' +
      'работает и без включения: list_services, search_catalog, describe_method.',
    )
  }
  return resolved
}

function text(value: string, structured: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: value }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  }
}

function requireService(args: Record<string, unknown>): ServiceCode {
  const value = args.service
  if (!isServiceCode(value)) {
    throw new RpcError(
      RPC.INVALID_PARAMS,
      `Неизвестный сервис. Доступны: ${SERVICE_LIST.map((s) => s.code).join(', ')}`,
    )
  }
  return value
}

export const apistendMcpServer: McpServerDefinition = {
  protocolVersion: '2025-06-18',
  serverInfo: {
    name: 'apistend',
    title: 'APIStend',
    version: '1.0.0',
    description: 'Демо-копии боевых API: Bitrix24, Ozon Seller, Wildberries и Apify',
    websiteUrl: 'https://apistend.ru/docs',
  },
  // Ресурсы и подсказки не объявляем: их у сервера нет, а пустая заявка в
  // capabilities заставила бы клиента ходить за списком, которого не существует.
  capabilities: { tools: {} },
  instructions:
    'APIStend отдаёт демо-копии боевых API вместо самих сервисов. Разработчик подменяет ' +
    'базовый адрес и работает с песочницей, не трогая боевой аккаунт.\n\n' +
    'Порядок работы: list_services — чем что подменяется; search_catalog — найти метод; ' +
    'describe_method — его параметры и пример ответа; call_mock — дёрнуть и посмотреть тело.\n\n' +
    'Ответы моков повторяются побайтово в пределах суток: даты в них живут относительно ' +
    'сегодняшнего дня, поэтому назавтра уезжают на сутки вперёд. ' +
    'Поле responseSource говорит, чему верить: example — значения из документации сервиса, ' +
    'schema — форма из спецификации при выдуманных значениях, generic — только то, ' +
    'что клиент не упадёт на разборе.\n\n' +
    'Данные демонстрационные: настоящих заказов, товаров и сделок за ними нет. ' +
    'Форма ответа настоящая, значения — нет; выводов о рынке или об аккаунте ' +
    'по ним делать нельзя.\n\n' +
    'У Apify, кроме REST, замокан и его MCP-сервер: адрес /apify/mcp отвечает вместо ' +
    'mcp.apify.com тем же набором инструментов, с настоящими схемами входа акторов. ' +
    'Запуск актора там не выполняется: форму строки задаёт схема полей датасета ' +
    'или пример из readme актора, а если он не описал результат никак — список ' +
    'пуст, и менять вход бессмысленно. Значения товарных полей берутся из того же ' +
    'общего каталога, из которого отвечают моки Wildberries и Ozon, поэтому выдача ' +
    'зависит от поисковой фразы и запрошенного количества. ' +
    'Каждый запуск сообщает источник в поле _apistend.',

  tools: () => TOOLS,

  async call(req, name, args) {
    switch (name) {
      case 'list_services': {
        const services = SERVICE_LIST.map((p) => ({
          code: p.code,
          title: p.title,
          replaces: p.replacesUrl,
          mountPath: p.mountPath,
          apiVersion: p.apiVersion,
          auth: p.nativeAuth.description,
          rateLimit: p.rateLimit.description,
          methodsInCatalog: engine.catalog(p.code).length,
          webhookNotes: p.webhook.notes,
          // Мок MCP есть пока только у Apify — единственного из четырёх, у кого
          // MCP-сервер есть и в бою.
          mcpPath: p.code === 'apify' ? '/apify/mcp' : null,
        }))
        return text(
          services
            .map((s) =>
              `${s.code} — ${s.title}\n  вместо ${s.replaces}, путь ${s.mountPath}, методов ${s.methodsInCatalog}\n` +
              `  авторизация: ${s.auth}\n  лимит: ${s.rateLimit}` +
              (s.mcpPath ? `\n  MCP: ${s.mcpPath} — вместо mcp.apify.com, тем же ключом` : ''),
            )
            .join('\n\n'),
          { services },
        )
      }

      case 'search_catalog': {
        const query = String(args.query ?? '').trim().toLowerCase()
        if (query.length === 0) throw new RpcError(RPC.INVALID_PARAMS, '«query» обязателен')
        const limit = Math.min(Number(args.limit ?? 20) || 20, 100)
        const only = isServiceCode(args.service) ? args.service : null
        const terms = query.split(/\s+/).filter(Boolean)

        const found: Array<Record<string, unknown>> = []
        for (const profile of SERVICE_LIST) {
          if (only && profile.code !== only) continue
          for (const m of engine.catalog(profile.code)) {
            const haystack = `${m.path} ${m.title} ${m.description} ${m.group}`.toLowerCase()
            if (!terms.every((t) => haystack.includes(t))) continue
            found.push({
              service: m.serviceCode,
              httpMethod: m.httpMethod,
              path: m.path,
              title: m.title,
              group: m.group,
              readiness: m.readiness,
              responseSource: m.responseSource,
              deprecated: m.deprecated,
            })
            if (found.length >= limit) break
          }
          if (found.length >= limit) break
        }

        return text(
          found.length === 0
            ? `По запросу «${args.query}» методов не найдено.`
            : found.map((m) => `${m.service} ${m.httpMethod} ${m.path} — ${m.title} (${m.responseSource})`).join('\n'),
          { total: found.length, methods: found },
        )
      }

      case 'describe_method': {
        const service = requireService(args)
        const path = String(args.path ?? '')
        const httpMethod = String(args.httpMethod ?? '').toUpperCase()
        const method = engine
          .catalog(service)
          .find((m) => m.path === path && (httpMethod === '' || m.httpMethod === httpMethod))
        if (!method) {
          return text(`Метод ${service} ${httpMethod} ${path} в каталоге не найден.`, { found: false }, true)
        }
        return text(
          [
            `${method.httpMethod} ${method.path} — ${method.title}`,
            method.description,
            `Раздел: ${method.group}`,
            `Готовность мока: ${method.readiness}, источник ответа: ${method.responseSource}`,
            `Боевой хост: ${method.upstreamHost}, снимок спецификации ${method.snapshotDate}`,
            '',
            'Параметры:',
            ...method.params.map((p) => `  ${p.name} (${p.in}, ${p.type})${p.required ? ' — обязателен' : ''}`),
          ].join('\n'),
          {
            found: true,
            method: {
              service: method.serviceCode,
              httpMethod: method.httpMethod,
              path: method.path,
              title: method.title,
              description: method.description,
              group: method.group,
              readiness: method.readiness,
              responseSource: method.responseSource,
              upstreamHost: method.upstreamHost,
              snapshotDate: method.snapshotDate,
              sourceUrl: method.sourceUrl,
              deprecated: method.deprecated,
              params: method.params,
              scenarios: method.scenarios,
              successStatus: method.successStatus,
              responseExample: method.responseExample,
            },
          },
        )
      }

      case 'call_mock': {
        const resolved = await sandboxOf(req)
        const service = requireService(args)
        const path = String(args.path ?? '')
        const httpMethod = String(args.httpMethod ?? 'GET').toUpperCase()
        const scenario = typeof args.scenario === 'string' ? args.scenario : 'success'

        const answer = engine.handle({
          service,
          httpMethod,
          path,
          query: {},
          headers: {},
          body: (args.body ?? null) as unknown,
          requestId: gatewayRequestId(service),
          scenario: scenario as 'success',
          now: new Date(),
          salt: resolved.sandbox.dataVolume,
        })

        return text(
          answer.serialized,
          {
            status: answer.status,
            // Боевые заголовки сервиса тоже часть ответа: агент, который пишет
            // разбор лимита, должен видеть, есть ли у сервиса такие заголовки вообще.
            headers: answer.headers,
            responseSource: answer.responseSource,
            body: answer.body,
            upstream: answer.method?.upstreamHost ?? SERVICE_PROFILES[service].replacesUrl,
          },
          answer.responseSource === 'error',
        )
      }

      case 'recent_requests': {
        const resolved = await sandboxOf(req)
        const limit = Math.min(Number(args.limit ?? 20) || 20, 100)
        const only = isServiceCode(args.service) ? args.service : undefined
        const rows = await prisma.requestLog.findMany({
          where: { sandboxId: resolved.sandbox.id, ...(only ? { serviceCode: only } : {}) },
          orderBy: { timestamp: 'desc' },
          take: limit,
          select: {
            publicId: true, serviceCode: true, httpMethod: true, endpoint: true,
            statusCode: true, durationMs: true, scenario: true, responseSource: true, timestamp: true,
          },
        })
        return text(
          rows.length === 0
            ? 'В журнале этой песочницы пока пусто.'
            : rows.map((r) => `${r.timestamp.toISOString()} ${r.serviceCode} ${r.httpMethod} ${r.endpoint} → ${r.statusCode} (${r.durationMs} мс)`).join('\n'),
          { total: rows.length, requests: rows },
        )
      }

      default:
        throw new RpcError(RPC.INVALID_PARAMS, `Инструмент «${name}» не найден`)
    }
  },
}
