import { Deterministic } from './deterministic.ts'
import { CATALOG_ITEMS } from './dictionaries.ts'

/**
 * Общий датасет песочницы: каталог товаров продавца.
 *
 * Без него каждый метод придумывал свои артикулы, и стенд отвечал верно по форме,
 * но про разные товары: каталог про один nmID, воронка про другой, остатки про третий.
 * Транспорт на таком стенде проверить можно, экономику — нет: ни маржи, ни ДРР,
 * ни «хватит на N дней» не посчитать, пока цифры не про один и тот же товар.
 *
 * Поэтому товар — единица датасета, а не набор независимых полей. Все методы
 * заполняются из этого пула, и цифры внутри товара согласованы между собой:
 * цена со скидкой выведена из цены и скидки, воронка убывает от показов к выкупам,
 * суммы заказов равны количеству, умноженному на цену.
 *
 * Пул зависит только от объёма датасета (min | medium | full), но не от метода:
 * иначе «тот же товар» в двух методах снова разъехался бы.
 */

export interface Product {
  /** Артикул WB. Он же ключ, по которому сходятся все методы. */
  nmId: number
  /** Идентификатор карточки-объединения. */
  imtId: number
  /** Идентификатор размера. У Ozon ему соответствует sku. */
  chrtId: number
  nmUuid: string
  /** Артикул продавца. */
  vendorCode: string
  barcode: string
  subjectId: number
  /** Предмет WB — узкая категория, по ней считается комиссия. */
  subjectName: string
  /** Широкая категория: «Одежда», «Электроника». */
  category: string
  brand: string
  title: string
  techSize: string
  /** Цена до скидки, рубли. */
  price: number
  /** Скидка продавца, проценты. */
  discountPercent: number
  /** Цена после скидки продавца — то, что видит покупатель до СПП. */
  discountedPrice: number
  /** Скидка постоянного покупателя, проценты. */
  spp: number
  rating: number
  /** Остаток на складах WB. */
  stock: number
  /** Остаток на складе продавца (FBS). */
  sellerStock: number
  /** Комиссия площадки по предмету, проценты. */
  commissionPercent: number
  // Воронка за период. Убывает: показы -> корзина -> заказы -> выкупы.
  openCount: number
  cartCount: number
  orderCount: number
  buyoutCount: number
  cancelCount: number
  orderSum: number
  buyoutSum: number
  /** Средний расход рекламы за период, рубли. */
  advertSum: number
}

/**
 * Сколько товаров в каталоге при каждом объёме датасета.
 *
 * Даже минимальный каталог — сотня артикулов: на десятке товаров не видно ни
 * пагинации, ни разброса маржи, ни «хватит на N дней» по складам, а именно это
 * на стенде и проверяют. Ответ от размера каталога не распухает: списки отдаются
 * страницами, как в бою.
 */
const POOL_SIZE: Record<string, number> = { min: 100, medium: 300, full: 1000 }

const cache = new Map<string, readonly Product[]>()

/** Каталог товаров для объёма датасета. Результат кешируется: пул общий для всех песочниц. */
export function productPool(salt: string): readonly Product[] {
  const cached = cache.get(salt)
  if (cached) return cached
  const size = POOL_SIZE[salt] ?? POOL_SIZE.medium!
  const det = new Deterministic(`dataset|${salt}`)
  const pool = Array.from({ length: size }, (_, i) => buildProduct(det, i))
  cache.set(salt, pool)
  return pool
}

