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
  const perDay = Math.max(3, Math.round(pool.length / 40))
  const events: OrderEvent[] = []

  for (let back = TIMELINE_DAYS - 1; back >= 0; back--) {
    const day = new Date(today.getTime() - back * 86_400_000)
    for (let i = 0; i < perDay; i++) {
      const k = `${dayKey(day)}|${i}`
      const product = pool[det.int(`product|${k}`, 0, pool.length - 1)]!
      // Время внутри дня: заказы идут не в полночь, а в течение суток.
      const orderedAt = new Date(
        day.getTime() +
        det.int(`hour|${k}`, 7, 23) * 3_600_000 +
        det.int(`minute|${k}`, 0, 59) * 60_000 +
        det.int(`second|${k}`, 0, 59) * 1000,
      )
      events.push(buildEvent(product, orderedAt, now, det, k))
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
): OrderEvent {
  // Доли исходов — из воронки самого товара: тот же процент выкупа, который
  // клиент увидит в аналитике, обязан получиться и подсчётом по журналу.
  const orders = Math.max(1, product.orderCount)
  const buyoutShare = product.buyoutCount / orders
  const cancelShare = Math.min(product.cancelCount / orders, 1 - buyoutShare)
  const roll = det.float(`roll|${k}`, 0, 1)

  // Заказ младше суток ещё не решён: у боевого API он висит в статусе «оформлен».
  const ageMs = now.getTime() - orderedAt.getTime()
  const settleDays = det.int(`settle|${k}`, 1, 5)
  const outcome: Outcome = ageMs < 86_400_000
    ? 'created'
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
export function dayStats(product: Product, day: Date): DayStats {
  const key = dayKey(day)
  const det = new Deterministic(`day|${product.nmId}|${key}`)
  // Разброс дня: спрос не бывает ровным, но и не скачет на порядок.
  const factor = det.float('factor', 0.55, 1.45)
  const per = (monthly: number) => Math.round((monthly / BASE_PERIOD_DAYS) * factor)

  const orderCount = per(product.orderCount)
  const buyoutCount = Math.min(orderCount, per(product.buyoutCount))
  const cancelCount = Math.min(orderCount - buyoutCount, per(product.cancelCount))
  return {
    date: key,
    openCount: per(product.openCount),
    cartCount: per(product.cartCount),
    orderCount,
    orderSum: orderCount * product.discountedPrice,
    buyoutCount,
    buyoutSum: buyoutCount * product.discountedPrice,
    cancelCount,
    cancelSum: cancelCount * product.discountedPrice,
    addToWishlistCount: per(Math.round(product.cartCount / 3)),
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
export function statsInWindow(product: Product, from: Date, to: Date): DayStats {
  const days = daysOf(from, to)
  const total = days.map((d) => dayStats(product, d)).reduce(
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
