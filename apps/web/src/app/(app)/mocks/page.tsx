'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Check, Copy, Play, Plus, ArrowUpDown, ArrowRight } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, CounterChip, EmptyState, ErrorState, MethodBadge,
  Overline, Panel, PanelFooter, PanelHeader, PlaceholderChip, SearchField, SegmentControl,
  SkeletonRows, Slider, StatusChip, Tabs, Toggle, formatCalls, formatMs, formatRelative,
  formatRules, meta,
} from '@apistend/ui'
import type { ChipTone } from '@apistend/ui'
import { api, ApiError, API_URL } from '@/lib/api'
import type { CustomMockItem, MocksResponse } from '@/lib/types'
import { Topbar } from '@/components/Topbar'

/**
 * Экран «Свои моки». design-handoff/screens/07-custom-mocks.md.
 *
 * Второй по важности экран продукта. Ключевое поведение из спецификации:
 * клик по чипу плейсхолдера вставляет его в позицию курсора, предпросмотр показывает
 * подставленные значения, несохранённые изменения помечены точкой warning.
 */

const STATUS_LABEL: Record<CustomMockItem['status'], string> = {
  active: 'Активен', draft: 'Черновик', disabled: 'Выключен',
}
const STATUS_TONE: Record<CustomMockItem['status'], ChipTone> = {
  active: 'success', draft: 'warning', disabled: 'neutral',
}
const STATUS_DOT: Record<CustomMockItem['status'], string> = {
  active: 'bg-success', draft: 'bg-warning', disabled: 'bg-border-strong',
}

