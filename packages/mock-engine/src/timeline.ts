import { Deterministic } from './deterministic.ts'
import type { Product } from './dataset.ts'

/**
 * Журнал заказов песочницы: что и когда заказали, выкупили, отменили, вернули.
 *
 * Без него методы статистики отвечают примером из документации: двадцать записей
 * одной датой, все с `isCancel: true`. Форма верна, а посчитать по такому ответу
 * нечего — ни выручки по дням, ни процента выкупа, ни динамики. Клиент строит
 * витрину за 7, 30 или 90 дней и выводит прочерки.
 *
 * Поэтому события живут во времени: девяносто дней назад от опорной даты, с
 * раскладкой по дням и разными исходами. Товар берётся из общего каталога
 * песочницы — того же, из которого отвечают карточки, — а вероятность исхода из
 * его же воронки: у товара с buyoutCount 380 из 400 заказов выкуп и в журнале
 * случается в девяти случаях из десяти. Одни и те же цифры, посчитанные с двух
 * сторон, обязаны сходиться.
 *
 * Журнал детерминирован: зависит только от объёма датасета и календарного дня.
 * Один и тот же запрос в течение дня даёт один и тот же ответ — иначе клиент,
 * которого отлаживают прогоном по кругу, не отличит свою ошибку от шума мока.
 */

/** Глубина журнала. Витрины считают за 7, 30 и 90 дней — последнее и берём. */
export const TIMELINE_DAYS = 90

/**
 * Доля возвратов.
 *
 * Семь процентов — обычная величина для маркетплейса: возврат случается редко,
 * но случается у каждого, и по нему считают качество карточки и логистику.
 */
const RETURN_SHARE = 0.07

/** Период, за который посчитаны показатели товара в каталоге. */
export const BASE_PERIOD_DAYS = 30

/** Исход заказа. */
export type Outcome = 'created' | 'buyout' | 'cancel' | 'return'

export interface OrderEvent {
  readonly product: Product
  /** Когда заказали. */
  readonly orderedAt: Date
  /** Когда стало известно, чем кончилось. У свежих заказов совпадает с orderedAt. */
  readonly settledAt: Date
  readonly outcome: Outcome
  /** Тип отмены — только у отменённых, как и у боевого API. */
  readonly cancelType: string | null
  readonly srid: string
  readonly gNumber: string
  readonly sticker: string
  readonly saleId: string
  readonly incomeId: number
  /** Цена до скидок и цена, которую заплатил покупатель. */
  readonly totalPrice: number
  readonly priceWithDisc: number
  readonly finishedPrice: number
  /** К перечислению продавцу: у отмены ноль, у возврата — со знаком минус. */
  readonly forPay: number
  readonly warehouseName: string
  readonly warehouseRegion: string
  readonly destinationCity: string
  readonly destinationDistrict: string
  readonly isMp: boolean
}

const WAREHOUSES = [
  { name: 'Коледино', region: 'Центральный федеральный округ' },
  { name: 'Электросталь', region: 'Центральный федеральный округ' },
  { name: 'Казань', region: 'Приволжский федеральный округ' },
  { name: 'Екатеринбург', region: 'Уральский федеральный округ' },
  { name: 'Санкт-Петербург', region: 'Северо-Западный федеральный округ' },
] as const

const CITIES = [
  { city: 'Москва', district: 'Центральный' },
  { city: 'Санкт-Петербург', district: 'Северо-Западный' },
  { city: 'Казань', district: 'Приволжский' },
  { city: 'Новосибирск', district: 'Сибирский' },
  { city: 'Екатеринбург', district: 'Уральский' },
  { city: 'Краснодар', district: 'Южный' },
] as const

const CANCEL_TYPES = ['app', 'receipt', 'expire', 'other'] as const

/** Начало дня по UTC: ключ дня и опора для расчётов. */
export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function dayKey(date: Date): string {
  return startOfDay(date).toISOString().slice(0, 10)
}

const cache = new Map<string, readonly OrderEvent[]>()

