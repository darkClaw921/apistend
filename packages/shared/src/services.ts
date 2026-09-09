/**
 * Профили демо-сервисов.
 *
 * Значения не выдуманы: сняты с официальной документации и живых ответов боевых API
 * (см. план проекта, раздел «Что изменило постановку задачи»). Профиль — единственное место,
 * где живут отличия сервисов друг от друга: конверт ошибки, схема лимитов, политика доставки
 * событий. Резолвер моков и диспетчер вебхуков не знают про сервисы ничего, кроме профиля.
 */

export const SERVICE_CODES = ['bitrix24', 'ozon', 'wildberries', 'apify'] as const
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

/**
 * Класс лимита для части путей сервиса.
 *
 * Нужен там, где лимит — свойство не сервиса, а эндпоинта. У Apify это так:
 * живые ответы отдают `x-ratelimit-limit: 60` на /v2/store и /v2/acts/…,
 * но `90` на /v2/users/me, а документация называет ещё 200 для записей
 * key-value store и 400 для запусков и датасетов. Один общий лимит на сервис
 * означал бы, что клиент, читающий заголовок на датасете, увидит 60 вместо 400
 * и построит свой троттлинг всемеро строже боевого.
 */
export interface RateLimitClass {
  /** Короткое имя класса: идёт в ключ ведра и в документацию. */
  readonly name: string
  /**
   * Пути, к которым относится класс, — регулярным выражением, а не префиксом.
   *
   * Префикса недостаточно: у Apify `/v2/acts/{id}` живёт с базовыми 60, а
   * `/v2/acts/{id}/runs` — с четырьмястами. Разделяет их не начало пути, а хвост.
   */
  readonly pathPattern: RegExp
  /** Ёмкость и скорость этого класса — те же единицы, что у профиля. */
  readonly limit: number
  readonly windowMs: number
  readonly burst: number
  readonly description: string
}

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
  /**
   * Классы лимита по путям. Первый подошедший выигрывает, не подошёл ни один —
   * работают limit/windowMs/burst самого профиля. Пусто у сервисов с единым лимитом.
   */
  readonly classes?: readonly RateLimitClass[]
}

/**
 * Какие из заголовков лимита сервис отдаёт на самом деле.
 *
 * Раньше здесь стоял булев флаг — «отдаёт три заголовка или ни одного». Живые
 * ответы Apify показали третий вариант: `x-ratelimit-limit` есть, а `-remaining`
 * и `-reset` нет вовсе. Приписать недостающие два так же неверно, как приписать
 * все три сервису, у которого их нет: клиент напишет откат по остатку, которого
 * в бою не увидит.
 */
