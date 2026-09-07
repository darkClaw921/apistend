'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Info, X } from 'lucide-react'
import { EmptyState, ErrorState, Panel, SkeletonRows } from '@apistend/ui'
import { B24_APP_STATUS_LOCAL } from '@apistend/shared'
import type { B24TokenResponse } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import type { B24OpenResponse, B24PortalResponse, B24TokenItem } from '@/lib/b24'
import { Topbar } from '@/components/Topbar'
import {
  AppFrame, BridgeCommandError, bridgeArg, bridgeNumber, bridgeParams, placementInterfaceFor,
  type BridgeHandlers, type FrameSession,
} from '@/components/portal/AppFrame'
import { BridgeLogPanel, useBridgeLog } from '@/components/portal/BridgeLog'
import { DealCard, DEAL_TAB_GENERAL, type PortalWidget } from '@/components/portal/DealCard'
import {
  PortalSidebar, PortalTopbar, WorkspaceHeader, portalStaff, type PortalSurface,
} from '@/components/portal/PortalChrome'
import { AppSlider, PortalDialogs, type DialogRequest, type DialogSpec } from '@/components/portal/PortalDialogs'

/**
 * Демонстрационный портал: приложение открывается ровно так, как это делает Bitrix24.
 *
 * Смысл экрана в одном: боевой портал требует адрес, доступный ЕМУ из внешней сети,
 * по https и с разрешённым фреймингом, поэтому цикл «поднять туннель — вписать адрес —
 * переустановить» повторяется после каждого перезапуска. Здесь портал живёт на той же
 * машине, что и приложение, и http://localhost — законный адрес обработчика.
 * Всё остальное совпадать обязано: POST во фрейм, набор полей, поведение моста.
 */

/** Место открытия по умолчанию, когда приложение выбрано не из меню портала. */
const DEFAULT_PLACEMENT = 'DEFAULT'

export default function PortalPage() {
  return (
    <Suspense fallback={<PortalFallback />}>
      <PortalScreen />
    </Suspense>
  )
}

/** Адрес приложения читается из query-строки, а она доступна только на клиенте. */
function PortalFallback() {
  return (
    <main className="flex min-h-0 flex-1 flex-col p-[24px]">
      <Panel className="flex-1">
        <SkeletonRows rows={8} />
      </Panel>
    </main>
  )
}

