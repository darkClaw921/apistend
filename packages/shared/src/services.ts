/**
 * Профили трёх демо-сервисов.
 *
 * Значения не выдуманы: сняты с официальной документации и живых ответов боевых API
 * (см. план проекта, раздел «Что изменило постановку задачи»). Профиль — единственное место,
 * где живут отличия сервисов друг от друга: конверт ошибки, схема лимитов, политика доставки
 * событий. Резолвер моков и диспетчер вебхуков не знают про сервисы ничего, кроме профиля.
 */

export const SERVICE_CODES = ['bitrix24', 'ozon', 'wildberries'] as const
export type ServiceCode = (typeof SERVICE_CODES)[number]

export function isServiceCode(v: unknown): v is ServiceCode {
  return typeof v === 'string' && (SERVICE_CODES as readonly string[]).includes(v)
}

/** Сценарий ответа, переключается заголовком X-Mock-Scenario. */
export const SCENARIOS = ['success', 'invalid_token', 'not_found', 'rate_limit', 'server_error', 'timeout'] as const
export type Scenario = (typeof SCENARIOS)[number]

/** Готовность мока — колонка «Мок» на экране «Каталог API». */
export const READINESS = ['ready', 'updating', 'planned'] as const
export type Readiness = (typeof READINESS)[number]

/** Откуда взят ответ. Уходит в заголовок X-APIStend-Source. */
export const RESPONSE_SOURCES = ['example', 'schema', 'generic'] as const
export type ResponseSource = (typeof RESPONSE_SOURCES)[number]

/** Как метод попал в каталог. Нужен, чтобы не выдавать снимок за живую спеку. */
export const EXTRACTION_KINDS = ['spec', 'mirror', 'parsed'] as const
export type ExtractionKind = (typeof EXTRACTION_KINDS)[number]

export interface RateLimitProfile {
  /** Сколько запросов в окне. */
  readonly limit: number
  /** Длина окна в миллисекундах. */
  readonly windowMs: number
  /**
   * Ёмкость бакета: сколько запросов подряд сервис пропускает сверх ровной скорости.
   *
   * У Bitrix24 это документированные 50 при средних двух запросах в секунду.
   * Без бакета мок оказывается в двадцать пять раз строже боевого портала:
   * приложение, которое при старте делает app.info, profile и placement.bind,
   * получало бы 503 на третьем вызове там, где бой отвечает спокойно.
   */
  readonly burst: number
  /** HTTP-код при превышении. У Bitrix24 это 503, а не 429 — частая ошибка. */
  readonly statusCode: number
  /** Отдаётся ли Retry-After. */
  readonly retryAfterSeconds: number | null
  /** Человекочитаемое описание для карточки метода. */
  readonly description: string
}

export interface WebhookProfile {
  readonly contentType: 'application/json' | 'application/x-www-form-urlencoded'
  /** Сколько секунд ждём ответ получателя. */
  readonly timeoutMs: number
  /**
   * Задержки перед повторными попытками, в миллисекундах.
   * Пустой массив означает «повторов нет» — так ведёт себя боевой Bitrix24.
   */
  readonly retryDelaysMs: readonly number[]
  /** Успех — это только 2xx, или ещё и содержимое тела. */
  readonly successRule: 'status_2xx' | 'status_200' | 'status_200_and_body'
  /** Тело, которое обязан вернуть получатель. Проверяется при successRule = status_200_and_body. */
  readonly expectedResponseBody: Record<string, unknown> | null
  /** Как подписывается доставка. */
  readonly signature: 'none' | 'application_token' | 'hmac_sha256'
  /** Заголовок с подписью, если она есть. */
  readonly signatureHeader: string | null
  /** Сколько событий сервис кладёт в один запрос при разборе накопившейся очереди. */
  readonly maxBatchSize: number
  /** Ставится ли подписка на паузу после серии неудач. */
  readonly suspendsAfterFailures: boolean
  readonly notes: string
}