function buildProduct(det: Deterministic, i: number): Product {
  const k = (suffix: string) => `product[${i}].${suffix}`
  // Номер товара разбирается на два разряда: позиция номенклатуры и вариант внутри неё.
  // Каталог получается линейками одной модели — так он устроен и у живого продавца.
  const item = CATALOG_ITEMS[i % CATALOG_ITEMS.length]!
  const round = Math.floor(i / CATALOG_ITEMS.length)
  const variant = item.variants[round % item.variants.length]!
  const generation = Math.floor(round / item.variants.length)
  const title = generation === 0
    ? `${item.title}, ${variant}`
    : `${item.title}, ${variant} (${generation + 1}-е поколение)`

  const price = det.int(k('price'), 3, 250) * 100 - 1
  const discountPercent = det.int(k('discount'), 5, 45)
  const discountedPrice = Math.round((price * (100 - discountPercent)) / 100)

  const openCount = det.int(k('open'), 400, 60_000)
  const cartCount = Math.round((openCount * det.int(k('cartRate'), 3, 18)) / 100)
  const orderCount = Math.round((cartCount * det.int(k('orderRate'), 20, 70)) / 100)
  const buyoutCount = Math.round((orderCount * det.int(k('buyoutRate'), 55, 95)) / 100)

  return {
    // Идентификаторы разнесены по номеру товара, а случайность добавляется внутри шага.
    // Так они выглядят как настоящие, но заведомо не совпадают: на каталоге в тысячу
    // артикулов случайные числа сталкиваются, и два товара получают один nmID.
    nmId: 100_000_000 + i * 1000 + det.int(k('nmId'), 0, 900),
    imtId: 10_000_000 + i * 100 + det.int(k('imtId'), 0, 90),
    chrtId: 1_000_000_000 + i * 1000 + det.int(k('chrtId'), 0, 900),
    nmUuid: det.uuid(k('nmUuid')),
    vendorCode: `ART-${String(i + 1001)}`,
    barcode: `2${String(i + 1).padStart(6, '0')}${String(det.int(k('barcode'), 0, 999_999)).padStart(6, '0')}`,
    subjectId: 1000 + (i % CATALOG_ITEMS.length),
    subjectName: item.subject,
    category: item.category,
    brand: item.brand,
    title,
    techSize: '0',
    price,
    discountPercent,
    discountedPrice,
    spp: det.int(k('spp'), 0, 25),
    rating: det.int(k('rating'), 3, 5),
    stock: det.int(k('stock'), 0, 240),
    sellerStock: det.int(k('sellerStock'), 0, 120),
    commissionPercent: det.int(k('commission'), 12, 25),
    openCount,
    cartCount,
    orderCount,
    buyoutCount,
    cancelCount: orderCount - buyoutCount,
    orderSum: orderCount * discountedPrice,
    buyoutSum: buyoutCount * discountedPrice,
    advertSum: det.int(k('advert'), 500, 90_000),
  }
}

/**
 * Значение поля из товара — или undefined, если поле не про товар.
 *
 * Сопоставление по имени поля, а не по схеме: у одного и того же смысла в трёх API
 * четыре написания (nmID, nmId, nm_id, nmid), и схемы этого не связывают.
 *
 * `inRecord` говорит, что мы внутри записи о товаре. Только там имеет смысл трактовать
 * размытые имена — name, price, quantity, sum: в ответе про склад «name» это адрес,
 * а в тарифах «price» — стоимость логистики, и товар им ничего не должен.
 */
