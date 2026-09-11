import { Deterministic } from './deterministic.ts'
import type { Product } from './dataset.ts'

/**
 * Рынок вокруг товара: чужие карточки того же предмета.
 *
 * Каталог песочницы — это витрина ОДНОГО продавца: у предмета один бренд, одна
 * цена, один продавец. Для сбора конкурентов такого набора мало: коридор цен
 * не построить, медиану считать не по чему, «дешевле рынка на 12 %» не с чем
 * сравнить. Поэтому у каждой карточки есть рынок — десяток чужих предложений
 * того же предмета от других продавцов.
 *
 * Три свойства, ради которых это и сделано:
 *
 *   1. **Цены группируются вокруг своей.** Конкурент строится ОТ цены карточки,
 *      с разбросом в пределах трети. Иначе выходило то, за чем и приходят
 *      с претензией: айфон за 29 514 ₽ как конкурент коврика за 10 125 ₽, и
 *      коридор цен превращается в бессмыслицу.
 *   2. **Продавцы разные и настоящие на вид.** Своё юрлицо, ИНН и ОГРН с верной
 *      контрольной суммой, свой рейтинг: клиент, который группирует выдачу по
 *      продавцу или проверяет ИНН, обязан работать на песочнице так же, как в бою.
 *   3. **Артикулы чужие.** Диапазон конкурентов не пересекается с каталогом
 *      продавца — иначе собранный «конкурент» оказался бы его собственной
 *      карточкой, и наценка считалась бы относительно самого себя.
 */

/** Сколько чужих предложений приходится на одну карточку каталога. */
const PER_PRODUCT = 12

/**
 * Начало диапазона артикулов конкурентов.
 *
 * Каталог продавца начинается со 100 000 000 и занимает миллион номеров;
 * конкуренты начинаются заведомо выше, чтобы пересечения не было никогда.
 */
const COMPETITOR_NM_BASE = 300_000_000

/** Магазины, под которыми выступают конкуренты. */
const SHOPS = [
  { name: 'ТехноЛавка', form: 'ООО' },
  { name: 'МаркетДом', form: 'ООО' },
  { name: 'ПродаЖа', form: 'ИП' },
  { name: 'Оптовик 24', form: 'ООО' },
  { name: 'СеверТорг', form: 'ООО' },
  { name: 'ГудсМаркет', form: 'ИП' },
  { name: 'Первый Склад', form: 'ООО' },
  { name: 'ТриЦены', form: 'ИП' },
  { name: 'Дом Товаров', form: 'ООО' },
  { name: 'БыстроМаркет', form: 'ООО' },
  { name: 'Ситипак', form: 'ИП' },
  { name: 'Ассортим', form: 'ООО' },
] as const

/** Фамилии для ИП: у индивидуального предпринимателя юрлицо — это он сам. */
const OWNERS = [
  'Крылова Анна Сергеевна', 'Дементьев Пётр Ильич', 'Савина Ольга Викторовна',
  'Ткачук Роман Андреевич', 'Белова Ирина Павловна', 'Хабибуллин Тимур Ринатович',
] as const

/** Чем чужая карточка отличается от нашей на витрине: те же слова, другой акцент. */
const TITLE_SUFFIX = [
  'premium', 'lite', 'pro', 'original', 'набор', 'подарочный',
  'улучшенный', 'compact', 'classic', 'плюс',
] as const

/** Названия характеристик — общие для любого предмета, значения привязаны к товару. */
const SPEC_NAMES = [
  'Материал', 'Страна производства', 'Гарантия', 'Комплектация', 'Вес, г',
  'Сезон', 'Упаковка', 'Артикул производителя', 'Тип товара', 'Бренд',
] as const

const MATERIALS = ['пластик', 'хлопок', 'металл', 'дерево', 'полиэстер', 'керамика'] as const
const COUNTRIES = ['Россия', 'Китай', 'Турция', 'Беларусь', 'Вьетнам'] as const
const WARRANTIES = ['6 месяцев', '12 месяцев', '24 месяца', 'без гарантии'] as const
const SEASONS = ['всесезонный', 'лето', 'зима', 'демисезон'] as const
const PACKAGING = ['коробка', 'пакет', 'блистер', 'подарочная упаковка'] as const

