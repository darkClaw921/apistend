import {
  Deterministic, competitorMarket, competitorsFor, productPool, type Competitor, type Product,
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
const QUERY_FIELDS = new Set([
  'queries', 'query', 'search', 'searchqueries', 'keywords', 'keyword',
  'searchterms', 'terms', 'productnames',
])

/**
 * Поля входа, в которых акторы держат прямой адрес конкурента: артикул или
 * ссылку на его карточку — а не поисковую фразу.
 *
 * `startUrls` у скраперов маркетплейсов почти всегда `requestListSources`:
 * массив `{ url }`, а не голых строк, поэтому строки внутри разбираются обеими
 * формами. Раньше эти поля не читались вовсе, и запрос «собери вот эти ссылки
 * конкурентов» отрабатывал как «страница каталога без фильтра» — выдавал
 * произвольные товары песочницы вместо адресованных.
 */
const URL_FIELDS = new Set(['starturls', 'urls', 'directurls', 'producturls', 'links', 'urllist', 'requesturls'])
const ID_FIELDS = new Set(['productids', 'productid', 'nmids', 'nmid', 'skus', 'sku', 'articuls', 'articul'])

/**
 * Значения полей входа по нормализованному имени ключа.
 *
 * Имена полей у акторов пишутся то `startUrls`, то `start_urls`, то
 * `START_URLS` — то же расхождение написаний, что и у окна дат с адресацией
 * карточки. Сравнивать с нормализованным множеством имён и не глядеть на
 * то, как именно автор расставил регистр и подчёркивания.
 */
function byNormalizedKey(input: Record<string, unknown>, names: ReadonlySet<string>): unknown[] {
  const found: unknown[] = []
  for (const [key, value] of Object.entries(input)) {
    if (names.has(normalize(key))) found.push(value)
  }
  return found
}

/**
 * Слова запроса.
 *
 * Короткие слова отбрасываются: «в», «на», «для» есть в половине названий
 * каталога и превращают ранжирование в шум. Ссылка без цифрового артикула
 * (категория, поиск) тоже даёт слова: сегменты её пути читаются так же, как
 * текст поисковой фразы, — `/catalog/smartfony-i-telefony` находит рынок
 * смартфонов не хуже, чем строка `queries: ["смартфоны"]`.
 */
function queryTerms(input: Record<string, unknown>): string[] {
  const raw: string[] = []
  for (const value of byNormalizedKey(input, QUERY_FIELDS)) {
    if (typeof value === 'string') raw.push(value)
    else if (Array.isArray(value)) raw.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  for (const value of byNormalizedKey(input, URL_FIELDS)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const url = requestUrl(entry)
      // Ссылка на конкретный товар обрабатывается адресно (см. directIds) —
      // её слова в поиск не идут, чтобы не размывать точный запрос.
      if (url && !/\d{6,}/.test(url)) raw.push(url.replace(/^https?:\/\/[^/]+/i, ''))
    }
  }
  return raw
    .join(' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
}

/** Ссылка из строки или из `{ url }` — `requestListSources` держит именно вторую форму. */
function requestUrl(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const url = (entry as Record<string, unknown>).url
    if (typeof url === 'string') return url
  }
  return null
}

/**
 * Конкретные конкуренты, которых назвал клиент: по артикулу или по ссылке
 * на карточку. Возвращается пусто, если адрес не назван, — тогда в дело идёт
 * поиск по фразе.
 */
function directIds(input: Record<string, unknown>): number[] {
  const ids = new Set<number>()
  for (const value of byNormalizedKey(input, ID_FIELDS)) {
    const values = Array.isArray(value) ? value : value !== undefined ? [value] : []
    for (const raw of values) {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (Number.isFinite(n) && n > 0) ids.add(Math.trunc(n))
    }
  }
  for (const value of byNormalizedKey(input, URL_FIELDS)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const url = requestUrl(entry)
      const match = url?.match(/\d{6,}/)
      if (match) ids.add(Number(match[0]))
    }
  }
  return [...ids]
}

