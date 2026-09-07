import { cac } from 'cac'
import pc from 'picocolors'
import { apiClient, CliError } from './api.ts'
import { readConfig, resolveApiBase, resolveApiKey, writeConfig, configPath } from './config.ts'
import { listen } from './listen.ts'
import { out } from './output.ts'
import { maskKey } from './mask.ts'

const VERSION = '1.5.0'

const cli = cac('apistend')

interface GlobalFlags {
  apiKey?: string
  apiBase?: string
  json?: boolean
}

interface TriggerFlags extends GlobalFlags {
  count?: string | number
  rate?: string | number
  errorRate?: string | number
  watch?: boolean
}

function requireKey(flags: GlobalFlags): string {
  const key = resolveApiKey(flags.apiKey)
  if (!key) {
    out.error('Не выполнен вход.', 'Запустите: apistend login --api-key stend_sk_…')
    process.exit(1)
  }
  if (key.startsWith('stend_sbx_')) {
    out.error(
      'Ключ stend_sbx_… — это ключ песочницы, он для запросов вашего кода к API.',
      'Для CLI нужен серверный ключ stend_sk_… — возьмите его в разделе «Ключи и токены».',
    )
    process.exit(1)
  }
  return key
}

function fail(e: unknown): never {
  if (e instanceof CliError) out.error(e.message, e.hint)
  else out.error((e as Error).message)
  process.exit(1)
}

cli
  .command('listen', 'Принимать события APIStend на локальное приложение')
  .option('-f, --forward <target>', 'Куда пересылать, например localhost:3000/webhooks')
  .option('-e, --events <list>', 'Фильтр по типам событий через запятую')
  .option('--no-replay', 'Не досылать накопленное за время простоя')
  .option('--timeout <ms>', 'Таймаут ответа приложения; 0 — отключить')
  .option('--concurrency <n>', 'Максимум одновременных вызовов', { default: 16 })
  .action(async (flags: GlobalFlags & Record<string, unknown>) => {
    const forward = (flags.forward as string) ?? 'localhost:3000/webhooks'
    const controller = new AbortController()
    process.on('SIGINT', () => controller.abort())
    process.on('SIGTERM', () => controller.abort())

    try {
      await listen({
        apiKey: requireKey(flags),
        apiBase: flags.apiBase,
        forward,
        events: typeof flags.events === 'string' ? flags.events.split(',').map((s) => s.trim()) : undefined,
        noReplay: flags.replay === false,
        timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
        concurrency: Number(flags.concurrency ?? 16),
        json: flags.json === true,
        version: VERSION,
        signal: controller.signal,
      })
      process.exit(0)
    } catch (e) {
      fail(e)
    }
  })

cli
  .command('login', 'Сохранить серверный ключ доступа')
  .option('--api-key <key>', 'Серверный ключ stend_sk_…')
  .action(async (flags: GlobalFlags) => {
    const key = flags.apiKey ?? process.env.APISTEND_API_KEY
    if (!key) {
      out.error('Укажите ключ: apistend login --api-key stend_sk_…',
        'Ключ создаётся в разделе «Ключи и токены» веб-интерфейса')
      process.exit(1)
    }
    try {
      const status = await apiClient.status(key, flags.apiBase)
      writeConfig({ ...readConfig(), apiKey: key, apiBase: resolveApiBase(flags.apiBase), sandbox: status.sandbox })
      out.info(`Вход выполнен: ${status.account} ${pc.dim('·')} песочница ${status.sandbox}`)
      out.info(`Конфигурация: ${pc.dim(configPath())}`)
    } catch (e) {
      fail(e)
    }
  })

cli.command('logout', 'Удалить сохранённый ключ').action(() => {
  const config = readConfig()
  delete config.apiKey
  writeConfig(config)
  out.info('Ключ удалён из конфигурации')
})

cli
  .command('whoami', 'Показать текущий аккаунт и песочницу')
  .action(async (flags: GlobalFlags) => {
    try {
      const status = await apiClient.status(requireKey(flags), flags.apiBase)
      if (flags.json) return out.json(status)
      out.info(`Аккаунт: ${status.account}`)
      out.info(`Песочница: ${status.sandbox}`)
      out.info(`Ключ: ${status.keyName} ${pc.dim(maskKey(resolveApiKey(flags.apiKey)!))}`)
    } catch (e) {
      fail(e)
    }
  })

