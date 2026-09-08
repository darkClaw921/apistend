import type { ServiceCode } from './services.ts'

/**
 * Локальные приложения Bitrix24.
 *
 * Боевой Bitrix24 требует от приложения адрес, доступный ЕМУ из внешней сети,
 * по HTTPS и с разрешённым фреймингом. Поэтому обычный цикл разработки выглядит так:
 * поднять ngrok, вписать выданный адрес в карточку приложения, переустановить,
 * повторить после каждого перезапуска туннеля. Документация Bitrix24 прямо пишет:
 * «localhost и локальные домены не подойдут», а placement.bind на такой адрес
 * отвечает ERROR_WRONG_HANDLER_URL.
 *
 * APIStend снимает ровно это: портал живёт на той же машине, что и приложение,
 * фрейм открывает браузер разработчика, и http://localhost:3000 — законный адрес
 * обработчика. Всё остальное обязано совпадать с боевым до имени поля: набор
 * параметров POST-запроса во фрейм, конверт OAuth, коды ошибок, правило
 * «до installFinish события не доставляются и виджеты не показываются».
 *
 * Что НЕ повторяется и повторено быть не может:
 *   — требование HTTPS: у localhost его нет и не будет;
 *   — проверка frame-ancestors на стороне приложения: её делает браузер, и если
 *     приложение шлёт X-Frame-Options: SAMEORIGIN, фрейм будет пустым точно так же,
 *     как в бою (это не дефект мока, а тот же самый дефект приложения).
 */

// ─────────────────────────── Права (scope) ───────────────────────────

export interface B24ScopeDefinition {
  readonly code: string
  readonly title: string
}

/**
 * Полный перечень прав со страницы «Доступные скоупы Bitrix24».
 *
 * Устаревшие (`tasks`, `tasks_extended`, `tasksmobile`) и не дающий доступа
 * `socialnetwork` сюда сознательно не включены: форма не должна предлагать то,
 * что боевой портал уже не принимает.
 */
export const B24_SCOPES: readonly B24ScopeDefinition[] = [
  { code: 'crm', title: 'CRM' },
  { code: 'task', title: 'Задачи' },
  { code: 'user', title: 'Пользователи' },
  { code: 'user_brief', title: 'Пользователи — минимальный набор полей' },
  { code: 'user_basic', title: 'Пользователи — базовый набор полей' },
  { code: 'placement', title: 'Встраивание приложений' },
  { code: 'im', title: 'Чат и уведомления' },
  { code: 'imbot', title: 'Чат-боты' },
  { code: 'imconnector', title: 'Коннекторы внешних мессенджеров' },
  { code: 'imopenlines', title: 'Открытые линии' },
  { code: 'entity', title: 'Хранилище данных' },
  { code: 'disk', title: 'Диск' },
  { code: 'calendar', title: 'Календарь' },
  { code: 'bizproc', title: 'Бизнес-процессы, роботы и RPA' },
  { code: 'catalog', title: 'Торговый каталог и склад' },
  { code: 'sale', title: 'Интернет-магазин' },
  { code: 'salescenter', title: 'CRM.Оплата и продажи в чате' },
  { code: 'delivery', title: 'Доставки' },
  { code: 'pay_system', title: 'Платёжные системы' },
  { code: 'cashbox', title: 'Кассы' },
  { code: 'telephony', title: 'Телефония' },
  { code: 'call', title: 'Совершение звонков' },
  { code: 'department', title: 'Структура компании' },
  { code: 'sonet_group', title: 'Рабочие группы' },
  { code: 'log', title: 'Живая лента' },
  { code: 'lists', title: 'Универсальные списки' },
  { code: 'landing', title: 'Сайты' },
  { code: 'documentgenerator', title: 'Генератор документов' },
  { code: 'timeman', title: 'Учёт рабочего времени' },
  { code: 'messageservice', title: 'Служба сообщений' },
  { code: 'mailservice', title: 'Почтовые сервисы' },
  { code: 'contact_center', title: 'Контакт-центр' },
  { code: 'biconnector', title: 'Коннектор BI-аналитики' },
  { code: 'rpa', title: 'Роботизация бизнеса' },
  { code: 'booking', title: 'Онлайн-запись' },
  { code: 'pull', title: 'Pull & Push' },
  { code: 'intranet', title: 'Виджеты интранета' },
  { code: 'main', title: 'Журнал событий' },
  { code: 'userfieldconfig', title: 'Настройки пользовательских полей' },
  { code: 'userconsent', title: 'Соглашения' },
  { code: 'vote', title: 'Опросы' },
  { code: 'ai_admin', title: 'Копилот' },
]

