import {
  Deterministic, competitorMarket, productPool, type Competitor, type Product,
} from '@apistend/mock-engine'

/**
 * Выдача скрапера маркетплейса — рынок вокруг каталога песочницы.
 *
 * Форму строки задаёт автор актора: схема полей датасета или пример в readme.
 * Значения — рынок: чужие предложения того же предмета, что и карточка продавца.
 * За скрапером маркетплейса приходят ровно за этим — собрать КОНКУРЕНТОВ, а не
 * свои же товары, и посчитать по ним коридор цен, медиану и отклонение от неё.
 *
 * Что это даёт по сравнению с выдачей из каталога продавца:
 *
 *   • у каждой строки свой продавец, своё юрлицо, ИНН и ОГРН — выдачу можно
 *     группировать по продавцу и проверять реквизиты;
 *   • цены сгруппированы вокруг цены своей карточки: коридор осмысленный,
 *     а не «айфон против коврика»;
 *   • артикулы из чужого диапазона: собранный конкурент не окажется
 *     собственной карточкой продавца.
 *
 * Связь со своим каталогом при этом сохраняется: «кофе в зёрнах» находит рынок
 * кофе, «коврик для йоги» — рынок ковриков, и сравнивать есть с чем, потому что
 * тот же предмет отдают моки Wildberries и Ozon.
 *
 * Что НЕ подменяется: поля, которых у предложения нет (штрихкод склада,
 * внутренние идентификаторы актора). Там остаётся значение автора: подставить
 * туда своё значило бы выдумать данные, а не пересобрать известные.
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

/**
 * Насколько товар отвечает запросу.
 *
 * Совпадение в названии и предмете весит больше, чем в бренде и категории.
 * Иначе «кофе» находит чай: у чая бренд «Северный кофе», и по одному лишь
 * подсчёту вхождений он равен настоящему кофе.
 */
function relevance(product: Product, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const strong = `${product.title} ${product.subjectName}`.toLowerCase()
  const weak = `${product.category} ${product.brand}`.toLowerCase()
  return terms.reduce(
    (score, term) => score + (strong.includes(term) ? 2 : weak.includes(term) ? 1 : 0),
    0,
  )
}

