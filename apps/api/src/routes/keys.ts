import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { SERVICE_CODES, SERVICE_LIST } from '@apistend/shared'
import { prisma } from '../db.ts'
import { generateKey, maskOf } from '../lib/keys.ts'
import { invalidateKeyCache } from '../lib/api-key.ts'
import { requireSandbox } from '../lib/guard.ts'
import { env } from '../env.ts'

/** Экран «Ключи и токены». Лимитов на количество ключей и запросов у продукта нет. */

const createBody = z.object({
  name: z.string().min(2, 'Название не короче 2 символов').max(80),
  subtitle: z.string().max(120).optional(),
  kind: z.enum(['sandbox', 'server']).default('sandbox'),
  services: z.array(z.enum(SERVICE_CODES)).min(1, 'Выберите хотя бы один сервис'),
  rotationDays: z.number().int().min(1).max(365).default(90),
})

export function registerKeyRoutes(app: FastifyInstance): void {
  app.get('/api/keys', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const keys = await prisma.apiKey.findMany({
      where: { sandboxId: ctx.sandbox.id },
      orderBy: { createdAt: 'desc' },
    })

    return reply.send({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        subtitle: k.subtitle,
        kind: k.kind,
        mask: maskOf(k.prefix, k.suffix),
        services: k.services,
        status: k.status,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        revokedBy: k.revokedBy,
        // Просто число: лимитов нет, прогресс-бара в этой колонке быть не должно.
        requestsPerDay: k.requestsPerDay,
        rotationDays: k.rotationDays,
      })),
      summary: {
        total: keys.length,
        active: keys.filter((k) => k.status === 'active').length,
        revoked: keys.filter((k) => k.status === 'revoked').length,
        note: 'количество ключей не ограничено',
        rotationNote: 'Ротация ключей раз в 90 дней',
      },
      baseUrls: SERVICE_LIST.map((p) => ({
        code: p.code,
        title: p.title,
        letter: p.letter,
        shortCode: p.shortCode,
        brandToken: p.brandToken,
        mockUrl: `${env.publicOrigin}${p.mountPath}/`,
        replaces: p.replacesUrl,
      })),
    })
  })

  /**
   * Сброс демо-данных песочницы.
   *
   * Базовый набор общий и только на чтение — сбрасывать в нём нечего. Личное
   * пользователя лежит в overlay: созданное, изменённое и удалённое поверх базы.
   * Поэтому сброс — это удаление overlay, ровно как задумано моделью данных,
   * и он не трогает ни ключи, ни вебхуки, ни свои моки.
   */
  app.post('/api/sandbox/reset', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const removed = await prisma.sandboxOverlay.deleteMany({ where: { sandboxId: ctx.sandbox.id } })
    const sandbox = await prisma.sandbox.update({
      where: { id: ctx.sandbox.id },
      data: { lastResetAt: new Date() },
      select: { lastResetAt: true },
    })

    return reply.send({ removed: removed.count, lastResetAt: sandbox.lastResetAt })
  })

  app.post('/api/keys', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }

    const generated = generateKey(parsed.data.kind)
    const created = await prisma.apiKey.create({
      data: {
        sandboxId: ctx.sandbox.id,
        name: parsed.data.name,
        subtitle: parsed.data.subtitle ?? null,
        kind: parsed.data.kind,
        prefix: generated.prefix,
        suffix: generated.suffix,
        keyHash: generated.hash,
        services: parsed.data.services,
        rotationDays: parsed.data.rotationDays,
      },
    })

    return reply.code(201).send({
      key: { id: created.id, name: created.name, mask: maskOf(created.prefix, created.suffix) },
      // Единственный момент, когда полный ключ покидает сервер.
      secret: generated.full,
      warning: 'Сохраните ключ: полностью он показывается только сейчас',
    })
  })

  /** Отзыв. Необратим: подтверждение вводом названия проверяется и на сервере. */
  app.post<{ Params: { id: string } }>('/api/keys/:id/revoke', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const confirm = (req.body as { confirmName?: string } | undefined)?.confirmName
    const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!key) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (key.status === 'revoked') return reply.code(409).send({ error: 'ALREADY_REVOKED' })

    // Клиент блокирует кнопку до точного совпадения, но полагаться на клиент нельзя.
    if (confirm !== key.name) {
      return reply.code(400).send({
        error: 'CONFIRM_MISMATCH',
        message: 'Введите точное название ключа для подтверждения',
      })
    }

    const user = await prisma.user.findUnique({ where: { id: ctx.userId } })
    const updated = await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'revoked', revokedAt: new Date(), revokedBy: user?.name ?? null },
    })
    // Без сброса кеша отзыв «подвисал» бы на время TTL.
    invalidateKeyCache()

    return reply.send({ id: updated.id, status: updated.status, revokedAt: updated.revokedAt })
  })

  /** Ротация: старый ключ отзывается, новый выдаётся с теми же правами. */
  app.post<{ Params: { id: string } }>('/api/keys/:id/rotate', async (req, reply) => {
    const ctx = await requireSandbox(req, reply)
    if (!ctx) return

    const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, sandboxId: ctx.sandbox.id } })
    if (!key) return reply.code(404).send({ error: 'NOT_FOUND' })

    const generated = generateKey(key.kind)
    const [, created] = await prisma.$transaction([
      prisma.apiKey.update({
        where: { id: key.id },
        data: { status: 'revoked', revokedAt: new Date(), revokedBy: 'ротация' },
      }),
      prisma.apiKey.create({
        data: {
          sandboxId: ctx.sandbox.id,
          name: key.name,
          subtitle: key.subtitle,
          kind: key.kind,
          prefix: generated.prefix,
          suffix: generated.suffix,
          keyHash: generated.hash,
          services: key.services,
          rotationDays: key.rotationDays,
        },
      }),
    ])
    invalidateKeyCache()

    return reply.code(201).send({
      key: { id: created.id, name: created.name, mask: maskOf(created.prefix, created.suffix) },
      secret: generated.full,
      replaced: key.id,
    })
  })
}