const SCOPE_CODES = new Set(B24_SCOPES.map((s) => s.code))

export function isB24Scope(code: string): boolean {
  return SCOPE_CODES.has(code)
}

// ──────────────────── Точки встраивания (placement) ────────────────────

export interface B24PlacementDefinition {
  readonly code: string
  /** Где именно появляется виджет — текст для подсказки в форме. */
  readonly title: string
  /** Право, без которого boевой портал отвечает ERROR_PLACEMENT_NOT_FOUND. */
  readonly scope: string | null
  /** Как открывается: вкладка внутри карточки, отдельная страница, слайдер, невидимый фрейм. */
  readonly surface: 'page' | 'tab' | 'menu' | 'slider' | 'background'
  /** Сколько обработчиков разрешено. У универсальных точек — ровно один. */
  readonly maxHandlers: number
  /** Ключи, которые портал кладёт в PLACEMENT_OPTIONS помимо URI. */
  readonly optionKeys: readonly string[]
}

/**
 * Коды встраивания, которые APIStend умеет открыть.
 *
 * Список неполон и полным быть не может: боевой перечень зависит от установленных
 * на портале модулей, поэтому документация советует «сверять код вызовом
 * placement.list, а не подбором». Здесь — точки, у которых есть видимое место
 * в демонстрационном портале; placement.bind на код вне списка отвечает тем же
 * ERROR_PLACEMENT_NOT_FOUND, что и боевой портал.
 */
