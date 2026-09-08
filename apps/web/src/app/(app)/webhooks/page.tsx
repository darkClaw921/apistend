'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, LaptopMinimal, Play, RefreshCw, RotateCcw, X } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, CounterChip, DataTable, EmptyState, ErrorState,
  MethodBadge, Overline, Panel, PanelFooter, PanelHeader, SearchField, SegmentControl,
  ServiceSquare, SkeletonRows, StatusChip, StatusCodeChip, formatInt, formatMs, formatPercent,
  formatRelative, formatTime, meta,
} from '@apistend/ui'
import type { ChipTone, Column } from '@apistend/ui'
import { SERVICE_PROFILES, isServiceCode } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import type { DeliveryItem, WebhookItem, WebhooksResponse } from '@/lib/types'
import { Topbar } from '@/components/Topbar'
import { LocalDeliveryBar } from '@/components/LocalDeliveryBar'
import { CreateWebhookDialog } from '@/components/CreateWebhookDialog'
import { ScenarioForm } from '@/components/ScenarioForm'

/**
 * Экран «Вебхуки и сценарии». design-handoff/screens/05-webhooks.md.
 *
 * Ключевая особенность продукта — доставка на localhost — вынесена в отдельную полосу
 * наверху. Локальные получатели выделены акцентом: должно быть видно, что событие
 * идёт на машину разработчика, а не в интернет.
 */

const STATUS_LABEL: Record<WebhookItem['status'], string> = {
  active: 'Активен',
  paused: 'Пауза',
  failing: 'Ошибки',
  disabled: 'Выключен',
}
const STATUS_TONE: Record<WebhookItem['status'], ChipTone> = {
  active: 'success', paused: 'neutral', failing: 'danger', disabled: 'neutral',
}

const DELIVERY_ICON: Record<DeliveryItem['state'], { label: string; tone: ChipTone }> = {
  succeeded: { label: 'доставлено', tone: 'success' },
  failed: { label: 'ошибка', tone: 'danger' },
  no_response: { label: 'нет ответа', tone: 'danger' },
  queued: { label: 'в очереди', tone: 'warning' },
  dispatched: { label: 'отправлено', tone: 'info' },
  dropped: { label: 'отброшено', tone: 'neutral' },
}

