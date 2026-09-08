'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CornerDownLeft, Search } from 'lucide-react'
import { EmptyState, MethodBadge, ServiceDot, SkeletonRows } from '@apistend/ui'
import { isServiceCode } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import type { SearchResponse, SearchResult } from '@/lib/types'

/**
 * Поиск из шапки. Чип ⌘K был нарисован в макете с самого начала, но ничего
 * не открывал: поле шапки заводило состояние на каждом экране и нигде его
 * не читало.
 *
 * Ищет по каталогу методов — то же, что делает панель поиска на «Обзоре».
 * Эндпоинт /api/search сессии не требует, поэтому палитра работает и в каталоге,
 * открытом гостю.
 */

const LIMIT = 8

export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  // Дебаунс 200 мс — как на «Обзоре»: набор идёт быстрее, чем отвечает сеть.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    // Сервер отвечает пустым списком короче двух символов — не ходим зря.
    if (debounced.length < 2) {
      setResults([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await api.get<SearchResponse>(
          `/api/search?q=${encodeURIComponent(debounced)}&limit=${LIMIT}`,
        )
        if (cancelled) return
        setResults(res.results)
        setCursor(0)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Не удалось выполнить поиск')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [debounced])

  const open = useCallback(
    (r: SearchResult) => {
      onClose()
      // Каталог открывает карточку метода по идентификатору в адресе —
      // ссылкой на найденный метод можно поделиться.
      router.push(`/catalog?method=${encodeURIComponent(r.id)}`)
    },
    [onClose, router],
  )

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(results.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      const hit = results[cursor]
      if (hit) open(hit)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-[10px] border-b border-border px-[16px] py-[12px]">
        <Search size={16} className="shrink-0 text-text-tertiary" aria-hidden />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Поиск методов, сервисов, логов"
          aria-label="Поиск по каталогу"
          className="w-full bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </div>

      <div className="max-h-[380px] min-h-[120px] overflow-y-auto scrollbar-thin">
        {debounced.length < 2 ? (
          <EmptyState title="Введите запрос" description="Минимум два символа: путь, название метода или часть описания" />
        ) : loading && results.length === 0 ? (
          <SkeletonRows rows={5} />
        ) : error ? (
          <EmptyState title="Поиск не удался" description={error} />
        ) : results.length === 0 ? (
          <EmptyState title="Ничего не найдено" description="Попробуйте другой запрос" />
        ) : (
          <ul>
            {results.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open(r)}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center gap-[10px] px-[16px] py-[10px] text-left ${
                    i === cursor ? 'bg-bg' : ''
                  }`}
                >
                  {isServiceCode(r.serviceCode) ? <ServiceDot service={r.serviceCode} /> : null}
                  <MethodBadge method={r.httpMethod} />
                  <span className="truncate font-mono text-[12px] text-text-primary">{r.path}</span>
                  <span className="ml-auto truncate text-[12px] text-text-tertiary">{r.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-[14px] border-t border-border px-[16px] py-[9px] text-[11px] text-text-tertiary">
        <span className="flex items-center gap-[5px]">
          <CornerDownLeft size={12} aria-hidden /> открыть
        </span>
        <span>↑ ↓ выбрать</span>
        <span>Esc закрыть</span>
      </div>
    </div>
  )
}
