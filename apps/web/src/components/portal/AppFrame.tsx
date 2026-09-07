'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { SkeletonRows, cn } from '@apistend/ui'
import {
  B24_APP_STATUS_LOCAL,
  B24_TOKEN_TTL_SECONDS,
  BX24_BRIDGE_NS,
  BX24_BRIDGE_VERSION,
  isBx24BridgeFrame,
} from '@apistend/shared'
import type { Bx24BridgeCommand, Bx24CallFrame, Bx24InitFrame, Bx24ResultFrame } from '@apistend/shared'
import type { B24Portal } from '@/lib/b24'
import { summarize, type BridgeLogger } from './BridgeLog'

/**
 * Фрейм приложения и портальная сторона моста BX24.js.
 *
 * Боевой Bitrix24 открывает приложение POST-запросом: DOMAIN, PROTOCOL, LANG и APP_SID
 * уходят в query-строку, токены и контекст встраивания — в тело. Повторяется дословно,
 * вплоть до имени фрейма: библиотека читает APP_SID в том числе из window.name,
 * поэтому name фрейма — это APP_SID, а не что-то удобное для разметки.
 *
 * Атрибута src у фрейма нет и быть не может: содержимое приходит ответом на отправку
 * скрытой формы. Отсюда же порядок — сначала фрейм оказывается в DOM со своим именем,
 * и только потом уходит форма.
 */

/** Сколько ждать первый кадр моста, прежде чем показать подсказку. */
const BRIDGE_TIMEOUT_MS = 8_000

/** Ниже этой высоты фрейм схлопывается в полосу и выглядит сломанным. */
const MIN_FRAME_HEIGHT = 120

/** Сотрудник портала, от имени которого открыто приложение. */
export interface ActingUser {
  readonly id: number
  readonly name: string
  readonly isAdmin: boolean
}

/**
 * Открытая сессия фрейма — ответ POST /api/b24/apps/:id/open.
 * key растёт при каждом открытии: страница монтирует новый AppFrame, а не чинит старый.
 */
export interface FrameSession {
  readonly key: number
  readonly appId: string
  readonly appSid: string
  readonly action: string
  readonly install: boolean
  readonly fields: Record<string, string>
}

export interface BridgeContext {
  readonly appId: string
  readonly appSid: string
  readonly placement: string
  readonly placementOptions: Record<string, unknown>
}

export type BridgeHandler = (params: unknown, ctx: BridgeContext) => unknown

export type BridgeHandlers = Partial<Record<Bx24BridgeCommand, BridgeHandler>>

/** Ошибка команды с кодом: уезжает во фрейм полем error кадра result. */
export class BridgeCommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeCommandError'
    this.code = code
  }
}

/**
 * js-интерфейс точки встраивания — то, что приложение получает из
 * BX24.placement.getInterface(). У карточки CRM документирована ровно одна команда,
 * reloadData, и своих событий у вкладки нет. Пустой интерфейс — это не заглушка:
 * у большинства точек встраивания его действительно нет.
 */
const PLACEMENT_INTERFACE: Record<string, { command: string[]; event: string[] }> = {
  CRM_DEAL_DETAIL_TAB: { command: ['reloadData'], event: [] },
  CRM_LEAD_DETAIL_TAB: { command: ['reloadData'], event: [] },
  CRM_CONTACT_DETAIL_TAB: { command: ['reloadData'], event: [] },
  CRM_COMPANY_DETAIL_TAB: { command: ['reloadData'], event: [] },
}

const NO_PLACEMENT_INTERFACE = { command: [], event: [] }

export function placementInterfaceFor(placement: string): { command: string[]; event: string[] } {
  return PLACEMENT_INTERFACE[placement] ?? NO_PLACEMENT_INTERFACE
}

export function placementOf(session: FrameSession): string {
  return session.fields.PLACEMENT ?? 'DEFAULT'
}

