'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import { CornerDownLeft, FileText, Search } from 'lucide-react'
import { EmptyState } from '@apistend/ui'
import type { SearchEntry } from '@/lib/docs/source'

/**
 * Поиск по документации. Клиентский, по индексу, собранному при сборке
 * (getSearchIndex) и переданному сюда пропсом: внешних служб нет.
 *
 * Устройство и клавиатура повторяют палитру кабинета (components/GlobalSearch.tsx) —
 * ↑ ↓ выбор, Enter открыть, Esc закрыть. Разница одна: там запрос уходит на сервер
 * и нужен дебаунс, здесь массив уже в памяти и фильтр считается на каждое нажатие.
 */

const LIMIT = 12

export function DocsSearch({ index, onClose }: { index: SearchEntry[]; onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
    if (words.length === 0) return []
    const scored: Array<{ entry: SearchEntry; score: number }> = []
    for (const entry of index) {
      const section = entry.section.toLowerCase()
      let score = 0
      let all = true
      for (const w of words) {
        // Совпадение в заголовке раздела весит больше, чем в теле: иначе наверх
        // всплывает страница, где слово встретилось десять раз в примерах.
        if (section.includes(w)) score += 10
        else if (entry.body.includes(w)) score += 1
        else { all = false; break }
      }
      if (all) scored.push({ entry, score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, LIMIT).map((s) => s.entry)
  }, [index, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  function open(entry: SearchEntry) {
    onClose()
    router.push(entry.href as Route)
  }

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
          placeholder="Поиск по документации"
          aria-label="Поиск по документации"
          className="w-full bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </div>

      <div className="max-h-[380px] min-h-[120px] overflow-y-auto scrollbar-thin">
        {query.trim().length < 2 ? (
          <EmptyState title="Введите запрос" description="Минимум два символа: название раздела или слово из текста" />
        ) : results.length === 0 ? (
          <EmptyState title="Ничего не найдено" description="Попробуйте другой запрос" />
        ) : (
          <ul>
            {results.map((r, i) => (
              <li key={r.href}>
                <button
                  type="button"
                  onClick={() => open(r)}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center gap-[10px] px-[16px] py-[10px] text-left ${i === cursor ? 'bg-bg' : ''}`}
                >
                  <FileText size={14} className="shrink-0 text-text-tertiary" aria-hidden />
                  <span className="truncate text-[13px] text-text-primary">{r.section}</span>
                  <span className="ml-auto truncate pl-[10px] text-[12px] text-text-tertiary">
                    {r.group ? `${r.group} · ${r.page}` : r.page}
                  </span>
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
