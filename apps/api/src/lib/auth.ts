import { createHash, randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../env.ts'
import { prisma } from '../db.ts'

/**
 * Сессия пользователя. Логин и пароль, без подтверждения почты и OAuth —
 * ровно то, что заказано для первой версии.
 *
 * Токен живёт в httpOnly-cookie: JavaScript страницы до него не добирается,
 * поэтому XSS не приводит к угону сессии.
 *
 * Рядом с токеном ведётся запись в таблице сессий. Без неё выход не значил
 * ничего: cookie удалялась в браузере, а сам токен оставался действительным
 * ещё две недели — скопированный с чужого компьютера, он продолжал работать.
 * Теперь у токена есть идентификатор, и выход эту запись удаляет.
 */

const COOKIE = 'apistend_session'
/** Имя cookie нужно и Management API: он описывает cookieAuth в OpenAPI. */
export const SESSION_COOKIE = COOKIE
const TTL_SECONDS = 60 * 60 * 24 * 14

const secret = new TextEncoder().encode(env.jwtSecret)

export interface SessionClaims {
  userId: string
  login: string
}

/** Хеш, а не сам идентификатор: в базе секретов не держим. */
function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function issueSession(
  reply: FastifyReply,
  claims: SessionClaims,
  request?: FastifyRequest,
): Promise<void> {
  const sessionId = randomUUID()
  const token = await new SignJWT({ login: claims.login, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret)

  await prisma.authSession.create({
    data: {
      userId: claims.userId,
      tokenHash: hashOf(sessionId),
      userAgent: request?.headers['user-agent']?.slice(0, 200) ?? null,
      ip: request?.ip ?? null,
      expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
    },
  })

  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    maxAge: TTL_SECONDS,
  })
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' })
}

export async function readSession(request: FastifyRequest): Promise<SessionClaims | null> {
  const token = request.cookies[COOKIE]
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret)
    if (!payload.sub) return null

    // Токен подписан верно, но мог быть отозван выходом.
    const sid = typeof payload.sid === 'string' ? payload.sid : null
    if (!sid) return null
    const live = await prisma.authSession.findUnique({
      where: { tokenHash: hashOf(sid) },
      select: { expiresAt: true },
    })
    if (!live || live.expiresAt.getTime() <= Date.now()) return null

    return { userId: payload.sub, login: String(payload.login ?? '') }
  } catch {
    return null
  }
}

/**
 * Хеш сессии, которой пришёл запрос, — в том виде, в каком он лежит в базе.
 *
 * Нужен управлению сессиями: отметить в списке текущую строку и не погасить её
 * заодно со всеми остальными можно только сравнением с записью, а сам
 * идентификатор наружу не отдаётся. null означает, что текущей сессии нет вовсе:
 * запрос пришёл по серверному ключу либо cookie нечитаема.
 */
export async function currentSessionHash(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[COOKIE]
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret)
    return typeof payload.sid === 'string' ? hashOf(payload.sid) : null
  } catch {
    // Токен нечитаем — считать его чьей-то сессией нельзя.
    return null
  }
}

/** Гасит сессию, которой пришёл запрос. Вызывается выходом. */
export async function revokeSession(request: FastifyRequest): Promise<void> {
  const hash = await currentSessionHash(request)
  if (hash) await prisma.authSession.deleteMany({ where: { tokenHash: hash } })
}
