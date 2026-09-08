import { B24_APP_STATUS_LOCAL, B24_TOKEN_TTL_SECONDS } from '@apistend/shared'
import { prisma } from '../db.ts'
import type { AppAuthEnvelope } from '../webhooks/dispatcher.ts'
import { clientEndpoint, memberIdFor, serverEndpoint } from './portal.ts'
import { issueTokenPair } from './tokens.ts'

/**
 * Конверт авторизации, который уходит приложению вместе с событием.
 *
 * Отдельный модуль, потому что им пользуется диспетчер доставок, а тянуть туда
 * весь раздел приложений незачем.
 *
 * Токен берётся действующий, а если такого нет — выписывается новый. Боевой портал
 * поступает так же: событие приложению без рабочего access_token бессмысленно,
 * обработчик всё равно первым делом полезет в REST.
 */
export async function loadAppAuth(appId: string): Promise<AppAuthEnvelope | null> {
  const app = await prisma.b24App.findUnique({ where: { id: appId } })
  if (!app || app.state === 'uninstalled') return null

  const existing = await prisma.b24AppToken.findFirst({
    // Замещённая обновлением пара не годится: её access_token уже мёртв,
    // и приложение получило бы вместе с событием заведомо нерабочий токен.
    where: {
      appId, revokedAt: null, supersededAt: null,
      expiresAt: { gt: new Date(Date.now() + 60_000) },
    },
    orderBy: { createdAt: 'desc' },
  })
  const token = existing ?? (await issueTokenPair(app, 1))

  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresIn: Math.max(Math.floor((token.expiresAt.getTime() - Date.now()) / 1000), 0) || B24_TOKEN_TTL_SECONDS,
    scope: token.scope,
    memberId: memberIdFor(app.sandboxId),
    clientEndpoint: clientEndpoint(),
    serverEndpoint: serverEndpoint(),
    status: B24_APP_STATUS_LOCAL,
    applicationToken: app.applicationToken,
  }
}
