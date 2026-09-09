import type { FastifyInstance } from 'fastify'
import { isServiceCode, SERVICE_LIST, SERVICE_PROFILES, type CatalogMethod, type ServiceCode } from '@apistend/shared'
import { engine } from '../gateway.ts'
import { env } from '../env.ts'
import { clampNumber } from '../lib/guard.ts'
import { prisma } from '../db.ts'
import { flushRequestLogs } from '../lib/log-buffer.ts'

/**
 * Каталог методов.
 *
 * Числа (сколько методов, какого числа снимок) отдаются из данных, а не зашиваются
 * в вёрстку: каталог наполняется волнами, и витрина обязана показывать то, что есть.
 */

interface ListQuery {
  service?: string
  q?: string
  method?: string
  readiness?: string
  limit?: string
  offset?: string
}

function toListItem(m: CatalogMethod) {
  return {
    id: m.id,
    serviceCode: m.serviceCode,
    httpMethod: m.httpMethod,
    path: m.path,
    title: m.title,
    description: m.description,
    group: m.group,
    tag: m.tag,
    version: m.version,
    readiness: m.readiness,
    deprecated: m.deprecated,
  }
}

/**
 * Живая статистика использования по сервисам для витрины лендинга.
 *
 * Считается одним запросом на все сервисы сразу и кешируется: страницу открывают
 * анонимные посетители, обновляется она у каждого из них раз в полминуты,
 * и без кеша это была бы четвёрка агрегатов по журналу на каждый показ.
 *
 * «Пользователи», а не «песочницы»: у одного аккаунта их может быть несколько,
 * и число песочниц отвечало бы на другой вопрос.
 */
interface ServiceUsage {
  requestsTotal: number
  requestsDay: number
  users: number
  usersOnline: number
}

const USAGE_TTL_MS = 30_000
let usageCache: { at: number; value: Record<string, ServiceUsage> } | null = null

async function serviceUsage(): Promise<Record<string, ServiceUsage>> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value

  // Буфер журнала сбрасываем: иначе последние запросы «появятся» на витрине
  // только со следующим флашем, и счётчик будет отставать от того, что человек
  // сам же и сделал минуту назад.
  await flushRequestLogs()

  const rows = await prisma.$queryRaw<
    Array<{ serviceCode: string; total: bigint; day: bigint; users: bigint; online: bigint }>
  >`
    SELECT l."serviceCode",
           count(*) AS total,
           count(*) FILTER (WHERE l."timestamp" > now() - interval '24 hours') AS day,
           count(DISTINCT s."userId") FILTER (WHERE l."timestamp" > now() - interval '30 days') AS users,
           count(DISTINCT s."userId") FILTER (WHERE l."timestamp" > now() - interval '5 minutes') AS online
    FROM request_logs l
    JOIN sandboxes s ON s.id = l."sandboxId"
    GROUP BY l."serviceCode"
  `

  const value: Record<string, ServiceUsage> = {}
  for (const row of rows) {
    value[row.serviceCode] = {
      requestsTotal: Number(row.total),
      requestsDay: Number(row.day),
      users: Number(row.users),
      usersOnline: Number(row.online),
    }
  }
  usageCache = { at: Date.now(), value }
  return value
}

const EMPTY_USAGE: ServiceUsage = { requestsTotal: 0, requestsDay: 0, users: 0, usersOnline: 0 }

export function registerCatalogRoutes(app: FastifyInstance): void {
  /** Сводка по сервисам: панель «Демо-сервисы» и счётчики лендинга. */
  app.get('/api/services', async (_req, reply) => {
    const usage = await serviceUsage()
    const services = SERVICE_LIST.map((profile) => {
      const methods = engine.catalog(profile.code)
      const snapshot = methods[0]?.snapshotDate ?? null
      return {
        code: profile.code,
        title: profile.title,
        letter: profile.letter,
        shortCode: profile.shortCode,
        apiVersion: profile.apiVersion,
        brandToken: profile.brandToken,
        replacesUrl: profile.replacesUrl,
        mockBaseUrl: `${env.publicOrigin}${profile.mountPath}/`,
        methodsCount: methods.length,
        // Пока сервис не заведён — честный статус, а не выдуманное число.
        status: methods.length === 0 ? 'planned' : 'ok',
        snapshotDate: snapshot,
        rateLimit: profile.rateLimit.description,
        nativeAuth: profile.nativeAuth.description,
        usage: usage[profile.code] ?? EMPTY_USAGE,
      }
    })
    const total = services.reduce((sum, s) => sum + s.methodsCount, 0)
    const totals = services.reduce(
      (acc, s) => ({
        requestsTotal: acc.requestsTotal + s.usage.requestsTotal,
        requestsDay: acc.requestsDay + s.usage.requestsDay,
      }),
      { requestsTotal: 0, requestsDay: 0 },
    )
    return reply.send({
      services,
      totalMethods: total,
      usage: { ...totals, generatedAt: new Date().toISOString() },
    })
  })

  app.get<{ Querystring: ListQuery }>('/api/catalog', async (req, reply) => {
    const { service, q, method, readiness } = req.query
    const limit = clampNumber(req.query.limit, 50, 1, 200)
        const offset = clampNumber(req.query.offset, 0, 0, 1_000_000)

    const codes: ServiceCode[] =
      service && isServiceCode(service) ? [service] : SERVICE_LIST.map((s) => s.code)

    let methods = codes.flatMap((c) => engine.catalog(c))

    if (method && method !== 'any') {
      const upper = method.toUpperCase()
      methods = methods.filter((m) => m.httpMethod === upper)
    }
    if (readiness && readiness !== 'any') {
      const allowed = new Set(readiness.split(','))
      methods = methods.filter((m) => allowed.has(m.readiness))
    }
    if (q && q.trim().length >= 2) {
      const needle = q.trim().toLowerCase()
      methods = methods.filter(
        (m) =>
          m.path.toLowerCase().includes(needle) ||
          m.title.toLowerCase().includes(needle) ||
          m.description.toLowerCase().includes(needle),
      )
    }

    const total = methods.length
    const page = methods.slice(offset, offset + limit)

    // Группы нужны для строк-заголовков в списке методов.
    const groups = new Map<string, { serviceCode: string; group: string; count: number }>()
    for (const m of methods) {
      const key = `${m.serviceCode}::${m.group}`
      const g = groups.get(key)
      if (g) g.count++
      else groups.set(key, { serviceCode: m.serviceCode, group: m.group, count: 1 })
    }

    return reply.send({
      total,
      offset,
      limit,
      methods: page.map(toListItem),
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
    })
  })

  app.get<{ Params: { id: string } }>('/api/catalog/:id', async (req, reply) => {
    const id = decodeURIComponent(req.params.id)
    const serviceCode = id.split(':')[0]
    if (!isServiceCode(serviceCode)) return reply.code(404).send({ error: 'NOT_FOUND' })

    const found = engine.catalog(serviceCode).find((m) => m.id === id)
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Метод не найден в каталоге' })

    const profile = SERVICE_PROFILES[serviceCode]
    return reply.send({
      ...found,
      // Пример вызова для футера панели деталей.
      exampleUrl: `${env.publicOrigin}${profile.mountPath}${found.path}`,
      unifiedUrl: `${env.publicOrigin}/v1/${serviceCode}${found.path}`,
      rateLimit: profile.rateLimit,
      nativeAuth: profile.nativeAuth,
    })
  })
}
