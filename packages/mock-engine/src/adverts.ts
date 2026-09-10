import { Deterministic } from './deterministic.ts'
import type { Product } from './dataset.ts'
import { dayKey, startOfDay } from './timeline.ts'

/**
 * Рекламные кампании песочницы.
 *
 * Реклама — единственный раздел кабинета, где данные обязаны сойтись сразу
 * в трёх местах: список кампаний, статистика по кампании и разнесение расхода
 * по карточкам. Пока каждый метод отвечал своим примером из документации, они
 * не сходились нигде:
 *
 *   • список отдавал кампании 123456 и 54321, статистика — 22161678 и 28449281.
 *     Клиент, который берёт идентификаторы из списка и просит по ним статистику,
 *     получал чужие кампании, не находил их у себя и отбрасывал строки — расход
 *     не записывался никуда, а вслед за ним пропадали ДРР, клики, CTR и CPC;
 *   • внутри дня все карточки были одной и той же, поэтому расход, даже если бы
 *     дошёл, разнёсся бы на один артикул из трёхсот;
 *   • кампании покрывали первые двадцать карточек каталога, и у остального
 *     каталога рекламы не было вовсе.
 *
 * Поэтому кампании здесь — сущность песочницы, а не строка примера: у каждой
 * свой набор карточек, свой период и свой бюджет, а вся статистика считается
 * от них. Клиент, сложивший расход по дням, получит расход кампании; сложивший
 * расход по карточкам — то же число.
 */

/** Сколько карточек ведёт одна кампания. */
const PRODUCTS_PER_CAMPAIGN = 25

/** Типы кампаний Wildberries: 8 — автоматическая, 9 — аукцион. */
const TYPES = [8, 9] as const

/** Статусы: 9 — идёт, 11 — на паузе, 7 — завершена. */
const STATUSES = [9, 9, 9, 11, 7] as const

export interface AdvertCampaign {
  readonly advertId: number
  readonly name: string
  readonly type: number
  readonly status: number
  readonly createdAt: Date
  readonly startedAt: Date
  /** Дата окончания — только у завершённых: у идущей кампании её нет. */
  readonly endedAt: Date | null
  /** Карточки кампании. Их и показывает `nms`, по ним же разносится расход. */
  readonly products: readonly Product[]
  /** Дневной бюджет, рубли. */
  readonly dailyBudget: number
  readonly paymentType: string
}

const cache = new Map<string, readonly AdvertCampaign[]>()

/**
 * Кампании песочницы. Их столько, чтобы хватило на весь каталог.
 *
 * Кампании на первые двадцать карточек мало: у продавца с тремя сотнями
 * артикулов вопрос «а что с рекламой по этому товару» задаётся про любой из них,
 * и ответ «кампаний нет» на 93 % каталога проверяет не интеграцию, а терпение.
 */
export function advertCampaigns(
  salt: string,
  pool: readonly Product[],
  now: Date,
): readonly AdvertCampaign[] {
  if (pool.length === 0) return []
  const key = `${salt}|${dayKey(now)}|${pool.length}`
  const cached = cache.get(key)
  if (cached) return cached

  const det = new Deterministic(`adverts|${key}`)
  const today = startOfDay(now)
  const count = Math.max(2, Math.ceil(pool.length / PRODUCTS_PER_CAMPAIGN))
  const campaigns: AdvertCampaign[] = []

  for (let i = 0; i < count; i++) {
    const k = `campaign|${i}`
    const products = pool.slice(i * PRODUCTS_PER_CAMPAIGN, (i + 1) * PRODUCTS_PER_CAMPAIGN)
    if (products.length === 0) break
    const status = STATUSES[det.int(`status|${k}`, 0, STATUSES.length - 1)]!
    const startedDaysAgo = det.int(`started|${k}`, 20, 180)
    const startedAt = new Date(today.getTime() - startedDaysAgo * 86_400_000)
    // Завершённая кампания закончилась в прошлом, идущая не закончилась вовсе:
    // клиент, который считает активные кампании по отсутствию endTime, обязан
    // получить тот же ответ, что и в бою.
    const endedAt = status === 7
      ? new Date(today.getTime() - det.int(`ended|${k}`, 1, 15) * 86_400_000)
      : null

    campaigns.push({
      // Восьмизначные идентификаторы — как у боевых кампаний.
      advertId: 20_000_000 + det.int(`id|${k}`, 0, 9_999_999),
      // Имя кампании продавцы дают по товару, который она ведёт.
      name: `${products[0]!.subjectName} — ${det.bool(`auto|${k}`) ? 'авто' : 'поиск'} ${i + 1}`,
      type: TYPES[det.int(`type|${k}`, 0, TYPES.length - 1)]!,
      status,
      createdAt: new Date(startedAt.getTime() - det.int(`created|${k}`, 1, 5) * 86_400_000),
      startedAt,
      endedAt,
      products,
      dailyBudget: det.int(`budget|${k}`, 500, 15_000),
      paymentType: det.bool(`payment|${k}`) ? 'Баланс' : 'Счет',
    })
  }

  cache.set(key, campaigns)
  if (cache.size > 8) cache.delete(cache.keys().next().value as string)
  return campaigns
}