/**
 * Журнал за последние TIMELINE_DAYS дней, от раннего события к позднему.
 *
 * Кешируется по объёму датасета и календарному дню: пересобирать девять тысяч
 * событий на каждый запрос незачем, а на смене суток журнал обязан сдвинуться.
 */
export function orderTimeline(
  salt: string,
  pool: readonly Product[],
  now: Date,
): readonly OrderEvent[] {
  if (pool.length === 0) return []
  const key = `${salt}|${dayKey(now)}|${pool.length}`
  const cached = cache.get(key)
  if (cached) return cached

  const det = new Deterministic(`timeline|${key}`)
  const today = startOfDay(now)
  // Плотность выбрана из двух условий разом. Снизу: за девяносто дней каждый
  // товар каталога должен получить свои заказы — иначе половина карточек не
  // встретится ни в заказах, ни в продажах, и «тот же товар во всех методах»
  // останется обещанием. Сверху: всё окно клиент забирает одним запросом, как
  // у боевого API, и ответ обязан остаться ответом, а не выгрузкой базы.
  const perDay = Math.max(8, Math.round(pool.length / 10))
  const events: OrderEvent[] = []

  // Товары раздаются по кругу, а не жеребьёвкой. При случайном выборе каждый
  // девятый артикул за девяносто дней не получал ни одного заказа: клиент
  // открывал карточку и видел «продаж нет» там, где их обязано быть хоть
  // сколько-то. Круг гарантирует, что очередь доходит до каждого.
  let cursor = 0
  for (let back = TIMELINE_DAYS - 1; back >= 0; back--) {
    const day = new Date(today.getTime() - back * 86_400_000)
    for (let i = 0; i < perDay; i++) {
      const k = `${dayKey(day)}|${i}`
      const product = pool[cursor % pool.length]!
      cursor += 1
      // Время внутри дня: заказы идут не в полночь, а в течение суток.
      const orderedAt = new Date(
        day.getTime() +
        det.int(`hour|${k}`, 7, 23) * 3_600_000 +
        det.int(`minute|${k}`, 0, 59) * 60_000 +
        det.int(`second|${k}`, 0, 59) * 1000,
      )
      // Первый заказ каждого товара — выкуп. Иначе у части каталога все заказы
      // случайно оказывались отменами, и в продажах товара не было вовсе:
      // ни выручки, ни процента выкупа по нему не посчитать.
      const first = cursor <= pool.length
      events.push(buildEvent(product, orderedAt, now, det, k, first))
    }
  }

  events.sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime())
  cache.set(key, events)
  // Журнал живёт до конца суток; на смене дня старый ключ больше не нужен.
  if (cache.size > 8) cache.delete(cache.keys().next().value as string)
  return events
}

