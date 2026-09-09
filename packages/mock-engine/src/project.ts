import type { FillContext } from './sampler.ts'
import { byFieldName, isIdentityField, pageSize } from './sampler.ts'
import {
  hasProductKey, looksLikeEvent, looksLikeProduct, looksLikeSeriesPoint, looksLikeSubjectRecord,
  productField, subjectsOf, type Product,
} from './dataset.ts'
import { dayStats, daysOf, statsInWindow, type OrderEvent } from './timeline.ts'

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

/** Потолок событий в одном ответе: страховка от тела в мегабайты. */
const EVENT_PAGE_MAX = 2_000

/** Счётчики, которые обязаны совпасть с длиной развёрнутого списка. */
const COUNTER_KEYS = new Set(['total', 'totalcount', 'count', 'cnt'])

export interface Projected {
  readonly value: unknown
  /** Даты в теле уже относительно сегодня — общий сдвиг им не нужен. */
  readonly dated: boolean
}

export function projectExample(example: unknown, ctx: FillContext): Projected {
  if (ctx.pool.length === 0) return { value: example, dated: false }
  const state = { dated: false }
  const value = walk(example, 'example', null, false, 0, { ...ctx, state })
  return { value, dated: state.dated }
}

/**
 * Списки, элементы которых описывают не товар, а его свойство.
 *
 * Внутри них общие имена принадлежат свойству, а не товару: `name` у характеристики —
 * это «Цвет», а не название товара. Без этой оговорки проекция каталога подменяла
 * имя характеристики названием карточки, и в ответе стояло «Кофе в зёрнах, 1 кг:
 * красно-сиреневый».
 */
const ATTRIBUTE_LISTS = new Set(['characteristics', 'options', 'params', 'attributes', 'addin'])

/** Общие имена, которые внутри такого списка принадлежат свойству, а не товару. */
const ATTRIBUTE_FIELDS = new Set(['name', 'title', 'value', 'id'])

