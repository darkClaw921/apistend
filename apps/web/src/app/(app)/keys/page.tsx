'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, EllipsisVertical, RotateCcw, ShieldAlert } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, DataTable, Dialog, ErrorState, MethodBadge,
  Panel, PanelFooter, PanelHeader, SearchField, SegmentControl, ServiceChip,
  ServiceSquare, SkeletonRows, Slider, StatusChip, formatDate, formatDayTime,
  formatInt, formatMs, formatPercent, formatRelative, meta,
} from '@apistend/ui'
import type { Column } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { ApiKeyItem, KeysResponse, Me } from '@/lib/types'
import { Topbar } from '@/components/Topbar'
import { useShell, useProjectCrumb } from '@/components/AppShell'
import { CreateKeyDialog } from '@/components/CreateKeyDialog'
import { HowToConnectDialog } from '@/components/HowToConnectDialog'

/**
 * Экран «Ключи и токены». design-handoff/screens/06-keys-tokens.md.
 *
 * Два правила макета, которые легко потерять:
 *  — в колонке «Запросов за сутки» просто число: лимитов у продукта нет,
 *    прогресс-бара там быть не должно;
 *  — кнопка отзыва активна только после точного совпадения введённого названия.
 */

const STATUS_LABEL: Record<ApiKeyItem['status'], string> = {
  active: 'Активен',
  expiring: 'Истекает',
  revoked: 'Отозван',
}
const STATUS_TONE = { active: 'success', expiring: 'warning', revoked: 'danger' } as const