export default function MocksPage() {
  const [data, setData] = useState<MocksResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState('response')

  // Черновик редактирования: отделён от загруженных данных, чтобы видеть несохранённое.
  const [draft, setDraft] = useState<CustomMockItem | null>(null)
  const [preview, setPreview] = useState<{ rendered: string; validJson: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<MocksResponse>('/api/mocks')
      setData(res)
      setSelectedId((cur) => (cur && res.mocks.some((m) => m.id === cur) ? cur : res.mocks[0]?.id ?? null))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить моки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const selected = useMemo(
    () => data?.mocks.find((m) => m.id === selectedId) ?? null,
    [data, selectedId],
  )

  useEffect(() => { setDraft(selected ? { ...selected } : null) }, [selected])

  // Предпросмотр пересчитывается с задержкой: иначе запрос на каждое нажатие клавиши.
  useEffect(() => {
    if (!draft?.templatingEnabled) { setPreview(null); return }
    const t = setTimeout(() => {
      api.post<{ rendered: string; validJson: boolean }>('/api/mocks/preview', { template: draft.responseBody })
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(t)
  }, [draft?.responseBody, draft?.templatingEnabled])

  const dirty = useMemo(() => {
    if (!draft || !selected) return false
    return JSON.stringify(draft) !== JSON.stringify(selected)
  }, [draft, selected])

  // Несохранённые изменения не должны теряться при уходе со страницы.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const mocks = useMemo(() => {
    let list = data?.mocks ?? []
    if (filter !== 'all') list = list.filter((m) => m.status === filter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((m) => m.path.toLowerCase().includes(q) || m.title.toLowerCase().includes(q))
    }
    return list
  }, [data, filter, search])

  async function persist() {
    if (!draft) return
    setSaving(true)
    try {
      const res = await fetch(`${API_URL}/api/mocks/${draft.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          httpMethod: draft.httpMethod, path: draft.path, title: draft.title, status: draft.status,
          responseStatusCode: draft.responseStatusCode, contentType: draft.contentType,
          delayMs: draft.delayMs, templatingEnabled: draft.templatingEnabled,
          responseBody: draft.responseBody,
        }),
      })
      if (!res.ok) throw new Error('Не удалось сохранить')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** Клик по чипу вставляет плейсхолдер в позицию курсора — требование спецификации. */
  function insertPlaceholder(code: string) {
    const el = editorRef.current
    if (!el || !draft) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = draft.responseBody.slice(0, start) + code + draft.responseBody.slice(end)
    setDraft({ ...draft, responseBody: next })
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + code.length, start + code.length)
    })
  }

  const callUrl = draft ? `${API_URL}${draft.path}` : ''

  return (
    <>
      <Topbar
        breadcrumb="Проект «Интеграция 1С» / Свои моки"
        title="Свои моки"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={<ButtonPrimary icon={<Plus size={13} aria-hidden />}>Новый мок</ButtonPrimary>}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] p-[24px]">
        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          <SegmentControl
            segments={[
              { value: 'all', label: 'Все', count: data?.counts.all },
              { value: 'active', label: 'Активные', count: data?.counts.active },
              { value: 'draft', label: 'Черновики', count: data?.counts.draft },
              { value: 'disabled', label: 'Выключенные', count: data?.counts.disabled },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <div className="ml-auto flex items-center gap-[10px]">
            <SearchField value={search} onValueChange={setSearch} placeholder="Поиск по своим мокам" width={260} />
            <ButtonSecondary>Импорт из OpenAPI</ButtonSecondary>
            <ButtonSecondary>Шаблоны</ButtonSecondary>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-[20px]">
          {/* Список моков */}
          <Panel className="w-[420px] shrink-0">
            <PanelHeader
              title="Мои моки"
              count={<CounterChip>{data?.counts.all ?? '—'}</CounterChip>}
              right={
                <span className="inline-flex items-center gap-[5px] text-[12px] text-text-tertiary">
                  по изменению <ArrowUpDown size={13} aria-hidden />
                </span>
              }
            />
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {loading && !data ? (
                <SkeletonRows rows={8} />
              ) : error && !data ? (
                <ErrorState message={error} onRetry={() => void load()} />
              ) : mocks.length === 0 ? (
                <EmptyState
                  title="Пока нет своих моков"
                  description="Создайте первый мок или импортируйте OpenAPI-файл"
                  action={<ButtonSecondary>Создать мок</ButtonSecondary>}
                />
              ) : (
                <ul>
                  {mocks.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(m.id)}
                        className={`flex w-full flex-col gap-[5px] border-b border-border px-[16px] py-[12px] text-left transition-colors last:border-b-0 ${
                          m.id === selectedId ? 'bg-accent-soft' : 'hover:bg-surface-2'
                        }`}
                      >
                        <span className="flex items-center gap-[10px]">
                          <MethodBadge method={m.httpMethod} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">{m.path}</span>
                          {m.id === selectedId && dirty ? (
                            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-warning" title="Есть несохранённые изменения" />
                          ) : (
                            <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${STATUS_DOT[m.status]}`} aria-hidden />
                          )}
                        </span>
                        <span className="truncate text-[12px] font-medium text-text-primary">{m.title}</span>
                        <span className="truncate text-[11px] text-text-tertiary">
                          {m.status === 'draft'
                            ? 'Черновик · не опубликован'
                            : m.status === 'disabled'
                              ? `Выключен · ${formatCalls(m.callsCount)} за сутки`
                              : meta(formatRules(m.rulesCount ?? 0), formatCalls(m.callsCount), formatRelative(m.updatedAt))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <PanelFooter
              left={<span className="inline-flex items-center gap-[5px] font-semibold text-accent"><Plus size={12} aria-hidden /> Создать мок</span>}
              right={<span className="text-[12px] text-text-secondary">Импортировать JSON</span>}
            />
          </Panel>

          {/* Редактор */}
          <Panel className="min-w-0 flex-1">
            {!draft ? (
              <EmptyState title="Мок не выбран" description="Выберите мок в списке слева" />
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-[10px] border-b border-border px-[16px] py-[12px]">
                  <select
                    value={draft.httpMethod}
                    onChange={(e) => setDraft({ ...draft, httpMethod: e.target.value })}
                    aria-label="HTTP-метод мока"
                    className="rounded-[6px] bg-accent-soft px-[10px] py-[6px] font-mono text-[12px] font-bold text-accent outline-none"
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input
                    value={draft.path}
                    onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                    aria-label="Путь мока"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[14px] font-medium text-text-primary outline-none"
                  />
                  <StatusChip tone={STATUS_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</StatusChip>
                  <ButtonSecondary icon={<Play size={13} aria-hidden />}>Тест-вызов</ButtonSecondary>
                  <ButtonPrimary onClick={() => void persist()} disabled={!dirty || saving}>
                    {saving ? 'Сохраняем…' : 'Сохранить'}
                  </ButtonPrimary>
                </div>

                <Tabs
                  items={[
                    { value: 'response', label: 'Ответ' },
                    { value: 'rules', label: 'Правила ответа' },
                    { value: 'headers', label: 'Заголовки' },
                    { value: 'delay', label: 'Задержка и ошибки' },
                    { value: 'history', label: 'История вызовов' },
                  ]}
                  value={tab}
                  onChange={setTab}
                />

                <div className="flex min-h-0 flex-1">
                  {/* Левая колонка: редактор и предпросмотр */}
                  <div className="flex min-w-0 flex-1 flex-col gap-[10px] p-[16px]">
                    <div className="flex items-center justify-between">
                      <Overline>Тело ответа · JSON</Overline>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            setDraft({ ...draft, responseBody: JSON.stringify(JSON.parse(draft.responseBody), null, 2) })
                          } catch { /* шаблон с плейсхолдерами не всегда валидный JSON — это нормально */ }
                        }}
                        className="inline-flex items-center gap-[5px] text-[12px] font-medium text-accent"
                      >
                        <Braces size={12} aria-hidden /> Форматировать
                      </button>
                    </div>
                    <textarea
                      ref={editorRef}
                      value={draft.responseBody}
                      onChange={(e) => setDraft({ ...draft, responseBody: e.target.value })}
                      spellCheck={false}
                      aria-label="Тело ответа"
                      className="min-h-0 flex-1 resize-none rounded-[6px] bg-code-bg p-[14px] font-mono text-[12px] leading-[1.4] text-code-text outline-none"
                    />

                    <div className="flex items-center justify-between">
                      <Overline>Предпросмотр · шаблоны подставлены</Overline>
                      <span className="rounded-[4px] bg-success-soft px-[7px] py-[2px] font-mono text-[11px] font-semibold text-success">
                        {draft.responseStatusCode} {draft.responseStatusCode === 201 ? 'Created' : 'OK'}
                      </span>
                    </div>
                    <div className="max-h-[150px] shrink-0 overflow-auto rounded-[6px] bg-surface-2 p-[12px] font-mono text-[11px] leading-[1.45] text-text-secondary">
                      {preview ? (
                        <>
                          {preview.rendered || '—'}
                          {!preview.validJson ? (
                            <p className="mt-[8px] text-[11px] text-warning">
                              После подстановки получается невалидный JSON — проверьте кавычки вокруг плейсхолдеров
                            </p>
                          ) : null}
                        </>
                      ) : draft.templatingEnabled ? '…' : 'Шаблонизация выключена — тело отдаётся как есть'}
                    </div>
                  </div>

                  {/* Правая колонка: настройки */}
                  <div className="flex w-[264px] shrink-0 flex-col gap-[18px] border-l border-border p-[16px]">
                    <div>
                      <Overline>Код ответа</Overline>
                      <div className="mt-[6px]">
                        <SegmentControl
                          segments={[200, 201, 400, 500].map((c) => ({ value: String(c), label: String(c) }))}
                          value={String(draft.responseStatusCode)}
                          onChange={(v) => setDraft({ ...draft, responseStatusCode: Number(v) })}
                        />
                      </div>
                    </div>

                    <div>
                      <Overline>Content-Type</Overline>
                      <select
                        value={draft.contentType}
                        onChange={(e) => setDraft({ ...draft, contentType: e.target.value })}
                        aria-label="Content-Type ответа"
                        className="mt-[6px] w-full rounded-[6px] border border-border-strong bg-surface px-[10px] py-[8px] text-[13px] outline-none"
                      >
                        {['application/json', 'application/xml', 'text/plain'].map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </div>

                    <Slider
                      label="Задержка ответа"
                      value={draft.delayMs}
                      min={0} max={3000} step={10}
                      onChange={(v) => setDraft({ ...draft, delayMs: v })}
                      formatValue={formatMs}
                      minLabel="0 мс" maxLabel="3000 мс"
                    />

                    <div className="flex items-start gap-[10px]">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-text-primary">Шаблонизация ответа</p>
                        <p className="mt-[2px] text-[11px] leading-[1.4] text-text-tertiary">
                          Плейсхолдеры в теле ответа подставляются при каждом вызове.
                        </p>
                      </div>
                      <Toggle
                        checked={draft.templatingEnabled}
                        onChange={(v) => setDraft({ ...draft, templatingEnabled: v })}
                        label="Шаблонизация ответа"
                      />
                    </div>

                    <div className="border-t border-border pt-[14px]">
                      <Overline>Плейсхолдеры</Overline>
                      <ul className="mt-[8px] flex flex-col gap-[8px]">
                        {data?.placeholders.map((p) => (
                          <li key={p.code}>
                            <PlaceholderChip onClick={() => insertPlaceholder(p.code)}>{p.code}</PlaceholderChip>
                            <p className="mt-[2px] text-[11px] text-text-tertiary">{p.description}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>

                <PanelFooter
                  left={
                    <span className="flex items-center gap-[8px]">
                      <span className="text-text-tertiary">Вызов:</span>
                      <MethodBadge method={draft.httpMethod} />
                      <span className="font-mono text-[12px] text-text-primary">{callUrl}</span>
                      <button
                        type="button"
                        aria-label="Копировать адрес вызова"
                        onClick={() => { void navigator.clipboard.writeText(callUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                        className="text-text-tertiary hover:text-text-secondary"
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </span>
                  }
                  right={
                    <span className="inline-flex items-center gap-[5px] text-[12px] font-semibold text-accent">
                      Открыть в консоли <ArrowRight size={12} aria-hidden />
                    </span>
                  }
                />
              </>
            )}
          </Panel>
        </div>
      </main>
    </>
  )
}
