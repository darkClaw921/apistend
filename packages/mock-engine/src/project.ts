import type { FillContext } from './sampler.ts'
import { byFieldName, isIdentityField, pageSize } from './sampler.ts'
import {
  hasProductKey, looksLikeEvent, looksLikeProduct, looksLikeSeriesPoint, looksLikeSubjectRecord,
  productField, subjectsOf, type Product,
} from './dataset.ts'
import { dayStats, daysOf, statsInWindow, type OrderEvent } from './timeline.ts'
import { advertDayStats, advertTotals, type AdvertCampaign } from './adverts.ts'

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

/**
 * Потолок событий в одном ответе.
 *
 * Выбран так, чтобы девяносто дней журнала помещались целиком: обрезка с начала
 * окна оставляла бы клиента без свежих дней — он просил три месяца, получал
 * первые две тысячи записей и не видел последних недель вовсе.
 */
const EVENT_PAGE_MAX = 3_000

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
    // Кампании: список отдаёт ровно те, что спросил клиент. Он берёт их
    // идентификаторы из списка кампаний, и статистика по чужим кампаниям
    // для него бесполезна — привязать её не к чему.
    if (event?.campaign === undefined && looksLikeCampaign(template)) {
      const wanted = ctx.campaigns()
      const page = wanted.slice(ctx.page.offset, ctx.page.offset + Math.max(pageSize(ctx), 1))
      return page.map((campaign, i) =>
        walk(template, `${path}[${i}]`, campaign.products[0] ?? product, true, depth + 1, ctx, inAttributes, { campaign }))
    }
    // Карточки внутри кампании: расход разносится именно по ним. Пока здесь
    // стоял один и тот же артикул, ДРР появлялся у одной карточки из трёхсот.
    if (event?.campaign && isProductListKey(lastKey(path))) {
      const campaign = event.campaign
      // Все карточки кампании: сумма по ним обязана сойтись с показателями дня.
      // Часть из них в этот день просто не показывалась — у таких нули, и это
      // обычное состояние, а не пропуск.
      return campaign.products.map((p, i) =>
        walk(template, `${path}[${i}]`, p, true, depth + 1, ctx, inAttributes, { ...event, product: p }))
    }
    // Поток событий: заказы, продажи, возвраты. Разворачивается по журналу
    // песочницы, а не по каталогу, — иначе в ленте по одной записи на товар,
    // все одной датой, и ни выручки по дням, ни процента выкупа не посчитать.
    if (event === null && product === null && looksLikeEvent(template)) {
      // Продажи — не то же самое, что заказы: у боевого Wildberries в них
      // попадают только состоявшиеся сделки и возвраты, а отменённый заказ
      // продажей не становится. Отличаем по полю самой записи.
      const salesOnly = hasKey(template, 'saleid')
      const all = salesOnly
        ? ctx.events().filter((e) => e.outcome === 'buyout' || e.outcome === 'return')
        : ctx.events()
      // Клиент не назвал период — отдаём последний месяц, а не всю глубину
      // журнала: у боевого метода `dateFrom` обязателен, и три месяца выгрузки
      // в ответ на запрос без единого параметра никому не нужны.
      const window = ctx.window.explicit
        ? all
        : all.filter((e) => e.settledAt.getTime() >= ctx.now.getTime() - 30 * 86_400_000)
      // Без явного limit отдаём всё окно: боевая статистика Wildberries так и
      // делает, и клиент строит по одному ответу график за все запрошенные дни.
      const size = ctx.page.explicitLimit ? pageSize(ctx) : Math.min(window.length, EVENT_PAGE_MAX)
      const page = window.slice(ctx.page.offset, ctx.page.offset + size)
      return page.map((e, i) =>
        walk(template, `${path}[${i}]`, e.product, true, depth + 1, ctx, inAttributes, { event: e }))
    }
    // Позиции в выдаче: по точке на день окна, карточки по кругу. Пока здесь
    // стоял артикул из документации, позиции считались по товару, которого
    // в кабинете нет.
    if (event?.campaign && lastKey(path).toLowerCase() === 'boosterstats') {
      const campaign = event.campaign
      const days = advertDays(ctx)
      return days.flatMap((day, i) =>
        campaign.products.slice(0, BOOSTER_PRODUCTS).map((p, j) =>
          walk(template, `${path}[${i * BOOSTER_PRODUCTS + j}]`, p, true, depth + 1, ctx, inAttributes,
            { ...event, day, product: p })))
    }
    // Временной ряд: по одной точке на день запрошенного окна. Товар берётся
    // тот же, что у записи, внутри которой ряд и лежит: график строят по товару.
    if (looksLikeSeriesPoint(template)) {
      const anchor = product ?? ctx.pool[ctx.page.offset % ctx.pool.length]!
      // День кампании считается по кампании целиком: карточка появится уровнем
      // ниже, в `nms`, и день обязан быть суммой этих карточек, а не одной из них.
      const inCampaign = event?.campaign !== undefined
      const series = inCampaign ? advertDays(ctx) : daysOf(ctx.window.from, endOfDay(ctx.window.to))
      return series.map((day, i) =>
        walk(template, `${path}[${i}]`, anchor, true, depth + 1, ctx, inAttributes,
          inCampaign ? { ...event, day, product: undefined } : { ...event, day, product: anchor }))
    }
    if (product === null && looksLikeProduct(template)) {
      // Спросили про конкретные карточки — отвечаем ими, а не страницей каталога.
      if (ctx.selection.length > 0) {
        return ctx.selection.map((p, i) =>
          walk(template, `${path}[${i}]`, p, true, depth + 1, ctx, inAttributes, event))
      }
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
    // Опорная карточка одиночного ответа: спросили про конкретную — она и есть.
    const anchor = ctx.selection[0]
      ?? (cursor
        ? ctx.pool[(ctx.page.offset + pageSize(ctx) - 1) % ctx.pool.length]!
        : ctx.pool[ctx.page.offset % ctx.pool.length]!)
    // Одиночная кампания: «покажи кампанию по идентификатору» отвечает объектом,
    // а не списком. Без привязки такой ответ рассказывал про кампанию, которой
    // у клиента нет, — ровно как список и статистика до этого.
    if (event?.campaign === undefined && looksLikeCampaign(node)) {
      const one = ctx.campaigns()[0]
      if (one) {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          out[k] = walk(v, `${path}.${k}`, one.products[0] ?? product, true, depth + 1, ctx,
            inAttributes || ATTRIBUTE_LISTS.has(k.toLowerCase()), { campaign: one })
        }
        return fixCounters(node as Record<string, unknown>, out, ctx)
      }
    }

    const own = product ?? (hasProductKey(node) ? anchor : null)
    // Площадку читаем из самой записи и передаём детям: по ней считается доля
    // дня, и без неё сумма по площадкам разошлась бы с днём.
    const appType = (node as Record<string, unknown>).appType ?? (node as Record<string, unknown>).app_type
    const childEvent = typeof appType === 'number' && event
      ? { ...event, appType }
      : event
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, `${path}.${k}`, own, record, depth + 1, ctx, inAttributes || ATTRIBUTE_LISTS.has(k.toLowerCase()), childEvent)
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
      const fromAdvert = advertField(key, event, ctx, like)
      if (fromAdvert !== undefined) {
        if (ctx.state && like === 'string') ctx.state.dated = true
        return fromAdvert
      }
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
  /** Рекламная кампания, внутри которой мы находимся. */
  readonly campaign?: AdvertCampaign
  /**
   * Площадка показа (сайт, Android, iOS).
   *
   * Читается из самой записи: статистика Wildberries разносит день по
   * площадкам, и без этого разреза сумма по `apps` не сошлась бы с днём.
   */
  readonly appType?: number
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
    const stats = dayStats(ctx.product ?? fill.pool[0]!, ctx.day, fill.timeline())
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
  const stats = statsInWindow(product, ctx.window.from, endOfDay(ctx.window.to), ctx.timeline())
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

