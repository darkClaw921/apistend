import type { ServiceCode } from '@apistend/shared'
import { SERVICE_PROFILES } from '@apistend/shared'

/**
 * Лимиты боевых API — эмуляция, а не защита APIStend.
 *
 * Схема — дырявое ведро: ёмкость burst, пополнение limit за windowMs. Именно так
 * описан лимит Bitrix24 («около двух запросов в секунду, бакет 50»), и без ведра
 * мок получается кратно строже боя: приложение, которое при старте вызывает
 * app.info, profile и placement.bind, упиралось бы в 503 на третьем вызове.
 *
 * Держим в памяти: точность до одного инстанса тут достаточна, а поход в Redis
 * на каждый запрос стоил бы дороже самого мока.
 *
 * Важно: у Bitrix24 при превышении — 503 QUERY_LIMIT_EXCEEDED, а не 429.
 * Код берётся из профиля сервиса, а не зашивается здесь.
 */

interface Bucket {
  /** Сколько запросов ещё пропустим прямо сейчас. Дробное: ведро пополняется плавно. */
  tokens: number
  filledAt: number
}

const buckets = new Map<string, Bucket>()
let lastSweep = 0

export interface RateVerdict {
  allowed: boolean
  limit: number
  remaining: number
  /**
   * Секунды до полного восстановления всплеска — ровно тот смысл, который
   * документация Wildberries вкладывает в X-Ratelimit-Reset: «через сколько секунд
   * допустимый всплеск восстановится до значения X-Ratelimit-Limit».
   */
  resetInSeconds: number
  /** Секунды до следующего разрешённого запроса — смысл X-Ratelimit-Retry. */
  retryInSeconds: number
}

export function checkRateLimit(apiKeyId: string, service: ServiceCode, now = Date.now()): RateVerdict {
  const { limit, windowMs, burst } = SERVICE_PROFILES[service].rateLimit
  const key = `${apiKeyId}:${service}`
  const perMs = limit / windowMs

  if (now - lastSweep > 60_000) {
    // Ведро, наполнившееся до краёв, неотличимо от отсутствующего — удаляем.
    for (const [k, b] of buckets) {
      if (b.tokens + (now - b.filledAt) * perMs >= burst) buckets.delete(k)
    }
    lastSweep = now
  }

  const bucket = buckets.get(key) ?? { tokens: burst, filledAt: now }
  bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.filledAt) * perMs)
  bucket.filledAt = now

  const allowed = bucket.tokens >= 1
  if (allowed) bucket.tokens -= 1
  buckets.set(key, bucket)

  return {
    allowed,
    // В заголовке X-Ratelimit-Limit боевые сервисы показывают ёмкость,
    // а не среднюю скорость: клиент по нему считает, сколько может отправить сразу.
    limit: burst,
    remaining: Math.max(0, Math.floor(bucket.tokens)),
    // Полное восстановление ведра, а не появление одного токена: клиент по этому
    // числу понимает, когда снова сможет работать в полную силу.
    resetInSeconds: Math.max(0, Math.ceil((burst - bucket.tokens) / perMs / 1000)),
    retryInSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)),
  }
}

/** Для тестов: сбросить состояние между кейсами. */
export function resetRateLimits(): void {
  buckets.clear()
}
