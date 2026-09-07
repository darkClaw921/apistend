import type { CatalogMethod } from '@apistend/shared'

/**
 * Маршрутизация по каталогу.
 *
 * Точные пути ищутся по карте, шаблонные (/api/v3/orders/{orderId}) — регулярками.
 * Проверено на снимке спек WB: пересечений METHOD+path между 14 файлами нет,
 * поэтому один индекс на сервис корректен. Коллизии всё равно логируем — состав
 * спецификаций меняется, и молча терять метод нельзя.
 */

export interface RouteMatch {
  method: CatalogMethod
  params: Record<string, string>
}

interface TemplateRoute {
  method: CatalogMethod
  regex: RegExp
  names: string[]
  /** Чем больше литеральных сегментов, тем выше приоритет. */
  specificity: number
}

export class MockRouter {
  private readonly exact = new Map<string, CatalogMethod>()
  /** Индекс без учёта глагола — для сервисов, где имя метода лежит в пути. */
  private readonly byPath = new Map<string, CatalogMethod>()
  private readonly templates: TemplateRoute[] = []
  readonly collisions: string[] = []

  constructor(methods: readonly CatalogMethod[]) {
    for (const m of methods) {
      if (m.path.includes('{')) {
        this.templates.push(compile(m))
      } else {
        const key = `${m.httpMethod} ${m.path}`
        if (this.exact.has(key)) this.collisions.push(key)
        else this.exact.set(key, m)
      }
      if (!this.byPath.has(m.path)) this.byPath.set(m.path, m)
    }
    // Более специфичные шаблоны проверяем первыми: /orders/new важнее /orders/{id}.
    this.templates.sort((a, b) => b.specificity - a.specificity)
  }

  /**
   * @param ignoreHttpMethod искать без учёта глагола (профиль сервиса `path-only`).
   */
  match(httpMethod: string, path: string, ignoreHttpMethod = false): RouteMatch | null {
    const normalized = path.replace(/\/+$/, '') || '/'
    const upper = httpMethod.toUpperCase()

    const direct = this.exact.get(`${upper} ${normalized}`) ?? this.exact.get(`${upper} ${path}`)
    if (direct) return { method: direct, params: {} }

    if (ignoreHttpMethod) {
      const byPath = this.byPath.get(normalized) ?? this.byPath.get(path)
      if (byPath) return { method: byPath, params: {} }
    }

    for (const t of this.templates) {
      if (!ignoreHttpMethod && t.method.httpMethod !== upper) continue
      const m = t.regex.exec(normalized)
      if (!m) continue
      const params: Record<string, string> = {}
      t.names.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] ?? '')
      })
      return { method: t.method, params }
    }
    return null
  }

  /** Пути, похожие на запрошенный: подсказка «возможно, вы имели в виду» в ошибке 404. */
  suggest(path: string, limit = 3): string[] {
    const target = path.toLowerCase()
    const all = [...this.exact.values(), ...this.templates.map((t) => t.method)]
    return all
      .map((m) => ({ path: m.path, score: similarity(target, m.path.toLowerCase()) }))
      .filter((x) => x.score > 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.path)
  }
}

function compile(method: CatalogMethod): TemplateRoute {
  const names: string[] = []
  let specificity = 0
  const pattern = method.path
    .split('/')
    .map((segment) => {
      if (segment.startsWith('{') && segment.endsWith('}')) {
        names.push(segment.slice(1, -1))
        return '([^/]+)'
      }
      if (segment.length > 0) specificity += 1
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { method, regex: new RegExp(`^${pattern}$`), names, specificity }
}

/** Грубая мера похожести по общим триграммам — достаточно для подсказки в 404. */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  const grams = (s: string) => {
    const out = new Set<string>()
    for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let shared = 0
  for (const g of ga) if (gb.has(g)) shared++
  return (2 * shared) / (ga.size + gb.size)
}
