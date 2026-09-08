'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, Copy, FileDown, SlidersHorizontal, X } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CounterChip, DataTable, EmptyState, ErrorState,
  MethodBadge, Panel, PanelFooter, PanelHeader, SearchField, SegmentControl,
  ServiceDot, SkeletonRows, StatusChip, formatInt, formatMethods, meta,
} from '@apistend/ui'
import type { Column } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { useOptionalShell } from '@/components/AppShell'
import type { CatalogListItem, CatalogResponse, ServiceSummary } from '@/lib/types'
import { Topbar } from '@/components/Topbar'
import { MethodDetailPanel } from '@/components/MethodDetailPanel'
import { READINESS_LABEL, READINESS_TONE } from '@/lib/readiness'
import { buildPostmanCollection, downloadJson } from '@/lib/postman'

/**
 * Экран «Каталог API». design-handoff/screens/02-api-catalog.md.
 *
 * Задача экрана: найти метод и понять, что он умеет, до того как звать его из кода.
 * Выбор строки обновляет правую панель без перезагрузки, идентификатор метода
 * попадает в адрес страницы — ссылкой можно поделиться.
 */

const PAGE_SIZE = 40
const HTTP_METHODS = ['any', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

const READINESS_FILTERS = [
  { value: 'any', label: 'любая' },
  { value: 'ready,updating', label: 'готов и в работе' },
  { value: 'ready', label: 'только готовые' },
  { value: 'planned', label: 'запланированные' },
] as const

/**
 * useSearchParams требует границы Suspense — тот же приём, что в консоли и портале.
 */
export default function CatalogPage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-bg" />}>
      <CatalogScreen />
    </Suspense>
  )
}

