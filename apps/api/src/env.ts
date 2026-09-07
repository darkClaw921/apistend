import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../../.env'), quiet: true })

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Не задана переменная окружения ${name}. Скопируйте .env.example в .env`)
  return v
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  port: Number(process.env.API_PORT ?? 8080),
  host: process.env.API_HOST ?? '127.0.0.1',
  webOrigin: process.env.WEB_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? 3000}`,
  publicOrigin: process.env.APISTEND_PUBLIC_ORIGIN ?? `http://localhost:${process.env.API_PORT ?? 8080}`,
  isProduction: process.env.NODE_ENV === 'production',
  /** Соединений к PostgreSQL на инстанс. Общее число = это значение × количество инстансов. */
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 12),

  // ── серии событий (нагрузочное тестирование вебхуков) ──
  /** Потолок скорости одной серии, событий в секунду. Запрос выше — обрезается, и об этом сообщается. */
  burstMaxRatePerSec: Number(process.env.BURST_MAX_RATE ?? 500),
  /** Потолок количества событий в одной серии. */
  burstMaxCount: Number(process.env.BURST_MAX_COUNT ?? 100_000),
  /** Сколько серий может идти одновременно в одной песочнице. */
  burstMaxConcurrent: Number(process.env.BURST_MAX_CONCURRENT ?? 3),
  /**
   * Разрешать доставку на приватные адреса (localhost, 10/8, 192.168/16, ::1).
   *
   * В разработке API и приложение живут на одной машине, поэтому по умолчанию можно.
   * В продакшене APIStend — общий сервис, и запрос по адресу из чужой песочницы стал бы
   * SSRF-каналом во внутреннюю сеть, тем более под серией на сотни событий в секунду.
   */
  allowPrivateWebhookTargets:
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === '1' ||
    (process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS !== '0' && process.env.NODE_ENV !== 'production'),
} as const