/**
 * PLACEMENT_OPTIONS читаем обратно из полей формы, а не из того, что просили у API:
 * приложение получило именно эту строку, и мост обязан показывать её же.
 */
export function placementOptionsOf(session: FrameSession): Record<string, unknown> {
  const raw = session.fields.PLACEMENT_OPTIONS
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Параметр команды моста.
 *
 * Библиотека вправе передать аргументы BX24.* и как именованный объект, и как
 * позиционный массив, а односложные вызовы вроде BX24.setTitle('…') — просто
 * значением. Разбираем все три формы, иначе поведение зависит от того, как именно
 * библиотека разложила аргументы.
 */
export function bridgeArg(params: unknown, name: string, index: number): unknown {
  if (Array.isArray(params)) return params[index]
  if (typeof params === 'object' && params !== null) return (params as Record<string, unknown>)[name]
  return index === 0 ? params : undefined
}

export function bridgeParams(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {}
}

/** Числовой параметр команды: библиотека вправе прислать и строку из формы. */
export function bridgeNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

function buildInit(session: FrameSession, portal: B24Portal, user: ActingUser): Bx24InitFrame {
  const f = session.fields
  return {
    ns: BX24_BRIDGE_NS,
    v: BX24_BRIDGE_VERSION,
    type: 'init',
    appSid: session.appSid,
    auth: {
      access_token: f.AUTH_ID ?? '',
      refresh_token: f.REFRESH_ID ?? '',
      expires_in: bridgeNumber(f.AUTH_EXPIRES) ?? B24_TOKEN_TTL_SECONDS,
      domain: portal.domain,
      member_id: f.member_id ?? portal.memberId,
      status: f.status ?? B24_APP_STATUS_LOCAL,
      client_endpoint: portal.restUrl,
      server_endpoint: f.SERVER_ENDPOINT ?? portal.oauthUrl,
    },
    domain: portal.domain,
    lang: portal.lang,
    isAdmin: user.isAdmin,
    userId: user.id,
    firstRun: session.install,
    placement: placementOf(session),
    placementOptions: placementOptionsOf(session),
    placementInterface: placementInterfaceFor(placementOf(session)),
  }
}

export function AppFrame({
  session, title, portal, user, handlers, onLog, onTitle, defaultHeight = 'fill', className,
}: {
  session: FrameSession
  /** Название приложения — уходит в атрибут title фрейма. */
  title: string
  portal: B24Portal
  user: ActingUser
  handlers: BridgeHandlers
  onLog: BridgeLogger
  onTitle?: (title: string) => void
  /** Высота до первого resizeWindow: «fill» — на всю рабочую область. */
  defaultHeight?: number | 'fill'
  className?: string
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const submitted = useRef(false)
  const [height, setHeight] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [bridged, setBridged] = useState(false)
  const [stalled, setStalled] = useState(false)

  // Обработчики и окружение читаются в момент прихода кадра: пересобирать
  // подписку на message из-за смены пропсов незачем, а терять свежие значения нельзя.
  const latest = useRef({ portal, user, handlers, onLog, onTitle })
  useEffect(() => {
    latest.current = { portal, user, handlers, onLog, onTitle }
  })

  const submitForm = useCallback(() => {
    const form = formRef.current
    if (!form) return
    form.submit()
    latest.current.onLog({
      dir: 'out',
      appSid: session.appSid,
      label: 'POST',
      summary: `${placementOf(session)} → ${session.action}`,
      payload: { action: session.action, target: session.appSid, fields: session.fields },
    })
  }, [session])

  useEffect(() => {
    // StrictMode в dev монтирует эффекты дважды, а повторный POST — это второй
    // запуск приложения и лишняя пара токенов в журнале.
    if (submitted.current) return
    submitted.current = true
    submitForm()
  }, [submitForm])

  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), BRIDGE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    const appSid = session.appSid

    function reply(origin: string, frame: Bx24InitFrame | Bx24ResultFrame): void {
      const win = iframeRef.current?.contentWindow
      if (!win) return
      try {
        // Строго на origin, с которого пришёл кадр: в теле init лежат токены портала.
        win.postMessage(frame, origin)
      } catch {
        latest.current.onLog({
          dir: 'out', appSid, label: frame.type, failed: true,
          summary: `кадр не ушёл: origin ${origin} недоступен`, payload: frame,
        })
      }
    }

    /** Команды, которые умеет только сам фрейм. Остальное — дело страницы портала. */
    const local: Record<string, BridgeHandler> = {
      // Ширину не трогаем: фрейм всегда во всю рабочую область, как и в боевом портале.
      resizeWindow: (params) => {
        const h = bridgeNumber(bridgeArg(params, 'height', 1))
        if (h !== null) setHeight(Math.max(MIN_FRAME_HEIGHT, Math.round(h)))
        return true
      },
      // Высоту документа считает сама библиотека: чужой документ порталу не измерить.
      // Портал только применяет присланное, а без него возвращает высоту по умолчанию.
      fitWindow: (params) => {
        const h = bridgeNumber(bridgeArg(params, 'height', 1))
        setHeight(h === null ? null : Math.max(MIN_FRAME_HEIGHT, Math.round(h)))
        return true
      },
      setTitle: (params) => {
        latest.current.onTitle?.(String(bridgeArg(params, 'title', 0) ?? ''))
        return true
      },
      // Перезагрузка страницы с приложением — это повторная отправка той же формы.
      reloadWindow: () => {
        submitForm()
        return true
      },
    }

    async function onCall(frame: Bx24CallFrame, origin: string): Promise<void> {
      const { onLog } = latest.current
      onLog({ dir: 'in', appSid, label: frame.method, summary: summarize(frame.params), payload: frame })

      const handler = local[frame.method] ?? latest.current.handlers[frame.method as Bx24BridgeCommand]
      const base = { ns: BX24_BRIDGE_NS, v: BX24_BRIDGE_VERSION, type: 'result', appSid, id: frame.id } as const

      let result: Bx24ResultFrame
      if (!handler) {
        result = {
          ...base,
          error: { code: 'UNKNOWN_COMMAND', message: `Портал не знает команду «${frame.method}»` },
        }
      } else {
        const ctx: BridgeContext = {
          appId: session.appId,
          appSid,
          placement: placementOf(session),
          placementOptions: placementOptionsOf(session),
        }
        try {
          result = { ...base, result: await handler(frame.params, ctx) }
        } catch (e) {
          const code = e instanceof BridgeCommandError ? e.code : 'ERROR'
          const message = e instanceof Error ? e.message : 'Портал не смог выполнить команду'
          result = { ...base, error: { code, message } }
        }
      }

      onLog({
        dir: 'out',
        appSid,
        label: frame.method,
        failed: result.error !== undefined,
        summary: result.error ? `ошибка ${result.error.code}: ${result.error.message}` : summarize(result.result),
        payload: result,
      })
      reply(origin, result)
    }

    function onMessage(event: MessageEvent): void {
      const frame: unknown = event.data
      if (!isBx24BridgeFrame(frame)) return
      const win = iframeRef.current?.contentWindow
      // На странице портала одновременно живут несколько фреймов — вкладка карточки,
      // слайдер, фоновый обработчик. Кадр обязан прийти именно из нашего.
      if (!win || event.source !== win) return
      if (frame.appSid !== session.appSid) return

      if (frame.type === 'hello') {
        setBridged(true)
        latest.current.onLog({
          dir: 'in', appSid, label: 'hello', summary: 'библиотека загрузилась и ждёт данные среды', payload: frame,
        })
        const init = buildInit(session, latest.current.portal, latest.current.user)
        latest.current.onLog({
          dir: 'out',
          appSid,
          label: 'init',
          summary: `${init.placement} · ${latest.current.user.name}${init.firstRun ? ' · первый запуск' : ''}`,
          payload: init,
        })
        reply(event.origin, init)
        return
      }

      if (frame.type === 'call') {
        setBridged(true)
        void onCall(frame, event.origin)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [session, submitForm])

  const explicitHeight = height ?? (defaultHeight === 'fill' ? null : defaultHeight)

  return (
    <div
      className={cn('relative', explicitHeight === null ? 'h-full' : 'shrink-0', className)}
      style={explicitHeight === null ? undefined : { height: explicitHeight }}
    >
      <iframe
        ref={iframeRef}
        name={session.appSid}
        title={title}
        onLoad={() => setLoaded(true)}
        className="h-full w-full border-0 bg-surface"
      />

      {/*
        Форма живёт рядом с фреймом и отправляется в него по имени. display:none
        отправке не мешает, а видимой она быть не должна: в скрытых полях токены.
      */}
      <form
        ref={formRef}
        action={session.action}
        method="post"
        target={session.appSid}
        acceptCharset="UTF-8"
        className="hidden"
      >
        {Object.entries(session.fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} readOnly />
        ))}
      </form>

      {!bridged && !loaded && !stalled ? (
        <div className="absolute inset-0 bg-surface">
          <SkeletonRows rows={6} />
        </div>
      ) : null}

      {stalled && !bridged ? <StalledHint loaded={loaded} action={session.action} portal={portal} /> : null}
    </div>
  )
}