/**
 * Поисковая фраза по товару.
 *
 * Продавец ищет свой товар теми же словами, что и покупатель: предмет плюс
 * уточнение. Фраза детерминирована — отчёт по кластерам обязан быть стабильным
 * между вызовами.
 */
function searchPhrase(product: Product, ctx: FillContext): string {
  const shapes = ['', ' купить', ' недорого', ' с доставкой', ' отзывы', ' оригинал']
  const shape = shapes[ctx.det.int(`phrase|${product.nmId}`, 0, shapes.length - 1)]!
  return `${product.subjectName.toLowerCase()}${shape}`
}

/** Сколько карточек кампании попадает в позиции выдачи за один день. */
const BOOSTER_PRODUCTS = 3

/**
 * Окно рекламной статистики.
 *
 * Боевой метод без дат вообще не отвечает: `beginDate` и `endDate` у него
 * обязательны. Клиенту, который их не прислал, отдаём последнюю неделю —
 * и заодно не считаем девяносто дней по десятку кампаний ради ответа,
 * которого никто не просил.
 */
function advertDays(ctx: FillContext): Date[] {
  if (ctx.window.explicit) return daysOf(ctx.window.from, endOfDay(ctx.window.to))
  const to = ctx.now
  return daysOf(new Date(to.getTime() - 6 * 86_400_000), to)
}