/** Кампания по идентификатору — или undefined, если такой в песочнице нет. */
export function campaignById(
  campaigns: readonly AdvertCampaign[],
  advertId: number,
): AdvertCampaign | undefined {
  return campaigns.find((c) => c.advertId === advertId)
}

/**
 * Кампании, которые спросил клиент.
 *
 * Просил конкретные — отдаём их и только их: статистика по чужой кампании
 * бесполезна вдвойне, потому что клиент не может её ни к чему привязать.
 * Незнакомый идентификатор не выдумывается — его просто нет в ответе, как и
 * у боевого API.
 */
export function requestedCampaigns(
  campaigns: readonly AdvertCampaign[],
  ids: readonly number[],
): readonly AdvertCampaign[] {
  if (ids.length === 0) return campaigns
  const wanted = ids.map((id) => campaignById(campaigns, id)).filter((c): c is AdvertCampaign => !!c)
  // Все идентификаторы чужие: отдаём пустую статистику, а не подменяем запрос
  // своими кампаниями — иначе клиент решит, что чужие кампании у него есть.
  return wanted
}

/** Показатели кампании за день, а при указании товара — его доля в этом дне. */
export interface AdvertStats {
  readonly views: number
  readonly clicks: number
  readonly ctr: number
  readonly cpc: number
  readonly sum: number
  readonly atbs: number
  readonly orders: number
  readonly shks: number
  readonly sumPrice: number
  readonly cr: number
  readonly canceled: number
  readonly avgPosition: number
}

/** Площадки, по которым Wildberries разносит показы: сайт, Android, iOS. */
export const APP_TYPES = [1, 32, 64] as const

/**
 * Базовая единица статистики: одна карточка, один день, одна площадка.
 *
 * Всё остальное — суммы над ней, и это главное свойство раздела. Клиент,
 * сложивший карточки, получает день площадки; сложивший площадки — день
 * кампании; сложивший дни — итог в шапке ответа. Пока каждый уровень
 * генерировался сам по себе, эти три числа не сходились, и сверка расхода
 * с расходом по карточкам показывала расхождение на порядки.
 *
 * Показатели считаются от показов вниз по воронке: клики не больше показов,
 * CTR — их отношение, CPC — расход, делённый на клики. Иначе в ответе стоял бы
 * CTR 107 % при кликах больше показов.
 */
/**
 * Кеш посчитанного.
 *
 * Одна и та же единица нужна дважды: день кампании складывает все карточки,
 * а потом каждая карточка печатается в `nms` со своими числами. Без кеша ответ
 * за 90 дней по десятку кампаний пересчитывался бы десятками тысяч раз.
 */
const statsCache = new Map<string, AdvertStats>()

function unitStats(
  campaign: AdvertCampaign,
  day: Date,
  product: Product,
  appType: number,
): AdvertStats {
  const cacheKey = `${campaign.advertId}|${dayKey(day)}|${product.nmId}|${appType}`
  const cached = statsCache.get(cacheKey)
  if (cached) return cached
  const value = computeUnit(campaign, day, product, appType, cacheKey)
  // Потолок кеша: десять кампаний × 90 дней × 25 карточек × 3 площадки.
  if (statsCache.size > 200_000) statsCache.clear()
  statsCache.set(cacheKey, value)
  return value
}

