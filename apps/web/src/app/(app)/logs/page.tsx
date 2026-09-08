'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronLeft, ChevronRight, FileDown, Pause, Play, RefreshCw, RotateCcw, X,
} from 'lucide-react'
import {
  ButtonSecondary, CounterChip, DataTable, DetailPane, ErrorState, MethodBadge, Panel, PanelFooter,
  PanelHeader, SearchField, SkeletonRows, StatusChip, StatusCodeChip, EmptyState,
  ServiceDot, formatBytes, formatInt, formatMs, formatPercent, formatTime, formatTimeMs, meta,
} from '@apistend/ui'
import type { Column, RowTone } from '@apistend/ui'
import { SERVICE_PROFILES, isServiceCode } from '@apistend/shared'
import { api, ApiError, API_URL } from '@/lib/api'
import type { KeysResponse, LogRow, LogsResponse } from '@/lib/types'
import { Topbar } from '@/components/Topbar'
import { HourlyChart } from '@/components/HourlyChart'
import { LogDetailPanel } from '@/components/LogDetailPanel'

/**
 * Экран «Логи запросов». design-handoff/screens/04-request-logs.md.
 *
 * Что именно отправила интеграция и что ответил мок. Плотный режим: 15 строк по 36 px.
 * Автообновление можно поставить на паузу — тогда поток останавливается,
 * а счётчик новых записей продолжает считать.
 */

