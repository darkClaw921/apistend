import type { B24App, B24AppToken, Sandbox } from '@prisma/client'
import { LruCache } from '@apistend/mock-engine'
import {
  B24_APP_STATUS_LOCAL,
  B24_AUTH_CODE_TTL_SECONDS,
  B24_REFRESH_TTL_SECONDS,
  B24_TOKEN_TTL_SECONDS,
  type B24TokenResponse,
} from '@apistend/shared'
import { prisma } from '../db.ts'
import {
  clientEndpoint, generateOpaqueToken, memberIdFor, portalDomain, serverEndpoint,
} from './portal.ts'

/**
 * Токены OAuth 2.0 локальных приложений.
 *
 * Сроки жизни боевые: access_token — час, refresh_token — 180 суток,
 * авторизационный код — 30 секунд. Это не украшение: приложение, написанное
 * против мока с вечным токеном, в бою упадёт через час — ровно в тот момент,
 * когда разработчик уже считает интеграцию готовой.
 *
 * Токены хранятся в открытом виде, в отличие от ключей APIStend (stend_sk_),
 * которые лежат только хешами. Причина в назначении: ключ — секрет пользователя,
 * а токен приложения здесь ещё и предмет показа. Его нужно видеть в кабинете
 * и уметь скопировать в curl, иначе половина отладочной ценности пропадает.
 */

export interface AppContext {
  readonly app: B24App
  readonly token: B24AppToken
  readonly sandbox: Sandbox
}

/**
 * Кеш разбора токенов приложения — тот же приём, что и для ключей песочницы:
 * горячий путь шлюза не должен ходить в базу. TTL короткий, потому что токен
 * может быть отозван переустановкой приложения, и «подвисший» на минуту доступ
 * к удалённому приложению выглядел бы как дефект.
 */
const CACHE_TTL_MS = 10_000
const cache = new LruCache<{ value: AppContext | null; expires: number }>(5_000)
const inflight = new Map<string, Promise<AppContext | null>>()

/** Похоже ли значение на токен приложения: 32 символа из строчных букв и цифр. */
export function looksLikeAppToken(raw: string): boolean {
  return /^[a-z0-9]{32}$/.test(raw)
}

export async function resolveAppToken(raw: string | null): Promise<AppContext | null> {
  if (!raw || !looksLikeAppToken(raw)) return null

  const hit = cache.get(raw)
  if (hit && hit.expires > Date.now()) return hit.value

  const pending = inflight.get(raw)
  if (pending) return pending

  const promise = loadFromDb(raw).finally(() => inflight.delete(raw))
  inflight.set(raw, promise)
  return promise
}

async function loadFromDb(accessToken: string): Promise<AppContext | null> {
  const token = await prisma.b24AppToken.findUnique({
    where: { accessToken },
    include: { app: { include: { sandbox: true } } },
  })

  let value: AppContext | null = null
  // Просроченный токен НЕ отбрасываем: шлюз обязан отличить «токен истёк»
  // (401 expired_token, и приложение пойдёт обновлять) от «токена нет вовсе»
  // (401 NO_AUTH_FOUND). Отозванный — именно что нет.
  if (token && !token.revokedAt && token.app.state !== 'uninstalled') {
    value = { app: token.app, token, sandbox: token.app.sandbox }
  }

  cache.set(accessToken, { value, expires: Date.now() + CACHE_TTL_MS })
  return value
}

export function invalidateAppTokenCache(): void {
  cache.clear()
}

export function appTokenExpired(token: B24AppToken, now = new Date()): boolean {
  return token.expiresAt.getTime() <= now.getTime()
}

