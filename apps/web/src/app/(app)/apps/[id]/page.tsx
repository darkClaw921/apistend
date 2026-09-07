'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, LayoutGrid, Radio, TriangleAlert } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, CounterChip, DataTable, EmptyState, ErrorState,
  Panel, PanelFooter, PanelHeader, SkeletonRows, StatusChip, formatDate, formatDayTime,
  formatInt, formatRelative,
} from '@apistend/ui'
import type { ChipTone, Column } from '@apistend/ui'
import { findB24Placement } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import type {
  B24AppResponse, B24AppState, B24EventHandlerItem, B24PlacementItem,
  B24SessionItem, B24TokenItem,
} from '@/lib/b24'
import { Topbar } from '@/components/Topbar'
import { B24AppForm, B24_APP_KIND_LABEL } from '@/components/B24AppForm'

/**
 * Карточка локального приложения: всё, что боевой портал показывает разработчику
 * о его приложении, и то, что в бою узнать негде — выданные токены и журнал открытий фрейма.
 *
 * Секрет показан открыто. Это демонстрационный портал, и смысл экрана в том, чтобы
 * пару client_id/client_secret можно было скопировать прямо в свой код.
 */

const STATE_LABEL: Readonly<Record<B24AppState, string>> = {
  awaiting_install: 'Не установлено',
  installed: 'Установлено',
  uninstalled: 'Удалено',
}
const STATE_TONE: Readonly<Record<B24AppState, ChipTone>> = {
  awaiting_install: 'warning',
  installed: 'success',
  uninstalled: 'neutral',
}

/** Как виджет появляется на странице портала — словами, а не кодом surface. */
const SURFACE_LABEL: Readonly<Record<string, string>> = {
  page: 'Отдельная страница',
  tab: 'Вкладка в карточке',
  menu: 'Пункт меню',
  slider: 'Слайдер поверх страницы',
  background: 'Фоновый фрейм, без интерфейса',
}

/**
 * auth_type — идентификатор сотрудника, под которым авторизуется обработчик события.
 * Ноль означает того, чьи действия событие и вызвали.
 */
function authTypeLabel(authType: number): string {
  return authType === 0 ? 'сотрудник, вызвавший событие' : `сотрудник № ${authType}`
}

