import type { RateSnapshot, ServiceCode } from '@apistend/shared'
import type { RateVerdict } from './rate-limit.ts'
import { buildTimeEnvelope } from '../b24/app-methods.ts'

/**
 * Мелочи, общие для мок-шлюза и консоли запросов.
 *
 * Консоль обязана показывать ровно тот ответ, который увидела бы клиентская
 * библиотека: заголовки лимита, идентификатор запроса, конверт time у Битрикс24.
 * Пока эти детали жили только в шлюзе, консоль показывала ответ беднее реального,
 * и разработчик, сверявший её с curl, видел два разных ответа на один вызов.
 */

/** Состояние лимита в том виде, в каком его читают боевые заголовки. */
export function rateSnapshot(verdict: RateVerdict): RateSnapshot {
  return {
    limit: verdict.limit,
    remaining: verdict.remaining,
    resetInSeconds: verdict.resetInSeconds,
    retryInSeconds: verdict.retryInSeconds,
  }
}

/**
 * Приклеивает конверт time к готовой строке ответа Битрикс24.
 *
 * Именно строкой, а не пересборкой объекта: тело приходит из кеша движка уже
 * сериализованным, и разбирать его обратно ради одного поля — лишняя работа
 * на каждом вызове самого нагруженного сервиса. Статичный time из примеров
 * документации движок снимает при сборке тела, так что дубля не возникает.
 */
export function withLiveTime(serialized: string, startedMs: number): string {
  if (!serialized.startsWith('{')) return serialized
  const time = JSON.stringify(buildTimeEnvelope(startedMs))
  const rest = serialized.slice(1)
  return rest === '}' ? `{"time":${time}}` : `{"time":${time},${rest}`
}

/** То же самое для уже разобранного тела — им отвечает консоль. */
export function withLiveTimeObject(
  service: ServiceCode,
  isError: boolean,
  body: unknown,
  startedMs: number,
): unknown {
  if (service !== 'bitrix24' || isError) return body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body
  return { time: buildTimeEnvelope(startedMs), ...(body as Record<string, unknown>) }
}
