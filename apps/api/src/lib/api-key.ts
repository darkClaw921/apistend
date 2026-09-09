import type { ApiKey, Sandbox } from '@prisma/client'
import { LruCache } from '@apistend/mock-engine'
import { prisma } from '../db.ts'
import { hashApiKey, keyKindOf } from './keys.ts'

/**
 * Разбор ключа из запроса к мок-шлюзу.
 *
 * Шлюз обязан принимать НАТИВНУЮ авторизацию сервиса: если разработчик просто подменил
 * базовый адрес, его клиентская библиотека шлёт ключ там, где привыкла.
 *   Bitrix24     — в пути /rest/{user}/{code}/… либо параметр auth=
 *   Ozon         — заголовки Client-Id и Api-Key
 *   Wildberries  — заголовок Authorization (без префикса Bearer)
 *   универсально — X-Mock-Key или Authorization: Bearer stend_…
 */

export interface ResolvedKey {
  apiKey: ApiKey
  sandbox: Sandbox
}

/**
 * Кеш разбора ключей.
 *
 * Без него каждый запрос шлюза идёт в базу — при тысячах запросов в секунду
 * от многих аккаунтов это первое, что упрётся в пул соединений.
 * LRU с вытеснением по одному: полная очистка по переполнению давала бы
 * одновременный промах по всем ключам и всплеск запросов к базе.
 *
 * Промахи (неизвестный ключ) кешируются тоже — иначе перебор мусорных ключей
 * бьёт в базу на каждом запросе.
 */
const CACHE_TTL_MS = 30_000
const cache = new LruCache<{ value: ResolvedKey | null; expires: number }>(20_000)

/** Ключи, по которым идёт запрос к базе прямо сейчас: не даём собраться «стаду». */
const inflight = new Map<string, Promise<ResolvedKey | null>>()

export function extractRawKey(
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>,
  path: string,
  body?: unknown,
): string | null {
  const header = (name: string): string | null => {
    const v = headers[name]
    if (typeof v === 'string') return v
    if (Array.isArray(v) && v.length > 0) return v[0] ?? null
    return null
  }

  const direct = header('x-mock-key')
  if (direct) return direct.trim()

  // Ozon: ключ приезжает в Api-Key, Client-Id несёт идентификатор продавца.
  const apiKeyHeader = header('api-key')
  if (apiKeyHeader) return apiKeyHeader.trim()

  const auth = header('authorization')
  if (auth) {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim())
    // Wildberries шлёт токен без префикса Bearer — принимаем оба варианта.
    return (bearer?.[1] ?? auth).trim()
  }

  // Bitrix24: параметр auth= в query.
  const q = query.auth
  if (typeof q === 'string' && q.length > 0) return q

  // Apify: параметр token= в адресе. Способ описан в его securitySchemes наравне
  // с Bearer и используется там, где заголовок поставить негде, — например,
  // в адресе, который Apify сам подставляет в вебхук.
  const token = query.token
  if (typeof token === 'string' && token.length > 0) return token

  // Bitrix24: секрет в пути входящего вебхука /rest/{user_id}/{code}/{method}.json
  const m = /^\/rest\/\d+\/([^/]+)\//.exec(path)
  if (m?.[1]) return m[1]

  // Bitrix24: документация прямо разрешает класть auth в тело POST-запроса —
  // и JSON, и form-urlencoded. Клиентские библиотеки этим пользуются.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const fromBody = (body as Record<string, unknown>).auth
    if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody
  }

  return null
}

export async function resolveApiKey(raw: string | null): Promise<ResolvedKey | null> {
  if (!raw || keyKindOf(raw) === null) return null

  const hash = hashApiKey(raw)
  const hit = cache.get(hash)
  if (hit && hit.expires > Date.now()) return hit.value

  const pending = inflight.get(hash)
  if (pending) return pending

  const promise = loadFromDb(hash).finally(() => inflight.delete(hash))
  inflight.set(hash, promise)
  return promise
}

async function loadFromDb(hash: string): Promise<ResolvedKey | null> {
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hash },
    include: { sandbox: true },
  })

  let value: ResolvedKey | null = null
  if (apiKey && apiKey.status !== 'revoked') {
    if (!apiKey.expiresAt || apiKey.expiresAt > new Date()) {
      value = { apiKey, sandbox: apiKey.sandbox }
    }
  }

  cache.set(hash, { value, expires: Date.now() + CACHE_TTL_MS })
  return value
}

/** Сбрасывает кеш: вызывается при отзыве и ротации ключа, иначе отзыв «подвисает» на 30 с. */
export function invalidateKeyCache(): void {
  cache.clear()
}

export function keyCacheStats() {
  return cache.stats()
}
