import { Deterministic, productPool, type Product } from '@apistend/mock-engine'

/**
 * Выдача скрапера маркетплейса — из общего каталога товаров песочницы.
 *
 * Форму строки задаёт автор актора: схема полей датасета или пример в readme.
 * Но форма — это ещё не проверка. Пока любой запрос возвращает один и тот же
 * товар из примера, конвейер сбора конкурентов проверяется целиком, а ценовая
 * логика — нет: iPhone за 29 514 ₽ как конкурент коврика для йоги за 10 125 ₽
 * не даёт ни коридора цен, ни медианы, ни отклонения от неё.
 *
 * Поэтому значения товарных полей берутся из того же каталога, из которого
 * отвечают моки Wildberries и Ozon: «кофе в зёрнах» находит кофе, «коврик для
 * йоги» — коврики, и цены внутри выдачи одного порядка. Тот же каталог, те же
 * артикулы — значит собранный конкурент сходится с товаром, который отдаёт мок
 * маркетплейса, а не живёт в своей вселенной.
 *
 * Что НЕ подменяется: поля, которых в каталоге нет (ИНН продавца, штрихкод
 * склада, идентификаторы внутренних сущностей актора). Там остаётся значение
 * автора: подставить туда своё значило бы выдумать данные, а не пересобрать
 * известные.
 */

/** Сколько товаров каталога перебирать. Средний объём — 300 артикулов. */
const SALT = 'medium'

/** Поля входа, в которых акторы держат поисковую фразу. */
const QUERY_FIELDS = [
  'queries', 'query', 'search', 'searchQueries', 'keywords', 'keyword',
  'searchTerms', 'terms', 'productNames',
]

/**
 * Слова запроса.
 *
 * Короткие слова отбрасываются: «в», «на», «для» есть в половине названий
 * каталога и превращают ранжирование в шум.
 */
