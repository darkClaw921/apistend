'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import {
  Activity, ArrowRight, Boxes, CircleX, KeyRound, Play, RefreshCw, Search, Timer, TriangleAlert,
} from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, CounterChip, DataTable, EmptyState, JsonViewer, KpiTile,
  MethodBadge, Overline, Panel, PanelFooter, PanelHeader, SegmentControl, ServiceDot,
  SkeletonRows, StatusChip, StatusCodeChip, KbdChip, formatBytes, formatDelta, formatInt,
  formatMethods, formatMs, formatPercent, formatTime, meta,
} from '@apistend/ui'
import type { ChipTone, Column, RowTone } from '@apistend/ui'
import { SERVICE_PROFILES, isServiceCode } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import type { OverviewResponse, PreviewResponse, SearchResponse, SearchResult, RecentRequest } from '@/lib/types'
import { useProjectCrumb } from '@/components/AppShell'
import { Topbar } from '@/components/Topbar'
import { READINESS_LABEL, READINESS_TONE } from '@/lib/readiness'

/**
 * Экран «Обзор». design-handoff/screens/01-overview.md.
 *
 * Отвечает на вопрос «всё ли в порядке с песочницей и как быстро дёрнуть нужный метод».
 * Ключевой блок — поиск по всем демо-API сразу: ответ подставляется в правую колонку
 * без ухода с экрана.
 */

/**
 * Классы перечислены целиком, а не собираются строкой.
 * Tailwind сканирует исходники статически: `bg-${tone}-soft` он не увидит
 * и утилиту не сгенерирует — подложка иконки останется прозрачной.
 */
const ALERT_STYLE: Record<string, { bg: string; fg: string }> = {
  danger: { bg: 'bg-danger-soft', fg: 'text-danger' },
  warning: { bg: 'bg-warning-soft', fg: 'text-warning' },
  info: { bg: 'bg-info-soft', fg: 'text-info' },
}

