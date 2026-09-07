import type { ServiceCode } from '@apistend/shared'
import { SERVICE_PROFILES } from '@apistend/shared'

/**
 * Лимиты боевых API — эмуляция, а не защита APIStend.
 *
 * Схема — скользящее окно на счётчиках. Держим в памяти: точность до одного инстанса
 * тут достаточна, а поход в Redis на каждый запрос стоил бы дороже самого мока.
 *
 * Важно: у Bitrix24 при превышении — 503 QUERY_LIMIT_EXCEEDED, а не 429.
 * Код берётся из профиля сервиса, а не зашивается здесь.
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
let lastSweep = 0

export interface RateVerdict {
  allowed: boolean
  limit: number
  remaining: number
  resetInSeconds: number
}

export function checkRateLimit(apiKeyId: string, service: ServiceCode, now = Date.now()): RateVerdict {
  const { limit, windowMs } = SERVICE_PROFILES[service].rateLimit
  const key = `${apiKeyId}:${service}`

  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
    lastSweep = now
  }

  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }

  bucket.count++
  const remaining = Math.max(0, limit - bucket.count)
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining,
    resetInSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}

/** Для тестов: сбросить состояние между кейсами. */
export function resetRateLimits(): void {
  buckets.clear()
}