function CatalogScreen() {
  const router = useRouter()
  // null — страницу открыл гость: каталог доступен без входа.
  const shell = useOptionalShell()
  const searchParams = useSearchParams()

  const [services, setServices] = useState<ServiceSummary[]>([])
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [service, setService] = useState('all')
  const [httpMethod, setHttpMethod] = useState<string>('any')
  const [readiness, setReadiness] = useState<string>('ready,updating')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)
  // Метод в адресе: по такой ссылке карточка открывается сразу — это обещано
  // в шапке файла и нужно поиску из шапки, который сюда и ведёт.
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('method'))
  // Метод из ссылки почти всегда лежит не на первой странице списка, а карточку
  // справа грузит отдельный запрос по идентификатору — значит показать его можно
  // и не находя в выдаче.
  const linkedId = searchParams.get('method')
  const [globalSearch, setGlobalSearch] = useState('')
  const [exporting, setExporting] = useState(false)

  // Дебаунс 200 мс — как задано в спецификации поведения поиска.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query)
      setPage(0)
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    api.get<{ services: ServiceSummary[] }>('/api/services')
      .then((r) => setServices(r.services))
      .catch(() => setServices([]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      readiness,
      method: httpMethod,
    })
    if (service !== 'all') params.set('service', service)
    if (debounced.trim().length >= 2) params.set('q', debounced.trim())

    try {
      const res = await api.get<CatalogResponse>(`/api/catalog?${params}`)
      setData(res)
      setSelectedId((current) => {
        // Сравнение с адресом, а не одноразовый флаг: в режиме разработки React
        // монтирует компонент дважды, и флаг сгорел бы на первом проходе.
        if (current && (current === linkedId || res.methods.some((m) => m.id === current))) return current
        return res.methods[0]?.id ?? null
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить каталог')
    } finally {
      setLoading(false)
    }
  }, [service, httpMethod, readiness, debounced, page, linkedId])

  useEffect(() => { void load() }, [load])

  /**
   * Экспорт коллекции Postman.
   *
   * Выгружается вся текущая выборка, а не видимая страница: фильтры на экране
   * и есть то, что пользователь выбрал. Каталог отдаёт максимум 200 методов
   * за раз, поэтому дочитываем страницами — на всём каталоге это около десятка
   * запросов, и они дешёвые.
   */
  async function exportCollection() {
    setExporting(true)
    try {
      const collected: CatalogListItem[] = []
      const PAGE = 200
      for (let offset = 0; ; offset += PAGE) {
        const params = new URLSearchParams({
          limit: String(PAGE), offset: String(offset), readiness, method: httpMethod,
        })
        if (service !== 'all') params.set('service', service)
        if (debounced.trim().length >= 2) params.set('q', debounced.trim())

        const res = await api.get<CatalogResponse>(`/api/catalog?${params}`)
        collected.push(...res.methods)
        if (collected.length >= res.total || res.methods.length === 0) break
      }

      const note = [
        service === 'all' ? 'Все сервисы' : (services.find((s) => s.code === service)?.title ?? service),
        httpMethod === 'any' ? null : `метод ${httpMethod}`,
        debounced.trim().length >= 2 ? `поиск «${debounced.trim()}»` : null,
        `${collected.length} методов`,
      ].filter(Boolean).join(' · ')

      const stamp = new Date().toISOString().slice(0, 10)
      downloadJson(
        buildPostmanCollection(collected, services, note),
        `apistend-catalog-${stamp}.postman_collection.json`,
      )
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось собрать коллекцию')
    } finally {
      setExporting(false)
    }
  }

  const totalCatalog = useMemo(() => services.reduce((n, s) => n + s.methodsCount, 0), [services])
  const snapshot = services.find((s) => s.snapshotDate)?.snapshotDate ?? null

  const segments = useMemo(
    () => [
      { value: 'all', label: 'Все сервисы' },
      ...services.map((s) => ({
        value: s.code,
        label: (
          <span className="inline-flex items-center gap-[6px]">
            <ServiceDot service={s.code} size={7} />
            {s.title}
          </span>
        ),
      })),
    ],
    [services],
  )

  const columns: Array<Column<CatalogListItem>> = useMemo(
    () => [
      { key: 'method', header: 'Метод', width: 78, render: (m) => <MethodBadge method={m.httpMethod} /> },
      {
        key: 'path', header: 'Эндпоинт', width: 300, mono: true,
        render: (m) => (
          <span className={m.id === selectedId ? 'text-accent' : 'text-text-primary'} title={m.path}>
            {m.path}
          </span>
        ),
      },
      {
        key: 'description', header: 'Описание',
        render: (m) => <span className="text-text-secondary" title={m.title}>{m.description || m.title}</span>,
      },
      {
        key: 'version', header: 'Версия', width: 74, mono: true,
        render: (m) => <span className="text-text-tertiary">{m.version}</span>,
      },
      {
        key: 'readiness', header: 'Мок', width: 124,
        render: (m) => (
          <StatusChip tone={READINESS_TONE[m.readiness]}>{READINESS_LABEL[m.readiness]}</StatusChip>
        ),
      },
    ],
    [selectedId],
  )

  const shownFrom = page * PAGE_SIZE + 1
  const shownTo = Math.min((page + 1) * PAGE_SIZE, data?.total ?? 0)
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const filtersActive = service !== 'all' || httpMethod !== 'any' || readiness !== 'ready,updating' || debounced.length > 0

  function resetFilters() {
    setService('all'); setHttpMethod('any'); setReadiness('ready,updating'); setQuery(''); setPage(0)
  }

  return (
    <>
      <Topbar
        // Гость проекта не имеет, и звать его «Новой песочницей» рано:
        // сначала регистрация.
        breadcrumb={shell ? 'Проект «Интеграция 1С» / Каталог API' : 'Демо-API Bitrix24, Ozon и Wildberries'}
        title="Каталог API"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        showTools={shell !== null}
        action={
          shell ? (
            <ButtonPrimary onClick={() => router.push('/keys')}>Новая песочница</ButtonPrimary>
          ) : (
            <ButtonPrimary onClick={() => router.push('/register')}>Создать песочницу</ButtonPrimary>
          )
        }
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] p-[24px]">
        {/* Панель фильтров */}
        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          <SegmentControl segments={segments} value={service} onChange={(v) => { setService(v); setPage(0) }} />

          <label className="inline-flex items-center gap-[6px] rounded-[6px] border border-border-strong bg-surface px-[10px] py-[6px]">
            <span className="text-[12px] text-text-secondary">Метод:</span>
            <select
              value={httpMethod}
              onChange={(e) => { setHttpMethod(e.target.value); setPage(0) }}
              className="bg-transparent text-[12px] font-semibold text-text-primary outline-none"
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>{m === 'any' ? 'любой' : m}</option>
              ))}
            </select>
          </label>

          <label className="inline-flex items-center gap-[6px] rounded-[6px] border border-accent bg-accent-soft px-[10px] py-[6px]">
            <span className="text-[12px] text-accent">Готовность:</span>
            <select
              value={readiness}
              onChange={(e) => { setReadiness(e.target.value); setPage(0) }}
              className="bg-transparent text-[12px] font-semibold text-accent outline-none"
            >
              {READINESS_FILTERS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            {readiness !== 'any' ? (
              <button type="button" onClick={() => setReadiness('any')} aria-label="Снять фильтр готовности">
                <X size={13} className="text-accent" aria-hidden />
              </button>
            ) : null}
          </label>

          <div className="ml-auto">
            <SearchField
              value={query}
              onValueChange={setQuery}
              placeholder="Поиск по пути или названию"
              width={280}
              matches={data?.total}
              aria-label="Поиск по каталогу"
            />
          </div>
        </div>

        {/* Рабочая область: список слева, деталка справа */}
        <div className="flex min-h-0 flex-1 gap-[20px]">
          <Panel className="min-w-0 flex-1">
            <PanelHeader
              title="Методы демо-API"
              count={
                <CounterChip>
                  {data ? `${formatInt(Math.min(data.methods.length, data.total))} из ${formatInt(data.total)}` : '—'}
                </CounterChip>
              }
              right={
                <>
                  <span className="inline-flex items-center gap-[6px] text-[12px] text-text-tertiary">
                    Группировка: по сервису
                    <SlidersHorizontal size={13} aria-hidden />
                  </span>
                  <ButtonSecondary
                    tone="quiet"
                    icon={<FileDown size={13} aria-hidden />}
                    onClick={() => void exportCollection()}
                    disabled={exporting}
                  >
                    {exporting ? 'Собираю…' : 'Экспорт коллекции'}
                  </ButtonSecondary>
                </>
              }
            />

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {loading && !data ? (
                <SkeletonRows rows={12} />
              ) : error ? (
                <ErrorState message={error} onRetry={() => void load()} />
              ) : data && data.methods.length === 0 ? (
                <EmptyState
                  icon={<X size={20} aria-hidden />}
                  title="Ничего не найдено"
                  description={
                    filtersActive
                      ? 'Попробуйте другой запрос или снимите фильтры'
                      : 'В каталоге пока нет методов этого сервиса'
                  }
                  action={filtersActive ? <ButtonSecondary onClick={resetFilters}>Сбросить фильтр</ButtonSecondary> : null}
                />
              ) : (
                <DataTable
                  columns={columns}
                  rows={data?.methods ?? []}
                  rowKey={(m) => m.id}
                  rowTone={(m) => (m.id === selectedId ? 'selected' : 'default')}
                  onRowClick={(m) => {
                    setSelectedId(m.id)
                    // Идентификатор уезжает в адрес — ссылкой на метод можно
                    // поделиться. replaceState, а не router: перерисовывать
                    // страницу ради выделения строки незачем.
                    window.history.replaceState(null, '', `/catalog?method=${encodeURIComponent(m.id)}`)
                  }}
                />
              )}
            </div>

            <PanelFooter
              left={
                data
                  ? meta(
                      `Показано ${formatInt(shownFrom)}–${formatInt(shownTo)} из ${formatMethods(data.total)}`,
                      snapshot ? `снимок ${snapshot}` : null,
                    )
                  : null
              }
              right={
                <div className="flex items-center gap-[6px]">
                  <button
                    type="button"
                    aria-label="Предыдущая страница"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border bg-surface text-text-secondary disabled:text-text-tertiary"
                  >
                    <ChevronLeft size={14} aria-hidden />
                  </button>
                  <span className="font-mono text-[11px] text-text-tertiary tabular">
                    {page + 1} / {pageCount}
                  </span>
                  <button
                    type="button"
                    aria-label="Следующая страница"
                    disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => p + 1)}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border bg-surface text-text-secondary disabled:text-text-tertiary"
                  >
                    <ChevronRight size={14} aria-hidden />
                  </button>
                </div>
              }
            />
          </Panel>

          <MethodDetailPanel methodId={selectedId} totalCatalog={totalCatalog} />
        </div>
      </main>
    </>
  )
}