/** Похожа ли запись на рекламную кампанию: по идентификатору кампании в ней. */
function looksLikeCampaign(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  const keys = Object.keys(node).map((k) => k.toLowerCase().replace(/[_\s]/g, ''))
  if (keys.includes('advertid')) return true
  if (keys.includes('id') && keys.includes('nmsettings')) return true
  // Статистика медиакампаний: запись без идентификатора в корне, но с периодом
  // и разбивкой по карточкам. Клиент просит её по тем же advertId.
  return keys.includes('interval') && keys.includes('stats')
}

/** Список карточек внутри кампании: у разных версий метода он называется по-разному. */
function isProductListKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_\s]/g, '')
  return k === 'nms' || k === 'nmsettings' || k === 'nmids' || k === 'products'
    || k === 'unitedparams' || k === 'stats'
}

/**
 * Поле рекламной статистики.
 *
 * Показатели считаются от показов вниз по воронке: клики не больше показов,
 * CTR — их отношение, CPC — расход, делённый на клики. Пока каждое число
 * приходило само по себе, в ответе стоял CTR 107 % при кликах больше показов —
 * и клиент, который сверяет эти три величины, справедливо считал ответ сломанным.
 */
function advertField(
  key: string,
  ctx: EventContext,
  fill: FillContext,
  like: 'string' | 'number' | 'boolean',
): unknown {
  const campaign = ctx.campaign
  if (!campaign) return undefined
  const k = key.toLowerCase().replace(/[_\s]/g, '')

  // Свойства самой кампании.
  // `id` — идентификатор кампании только в самой записи о кампании: внутри
  // карточки так называется её предмет, и подменять его номером кампании
  // значит склеить две разные сущности в одну.
  if (k === 'advertid' || (k === 'id' && like === 'number' && !ctx.product)) return campaign.advertId
  if (k === 'campname' || k === 'campaignname' || (k === 'name' && !ctx.product)) {
    // Внутри карточки `name` — это название товара, а не кампании: клиент
    // печатает его в строке отчёта рядом с артикулом.
    return like === 'string' ? campaign.name : undefined
  }
  // Поисковая фраза кластера — по товару, а не «Фраза 1»: клиент печатает её
  // в отчёте, и одинаковые строки в нём читаются как ошибка выгрузки.
  if (k === 'normquery' || k === 'query' || k === 'keyword' || k === 'searchtext') {
    const product = ctx.product ?? campaign.products[0]
    return like === 'string' && product ? searchPhrase(product, fill) : undefined
  }
  if (k === 'itemid' && ctx.product) return ctx.product.nmId
  if (k === 'itemname' && ctx.product) return like === 'string' ? ctx.product.title : undefined
  if (k === 'type' || k === 'adverttype') return campaign.type
  if (k === 'status' || k === 'advertstatus') return campaign.status
  if (k === 'paymenttype') return like === 'string' ? campaign.paymentType : undefined
  if (k === 'dailybudget' || k === 'budget') return campaign.dailyBudget
  if (k === 'createtime' || k === 'created' || k === 'createdat') {
    return like === 'string' ? campaign.createdAt.toISOString() : undefined
  }
  if (k === 'starttime' || k === 'started' || k === 'startedat') {
    return like === 'string' ? campaign.startedAt.toISOString() : undefined
  }
  if (k === 'endtime' || k === 'ended' || k === 'endedat' || k === 'deleted') {
    return like === 'string' ? (campaign.endedAt ?? campaign.startedAt).toISOString() : undefined
  }

  if (like !== 'number') return undefined
  // Показатели: за день, если мы внутри дня, иначе — итог за окно.
  const stats = ctx.day
    ? advertDayStats(campaign, ctx.day, ctx.product, ctx.appType)
    : advertTotals(campaign, advertDays(fill), ctx.product, ctx.appType)

  switch (k) {
    case 'views': case 'impressions': return stats.views
    case 'clicks': return stats.clicks
    case 'ctr': return stats.ctr
    case 'cpc': return stats.cpc
    case 'cpm': return stats.views === 0 ? 0 : Number(((stats.sum / stats.views) * 1000).toFixed(2))
    case 'sum': case 'expenses': case 'updsum': case 'spent': return stats.sum
    case 'sumprice': return stats.sumPrice
    case 'atbs': return stats.atbs
    case 'orders': return stats.orders
    case 'shks': return stats.shks
    case 'cr': return stats.cr
    case 'canceled': return stats.canceled
    case 'avgposition': case 'avgpos': case 'position': return stats.avgPosition
    default: return undefined
  }
}
