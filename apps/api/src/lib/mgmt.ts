import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Sandbox, User } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { env } from '../env.ts'
import { readSession } from './auth.ts'
import { resolveApiKey } from './api-key.ts'
import { keyKindOf } from './keys.ts'
import { recordKeyUsage } from './key-usage.ts'

/**
 * Management API: кто вызывает и что ему разрешено.
 *
 * Публичный API обязан принимать оба способа входа. Скрипт и CLI приходят
 * с серверным ключом в заголовке Authorization; кабинет — с cookie-сессией.
 * Иначе браузерной части пришлось бы держать вторую пару маршрутов для того же
 * самого, и они бы разошлись.
 *
 * Владелец аккаунта определяется по цепочке ApiKey → Sandbox → User: своего
 * поля userId у ключа нет. Из этого следует и правило умолчания — песочница
 * ключа считается текущей, пока в запросе не указана другая.
 */

/**
 * Области доступа.
 *
 * Ключ с пустым списком — полный доступ. Так работают все ключи, выданные
 * до появления областей, и так же выглядит «ключ для себя»: требовать
 * перечисления прав от человека, у которого одна песочница, — лишний обряд.
 *
 * Право на запись включает право на чтение того же ресурса: возможность
 * изменить вебхук без возможности его прочитать не имеет смысла, а держать
 * в ключе обе строки — лишний повод ошибиться.
 */
export const MGMT_SCOPES = [
  '*',
  'account:read',
  'account:write',
  'sandboxes:read',
  'sandboxes:write',
  'keys:read',
  'keys:write',
  'webhooks:read',
  'webhooks:write',
  'scenarios:read',
  'scenarios:write',
  'bursts:read',
  'bursts:write',
  'mocks:read',
  'mocks:write',
  'logs:read',
  'logs:write',
  'catalog:read',
  'apps:read',
  'apps:write',
  'console:write',
  'tunnel:read',
] as const

export type Scope = (typeof MGMT_SCOPES)[number]

/** Готовая схема для маршрутов, которые принимают список областей (создание ключа). */
export const scopeSchema = z.enum(MGMT_SCOPES)

/** Подписи для документации и для экрана выдачи ключа. */
export const MGMT_SCOPE_LABELS: Record<Scope, string> = {
  '*': 'полный доступ',
  'account:read': 'профиль и сводка аккаунта',
  'account:write': 'изменение профиля, пароля, сессий',
  'sandboxes:read': 'список и настройки песочниц',
  'sandboxes:write': 'создание, изменение, сброс песочниц',
  'keys:read': 'список ключей',
  'keys:write': 'выпуск, ротация и отзыв ключей',
  'webhooks:read': 'подписки и журнал доставок',
  'webhooks:write': 'создание подписок и тестовые отправки',
  'scenarios:read': 'сценарии симуляции',
  'scenarios:write': 'создание и запуск сценариев',
  'bursts:read': 'состояние серий событий',
  'bursts:write': 'запуск и остановка серий событий',
  'mocks:read': 'свои моки',
  'mocks:write': 'создание и изменение своих моков',
  'logs:read': 'журнал запросов',
  'logs:write': 'очистка журнала запросов',
  'catalog:read': 'каталог методов и сервисов',
  'apps:read': 'локальные приложения Bitrix24 и их токены',
  'apps:write': 'создание, установка и удаление приложений',
  'console:write': 'вызов методов через консоль',
  'tunnel:read': 'состояние туннелей CLI',
}

export interface MgmtCtx {
  userId: string
  user: User
  via: 'key' | 'session'
  /** null у сессии кабинета: там ключа нет. */
  apiKeyId: string | null
  /** Что реально выдано субъекту. Пустой массив — ограничений нет. */
  scopes: string[]
  /** Песочница ключа, а для сессии — первая песочница аккаунта. */
  defaultSandboxId: string | null
}

export type MgmtSandboxCtx = MgmtCtx & { sandbox: Sandbox }

/**
 * Конверт ошибки — тот же, что и в кабинете: { error, message, issues? }.
 *
 * Возвращаемый тип never, а не void: тогда обработчик маршрута с любым типом
 * ответа может написать `return notFound(reply, …)`, не подгоняя типы.
 * Фактическое значение — null, его никто не читает.
 */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  issues?: string[],
): never {
  void reply.code(status).send(issues && issues.length > 0 ? { error: code, message, issues } : { error: code, message })
  return null as never
}

// ─────────────────────────── Ограничение частоты ───────────────────────────

/**
 * Дырявое ведро на субъект.
 *
 * Это защита APIStend, а не эмуляция чужих лимитов (та живёт в lib/rate-limit.ts
 * и считает по паре ключ+сервис). Ёмкость равна минутной норме: короткая пачка
 * (CLI при старте опрашивает песочницу, ключи и вебхуки разом) проходит целиком,
 * а ровный поток упирается в норму.
 *
 * В памяти процесса: при нескольких инстансах лимит станет кратно мягче, и это
 * осознанный размен — поход в общее хранилище на каждый запрос стоит дороже,
 * чем сам запрос к Management API.
 */