export interface Competitor {
  /** Артикул конкурента. Из чужого диапазона: это не карточка продавца. */
  readonly nmId: number
  readonly title: string
  readonly brand: string
  readonly subjectName: string
  readonly category: string
  /** Цена до скидки и цена на витрине. */
  readonly price: number
  readonly discountedPrice: number
  readonly discountPercent: number
  readonly rating: number
  readonly reviewsCount: number
  readonly stock: number
  readonly sellerId: number
  readonly sellerName: string
  /** Юрлицо продавца целиком: так его показывает карточка продавца. */
  readonly sellerFullName: string
  readonly inn: string
  readonly ogrn: string
  readonly sellerRating: number
  /**
   * Фотографии предложения. Число варьируется от карточки к карточке — иначе
   * «ровно одно фото у всех» превращает выборку в один и тот же снимок.
   */
  readonly images: readonly string[]
  /**
   * Видео карточки. Не у всех предложений оно есть — часть продавцов видео
   * не снимает, и на боевом рынке так и есть; но у части оно ЕСТЬ, а не
   * отсутствует поголовно, как было бы, останься поле совсем без значения.
   */
  readonly video: { readonly url: string; readonly type: string; readonly width: number; readonly height: number } | null
  /** Характеристики предложения: набор «имя-значение», разного размера у разных карточек. */
  readonly characteristics: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** Короткая история цены: несколько точек за последние недели. */
  readonly priceHistory: ReadonlyArray<{ readonly date: string; readonly price: number }>
  /** Товар каталога, вокруг которого построено предложение. */
  readonly reference: Product
}

const cache = new Map<string, readonly Competitor[]>()

/**
 * Рынок вокруг одной карточки. Детерминирован: тот же товар — тот же рынок.
 */
export function competitorsFor(product: Product, salt: string): readonly Competitor[] {
  const key = `${salt}|${product.nmId}`
  const cached = cache.get(key)
  if (cached) return cached

  const det = new Deterministic(`competitors|${key}`)
  const list = Array.from({ length: PER_PRODUCT }, (_, i) => build(product, det, i))
  cache.set(key, list)
  if (cache.size > 5_000) cache.delete(cache.keys().next().value as string)
  return list
}

/** Рынок вокруг нескольких карточек, вперемешку, но детерминированно. */
export function competitorMarket(
  products: readonly Product[],
  salt: string,
  seed: string,
): readonly Competitor[] {
  const det = new Deterministic(`market|${seed}`)
  const all = products.flatMap((p) => competitorsFor(p, salt))
  // Порядок выдачи маркетплейса — не порядок каталога: иначе первыми всегда
  // идут предложения по первому товару, и клиент, берущий верхние десять,
  // соберёт рынок одной карточки вместо рынка запроса.
  return [...all]
    .map((c) => ({ c, order: det.int(`order|${c.nmId}`, 0, 1_000_000) }))
    .sort((a, b) => a.order - b.order)
    .map((x) => x.c)
}