/**
 * Заголовки ответа боевого сервиса.
 *
 * Обещание продукта — «поменял базовый адрес, и всё работает» — держится не только
 * на теле ответа: клиентские библиотеки читают заголовки. Поэтому набор заголовков
 * тоже принадлежит профилю сервиса, а не шлюзу: у каждого сервиса он свой,
 * и лишний чужой заголовок так же неверен, как отсутствующий свой.
 *
 * В этой структуре только то, что подтверждено документацией или живыми ответами.
 * Ничего не додумываем: заголовок, которого в бою нет, учит клиента неправде
 * ровно так же, как выдуманное поле в теле.
 */
export interface NativeHeadersProfile {
  /**
   * Content-Type успешного ответа — дословно, вместе с наличием или отсутствием charset.
   * Битрикс24 отдаёт `; charset=utf-8`, Ozon и WB — голый application/json.
   */
  readonly contentType: string
  /** Имя заголовка с идентификатором запроса. null — сервис его не отдаёт вовсе. */
  readonly requestIdHeader: string | null
  /**
   * Как выглядит этот идентификатор в бою. Формат важен: он попадает и в тело
   * ошибки (у WB поле requestId прямо названо дубликатом заголовка X-Request-Id),
   * и в тикеты поддержки, и в регулярные выражения чужих парсеров.
   */
  readonly requestIdFormat: 'hex32' | 'hex16' | null
  /**
   * Отдаёт ли сервис X-Ratelimit-* на КАЖДОМ ответе.
   *
   * Документированы они только у Wildberries. У Битрикс24 остаток лимита живёт
   * в теле, в конверте `time` (`operating`, `operating_reset_at`), а заголовков нет:
   * шлюз, приписывающий их, учит клиента читать то, чего в бою не будет.
   */
  readonly rateLimitHeaders: boolean
  /** Имя заголовка с паузой до повторной попытки при превышении лимита. */
  readonly retryHeader: string | null
}

export interface ServiceProfile {
  readonly code: ServiceCode
  readonly title: string
  /** Короткая метка для квадрата логотипа: B / O / W. */
  readonly letter: string
  /** Двухбуквенный чип в таблице ключей: B24 / OZ / WB. */
  readonly shortCode: string
  readonly apiVersion: string
  /** Боевой адрес, который подменяет пользователь. */
  readonly replacesUrl: string
  /**
   * Префикс пути мока для подстановки вместо боевого адреса.
   * Поддомены с именами сервисов сознательно не используются: ГК РФ ст. 1484 п. 2 пп. 5
   * называет доменное имя способом использования товарного знака.
   */
  readonly mountPath: string
  /** Токен цвета сервиса. Используется только как маркер: точка, буква логотипа. */
  readonly brandToken: `brand-${string}`
  readonly rateLimit: RateLimitProfile
  /** Заголовки ответа, как их отдаёт боевой сервис. */
  readonly native: NativeHeadersProfile
  readonly webhook: WebhookProfile
  /**
   * Значим ли HTTP-глагол при поиске метода.
   *
   * У Bitrix24 имя метода лежит в ПУТИ, а глагол не несёт смысла: один и тот же
   * crm.deal.add документация разрешает вызывать и GET с query-параметрами,
   * и POST с JSON, и POST form-urlencoded, и multipart. Мок обязан вести себя так же,
   * иначе рабочая интеграция на GET получит 404 там, где боевой портал отвечает.
   */
  readonly routing: 'method-and-path' | 'path-only'
  /** Где клиентская библиотека сервиса передаёт ключ. Шлюз обязан принять все варианты. */
  readonly nativeAuth: {
    readonly kind: 'path' | 'headers' | 'header'
    readonly headers?: readonly string[]
    readonly description: string
  }
}