export default function B24AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [data, setData] = useState<B24AppResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.get<B24AppResponse>(`/api/b24/apps/${id}`))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить приложение')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  const app = data?.app ?? null

  async function act(action: string, path: string) {
    setBusy(action)
    try {
      await api.post(path)
      setError(null)
      await load()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось выполнить действие')
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setBusy('delete')
    try {
      await api.post(`/api/b24/apps/${id}/delete`)
      router.push('/apps')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось удалить приложение')
      setBusy(null)
    }
  }

  const placementColumns: Array<Column<B24PlacementItem>> = useMemo(
    () => [
      {
        key: 'placement', header: 'Код', width: 218,
        render: (p) => (
          <span className="flex min-w-0 items-center gap-[8px]">
            <span className="truncate font-mono text-[12px] text-text-primary">{p.placement}</span>
            {p.known ? null : <StatusChip tone="warning">неизвестен</StatusChip>}
          </span>
        ),
      },
      {
        key: 'title', header: 'Название', width: 134,
        render: (p) => <span className="truncate text-text-secondary">{p.title ?? '—'}</span>,
      },
      {
        key: 'handler', header: 'Обработчик', mono: true,
        render: (p) => <span className="truncate text-text-secondary" title={p.handler}>{p.handler}</span>,
      },
      {
        key: 'surface', header: 'Где появляется', width: 186,
        render: (p) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] text-text-primary">
              {(p.surface ? SURFACE_LABEL[p.surface] : undefined) ?? 'место не определено'}
            </span>
            <span className="truncate text-[11px] text-text-tertiary">
              {findB24Placement(p.placement)?.title ?? 'портал такого кода не знает'}
            </span>
          </span>
        ),
      },
    ],
    [],
  )

  const handlerColumns: Array<Column<B24EventHandlerItem>> = useMemo(
    () => [
      {
        key: 'event', header: 'Событие', width: 218, mono: true,
        render: (h) => <span className="truncate text-text-primary">{h.event}</span>,
      },
      {
        key: 'handler', header: 'Обработчик', mono: true,
        render: (h) => <span className="truncate text-text-secondary" title={h.handler}>{h.handler}</span>,
      },
      {
        key: 'authType', header: 'Авторизация', width: 224,
        render: (h) => <span className="truncate text-text-secondary">{authTypeLabel(h.authType)}</span>,
      },
    ],
    [],
  )

  const tokenColumns: Array<Column<B24TokenItem>> = useMemo(
    () => [
      {
        key: 'access', header: 'access_token',
        render: (t) => <CopyValue value={t.accessToken} label="access_token" />,
      },
      {
        key: 'refresh', header: 'refresh_token', width: 190,
        render: (t) => <CopyValue value={t.refreshToken} label="refresh_token" />,
      },
      {
        key: 'expires', header: 'Действует до', width: 148, mono: true,
        render: (t) => <span className="text-text-secondary">{formatDayTime(t.expiresAt)}</span>,
      },
      {
        key: 'state', header: 'Состояние', width: 118,
        render: (t) => (
          t.revokedAt !== null
            ? <StatusChip tone="neutral">Отозван</StatusChip>
            : t.expired
              ? <StatusChip tone="danger">Истёк</StatusChip>
              : <StatusChip tone="success">Действует</StatusChip>
        ),
      },
      {
        key: 'user', header: 'Сотрудник', width: 96, align: 'right', mono: true,
        render: (t) => <span className="text-text-secondary">№ {t.portalUserId}</span>,
      },
    ],
    [],
  )

  const sessionColumns: Array<Column<B24SessionItem>> = useMemo(
    () => [
      {
        key: 'appSid', header: 'APP_SID',
        render: (s) => <CopyValue value={s.appSid} label="APP_SID" />,
      },
      {
        key: 'placement', header: 'Точка встраивания', width: 200, mono: true,
        render: (s) => <span className="truncate text-text-secondary">{s.placement}</span>,
      },
      {
        key: 'kind', header: 'Открытие', width: 148,
        render: (s) => (
          <span className="text-text-secondary">{s.isInstall ? 'Мастер установки' : 'Обработчик'}</span>
        ),
      },
      {
        key: 'finished', header: 'Установка', width: 176,
        render: (s) => (
          s.isInstall
            ? s.finishedAt !== null
              ? <StatusChip tone="success">installFinish получен</StatusChip>
              : <StatusChip tone="warning">ждёт installFinish</StatusChip>
            : <span className="text-[12px] text-text-tertiary">—</span>
        ),
      },
      {
        key: 'createdAt', header: 'Открыто', width: 128, align: 'right',
        render: (s) => (
          <span className="flex flex-col items-end">
            <span className="font-mono text-[12px] text-text-secondary tabular">{formatDayTime(s.createdAt)}</span>
            <span className="text-[11px] text-text-tertiary">{formatRelative(s.createdAt)}</span>
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <>
      <Topbar
        breadcrumb={`Локальные приложения / ${app?.title ?? '…'}`}
        title={app?.title ?? 'Приложение'}
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={
          <ButtonPrimary disabled={app === null} onClick={() => router.push(`/portal?app=${id}`)}>
            Открыть приложение
          </ButtonPrimary>
        }
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto scrollbar-thin p-[24px]">
        {data === null || app === null ? (
          <Panel className="shrink-0">
            {loading ? <SkeletonRows rows={6} /> : <ErrorState message={error ?? 'Приложение не найдено'} onRetry={() => void load()} />}
          </Panel>
        ) : (
          <>
            {error ? (
              <section role="alert" className="shrink-0 rounded-[10px] border border-danger bg-danger-soft px-[16px] py-[12px] text-[12px] text-danger">
                {error}
              </section>
            ) : null}

            {app.installed ? null : (
              <section className="flex shrink-0 items-start gap-[12px] rounded-[10px] border border-border bg-warning-soft p-[16px]">
                <TriangleAlert size={16} className="mt-[1px] shrink-0 text-warning" aria-hidden />
                <div className="min-w-0">
                  <h2 className="text-[13px] font-semibold text-text-primary">Приложение ещё не установлено</h2>
                  <p className="mt-[3px] text-[12px] leading-[1.5] text-text-secondary">
                    Пока приложение не вызвало BX24.installFinish(), портал не доставляет ему события
                    и не показывает зарегистрированные виджеты. Боевой Bitrix24 ведёт себя так же:
                    карточка приложения уже есть, а установленного приложения на портале ещё нет.
                  </p>
                </div>
              </section>
            )}

            <div className="flex min-h-0 shrink-0 gap-[20px]">
              <div className="flex min-w-0 flex-1 flex-col gap-[20px]">
                <Panel className="shrink-0">
                  <PanelHeader title="Ключи авторизации" />
                  <div className="grid grid-cols-2 gap-[14px] p-[16px]">
                    <KeyRow label="client_id" value={app.clientId} />
                    <KeyRow label="client_secret" value={app.clientSecret} />
                    <KeyRow label="APPLICATION_TOKEN" value={app.applicationToken} />
                    <KeyRow label="member_id" value={data.portal.memberId} />
                  </div>
                  <PanelFooter left="Секрет показан открыто и не маскируется: это демонстрационный портал, и смысл экрана в том, чтобы пару можно было скопировать прямо в свой код." />
                </Panel>

                <Panel className="shrink-0">
                  <PanelHeader
                    title="Виджеты"
                    count={<CounterChip>{app.placements.length}</CounterChip>}
                    subtitle="точки встраивания"
                  />
                  {app.placements.length > 0 ? (
                    <DataTable columns={placementColumns} rows={app.placements} rowKey={(p) => p.id} />
                  ) : (
                    <>
                      <EmptyState
                        icon={<LayoutGrid size={20} aria-hidden />}
                        title="Виджетов нет"
                        description="Портал их не создаёт: приложение регистрирует себя само, вызовом placement.bind. Незнакомый код встраивания портал отклонит — как и боевой."
                      />
                      <div className="px-[16px] pb-[16px]">
                        <CodeBlock size="sm" language="text" code={PLACEMENT_EXAMPLE} />
                      </div>
                    </>
                  )}
                </Panel>

                <Panel className="shrink-0">
                  <PanelHeader
                    title="Подписки на события"
                    count={<CounterChip>{app.handlers.length}</CounterChip>}
                  />
                  {app.handlers.length > 0 ? (
                    <DataTable columns={handlerColumns} rows={app.handlers} rowKey={(h) => h.id} />
                  ) : (
                    <>
                      <EmptyState
                        icon={<Radio size={20} aria-hidden />}
                        title="Подписок нет"
                        description="Приложение подписывается само, вызовом event.bind. До installFinish портал события не доставляет, даже если подписка уже зарегистрирована."
                      />
                      <div className="px-[16px] pb-[16px]">
                        <CodeBlock size="sm" language="text" code={EVENT_EXAMPLE} />
                      </div>
                    </>
                  )}
                </Panel>

                <Panel className="shrink-0">
                  <PanelHeader
                    title="Токены"
                    count={<CounterChip>{app.tokens.length}</CounterChip>}
                    right={
                      <ButtonSecondary
                        tone="quiet"
                        disabled={busy !== null}
                        onClick={() => void act('token', `/api/b24/apps/${id}/token`)}
                      >
                        {busy === 'token' ? 'Выпускаем…' : 'Выпустить новую пару'}
                      </ButtonSecondary>
                    }
                  />
                  {app.tokens.length > 0 ? (
                    <DataTable columns={tokenColumns} rows={app.tokens} rowKey={(t) => t.id} />
                  ) : (
                    <EmptyState
                      title="Токенов ещё не было"
                      description="Пара выдаётся, когда портал открывает приложение во фрейме или когда приложение меняет refresh_token на новую пару."
                    />
                  )}
                </Panel>

                <Panel className="shrink-0">
                  <PanelHeader
                    title="Открытия во фрейме"
                    count={<CounterChip>{app.sessions.length}</CounterChip>}
                    subtitle="последние сессии"
                  />
                  {app.sessions.length > 0 ? (
                    <DataTable dense columns={sessionColumns} rows={app.sessions} rowKey={(s) => s.id} />
                  ) : (
                    <EmptyState
                      title="Приложение ещё не открывали"
                      description="APP_SID появится здесь после первого открытия во фрейме портала."
                    />
                  )}
                </Panel>
              </div>

              <div className="w-[380px] shrink-0">
                <Panel>
                  <PanelHeader title="Параметры" />
                  <dl className="flex flex-col gap-[12px] p-[16px]">
                    <ParamRow label="Вид">
                      <StatusChip tone={app.kind === 'server_ui' ? 'info' : 'neutral'}>
                        {B24_APP_KIND_LABEL[app.kind]}
                      </StatusChip>
                    </ParamRow>

                    <ParamRow label={`Права доступа · ${formatInt(app.scope.length)}`}>
                      {app.scope.length > 0 ? (
                        <span className="flex flex-wrap gap-[5px]">
                          {app.scope.map((s) => (
                            <span key={s} className="rounded-[4px] bg-surface-2 px-[6px] py-[2px] font-mono text-[11px] text-text-secondary">
                              {s}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[12px] text-text-tertiary">не заданы — REST ответит insufficient_scope</span>
                      )}
                    </ParamRow>

                    <ParamRow label="Путь обработчика">
                      <span className="block truncate font-mono text-[12px] text-text-primary" title={app.handlerUrl ?? ''}>
                        {app.handlerUrl ?? '—'}
                      </span>
                    </ParamRow>

                    <ParamRow label="Путь установки">
                      <span className="block truncate font-mono text-[12px] text-text-primary" title={app.installUrl ?? ''}>
                        {app.installUrl ?? '—'}
                      </span>
                    </ParamRow>

                    {app.kind === 'server_ui' ? (
                      <ParamRow label="Пункт меню">
                        <span className="block truncate text-[12px] text-text-primary">{app.menuTitle ?? '—'}</span>
                      </ParamRow>
                    ) : null}

                    <ParamRow label="Состояние">
                      <span className="flex flex-wrap items-center gap-[8px]">
                        <StatusChip tone={STATE_TONE[app.state]}>{STATE_LABEL[app.state]}</StatusChip>
                        {app.installedAt ? (
                          <span className="text-[11px] text-text-tertiary tabular">{formatDayTime(app.installedAt)}</span>
                        ) : null}
                      </span>
                      {app.lastInstallNote ? (
                        <p className="mt-[4px] text-[11px] leading-[1.4] text-text-tertiary">{app.lastInstallNote}</p>
                      ) : null}
                    </ParamRow>

                    <ParamRow label="Версия и дата">
                      <span className="font-mono text-[12px] text-text-secondary tabular">
                        {formatInt(app.version)} · {formatDate(app.createdAt)}
                      </span>
                    </ParamRow>
                  </dl>

                  {confirmDelete ? (
                    <div className="border-t border-border bg-danger-soft px-[16px] py-[12px]">
                      <p className="text-[12px] leading-[1.5] text-text-secondary">
                        Удалить приложение «{app.title}»? Вместе с карточкой исчезнут выданные токены,
                        зарегистрированные виджеты и подписки на события.
                      </p>
                      <div className="mt-[10px] flex gap-[8px]">
                        <ButtonSecondary className="flex-1" onClick={() => setConfirmDelete(false)}>
                          Отмена
                        </ButtonSecondary>
                        <ButtonSecondary tone="danger" className="flex-1" disabled={busy !== null} onClick={() => void remove()}>
                          {busy === 'delete' ? 'Удаляем…' : 'Удалить'}
                        </ButtonSecondary>
                      </div>
                    </div>
                  ) : (
                    <PanelFooter
                      left={
                        <span className="flex gap-[8px]">
                          <ButtonSecondary tone="quiet" onClick={() => setEditing(true)}>Изменить</ButtonSecondary>
                          <ButtonSecondary
                            tone="quiet"
                            disabled={busy !== null}
                            onClick={() => void act('reinstall', `/api/b24/apps/${id}/reinstall`)}
                          >
                            {busy === 'reinstall' ? 'Сбрасываем…' : 'Сбросить установку'}
                          </ButtonSecondary>
                        </span>
                      }
                      right={
                        <ButtonSecondary tone="quiet" onClick={() => setConfirmDelete(true)}>Удалить</ButtonSecondary>
                      }
                    />
                  )}
                </Panel>
              </div>
            </div>
          </>
        )}
      </main>

      {editing && app && data ? (
        <B24AppForm
          scopes={data.scopes}
          app={app}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false)
            setData((cur) => (cur ? { ...cur, app: saved } : cur))
          }}
        />
      ) : null}
    </>
  )
}

const PLACEMENT_EXAMPLE = `BX24.callMethod('placement.bind', {
  PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
  HANDLER: 'http://localhost:3000/b24/deal-tab',
  TITLE: 'Отгрузки',
})`

const EVENT_EXAMPLE = `BX24.callMethod('event.bind', {
  event: 'ONCRMDEALUPDATE',
  handler: 'http://localhost:3000/b24/events',
})`

/** Значение, которое разработчик копирует в свой код: моноширинное, целиком, с кнопкой. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Буфер обмена недоступен (не https, нет разрешения) — молча ничего не делаем.
    }
  }

  return (
    <span className="flex min-w-0 items-center gap-[8px]">
      <span className="min-w-0 truncate font-mono text-[12px] text-text-primary" title={value}>{value}</span>
      <button
        type="button"
        aria-label={`Копировать ${label}`}
        onClick={() => void copy()}
        className="shrink-0 text-text-tertiary hover:text-text-secondary"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  )
}

function KeyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px]">
      <span className="font-mono text-[11px] text-text-tertiary">{label}</span>
      <CopyValue value={value} label={label} />
    </div>
  )
}

function ParamRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[4px]">
      <dt className="text-[11px] text-text-tertiary">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