function PortalScreen() {
  const searchParams = useSearchParams()
  const requestedApp = searchParams.get('app')

  const [data, setData] = useState<B24PortalResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')

  const [appId, setAppId] = useState<string | null>(null)
  /** Индекс пункта меню приложений; −1 — приложение выбрано не из меню. */
  const [menuIndex, setMenuIndex] = useState(-1)
  const [surface, setSurface] = useState<'page' | 'deal'>('page')
  const [dealId, setDealId] = useState<string | null>(null)
  const [dealTab, setDealTab] = useState(DEAL_TAB_GENERAL)
  const [dealRefreshedAt, setDealRefreshedAt] = useState<Date | null>(null)
  const [actingId, setActingId] = useState<number | null>(null)
  const [reopenSeq, setReopenSeq] = useState(0)

  const [session, setSession] = useState<FrameSession | null>(null)
  const [slider, setSlider] = useState<FrameSession | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [frameTitle, setFrameTitle] = useState<string | null>(null)
  const [sliderTitle, setSliderTitle] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)
  const [logOpen, setLogOpen] = useState(true)

  const log = useBridgeLog()
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const sessionSeq = useRef(0)
  const noticeSeq = useRef(0)
  const dialogRef = useRef<DialogRequest | null>(null)
  const appliedRequest = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.get<B24PortalResponse>('/api/b24/portal'))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить портал')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!data) return
    setActingId((cur) => cur ?? data.portal.currentUser.id)
    setDealId((cur) => (cur && data.deals.some((d) => d.id === cur) ? cur : data.deals[0]?.id ?? null))
    setAppId((cur) => (cur && data.apps.some((a) => a.id === cur) ? cur : data.apps[0]?.id ?? null))
    // После installFinish меню перестраивается: виджеты приложения появляются в нём
    // только теперь, и прежний индекс мог бы указать на чужой пункт.
    setMenuIndex((cur) => (cur >= data.menu.length ? -1 : cur))
  }, [data])

  // Карточка приложения открывает портал ссылкой ?app=<id>. Применяем адрес один раз:
  // иначе перечитывание портала возвращало бы пользователя к тому приложению,
  // от которого он уже ушёл по меню.
  useEffect(() => {
    if (!data || !requestedApp || appliedRequest.current === requestedApp) return
    if (!data.apps.some((a) => a.id === requestedApp)) return
    appliedRequest.current = requestedApp
    setAppId(requestedApp)
    setMenuIndex(data.menu.findIndex((m) => m.appId === requestedApp))
    setSurface('page')
  }, [data, requestedApp])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 7_000)
    return () => clearTimeout(timer)
  }, [notice])

  const portal = data?.portal ?? null
  const staff = useMemo(() => (portal ? portalStaff(portal) : []), [portal])
  const acting = staff.find((s) => s.id === actingId) ?? staff[0] ?? null
  const app = data?.apps.find((a) => a.id === appId) ?? null
  const menuItem = menuIndex >= 0 ? data?.menu[menuIndex] ?? null : null
  const dealWidgets: PortalWidget[] = data?.widgets['CRM_DEAL_DETAIL_TAB'] ?? []
  const deal = data?.deals.find((d) => d.id === dealId) ?? null
  const activeWidget = dealWidgets.find((w) => w.id === dealTab) ?? null

  // Что именно портал открывает во фрейме. Все составляющие — примитивы:
  // от них зависит эффект открытия, и объект в зависимостях перезапускал бы его вечно.
  // Вкладка карточки без сделки бессмысленна: PLACEMENT_OPTIONS.ID взять неоткуда.
  const frameAppId = surface === 'deal' ? (deal ? activeWidget?.appId ?? null : null) : menuItem?.appId ?? appId
  const framePlacement = surface === 'deal' ? 'CRM_DEAL_DETAIL_TAB' : menuItem?.placement ?? DEFAULT_PLACEMENT
  // URI в PLACEMENT_OPTIONS подставляет сам портал: правило «какой путь у карточки»
  // одно на весь продукт, и второй его копии на клиенте быть не должно.
  const frameOptions = surface === 'deal' && deal ? JSON.stringify({ ID: deal.id }) : '{}'
  const frameApp = data?.apps.find((a) => a.id === frameAppId) ?? null
  const frameInstall = frameApp?.state === 'awaiting_install'
  // Мастеру установки хватает installUrl: обработчик у приложения может появиться позже.
  const frameOpenable = frameApp !== null && (frameApp.handlerUrl !== null || frameApp.installUrl !== null)
  const sliderApp = data?.apps.find((a) => a.id === slider?.appId) ?? null

  function showNotice(text: string): void {
    noticeSeq.current += 1
    setNotice({ id: noticeSeq.current, text })
  }

  /**
   * Открытие фрейма. Боевой портал делает это POST-запросом, поэтому ответ — не адрес
   * для src, а адрес формы и набор её скрытых полей.
   */
  useEffect(() => {
    if (!frameAppId || !frameOpenable || actingId === null) {
      setSession(null)
      return
    }
    let cancelled = false
    setOpening(true)
    void (async () => {
      try {
        const res = await api.post<B24OpenResponse>(`/api/b24/apps/${frameAppId}/open`, {
          placement: framePlacement,
          placementOptions: JSON.parse(frameOptions) as Record<string, unknown>,
          install: frameInstall,
          // Токен выдаётся выбранному сотруднику: смена сотрудника обязана менять
          // и user_id в паре, иначе приложение увидит одно, а REST ответит про другого.
          portalUserId: actingId,
        })
        if (cancelled) return
        sessionSeq.current += 1
        setSession({
          key: sessionSeq.current,
          appId: frameAppId,
          appSid: res.appSid,
          action: res.action,
          install: res.install,
          fields: res.fields,
        })
        setFrameTitle(null)
        setOpenError(null)
      } catch (e) {
        if (cancelled) return
        setSession(null)
        setOpenError(e instanceof ApiError ? e.message : 'Не удалось открыть приложение')
      } finally {
        if (!cancelled) setOpening(false)
      }
    })()
    return () => { cancelled = true }
  }, [frameAppId, frameOpenable, framePlacement, frameOptions, frameInstall, actingId, reopenSeq])

  /** Слайдер — второй фрейм поверх страницы. Так открывается BX24.openApplication. */
  const openSlider = useCallback(async (targetAppId: string, options: Record<string, unknown>) => {
    const res = await apiPost<B24OpenResponse>(`/api/b24/apps/${targetAppId}/open`, {
      placement: DEFAULT_PLACEMENT,
      placementOptions: options,
      portalUserId: actingId,
    })
    sessionSeq.current += 1
    setSliderTitle(null)
    setSlider({
      key: sessionSeq.current,
      appId: targetAppId,
      appSid: res.appSid,
      action: res.action,
      install: res.install,
      fields: res.fields,
    })
  }, [actingId])

  function ask(spec: DialogSpec): Promise<unknown> {
    return new Promise((resolve) => {
      // Второй диалог вытесняет первый: неотвеченному отдаём null, иначе колбэк
      // приложения будет ждать вечно.
      dialogRef.current?.resolve(null)
      const request: DialogRequest = { spec, resolve }
      dialogRef.current = request
      setDialog(request)
    })
  }

  function resolveDialog(value: unknown): void {
    const current = dialogRef.current
    dialogRef.current = null
    setDialog(null)
    current?.resolve(value)
  }

  const handlers: BridgeHandlers = {
    installFinish: async (_params, ctx) => {
      await apiPost(`/api/b24/apps/${ctx.appId}/install-finish`, { appSid: ctx.appSid })
      // Виджеты и пункты меню портал показывает только после installFinish, поэтому
      // читаем портал целиком и переоткрываем фрейм уже на обработчике — ровно так
      // ведёт себя боевой портал, и приложение обязано это пережить.
      const fresh = await apiGet<B24PortalResponse>('/api/b24/portal')
      setData(fresh)
      setReopenSeq((n) => n + 1)
      return true
    },

    scrollParentWindow: (params) => {
      const top = bridgeNumber(bridgeArg(params, 'scroll', 0))
      if (top !== null) workspaceRef.current?.scrollTo({ top, behavior: 'smooth' })
      return true
    },

    // BX24.openApplication(params, cb, settings) — порталу нужны params: они уезжают
    // во второй фрейм как PLACEMENT_OPTIONS.
    openApplication: async (params, ctx) => {
      await openSlider(ctx.appId, bridgeParams(bridgeArg(params, 'params', 0)))
      return true
    },

    closeApplication: (_params, ctx) => {
      if (slider && slider.appSid === ctx.appSid) {
        setSlider(null)
        return true
      }
      showNotice('Приложение попросило закрыть окно, но открыто оно основной страницей, а не слайдером — закрывать нечего')
      return true
    },

    openPath: (params) => {
      const path = String(bridgeArg(params, 'path', 0) ?? '')
      // Боевой SDK на чужой путь отвечает не ошибкой моста, а результатом команды.
      if (!path.startsWith('/')) return { result: 'error', errorCode: 'PATH_NOT_AVAILABLE' }
      showNotice(`Портал открыл бы «${path}» в слайдере`)
      return { result: 'close' }
    },

    selectUser: () => ask({ kind: 'user', multiple: false }),
    selectUsers: () => ask({ kind: 'user', multiple: true }),
    selectAccess: (params) => ask({ kind: 'access', blocked: toStringArray(bridgeArg(params, 'value', 0)) }),
    selectCRM: (params) => {
      const p = bridgeParams(bridgeArg(params, 'params', 0))
      return ask({ kind: 'crm', multiple: p.multiple === true, entityTypes: toStringArray(p.entityType) })
    },

    'userOption.get': (params, ctx) => readOption(userOptionKey(ctx.appId, acting?.id ?? 0), params),
    'userOption.set': (params, ctx) => writeOption(userOptionKey(ctx.appId, acting?.id ?? 0), params),
    'appOption.get': (params, ctx) => readOption(appOptionKey(ctx.appId), params),
    'appOption.set': (params, ctx) => writeOption(appOptionKey(ctx.appId), params),

    'placement.call': (params, ctx) => {
      const command = String(bridgeArg(params, 'command', 0) ?? '')
      if (command === 'reloadData' && placementInterfaceFor(ctx.placement).command.includes(command)) {
        setDealRefreshedAt(new Date())
        return true
      }
      // Команда, которой у точки встраивания нет, — это ошибка самой команды.
      return { result: 'error', errorCode: 'Command is undefined' }
    },

    'im.callTo': (params) => imNotice('видеозвонок сотруднику', bridgeArg(params, 'userId', 0)),
    'im.phoneTo': (params) => imNotice('звонок на номер', bridgeArg(params, 'phone', 0)),
    'im.openMessenger': (params) => imNotice('окно мессенджера', bridgeArg(params, 'dialogId', 0)),
    'im.openHistory': (params) => imNotice('историю чата', bridgeArg(params, 'dialogId', 0)),

    refreshAuth: async (_params, ctx) => {
      const res = await apiPost<{ token: B24TokenItem; auth?: B24TokenResponse }>(
        `/api/b24/apps/${ctx.appId}/token`,
        { appSid: ctx.appSid, portalUserId: acting?.id },
      )
      // Сервер авторизации отдаёт конверт целиком — приложение должно увидеть тот же
      // набор полей, что и при обмене refresh_token, а не урезанный портальный.
      return res.auth ?? {
        access_token: res.token.accessToken,
        refresh_token: res.token.refreshToken,
        expires_in: Math.max(0, Math.round((new Date(res.token.expiresAt).getTime() - Date.now()) / 1000)),
        domain: portal?.domain ?? '',
        member_id: portal?.memberId ?? '',
        status: B24_APP_STATUS_LOCAL,
        client_endpoint: portal?.restUrl ?? '',
        server_endpoint: portal?.oauthUrl ?? '',
      }
    },
  }

  function imNotice(what: string, target: unknown): boolean {
    const suffix = target === undefined || target === null || target === '' ? '' : `: ${String(target)}`
    showNotice(`Портал открыл бы ${what}${suffix}`)
    return true
  }

  async function changeSurface(next: PortalSurface): Promise<void> {
    if (next !== 'slider') {
      setSlider(null)
      setSurface(next)
      // В карточку сделки заходят ради своей вкладки — открываем сразу её,
      // если приложение зарегистрировало CRM_DEAL_DETAIL_TAB.
      if (next === 'deal') {
        const own = dealWidgets.find((w) => w.appId === (menuItem?.appId ?? appId))
        setDealTab(own?.id ?? DEAL_TAB_GENERAL)
      }
      return
    }
    if (slider) return
    if (!frameAppId) {
      showNotice('Сначала выберите приложение в меню портала')
      return
    }
    try {
      await openSlider(frameAppId, {})
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Не удалось открыть слайдер')
    }
  }

  function renderFrame(defaultHeight: number | 'fill') {
    if (!data || !portal || !acting) return null
    if (data.apps.length === 0) {
      return (
        <EmptyState
          title="Приложений нет"
          description="Создайте локальное приложение — портал откроет его тем же POST-запросом, каким это делает боевой Bitrix24"
        />
      )
    }
    if (!frameApp) {
      return <EmptyState title="Приложение не выбрано" description="Выберите пункт в меню портала слева" />
    }
    if (frameApp.kind === 'api_only') {
      return (
        <EmptyState
          title="Приложение работает только через API"
          description="Интерфейса, который можно открыть во фрейме, у него нет: обмен идёт по REST с токеном из карточки приложения"
        />
      )
    }
    if (!frameApp.handlerUrl && !frameApp.installUrl) {
      return (
        <EmptyState
          title="У приложения нет адреса обработчика"
          description="Приложение без интерфейса портал во фрейме не открывает: у него есть только REST. Укажите адрес обработчика в карточке приложения."
        />
      )
    }
    if (openError) {
      return <ErrorState message={openError} onRetry={() => setReopenSeq((n) => n + 1)} />
    }
    if (!session || opening) {
      return <SkeletonRows rows={6} />
    }
    return (
      <AppFrame
        key={session.key}
        session={session}
        title={frameApp.title}
        portal={portal}
        user={acting}
        handlers={handlers}
        onLog={log.push}
        onTitle={setFrameTitle}
        defaultHeight={defaultHeight}
      />
    )
  }

  return (
    <>
      <Topbar
        breadcrumb="Локальные приложения Bitrix24 / Портал"
        title="Демонстрационный портал"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
      />

      <main className="flex min-h-0 flex-1 gap-[20px] overflow-hidden p-[24px]">
        <Panel className="relative min-w-0 flex-1">
          {loading && !data ? (
            <SkeletonRows rows={8} />
          ) : error && !data ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : data && portal && acting ? (
            <>
              <PortalTopbar
                portal={portal}
                staff={staff}
                actingId={acting.id}
                onActingChange={setActingId}
                surface={slider ? 'slider' : surface}
                onSurfaceChange={(next) => void changeSurface(next)}
                logOpen={logOpen}
                onLogToggle={() => setLogOpen((v) => !v)}
                onReopen={() => setReopenSeq((n) => n + 1)}
                reopening={opening}
              />

              {notice ? (
                <div className="flex shrink-0 items-center gap-[8px] border-b border-border bg-accent-soft px-[16px] py-[8px]">
                  <Info size={14} className="shrink-0 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">{notice.text}</span>
                  <button
                    type="button"
                    onClick={() => setNotice(null)}
                    aria-label="Скрыть сообщение портала"
                    className="text-text-tertiary hover:text-text-secondary"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1">
                <PortalSidebar
                  menu={data.menu}
                  activeIndex={menuIndex}
                  surface={surface}
                  onSelectApp={(index) => {
                    const item = data.menu[index]
                    if (!item) return
                    setMenuIndex(index)
                    setAppId(item.appId)
                    setSlider(null)
                    setSurface('page')
                  }}
                  onOpenCrm={() => { setSlider(null); setSurface('deal') }}
                />

                <div ref={workspaceRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin bg-bg">
                  {surface === 'deal' ? (
                    <DealCard
                      deal={deal}
                      deals={data.deals}
                      onDealChange={setDealId}
                      widgets={dealWidgets}
                      activeTab={dealTab}
                      onTabChange={setDealTab}
                      refreshedAt={dealRefreshedAt}
                    >
                      {/* Вкладка карточки не тянется на всю область: боевой портал даёт
                          виджету стартовую высоту, а дальше её задаёт сам виджет. */}
                      {renderFrame(480)}
                    </DealCard>
                  ) : (
                    <div className="flex h-full min-h-0 flex-col">
                      <WorkspaceHeader
                        title={frameTitle ?? frameApp?.title ?? app?.title ?? 'Приложение'}
                        placement={framePlacement}
                        appSid={session?.appSid ?? null}
                        install={session?.install ?? false}
                      />
                      <div className="min-h-0 flex-1">{renderFrame('fill')}</div>
                    </div>
                  )}
                </div>
              </div>

              {slider ? (
                <AppSlider
                  title={sliderTitle ?? sliderApp?.title ?? 'Приложение'}
                  subtitle={`PLACEMENT=${DEFAULT_PLACEMENT} · APP_SID=${slider.appSid}`}
                  onClose={() => setSlider(null)}
                >
                  <AppFrame
                    key={slider.key}
                    session={slider}
                    title={sliderApp?.title ?? 'Приложение'}
                    portal={portal}
                    user={acting}
                    handlers={handlers}
                    onLog={log.push}
                    onTitle={setSliderTitle}
                    defaultHeight="fill"
                  />
                </AppSlider>
              ) : null}

              <PortalDialogs request={dialog} staff={staff} deals={data.deals} onResolve={resolveDialog} />
            </>
          ) : (
            <EmptyState title="Портал недоступен" description="Обновите страницу: данные портала не загрузились" />
          )}
        </Panel>

        {logOpen ? <BridgeLogPanel log={log} className="w-[330px] shrink-0" /> : null}
      </main>
    </>
  )
}

/** Ошибки кабинета уезжают во фрейм полем error кадра result, а не всплывают на экран. */
async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await api.post<T>(path, body)
  } catch (e) {
    throw toBridgeError(e)
  }
}

