'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AppWindow, RefreshCw } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, CounterChip, DataTable, EmptyState, ErrorState,
  Panel, PanelHeader, SearchField, SegmentControl, SkeletonRows, StatusChip, formatInt,
} from '@apistend/ui'
import type { ChipTone, Column } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { B24AppItem, B24AppState, B24AppsResponse, B24Portal } from '@/lib/b24'
import { Topbar } from '@/components/Topbar'
import { B24AppForm, B24_APP_KIND_SHORT } from '@/components/B24AppForm'

/**
 * Раздел «Локальные приложения»: список карточек, зарегистрированных на демо-портале.
 *
 * Боевой Bitrix24 на этом месте требует адрес, доступный порталу из внешней сети,
 * и по https. Поэтому в правой колонке — адреса портала песочницы и строка
 * подключения библиотеки: подменой этих адресов приложение и переезжает
 * со стенда на бой и обратно.
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

export default function B24AppsPage() {
  const router = useRouter()
  const [data, setData] = useState<B24AppsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.get<B24AppsResponse>('/api/b24/apps'))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить приложения')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => {
    const list = data?.apps ?? []
    return {
      all: list.length,
      installed: list.filter((a) => a.state === 'installed').length,
      awaiting: list.filter((a) => a.state === 'awaiting_install').length,
    }
  }, [data])

  const rows = useMemo(() => {
    let list = data?.apps ?? []
    if (filter === 'installed') list = list.filter((a) => a.state === 'installed')
    if (filter === 'awaiting') list = list.filter((a) => a.state === 'awaiting_install')
    const q = search.trim().toLowerCase()
    if (q === '') return list
    return list.filter(
      (a) => a.title.toLowerCase().includes(q) || a.code.includes(q) || a.clientId.toLowerCase().includes(q),
    )
  }, [data, filter, search])

  // Ширины подобраны под фактическую ширину панели: сайдбар 248, паддинг 24×2
  // и колонка портала 380 оставляют таблице около 680 px. Сумма фиксированных
  // колонок обязана быть меньше — иначе заголовки наезжают друг на друга,
  // а правые колонки уходят за край панели.
  const columns: Array<Column<B24AppItem>> = useMemo(
    () => [
      {
        key: 'title', header: 'Приложение',
        render: (a) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-text-primary">{a.title}</span>
            <span className="truncate font-mono text-[11px] text-text-tertiary">{a.clientId}</span>
          </span>
        ),
      },
      {
        key: 'kind', header: 'Вид', width: 140,
        render: (a) => <StatusChip tone={a.kind === 'server_ui' ? 'info' : 'neutral'}>{B24_APP_KIND_SHORT[a.kind]}</StatusChip>,
      },
      {
        key: 'scope', header: 'Права', width: 140,
        render: (a) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-[11px] text-text-secondary">
              {a.scope.slice(0, 2).join(' · ') || '—'}
            </span>
            <span className="text-[11px] text-text-tertiary tabular">
              {a.scope.length > 2 ? `и ещё ${formatInt(a.scope.length - 2)}` : `${formatInt(a.scope.length)} всего`}
            </span>
          </span>
        ),
      },
      {
        key: 'state', header: 'Установка', width: 140,
        render: (a) => <StatusChip tone={STATE_TONE[a.state]}>{STATE_LABEL[a.state]}</StatusChip>,
      },
      {
        key: 'placements', header: 'Виджеты', width: 78, align: 'right', mono: true,
        render: (a) => <span className="text-text-primary">{formatInt(a.placementsCount)}</span>,
      },
      {
        key: 'handlers', header: 'Подписки', width: 82, align: 'right', mono: true,
        render: (a) => <span className="text-text-primary">{formatInt(a.handlersCount)}</span>,
      },
    ],
    [],
  )

  return (
    <>
      <Topbar
        breadcrumb="Bitrix24 / Локальные приложения"
        title="Локальные приложения"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={<ButtonPrimary onClick={() => setCreating(true)}>Создать приложение</ButtonPrimary>}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto scrollbar-thin p-[24px]">
        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          <SegmentControl
            segments={[
              { value: 'all', label: 'Все', count: counts.all },
              { value: 'installed', label: 'Установленные', count: counts.installed },
              { value: 'awaiting', label: 'Ждут установки', count: counts.awaiting },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <div className="ml-auto flex items-center gap-[10px]">
            <SearchField value={search} onValueChange={setSearch} placeholder="Поиск по названию, коду, client_id" width={280} />
            <ButtonSecondary icon={<RefreshCw size={13} aria-hidden />} onClick={() => void load()}>
              Обновить
            </ButtonSecondary>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-[20px]">
          <Panel className="min-h-[320px] min-w-0 flex-1">
            <PanelHeader
              title="Приложения портала"
              count={<CounterChip>{data ? data.apps.length : '—'}</CounterChip>}
              subtitle="карточки, зарегистрированные на демо-портале"
            />
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {loading && !data ? (
                <SkeletonRows rows={6} />
              ) : error ? (
                <ErrorState message={error} onRetry={() => void load()} />
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={<AppWindow size={20} aria-hidden />}
                  title={counts.all === 0 ? 'Локальных приложений нет' : 'Ничего не нашлось'}
                  description={
                    counts.all === 0
                      ? 'Локальное приложение — карточка на портале: адрес обработчика, набор прав и пара client_id/client_secret. Портал открывает обработчик во фрейме и передаёт ему токены, а приложение ходит в REST от имени сотрудника — здесь для этого не нужны ни туннель наружу, ни сертификат.'
                      : 'Проверьте фильтр и написание названия, кода или client_id'
                  }
                  action={
                    counts.all === 0
                      ? <ButtonSecondary onClick={() => setCreating(true)}>Создать приложение</ButtonSecondary>
                      : undefined
                  }
                />
              ) : (
                <DataTable
                  columns={columns}
                  rows={rows}
                  rowKey={(a) => a.id}
                  onRowClick={(a) => router.push(`/apps/${a.id}`)}
                />
              )}
            </div>
          </Panel>

          <div className="flex w-[380px] shrink-0 flex-col gap-[20px]">
            <PortalPanel portal={data?.portal ?? null} />

            <Panel className="shrink-0">
              <PanelHeader title="Чем это отличается от боевого" />
              <ul className="flex flex-col gap-[10px] p-[16px] text-[12px] leading-[1.5] text-text-secondary">
                <li>
                  Адрес обработчика может быть на localhost и по http. Боевой портал такой адрес
                  отклоняет, и обычный цикл разработки требует туннеля наружу.
                </li>
                <li>
                  Всё остальное совпадает: набор полей во фрейме, конверт OAuth, коды ошибок и правило
                  «до installFinish события не доставляются, а виджеты не показываются».
                </li>
                <li>
                  Проверку фрейма делает браузер. Если приложение отдаёт X-Frame-Options: SAMEORIGIN,
                  фрейм останется пустым — ровно так же, как в бою.
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      </main>

      {creating && data ? (
        <B24AppForm
          scopes={data.scopes}
          onCancel={() => setCreating(false)}
          onSaved={(app) => { setCreating(false); router.push(`/apps/${app.id}`) }}
        />
      ) : null}
    </>
  )
}

/** Данные портала: то, что приложение подставляет вместо боевых адресов Bitrix24. */
function PortalPanel({ portal }: { portal: B24Portal | null }) {
  return (
    <Panel className="shrink-0">
      <PanelHeader title="Портал песочницы" />
      {portal ? (
        <div className="flex flex-col gap-[12px] p-[16px]">
          <dl className="flex flex-col gap-[8px]">
            <PortalRow label="DOMAIN" value={portal.domain} />
            <PortalRow
              label="PROTOCOL"
              value={portal.protocol === '1' ? '1 — https' : '0 — http'}
              note={portal.protocol === '0' ? 'у localhost сертификата нет, и приложение обязано это увидеть' : undefined}
            />
            <PortalRow label="member_id" value={portal.memberId} />
            <PortalRow label="REST портала" value={portal.restUrl} />
            <PortalRow label="Сервер авторизации" value={portal.oauthUrl} />
          </dl>

          <div>
            <p className="mb-[6px] text-[12px] font-medium text-text-secondary">Подключение библиотеки</p>
            <CodeBlock size="sm" language="text" code={`<script src="${portal.bx24JsUrl}"></script>`} />
            <p className="mt-[6px] text-[11px] leading-[1.4] text-text-tertiary">
              В боевом портале на этом месте стоит //api.bitrix24.tech/api/v1/. Поверхность BX24.*
              та же, меняется только адрес.
            </p>
          </div>
        </div>
      ) : (
        <SkeletonRows rows={4} />
      )}
    </Panel>
  )
}

function PortalRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-[1px]">
      <dt className="text-[11px] text-text-tertiary">{label}</dt>
      <dd className="truncate font-mono text-[12px] text-text-primary" title={value}>{value}</dd>
      {note ? <p className="text-[11px] leading-[1.4] text-text-tertiary">{note}</p> : null}
    </div>
  )
}