export function productField(name: string, p: Product, inRecord: boolean): number | string | undefined {
  const n = name.toLowerCase().replace(/[_\s]/g, '')

  // Идентификаторы — однозначны в любом контексте.
  if (n === 'nmid' || n === 'nmids' || n === 'nomenclature') return p.nmId
  if (n === 'imtid') return p.imtId
  if (n === 'nmuuid') return p.nmUuid
  if (n === 'chrtid') return p.chrtId
  if (n === 'barcode' || n === 'barcodes' || n === 'ean') return p.barcode
  if (n === 'vendorcode' || n === 'supplierarticle' || n === 'offerid' || n === 'sellerarticle') return p.vendorCode
  if (n === 'techsize') return p.techSize
  if (n === 'subjectid') return p.subjectId
  if (n === 'subjectname') return p.subjectName
  if (n === 'categoryname') return p.category
  if (n === 'brand' || n === 'brandname') return p.brand
  if (n === 'productname' || n === 'goodsname' || n === 'itemname') return p.title
  if (n === 'productrating' || n === 'feedbackrating') return p.rating

  // Цены и скидки.
  if (n === 'totalprice' || n === 'retailprice' || n === 'sellerprice' || n === 'oldprice') return p.price
  if (
    n === 'discountedprice' || n === 'finishedprice' || n === 'pricewithdisc' || n === 'retailpricewithdisc' ||
    n === 'avgprice' || n === 'avgpricerub' || n === 'clubdiscountedprice'
  ) return p.discountedPrice
  if (n === 'discountpercent' || n === 'salepercent') return p.discountPercent
  if (n === 'spp' || n === 'sppprc') return p.spp
  if (n === 'commissionpercent' || n === 'kvwbase') return p.commissionPercent

  // Воронка. Имена достаточно узкие, чтобы не встретиться вне товарной аналитики.
  if (n === 'opencount' || n === 'opencardcount' || n === 'viewcount') return p.openCount
  if (n === 'cartcount' || n === 'addtocartcount') return p.cartCount
  if (n === 'ordercount' || n === 'orderscount') return p.orderCount
  if (n === 'ordersum' || n === 'orderssumrub' || n === 'ordersumrub') return p.orderSum
  if (n === 'buyoutcount' || n === 'buyoutscount') return p.buyoutCount
  if (n === 'buyoutsum' || n === 'buyoutssumrub' || n === 'buyoutsumrub' || n === 'forpay') return p.buyoutSum
  if (n === 'cancelcount' || n === 'cancelscount') return p.cancelCount
  if (n === 'cancelsum' || n === 'cancelsumrub') return p.cancelCount * p.discountedPrice
  if (n === 'buyoutpercent' || n === 'buyoutspercent')
    return p.orderCount === 0 ? 0 : Math.round((p.buyoutCount / p.orderCount) * 100)
  if (n === 'addtocartpercent') return p.openCount === 0 ? 0 : Math.round((p.cartCount / p.openCount) * 100)
  if (n === 'carttoorderpercent') return p.cartCount === 0 ? 0 : Math.round((p.orderCount / p.cartCount) * 100)

  if (!inRecord) return undefined

  // Дальше — только внутри записи о товаре.
  if (n === 'sku' || n === 'skus' || n === 'skuid' || n === 'productid') return p.chrtId
  if (n === 'article') return p.vendorCode
  if (n === 'size') return p.techSize
  if (n === 'subject') return p.subjectName
  if (n === 'category') return p.category
  if (n === 'title' || n === 'name') return p.title
  if (n === 'rating') return p.rating
  if (n === 'price') return p.price
  if (n === 'discount') return p.discountPercent
  if (n === 'currency' || n === 'currencyisocode' || n === 'currencyisocode4217') return 'RUB'
  if (n === 'quantity' || n === 'quantityfull' || n === 'stock' || n === 'stocks' || n === 'present') return p.stock
  if (n === 'stockmp' || n === 'sellerstock' || n === 'stocksmp' || n === 'mp') return p.sellerStock
  if (n === 'wb') return p.stock
  if (n === 'balancesum' || n === 'stocksum') return p.stock * p.discountedPrice
  if (n === 'sum' || n === 'sumrub' || n === 'advertsum') return p.advertSum

  return undefined
}

/** Поля, которые описывают товар. Используется, чтобы узнать товарный список в примере. */
const PRODUCT_KEYS = new Set(['nmid', 'nmids', 'vendorcode', 'supplierarticle', 'offerid', 'imtid', 'chrtid', 'sku'])

/**
 * Похож ли объект на запись о товаре: по нему решаем, разворачивать ли список по каталогу.
 *
 * Смотрим и на вложенные объекты первого уровня: в воронке продаж запись выглядит как
 * `{ product: {...}, statistic: {...} }`, и артикул лежит на уровень глубже. Без этого
 * воронка осталась бы единственным отчётом, который не разворачивается по каталогу.
 */
export function looksLikeProduct(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  if (hasProductKey(node)) return true
  return Object.values(node).some((v) => hasProductKey(v))
}

/** Есть ли у объекта собственное товарное поле: по нему решаем, товарная ли это запись. */
export function hasProductKey(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  return Object.keys(node).some((k) => PRODUCT_KEYS.has(k.toLowerCase().replace(/[_\s]/g, '')))
}
