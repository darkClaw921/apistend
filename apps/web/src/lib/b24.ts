/**
 * Контракт кабинета по локальным приложениям Bitrix24.
 *
 * Отдельно от types.ts: там DTO всех остальных разделов, и смешивать их
 * с довольно объёмной моделью приложений незачем — раздел самодостаточен.
 */

export type B24AppKind = 'server_ui' | 'api_only'
export type B24AppState = 'awaiting_install' | 'installed' | 'uninstalled'

/** Данные демонстрационного портала: то, что боевой Bitrix24 сообщает о себе приложению. */
export interface B24Portal {
  /** Хост портала. Он же DOMAIN во фрейме и основа client_endpoint. */
  domain: string
  /** «0» — http, «1» — https. У localhost это всегда «0», и приложение обязано это увидеть. */
  protocol: '0' | '1'
  lang: string
  memberId: string
  /** Базовый адрес REST: http://localhost:8080/rest/ */
  restUrl: string
  /** Сервер авторизации: адрес, куда идут запросы за токенами. */
  oauthUrl: string
  /** Что подключать вместо //api.bitrix24.tech/api/v1/ */
  bx24JsUrl: string
  currentUser: { id: number; name: string; isAdmin: boolean }
}

export interface B24AppItem {
  id: string
  title: string
  code: string
  clientId: string
  kind: B24AppKind
  state: B24AppState
  scope: string[]
  handlerUrl: string | null
  installUrl: string | null
  menuTitle: string | null
  applicationToken: string
  version: number
  /**
   * Срок жизни access_token в секундах.
   *
   * Боевой портал всегда даёт 3600 и настройки не имеет. Здесь она есть ровно
   * для одной проверки: дождаться expired_token и увидеть, как приложение
   * восстанавливает доступ само.
   */
  tokenTtlSeconds: number
  /** Срок жизни refresh_token в секундах. */
  refreshTtlSeconds: number
  /** app.info → INSTALLED. До installFinish события не идут и виджеты не показываются. */
  installed: boolean
  installedAt: string | null
  lastInstallNote: string | null
  placementsCount: number
  handlersCount: number
  tokensCount: number
  createdAt: string
}

export interface B24PlacementItem {
  id: string
  placement: string
  /** Название вкладки или пункта меню. */
  title: string | null
  handler: string
  options: Record<string, unknown>
  /** Знает ли APIStend этот код: незнакомый placement.bind отвергает, как и боевой портал. */
  known: boolean
  /** Как открывается: вкладка, страница, слайдер, фоновый фрейм. */
  surface: string | null
  createdAt: string
}

export interface B24EventHandlerItem {
  id: string
  event: string
  handler: string
  authType: number
  createdAt: string
}

export interface B24TokenItem {
  id: string
  accessToken: string
  refreshToken: string
  portalUserId: number
  scope: string[]
  expiresAt: string
  expired: boolean
  /** Сколько секунд осталось. Отрицательное — токен уже протух. */
  expiresInSeconds: number
  revokedAt: string | null
  createdAt: string
}

/** Ответ POST /api/b24/apps/:id/expire-tokens */
export interface B24ExpireResponse {
  /** Сколько действующих пар состарено. */
  expired: number
  app: B24AppDetail
}

export interface B24SessionItem {
  id: string
  appSid: string
  placement: string
  isInstall: boolean
  finishedAt: string | null
  createdAt: string
}

export interface B24AppDetail extends B24AppItem {
  /** Показывается открыто: это демо-портал, и смысл экрана в том, чтобы секрет можно было скопировать. */
  clientSecret: string
  placements: B24PlacementItem[]
  handlers: B24EventHandlerItem[]
  tokens: B24TokenItem[]
  sessions: B24SessionItem[]
}

export interface B24ScopeOption {
  code: string
  title: string
}

export interface B24PlacementOption {
  code: string
  title: string
  scope: string | null
  surface: string
}

/** GET /api/b24/apps */
export interface B24AppsResponse {
  apps: B24AppItem[]
  portal: B24Portal
  scopes: B24ScopeOption[]
  placements: B24PlacementOption[]
}

/** GET /api/b24/apps/:id */
export interface B24AppResponse {
  app: B24AppDetail
  portal: B24Portal
  scopes: B24ScopeOption[]
  placements: B24PlacementOption[]
}

/**
 * POST /api/b24/apps/:id/open — портал готовит открытие фрейма.
 *
 * Ответ нельзя подставить в iframe напрямую: боевой Bitrix24 открывает приложение
 * POST-запросом, часть полей уходит в query, часть — в тело. Страница портала строит
 * скрытую форму с target на iframe и отправляет её.
 */
export interface B24OpenResponse {
  appSid: string
  /** Полный адрес обработчика вместе с query-параметрами. Атрибут action формы. */
  action: string
  /** Открывается мастер установки, а не обработчик. */
  install: boolean
  /** Поля скрытой формы: имя → значение. */
  fields: Record<string, string>
  app: B24AppItem
}

/** Элемент главного меню демонстрационного портала. */
export interface B24MenuItem {
  appId: string
  title: string
  /** DEFAULT — основная страница приложения, LEFT_MENU — зарегистрированный виджет. */
  placement: string
  handler: string
}

/** Сделка портала: нужна вкладкам CRM_DEAL_DETAIL_TAB, чтобы у виджета был контекст. */
export interface B24PortalDeal {
  id: string
  title: string
  stage: string
  opportunity: string
  contact: string
}

/** GET /api/b24/portal */
export interface B24PortalResponse {
  portal: B24Portal
  apps: B24AppItem[]
  menu: B24MenuItem[]
  deals: B24PortalDeal[]
  /** Виджеты по кодам встраивания: CRM_DEAL_DETAIL_TAB → [...]. */
  widgets: Record<string, Array<B24PlacementItem & { appId: string; appTitle: string }>>
}