function build(product: Product, det: Deterministic, i: number): Competitor {
  const k = `${product.nmId}|${i}`
  const shop = SHOPS[det.int(`shop|${k}`, 0, SHOPS.length - 1)]!
  const isSoleTrader = shop.form === 'ИП'

  // Цена конкурента — от нашей, с разбросом в пределах трети в обе стороны.
  // Так у выдачи появляется коридор: медиана, дешёвый край, дорогой край.
  const factor = det.float(`price|${k}`, 0.7, 1.32)
  const price = Math.max(100, Math.round((product.price * factor) / 10) * 10 - 1)
  const discountPercent = det.int(`discount|${k}`, 0, 45)
  const discountedPrice = Math.round((price * (100 - discountPercent)) / 100)

  const sellerId = 200_000 + det.int(`seller|${k}`, 0, 799_999)
  const suffix = TITLE_SUFFIX[det.int(`suffix|${k}`, 0, TITLE_SUFFIX.length - 1)]!
  // Название — тот же предмет, другой акцент: по нему клиент и сопоставляет
  // чужое предложение со своей карточкой.
  const title = `${product.subjectName} ${shop.name} ${suffix}`
  const nmId = COMPETITOR_NM_BASE + det.int(`nm|${k}`, 0, 89_999_999)

  // Фото: от двух до шести на предложение — иначе у любой выборки в один
  // снимок, и медиана по числу фото ничего не показывает.
  const imageCount = det.int(`imageCount|${k}`, 2, 6)
  const images = Array.from(
    { length: imageCount },
    (_, idx) => `https://cdn.apistend.sandbox/media/${sellerId}/${nmId}/${idx + 1}.webp`,
  )

  // Видео есть не у всех предложений — как и в бою, часть продавцов его не
  // снимает, — но у трети оно есть, а не отсутствует у всех подряд.
  const hasVideo = det.bool(`hasVideo|${k}`, 0.35)
  const video = hasVideo
    ? {
        url: `https://cdn.apistend.sandbox/media/${sellerId}/${nmId}/video.mp4`,
        type: 'video/mp4',
        width: 1280,
        height: det.pick(`videoOrientation|${k}`, [720, 1600] as const),
      }
    : null

  // Характеристики: от двух до шести пар, часть — общие для любого предмета
  // (материал, страна, гарантия), часть — сам предмет и бренд конкурента.
  const specCount = det.int(`specCount|${k}`, 2, 6)
  const specPool: ReadonlyArray<{ name: string; value: string }> = [
    { name: 'Бренд', value: shop.name },
    { name: 'Тип товара', value: product.subjectName },
    { name: 'Материал', value: MATERIALS[det.int(`material|${k}`, 0, MATERIALS.length - 1)]! },
    { name: 'Страна производства', value: COUNTRIES[det.int(`country|${k}`, 0, COUNTRIES.length - 1)]! },
    { name: 'Гарантия', value: WARRANTIES[det.int(`warranty|${k}`, 0, WARRANTIES.length - 1)]! },
    { name: 'Вес, г', value: String(det.int(`weight|${k}`, 80, 8_000)) },
    { name: 'Сезон', value: SEASONS[det.int(`season|${k}`, 0, SEASONS.length - 1)]! },
    { name: 'Упаковка', value: PACKAGING[det.int(`packaging|${k}`, 0, PACKAGING.length - 1)]! },
    { name: 'Артикул производителя', value: `${sellerId}-${nmId % 1000}` },
    { name: SPEC_NAMES[det.int(`extraSpec|${k}`, 0, SPEC_NAMES.length - 1)]!, value: product.category },
  ]
  const characteristics = specPool.slice(0, specCount)

  // История цены: две-пять точек за последние недели, идущих к нынешней цене.
  const historyLength = det.int(`historyLength|${k}`, 2, 5)
  const priceHistory = Array.from({ length: historyLength }, (_, idx) => {
    const daysAgo = (historyLength - idx) * det.int(`historyGap|${k}|${idx}`, 5, 14)
    const drift = det.float(`historyDrift|${k}|${idx}`, 0.85, 1.2)
    return {
      date: new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10),
      price: Math.max(100, Math.round((price * drift) / 10) * 10),
    }
  })

  return {
    nmId,
    title,
    brand: shop.name,
    subjectName: product.subjectName,
    category: product.category,
    price,
    discountedPrice,
    discountPercent,
    rating: Number((det.int(`rating|${k}`, 32, 50) / 10).toFixed(1)),
    reviewsCount: det.int(`reviews|${k}`, 0, 12_000),
    stock: det.int(`stock|${k}`, 0, 900),
    sellerId,
    sellerName: shop.name,
    sellerFullName: isSoleTrader
      ? `Индивидуальный предприниматель ${OWNERS[det.int(`owner|${k}`, 0, OWNERS.length - 1)]!}`
      : `Общество с ограниченной ответственностью «${shop.name}»`,
    // ИНН и ОГРН — с верной контрольной суммой: клиент, который их проверяет,
    // на песочнице обязан получить тот же ответ, что и в бою.
    inn: isSoleTrader ? innIndividual(det, k) : innCompany(det, k),
    ogrn: isSoleTrader ? ogrnIp(det, k) : ogrnCompany(det, k),
    sellerRating: Number((det.int(`sellerRating|${k}`, 35, 50) / 10).toFixed(1)),
    images,
    video,
    characteristics,
    priceHistory,
    reference: product,
  }
}

/** Контрольная цифра ИНН: свёртка по весам, остаток от деления на 11. */
function checksum(digits: readonly number[], weights: readonly number[]): number {
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i]!, 0)
  return (sum % 11) % 10
}

function innCompany(det: Deterministic, k: string): string {
  const body = Array.from({ length: 9 }, (_, i) => det.int(`inn|${k}|${i}`, 0, 9))
  return `${body.join('')}${checksum(body, [2, 4, 10, 3, 5, 9, 4, 6, 8])}`
}

function innIndividual(det: Deterministic, k: string): string {
  const body = Array.from({ length: 10 }, (_, i) => det.int(`innip|${k}|${i}`, 0, 9))
  const eleventh = checksum(body, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
  const twelfth = checksum([...body, eleventh], [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
  return `${body.join('')}${eleventh}${twelfth}`
}

/** ОГРН: последняя цифра — остаток от деления числа без неё на 11. */
function ogrn(det: Deterministic, k: string, length: 13 | 15): string {
  const body = Array.from({ length: length - 1 }, (_, i) =>
    det.int(`ogrn|${k}|${i}`, i === 0 ? 1 : 0, 9)).join('')
  const remainder = Number(BigInt(body) % (length === 13 ? 11n : 13n)) % 10
  return `${body}${remainder}`
}

const ogrnCompany = (det: Deterministic, k: string) => ogrn(det, k, 13)
const ogrnIp = (det: Deterministic, k: string) => ogrn(det, k, 15)
