import type { FillContext } from './sampler.ts'
import { byFieldName, isIdentityField, pageSize } from './sampler.ts'
import { hasProductKey, looksLikeProduct, productField, type Product } from './dataset.ts'

/**
 * Проекция каталога на пример из спецификации.
 *
 * Пример из документации — самая честная форма ответа, но он всегда про один товар
 * и почти всегда в одном экземпляре: «карточки» приходят списком из одной записи,
 * заказы — из одного заказа. Отдавать его как есть значит показывать продавцу
 * витрину чужого магазина: в каталоге один nmID, в заказах другой.
 *
 * Поэтому форму примера сохраняем полностью, а товарные списки разворачиваем
 * по каталогу песочницы: сколько товаров, столько записей, и в каждой — поля
 * своего товара. Всё, что к товару отношения не имеет (адреса, статусы, описания
 * структуры), остаётся ровно таким, как в документации.
 */

/** Счётчики, которые обязаны совпасть с длиной развёрнутого списка. */
const COUNTER_KEYS = new Set(['total', 'totalcount', 'count', 'cnt'])

export function projectExample(example: unknown, ctx: FillContext): unknown {
  if (ctx.pool.length === 0) return example
  return walk(example, 'example', null, false, 0, ctx)
}

function walk(
  node: unknown,
  path: string,
  product: Product | null,
  inRecord: boolean,
  depth: number,
  ctx: FillContext,
): unknown {
  if (depth > 24) return node

  if (Array.isArray(node)) {
    if (node.length === 0) return node
    const template = node[0]
    // Если товар уже выбран снаружи, список вложен в запись о товаре и описывает
    // его же (размеры, баркоды) — разворачивать его по каталогу нельзя.
    if (product === null && looksLikeProduct(template)) {
      const count = pageSize(ctx)
      return Array.from({ length: count }, (_, i) =>
        walk(template, `${path}[${i}]`, ctx.pool[(ctx.page.offset + i) % ctx.pool.length]!, true, depth + 1, ctx))
    }
    return node.map((item, i) => walk(item, `${path}[${i}]`, product, inRecord, depth + 1, ctx))
  }

  if (node !== null && typeof node === 'object') {
    const record = inRecord || hasProductKey(node)
    const own = product ?? (hasProductKey(node) ? ctx.pool[ctx.page.offset % ctx.pool.length]! : null)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, `${path}.${k}`, own, record, depth + 1, ctx)
    }
    return fixCounters(node as Record<string, unknown>, out, ctx)
  }

  if (product && (typeof node === 'string' || typeof node === 'number')) {
    const like = typeof node === 'string' ? 'string' : 'number'
    const key = lastKey(path)
    const fromCatalog = productField(key, product, inRecord)
    if (fromCatalog !== undefined) return like === 'string' ? String(fromCatalog) : Number(fromCatalog)
    // Идентификаторы записи (srid, номер заказа, стикер) обязаны различаться:
    // одинаковые ключи в списке ломают любого клиента, который кладёт записи в словарь.
    if (isIdentityField(key)) return byFieldName(key, path, ctx, like)
  }
  return node
}

/**
 * Приводит счётчики к длине развёрнутого списка.
 *
 * Проверяем и сам объект, и его вложенные объекты-конверты (cursor, pagination):
 * в WB общее количество карточек лежит именно в соседнем `cursor.total`, и оставить
 * там единицу — значит показать клиенту список из двенадцати записей и total = 1.
 */
function fixCounters(
  source: Record<string, unknown>,
  out: Record<string, unknown>,
  ctx: FillContext,
): Record<string, unknown> {
  const hasProductList = Object.values(source)
    .some((v) => Array.isArray(v) && v.length > 0 && looksLikeProduct(v[0]))
  if (!hasProductList) return out
  // Общее количество — размер всего каталога, а не текущей страницы: клиент по нему
  // считает, сколько страниц ему предстоит.
  const expanded = ctx.pool.length

  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'number' && COUNTER_KEYS.has(k.toLowerCase())) out[k] = expanded
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const nested = v as Record<string, unknown>
      for (const [nk, nv] of Object.entries(nested)) {
        if (typeof nv === 'number' && COUNTER_KEYS.has(nk.toLowerCase())) nested[nk] = expanded
      }
    }
  }
  return out
}

/** Последний ключ пути: example.cards[3].nmID -> nmID. */
function lastKey(path: string): string {
  const tail = path.split('.').pop() ?? path
  return tail.replace(/\[\d+\]$/, '')
}