export type RateLimitHeaderPart = 'limit' | 'remaining' | 'reset'

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
   * Какие X-Ratelimit-* сервис отдаёт на КАЖДОМ ответе.
   *
   * Все три — только у Wildberries. У Apify живые ответы отдают один
   * `x-ratelimit-limit`, без остатка и без сброса. У Битрикс24 остаток лимита
   * живёт в теле, в конверте `time` (`operating`, `operating_reset_at`),
   * а заголовков нет вовсе; у Ozon нет и того.
   */
  readonly rateLimitHeaders: readonly RateLimitHeaderPart[]
  /** Имя заголовка с паузой до повторной попытки при превышении лимита. */
  readonly retryHeader: string | null
  /**
   * Префикс заголовков пагинации, если сервис их отдаёт.
   *
   * У Apify списковые ответы дублируют поля конверта `data` в заголовки
   * `x-apify-pagination-total|offset|count|limit|desc`, и они же перечислены
   * в его `Access-Control-Expose-Headers` — то есть это часть контракта,
   * а не украшение. Значения берутся из тела, которое мок и так отдаёт,
   * поэтому расхождения между заголовком и телом возникнуть не может.
   */
  readonly paginationHeaderPrefix: string | null
  /**
   * Разрешает ли боевой сервис обращение из браузера.
   *
   * Ozon с 16.05.2025 запрещает, WB не отдаёт CORS вовсе, Битрикс24 отдаёт только
   * порталу. Apify отвечает `access-control-allow-origin: *` — и для него пометка
   * «CORS добавлен песочницей» была бы неправдой в другую сторону.
   */
  readonly nativeCors: boolean
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
  /**
   * Исторические написания путей, которые боевой сервис принимает наравне
   * с теми, что описаны в его спецификации.
   *
   * У Apify это `/v2/acts/…`: спецификация, из которой собран каталог, знает
   * только `/v2/actors/…`, но боевой api.apify.com отвечает 200 на оба
   * написания, и `acts` — как раз то, что стоит в примерах его документации
   * и в коде его собственных клиентов. Каталог этим не раздувается: алиас
   * приводит путь к каноничному и уходит в тот же метод, а не заводит второй.
   */
  readonly pathAliases?: readonly { readonly from: RegExp; readonly to: string }[]
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
      rateLimitHeaders: [],
      retryHeader: null,
      paginationHeaderPrefix: null,
      nativeCors: false,
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
      rateLimitHeaders: [],
      retryHeader: null,
      paginationHeaderPrefix: null,
      // Запросы из браузера Ozon запрещает с 16.05.2025.
      nativeCors: false,
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
      // Единственный, кто документирует все три — X-Ratelimit-Limit / -Remaining /
      // -Reset — и отдаёт их на каждом ответе.
      rateLimitHeaders: ['limit', 'remaining', 'reset'],
      retryHeader: 'x-ratelimit-retry',
      paginationHeaderPrefix: null,
      nativeCors: false,
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

  apify: {
    code: 'apify',
    title: 'Apify API',
    letter: 'A',
    shortCode: 'APF',
    apiVersion: 'API v2',
    replacesUrl: 'api.apify.com',
    mountPath: '/apify',
    // #1672EB — токен --color-primary-action из собственной дизайн-системы Apify.
    brandToken: 'brand-apify',
    rateLimit: {
      // Базовый лимит — 60 запросов в секунду на ресурс; ровно это число приходит
      // в x-ratelimit-limit на /v2/store и на карточке актора. Глобальный потолок
      // (250 000 запросов в минуту на пользователя) в моке не воспроизводим:
      // до него не доберётся ни одна отладочная нагрузка, а ведро на него
      // означало бы держать четверть миллиона токенов ради ненаступающего события.
      limit: 60,
      windowMs: 1_000,
      burst: 60,
      statusCode: 429,
      // Паузу Apify не сообщает: заголовка Retry-After в ответах нет, а его
      // собственные клиенты (apify-client для Python и JS) отступают по своей
      // экспоненте — 500 мс, 1 с, 2 с, 4 с. Подсказывать паузу от имени сервиса,
      // который её не даёт, значит научить читать несуществующий заголовок.
      retryAfterSeconds: null,
      description:
        'До 60 запросов в секунду на ресурс; 200 для записей key-value store, ' +
        '400 для запусков и датасетов. Отдаётся только X-RateLimit-Limit',
      classes: [
        {
          name: 'runs-and-datasets',
          // Документированные 400 в секунду. Карточка самого актора сюда НЕ входит:
          // живой ответ на /v2/acts/{id} отдал x-ratelimit-limit: 60. Класс охватывает
          // ресурсы запусков и датасетов, в том числе вложенные в актора и в задачу.
          pathPattern: /^\/v2\/(actor-runs|datasets|actor-tasks\/[^/]+\/runs?|acts?\/[^/]+\/(runs?|builds)|actors\/[^/]+\/(runs?|builds))/,
          limit: 400,
          windowMs: 1_000,
          burst: 400,
          description: 'Запуски акторов, сборки и датасеты — 400 запросов в секунду',
        },
        {
          name: 'key-value-store',
          pathPattern: /^\/v2\/key-value-stores/,
          limit: 200,
          windowMs: 1_000,
          burst: 200,
          description: 'Чтение и запись записей key-value store — 200 запросов в секунду',
        },
        {
          name: 'user',
          // 90 — не из документации, а из живого ответа /v2/users/me.
          pathPattern: /^\/v2\/users/,
          limit: 90,
          windowMs: 1_000,
          burst: 90,
          description: 'Профиль пользователя — 90 запросов в секунду',
        },
      ],
    },
    native: {
      // Живой ответ: application/json; charset=utf-8 — с charset, как у Битрикс24.
      contentType: 'application/json; charset=utf-8',
      // Идентификатора запроса Apify не отдаёт: в живых ответах его нет ни под одним
      // из принятых имён, и в спецификации он не описан.
      requestIdHeader: null,
      requestIdFormat: null,
      // Только limit. Ни -remaining, ни -reset в живых ответах нет.
      rateLimitHeaders: ['limit'],
      retryHeader: null,
      // Списковые ответы дублируют конверт data в x-apify-pagination-*, и сам Apify
      // перечисляет эти пять заголовков в своём Access-Control-Expose-Headers.
      paginationHeaderPrefix: 'x-apify-pagination-',
      // access-control-allow-origin: * — Apify единственный из четырёх, кто разрешает
      // вызовы из браузера. Пометка «CORS добавлен песочницей» здесь была бы неправдой.
      nativeCors: true,
    },
    webhook: {
      contentType: 'application/json',
      // «webhook HTTP requests have a timeout of 2 minutes».
      timeoutMs: 120_000,
      // «First retry: after approximately 1 minute, second: 2 minutes, third: 4 minutes…
      // eleventh retry: after approximately 32 hours». Чистая экспонента с основанием 2.
      retryDelaysMs: [
        60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000,
        3_840_000, 7_680_000, 15_360_000, 30_720_000, 61_440_000,
      ],
      successRule: 'status_2xx',
      expectedResponseBody: null,
      // Подписи нет: Apify предлагает вместо неё секрет в самом адресе вебхука.
      signature: 'none',
      signatureHeader: null,
      maxBatchSize: 1,
      suspendsAfterFailures: false,
      notes:
        'Тело — {userId, createdAt, eventType, eventData, resource}; resource повторяет ответ ' +
        'соответствующего метода API на момент события. Заголовки X-Apify-Webhook, ' +
        'X-Apify-Webhook-Dispatch-Id и X-Apify-Request-Origin система выставляет сама и ' +
        'перезаписывает пользовательские. Доставка может повториться — обработчик обязан ' +
        'быть идемпотентным.',
    },
    routing: 'method-and-path',
    // Живая проверка 09.09.2026: GET /v2/acts/memo23~wildberries-scraper и
    // GET /v2/actors/memo23~wildberries-scraper оба отвечают 200 одним и тем же
    // телом. Без алиаса клиент, написанный по документации Apify, получал бы
    // от песочницы 404 там, где боевой сервис отвечает.
    pathAliases: [{ from: /^\/v2\/acts(?=\/|$)/, to: '/v2/actors' }],
    nativeAuth: {
      kind: 'header',
      headers: ['Authorization'],
      description: 'Заголовок Authorization: Bearer <token> либо параметр token= в адресе',
    },
  },
} as const

