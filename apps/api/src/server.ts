import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { z } from 'zod'
import { ru } from 'zod/locales'
import { SERVICE_LIST, allGatewayResponseHeaders } from '@apistend/shared'
import { env } from './env.ts'
import { prisma } from './db.ts'
import { engine, registerGateway } from './gateway.ts'
import { registerMcp } from './mcp/routes.ts'
import { MCP_EXPOSED_HEADERS } from './mcp/transport.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerCatalogRoutes } from './routes/catalog.ts'
import { registerKeyRoutes } from './routes/keys.ts'
import { registerSettingsRoutes } from './routes/settings.ts'
import { registerConsoleRoutes } from './routes/console.ts'
import { registerLogRoutes } from './routes/logs.ts'
import { registerWebhookRoutes } from './routes/webhooks.ts'
import { registerMockRoutes } from './routes/mocks.ts'
import { registerOverviewRoutes } from './routes/overview.ts'
import { registerB24AppRoutes } from './routes/b24-apps.ts'
import { registerOpenApiRoute } from './routes/v1/_registry.ts'
import { registerAccountV1Routes } from './routes/v1/account.ts'
import { registerSandboxV1Routes } from './routes/v1/sandboxes.ts'
import { registerKeysV1Routes } from './routes/v1/keys.ts'
import { registerWebhookV1Routes } from './routes/v1/webhooks.ts'
import { registerScenarioV1Routes } from './routes/v1/scenarios.ts'
import { registerMockV1Routes } from './routes/v1/mocks.ts'
import { registerV1LogsRoutes } from './routes/v1/logs.ts'
import { registerCatalogV1Routes } from './routes/v1/catalog.ts'
import { registerTunnel } from './tunnel/server.ts'
import { startWebhookScheduler } from './webhooks/dispatcher.ts'
import { reapInterruptedBursts } from './webhooks/burst.ts'
import { bufferStats, flushRequestLogs } from './lib/log-buffer.ts'
import { flushKeyUsage, keyUsageStats } from './lib/key-usage.ts'
import { keyCacheStats } from './lib/api-key.ts'
import { mgmtRateStats } from './lib/mgmt.ts'
import { retentionStats, startRetentionJob, stopRetentionJob } from './lib/retention.ts'
import { allSessions } from './tunnel/registry.ts'

/**
 * Сообщения валидации — по-русски.
 *
 * Тексты zod по умолчанию английские, и в русском интерфейсе всплывали строки
 * вроде «Too small: expected string to have >=2 characters». Собственные тексты
 * у полей, где формулировка важна, остаются: локаль подставляется только там,
 * где сообщение не задано.
 */
z.config(ru())

/**
 * Ветки мок-шлюза и своих моков.
 *
 * Им положен открытый CORS: это песочница, к которой ходят из чужих страниц.
 * Кабинету — наоборот, строгий origin с cookie. Плагин отвечает на предполётный
 * запрос сам, в onRequest, поэтому решение принимается здесь, а не в маршруте:
 * до обработчика шлюза предполёт просто не доходил, и браузер получал ответ
 * с origin кабинета — то есть отказ.
 */
const GATEWAY_PREFIXES = [
  ...SERVICE_LIST.map((p) => `${p.mountPath}/`),
  ...SERVICE_LIST.map((p) => p.mountPath),
  '/v1/',
  '/rest/',
  '/custom/',
  '/oauth/',
  // Оба MCP-сервера: мок mcp.apify.com и собственный сервер APIStend.
  // Им нужен тот же открытый CORS, что и шлюзу: клиентом MCP всё чаще
  // оказывается браузерное расширение, а не локальный процесс.
  '/mcp',
]