function buildEvent(
  product: Product,
  orderedAt: Date,
  now: Date,
  det: Deterministic,
  k: string,
  forceBuyout = false,
): OrderEvent {
  // Доли исходов — из воронки самого товара: тот же процент выкупа, который
  // клиент увидит в аналитике, обязан получиться и подсчётом по журналу.
  const orders = Math.max(1, product.orderCount)
  const buyoutShare = product.buyoutCount / orders
  // Возврат — отдельный исход, а не разновидность отмены. Пока он выводился
  // остатком от выкупов и отмен, возвратов не случалось вовсе: доли складывались
  // в единицу, и процент возврата по товару всегда выходил нулём.
  const returnShare = RETURN_SHARE
  const cancelShare = Math.max(0, 1 - buyoutShare - returnShare)
  const roll = det.float(`roll|${k}`, 0, 1)

  // Заказ младше суток ещё не решён: у боевого API он висит в статусе «оформлен».
  const ageMs = now.getTime() - orderedAt.getTime()
  const settleDays = det.int(`settle|${k}`, 1, 5)
  const outcome: Outcome = ageMs < 86_400_000
    ? 'created'
    : forceBuyout
      ? 'buyout'
      : roll < buyoutShare
      ? 'buyout'
        : roll < buyoutShare + cancelShare
          ? 'cancel'
          : 'return'

  const settledAt = outcome === 'created'
    ? orderedAt
    : new Date(Math.min(now.getTime(), orderedAt.getTime() + settleDays * 86_400_000))

  const warehouse = WAREHOUSES[det.int(`wh|${k}`, 0, WAREHOUSES.length - 1)]!
  const destination = CITIES[det.int(`city|${k}`, 0, CITIES.length - 1)]!
  const finishedPrice = Math.round((product.discountedPrice * (100 - product.spp)) / 100)
  // К перечислению — за вычетом комиссии площадки. Возврат уносит выплату обратно,
  // отмена не приносит ничего: заказ до продавца не дошёл.
  const payout = Math.round((finishedPrice * (100 - product.commissionPercent)) / 100)
  const forPay = outcome === 'buyout' ? payout : outcome === 'return' ? -payout : 0

  const serial = det.int(`serial|${k}`, 100_000, 999_999)
  return {
    product,
    orderedAt,
    settledAt,
    outcome,
    cancelType: outcome === 'cancel' ? CANCEL_TYPES[det.int(`ct|${k}`, 0, CANCEL_TYPES.length - 1)]! : null,
    srid: `${det.int(`srid|${k}`, 1_000_000_000, 9_999_999_999)}.${det.int(`sridSuffix|${k}`, 1, 9)}.0`,
    gNumber: `${det.int(`gnum|${k}`, 10_000_000, 99_999_999)}${serial}${det.int(`gnum2|${k}`, 100_000, 999_999)}`,
    sticker: String(det.int(`sticker|${k}`, 100_000_000, 999_999_999)),
    // Продажа и возврат нумеруются по-разному, и клиент их различает по первой букве.
    saleId: `${outcome === 'return' ? 'R' : 'S'}${det.int(`sale|${k}`, 1_000_000_000, 9_999_999_999)}`,
    incomeId: det.int(`income|${k}`, 10_000_000, 99_999_999),
    totalPrice: product.price,
    priceWithDisc: product.discountedPrice,
    finishedPrice,
    forPay,
    warehouseName: warehouse.name,
    warehouseRegion: warehouse.region,
    destinationCity: destination.city,
    destinationDistrict: destination.district,
    isMp: det.bool(`mp|${k}`),
  }
}

/**
 * События окна.
 *
 * Отбор идёт по дате изменения, а не заказа: боевой `dateFrom` у Wildberries
 * означает «что изменилось с этого момента», и клиент, забирающий обновления
 * инкрементально, ждёт именно этого.
 */
export function eventsInWindow(
  events: readonly OrderEvent[],
  from: Date,
  to: Date,
): readonly OrderEvent[] {
  const start = from.getTime()
  const end = to.getTime()
  return events.filter((e) => {
    const t = e.settledAt.getTime()
    return t >= start && t <= end
  })
}

/** Показатели воронки за один день. Тот же набор, что отдаёт аналитика Wildberries. */
export interface DayStats {
  readonly date: string
  readonly openCount: number
  readonly cartCount: number
  readonly orderCount: number
  readonly orderSum: number
  readonly buyoutCount: number
  readonly buyoutSum: number
  readonly cancelCount: number
  readonly cancelSum: number
  readonly addToWishlistCount: number
}

/**
 * Дневная раскладка воронки товара.
 *
 * Показатели товара в каталоге посчитаны за месяц; здесь месяц раскладывается по
 * дням с разбросом, но пропорции воронки внутри дня сохраняются — показы больше
 * корзин, корзины больше заказов, выкупы меньше заказов. Ряд по дням строится
 * именно отсюда: клиенту нужен график, а не три одинаковые точки.
 */
/**
 * Индекс «товар и день → его заказы».
 *
 * Без него каждый показатель дня перебирал весь журнал: двадцать товаров на
 * девяносто дней — это миллионы сравнений на один ответ, и аналитика отвечала
 * секундами вместо миллисекунд. Индекс строится один раз на журнал и живёт
 * ровно столько же — журнал неизменяем и меняется только со сменой суток.
 */