/**
 * Подсказка на молчащий фрейм.
 *
 * Если страница загрузилась, но моста нет, перекрывать её нельзя — приложение
 * могло отрисоваться и без библиотеки. Тогда подсказка становится полосой снизу.
 */
function StalledHint({ loaded, action, portal }: { loaded: boolean; action: string; portal: B24Portal }) {
  const origin = typeof window === 'undefined' ? `${portal.protocol === '1' ? 'https' : 'http'}://${portal.domain}` : window.location.origin

  const body = (
    <>
      <p className="flex items-center gap-[8px] text-[14px] font-semibold text-text-primary">
        <TriangleAlert size={16} className="shrink-0 text-warning" aria-hidden />
        Приложение не вышло на связь
      </p>
      <p className="text-[13px] leading-[1.5] text-text-secondary">
        За 8 секунд от фрейма не пришло ни одного кадра моста.{' '}
        {loaded ? 'Страница во фрейме загрузилась, значит проверять стоит саму страницу:' : 'Фрейм не загрузил страницу — проверьте по порядку:'}
      </p>
      <ul className="flex flex-col gap-[4px] text-[12px] leading-[1.5] text-text-secondary">
        <li>
          — обработчик <span className="font-mono text-[11px] text-text-primary">{action}</span> отвечает
          на <span className="font-mono text-[11px]">POST</span>, а не только на GET, и отдаёт HTML;
        </li>
        <li>
          — страница подключает библиотеку{' '}
          <span className="font-mono text-[11px] text-text-primary">{portal.bx24JsUrl}</span> и вызывает{' '}
          <span className="font-mono text-[11px]">BX24.init()</span>;
        </li>
        <li>
          — приложение не запрещает фрейминг: заголовки{' '}
          <span className="font-mono text-[11px]">X-Frame-Options</span> и{' '}
          <span className="font-mono text-[11px]">Content-Security-Policy: frame-ancestors</span> должны
          разрешать <span className="font-mono text-[11px] text-text-primary">{origin}</span>.
        </li>
      </ul>
      <p className="text-[11px] leading-[1.5] text-text-tertiary">
        В боевом портале это выглядит так же: пустой фрейм и молчащая библиотека. Проверку фрейминга
        делает браузер, и APIStend обойти её не может.
      </p>
    </>
  )

  if (loaded) {
    return (
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-[8px] border-t border-border bg-warning-soft/60 p-[16px]">
        {body}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-[10px] bg-surface p-[24px]">{body}</div>
  )
}