interface Bucket {
  tokens: number
  filledAt: number
}

const buckets = new Map<string, Bucket>()
let lastSweep = 0

export interface MgmtRateVerdict {
  allowed: boolean
  limit: number
  remaining: number
  /** Через сколько секунд освободится хотя бы один запрос. */
  resetInSeconds: number
}

export function checkMgmtRate(subject: string, now: number = Date.now()): MgmtRateVerdict {
  const limit = Math.max(1, env.mgmtRateLimitPerMin)
  const perMs = limit / 60_000

  if (now - lastSweep > 60_000) {
    // Полное ведро неотличимо от отсутствующего — держать его в памяти незачем.
    for (const [key, bucket] of buckets) {
      if (bucket.tokens + (now - bucket.filledAt) * perMs >= limit) buckets.delete(key)
    }
    lastSweep = now
  }

  const bucket = buckets.get(subject) ?? { tokens: limit, filledAt: now }
  bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.filledAt) * perMs)
  bucket.filledAt = now

  const allowed = bucket.tokens >= 1
  if (allowed) bucket.tokens -= 1
  buckets.set(subject, bucket)

  return {
    allowed,
    limit,
    remaining: Math.max(0, Math.floor(bucket.tokens)),
    resetInSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)),
  }
}

/**
 * Отдельное, куда более строгое ведро для дорогих маршрутов.
 *
 * Выгрузка журнала читает до ста тысяч записей за запрос и собирает их в памяти
 * одного процесса — того же, который обслуживает мок-шлюз. На общей норме
 * в несколько сотен запросов в минуту десяток параллельных выгрузок кладёт сервис,
 * не нарушая ни одного лимита. Считается тем же ведром, но своим счётчиком
 * и своим ключом, поэтому обычные запросы от этого не страдают.
 */
const HEAVY_PER_MINUTE = 6
const heavyBuckets = new Map<string, Bucket>()

export function checkHeavyRate(subject: string, now: number = Date.now()): MgmtRateVerdict {
  const perMs = HEAVY_PER_MINUTE / 60_000
  const bucket = heavyBuckets.get(subject) ?? { tokens: HEAVY_PER_MINUTE, filledAt: now }
  bucket.tokens = Math.min(HEAVY_PER_MINUTE, bucket.tokens + (now - bucket.filledAt) * perMs)
  bucket.filledAt = now

  const allowed = bucket.tokens >= 1
  if (allowed) bucket.tokens -= 1
  heavyBuckets.set(subject, bucket)

  return {
    allowed,
    limit: HEAVY_PER_MINUTE,
    remaining: Math.max(0, Math.floor(bucket.tokens)),
    resetInSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)),
  }
}

export function mgmtRateStats(): { subjects: number } {
  return { subjects: buckets.size + heavyBuckets.size }
}

function applyRateHeaders(reply: FastifyReply, verdict: MgmtRateVerdict): void {
  reply.header('x-ratelimit-limit', String(verdict.limit))
  reply.header('x-ratelimit-remaining', String(verdict.remaining))
  reply.header('x-ratelimit-reset', String(verdict.resetInSeconds))
}

// ─────────────────────────── Опознание субъекта ───────────────────────────

type AuthOutcome =
  | { ok: true; subject: string; ctx: MgmtCtx }
  | { ok: false; subject: string; code: string; message: string }

/** null — заголовка нет; пустая строка — заголовок есть, но это не «Bearer …». */
function bearerOf(req: FastifyRequest): string | null {
  const raw = req.headers.authorization
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m?.[1]?.trim() ?? ''
}