const dayIndexes = new WeakMap<object, Map<string, { orders: number; buyouts: number; cancels: number }>>()

function dayIndex(events: readonly OrderEvent[]): Map<string, { orders: number; buyouts: number; cancels: number }> {
  const cached = dayIndexes.get(events as object)
  if (cached) return cached
  const index = new Map<string, { orders: number; buyouts: number; cancels: number }>()
  for (const e of events) {
    const key = `${e.product.nmId}|${dayKey(e.orderedAt)}`
    const cell = index.get(key) ?? { orders: 0, buyouts: 0, cancels: 0 }
    cell.orders += 1
    if (e.outcome === 'buyout') cell.buyouts += 1
    if (e.outcome === 'cancel') cell.cancels += 1
    index.set(key, cell)
  }
  dayIndexes.set(events as object, index)
  return index
}

export function dayStats(
  product: Product,
  day: Date,
  events: readonly OrderEvent[] = [],
): DayStats {
  const key = dayKey(day)
  const det = new Deterministic(`day|${product.nmId}|${key}`)

  // Заказы дня берутся из журнала: клиент, сложивший записи из выгрузки заказов,
  // обязан получить то же число, что стоит в аналитике. Пока эти два ответа
  // считались по отдельности, они расходились в сотни раз — и сверить выгрузку
  // с витриной было нельзя.
  const cell = dayIndex(events).get(`${product.nmId}|${key}`)
  const orderCount = cell?.orders ?? 0
  const buyoutCount = cell?.buyouts ?? 0
  const cancelCount = cell?.cancels ?? 0

  // Показы и корзины журнал не хранит — их не бывает «событием». Выводим их
  // из заказов теми же соотношениями, что стоят в карточке товара: воронка
  // сужается от показов к заказам, а не живёт тремя независимыми числами.
  const viewsPerOrder = det.int('views', 40, 90)
  const cartPerOrder = det.int('cart', 4, 9)
  return {
    date: key,
    openCount: orderCount * viewsPerOrder,
    cartCount: orderCount * cartPerOrder,
    orderCount,
    orderSum: orderCount * product.discountedPrice,
    buyoutCount,
    buyoutSum: buyoutCount * product.discountedPrice,
    cancelCount,
    cancelSum: cancelCount * product.discountedPrice,
    addToWishlistCount: Math.round(orderCount * cartPerOrder / 3),
  }
}

/** Дни окна, от раннего к позднему. Больше глубины журнала не отдаём. */
export function daysOf(from: Date, to: Date): Date[] {
  const start = startOfDay(from).getTime()
  const end = startOfDay(to).getTime()
  const days: Date[] = []
  for (let t = start; t <= end && days.length < TIMELINE_DAYS; t += 86_400_000) {
    days.push(new Date(t))
  }
  return days
}

/** Сумма дневных показателей за окно: воронка за запрошенный период, а не за чужой. */
export function statsInWindow(
  product: Product,
  from: Date,
  to: Date,
  events: readonly OrderEvent[] = [],
): DayStats {
  const days = daysOf(from, to)
  const total = days.map((d) => dayStats(product, d, events)).reduce(
    (acc, d) => ({
      date: acc.date,
      openCount: acc.openCount + d.openCount,
      cartCount: acc.cartCount + d.cartCount,
      orderCount: acc.orderCount + d.orderCount,
      orderSum: acc.orderSum + d.orderSum,
      buyoutCount: acc.buyoutCount + d.buyoutCount,
      buyoutSum: acc.buyoutSum + d.buyoutSum,
      cancelCount: acc.cancelCount + d.cancelCount,
      cancelSum: acc.cancelSum + d.cancelSum,
      addToWishlistCount: acc.addToWishlistCount + d.addToWishlistCount,
    }),
    {
      date: dayKey(to), openCount: 0, cartCount: 0, orderCount: 0, orderSum: 0,
      buyoutCount: 0, buyoutSum: 0, cancelCount: 0, cancelSum: 0, addToWishlistCount: 0,
    },
  )
  return total
}
