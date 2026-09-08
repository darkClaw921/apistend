import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { hashPassword, verifyPassword, generateKey } from '../lib/keys.ts'
import { clearSession, issueSession, readSession, revokeSession } from '../lib/auth.ts'
import { SERVICE_LIST } from '@apistend/shared'
import { engine } from '../gateway.ts'

/** Вход и регистрация по логину и паролю. Без подтверждения почты и OAuth. */

const credentials = z.object({
  email: z.email('Введите корректный адрес почты').max(200),
  password: z.string().min(8, 'Пароль не короче 8 символов').max(200),
})

const registration = credentials.extend({
  /**
   * Имя необязательно: на экране регистрации его не спрашивают — по макету
   * там email, пароль и проект. Когда его нет, берём часть адреса до собаки:
   * это лучше пустого места в подписи пользователя, чем «Без имени».
   */
  name: z.string().min(2, 'Укажите имя').max(80).optional(),
  /** Имя проекта. Стоит в хлебных крошках кабинета и в баннере CLI. */
  project: z.string().min(2, 'Название проекта не короче 2 символов').max(80).optional(),
})

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'AP'
}

/** «igor.gerasimov@acme.ru» → «Igor.gerasimov». Запасное имя, когда его не спросили. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'user'
  return local.charAt(0).toUpperCase() + local.slice(1)
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = registration.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const { email, password } = parsed.data
    const normalizedEmail = email.toLowerCase()
    const name = parsed.data.name ?? nameFromEmail(normalizedEmail)
    const project = parsed.data.project ?? 'Первый проект'

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
    if (existing) {
      return reply.code(409).send({ error: 'EMAIL_TAKEN', message: 'Аккаунт с такой почтой уже существует' })
    }

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await hashPassword(password),
        name,
        initials: initialsOf(name),
      },
    })

    // Новому аккаунту сразу выдаём песочницу и ключ: без них продуктом нельзя пользоваться.
    const sandbox = await prisma.sandbox.create({
      data: { userId: user.id, name: 'sandbox-01', project },
    })
    const key = generateKey('sandbox')
    await prisma.apiKey.create({
      data: {
        sandboxId: sandbox.id,
        name: 'Первый ключ',
        subtitle: 'Создан при регистрации',
        kind: 'sandbox',
        prefix: key.prefix,
        suffix: key.suffix,
        keyHash: key.hash,
        services: ['bitrix24', 'ozon', 'wildberries'],
      },
    })

    await issueSession(reply, { userId: user.id, email: user.email }, req)
    return reply.code(201).send({
      user: { id: user.id, email: user.email, name: user.name, initials: user.initials },
      sandbox: { id: sandbox.id, name: sandbox.name, project: sandbox.project },
      // Полный ключ показывается ровно один раз — здесь.
      apiKey: key.full,
    })
  })

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = credentials.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION', issues: parsed.error.issues.map((i) => i.message) })
    }
    const email = parsed.data.email.toLowerCase()
    const user = await prisma.user.findUnique({ where: { email } })

    // Одинаковый ответ и текст для «нет такого пользователя» и «неверный пароль»:
    // иначе форма превращается в способ узнать, есть ли аккаунт.
    const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false
    if (!user || !ok) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Неверная почта или пароль' })
    }

    await issueSession(reply, { userId: user.id, email: user.email }, req)
    return reply.send({ user: { id: user.id, email: user.email, name: user.name, initials: user.initials } })
  })

  app.post('/api/auth/logout', async (req, reply) => {
    // Гасим запись сессии, а не только cookie: иначе скопированный токен
    // продолжал бы работать до конца своего срока.
    await revokeSession(req)
    clearSession(reply)
    return reply.send({ ok: true })
  })

  app.get('/api/auth/me', async (req, reply) => {
    const session = await readSession(req)
    if (!session) return reply.code(401).send({ error: 'UNAUTHORIZED' })

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: { sandboxes: { orderBy: { createdAt: 'asc' } } },
    })
    if (!user) {
      clearSession(reply)
      return reply.code(401).send({ error: 'UNAUTHORIZED' })
    }

    // Счётчики в сайдбаре берутся из данных, а не зашиваются в вёрстку.
    const primary = user.sandboxes[0]
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    // Шесть счётчиков одним заходом: сайдбар рисуется на каждом экране, и делать
    // ради него пять последовательных запросов к базе — значит платить их
    // задержками при каждом переходе.
    const [requestsThisMonth, requestsToday, keys, mocks, webhooks, alerts] = primary
      ? await Promise.all([
          prisma.requestLog.count({
            where: { sandboxId: primary.id, timestamp: { gte: new Date(Date.now() - 30 * 86_400_000) } },
          }),
          prisma.requestLog.count({ where: { sandboxId: primary.id, timestamp: { gte: startOfDay } } }),
          // Не revoked, а не status: 'active': ключ со статусом expiring продолжает
          // работать. Считаем так же, как KPI «Активных ключей» на «Обзоре», —
          // два разных числа под одной подписью на соседних панелях хуже, чем
          // любое из них по отдельности.
          prisma.apiKey.count({ where: { sandboxId: primary.id, status: { not: 'revoked' } } }),
          prisma.customMock.count({ where: { sandboxId: primary.id } }),
          prisma.webhook.count({ where: { sandboxId: primary.id } }),
          prisma.alert.count({ where: { sandboxId: primary.id } }),
        ])
      : [0, 0, 0, 0, 0, 0]

    /**
     * «Первые шаги» в сайдбаре — не украшение: каждый шаг проверяется по данным.
     * Показывать выдуманный прогресс нельзя, а держать блок после того, как всё
     * пройдено, незачем — клиент прячет его, когда done === steps.length.
     */
    const onboarding = [
      { id: 'key', label: 'Создайте ключ', href: '/keys', done: keys > 0 },
      { id: 'request', label: 'Сделайте первый запрос', href: '/console', done: requestsThisMonth > 0 },
      { id: 'mock', label: 'Заведите свой мок', href: '/mocks', done: mocks > 0 },
      { id: 'webhook', label: 'Подключите вебхук', href: '/webhooks', done: webhooks > 0 },
    ]

    return reply.send({
      user: {
        id: user.id, email: user.email, name: user.name,
        initials: user.initials, planLabel: user.planLabel,
      },
      usage: { requestsThisMonth, hasLimits: false },
      counts: {
        requestsToday,
        keys,
        mocks,
        webhooks,
        // Точка на колокольчике. Прочитанность уведомлений мы не храним, поэтому
        // точка означает ровно «уведомления есть», а не «есть непрочитанные».
        alerts,
        // Каталог общий для всех аккаунтов и живёт в памяти движка — в базу не ходим.
        catalogMethods: SERVICE_LIST.reduce((n, s) => n + engine.catalog(s.code).length, 0),
      },
      onboarding,
      sandboxes: user.sandboxes.map((s) => ({
        id: s.id, name: s.name, project: s.project, status: s.status,
        dataVolume: s.dataVolume, latencyMs: s.latencyMs, errorRate: s.errorRate,
        lastResetAt: s.lastResetAt,
      })),
    })
  })
}
