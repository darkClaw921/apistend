import { SignJWT, jwtVerify } from 'jose'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../env.ts'

/**
 * Сессия пользователя. Логин и пароль, без подтверждения почты и OAuth —
 * ровно то, что заказано для первой версии.
 *
 * Токен живёт в httpOnly-cookie: JavaScript страницы до него не добирается,
 * поэтому XSS не приводит к угону сессии.
 */

const COOKIE = 'apistend_session'
const TTL_SECONDS = 60 * 60 * 24 * 14

const secret = new TextEncoder().encode(env.jwtSecret)

export interface SessionClaims {
  userId: string
  email: string
}

export async function issueSession(reply: FastifyReply, claims: SessionClaims): Promise<void> {
  const token = await new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret)

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
    return { userId: payload.sub, email: String(payload.email ?? '') }
  } catch {
    return null
  }
}