const PERIODS = [
  { value: '1h', label: '1 час' },
  { value: '24h', label: '24 часа' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
] as const

const STATUSES = [
  { value: 'all', label: 'Все' },
  { value: '200', label: '2xx' },
  { value: '400', label: '4xx' },
  { value: '500', label: '5xx' },
] as const

const REFRESH_MS = 5_000
const PAGE_SIZE = 15

export default function LogsPage() {
  const router = useRouter()

  const [data, setData] = useState<LogsResponse | null>(null)
  const [keys, setKeys] = useState<KeysResponse['keys']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [service, setService] = useState('all')
  const [status, setStatus] = useState('all')
  const [apiKeyId, setApiKeyId] = useState('all')
  const [period, setPeriod] = useState('24h')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)

  const [paused, setPaused] = useState(false)
  const [pendingNew, setPendingNew] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [selected, setSelected] = useState<LogRow | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')

  const knownTotal = useRef<number | null>(null)

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(query); setPage(0) }, 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    api.get<KeysResponse>('/api/keys').then((r) => setKeys(r.keys)).catch(() => setKeys([]))
  }, [])

  const params = useMemo(() => {
    const p = new URLSearchParams({ period, status, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    if (service !== 'all') p.set('service', service)
    if (apiKeyId !== 'all') p.set('apiKeyId', apiKeyId)
    if (debounced.trim()) p.set('q', debounced.trim())
    return p
  }, [period, status, service, apiKeyId, debounced, page])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await api.get<LogsResponse>(`/api/logs?${params}`)
      setData(res)
      knownTotal.current = res.total
      setUpdatedAt(new Date())
      setPendingNew(0)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить журнал')
    } finally {
      setLoading(false)
    }
  }, [params])

  useEffect(() => { void load() }, [load])

  // Автообновление. На паузе поток останавливается, но новые записи считаются:
  // пользователь должен видеть, что жизнь продолжается, и догрузить их кликом.
  useEffect(() => {
    const timer = setInterval(() => {
      if (paused) {
        api.get<LogsResponse>(`/api/logs?${params}`)
          .then((r) => {
            if (knownTotal.current !== null && r.total > knownTotal.current) {
              setPendingNew(r.total - knownTotal.current)
            }
          })
          .catch(() => { /* тихо: это фоновый опрос */ })
      } else {
        void load(true)
      }
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [paused, params, load])

  function reset() {
    setService('all'); setStatus('all'); setApiKeyId('all'); setPeriod('24h'); setQuery(''); setPage(0)
  }

  const columns: Array<Column<LogRow>> = useMemo(
    () => [
      {
        key: 'time', header: 'Время', width: 100, mono: true,
        render: (r) => (
          <span className={r.id === selected?.id ? 'text-accent' : 'text-text-secondary'}>
            {formatTimeMs(r.timestamp)}
          </span>
        ),
      },
      {
        key: 'service', header: 'Сервис', width: 108,
        render: (r) => (
          <span className="flex items-center gap-[7px]">
            {isServiceCode(r.serviceCode) ? <ServiceDot service={r.serviceCode} size={7} /> : null}
            <span className="truncate text-text-primary">
              {isServiceCode(r.serviceCode) ? SERVICE_PROFILES[r.serviceCode].title : r.serviceCode}
            </span>
          </span>
        ),
      },
      { key: 'method', header: 'Метод', width: 68, render: (r) => <MethodBadge method={r.httpMethod} /> },
      {
        key: 'endpoint', header: 'Путь эндпоинта', mono: true,
        render: (r) => <span className="text-text-primary" title={r.endpoint}>{r.endpoint}</span>,
      },
      { key: 'status', header: 'Код', width: 72, render: (r) => <StatusCodeChip code={r.statusCode} /> },
      {
        key: 'duration', header: 'Задержка', width: 84, mono: true,
        render: (r) => (
          <span className={r.durationMs >= 1000 ? 'text-danger' : 'text-text-secondary'}>
            {formatMs(r.durationMs)}
          </span>
        ),
      },
      {
        key: 'size', header: 'Размер', width: 74, mono: true,
        render: (r) => <span className="text-text-secondary">{formatBytes(r.sizeBytes)}</span>,
      },
      {
        key: 'key', header: 'Ключ доступа', width: 104, mono: true,
        render: (r) => <span className="truncate text-text-tertiary">{r.apiKeyName ?? '—'}</span>,
      },
    ],
    [selected],
  )

  const rowTone = (r: LogRow): RowTone => {
    if (r.id === selected?.id) return 'selected'
    if (r.statusCode === 429 || r.statusCode === 503) return 'warning'
    if (r.statusCode >= 400) return 'error'
    return 'default'
  }

  const from = page * PAGE_SIZE + 1
  const to = Math.min((page + 1) * PAGE_SIZE, data?.total ?? 0)
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const filtersActive = service !== 'all' || status !== 'all' || apiKeyId !== 'all' || period !== '24h' || debounced !== ''

  return (
    <>
      <Topbar
        breadcrumb="Проект «Интеграция 1С» / Логи запросов"
        title="Логи запросов"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={
          <ButtonSecondary
            icon={<FileDown size={13} aria-hidden />}
            onClick={() => window.open(`${API_URL}/api/logs/export?${params}`, '_blank')}
          >
            Экспорт CSV
          </ButtonSecondary>
        }
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] p-[24px]">
        {/* Сводка */}
        <div className="flex h-[132px] shrink-0 gap-[16px]">
          <div className="grid flex-1 grid-cols-4 gap-[16px]">
            <Metric label="Всего запросов" value={data ? formatInt(data.summary.total) : '—'} />
            <Metric label="Доля ошибок" value={data ? formatPercent(data.summary.errorRate) : '—'} />
            <Metric label="Средняя задержка" value={data ? formatMs(data.summary.avgLatencyMs) : '—'} />
            <Metric label="95-й перцентиль" value={data ? formatMs(data.summary.p95LatencyMs) : '—'} />
          </div>
          <Panel className="w-[452px] shrink-0 p-[14px]">
            <p className="mb-[6px] shrink-0 text-[13px] font-medium text-text-primary">Активность по часам</p>
            <div className="min-h-0 flex-1">
              <HourlyChart buckets={data?.hourly ?? []} />
            </div>
          </Panel>
        </div>

        {/* Фильтры */}
        <div className="flex shrink-0 flex-wrap items-center gap-[10px] rounded-[10px] border border-border bg-surface px-[14px] py-[10px]">
          <SearchField value={query} onValueChange={setQuery} placeholder="Поиск по пути эндпоинта" width={240} />
          <Select label="Сервис" value={service} onChange={(v) => { setService(v); setPage(0) }}
            options={[{ value: 'all', label: 'Все' }, ...Object.values(SERVICE_PROFILES).map((p) => ({ value: p.code, label: p.title }))]} />
          <Select label="Код ответа" value={status} onChange={(v) => { setStatus(v); setPage(0) }} options={[...STATUSES]} />
          <Select label="Ключ" value={apiKeyId} onChange={(v) => { setApiKeyId(v); setPage(0) }}
            options={[{ value: 'all', label: 'Все' }, ...keys.map((k) => ({ value: k.id, label: k.name }))]} />
          <Select label="Период" value={period} onChange={(v) => { setPeriod(v); setPage(0) }} options={[...PERIODS]} />
          {filtersActive ? (
            <button type="button" onClick={reset}
              className="inline-flex items-center gap-[5px] text-[12px] font-medium text-accent hover:underline">
              <RotateCcw size={12} aria-hidden /> Сбросить
            </button>
          ) : null}
        </div>

        {/* Таблица и деталка */}
        <div className="flex min-h-0 flex-1 gap-[20px]">
          <Panel className="min-w-0 flex-1">
            <PanelHeader
              title="Журнал запросов"
              count={<CounterChip>{data ? formatInt(data.total) : '—'}</CounterChip>}
              right={
                <>
                  {pendingNew > 0 ? (
                    <button type="button" onClick={() => { setPage(0); void load() }}
                      className="inline-flex items-center gap-[5px] rounded-[20px] bg-accent-soft px-[10px] py-[4px] text-[11px] font-semibold text-accent">
                      {formatInt(pendingNew)} новых
                    </button>
                  ) : (
                    <span className="text-[11px] text-text-tertiary">
                      {updatedAt ? `Обновлено ${formatTime(updatedAt)}` : ''}
                    </span>
                  )}
                  <StatusChip tone={paused ? 'neutral' : 'success'}>
                    {paused ? 'На паузе' : 'Автообновление'}
                  </StatusChip>
                  <button type="button" onClick={() => setPaused((p) => !p)}
                    aria-label={paused ? 'Возобновить автообновление' : 'Поставить на паузу'}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border bg-surface text-text-secondary hover:bg-surface-2">
                    {paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
                  </button>
                  <button type="button" onClick={() => void load()} aria-label="Обновить сейчас"
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border bg-surface text-text-secondary hover:bg-surface-2">
                    <RefreshCw size={13} aria-hidden />
                  </button>
                </>
              }
            />
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {loading && !data ? (
                <SkeletonRows rows={15} />
              ) : error ? (
                <ErrorState message={error} onRetry={() => void load()} />
              ) : data && data.rows.length === 0 ? (
                <EmptyState
                  icon={<X size={20} aria-hidden />}
                  title="Запросов за период не было"
                  description="Измените период или отправьте тестовый запрос"
                  action={<ButtonSecondary onClick={() => router.push('/console')}>Открыть консоль</ButtonSecondary>}
                />
              ) : (
                <DataTable
                  dense
                  columns={columns}
                  rows={data?.rows ?? []}
                  rowKey={(r) => r.id}
                  rowTone={rowTone}
                  onRowClick={(r) => setSelected(r)}
                />
              )}
            </div>
            <PanelFooter
              left={data ? meta(
                `Показано ${formatInt(from)}–${formatInt(to)} из ${formatInt(data.total)}`,
                data.sampling && data.sampling.sampleRate < 1
                  ? `выборка ${formatPercent(data.sampling.sampleRate * 100, 0)} — журнал прорежен под нагрузкой`
                  : null,
              ) : null}
              right={
                <div className="flex items-center gap-[6px]">
                  <button type="button" aria-label="Предыдущая страница" disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border bg-surface text-text-secondary disabled:text-text-tertiary">
                    <ChevronLeft size={14} aria-hidden />
                  </button>
                  <span className="font-mono text-[11px] text-text-tertiary tabular">{page + 1} / {formatInt(pageCount)}</span>
                  <button type="button" aria-label="Следующая страница" disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => p + 1)}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border bg-surface text-text-secondary disabled:text-text-tertiary">
                    <ChevronRight size={14} aria-hidden />
                  </button>
                </div>
              }
            />
          </Panel>

          {/* Деталка появляется только по выбору строки, поэтому здесь хватает
              самого факта выбора — отдельное состояние шторке не нужно. */}
          <DetailPane open={!!selected} onClose={() => setSelected(null)} className="w-[420px] shrink-0 max-xl:w-[min(460px,100vw)]">
            <LogDetailPanel row={selected} onClose={() => setSelected(null)} />
          </DetailPane>
        </div>
      </main>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col justify-between rounded-[10px] border border-border bg-surface p-[16px]">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <span className="text-[26px] leading-none font-bold tracking-[-0.6px] text-text-primary tabular">{value}</span>
    </div>
  )
}

function Select({
  label, value, onChange, options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
}) {
  return (
    <label className="inline-flex h-[29px] items-center gap-[6px] rounded-[6px] border border-border-strong bg-surface px-[10px]">
      <span className="text-[12px] whitespace-nowrap text-text-secondary">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className="max-w-[140px] bg-transparent text-[12px] font-semibold text-text-primary outline-none">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}