/** Выпускает новую пару токенов и отзывает предыдущие пары этого приложения. */
export async function issueTokenPair(
  app: Pick<B24App, 'id' | 'scope'>,
  portalUserId: number,
): Promise<B24AppToken> {
  const now = Date.now()
  // Боевой портал выдаёт новую пару при каждой отрисовке фрейма, а прежняя
  // продолжает действовать до своего срока. Здесь так же: старые не отзываем,
  // иначе открытая в соседней вкладке копия приложения внезапно теряет доступ.
  const token = await prisma.b24AppToken.create({
    data: {
      appId: app.id,
      accessToken: generateOpaqueToken(),
      refreshToken: generateOpaqueToken(),
      portalUserId,
      scope: app.scope,
      expiresAt: new Date(now + B24_TOKEN_TTL_SECONDS * 1000),
      refreshExpiresAt: new Date(now + B24_REFRESH_TTL_SECONDS * 1000),
    },
  })
  invalidateAppTokenCache()
  return token
}

/**
 * Обновление по refresh_token.
 *
 * Возвращает null, если код не найден или просрочен: боевой сервер авторизации
 * отвечает на это invalid_grant и требует пройти OAuth заново.
 */
export async function refreshTokenPair(refreshToken: string): Promise<{ app: B24App; token: B24AppToken } | null> {
  const existing = await prisma.b24AppToken.findUnique({
    where: { refreshToken },
    include: { app: true },
  })
  if (!existing || existing.revokedAt) return null
  if (existing.refreshExpiresAt.getTime() <= Date.now()) return null
  if (existing.app.state === 'uninstalled') return null

  const now = Date.now()
  const [, created] = await prisma.$transaction([
    // Прежняя пара гасится: документация прямо требует сохранить новый refresh_token
    // вместо старого, и мок, продолжающий принимать старый, скроет ошибку хранения.
    prisma.b24AppToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } }),
    prisma.b24AppToken.create({
      data: {
        appId: existing.appId,
        accessToken: generateOpaqueToken(),
        refreshToken: generateOpaqueToken(),
        portalUserId: existing.portalUserId,
        scope: existing.scope,
        expiresAt: new Date(now + B24_TOKEN_TTL_SECONDS * 1000),
        refreshExpiresAt: new Date(now + B24_REFRESH_TTL_SECONDS * 1000),
      },
    }),
  ])

  invalidateAppTokenCache()
  return { app: existing.app, token: created }
}

/** Отзывает все токены приложения. Вызывается при удалении и при сбросе установки. */
export async function revokeAppTokens(appId: string): Promise<void> {
  await prisma.b24AppToken.updateMany({
    where: { appId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  invalidateAppTokenCache()
}

/** Ответ сервера авторизации. Имена полей совпадают с боевыми дословно. */
export function tokenResponse(app: B24App, token: B24AppToken, sandboxId: string): B24TokenResponse {
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_in: B24_TOKEN_TTL_SECONDS,
    expires: Math.floor(token.expiresAt.getTime() / 1000),
    scope: token.scope.join(','),
    domain: portalDomain(),
    server_endpoint: serverEndpoint(),
    client_endpoint: clientEndpoint(),
    member_id: memberIdFor(sandboxId),
    status: B24_APP_STATUS_LOCAL,
    user_id: token.portalUserId,
  }
}

/** Одноразовый авторизационный код. Живёт 30 секунд, как в бою. */
export async function issueAuthCode(
  appId: string,
  portalUserId: number,
  state: string | null,
): Promise<string> {
  const code = generateOpaqueToken()
  await prisma.b24AuthCode.create({
    data: {
      appId,
      code,
      portalUserId,
      state,
      expiresAt: new Date(Date.now() + B24_AUTH_CODE_TTL_SECONDS * 1000),
    },
  })
  return code
}

/** Гасит код и возвращает приложение. null — код неизвестен, просрочен или уже использован. */
export async function consumeAuthCode(code: string): Promise<{ app: B24App; portalUserId: number } | null> {
  const row = await prisma.b24AuthCode.findUnique({ where: { code }, include: { app: true } })
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null

  // Гасим условием на usedAt: два одновременных обмена одним кодом должны
  // закончиться выдачей ровно одной пары токенов.
  const claimed = await prisma.b24AuthCode.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (claimed.count === 0) return null

  return { app: row.app, portalUserId: row.portalUserId }
}