function computeUnit(
  campaign: AdvertCampaign,
  day: Date,
  product: Product,
  appType: number,
  cacheKey: string,
): AdvertStats {
  const det = new Deterministic(`advunit|${cacheKey}`)

  // Кампания вне своего периода не тратит ничего: клиент, который строит график
  // расхода, обязан увидеть у завершённой кампании ноль после даты окончания.
  const time = startOfDay(day).getTime()
  const outside = time < startOfDay(campaign.startedAt).getTime()
    || (campaign.endedAt !== null && time > startOfDay(campaign.endedAt).getTime())
  // Показы получает не весь ассортимент каждый день: часть карточек в этот день
  // просто не показывалась, и ноль у них — не ошибка, а обычное состояние.
  if (outside || det.float('shown', 0, 1) > 0.55) return EMPTY

  const views = det.int('views', 10, 900)
  const ctrPercent = det.float('ctr', 0.8, 12)
  const clicks = Math.max(0, Math.min(views, Math.round((views * ctrPercent) / 100)))
  const sum = Number((clicks * det.float('cpc', 3, 26)).toFixed(2))
  const atbs = Math.round(clicks * det.float('atbs', 0.02, 0.25))
  const orders = Math.round(atbs * det.float('orders', 0.15, 0.7))
  const canceled = Math.round(orders * det.float('canceled', 0, 0.15))

  return {
    views,
    clicks,
    ctr: ratio(clicks, views),
    cpc: clicks === 0 ? 0 : Number((sum / clicks).toFixed(2)),
    sum,
    atbs,
    orders,
    shks: orders + Math.round(orders * det.float('shks', 0, 0.4)),
    sumPrice: orders * product.discountedPrice,
    cr: ratio(orders, clicks),
    canceled,
    avgPosition: det.int('position', 1, 60),
  }
}

const EMPTY: AdvertStats = {
  views: 0, clicks: 0, ctr: 0, cpc: 0, sum: 0, atbs: 0, orders: 0,
  shks: 0, sumPrice: 0, cr: 0, canceled: 0, avgPosition: 0,
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(2))
}

/** Сумма показателей: производные (CTR, CPC, CR) пересчитываются, а не складываются. */
function total(parts: readonly AdvertStats[]): AdvertStats {
  const views = parts.reduce((a, s) => a + s.views, 0)
  const clicks = parts.reduce((a, s) => a + s.clicks, 0)
  const sum = Number(parts.reduce((a, s) => a + s.sum, 0).toFixed(2))
  const orders = parts.reduce((a, s) => a + s.orders, 0)
  const positions = parts.filter((s) => s.views > 0).map((s) => s.avgPosition)
  return {
    views,
    clicks,
    ctr: ratio(clicks, views),
    cpc: clicks === 0 ? 0 : Number((sum / clicks).toFixed(2)),
    sum,
    atbs: parts.reduce((a, s) => a + s.atbs, 0),
    orders,
    shks: parts.reduce((a, s) => a + s.shks, 0),
    sumPrice: parts.reduce((a, s) => a + s.sumPrice, 0),
    cr: ratio(orders, clicks),
    canceled: parts.reduce((a, s) => a + s.canceled, 0),
    avgPosition: positions.length === 0
      ? 0
      : Math.round(positions.reduce((a, p) => a + p, 0) / positions.length),
  }
}

/**
 * Статистика за день: кампании целиком, её площадки, её карточки.
 *
 * Что именно суммировать, решают аргументы: без карточки и площадки — весь день
 * кампании, с площадкой — её доля, с карточкой — доля карточки.
 */
export function advertDayStats(
  campaign: AdvertCampaign,
  day: Date,
  product?: Product,
  appType?: number,
): AdvertStats {
  const products = product ? [product] : campaign.products
  const apps = appType === undefined ? APP_TYPES : [appType]
  return total(products.flatMap((p) => apps.map((a) => unitStats(campaign, day, p, a))))
}

/** Итог за окно: сумма дней. Он и стоит в шапке ответа статистики. */
export function advertTotals(
  campaign: AdvertCampaign,
  days: readonly Date[],
  product?: Product,
  appType?: number,
): AdvertStats {
  return total(days.map((d) => advertDayStats(campaign, d, product, appType)))
}

/**
 * Идентификаторы кампаний из запроса.
 *
 * Пишут их по-разному: `ids=1,2` в адресе у одной версии метода, `advertIds`
 * у другой, массив в теле у третьей. Разбираем все написания — клиент не должен
 * угадывать, какое из них песочница поняла.
 */
export function readAdvertIds(query: Record<string, string | string[]>, body: unknown): number[] {
  const out: number[] = []
  const push = (value: unknown) => {
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    if (Number.isFinite(n) && n > 0) out.push(Math.trunc(n))
  }
  const collect = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item !== null && typeof item === 'object') collect(item, depth + 1)
      }
      return
    }
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      const key = rawKey.toLowerCase().replace(/[_\s-]/g, '')
      if (key === 'id' || key === 'ids' || key === 'advertid' || key === 'advertids' || key === 'campaignids') {
        if (Array.isArray(value)) value.forEach(push)
        else if (typeof value === 'string') value.split(',').forEach(push)
        else push(value)
        continue
      }
      if (value !== null && typeof value === 'object') collect(value, depth + 1)
    }
  }
  collect(query, 0)
  collect(body, 0)
  return [...new Set(out)]
}