export default function OverviewPage() {
  const router = useRouter()
  const crumb = useProjectCrumb('Обзор')

  const [data, setData] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')

  const [query, setQuery] = useState('остатк')
  const [debounced, setDebounced] = useState('остатк')
  const [search, setSearch] = useState<SearchResponse | null>(null)
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [tab, setTab] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.get<OverviewResponse>('/api/overview'))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить обзор')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Ввод от 2 символов, дебаунс 200 мс — как задано в спецификации поведения.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (debounced.trim().length < 2) { setSearch(null); setSelected(null); return }
    api.get<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced.trim())}&limit=8`)
      .then((r) => {
        setSearch(r)
        setSelected((cur) => (cur && r.results.some((x) => x.id === cur.id) ? cur : r.results[0] ?? null))
      })
      .catch(() => setSearch(null))
  }, [debounced])

  useEffect(() => {
    if (!selected) { setPreview(null); return }
    let cancelled = false
    setPreviewLoading(true)
    api.get<PreviewResponse>(`/api/search/preview/${encodeURIComponent(selected.id)}`)
      .then((p) => { if (!cancelled) setPreview(p) })
      .catch(() => { if (!cancelled) setPreview(null) })
      .finally(() => { if (!cancelled) setPreviewLoading(false) })
    return () => { cancelled = true }
  }, [selected])

  // Стрелки ↑↓ переключают результат — требование спецификации.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!search || search.results.length === 0) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const idx = search.results.findIndex((r) => r.id === selected?.id)
      const next = e.key === 'ArrowDown'
        ? Math.min(search.results.length - 1, idx + 1)
        : Math.max(0, idx - 1)
      setSelected(search.results[next] ?? null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [search, selected])

  const recent = useMemo(() => {
    const rows = data?.recent ?? []
    if (tab === 'errors') return rows.filter((r) => r.statusCode >= 400)
    if (tab === 'slow') return rows.filter((r) => r.durationMs >= 500)
    return rows
  }, [data, tab])

  const columns: Array<Column<RecentRequest>> = useMemo(
    () => [
      { key: 'time', header: 'Время', width: 88, mono: true, render: (r) => <span className="text-text-secondary">{formatTime(r.timestamp)}</span> },
      {
        key: 'service', header: 'Сервис', width: 124,
        render: (r) => {
          const title = isServiceCode(r.serviceCode) ? SERVICE_PROFILES[r.serviceCode].title : r.serviceCode
          return (
            <span className="flex items-center gap-[7px]" title={title}>
              {isServiceCode(r.serviceCode) ? <ServiceDot service={r.serviceCode} size={7} /> : null}
              <span className="truncate">{title}</span>
            </span>
          )
        },
      },
      { key: 'method', header: 'Метод', width: 70, render: (r) => <MethodBadge method={r.httpMethod} /> },
      {
        key: 'endpoint', header: 'Эндпоинт', mono: true,
        render: (r) => <span className="text-text-primary" title={r.endpoint}>{r.endpoint}</span>,
      },
      { key: 'code', header: 'Код', width: 74, render: (r) => <StatusCodeChip code={r.statusCode} /> },
      {
        key: 'duration', header: 'Задержка', width: 96, mono: true,
        render: (r) => <span className={r.durationMs >= 1000 ? 'text-danger' : 'text-text-secondary'}>{formatMs(r.durationMs)}</span>,
      },
      // Имя ключа — свободный текст: многоточие законно, полное значение
      // даёт всплывающая подсказка.
      {
        key: 'key', header: 'Ключ', width: 104, mono: true,
        render: (r) => (
          <span className="truncate text-text-tertiary" title={r.apiKeyName ?? undefined}>
            {r.apiKeyName ?? '—'}
          </span>
        ),
      },
    ],
    [],
  )

  const rowTone = (r: RecentRequest): RowTone =>
    r.statusCode === 429 || r.statusCode === 503 ? 'warning' : r.statusCode >= 400 ? 'error' : 'default'

  return (
    <>
      <Topbar
        breadcrumb={crumb}
        title="Обзор"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={<ButtonPrimary onClick={() => router.push('/keys')}>Новая песочница</ButtonPrimary>}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto scrollbar-thin p-[24px]">
        {/* KPI. Четыре плитки в ряд — раскладка макета на 1440; на узком экране
            от «Запросов за 24 часа» оставалось «За 24», поэтому ниже 1024
            они встают в две строки по две. */}
        <div className="grid shrink-0 gap-[16px] max-lg:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Запросов за 24 часа"
            value={data ? formatInt(data.kpi.requests24h) : '—'}
            icon={<Activity size={15} aria-hidden />}
            delta={data?.kpi.requestsGrowthPercent != null ? formatDelta(Math.round(data.kpi.requestsGrowthPercent), '%') : undefined}
            deltaTone={data?.kpi.requestsGrowthPercent != null && data.kpi.requestsGrowthPercent >= 0 ? 'good' : 'bad'}
            deltaSuffix="к вчера"
          />
          <KpiTile
            label="Средняя задержка"
            value={data ? formatMs(data.kpi.avgLatencyMs) : '—'}
            icon={<Timer size={15} aria-hidden />}
          />
          <KpiTile
            label="Доля ошибок"
            value={data ? formatPercent(data.kpi.errorRatePercent) : '—'}
            icon={<TriangleAlert size={15} aria-hidden />}
            deltaTone={data && data.kpi.errorRatePercent > 5 ? 'bad' : 'neutral'}
          />
          <KpiTile
            label="Активных ключей"
            value={data ? formatInt(data.kpi.activeKeys) : '—'}
            icon={<KeyRound size={15} aria-hidden />}
            deltaSuffix="без ограничений"
          />
        </div>

        {/* Поиск по всем демо-API */}
        <Panel className="h-[320px] shrink-0">
          <PanelHeader
            title="Поиск по всем демо-API"
            icon={<Search size={16} className="text-accent" aria-hidden />}
            right={
              <>
                <span className="text-[11px] text-text-tertiary">Ищет по названию метода, пути и описанию</span>
                <KbdChip>⌘K</KbdChip>
              </>
            }
          />
          <div className="flex min-h-0 flex-1">
            {/* 600 px из макета — но только когда рядом помещается предпросмотр.
                Ниже 1280 предпросмотр уходит, а список занимает всю ширину. */}
            <div className="flex min-w-0 flex-col border-r border-border max-xl:flex-1 xl:w-[600px] xl:shrink-0">
              <div className="flex shrink-0 items-center gap-[10px] border-b border-border px-[16px] py-[13px]">
                <Search size={16} className="shrink-0 text-text-tertiary" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Например: остатки, сделка, posting"
                  aria-label="Поиск по всем демо-API"
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
                />
                {search ? (
                  <span className="shrink-0 text-[11px] text-text-tertiary tabular">
                    {formatInt(search.total)} совпадений
                  </span>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {query.trim().length < 2 ? (
                  <EmptyState title="Введите запрос" description="Минимум два символа — ищем сразу по всем сервисам" />
                ) : !search || search.results.length === 0 ? (
                  <EmptyState title="Ничего не найдено" description="Попробуйте другой запрос или снимите фильтры" />
                ) : (
                  <ul>
                    {search.results.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(r)}
                          className={`flex w-full items-center gap-[12px] border-b border-border px-[16px] py-[8px] text-left transition-colors last:border-b-0 ${
                            r.id === selected?.id ? 'bg-accent-soft' : 'hover:bg-surface-2'
                          }`}
                        >
                          <span className="flex w-[104px] shrink-0 items-center gap-[7px]">
                            {isServiceCode(r.serviceCode) ? <ServiceDot service={r.serviceCode} /> : null}
                            <span className="truncate text-[12px] font-medium text-text-primary">
                              {isServiceCode(r.serviceCode) ? SERVICE_PROFILES[r.serviceCode].title : r.serviceCode}
                            </span>
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                            <span className="flex items-center gap-[8px]">
                              <MethodBadge method={r.httpMethod} />
                              <span className="truncate font-mono text-[12px] text-text-primary">{r.path}</span>
                            </span>
                            <span className="truncate text-[11px] text-text-tertiary">
                              <Highlight text={r.description || r.title} needle={debounced.trim()} />
                            </span>
                          </span>
                          <span
                            className={`inline-flex shrink-0 items-center gap-[5px] rounded-[6px] px-[10px] py-[6px] text-[12px] font-semibold ${
                              r.id === selected?.id ? 'bg-accent text-white' : 'border border-border-strong text-text-secondary'
                            }`}
                          >
                            <Play size={12} aria-hidden /> Запрос
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Предпросмотр обмена. Ниже 1280 его показать негде: рядом со списком
                на 600 px он ужимался до пары сантиметров и кодовые блоки в нём
                читать было нечем. Метод открывается в консоли. */}
            <div className="flex min-w-0 flex-1 flex-col gap-[10px] p-[16px] max-xl:hidden">
              {!selected ? (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-[13px] text-text-tertiary">Выберите метод, чтобы увидеть обмен</p>
                </div>
              ) : (
                <>
                  <div className="flex shrink-0 items-center gap-[10px]">
                    <MethodBadge method={selected.httpMethod} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">{selected.path}</span>
                    <ButtonPrimary
                      icon={<Play size={12} aria-hidden />}
                      onClick={() => router.push(`/console?method=${encodeURIComponent(selected.id)}`)}
                    >
                      Отправить
                    </ButtonPrimary>
                  </div>

                  <div className="flex shrink-0 items-baseline justify-between">
                    <Overline>Что уходит · тело запроса</Overline>
                    <span className="font-mono text-[10px] text-text-tertiary">X-Mock-Key: stend_sbx_9f2a…</span>
                  </div>
                  <CodeBlock
                    size="sm"
                    maxLines={3}
                    copyable={false}
                    code={preview?.request ? JSON.stringify(preview.request, null, 2) : '{}'}
                  />

                  <div className="flex shrink-0 items-baseline justify-between">
                    <Overline>Что приходит · ответ</Overline>
                    {preview ? (
                      <span className="flex items-center gap-[8px]">
                        <StatusChip tone="success" dot={false}>{preview.statusCode} OK</StatusChip>
                        <span className="font-mono text-[10px] text-text-tertiary">
                          {meta(formatMs(preview.durationMs), formatBytes(preview.sizeBytes))}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {previewLoading && !preview ? (
                      <SkeletonRows rows={4} />
                    ) : (
                      // Панель даёт блоку высоту, поэтому здесь не обрезание
                      // по строкам, а прокрутка: ответ можно досмотреть до конца
                      // и свернуть ветки, не уходя с обзора.
                      <JsonViewer size="sm" fill value={preview ? preview.response : null} />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </Panel>

        {/* Нижняя область */}
        <div className="flex min-h-[380px] flex-1 gap-[16px] max-xl:flex-col">
          <Panel className="min-w-0 flex-1">
            <PanelHeader
              title="Последние запросы"
              count={<StatusChip tone="success">в реальном времени</StatusChip>}
              right={
                <SegmentControl
                  segments={[
                    { value: 'all', label: 'Все' },
                    { value: 'errors', label: 'Ошибки' },
                    { value: 'slow', label: 'Медленные' },
                  ]}
                  value={tab}
                  onChange={setTab}
                />
              }
            />
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {loading && !data ? (
                <SkeletonRows rows={8} />
              ) : recent.length === 0 ? (
                <EmptyState title="Запросов за период не было" description="Измените период или отправьте тестовый запрос" />
              ) : (
                <DataTable dense columns={columns} rows={recent} rowKey={(r) => r.id} rowTone={rowTone} />
              )}
            </div>
            <PanelFooter
              left={data ? `Показаны последние ${recent.length} из ${formatInt(data.kpi.requests24h)} запросов за 24 часа` : null}
              right={
                <button type="button" onClick={() => router.push('/logs')} className="inline-flex items-center gap-[5px] text-[12px] font-semibold text-accent">
                  Открыть логи запросов <ArrowRight size={12} aria-hidden />
                </button>
              }
            />
          </Panel>

          <div className="flex flex-col gap-[16px] xl:w-[328px] xl:shrink-0">
            <Panel className="flex-1">
              <PanelHeader
                title="Требуют внимания"
                count={data && data.alerts.length > 0 ? <CounterChip tone="danger">{data.alerts.length}</CounterChip> : undefined}
              />
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {data?.alerts.length === 0 ? (
                  <EmptyState title="Всё в порядке" description="Ошибок и обновлений моков нет" />
                ) : (
                  <ul>
                    {data?.alerts.map((a) => {
                      const style = ALERT_STYLE[a.severity] ?? ALERT_STYLE.info!
                      const Icon = a.icon === 'circle-x' ? CircleX : a.icon === 'refresh-cw' ? RefreshCw : Boxes
                      const body = (
                        <>
                          <span className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] ${style.bg}`}>
                            <Icon size={14} className={style.fg} aria-hidden />
                          </span>
                          <span className="flex min-w-0 flex-col text-left">
                            <span className="text-[12px] font-medium text-text-primary">{a.title}</span>
                            <span className="text-[11px] text-text-tertiary">{a.meta}</span>
                          </span>
                        </>
                      )
                      return (
                        <li key={a.id} className="border-b border-border last:border-b-0">
                          {/* Уведомление несёт адрес разбирательства (?status=500,
                              ?service=wildberries) — и в колокольчике шапки по нему
                              переходят. Здесь оно было простым текстом: одно и то же
                              уведомление в одном месте ссылка, в другом — нет. */}
                          {a.link ? (
                            <button
                              type="button"
                              onClick={() => router.push(a.link as Route)}
                              className="flex w-full items-start gap-[10px] px-[16px] py-[12px] hover:bg-surface-2"
                            >
                              {body}
                            </button>
                          ) : (
                            <div className="flex items-start gap-[10px] px-[16px] py-[12px]">{body}</div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </Panel>

            <Panel className="shrink-0">
              <PanelHeader
                title="Демо-сервисы"
                right={<span className="text-[11px] text-text-tertiary">{data ? formatMethods(data.totalMethods) : '—'}</span>}
              />
              <ul>
                {data?.services.map((s) => (
                  <li key={s.code} className="flex items-center gap-[10px] border-b border-border px-[16px] py-[11px] last:border-b-0">
                    {isServiceCode(s.code) ? <ServiceDot service={s.code} /> : null}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{s.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-text-tertiary tabular">{formatInt(s.methodsCount)}</span>
                    <StatusChip tone={s.status === 'ok' ? 'success' : 'warning'}>
                      {s.status === 'ok' ? 'Работает' : 'Обновляется'}
                    </StatusChip>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      </main>
    </>
  )
}

/** Подсветка совпавшего фрагмента — требование спецификации блока поиска. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (needle.length < 2) return <>{text}</>
  const idx = text.toLowerCase().indexOf(needle.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-accent">{text.slice(idx, idx + needle.length)}</span>
      {text.slice(idx + needle.length)}
    </>
  )
}
