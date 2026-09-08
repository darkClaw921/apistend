import type { FastifyInstance } from 'fastify'
import { isServiceCode, SERVICE_LIST, SERVICE_PROFILES, type CatalogMethod, type ServiceCode } from '@apistend/shared'
import { engine } from '../gateway.ts'
import { env } from '../env.ts'
import { clampNumber } from '../lib/guard.ts'

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

export function registerCatalogRoutes(app: FastifyInstance): void {
  /** Сводка по сервисам: панель «Демо-сервисы» и счётчики лендинга. */
  app.get('/api/services', async (_req, reply) => {
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
      }
    })
    const total = services.reduce((sum, s) => sum + s.methodsCount, 0)
    return reply.send({ services, totalMethods: total })
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