export const SERVICE_LIST: readonly ServiceProfile[] = SERVICE_CODES.map((c) => SERVICE_PROFILES[c])

/**
 * Класс лимита для конкретного пути: ёмкость, скорость и имя ведра.
 *
 * Сервису без классов всегда возвращается его общий профиль — имя класса при этом
 * пустое, и ключ ведра остаётся прежним, каким был до появления классов.
 */
export function rateLimitClassFor(
  service: ServiceCode,
  path: string,
): { name: string; limit: number; windowMs: number; burst: number } {
  const profile = SERVICE_PROFILES[service].rateLimit
  for (const cls of profile.classes ?? []) {
    if (cls.pathPattern.test(path)) {
      return { name: cls.name, limit: cls.limit, windowMs: cls.windowMs, burst: cls.burst }
    }
  }
  return { name: '', limit: profile.limit, windowMs: profile.windowMs, burst: profile.burst }
}

/** Разбирает путь вида /wb/api/v3/orders в код сервиса и остаток пути. */
export function matchMountPath(pathname: string): { service: ServiceCode; rest: string } | null {
  for (const profile of SERVICE_LIST) {
    const p = profile.mountPath
    if (pathname === p) return { service: profile.code, rest: '/' }
    if (pathname.startsWith(`${p}/`)) return { service: profile.code, rest: pathname.slice(p.length) }
  }
  return null
}