/**
 * Конкурент под конкретный запрошенный адрес.
 *
 * Артикул из ссылки клиента чужой каталогу песочницы — своего товара под ним
 * нет. Поэтому карточка строится вокруг СЛУЧАЙНОГО (но детерминированного по
 * этому же id) товара каталога — цена и категория остаются согласованными —
 * а идентификатор и адрес в ответе остаются ТЕМИ, что назвал клиент: он
 * запросил конкретную ссылку и обязан узнать её в ответе, а не получить
 * карточку с чужим артикулом вместо своей.
 */
function competitorForId(id: number, pool: readonly Product[], seed: string): Competitor {
  const det = new Deterministic(`direct|${seed}`)
  const base = pool[det.int(`base|${id}`, 0, pool.length - 1)]!
  const variants = competitorsFor(base, SALT)
  const picked = variants[det.int(`variant|${id}`, 0, variants.length - 1)]!
  return { ...picked, nmId: id }
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
  // Клиент назвал конкретных конкурентов — артикулом или ссылкой. Это не
  // поиск, а адрес: каждый запрошенный id должен получить СВОЮ строку в ответе,
  // а не потеряться среди случайно подобранных по фразе.
  const ids = directIds(input)
  if (ids.length > 0) {
    const pool = productPool(SALT)
    const offers = ids.map((id) => competitorForId(id, pool, seed))
    return { offers: offers.slice(0, count), matched: true }
  }

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
  description: (c) => {
    // Длина не фиксирована: она зависит от числа характеристик и остатка
    // конкретного предложения — тех же полей, что и в остальной выдаче.
    // Одинаковая длина у всех строк была тем самым дефектом, из-за которого
    // медиана по описаниям ничего не показывала.
    const base = `${c.title}. ${c.subjectName}, категория «${c.category}». Предложение продавца ${c.sellerName}.`
    const specs = c.characteristics
      .map((s) => `${s.name.toLowerCase()}: ${s.value}`)
      .join(', ')
    const stockLine = c.stock > 0 ? ` В наличии ${c.stock} шт.` : ' Товара нет в наличии.'
    return specs.length > 0 ? `${base} Характеристики: ${specs}.${stockLine}` : `${base}${stockLine}`
  },
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
  isavailable: (c) => c.stock > 0,
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

/**
 * Поля-коллекции: фото, видео, характеристики, история цены.
 *
 * У `FIELD_VALUE` builder получает только конкурента — правильно для плоского
 * значения, но не для массива: сколько фото и что внутри каждого зависит ещё
 * и от того, как автор actor'а показал поле в своём примере (строкой, объектом
 * с { url, type, width, height }, вложенным `{ items: [...] }`). Здесь builder
 * получает ещё и `sample` — форму, которую показал автор, — и подгоняет под
 * неё СВОЁ содержимое, а не структуру примера под своё.
 *
 * Без этого разбора поле оставалось нетронутым (ветка `out[key] = sample` в
 * applyOffer) — отсюда и жалоба «ровно одно фото, две характеристики у всех»:
 * автор показал в readme одну карточку с одним фото, и она же копировалась
 * в каждую строку выдачи.
 */
const SHAPE_FIELD_VALUE: Record<string, (c: Competitor, sample: unknown) => unknown> = {
  images: (c, sample) => shapeList(sample, c.images),
  image: (c, sample) => shapeList(sample, c.images),
  imageurls: (c, sample) => shapeList(sample, c.images),
  imageurl: (c) => c.images[0] ?? null,
  photos: (c, sample) => shapeList(sample, c.images),
  photo: (c, sample) => shapeList(sample, c.images),
  gallery: (c, sample) => shapeList(sample, c.images),
  media: (c, sample) => shapeList(sample, c.images),
  picturelinks: (c, sample) => shapeList(sample, c.images),
  pictures: (c, sample) => shapeList(sample, c.images),
  descriptionimages: (c, sample) => shapeList(sample, c.images),
  descriptionimagelinks: (c, sample) => shapeList(sample, c.images),
  coverimageurl: (c) => c.images[0] ?? null,
  mainimage: (c) => c.images[0] ?? null,

  video: (c, sample) => shapeVideo(sample, c.video),
  videos: (c, sample) => shapeVideo(sample, c.video),
  productvideo: (c, sample) => shapeVideo(sample, c.video),
  videourl: (c) => c.video?.url ?? null,
  mediavideo: (c, sample) => shapeVideo(sample, c.video),
  descriptionvideos: (c, sample) => shapeVideo(sample, c.video),

  characteristics: (c, sample) => shapeCharacteristics(sample, c.characteristics),
  shortcharacteristics: (c, sample) => shapeCharacteristics(sample, c.characteristics),
  attributes: (c, sample) => shapeCharacteristics(sample, c.characteristics),
  specs: (c, sample) => shapeCharacteristics(sample, c.characteristics),
  specifications: (c, sample) => shapeCharacteristics(sample, c.characteristics),
  params: (c, sample) => shapeCharacteristics(sample, c.characteristics),
  characteristicscount: (c) => c.characteristics.length,

  pricehistory: (c, sample) => (Array.isArray(sample) ? c.priceHistory : sample),
}

/** Список строк или объектов — форму объекта задаёт первый элемент примера. */
function shapeList(sample: unknown, values: readonly string[]): unknown {
  if (!Array.isArray(sample)) return values[0] ?? null
  const template = sample[0]
  if (template !== null && typeof template === 'object') {
    // Пример — массив объектов вроде { url, alt }: url заменяем, остальное
    // (тип, размеры) оставляем таким, каким его показал автор.
    return values.map((url) => ({ ...(template as Record<string, unknown>), url }))
  }
  return values
}

/** Видео: форма произвольная — массив объектов, объект или голая ссылка. */
function shapeVideo(
  sample: unknown,
  video: Competitor['video'],
): unknown {
  if (Array.isArray(sample)) {
    if (!video) return []
    const template = sample[0]
    return [template !== null && typeof template === 'object' ? { ...(template as object), ...video } : video.url]
  }
  if (sample !== null && typeof sample === 'object') {
    return video ? { ...(sample as object), ...video } : null
  }
  return video?.url ?? null
}

/** Характеристики: пары `{ name, value }` — именами полей автора, значениями своими. */
function shapeCharacteristics(
  sample: unknown,
  pairs: Competitor['characteristics'],
): unknown {
  if (!Array.isArray(sample)) return pairs.length
  const template = (sample[0] ?? { name: 'name', value: 'value' }) as Record<string, unknown>
  const [nameKey, valueKey] = Object.keys(template)
  if (!nameKey || !valueKey) return pairs
  return pairs.map((pair) => ({ [nameKey]: pair.name, [valueKey]: pair.value }))
}

/**
 * Поля, которые сами по себе значат «это карточка товара»: цена, скидка,
 * артикул, рейтинг с числом отзывов, продавец. У профиля в соцсети, поста
 * или точки на карте таких не бывает вместе.
 *
 * Остальные распознанные поля — `name`, `category`, `images`, `video` —
 * весят меньше: они встречаются и у совсем других сущностей (имя есть у
 * профиля, фото — у поста), и набора из одних них достаточно, чтобы
 * инстаграм-пост с полем `images` и профиль с полем `fullName` в одной
 * закорючке датасета накопили порог «это товар» на пустом месте.
 */
const STRONG_KEYS = new Set([
  'price', 'pricebasic', 'basicprice', 'oldprice', 'listprice', 'priceoriginal', 'originalprice',
  'pricesale', 'saleprice', 'finalprice', 'currentprice', 'discountedprice', 'pricewithdiscount',
  'discount', 'discountpercent', 'discountpercentage',
  'productid', 'nmid', 'nm', 'sku', 'article', 'articul',
  'rating', 'ratingvalue', 'reviewrating', 'averagerating',
  'reviewscount', 'reviewcount', 'feedbacks', 'feedbackcount',
  'suppliername', 'sellername', 'seller', 'shopname', 'merchantname',
  'supplierid', 'sellerid', 'shopid', 'merchantid',
  'supplierrating', 'sellerrating', 'shoprating',
  'inn', 'taxid', 'ogrn', 'ogrnip',
])

/** Сколько полей строки распознаются как товарные — мера того, насколько это карточка. */
function knownFieldCount(row: Record<string, unknown>): number {
  return Object.keys(row).filter(
    (key) => FIELD_VALUE[normalize(key)] !== undefined || SHAPE_FIELD_VALUE[normalize(key)] !== undefined,
  ).length
}

/** Поля, которые распознаются как товарные, — по ним и решается, накладывать ли каталог. */
export function looksLikeProductRow(row: Record<string, unknown>): boolean {
  const strong = Object.keys(row).filter((key) => STRONG_KEYS.has(normalize(key))).length
  // Слабых совпадений мало, даже трёх: поле `name` есть и у профиля в
  // соцсети. Хотя бы два сильных признака — цена, артикул, рейтинг с
  // отзывами, продавец — надёжно отличают карточку товара от чего угодно.
  return strong >= 2 && knownFieldCount(row) >= 3
}

/** Название поля, которым автор помечает разные сущности одного датасета. */
const DISCRIMINANT_KEYS = new Set(['rowtype', 'type', 'kind', 'recordtype', 'entitytype', 'resulttype'])

/**
 * Сшивает примеры автора в одну форму карточки товара.
 *
 * Readme показывает не всегда одну карточку целиком, а несколько кусков —
 * «вот блок с видео», «вот статус недоступного товара», «вот сама карточка
 * со всеми полями». Взять только лучший из них значит потерять поля, которых
 * в НЁМ не было: ровно так пропадало поле видео, показанное отдельным
 * примером, — оно есть у актора, просто не в том куске, что выбрал .find().
 *
 * Смешивать можно не всегда. Если у датасета несколько РАЗНЫХ сущностей —
 * товар, отзыв, продавец, — это обычно видно по полю-дискриминанту вроде
 * `rowType`, и оно стоит хотя бы у ОДНОГО примера набора: у профиля Instagram
 * дискриминанта нет, но он есть у постов того же актора, и этого достаточно,
 * чтобы понять — примеры описывают разные сущности, а не разные грани одной.
 * Тогда сшивать нельзя вовсе: слияние поста и профиля тремя-четырьмя общими
 * словами вроде `name`/`fullName` набрало бы порог «это карточка товара» на
 * пустом месте — ровно так `apify/instagram-scraper` чуть не обзавёлся ценой.
 * Годится это правило лишь при полном отсутствии дискриминанта у ВСЕХ
 * примеров сразу: тогда куски readme — грани одного и того же объекта.
 */
export function mergeProductExamples(
  examples: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  if (examples.length === 0) return null
  const scored = examples
    .map((row) => ({ row, score: knownFieldCount(row) }))
    .sort((a, b) => b.score - a.score)
  const anchor = scored[0]!
  if (anchor.score === 0) return null

  const heterogeneous = examples.some((row) =>
    Object.keys(row).some((key) => DISCRIMINANT_KEYS.has(normalize(key))))
  if (heterogeneous) return anchor.row

  const merged: Record<string, unknown> = { ...anchor.row }
  for (const { row } of scored.slice(1)) {
    for (const [key, value] of Object.entries(row)) {
      if (!(key in merged)) merged[key] = value
    }
  }
  return merged
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
    const norm = normalize(key)
    const shapeBuild = SHAPE_FIELD_VALUE[norm]
    if (shapeBuild) {
      out[key] = shapeBuild(offer, sample)
      continue
    }
    const build = FIELD_VALUE[norm]
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
