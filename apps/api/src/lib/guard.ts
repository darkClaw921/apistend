import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Sandbox } from '@prisma/client'
import { prisma } from '../db.ts'
import { readSession } from './auth.ts'

/** Достаёт текущего пользователя и его песочницу. Отвечает 401/404 сам. */
export async function requireSandbox(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; sandbox: Sandbox } | null> {
  const session = await readSession(req)
  if (!session) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Требуется вход' })
    return null
  }

  const requested = (req.query as { sandboxId?: string } | undefined)?.sandboxId
  const sandbox = requested
    ? await prisma.sandbox.findFirst({ where: { id: requested, userId: session.userId } })
    : await prisma.sandbox.findFirst({ where: { userId: session.userId }, orderBy: { createdAt: 'asc' } })

  if (!sandbox) {
    await reply.code(404).send({ error: 'SANDBOX_NOT_FOUND', message: 'Песочница не найдена' })
    return null
  }
  return { userId: session.userId, sandbox }
}

/**
 * Число из query-параметра. Number('abc') даёт NaN, а Math.min/Math.max с NaN
 * возвращают NaN — и срез по такому «лимиту» молча отдавал пустой список,
 * хотя совпадения были. Непонятное значение теперь равнозначно отсутствию.
 */
export function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}