export const B24_PLACEMENTS: readonly B24PlacementDefinition[] = [
  { code: 'DEFAULT', title: 'Основная страница приложения', scope: null, surface: 'page', maxHandlers: 1, optionKeys: [] },
  { code: 'LEFT_MENU', title: 'Пункт в главном меню, группа «Приложения»', scope: null, surface: 'page', maxHandlers: 8, optionKeys: [] },

  { code: 'CRM_DEAL_DETAIL_TAB', title: 'Вкладка в карточке сделки', scope: 'crm', surface: 'tab', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_DEAL_DETAIL_TOOLBAR', title: 'Пункт меню верхней кнопки карточки сделки', scope: 'crm', surface: 'slider', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_DEAL_DETAIL_ACTIVITY', title: 'Кнопка над таймлайном сделки', scope: 'crm', surface: 'slider', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_DEAL_LIST_MENU', title: 'Пункт контекстного меню сделки в списке', scope: 'crm', surface: 'slider', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_DEAL_LIST_TOOLBAR', title: 'Пункт меню над списком сделок', scope: 'crm', surface: 'slider', maxHandlers: 8, optionKeys: [] },

  { code: 'CRM_LEAD_DETAIL_TAB', title: 'Вкладка в карточке лида', scope: 'crm', surface: 'tab', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_LEAD_LIST_MENU', title: 'Пункт контекстного меню лида в списке', scope: 'crm', surface: 'slider', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_CONTACT_DETAIL_TAB', title: 'Вкладка в карточке контакта', scope: 'crm', surface: 'tab', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_COMPANY_DETAIL_TAB', title: 'Вкладка в карточке компании', scope: 'crm', surface: 'tab', maxHandlers: 8, optionKeys: ['ID'] },
  { code: 'CRM_ANALYTICS_MENU', title: 'Отчёт приложения в меню CRM-аналитики', scope: 'crm', surface: 'page', maxHandlers: 8, optionKeys: [] },

  { code: 'TASK_VIEW_TAB', title: 'Виджет в карточке задачи', scope: 'task', surface: 'tab', maxHandlers: 8, optionKeys: ['taskId'] },
  { code: 'TASK_LIST_CONTEXT_MENU', title: 'Пункт контекстного меню задачи', scope: 'task', surface: 'slider', maxHandlers: 8, optionKeys: ['taskId'] },
  { code: 'TASK_USER_LIST_TOOLBAR', title: 'Пункт меню над списком задач', scope: 'task', surface: 'slider', maxHandlers: 8, optionKeys: [] },

  { code: 'USER_PROFILE_MENU', title: 'Пункт в меню пользователя', scope: 'user', surface: 'slider', maxHandlers: 8, optionKeys: [] },
  { code: 'CALL_CARD', title: 'Вкладка в карточке звонка', scope: 'telephony', surface: 'tab', maxHandlers: 8, optionKeys: ['CALL_ID', 'PHONE_NUMBER', 'CRM_ENTITY_TYPE', 'CRM_ENTITY_ID', 'CALL_DIRECTION', 'CALL_STATE'] },
  { code: 'CONTACT_CENTER', title: 'Плитка в контакт-центре', scope: 'contact_center', surface: 'page', maxHandlers: 8, optionKeys: [] },
  { code: 'IM_TEXTAREA', title: 'Кнопка над полем ввода чата', scope: 'im', surface: 'slider', maxHandlers: 8, optionKeys: ['dialogId'] },

  { code: 'REST_APP_URI', title: 'Открытие слайдером по ссылке в сообщении', scope: null, surface: 'slider', maxHandlers: 1, optionKeys: [] },
  { code: 'PAGE_BACKGROUND_WORKER', title: 'Фоновый обработчик на всех страницах', scope: null, surface: 'background', maxHandlers: 1, optionKeys: ['ID'] },
]

const PLACEMENT_BY_CODE = new Map(B24_PLACEMENTS.map((p) => [p.code, p]))

export function findB24Placement(code: string): B24PlacementDefinition | undefined {
  return PLACEMENT_BY_CODE.get(code.toUpperCase())
}

/** Коды, которые placement.bind принимает. DEFAULT в их число не входит — он не регистрируется. */
export function bindableB24Placements(scopes: readonly string[]): B24PlacementDefinition[] {
  return B24_PLACEMENTS.filter(
    (p) => p.code !== 'DEFAULT' && (p.scope === null || scopes.includes(p.scope)),
  )
}

// ─────────────────────────── Приложение ───────────────────────────

/**
 * Вид локального приложения. В форме портала отдельного селектора нет — вид
 * определяется тем, какие поля заполнены, но для интерфейса и для проверок
 * удобнее явное значение.
 */
export const B24_APP_KINDS = ['server_ui', 'api_only'] as const
export type B24AppKind = (typeof B24_APP_KINDS)[number]

export const B24_APP_KIND_TITLE: Readonly<Record<B24AppKind, string>> = {
  server_ui: 'Серверное с интерфейсом',
  api_only: 'Только API, без интерфейса',
}

/**
 * События жизненного цикла приложения.
 *
 * Приходят не на подписку, а на адрес из карточки приложения, поэтому event.get
 * их не показывает: их никто не регистрировал вызовом event.bind.
 */
export const B24_LIFECYCLE_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const

export function isB24LifecycleEvent(event: string): boolean {
  return (B24_LIFECYCLE_EVENTS as readonly string[]).includes(event.toUpperCase())
}

/** Статус приложения в поле status и в app.info. Локальное всегда L. */
export const B24_APP_STATUS_LOCAL = 'L'

/** Срок жизни access_token, секунды. Боевое значение — ровно час. */
export const B24_TOKEN_TTL_SECONDS = 3600

/** Срок жизни refresh_token. Боевое значение — 180 суток. */
export const B24_REFRESH_TTL_SECONDS = 180 * 24 * 3600

/**
 * Границы срока жизни токенов, настраиваемого в карточке приложения.
 *
 * Единственное место, где APIStend сознательно расходится с боевым порталом:
 * там срок всегда час, и дождаться протухания при отладке нельзя — час это
 * час. А проверять надо именно его: документация предписывает приложению
 * дождаться ошибки expired_token и только после неё обновлять пару. Написать
 * такой обработчик легко, проверить в бою — почти нет, поэтому ошибка обычно
 * обнаруживается через час работы на проде.
 *
 * Нижняя граница в пять секунд позволяет увидеть цикл целиком за один заход,
 * верхняя совпадает с сутками — дольше отлаживать нечего.
 */
export const B24_TOKEN_TTL_MIN_SECONDS = 5
export const B24_TOKEN_TTL_MAX_SECONDS = 24 * 3600

/** Границы срока refresh_token: от минуты (проверить «пройти OAuth заново») до 180 суток. */
export const B24_REFRESH_TTL_MIN_SECONDS = 60
export const B24_REFRESH_TTL_MAX_SECONDS = 180 * 24 * 3600

/** Готовые значения для быстрого выбора в интерфейсе. */
export const B24_TOKEN_TTL_PRESETS: ReadonlyArray<{ seconds: number; label: string; hint: string }> = [
  { seconds: 10, label: '10 секунд', hint: 'Цикл виден сразу: вызов, отказ, обновление, повтор' },
  { seconds: 60, label: 'минута', hint: 'Хватает на ручную проверку без спешки' },
  { seconds: 300, label: '5 минут', hint: 'Обновление случится посреди работы, а не на старте' },
  { seconds: 3600, label: 'час', hint: 'Как в боевом Bitrix24' },
]

export function clampTokenTtl(seconds: number): number {
  return Math.min(Math.max(Math.round(seconds), B24_TOKEN_TTL_MIN_SECONDS), B24_TOKEN_TTL_MAX_SECONDS)
}

export function clampRefreshTtl(seconds: number): number {
  return Math.min(Math.max(Math.round(seconds), B24_REFRESH_TTL_MIN_SECONDS), B24_REFRESH_TTL_MAX_SECONDS)
}

/** Срок жизни авторизационного кода. Боевое значение — 30 секунд. */
export const B24_AUTH_CODE_TTL_SECONDS = 30

/**
 * Ответ сервера авторизации на выдачу и обновление токенов.
 *
 * Имена полей совпадают с боевыми дословно: их разбирает клиентский код
 * разработчика, и переименование хотя бы одного делает мок бесполезным.
 */
export interface B24TokenResponse {
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_in: number
  readonly expires: number
  readonly scope: string
  readonly domain: string
  readonly server_endpoint: string
  readonly client_endpoint: string
  readonly member_id: string
  readonly status: string
  readonly user_id: number
}

/**
 * Набор полей, который портал отдаёт фрейму приложения.
 *
 * Часть уходит в query-строку, часть — в тело POST. Разделение боевое:
 * DOMAIN/PROTOCOL/LANG/APP_SID видны в адресной строке фрейма, остальное —
 * в теле, потому что там токены.
 */
export interface B24FramePayload {
  /** В query-строке. */
  readonly query: {
    readonly DOMAIN: string
    readonly PROTOCOL: '0' | '1'
    readonly LANG: string
    readonly APP_SID: string
  }
  /** В теле POST, application/x-www-form-urlencoded. */
  readonly body: {
    readonly AUTH_ID: string
    readonly AUTH_EXPIRES: string
    readonly REFRESH_ID: string
    readonly SERVER_ENDPOINT: string
    readonly APPLICATION_TOKEN: string
    readonly APPLICATION_SCOPE: string
    readonly member_id: string
    readonly status: string
    readonly PLACEMENT: string
    readonly PLACEMENT_OPTIONS?: string
  }
}

// ────────────────── Мост между фреймом и порталом ──────────────────

/**
 * Протокол postMessage между нашим BX24.js и страницей портала.
 *
 * Боевой Bitrix24 свой протокол не публикует — он инкапсулирован в библиотеке,
 * и документация говорит лишь, что «единственный канал наружу — мост к родительскому
 * окну», а APP_SID «связывает js-библиотеку с окружением приложения». Поэтому здесь
 * собственный протокол; совпадать обязан не он, а поверхность BX24.*, которую видит
 * разработчик. Библиотеку отдаёт APIStend, и подключается она вместо
 * //api.bitrix24.tech/api/v1/ — той же подменой адреса, что и весь остальной продукт.
 *
 * APP_SID проверяется в каждом кадре: на странице портала одновременно живут
 * несколько фреймов (вкладка карточки, слайдер, фоновый обработчик), и ответ
 * обязан вернуться тому, кто спрашивал.
 */
export const BX24_BRIDGE_NS = 'apistend.bx24'
export const BX24_BRIDGE_VERSION = 1

/** Фрейм → портал: библиотека загрузилась и ждёт данные среды. */
export interface Bx24HelloFrame {
  readonly ns: typeof BX24_BRIDGE_NS
  readonly v: 1
  readonly type: 'hello'
  readonly appSid: string
}

/** Портал → фрейм: данные среды. Ответ на hello и на смену контекста. */
export interface Bx24InitFrame {
  readonly ns: typeof BX24_BRIDGE_NS
  readonly v: 1
  readonly type: 'init'
  readonly appSid: string
  readonly auth: {
    readonly access_token: string
    readonly refresh_token: string
    readonly expires_in: number
    readonly domain: string
    readonly member_id: string
    readonly status: string
    readonly client_endpoint: string
    readonly server_endpoint: string
  }
  readonly domain: string
  readonly lang: string
  readonly isAdmin: boolean
  readonly userId: number
  /** Первый ли это запуск: BX24.install срабатывает только тогда. */
  readonly firstRun: boolean
  readonly placement: string
  readonly placementOptions: Readonly<Record<string, unknown>>
  /** Команды и события, которые точка встраивания предоставляет placement.call. */
  readonly placementInterface: { readonly command: readonly string[]; readonly event: readonly string[] }
}

/** Фрейм → портал: вызов команды интерфейса. */
export interface Bx24CallFrame {
  readonly ns: typeof BX24_BRIDGE_NS
  readonly v: 1
  readonly type: 'call'
  readonly appSid: string
  readonly id: string
  readonly method: string
  readonly params: unknown
}

/** Портал → фрейм: результат команды. */
export interface Bx24ResultFrame {
  readonly ns: typeof BX24_BRIDGE_NS
  readonly v: 1
  readonly type: 'result'
  readonly appSid: string
  readonly id: string
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** Портал → фрейм: событие точки встраивания (placement.bindEvent). */
export interface Bx24EventFrame {
  readonly ns: typeof BX24_BRIDGE_NS
  readonly v: 1
  readonly type: 'event'
  readonly appSid: string
  readonly event: string
  readonly data: unknown
}

export type Bx24BridgeFrame =
  | Bx24HelloFrame
  | Bx24InitFrame
  | Bx24CallFrame
  | Bx24ResultFrame
  | Bx24EventFrame

/** Команды моста, которые обязана понимать страница портала. */
export const BX24_BRIDGE_COMMANDS = [
  'installFinish',
  'resizeWindow',
  'fitWindow',
  'setTitle',
  'reloadWindow',
  'scrollParentWindow',
  'openApplication',
  'closeApplication',
  'openPath',
  'selectUser',
  'selectUsers',
  'selectAccess',
  'selectCRM',
  'refreshAuth',
  'userOption.set',
  'userOption.get',
  'appOption.set',
  'appOption.get',
  'placement.call',
  'im.callTo',
  'im.phoneTo',
  'im.openMessenger',
  'im.openHistory',
] as const

export type Bx24BridgeCommand = (typeof BX24_BRIDGE_COMMANDS)[number]

export function isBx24BridgeFrame(value: unknown): value is Bx24BridgeFrame {
  if (typeof value !== 'object' || value === null) return false
  const f = value as { ns?: unknown; v?: unknown; type?: unknown }
  return f.ns === BX24_BRIDGE_NS && f.v === BX24_BRIDGE_VERSION && typeof f.type === 'string'
}

// ───────────────── Ошибки, специфичные для приложений ─────────────────

/**
 * Конверт ошибки REST в точности как у боевого портала.
 *
 * Отдельно от buildScenarioError в errors.ts: там ошибки шлюза (лимит, неверный ключ),
 * здесь — ошибки контекста приложения, которых у ключа песочницы просто не бывает.
 */
export interface B24AppError {
  readonly status: number
  readonly body: { readonly error: string; readonly error_description: string }
}

export const B24_APP_ERRORS = {
  expiredToken: {
    status: 401,
    body: { error: 'expired_token', error_description: 'The access token provided has expired' },
  },
  noAuthFound: {
    status: 401,
    body: { error: 'NO_AUTH_FOUND', error_description: 'Wrong authorization data' },
  },
  insufficientScope: {
    status: 403,
    body: {
      error: 'insufficient_scope',
      error_description: 'The request requires higher privileges than provided by the access token',
    },
  },
  wrongAuthType: {
    status: 401,
    body: { error: 'WRONG_AUTH_TYPE', error_description: 'Application context required' },
  },
  appContextRequired: {
    status: 400,
    body: { error: 'ACCESS_DENIED', error_description: 'Access denied! Application context required' },
  },
} as const satisfies Readonly<Record<string, B24AppError>>

/** Ошибки сервера авторизации. Приходят вместо пары токенов, всегда с кодом 400. */
export const B24_OAUTH_ERRORS = {
  invalidRequest: { error: 'invalid_request', error_description: 'Invalid request' },
  invalidClient: { error: 'invalid_client', error_description: 'Invalid client' },
  invalidGrant: { error: 'invalid_grant', error_description: 'Invalid grant' },
  invalidScope: { error: 'invalid_scope', error_description: 'Invalid scope' },
  unsupportedGrantType: { error: 'invalid_request', error_description: 'Unsupported grant type' },
} as const

/** Сервис, к которому относится вся эта машинерия. Приложения есть только у Bitrix24. */
export const B24_SERVICE: ServiceCode = 'bitrix24'
