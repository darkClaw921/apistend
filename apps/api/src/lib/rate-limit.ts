import type { ServiceCode } from '@apistend/shared'
import { rateLimitClassFor } from '@apistend/shared'

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
 *
 * Лимит не всегда свойство сервиса целиком: у Apify он зависит от эндпоинта
 * (60 в секунду по умолчанию, 200 на записи key-value store, 400 на запуски
 * и датасеты). Поэтому ведро заводится на (субъект, сервис, класс пути),
 * а класс выбирает профиль — здесь про конкретные пути ничего не знают.
 */

interface Bucket {
  /** Сколько запросов ещё пропустим прямо сейчас. Дробное: ведро пополняется плавно. */
  tokens: number
  filledAt: number
  /** Параметры класса, которому принадлежит ведро: нужны уборщику. */
  perMs: number
  burst: number
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

export function checkRateLimit(
  apiKeyId: string,
  service: ServiceCode,
  now = Date.now(),
  path = '',
): RateVerdict {
  const cls = rateLimitClassFor(service, path)
  const { limit, windowMs, burst } = cls
  // Имя класса пустое у сервисов с единым лимитом — ключ ведра тогда прежний.
  const key = cls.name ? `${apiKeyId}:${service}:${cls.name}` : `${apiKeyId}:${service}`
  const perMs = limit / windowMs

  if (now - lastSweep > 60_000) {
    // Ведро, наполнившееся до краёв, неотличимо от отсутствующего — удаляем.
    // Порог считаем по параметрам ТОГО класса, которому ведро принадлежит:
    // общая скорость текущего вызова стёрла бы чужие вёдра раньше срока
    // (у Apify самый быстрый класс наполняется в шесть раз быстрее базового).
    for (const [k, b] of buckets) {
      const own = b.burst
      if (b.tokens + (now - b.filledAt) * b.perMs >= own) buckets.delete(k)
    }
    lastSweep = now
  }

  const bucket = buckets.get(key) ?? { tokens: burst, filledAt: now, perMs, burst }
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