async function authenticate(req: FastifyRequest): Promise<AuthOutcome> {
  // Пока субъект не опознан, лимит считается по адресу: перебор ключей должен
  // упираться в тот же потолок, что и обычная работа.
  const anonymous = `ip:${req.ip}`
  const bearer = bearerOf(req)

  if (bearer !== null) {
    if (bearer.length === 0) {
      return { ok: false, subject: anonymous, code: 'UNAUTHORIZED', message: 'Заголовок Authorization должен быть вида «Bearer stend_sk_…»' }
    }

    const kind = keyKindOf(bearer)
    if (kind === 'sandbox') {
      return {
        ok: false,
        subject: anonymous,
        code: 'SANDBOX_KEY_NOT_ALLOWED',
        // Ключ песочницы лежит в коде интеграции и в конфигах — он утекает
        // легче всего, а Management API умеет удалять данные и выпускать ключи.
        message:
          'Ключ песочницы (stend_sbx_…) в Management API не принимается: им ходит код интеграции, ' +
          'и утечь он может вместе с любым конфигом. Нужен серверный ключ stend_sk_… — ' +
          'создайте его на экране «Ключи и токены» или командой apistend keys create --kind server',
      }
    }
    if (kind !== 'server') {
      return { ok: false, subject: anonymous, code: 'UNAUTHORIZED', message: 'Это не ключ APIStend. Ожидается «Bearer stend_sk_…»' }
    }

    const resolved = await resolveApiKey(bearer)
    if (!resolved) {
      // Один текст на «нет такого», «отозван» и «просрочен»: подробность здесь
      // подсказывала бы перебору, какой ключ существует.
      return { ok: false, subject: anonymous, code: 'UNAUTHORIZED', message: 'Ключ недействителен: не существует, отозван или просрочен' }
    }

    const user = await prisma.user.findUnique({ where: { id: resolved.sandbox.userId } })
    if (!user) return { ok: false, subject: anonymous, code: 'UNAUTHORIZED', message: 'Владелец ключа не найден' }

    return {
      ok: true,
      subject: `key:${resolved.apiKey.id}`,
      ctx: {
        userId: user.id,
        user,
        via: 'key',
        apiKeyId: resolved.apiKey.id,
        scopes: resolved.apiKey.scopes,
        defaultSandboxId: resolved.apiKey.sandboxId,
      },
    }
  }

  const session = await readSession(req)
  if (!session) {
    return {
      ok: false,
      subject: anonymous,
      code: 'UNAUTHORIZED',
      message: 'Требуется серверный ключ в заголовке «Authorization: Bearer stend_sk_…» или вход в кабинет',
    }
  }

  // Пользователь и его первая песочница одним запросом: сессия и так стоила
  // похода в базу за записью сессии, третий подряд был бы уже расточительством.
  const row = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { sandboxes: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true } } },
  })
  if (!row) return { ok: false, subject: anonymous, code: 'UNAUTHORIZED', message: 'Пользователь не найден' }

  const { sandboxes, ...user } = row
  return {
    ok: true,
    subject: `session:${user.id}`,
    ctx: {
      userId: user.id,
      user,
      via: 'session',
      apiKeyId: null,
      // Сессия кабинета — это сам владелец аккаунта, урезать его в правах нечем:
      // всё то же самое он делает мышкой на соседнем экране.
      scopes: ['*'],
      defaultSandboxId: sandboxes[0]?.id ?? null,
    },
  }
}

export function hasScope(granted: readonly string[], required: Scope): boolean {
  if (granted.length === 0 || granted.includes('*') || granted.includes(required)) return true
  const [resource, action] = required.split(':')
  return action === 'read' && granted.includes(`${resource}:write`)
}

/**
 * Опознаёт вызывающего и проверяет право. Сам отвечает 401 / 403 / 429
 * и возвращает null — обработчику остаётся `if (!ctx) return`.
 */
export async function requireMgmt(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: Scope,
): Promise<MgmtCtx | null> {
  const auth = await authenticate(req)

  const verdict = checkMgmtRate(auth.subject)
  applyRateHeaders(reply, verdict)
  if (!verdict.allowed) {
    reply.header('retry-after', String(verdict.resetInSeconds))
    return sendError(
      reply,
      429,
      'RATE_LIMITED',
      `Слишком много запросов к Management API: не больше ${verdict.limit} в минуту. Повторите через ${verdict.resetInSeconds} с.`,
    )
  }

  if (!auth.ok) return sendError(reply, 401, auth.code, auth.message)

  if (!hasScope(auth.ctx.scopes, scope)) {
    return sendError(
      reply,
      403,
      'FORBIDDEN',
      `Ключу не выдана область доступа «${scope}» (${MGMT_SCOPE_LABELS[scope]}). Выданы: ${auth.ctx.scopes.join(', ')}`,
    )
  }

  // Через буфер, а не UPDATE на каждый вызов. Побочный эффект — в счётчике
  // requestsPerDay на экране ключей вызовы Management API тоже видны; это честно:
  // ключ действительно работал.
  if (auth.ctx.apiKeyId) recordKeyUsage(auth.ctx.apiKeyId)

  return auth.ctx
}

/** Пустая строка в ?sandboxId= — это «не указано», а не «песочница с пустым идентификатором». */
function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * То же, что requireMgmt, плюс текущая песочница.
 *
 * Порядок поиска: :sandboxId в пути → ?sandboxId= → песочница ключа →
 * первая песочница аккаунта. Последние два шага и делают API удобным для скрипта:
 * у кого одна песочница, тот про неё вообще не вспоминает.
 */
export async function requireMgmtSandbox(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: Scope,
): Promise<MgmtSandboxCtx | null> {
  const ctx = await requireMgmt(req, reply, scope)
  if (!ctx) return null

  const fromPath = trimmed((req.params as { sandboxId?: unknown } | undefined)?.sandboxId)
  const fromQuery = trimmed((req.query as { sandboxId?: unknown } | undefined)?.sandboxId)
  const wanted = fromPath ?? fromQuery ?? ctx.defaultSandboxId

  if (!wanted) {
    return sendError(reply, 404, 'SANDBOX_NOT_FOUND', 'У аккаунта нет ни одной песочницы. Создайте её через POST /api/v1/sandboxes')
  }

  // Чужая песочница даёт 404, а не 403: по разнице кодов чужие идентификаторы
  // перебираются на существование.
  const sandbox = await prisma.sandbox.findFirst({ where: { id: wanted, userId: ctx.userId } })
  if (!sandbox) return sendError(reply, 404, 'SANDBOX_NOT_FOUND', `Песочница «${wanted}» не найдена`)

  return { ...ctx, sandbox }
}