cli
  .command('status', 'Состояние локального агента')
  .action(async (flags: GlobalFlags) => {
    try {
      const status = await apiClient.status(requireKey(flags), flags.apiBase)
      if (flags.json) return out.json(status)
      if (!status.connected) {
        out.info('Локальная доставка не подключена')
        out.info(pc.dim('Запустите: apistend listen --forward localhost:3000/webhooks'))
        return
      }
      out.info(`Подключено ${pc.dim('·')} сессия ${status.sessionId} ${pc.dim('·')} ${status.agentVersion}`)
      out.info(`Пересылка: ${status.forwardUrl}`)
      out.info(`За час: ${status.eventsLastHour} событий, ошибок доставки ${status.failedDeliveries}`)
    } catch (e) {
      fail(e)
    }
  })

cli
  .command('trigger <event>', 'Отправить событие вручную или серией')
  .option('--count <n>', 'Сколько событий отправить (серия)')
  .option('--rate <n>', 'Скорость серии, событий в секунду')
  .option('--error-rate <n>', 'Доля событий со сбоем отправки, проценты')
  .option('--watch', 'Показывать прогресс серии до её конца')
  .action(async (event: string, flags: TriggerFlags) => {
    try {
      const key = requireKey(flags)
      const count = flags.count === undefined ? null : Number(flags.count)
      const rate = flags.rate === undefined ? null : Number(flags.rate)

      // Одиночная отправка — прежнее поведение, ни count, ни rate не заданы.
      if (count === null && rate === null) {
        const result = await apiClient.trigger(key, flags.apiBase, event)
        if (flags.json) return out.json(result)
        out.info(`Событие ${pc.bold(event)} поставлено в очередь ${pc.dim(`[${result.deliveryId}]`)}`)
        out.info(`Получатель: ${result.target} ${pc.dim(`(${result.transport})`)}`)
        return
      }

      // Задано одно из двух: количество без скорости — отправить как можно ровнее за секунду,
      // скорость без количества — секунда работы на этой скорости.
      const wantCount = count ?? rate!
      const wantRate = rate ?? count!
      if (!Number.isFinite(wantCount) || !Number.isFinite(wantRate) || wantCount < 1 || wantRate < 1) {
        throw new CliError('Значения --count и --rate должны быть положительными числами')
      }

      const accepted = await apiClient.burst(key, flags.apiBase, {
        event,
        count: Math.round(wantCount),
        rate: Math.round(wantRate),
        errorRate: flags.errorRate === undefined ? undefined : Number(flags.errorRate),
      })
      if (flags.json && !flags.watch) return out.json(accepted)

      out.burstStarted(
        event, accepted.count, accepted.ratePerSec, accepted.target,
        accepted.estimatedSeconds, accepted.capped,
      )
      if (!flags.watch) {
        out.info(`Прогресс: ${pc.dim('apistend trigger ' + event + ' --watch')} или экран «Вебхуки»`)
        return
      }
      await watchBurst(key, flags, accepted.burstId, accepted.count, accepted.ratePerSec, flags.json === true)
    } catch (e) {
      fail(e)
    }
  })

/** Опрос прогресса серии. Раз в 500 мс: чаще — лишняя нагрузка на тот же сервер, который мы и меряем. */
async function watchBurst(
  key: string, flags: GlobalFlags, burstId: string,
  count: number, wantedRate: number, asJson: boolean,
): Promise<void> {
  for (;;) {
    const progress = await apiClient.bursts(key, flags.apiBase)
    const live = progress.running.find((b) => b.id === burstId)
    if (live) {
      out.burstProgress(live.sent, live.count, live.actualRatePerSec, wantedRate, live.throttledTicks > 0)
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const done = progress.recent.find((b) => b.id === burstId)
    if (asJson) return out.json(done ?? { id: burstId, state: 'unknown' })
    if (done) out.burstDone(done.sent, done.count, done.succeeded, done.failed, done.note)
    else out.info('Серия завершена, итог получить не удалось')
    return
  }
}

cli.option('--api-key <key>', 'Ключ доступа (иначе берётся из конфигурации)')
cli.option('--api-base <url>', 'Адрес API APIStend')
cli.option('--json', 'Машиночитаемый вывод')
cli.help()
cli.version(VERSION)

cli.parse()