export default function WebhooksPage() {
  const [data, setData] = useState<WebhooksResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [service, setService] = useState('all')
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [search, setSearch] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<DeliveryItem | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [creatingScenario, setCreatingScenario] = useState(false)
  const [busyScenario, setBusyScenario] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await api.get<WebhooksResponse>('/api/webhooks')
      setData(res)
      setSelected((cur) => (cur ? res.deliveries.find((d) => d.id === cur.id) ?? res.deliveries[0] ?? null : res.deliveries[0] ?? null))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить вебхуки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const anyRunning = (data?.scenarios ?? []).some((s) => s.status === 'running')
  // Журнал доставок живой: события приходят асинхронно.
  useEffect(() => {
    // Пока серия идёт, обновляемся чаще: полоса прогресса иначе стоит на месте.
    const t = setInterval(() => void load(true), anyRunning ? 700 : 4_000)
    return () => clearInterval(t)
  }, [load, anyRunning])

  async function test(id: string) {
    setTesting(id)
    try {
      await api.post(`/api/webhooks/${id}/test`)
      setTimeout(() => void load(true), 400)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить тестовое событие')
    } finally {
      setTesting(null)
    }
  }

  /**
   * Запуск и остановка сценария.
   * Пока серия идёт, экран опрашивается чаще: прогресс должен двигаться, а не догоняться.
   */
  async function runScenario(id: string, running: boolean) {
    setBusyScenario(id)
    try {
      await api.post(`/api/scenarios/${id}/${running ? 'stop' : 'run'}`)
      setError(null)
      setTimeout(() => void load(true), 200)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось запустить сценарий')
    } finally {
      setBusyScenario(null)
    }
  }

  const webhooks = useMemo(() => {
    let list = data?.webhooks ?? []
    if (service !== 'all') list = list.filter((w) => w.serviceCode === service)
    if (onlyErrors) list = list.filter((w) => w.status === 'failing')
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((w) => w.event.toLowerCase().includes(q) || (w.targetUrl ?? w.targetPath ?? '').toLowerCase().includes(q))
    }
    return list
  }, [data, service, onlyErrors, search])

  const avgSuccess = data && data.webhooks.length > 0
    ? data.webhooks.reduce((s, w) => s + w.successRate24h, 0) / data.webhooks.length
    : 0

  const columns: Array<Column<WebhookItem>> = useMemo(
    () => [
      {
        key: 'event', header: 'Сервис и событие',
        render: (w) => (
          <span className="flex min-w-0 items-center gap-[10px]">
            {isServiceCode(w.serviceCode) ? <ServiceSquare service={w.serviceCode} size={26} /> : null}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[12px] text-text-primary">{w.event}</span>
              <span
                className={`truncate text-[11px] ${w.target === 'local' ? 'text-accent' : 'text-text-tertiary'}`}
                title={w.target === 'local' ? `${data?.localAgent.forwardUrl ?? 'localhost'}${w.targetPath}` : w.targetUrl ?? ''}
              >
                {w.target === 'local'
                  // База серым, относительный путь акцентом: видно, что уходит на машину разработчика.
                  ? <>
                      <span className="text-text-tertiary">{data?.localAgent.forwardUrl ?? 'apistend listen'}</span>
                      <span className="text-accent">{w.targetPath}</span>
                    </>
                  : w.targetUrl}
              </span>
            </span>
          </span>
        ),
      },
      { key: 'method', header: 'Метод', width: 66, render: (w) => <MethodBadge method={w.httpMethod} /> },
      {
        key: 'status', header: 'Статус', width: 106,
        render: (w) => <StatusChip tone={STATUS_TONE[w.status]}>{STATUS_LABEL[w.status]}</StatusChip>,
      },
      {
        key: 'last', header: 'Посл. попытка', width: 104,
        render: (w) => (
          <span className="flex flex-col">
            <span className="font-mono text-[12px] text-text-primary tabular">
              {w.lastAttemptAt ? formatTime(w.lastAttemptAt) : '—'}
            </span>
            {w.lastAttemptAt ? (
              <span className="text-[11px] text-text-tertiary">{formatRelative(w.lastAttemptAt)}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'test', header: '', width: 76, align: 'right',
        render: (w) => (
          <ButtonSecondary tone="quiet" disabled={testing === w.id} onClick={() => void test(w.id)}>
            {testing === w.id ? '…' : 'Тест'}
          </ButtonSecondary>
        ),
      },
    ],
    [data, testing],
  )

  const deliveryColumns: Array<Column<DeliveryItem>> = useMemo(
    () => [
      {
        key: 'time', header: 'Время', width: 88, mono: true,
        render: (d) => <span className="text-text-secondary">{formatTime(d.timestamp)}</span>,
      },
      {
        key: 'event', header: 'Событие и получатель',
        render: (d) => (
          <span className="flex min-w-0 items-baseline gap-[10px]">
            <span className="truncate font-mono text-[12px] text-text-primary">{d.event}</span>
            <span className="truncate font-mono text-[11px] text-text-tertiary">{d.targetDisplay}</span>
          </span>
        ),
      },
      {
        key: 'code', header: 'Код', width: 74,
        render: (d) => (d.statusCode ? <StatusCodeChip code={d.statusCode} /> : <span className="text-[12px] text-text-tertiary">—</span>),
      },
      {
        key: 'attempt', header: 'Попытки', width: 82, mono: true,
        render: (d) => (
          <span className={d.attempt > 1 ? 'text-warning' : 'text-text-secondary'}>
            {d.attempt}{d.maxAttempts > 1 ? ` / ${d.maxAttempts}` : ''}
          </span>
        ),
      },
      {
        key: 'duration', header: 'Длит.', width: 84, mono: true,
        render: (d) => <span className="text-text-secondary">{d.durationMs === null ? '—' : formatMs(d.durationMs)}</span>,
      },
      {
        key: 'state', header: '', width: 110, align: 'right',
        render: (d) => (
          <StatusChip tone={DELIVERY_ICON[d.state].tone}>{DELIVERY_ICON[d.state].label}</StatusChip>
        ),
      },
    ],
    [],
  )

  return (
    <>
      <Topbar
        breadcrumb="Проект «Интеграция 1С» / Вебхуки"
        title="Вебхуки и сценарии"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={<ButtonPrimary onClick={() => setCreating(true)}>Новый вебхук</ButtonPrimary>}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto scrollbar-thin p-[24px]">
        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          <SegmentControl
            segments={[
              { value: 'all', label: 'Все сервисы' },
              ...Object.values(SERVICE_PROFILES).map((p) => ({ value: p.code, label: p.title })),
            ]}
            value={service}
            onChange={setService}
          />
          <button
            type="button"
            onClick={() => setOnlyErrors((v) => !v)}
            className={`inline-flex items-center gap-[6px] rounded-[6px] border px-[12px] py-[6px] text-[12px] ${
              onlyErrors ? 'border-danger bg-danger-soft text-danger' : 'border-border-strong bg-surface text-text-secondary'
            }`}
          >
            Только с ошибками
          </button>
          <div className="ml-auto flex items-center gap-[10px]">
            <SearchField value={search} onValueChange={setSearch} placeholder="Поиск по вебхукам" width={236} />
            <ButtonSecondary icon={<RefreshCw size={13} aria-hidden />} onClick={() => void load()}>
              Обновить
            </ButtonSecondary>
          </div>
        </div>

        <LocalDeliveryBar agent={data?.localAgent ?? null} loading={loading && !data} />

        <div className="flex min-h-0 flex-1 gap-[20px]">
          <div className="flex min-w-0 flex-1 flex-col gap-[20px]">
            <Panel className="min-h-[280px] flex-1">
              <PanelHeader
                title="Настроенные вебхуки"
                count={<CounterChip>{data ? data.webhooks.length : '—'}</CounterChip>}
                right={
                  <span className="text-[12px] text-text-tertiary">
                    Доставка за 24 ч — {formatPercent(avgSuccess)}
                  </span>
                }
              />
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {loading && !data ? (
                  <SkeletonRows rows={6} />
                ) : error ? (
                  <ErrorState message={error} onRetry={() => void load()} />
                ) : webhooks.length === 0 ? (
                  <EmptyState
                    icon={<X size={20} aria-hidden />}
                    title="Вебхуков нет"
                    description="Создайте вебхук, чтобы получать события моков — в том числе прямо на localhost"
                  />
                ) : (
                  <DataTable columns={columns} rows={webhooks} rowKey={(w) => w.id} />
                )}
              </div>
            </Panel>

            <Panel className="h-[300px] shrink-0">
              <PanelHeader
                title="Журнал доставок"
                subtitle="последние доставки"
                right={
                  data ? (
                    <>
                      <StatusChip tone="success">{data.deliveryStats.succeeded} успешно</StatusChip>
                      {data.deliveryStats.failed > 0 ? (
                        <StatusChip tone="danger">{data.deliveryStats.failed} ошибки</StatusChip>
                      ) : null}
                      {data.deliveryStats.retried > 0 ? (
                        <StatusChip tone="warning">{data.deliveryStats.retried} повтор</StatusChip>
                      ) : null}
                    </>
                  ) : null
                }
              />
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {data && data.deliveries.length > 0 ? (
                  <DataTable
                    dense
                    columns={deliveryColumns}
                    rows={data.deliveries}
                    rowKey={(d) => d.id}
                    rowTone={(d) => (d.id === selected?.id ? 'selected' : d.state === 'failed' || d.state === 'no_response' ? 'error' : 'default')}
                    onRowClick={setSelected}
                  />
                ) : (
                  <EmptyState title="Доставок пока не было" description="Нажмите «Тест» в строке вебхука" />
                )}
              </div>
              <PanelFooter
                left={data ? `Показано ${formatInt(data.deliveries.length)} доставок` : null}
                right={
                  <button
                    type="button"
                    onClick={() => void api.post('/api/webhooks/retry-failed').then(() => load())}
                    className="text-[12px] font-semibold text-accent hover:underline"
                  >
                    Повторить ошибочные
                  </button>
                }
              />
            </Panel>
          </div>

          <div className="flex w-[380px] shrink-0 flex-col gap-[20px]">
            <Panel className="flex-1">
              <PanelHeader
                title="Сценарии симуляции"
                subtitle={`до ${formatInt(data?.burstLimits.maxRatePerSec ?? 500)} соб/с`}
                right={
                  <ButtonSecondary tone="quiet" onClick={() => setCreatingScenario((v) => !v)}>
                    {creatingScenario ? 'Отмена' : 'Создать'}
                  </ButtonSecondary>
                }
              />
              {/* Форма внутри прокручиваемой области: панель фиксированной высоты,
                  и снаружи её нижняя часть с кнопками просто обрезалась бы. */}
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {creatingScenario ? (
                  <ScenarioForm
                    webhooks={data?.webhooks ?? []}
                    limits={data?.burstLimits ?? { maxRatePerSec: 500, maxCount: 100000, maxConcurrent: 3 }}
                    onCancel={() => setCreatingScenario(false)}
                    onCreated={() => { setCreatingScenario(false); void load(true) }}
                    onError={setError}
                  />
                ) : null}
                {data?.scenarios.map((s) => {
                  const running = s.status === 'running'
                  return (
                    <div key={s.id} className="border-b border-border p-[14px] last:border-b-0">
                      <div className="mb-[6px] flex items-center gap-[10px]">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">{s.name}</span>
                        <StatusChip tone={running ? 'accent' : 'neutral'}>
                          {running ? 'Выполняется' : 'Готов'}
                        </StatusChip>
                      </div>
                      {/* Код события и параметры нагрузки — разными строками: в 380 px
                          одной строкой они переносятся посередине и читаются хуже. */}
                      <p className="truncate font-mono text-[11px] text-text-secondary" title={s.event}>
                        {s.event}
                      </p>
                      <p className="mb-[8px] font-mono text-[11px] text-text-tertiary">
                        {meta(
                          `${formatInt(s.stepsCount)} соб`,
                          `${formatInt(s.ratePerSec)}/с`,
                          `ошибки ${s.errorRate} %`,
                        )}
                      </p>
                      {running ? (
                        <>
                          <div className="mb-[6px] h-[5px] w-full overflow-hidden rounded-[3px] bg-surface-3">
                            <div
                              className="h-full rounded-[3px] bg-accent transition-[width] duration-150"
                              style={{ width: `${Math.min(100, (s.progress / s.stepsCount) * 100)}%` }}
                            />
                          </div>
                          {/* Фактическая скорость — то, ради чего нагрузочную проверку и запускают. */}
                          <p className="mb-[6px] font-mono text-[11px] text-text-secondary">
                            {formatInt(s.progress)} / {formatInt(s.stepsCount)}
                            {s.actualRatePerSec === null ? null : (
                              <>
                                {' · '}
                                <span className={s.lagging ? 'text-warning' : 'text-success'}>
                                  {formatInt(s.actualRatePerSec)} соб/с
                                </span>
                              </>
                            )}
                            {s.lagging ? <span className="text-warning"> · приложение не успевает</span> : null}
                          </p>
                        </>
                      ) : null}
                      <div className="flex items-center justify-between gap-[10px]">
                        {/* Итог запуска — главный результат нагрузочной проверки,
                            поэтому ему две строки, а не многоточие. */}
                        <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-[15px] text-text-tertiary" title={s.lastRunNote ?? ''}>
                          {s.lastRunNote ?? '—'}
                        </span>
                        <ButtonSecondary
                          tone="quiet"
                          icon={running ? <X size={12} aria-hidden /> : <Play size={12} aria-hidden />}
                          disabled={busyScenario === s.id}
                          onClick={() => void runScenario(s.id, running)}
                        >
                          {running ? 'Стоп' : 'Запустить'}
                        </ButtonSecondary>
                      </div>
                    </div>
                  )
                })}
                {data && data.scenarios.length === 0 ? (
                  <EmptyState
                    title="Сценариев нет"
                    description="Создайте сценарий: событие, сколько отправить и с какой скоростью"
                  />
                ) : null}
              </div>
            </Panel>

            <Panel className="h-[340px] shrink-0">
              <PanelHeader
                title="Тело события"
                right={
                  selected ? (
                    <button
                      type="button"
                      aria-label="Копировать тело события"
                      onClick={() => { void navigator.clipboard.writeText(selected.rawBody); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                      className="text-text-tertiary hover:text-text-secondary"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  ) : null
                }
              />
              {selected ? (
                <>
                  <div className="flex shrink-0 flex-wrap items-center gap-[8px] border-b border-border bg-accent-soft/40 px-[14px] py-[8px]">
                    <span className="font-mono text-[12px] font-semibold text-accent">{selected.event}</span>
                    <span className="text-[11px] text-text-tertiary">попытка {selected.attempt} из {selected.maxAttempts}</span>
                    {selected.statusCode ? <StatusCodeChip code={selected.statusCode} /> : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-[14px]">
                    <Overline>
                      {selected.contentType === 'application/x-www-form-urlencoded'
                        ? 'Тело · form-urlencoded'
                        : 'Тело · JSON'}
                    </Overline>
                    <CodeBlock
                      className="mt-[6px]"
                      size="sm"
                      language={selected.contentType.includes('json') ? 'json' : 'text'}
                      code={prettyBody(selected)}
                    />
                    {selected.errorMessage ? (
                      <p className="mt-[8px] rounded-[6px] bg-danger-soft px-[10px] py-[7px] text-[11px] text-danger">
                        {selected.errorMessage}
                      </p>
                    ) : null}
                  </div>
                </>
              ) : (
                <EmptyState title="Доставка не выбрана" description="Выберите строку журнала доставок" />
              )}
            </Panel>
          </div>
        </div>
      </main>

      {creating ? (
        <CreateWebhookDialog
          forwardUrl={data?.localAgent.forwardUrl ?? null}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); void load(true) }}
        />
      ) : null}
    </>
  )
}

/** Bitrix24 шлёт form-urlencoded — показываем его читаемо, а не одной строкой. */
function prettyBody(d: DeliveryItem): string {
  if (d.contentType.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(d.rawBody), null, 2)
    } catch {
      return d.rawBody
    }
  }
  return [...new URLSearchParams(d.rawBody).entries()]
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
}
