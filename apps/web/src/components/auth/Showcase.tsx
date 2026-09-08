'use client'

import { useEffect, useState } from 'react'
import { AUTH_COLORS as C } from './AuthScreen'
import { API_URL } from '@/lib/api'

/**
 * Правая колонка экранов входа и регистрации: терминал, три метрики,
 * комментарии. Макет: «Экран — Вход», Showcase Column.
 *
 * Содержимое терминала — настоящие команды и настоящая форма ответа мока.
 * Придуманных команд здесь нет: в макете стоял `apistend login --code`
 * и `apistend init`, которых у CLI не существует.
 */

/** Роли раскраски строки терминала — из палитры кода дизайн-пакета. */
const TONE = {
  muted: C.dim,
  text: '#D5DCE6',
  key: '#7FB3FF',
  str: '#8FD69B',
  num: '#E5B86B',
  ok: '#3DD68C',
} as const

export type Span = { t: string; c?: keyof typeof TONE }

export function Terminal({ path, lines }: { path: string; lines: Array<Span[] | null> }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[14px]"
      style={{ background: C.column, border: `1px solid ${C.lineStrong}` }}
    >
      <div
        className="flex shrink-0 items-center gap-[12px] px-[16px] py-[12px]"
        style={{ background: C.chip, borderBottom: `1px solid ${C.lineStrong}` }}
      >
        <span className="flex shrink-0 gap-[6px]" aria-hidden>
          {['#E5695B', '#E5B86B', '#3DD68C'].map((color) => (
            <span key={color} className="h-[9px] w-[9px] rounded-full" style={{ background: color }} />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: C.dim }}>{path}</span>
        <span className="shrink-0 font-mono text-[11px]" style={{ color: C.dim }}>zsh</span>
      </div>

      <div className="flex flex-col gap-[3px] overflow-x-auto scrollbar-thin p-[20px]">
        {lines.map((spans, i) => (
          <span key={i} className="block font-mono text-[12px] leading-[1.35] whitespace-pre">
            {spans === null
              ? ' '
              : spans.map((s, j) => (
                  <span key={j} style={{ color: TONE[s.c ?? 'text'] }}>{s.t}</span>
                ))}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Три метрики под терминалом. В макете стоят «105 методов» и «41 мс» —
 * числа из ранней версии; берём настоящие из /health и замеряем его же ответ.
 */
export function Metrics() {
  const [health, setHealth] = useState<{ methods: number; services: number; ms: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const started = performance.now()
    fetch(`${API_URL}/health`)
      .then((r) => r.json())
      .then((d: { methods?: number; services?: string[] }) => {
        if (cancelled) return
        setHealth({
          methods: d.methods ?? 0,
          services: d.services?.length ?? 0,
          ms: Math.max(1, Math.round(performance.now() - started)),
        })
      })
      .catch(() => { /* витрина не обязана работать, чтобы можно было войти */ })
    return () => { cancelled = true }
  }, [])

  const tiles: Array<[string, string]> = [
    [health ? new Intl.NumberFormat('ru-RU').format(health.methods) : '—', 'методов в каталоге'],
    [health ? String(health.services) : '—', 'сервиса: B24 · Ozon · WB'],
    [health ? `${health.ms} мс` : '—', 'ответ API из браузера'],
  ]

  return (
    <div className="flex gap-[12px]">
      {tiles.map(([value, label]) => (
        <div
          key={label}
          className="flex min-w-0 flex-1 flex-col gap-[3px] rounded-[10px] px-[16px] py-[14px]"
          style={{ background: C.column, border: `1px solid ${C.line}` }}
        >
          <span className="font-mono text-[18px] font-bold tabular" style={{ color: C.white }}>{value}</span>
          <span className="truncate font-mono text-[11px]" style={{ color: C.dim }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

export function Comments({ lines }: { lines: readonly string[] }) {
  return (
    <div className="flex flex-col gap-[5px]">
      {lines.map((line) => (
        <span key={line} className="font-mono text-[12px] leading-[1.4]" style={{ color: C.dim }}>{line}</span>
      ))}
    </div>
  )
}