function queryTerms(input: Record<string, unknown>): string[] {
  const raw: string[] = []
  for (const field of QUERY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string') raw.push(value)
    else if (Array.isArray(value)) raw.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  return raw
    .join(' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
}

/** Насколько товар отвечает запросу: сколько слов запроса встретилось в его описании. */
function relevance(product: Product, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const haystack =
    `${product.title} ${product.subjectName} ${product.category} ${product.brand}`.toLowerCase()
  return terms.filter((term) => haystack.includes(term)).length
}

export interface CatalogSelection {
  readonly products: readonly Product[]
  /** Нашлось ли в каталоге песочницы хоть что-то по фразе запроса. */
  readonly matched: boolean
}

/**
 * Товары под запрос: сначала подходящие, потом остальные.
 *
 * Остальные добираются намеренно. Актор, у которого попросили пятьдесят строк
 * по узкой фразе, в бою вернёт пятьдесят — пусть и уходя от неё всё дальше;
 * оборвать выдачу на восьми означало бы проверить пагинацию клиента не на том,
 * на чём она ломается.
 */
export function selectProducts(
  input: Record<string, unknown>,
  count: number,
  seed: string,
): CatalogSelection {
  const terms = queryTerms(input)
  const det = new Deterministic(`catalog|${seed}`)
  const scored = productPool(SALT).map((product) => ({
    product,
    score: relevance(product, terms),
    // Тай-брейк детерминирован: без него выдача — всегда начало каталога,
    // и два разных запроса по одной категории дают буквально один список.
    shuffle: det.int(`order|${product.nmId}`, 0, 1_000_000),
  }))
  scored.sort((a, b) => b.score - a.score || a.shuffle - b.shuffle)
  return {
    products: scored.slice(0, count).map((x) => x.product),
    matched: (scored[0]?.score ?? 0) > 0,
  }
}

/**
 * Нормализованное имя поля: `price_sale`, `priceSale` и `PriceSale` — одно и то же.
 *
 * Технический хвост отбрасывается. Акторы часто отдают одно и то же значение
 * дважды — строкой и числом (`price` и `priceDecimal`, `reviewCount` и
 * `reviewCountDecimal`), и если подменить только первое, строка выдачи начнёт
 * противоречить сама себе: цена 17 299 рядом с ценой 62 334.
 */
function normalize(name: string): string {
  const flat = name.toLowerCase().replace(/[^a-zа-я0-9]/gi, '')
  return flat.replace(/(decimal|value|amount|raw|number|int|float|str|string)$/, '') || flat
}

/**
 * Что подставить в поле с таким именем.
 *
 * Имена собраны по живым акторам маркетплейсов: у каждого своё название для
 * цены со скидкой и для остатка, и попытка угадать одно каноничное имя оставила
 * бы половину полей примера нетронутой.
 */
const FIELD_VALUE: Record<string, (p: Product, det: Deterministic) => unknown> = {
  // Названия и описания.
  name: (p) => p.title,
  title: (p) => p.title,
  productname: (p) => p.title,
  producttitle: (p) => p.title,
  fulltitle: (p) => p.title,
  description: (p) => p.description,
  brand: (p) => p.brand,
  brandname: (p) => p.brand,
  category: (p) => p.category,
  categoryname: (p) => p.category,
  subject: (p) => p.subjectName,
  subjectname: (p) => p.subjectName,
  // Идентификаторы.
  productid: (p) => p.nmId,
  nmid: (p) => p.nmId,
  nmidnumber: (p) => p.nmId,
  sku: (p) => p.nmId,
  article: (p) => p.nmId,
  articul: (p) => p.nmId,
  imtid: (p) => p.imtId,
  vendorcode: (p) => p.vendorCode,
  barcode: (p) => p.barcode,
  // Деньги. `price` у скраперов — та цена, что видит покупатель, то есть уже
  // со скидкой; цена до скидки живёт под именем old/original/basic. Перепутать
  // их значит выдать скидку нулём там, где она есть.
  price: (p) => p.discountedPrice,
  pricebasic: (p) => p.price,
  basicprice: (p) => p.price,
  oldprice: (p) => p.price,
  listprice: (p) => p.price,
  priceoriginal: (p) => p.price,
  originalprice: (p) => p.price,
  pricesale: (p) => p.discountedPrice,
  saleprice: (p) => p.discountedPrice,
  finalprice: (p) => p.discountedPrice,
  currentprice: (p) => p.discountedPrice,
  discountedprice: (p) => p.discountedPrice,
  pricewithdiscount: (p) => p.discountedPrice,
  discount: (p) => p.discountPercent,
  discountpercent: (p) => p.discountPercent,
  discountpercentage: (p) => p.discountPercent,
  // Витринные показатели.
  rating: (p) => p.rating,
  ratingvalue: (p) => p.rating,
  reviewrating: (p) => p.rating,
  averagerating: (p) => p.rating,
  reviewscount: (p, det) => det.int(`reviews|${p.nmId}`, 3, 4_000),
  reviewcount: (p, det) => det.int(`reviews|${p.nmId}`, 3, 4_000),
  feedbacks: (p, det) => det.int(`reviews|${p.nmId}`, 3, 4_000),
  feedbackcount: (p, det) => det.int(`reviews|${p.nmId}`, 3, 4_000),
  // Склад.
  stock: (p) => p.stock,
  stocktotal: (p) => p.stock,
  quantity: (p) => p.stock,
  totalquantity: (p) => p.stock,
  instock: (p) => p.stock > 0,
  available: (p) => p.stock > 0,
  // Продавец. Своего продавца в каталоге нет — берём бренд: у большинства
  // артикулов песочницы бренд и продавец совпадают, как у живого продавца WB.
  suppliername: (p) => p.brand,
  sellername: (p) => p.brand,
  seller: (p) => p.brand,
  shopname: (p) => p.brand,
  merchantname: (p) => p.brand,
}

/** Поля, которые распознаются как товарные, — по ним и решается, накладывать ли каталог. */
export function looksLikeProductRow(row: Record<string, unknown>): boolean {
  const known = Object.keys(row).filter((key) => FIELD_VALUE[normalize(key)] !== undefined)
  // Одного совпадения мало: поле `name` есть и у профиля в соцсети. Цена или
  // артикул рядом с названием — уже карточка товара.
  return known.length >= 3
}

/**
 * Ссылка на карточку: адрес из примера автора, но на товар песочницы.
 *
 * Домен и форма пути — авторские, они говорят, какую площадку актор скрапит.
 * Заменяется то, что называет конкретный товар: числовой сегмент и слаг.
 * Слаг важен не меньше номера — `/product/apple-smartfon-iphone-15-.../`
 * поверх коврика для йоги читается как настоящая ссылка на айфон, и агент,
 * который берёт название из адреса, соберёт чужой товар.
 */
function rewriteUrl(value: string, product: Product): string {
  if (!/^https?:\/\//i.test(value)) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  const slug = product.vendorCode.toLowerCase()
  url.pathname = url.pathname
    .split('/')
    .map((segment) => {
      if (/^\d{6,}$/.test(segment)) return String(product.nmId)
      if (/\d{6,}/.test(segment)) return `${slug}-${product.nmId}`
      return segment
    })
    .join('/')
  for (const [key, param] of [...url.searchParams]) {
    if (/^\d{6,}$/.test(param)) url.searchParams.set(key, String(product.nmId))
  }
  return url.toString()
}

/** Приводит подставляемое значение к типу того, что стояло в примере автора. */
function coerce(value: unknown, sample: unknown): unknown {
  if (typeof sample === 'string' && typeof value !== 'string') return String(value)
  if (typeof sample === 'number' && typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  return value
}

/**
 * Строка выдачи: форма автора, значения — из каталога песочницы.
 *
 * Обходится только верхний уровень. Вложенные объекты у акторов — это блоки
 * характеристик и вариантов размеров, у каталога такого разреза нет, и
 * переписывать их наугад значило бы портить пример автора без выигрыша.
 */
export function applyProduct(
  row: Record<string, unknown>,
  product: Product,
  det: Deterministic,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, sample] of Object.entries(row)) {
    const build = FIELD_VALUE[normalize(key)]
    if (build) {
      out[key] = coerce(build(product, det), sample)
      continue
    }
    if (typeof sample === 'string' && /url|link/i.test(key)) {
      out[key] = rewriteUrl(sample, product)
      continue
    }
    out[key] = sample
  }
  return out
}