function isGatewayPath(url: string): boolean {
  const path = url.split('?')[0] ?? '/'
  return GATEWAY_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

export async function buildServer() {
  const app = Fastify({
    logger: env.isProduction
      ? { level: 'info' }
      : { level: 'info', transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
    // Тела запросов к мокам бывают крупными (загрузка карточек товаров).
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: true,
  })

  await app.register(cookie)
  await app.register(cors, {
    delegator: (req, done) => {
      if (isGatewayPath(req.url)) {
        done(null, {
          // Песочницу зовут откуда угодно, и заголовок x-apistend-cors честно
          // помечает, что в бою этого разрешения не будет.
          origin: '*',
          credentials: false,
          methods: 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
          allowedHeaders: '*',
          // Список собирается из профилей сервисов: браузер показывает коду
          // страницы только перечисленные здесь заголовки, и забытый в списке
          // X-Ratelimit-Reset выглядел бы для клиентской библиотеки так же,
          // как отсутствующий, — то есть подмена адреса ломала бы рабочий код.
          exposedHeaders: [...allGatewayResponseHeaders(), ...MCP_EXPOSED_HEADERS],
          // Предполёт без заголовков предполёта — обычный OPTIONS, и отвечать
          // на него четырёхсотым нельзя: этим спрашивают, что умеет адрес.
          strictPreflight: false,
        })
        return
      }
      // Кабинет ходит с другого порта и обязан присылать cookie сессии.
      // Сюда же попадает Management API (/api/v1/*): он принимает ту же cookie,
      // поэтому строгий origin ему подходит, а серверному клиенту CORS не нужен вовсе.
      // Заголовки лимита частоты приходится перечислять: без exposedHeaders браузер
      // их не отдаёт коду страницы, и кабинет не смог бы показать, сколько осталось.
      done(null, {
        origin: [env.webOrigin],
        credentials: true,
        // Умолчание плагина — «GET,HEAD,POST», то есть ровно те методы, которым
        // предполёт не нужен. Браузер сверяет запрошенный метод с этим списком,
        // и PATCH с DELETE не проходили предполёт вообще: кабинетное удаление
        // вебхука и весь Management API, где почти у каждого ресурса есть PATCH
        // и DELETE, из браузера были недоступны.
        methods: 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        exposedHeaders: [
          'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after',
        ],
      })
    },
  })

  // Тело неизвестного типа не должно ронять запрос: мок обязан принять всё,
  // что пришлёт клиентская библиотека, и разобраться сам.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  /**
   * Пустое тело при заголовке «Content-Type: application/json».
   *
   * Встроенный разбор Fastify отвечает на него своим английским
   * FST_ERR_CTP_EMPTY_JSON_BODY — ещё до того, как запрос дойдёт до маршрута.
   * А случай этот обычный: fetch и curl ставят заголовок по привычке даже там,
   * где телу взяться неоткуда (POST /api/v1/keys/:id/rotate, «сбросить песочницу»,
   * «повторить доставку», «погасить все сессии»). Считаем пустое тело за {} —
   * и пусть на нём спотыкается уже проверка полей, с русским текстом и разбором
   * по именам, а не разбор транспорта.
   *
   * Заодно русским становится ответ на битый JSON.
   */
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim()
    if (text.length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch {
      done(Object.assign(new Error('Тело запроса не разбирается как JSON'), {
        statusCode: 400,
        code: 'INVALID_JSON',
      }))
    }
  })
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch {
        done(null, {})
      }
    },
  )

  /**
   * Повторённый query-параметр (?q=a&q=b) Fastify отдаёт массивом, а маршруты
   * ждут строку — и падали на q.trim(). Схлопываем к последнему значению:
   * так же поступает большинство серверов, и клиент, приславший параметр
   * дважды, получает предсказуемый результат вместо ошибки.
   */
  app.addHook('onRequest', async (req) => {
    const query = req.query as Record<string, unknown> | undefined
    if (!query) return
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) query[key] = value[value.length - 1]
    }
  })

  /**
   * Единый обработчик ошибок.
   *
   * По умолчанию Fastify отдаёт клиенту message исключения — а это внутренности:
   * текст вроде «q.trim is not a function» или дамп запроса Prisma с именами
   * колонок и значениями. Наружу должен уходить один и тот же безликий конверт,
   * подробности — в журнал сервера.
   *
   * Ошибки валидации и явные 4xx это не трогает: их код меньше 500.
   */
  app.setErrorHandler((error: unknown, req, reply) => {
    const e = error as { statusCode?: number; code?: string; message?: string }
    const status = e.statusCode ?? 500
    if (status < 500) {
      return reply.code(status).send({
        error: e.code ?? 'BAD_REQUEST',
        message: e.message ?? 'Некорректный запрос',
      })
    }

    req.log.error({ err: error, url: req.url, method: req.method }, 'необработанная ошибка')
    return reply.code(500).send({
      error: 'INTERNAL',
      message: 'Внутренняя ошибка сервиса. Повторите запрос позже.',
      requestId: req.id,
    })
  })

  app.get('/health', async () => ({
    ok: true,
    services: engine.loadedServices,
    methods: engine.loadedServices.reduce((n, c) => n + engine.catalog(c).length, 0),
    logBuffer: bufferStats(),
    responseCache: engine.cacheStats(),
    keyCache: keyCacheStats(),
    keyUsage: keyUsageStats(),
    mgmtRate: mgmtRateStats(),
    tunnelSessions: allSessions().length,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    retention: retentionStats(),
  }))

  registerAuthRoutes(app)
  registerCatalogRoutes(app)
  registerKeyRoutes(app)
  registerSettingsRoutes(app)
  registerConsoleRoutes(app)
  registerLogRoutes(app)
  registerWebhookRoutes(app)
  registerMockRoutes(app)
  registerOverviewRoutes(app)
  registerB24AppRoutes(app)

  /**
   * Management API — то же самое, что делается в кабинете, но программно.
   *
   * Регистрируется после кабинета и до шлюза. До шлюза — потому что его маршруты
   * самые широкие; после кабинета — потому что пути не пересекаются, и порядок
   * между ними ничего не решает, кроме читаемости этого списка.
   *
   * Адреса /api/v1 и /api/v1/ (ровно они, без продолжения) заняты библиотекой
   * BX24.js из registerB24AppRoutes — статический маршрут в Fastify приоритетнее
   * параметрического, поэтому /api/v1/keys и соседи её не перекрывают.
   */
  registerAccountV1Routes(app)
  registerSandboxV1Routes(app)
  registerKeysV1Routes(app)
  registerWebhookV1Routes(app)
  registerScenarioV1Routes(app)
  registerMockV1Routes(app)
  registerV1LogsRoutes(app)
  registerCatalogV1Routes(app)
  /*
   * Неизвестный адрес под /api/v1/ отвечает нашим конвертом, а не фастифаевским.
   *
   * По умолчанию Fastify отдаёт {"message":"Route ... not found","error":"Not Found"} —
   * английский текст и другая форма, чем у всех остальных отказов Management API.
   * Клиент, который разбирает поле error по своему справочнику кодов, на опечатке
   * в адресе получал бы непонятное «Not Found» вместо NOT_FOUND.
   */
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/v1/')) {
      return reply.code(404).send({
        error: 'NOT_FOUND',
        message: `Адрес ${req.method} ${req.url.split('?')[0]} не существует. ` +
          'Список маршрутов — в /api/v1/openapi.json',
      })
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: 'Адрес не найден' })
  })

  // Служебная пара без авторизации: /api/v1/openapi.json и /api/v1/meta.
  // Документ собирается на каждый запрос, поэтому место вызова роли не играет.
  registerOpenApiRoute(app)

  // MCP регистрируется ДО шлюза: /apify/mcp иначе попал бы под /apify/*
  // и ушёл бы в движок моков как обычный REST-путь, которого в каталоге нет.
  registerMcp(app)

  // Шлюз регистрируется последним: его маршруты самые широкие (/wb/*, /v1/:service/*)
  // и не должны перехватывать /api/*.
  registerGateway(app)

  // Туннель и планировщик доставок — часть сервера, а не часть точки входа:
  // сквозные тесты поднимают buildServer() напрямую, и без них они проверяли бы
  // не тот сервер, который работает в продакшене.
  registerTunnel(app, (msg) => app.log.info(msg))
  const webhookTimer = startWebhookScheduler((msg) => app.log.debug(msg))

  // Расписание серий живёт в памяти процесса и перезапуск не переживает.
  // Оставить их в состоянии «идёт» — значит показывать в интерфейсе неправду.
  const interrupted = await reapInterruptedBursts((msg) => app.log.info(msg))
  if (interrupted > 0) app.log.info(`серий событий прервано перезапуском: ${interrupted}`)
  app.addHook('onClose', async () => {
    clearInterval(webhookTimer)
    await Promise.all([flushRequestLogs(), flushKeyUsage()])
  })

  return app
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')

if (isEntrypoint) {
  const app = await buildServer()

  // Журнал обещает хранение 30 дней — значит, старое надо удалять.
  startRetentionJob((msg) => app.log.info(msg))

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: останавливаюсь`)
    stopRetentionJob()
    // Успеваем дописать накопленное — иначе теряется последняя пачка логов
    // и последние приращения счётчиков ключей.
    await Promise.all([flushRequestLogs(), flushKeyUsage()])
    await app.close()
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ port: env.port, host: env.host })
  const loaded = engine.loadedServices
  const total = loaded.reduce((n, c) => n + engine.catalog(c).length, 0)
  app.log.info(`APIStend API на http://${env.host}:${env.port}`)
  app.log.info(`Каталог: ${total} методов, сервисы: ${loaded.join(', ') || 'нет (запустите pnpm ingest)'}`)
}