export interface MarketSelection {
  /** Предложения конкурентов — то, что и отдаётся строками выдачи. */
  readonly offers: readonly Competitor[]
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
export function selectMarket(
  input: Record<string, unknown>,
  count: number,
  seed: string,
): MarketSelection {
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
  // Только то, что отвечает запросу. Добирать «ещё немного каталога» нельзя:
  // в выдаче по фразе «кофе в зёрнах» появился бы чай, и клиент посчитал бы
  // по нему свой коридор цен — а это уже не конкуренты.
  // Берём только лучших по релевантности: у предмета двенадцать предложений,
  // и десяти строк выдачи хватает рынка одной-двух карточек. Разбавлять его
  // соседними предметами значит подмешать в конкурентов чужой товар.
  const best = scored[0]?.score ?? 0
  const relevant = best > 0 ? scored.filter((x) => x.score === best) : scored
  const wanted = Math.max(2, Math.ceil(count / 6))
  const products = relevant.slice(0, wanted).map((x) => x.product)
  return {
    offers: competitorMarket(products, SALT, seed).slice(0, count),
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
const FIELD_VALUE: Record<string, (c: Competitor) => unknown> = {
  // Названия и описания.
  name: (c) => c.title,
  title: (c) => c.title,
  productname: (c) => c.title,
  producttitle: (c) => c.title,
  fulltitle: (c) => c.title,
  description: (c) => `${c.title}. ${c.subjectName}, категория «${c.category}». Предложение продавца ${c.sellerName}.`,
  brand: (c) => c.brand,
  brandname: (c) => c.brand,
  trademark: (c) => c.brand,
  category: (c) => c.category,
  categoryname: (c) => c.category,
  subject: (c) => c.subjectName,
  subjectname: (c) => c.subjectName,
  // Идентификаторы товара.
  productid: (c) => c.nmId,
  nmid: (c) => c.nmId,
  nm: (c) => c.nmId,
  sku: (c) => c.nmId,
  article: (c) => c.nmId,
  articul: (c) => c.nmId,
  // Деньги. `price` у скраперов — та цена, что видит покупатель, то есть уже
  // со скидкой; цена до скидки живёт под именем old/original/basic. Перепутать
  // их значит выдать скидку нулём там, где она есть.
  price: (c) => c.discountedPrice,
  pricebasic: (c) => c.price,
  basicprice: (c) => c.price,
  oldprice: (c) => c.price,
  listprice: (c) => c.price,
  priceoriginal: (c) => c.price,
  originalprice: (c) => c.price,
  pricesale: (c) => c.discountedPrice,
  saleprice: (c) => c.discountedPrice,
  finalprice: (c) => c.discountedPrice,
  currentprice: (c) => c.discountedPrice,
  discountedprice: (c) => c.discountedPrice,
  pricewithdiscount: (c) => c.discountedPrice,
  discount: (c) => c.discountPercent,
  discountpercent: (c) => c.discountPercent,
  discountpercentage: (c) => c.discountPercent,
  // Витринные показатели.
  rating: (c) => c.rating,
  ratingvalue: (c) => c.rating,
  reviewrating: (c) => c.rating,
  averagerating: (c) => c.rating,
  reviewscount: (c) => c.reviewsCount,
  reviewcount: (c) => c.reviewsCount,
  feedbacks: (c) => c.reviewsCount,
  feedbackcount: (c) => c.reviewsCount,
  // Склад.
  stock: (c) => c.stock,
  stocktotal: (c) => c.stock,
  quantity: (c) => c.stock,
  totalquantity: (c) => c.stock,
  instock: (c) => c.stock > 0,
  available: (c) => c.stock > 0,
  // Продавец. Ради него скрапер и запускают: конкурент — это не строка прайса,
  // а компания, у которой есть имя, реквизиты и репутация.
  suppliername: (c) => c.sellerName,
  sellername: (c) => c.sellerName,
  seller: (c) => c.sellerName,
  shopname: (c) => c.sellerName,
  merchantname: (c) => c.sellerName,
  supplierid: (c) => c.sellerId,
  sellerid: (c) => c.sellerId,
  shopid: (c) => c.sellerId,
  merchantid: (c) => c.sellerId,
  supplierrating: (c) => c.sellerRating,
  sellerrating: (c) => c.sellerRating,
  shoprating: (c) => c.sellerRating,
  fullname: (c) => c.sellerFullName,
  legalname: (c) => c.sellerFullName,
  companyname: (c) => c.sellerFullName,
  organizationname: (c) => c.sellerFullName,
  inn: (c) => c.inn,
  taxid: (c) => c.inn,
  ogrn: (c) => c.ogrn,
  ogrnip: (c) => c.ogrn,
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
function rewriteUrl(value: string, offer: Competitor): string {
  if (!/^https?:\/\//i.test(value)) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  const slug = `offer-${offer.sellerId}`
  url.pathname = url.pathname
    .split('/')
    .map((segment) => {
      if (/^\d{6,}$/.test(segment)) return String(offer.nmId)
      if (/\d{6,}/.test(segment)) return `${slug}-${offer.nmId}`
      return segment
    })
    .join('/')
  for (const [key, param] of [...url.searchParams]) {
    if (/^\d{6,}$/.test(param)) url.searchParams.set(key, String(offer.nmId))
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
export function applyOffer(
  row: Record<string, unknown>,
  offer: Competitor,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, sample] of Object.entries(row)) {
    const build = FIELD_VALUE[normalize(key)]
    if (build) {
      out[key] = coerce(build(offer), sample)
      continue
    }
    if (typeof sample === 'string' && /url|link/i.test(key)) {
      out[key] = rewriteUrl(sample, offer)
      continue
    }
    out[key] = sample
  }
  return out
}