async function apiGet<T>(path: string): Promise<T> {
  try {
    return await api.get<T>(path)
  } catch (e) {
    throw toBridgeError(e)
  }
}

function toBridgeError(e: unknown): BridgeCommandError {
  return e instanceof ApiError
    ? new BridgeCommandError(e.code, e.message)
    : new BridgeCommandError('ERROR', 'Портал не смог выполнить команду')
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

/**
 * Настройки приложения. Боевой портал хранит их у себя и отдаёт при следующем запуске;
 * здесь довольно localStorage браузера — переживать перезагрузку страницы им хватает,
 * а сервер портала эти значения всё равно никому больше не показывает.
 */
function userOptionKey(appId: string, userId: number): string {
  return `apistend.b24.userOption.${appId}.${userId}`
}

function appOptionKey(appId: string): string {
  return `apistend.b24.appOption.${appId}`
}

function readOption(key: string, params: unknown): unknown {
  const name = String(bridgeArg(params, 'name', 0) ?? '')
  // Непрочитанная настройка — пустая строка, а не null: так отвечает боевой портал,
  // и приложение сравнивает результат именно с ''.
  return readOptions(key)[name] ?? ''
}

function writeOption(key: string, params: unknown): boolean {
  const name = String(bridgeArg(params, 'name', 0) ?? '')
  if (!name) throw new BridgeCommandError('INVALID_PARAMS', 'Не указано имя настройки')
  const values = readOptions(key)
  values[name] = bridgeArg(params, 'value', 1) ?? null
  try {
    localStorage.setItem(key, JSON.stringify(values))
  } catch {
    throw new BridgeCommandError('STORAGE_UNAVAILABLE', 'Браузер не дал сохранить настройку')
  }
  return true
}

function readOptions(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // Приватный режим и запрет хранилища: настроек просто нет.
    return {}
  }
}