export const SERVICE_PROFILES: Readonly<Record<ServiceCode, ServiceProfile>> = {
  bitrix24: {
    code: 'bitrix24',
    title: 'Bitrix24',
    letter: 'B',
    shortCode: 'B24',
    apiVersion: 'REST API v1',
    replacesUrl: '<portal>.bitrix24.ru/rest/',
    mountPath: '/b24',
    brandToken: 'brand-bitrix',
    rateLimit: {
      // Документировано: leaky bucket, ~2 запроса в секунду, бакет 50.
      // Ответ при превышении — 503 QUERY_LIMIT_EXCEEDED, НЕ 429.
      limit: 2,
      windowMs: 1_000,
      burst: 50,
      statusCode: 503,
      retryAfterSeconds: null,
      description: 'Около 2 запросов в секунду, бакет 50. При превышении — 503 QUERY_LIMIT_EXCEEDED',
    },
    native: {
      contentType: 'application/json; charset=utf-8',
      // Портал не отдаёт идентификатора запроса в заголовке: в документации его нет,
      // а в тикеты поддержки клиенты приносят конверт time из тела.
      requestIdHeader: null,
      requestIdFormat: null,
      // Заголовков лимита у Битрикс24 нет вовсе — про остаток ресурса клиент узнаёт
      // из полей time.operating и time.operating_reset_at, документация лимитов
      // прямо предписывает ориентироваться на них.
      rateLimitHeaders: false,
      retryHeader: null,
    },
    webhook: {
      contentType: 'application/x-www-form-urlencoded',
      timeoutMs: 30_000,
      // Дословно из документации: «Повторных отправок нет. Если ваш сервер не ответил
      // или вернул ошибку, сервер очередей Битрикс24 зафиксирует сбой, но не отправит
      // событие повторно». Вместо повторов — адаптивный троттлинг очереди.
      retryDelaysMs: [],
      successRule: 'status_2xx',
      expectedResponseBody: null,
      signature: 'application_token',
      signatureHeader: null,
      maxBatchSize: 1,
      suspendsAfterFailures: false,
      notes:
        'Событие несёт только идентификатор (data[FIELDS][ID]) — значения полей не передаются, ' +
        'клиент обязан дёрнуть crm.deal.get. Тело — form-urlencoded, не JSON. Повторов нет.',
    },
    routing: 'path-only',
    nativeAuth: {
      kind: 'path',
      description: 'Ключ в пути входящего вебхука /rest/{user_id}/{code}/{method}.json либо параметр auth=',
    },
  },

  ozon: {
    code: 'ozon',
    title: 'Ozon Seller API',
    letter: 'O',
    shortCode: 'OZ',
    apiVersion: 'Seller API v3',
    replacesUrl: 'api-seller.ozon.ru',
    mountPath: '/oz',
    brandToken: 'brand-ozon',
    rateLimit: {
      limit: 50,
      windowMs: 1_000,
      burst: 50,
      statusCode: 429,
      retryAfterSeconds: 1,
      description: 'Около 50 запросов в секунду на аккаунт продавца',
    },
    native: {
      contentType: 'application/json',
      // x-o3-trace-id — сквозной идентификатор платформы O3: он описан в OpenAPI
      // самого Ozon (Performance API, заголовки ответа) и приходит в живых ответах.
      requestIdHeader: 'x-o3-trace-id',
      requestIdFormat: 'hex16',
      // Ozon документирует сам лимит (около 50 запросов в секунду), но не заголовки
      // с остатком, и в ответах их нет. Приписывать их — учить клиента читать пустоту.
      rateLimitHeaders: false,
      retryHeader: null,
    },
    webhook: {
      contentType: 'application/json',
      // Обработка дольше 5 секунд — одно из условий автоматической приостановки уведомлений.
      timeoutMs: 5_000,
      // «Через несколько секунд система повторит запрос несколько раз. Интервал постепенно
      // увеличивается. Когда интервал достигает максимума в 10 минут, делается ещё 5 попыток
      // с интервалом 10 минут». Ниже — эта лестница в явном виде.
      retryDelaysMs: [
        5_000, 15_000, 60_000, 300_000, 600_000,
        600_000, 600_000, 600_000, 600_000, 600_000,
      ],
      successRule: 'status_200_and_body',
      expectedResponseBody: { result: true },
      signature: 'none',
      signatureHeader: null,
      maxBatchSize: 1,
      suspendsAfterFailures: true,
      notes:
        'Успехом считается 200 И тело {"result": true}. Только кода 200 недостаточно. ' +
        'На проверочный TYPE_PING ответ обязан содержать version, name и time. ' +
        'Подписка автоматически ставится на паузу и возобновляется только вручную.',
    },
    routing: 'method-and-path',
    nativeAuth: {
      kind: 'headers',
      headers: ['Client-Id', 'Api-Key'],
      description: 'Заголовки Client-Id и Api-Key',
    },
  },

  wildberries: {
    code: 'wildberries',
    title: 'Wildberries',
    letter: 'W',
    shortCode: 'WB',
    apiVersion: 'Suppliers API v3',
    replacesUrl: 'suppliers-api.wildberries.ru',
    mountPath: '/wb',
    brandToken: 'brand-wb',
    rateLimit: {
      limit: 300,
      windowMs: 60_000,
      burst: 300,
      statusCode: 429,
      retryAfterSeconds: 20,
      description: 'До 300 запросов в минуту (Маркетплейс, персональный токен), заголовки X-Ratelimit-*',
    },
    native: {
      contentType: 'application/json',
      // Спецификация WB прямо называет поле requestId в теле ошибки дубликатом
      // заголовка X-Request-Id, а пример значения — 32 шестнадцатеричных знака.
      requestIdHeader: 'x-request-id',
      requestIdFormat: 'hex32',
      // Единственный из трёх, кто документирует X-Ratelimit-Limit / -Remaining /
      // -Reset и отдаёт их на каждом ответе.
      rateLimitHeaders: true,
      retryHeader: 'x-ratelimit-retry',
    },
    webhook: {
      contentType: 'application/json',
      // «Ваш сервис должен вернуть статус доставки 200 в течение 10 секунд».
      timeoutMs: 10_000,
      // «Попытки доставки будут повторяться с нарастающим интервалом от 10 секунд
      // до 15 минут, после чего событие будет удалено».
      retryDelaysMs: [10_000, 30_000, 120_000, 450_000, 900_000],
      successRule: 'status_200',
      expectedResponseBody: null,
      signature: 'hmac_sha256',
      signatureHeader: 'X-Hub-Signature',
      // «Один запрос может содержать несколько событий... Максимум 100 событий в одном запросе».
      maxBatchSize: 100,
      suspendsAfterFailures: true,
      notes:
        'События приходят конвертом {sellerId, requestId, events[]}. После простоя накопленные ' +
        'события приезжают пачкой до 100 штук в одном запросе, а не отдельными POST. ' +
        'Дедупликация — по idempotencyKey каждого события.',
    },
    routing: 'method-and-path',
    nativeAuth: {
      kind: 'header',
      headers: ['Authorization'],
      description: 'Заголовок Authorization с токеном, без префикса Bearer',
    },
  },
} as const

export const SERVICE_LIST: readonly ServiceProfile[] = SERVICE_CODES.map((c) => SERVICE_PROFILES[c])

/** Разбирает путь вида /wb/api/v3/orders в код сервиса и остаток пути. */
export function matchMountPath(pathname: string): { service: ServiceCode; rest: string } | null {
  for (const profile of SERVICE_LIST) {
    const p = profile.mountPath
    if (pathname === p) return { service: profile.code, rest: '/' }
    if (pathname.startsWith(`${p}/`)) return { service: profile.code, rest: pathname.slice(p.length) }
  }
  return null
}