function walk(
  node: unknown,
  path: string,
  product: Product | null,
  inRecord: boolean,
  depth: number,
  ctx: FillContext,
  inAttributes = false,
  event: EventContext | null = null,
): unknown {
  if (depth > 24) return node

  if (Array.isArray(node)) {
    if (node.length === 0) return node
    const template = node[0]
    // Если товар уже выбран снаружи, список вложен в запись о товаре и описывает
    // его же (размеры, баркоды) — разворачивать его по каталогу нельзя.
    // Справочник по предметам: комиссии, ставки, тарифы. Разворачиваем не по товарам,
    // а по предметам каталога — по одной строке на предмет. Иначе в ответе остаётся
    // единственный предмет из документации, с товарами песочницы не пересекающийся,
    // и подобрать ставку к товару не к чему: юнит-экономика не считается.
    if (product === null && looksLikeSubjectRecord(template)) {
      const subjects = subjectsOf(ctx.pool)
      return subjects.map((s, i) => walk(template, `${path}[${i}]`, s, true, depth + 1, ctx, inAttributes, event))
    }
    // Поток событий: заказы, продажи, возвраты. Разворачивается по журналу
    // песочницы, а не по каталогу, — иначе в ленте по одной записи на товар,
    // все одной датой, и ни выручки по дням, ни процента выкупа не посчитать.
    if (event === null && product === null && looksLikeEvent(template)) {
      // Продажи — не то же самое, что заказы: у боевого Wildberries в них
      // попадают только состоявшиеся сделки и возвраты, а отменённый заказ
      // продажей не становится. Отличаем по полю самой записи.
      const salesOnly = hasKey(template, 'saleid')
      const window = salesOnly
        ? ctx.events().filter((e) => e.outcome === 'buyout' || e.outcome === 'return')
        : ctx.events()
      // Без явного limit отдаём всё окно: боевая статистика Wildberries так и
      // делает, и клиент строит по одному ответу график за все запрошенные дни.
      const size = ctx.page.explicitLimit ? pageSize(ctx) : Math.min(window.length, EVENT_PAGE_MAX)
      const page = window.slice(ctx.page.offset, ctx.page.offset + size)
      return page.map((e, i) =>
        walk(template, `${path}[${i}]`, e.product, true, depth + 1, ctx, inAttributes, { event: e }))
    }
    // Временной ряд: по одной точке на день запрошенного окна. Товар берётся
    // тот же, что у записи, внутри которой ряд и лежит: график строят по товару.
    if (looksLikeSeriesPoint(template)) {
      const anchor = product ?? ctx.pool[ctx.page.offset % ctx.pool.length]!
      return daysOf(ctx.window.from, endOfDay(ctx.window.to)).map((day, i) =>
        walk(template, `${path}[${i}]`, anchor, true, depth + 1, ctx, inAttributes, { day, product: anchor }))
    }
    if (product === null && looksLikeProduct(template)) {
      const count = pageSize(ctx)
      return Array.from({ length: count }, (_, i) =>
        walk(template, `${path}[${i}]`, ctx.pool[(ctx.page.offset + i) % ctx.pool.length]!, true, depth + 1, ctx, inAttributes, event))
    }
    return node.map((item, i) => walk(item, `${path}[${i}]`, product, inRecord, depth + 1, ctx, inAttributes, event))
  }

  if (node !== null && typeof node === 'object') {
    const record = inRecord || hasProductKey(node)
    // Курсор описывает не первую запись страницы, а ПОСЛЕДНЮЮ: клиент возвращает
    // его обратно, чтобы получить продолжение. Курсор на первой записи давал бы
    // шаг в одну карточку на запрос — обход каталога из трёхсот товаров занял бы
    // триста запросов вместо пятнадцати.
    const cursor = lastKey(path) === 'cursor'
    const anchor = cursor
      ? ctx.pool[(ctx.page.offset + pageSize(ctx) - 1) % ctx.pool.length]!
      : ctx.pool[ctx.page.offset % ctx.pool.length]!
    const own = product ?? (hasProductKey(node) ? anchor : null)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, `${path}.${k}`, own, record, depth + 1, ctx, inAttributes || ATTRIBUTE_LISTS.has(k.toLowerCase()), event)
    }
    return fixCounters(node as Record<string, unknown>, out, ctx)
  }

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const key = lastKey(path)
    // Границы запрошенного периода: клиент прислал их сам, и ответ обязан
    // отвечать за них, а не за интервал из документации.
    const fromWindow = windowField(key, path, ctx)
    if (fromWindow !== undefined && typeof node === 'string') {
      if (ctx.state) ctx.state.dated = true
      return keepDateShape(node, fromWindow)
    }
    if (event) {
      const like = typeof node === 'string' ? 'string' : typeof node === 'number' ? 'number' : 'boolean'
      const fromEvent = eventField(key, event, ctx, like)
      if (fromEvent !== undefined) {
        if (ctx.state && like === 'string') ctx.state.dated = true
        return fromEvent
      }
    }
  }

  if (product && (typeof node === 'string' || typeof node === 'number')) {
    const like = typeof node === 'string' ? 'string' : 'number'
    const key = lastKey(path)
    // Внутри списка свойств общие имена принадлежат свойству, а не товару.
    if (inAttributes && ATTRIBUTE_FIELDS.has(key.toLowerCase())) return node
    // Показатели за запрошенный период, а не за месяц из карточки товара:
    // клиент, сузивший окно до недели, обязан увидеть цифры недели.
    const forWindow = windowStatsField(key, product, ctx)
    if (forWindow !== undefined) {
      return like === 'string' ? String(forWindow) : Number(forWindow)
    }
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

/** Есть ли у записи такое поле — по нормализованному имени. */
function hasKey(node: unknown, name: string): boolean {
  if (node === null || typeof node !== 'object') return false
  return Object.keys(node).some((k) => k.toLowerCase().replace(/[_\s]/g, '') === name)
}

/** Последний ключ пути: example.cards[3].nmID -> nmID. */
function lastKey(path: string): string {
  const tail = path.split('.').pop() ?? path
  return tail.replace(/\[\d+\]$/, '')
}

/**
 * Чем занята текущая запись: событием журнала или днём временного ряда.
 *
 * Одно из двух, но не оба: заказ — это операция, точка ряда — сутки. Общего
 * у них только то, что и там и там значения зависят от времени, а не от того,
 * что стояло в примере документации.
 */
interface EventContext {
  readonly event?: OrderEvent
  readonly day?: Date
  /** Товар, к которому относится день ряда. */
  readonly product?: Product
}

/** Конец дня: окно, названное датой без времени, включает эти сутки целиком. */
function endOfDay(date: Date): Date {
  const midnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0
  return midnight ? new Date(date.getTime() + 86_399_999) : date
}

/**
 * Границы периода в теле ответа.
 *
 * Аналитика Wildberries возвращает период, за который посчитала, — и в примере
 * из документации там стоит интервал, за который считали её авторы. Клиент,
 * сверяющий ответ со своим запросом, видит чужие даты и считает ответ неверным.
 * Подменяем только внутри объекта периода: `start` у периода — это дата, а
 * `start` у чего-нибудь другого может быть чем угодно.
 */
function windowField(key: string, path: string, ctx: FillContext): Date | undefined {
  const parent = parentKey(path)
  if (!PERIOD_PARENTS.has(parent)) return undefined
  const k = key.toLowerCase()
  if (k === 'start' || k === 'begin' || k === 'datefrom' || k === 'from') return ctx.window.from
  if (k === 'end' || k === 'finish' || k === 'dateto' || k === 'to') return endOfDay(ctx.window.to)
  return undefined
}

const PERIOD_PARENTS = new Set([
  'period', 'currentperiod', 'selectedperiod', 'previousperiod', 'interval', 'dates',
])

/**
 * Значение поля записи о событии или дне.
 *
 * Возвращает undefined, если поле к времени отношения не имеет: тогда его
 * заполнит проекция каталога, как и раньше.
 */
function eventField(
  key: string,
  ctx: EventContext,
  fill: FillContext,
  like: 'string' | 'number' | 'boolean',
): unknown {
  const k = key.toLowerCase().replace(/[_\s]/g, '')

  if (ctx.day) {
    const stats = dayStats(ctx.product ?? fill.pool[0]!, ctx.day)
    if (DATE_FIELDS.has(k)) return like === 'string' ? stats.date : undefined
    if (like !== 'number') return undefined
    // Показатели дня, а не месяца: три точки с одинаковыми числами графиком
    // не являются, а именно их клиент и рисует.
    if (k === 'opencount' || k === 'opencardcount' || k === 'viewcount') return stats.openCount
    if (k === 'cartcount' || k === 'addtocartcount') return stats.cartCount
    if (k === 'ordercount' || k === 'orderscount') return stats.orderCount
    if (k === 'ordersum' || k === 'ordersumrub') return stats.orderSum
    if (k === 'buyoutcount' || k === 'buyoutscount') return stats.buyoutCount
    if (k === 'buyoutsum' || k === 'buyoutsumrub') return stats.buyoutSum
    if (k === 'cancelcount' || k === 'cancelscount') return stats.cancelCount
    if (k === 'cancelsum' || k === 'cancelsumrub') return stats.cancelSum
    if (k === 'addtowishlistcount') return stats.addToWishlistCount
    if (k === 'buyoutpercent' || k === 'buyoutspercent') {
      return stats.orderCount === 0 ? 0 : Math.round((stats.buyoutCount / stats.orderCount) * 100)
    }
    return undefined
  }

  const e = ctx.event
  if (!e) return undefined

  // Даты события. Заказ и его исход — разные моменты, и клиент, считающий срок
  // выкупа, вычитает одно из другого.
  if (k === 'date' || k === 'orderdate' || k === 'orderedat' || k === 'createdat') {
    return like === 'string' ? localIso(e.orderedAt) : undefined
  }
  if (k === 'lastchangedate' || k === 'updatedat' || k === 'saledate' || k === 'dt') {
    return like === 'string' ? localIso(e.settledAt) : undefined
  }
  if (k === 'canceldate' || k === 'canceldt') {
    return like === 'string' ? localIso(e.outcome === 'cancel' ? e.settledAt : e.orderedAt) : undefined
  }

  // Исход. Отмена и возврат — разные вещи: по первой считают отказы, по второй
  // возвраты, и слепить их в один флаг значит потерять половину воронки.
  if (k === 'iscancel') return e.outcome === 'cancel'
  if (k === 'canceltype' || k === 'cancletype') return e.cancelType ?? ''
  if (k === 'status' || k === 'ordertype') return like === 'string' ? e.outcome : undefined
  if (k === 'isrealization') return e.outcome === 'buyout'
  if (k === 'ismp') return e.isMp
  if (k === 'issupply') return !e.isMp

  // Идентификаторы: у каждой записи свои, иначе клиент, кладущий их в словарь,
  // получит одну запись вместо страницы.
  if (k === 'srid' || k === 'odid' || k === 'orderuid') return e.srid
  if (k === 'gnumber') return e.gNumber
  if (k === 'sticker') return like === 'number' ? Number(e.sticker) : e.sticker
  if (k === 'saleid') return e.saleId
  if (k === 'incomeid') return like === 'string' ? String(e.incomeId) : e.incomeId

  // Деньги сделки.
  if (k === 'totalprice') return e.totalPrice
  if (k === 'pricewithdisc' || k === 'sellerprice' || k === 'retailpricewithdisc') return e.priceWithDisc
  if (k === 'finishedprice' || k === 'retailprice') return e.finishedPrice
  if (k === 'forpay' || k === 'ppvzforpay') return e.forPay

  // Склад и доставка.
  if (k === 'warehousename') return e.warehouseName
  if (k === 'warehouseregion' || k === 'oblastokrugname') return e.warehouseRegion
  if (k === 'destinationcity') return e.destinationCity
  if (k === 'destinationdistrict') return e.destinationDistrict
  return undefined
}

const DATE_FIELDS = new Set(['date', 'dt', 'day'])

/**
 * Счётчик воронки за окно запроса.
 *
 * В каталоге показатели товара посчитаны за месяц. Пока ответ отдаёт их как есть,
 * период запроса ни на что не влияет: неделя, месяц и квартал дают одно число,
 * и проверить выбор периода на витрине нечем. Складываем дни окна — тогда
 * квартал и вправду больше недели.
 */
function windowStatsField(key: string, product: Product, ctx: FillContext): number | undefined {
  const k = key.toLowerCase().replace(/[_\s]/g, '')
  if (!WINDOW_STATS.has(k)) return undefined
  const stats = statsInWindow(product, ctx.window.from, endOfDay(ctx.window.to))
  switch (k) {
    case 'opencount': case 'opencardcount': case 'viewcount': return stats.openCount
    case 'cartcount': case 'addtocartcount': return stats.cartCount
    case 'ordercount': case 'orderscount': return stats.orderCount
    case 'ordersum': case 'ordersumrub': case 'orderssumrub': return stats.orderSum
    case 'buyoutcount': case 'buyoutscount': return stats.buyoutCount
    case 'buyoutsum': case 'buyoutsumrub': case 'buyoutssumrub': return stats.buyoutSum
    case 'cancelcount': case 'cancelscount': return stats.cancelCount
    case 'cancelsum': case 'cancelsumrub': return stats.cancelSum
    case 'addtowishlist': case 'addtowishlistcount': return stats.addToWishlistCount
    default: return undefined
  }
}

const WINDOW_STATS = new Set([
  'opencount', 'opencardcount', 'viewcount', 'cartcount', 'addtocartcount',
  'ordercount', 'orderscount', 'ordersum', 'ordersumrub', 'orderssumrub',
  'buyoutcount', 'buyoutscount', 'buyoutsum', 'buyoutsumrub', 'buyoutssumrub',
  'cancelcount', 'cancelscount', 'cancelsum', 'cancelsumrub',
  'addtowishlist', 'addtowishlistcount',
])

/**
 * Дата в формате того значения, что стояло в примере.
 *
 * Клиент разбирает ответ строгим парсером, и подменять `2026-06-01` на полный ISO
 * значит ломать его на ровном месте.
 */
function keepDateShape(sample: string, value: Date): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return value.toISOString().slice(0, 10)
  if (/Z$/.test(sample)) return value.toISOString()
  return localIso(value)
}

/** Время без зоны — так его пишет статистика Wildberries: 2026-06-01T18:08:31. */
function localIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '')
}

/** Ключ родительского объекта: example.data.period.start -> period. */
function parentKey(path: string): string {
  const parts = path.split('.')
  const parent = parts[parts.length - 2] ?? ''
  return parent.replace(/\[\d+\]$/, '').toLowerCase()
}