export default function KeysPage() {
  const shell = useShell()
  const crumb = useProjectCrumb('Ключи и токены')

  const [data, setData] = useState<KeysResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [howTo, setHowTo] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetPending, setResetPending] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const sandbox = shell.me.sandboxes[0]
  const [latency, setLatency] = useState(sandbox?.latencyMs ?? 250)
  const [errorRate, setErrorRate] = useState(sandbox?.errorRate ?? 5)
  const [behaviourSaved, setBehaviourSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyItem | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [revoking, setRevoking] = useState(false)

  /**
   * Задержка и доля ошибок сохраняются на сервере, а не живут в состоянии страницы.
   *
   * Раньше ползунки двигались, число менялось, а песочница отвечала по-старому:
   * значение никуда не уходило, и после перезагрузки страницы возвращалось прежнее.
   * Настройка, которая выглядит применённой, но не применена, хуже отсутствующей —
   * по ней делают вывод о поведении мока.
   *
   * Отправка отложенная: пока ползунок тянут, запрос на каждый шаг — это сотня
   * запросов на одно движение мыши.
   */
  useEffect(() => {
    if (!sandbox) return
    if (latency === sandbox.latencyMs && errorRate === sandbox.errorRate) return

    const timer = setTimeout(() => {
      setBehaviourSaved('saving')
      api
        .patch(`/api/v1/sandboxes/${sandbox.id}`, { latencyMs: latency, errorRate })
        .then(() => {
          setBehaviourSaved('saved')
          // Обновляем то, что кабинет считает текущим состоянием песочницы:
          // иначе следующее сравнение снова сочтёт значение несохранённым.
          sandbox.latencyMs = latency
          sandbox.errorRate = errorRate
        })
        .catch(() => setBehaviourSaved('failed'))
    }, 600)
    return () => clearTimeout(timer)
  }, [latency, errorRate, sandbox])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.get<KeysResponse>('/api/keys'))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить ключи')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!revokeTarget) {
      const firstRevoked = data?.keys.find((k) => k.status === 'revoked')
      if (firstRevoked) setRevokeTarget(firstRevoked)
    }
  }, [data, revokeTarget])

  const rows = useMemo(() => {
    let list = data?.keys ?? []
    if (filter === 'active') list = list.filter((k) => k.status !== 'revoked')
    if (filter === 'revoked') list = list.filter((k) => k.status === 'revoked')
    if (search.trim().length > 0) {
      const q = search.trim().toLowerCase()
      list = list.filter((k) => k.name.toLowerCase().includes(q) || k.mask.toLowerCase().includes(q))
    }
    return list
  }, [data, filter, search])

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    } catch { /* буфер недоступен */ }
  }

  async function revoke() {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await api.post(`/api/keys/${revokeTarget.id}/revoke`, { confirmName: confirmText })
      setConfirmText('')
      await load()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отозвать ключ')
    } finally {
      setRevoking(false)
    }
  }

  const columns: Array<Column<ApiKeyItem>> = useMemo(
    () => [
      {
        key: 'name', header: 'Название ключа', width: 232,
        render: (k) => (
          <div className="flex min-w-0 flex-col">
            <span className={`truncate text-[13px] font-medium ${k.status === 'revoked' ? 'text-text-tertiary' : 'text-text-primary'}`}>
              {k.name}
            </span>
            {k.subtitle ? <span className="truncate text-[11px] text-text-tertiary">{k.subtitle}</span> : null}
          </div>
        ),
      },
      {
        key: 'prefix', header: 'Префикс ключа', width: 248,
        render: (k) => (
          <span className="flex items-center gap-[8px]">
            <span className={`truncate font-mono text-[12px] ${k.status === 'revoked' ? 'text-text-tertiary' : 'text-text-primary'}`}>
              {k.mask}
            </span>
            <button type="button" aria-label="Копировать маску ключа" onClick={() => void copy(k.mask, k.id)}
              className="shrink-0 text-text-tertiary hover:text-text-secondary">
              {copied === k.id ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </span>
        ),
      },
      {
        key: 'services', header: 'Доступные сервисы', width: 148, className: 'max-lg:hidden',
        render: (k) => (
          <span className="flex flex-wrap gap-[4px]">
            {k.services.map((s) => <ServiceChip key={s} service={s} />)}
          </span>
        ),
      },
      {
        key: 'created', header: 'Создан', width: 110, className: 'max-xl:hidden',
        render: (k) => <span className="text-text-secondary tabular">{formatDate(k.createdAt)}</span>,
      },
      {
        key: 'lastUsed', header: 'Последний запрос', width: 152, className: 'max-xl:hidden',
        render: (k) => (
          <div className="flex flex-col">
            <span className="text-text-secondary tabular">
              {k.lastUsedAt ? formatDayTime(k.lastUsedAt) : 'нет запросов'}
            </span>
            {k.lastUsedAt ? (
              <span className="text-[11px] text-text-tertiary">{formatRelative(k.lastUsedAt)}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'requests', header: 'Запросов за сутки', width: 132, mono: true, className: 'max-xl:hidden',
        // Просто число. Лимитов нет — прогресс-бару здесь не место.
        render: (k) => <span className="text-text-primary">{formatInt(k.requestsPerDay)}</span>,
      },
      {
        key: 'status', header: 'Статус', width: 132,
        render: (k) => <StatusChip tone={STATUS_TONE[k.status]}>{STATUS_LABEL[k.status]}</StatusChip>,
      },
      {
        key: 'actions', header: '', width: 58, align: 'right',
        render: (k) => (
          <button type="button" aria-label={`Действия с ключом ${k.name}`}
            onClick={() => setRevokeTarget(k)}
            className="text-text-tertiary hover:text-text-secondary">
            <EllipsisVertical size={14} aria-hidden />
          </button>
        ),
      },
    ],
    [copied],
  )

  return (
    <>
      <Topbar
        breadcrumb={crumb}
        title="Ключи и токены"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={<ButtonPrimary onClick={() => setCreating(true)}>Создать ключ</ButtonPrimary>}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto scrollbar-thin p-[24px]">
        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          <SegmentControl
            segments={[
              { value: 'all', label: 'Все ключи' },
              { value: 'active', label: 'Активные' },
              { value: 'revoked', label: 'Отозванные' },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <div className="ml-auto flex items-center gap-[10px]">
            <SearchField value={search} onValueChange={setSearch} placeholder="Поиск по названию или префиксу" width={280} />
            <ButtonSecondary onClick={() => setHowTo(true)}>Как подключить</ButtonSecondary>
          </div>
        </div>

        <Panel className="shrink-0">
          {loading && !data ? (
            <SkeletonRows rows={5} />
          ) : error && !data ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : (
            // Панель обрезает по overflow-hidden, а восемь колонок в 556 px
            // не помещаются. Собственный горизонтальный скролл — чтобы до
            // правых колонок можно было добраться, а не догадываться о них.
            <div className="overflow-x-auto scrollbar-thin">
              <DataTable columns={columns} rows={rows} rowKey={(k) => k.id}
                rowTone={(k) => (k.status === 'revoked' ? 'warning' : 'default')} />
            </div>
          )}
          {data ? (
            <PanelFooter
              left={meta(
                `${formatInt(data.summary.total)} ключей`,
                `${data.summary.active} активных, ${data.summary.revoked} отозван`,
                data.summary.note,
              )}
              right={<span className="text-[12px] font-semibold text-accent">{data.summary.rotationNote}</span>}
            />
          ) : null}
        </Panel>

        {/* «Поведение песочницы» фиксировано в 440 px и не сжимается: на узком
            экране соседней панели оставалось девяносто пикселей. Ниже 1280
            панели встают друг под другом. */}
        <div className="flex shrink-0 gap-[20px] max-xl:flex-col">
          {/* Базовые адреса моков */}
          <Panel className="min-w-0 flex-1">
            <PanelHeader title="Базовые адреса моков" />
            <div className="p-[16px]">
              <p className="mb-[12px] text-[13px] text-text-secondary">
                Подставьте адрес мока вместо боевого — формат ответов и коды ошибок совпадают.
              </p>
              <ul className="flex flex-col gap-[8px]">
                {data?.baseUrls.map((b) => (
                  <li key={b.code} className="flex items-center gap-[12px] rounded-[6px] bg-surface-2 px-[12px] py-[10px]">
                    <ServiceSquare service={b.code} size={32} />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-medium text-text-primary">{b.title}</span>
                      <span className="truncate font-mono text-[12px] text-text-secondary">{b.mockUrl}</span>
                    </div>
                    <span className="ml-auto shrink-0 text-[11px] text-text-tertiary">вместо {b.replaces}</span>
                    <button type="button" aria-label={`Копировать адрес ${b.title}`}
                      onClick={() => void copy(b.mockUrl, `base-${b.code}`)}
                      className="shrink-0 rounded-[6px] border border-border bg-surface p-[7px] text-text-secondary hover:bg-surface-2">
                      {copied === `base-${b.code}` ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </li>
                ))}
              </ul>
              {data?.baseUrls[2] ? (
                <div className="mt-[12px] flex items-center gap-[10px] rounded-[6px] bg-code-bg px-[12px] py-[10px]">
                  <MethodBadge method="GET" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-code-string">
                    {data.baseUrls[2].mockUrl}api/v3/orders/new
                  </span>
                  <button type="button" aria-label="Копировать пример"
                    onClick={() => void copy(`${data.baseUrls[2]!.mockUrl}api/v3/orders/new`, 'sample')}
                    className="shrink-0 text-code-muted hover:text-code-text">
                    {copied === 'sample' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              ) : null}
            </div>
          </Panel>

          {/* Поведение песочницы */}
          <Panel className="xl:w-[440px] xl:shrink-0">
            <PanelHeader title="Поведение песочницы" />
            <div className="flex flex-col gap-[18px] p-[16px]">
              <Slider
                label="Искусственная задержка ответов"
                value={latency} min={0} max={3000} step={10}
                onChange={setLatency}
                formatValue={formatMs}
                minLabel="0 мс" maxLabel="3000 мс"
              />
              <div>
                <Slider
                  label="Доля случайных ошибок"
                  value={errorRate} min={0} max={50} step={1}
                  onChange={setErrorRate}
                  formatValue={(v) => formatPercent(v, 0)}
                  minLabel="0 %" maxLabel="50 %"
                />
                <p className="mt-[6px] text-[11px] leading-[1.4] text-text-tertiary">
                  Возвращаются 429, 500 и таймауты по схемам сервисов.
                  {behaviourSaved === 'saving' ? ' Сохраняю…' : null}
                  {behaviourSaved === 'saved' ? ' Сохранено.' : null}
                </p>
                {behaviourSaved === 'failed' ? (
                  <p className="mt-[6px] text-[11px] leading-[1.4] text-danger">
                    Не удалось сохранить настройки песочницы. Проверьте связь и подвиньте ползунок ещё раз.
                  </p>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-[12px] border-t border-border pt-[14px]">
                <div className="flex flex-col">
                  <span className="text-[13px] text-text-primary">Сброс демо-данных</span>
                  <span className="text-[11px] text-text-tertiary">
                    Последний сброс: {sandbox ? formatDayTime(sandbox.lastResetAt) : '—'} (МСК)
                  </span>
                </div>
                <ButtonSecondary
                  icon={<RotateCcw size={13} aria-hidden />}
                  onClick={() => setResetting(true)}
                >
                  Сбросить сейчас
                </ButtonSecondary>
              </div>
            </div>
          </Panel>
        </div>

        {/* Опасная зона */}
        {revokeTarget && revokeTarget.status !== 'revoked' ? (
          <section className="flex shrink-0 items-center gap-[16px] rounded-[10px] border border-danger bg-danger-soft p-[16px]">
            <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[8px] bg-danger/10">
              <ShieldAlert size={18} className="text-danger" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-semibold text-danger">Отзыв ключа «{revokeTarget.name}»</h3>
              <p className="mt-[2px] text-[12px] leading-[1.5] text-text-secondary">
                Ключ перестанет действовать сразу и без возможности восстановления: все интеграции
                с этим префиксом получат 401 Unauthorized. История запросов сохранится в логах 30 дней.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-[6px]">
              <label className="text-[11px] text-text-secondary">Введите название ключа для подтверждения</label>
              <div className="flex items-center gap-[8px]">
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={revokeTarget.name}
                  aria-label="Подтверждение отзыва"
                  className="w-[240px] rounded-[6px] border border-border-strong bg-surface px-[10px] py-[8px] text-[13px] outline-none focus:border-danger"
                />
                <ButtonSecondary
                  tone="danger"
                  disabled={confirmText !== revokeTarget.name || revoking}
                  onClick={() => void revoke()}
                >
                  {revoking ? 'Отзываем…' : 'Отозвать ключ'}
                </ButtonSecondary>
              </div>
            </div>
          </section>
        ) : null}
      </main>

      {creating ? (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); void load() }}
        />
      ) : null}

      {resetting ? (
        <Dialog title="Сбросить демо-данные" onClose={() => setResetting(false)}>
          <div className="flex flex-col gap-[14px] p-[16px]">
            <p className="text-[13px] leading-[1.55] text-text-secondary">
              Всё, что вы создали, изменили или удалили через API, вернётся к исходному
              состоянию. Базовый набор данных общий и только на чтение — он не меняется.
            </p>
            <p className="text-[12px] leading-[1.5] text-text-tertiary">
              Ключи, вебхуки и свои моки сброс не трогает.
            </p>
            <div className="flex justify-end gap-[10px]">
              <ButtonSecondary onClick={() => setResetting(false)}>Отмена</ButtonSecondary>
              <ButtonSecondary
                tone="danger"
                disabled={resetPending}
                onClick={async () => {
                  setResetPending(true)
                  try {
                    await api.post('/api/sandbox/reset')
                    setResetting(false)
                    // Подпись «Последний сброс» берётся из профиля, а не из
                    // ответа ключей — без обновления каркаса она оставалась старой.
                    await shell.refresh()
                    void load()
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : 'Не удалось сбросить данные')
                  } finally {
                    setResetPending(false)
                  }
                }}
              >
                {resetPending ? 'Сбрасываю…' : 'Сбросить'}
              </ButtonSecondary>
            </div>
          </div>
        </Dialog>
      ) : null}

      {howTo && data ? (
        <HowToConnectDialog
          baseUrls={data.baseUrls}
          // Маска, а не полный ключ: полностью он показывается только при создании.
          sampleKey={data.keys.find((k) => k.kind === 'sandbox')?.mask ?? 'stend_sbx_…'}
          onClose={() => setHowTo(false)}
        />
      ) : null}
    </>
  )
}
