import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { env } from './env.ts'
import { prisma } from './db.ts'
import { engine, registerGateway } from './gateway.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerCatalogRoutes } from './routes/catalog.ts'
import { registerKeyRoutes } from './routes/keys.ts'
import { registerConsoleRoutes } from './routes/console.ts'
import { registerLogRoutes } from './routes/logs.ts'
import { registerWebhookRoutes } from './routes/webhooks.ts'
import { registerMockRoutes } from './routes/mocks.ts'
import { registerOverviewRoutes } from './routes/overview.ts'
import { registerB24AppRoutes } from './routes/b24-apps.ts'
import { registerTunnel } from './tunnel/server.ts'
import { startWebhookScheduler } from './webhooks/dispatcher.ts'
import { reapInterruptedBursts } from './webhooks/burst.ts'
import { bufferStats, flushRequestLogs } from './lib/log-buffer.ts'
import { flushKeyUsage, keyUsageStats } from './lib/key-usage.ts'
import { keyCacheStats } from './lib/api-key.ts'
import { retentionStats, startRetentionJob, stopRetentionJob } from './lib/retention.ts'
import { allSessions } from './tunnel/registry.ts'

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
  // Кабинет ходит с другого порта и обязан присылать cookie сессии.
  await app.register(cors, { origin: [env.webOrigin], credentials: true })

  // Тело неизвестного типа не должно ронять запрос: мок обязан принять всё,
  // что пришлёт клиентская библиотека, и разобраться сам.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
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
    tunnelSessions: allSessions().length,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    retention: retentionStats(),
  }))

  registerAuthRoutes(app)
  registerCatalogRoutes(app)
  registerKeyRoutes(app)
  registerConsoleRoutes(app)
  registerLogRoutes(app)
  registerWebhookRoutes(app)
  registerMockRoutes(app)
  registerOverviewRoutes(app)
  registerB24AppRoutes(app)

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
