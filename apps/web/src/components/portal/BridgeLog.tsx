'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { JsonViewer, CounterChip, EmptyState, Panel, PanelHeader, cn, formatTimeMs } from '@apistend/ui'

/**
 * Журнал моста между порталом и фреймом приложения.
 *
 * Боевой Bitrix24 обмен BX24.js с порталом не показывает нигде: разработчик видит
 * только последствия — «окно не изменило размер», «диалог не открылся». Здесь виден
 * сам кадр, и это главная отладочная ценность экрана.
 */

/** Лента ограничена: приложение в цикле resizeWindow способно выдать тысячи кадров в минуту. */
export const BRIDGE_LOG_LIMIT = 200

export interface BridgeLogEntry {
  readonly id: string
  readonly at: Date
  /** in — кадр от приложения, out — кадр портала. */
  readonly dir: 'in' | 'out'
  readonly appSid: string
  /** Команда или тип кадра: hello, init, resizeWindow. */
  readonly label: string
  readonly summary: string
  /** Результат с ошибкой: строка красится в danger. */
  readonly failed?: boolean
  readonly payload: unknown
}

export type BridgeLogInput = Omit<BridgeLogEntry, 'id' | 'at'>
export type BridgeLogger = (entry: BridgeLogInput) => void

export interface BridgeLog {
  readonly entries: BridgeLogEntry[]
  readonly push: BridgeLogger
  readonly clear: () => void
}

export function useBridgeLog(): BridgeLog {
  const [entries, setEntries] = useState<BridgeLogEntry[]>([])
  const seq = useRef(0)

  const push = useCallback<BridgeLogger>((entry) => {
    seq.current += 1
    const id = String(seq.current)
    setEntries((prev) => [{ ...entry, id, at: new Date() }, ...prev].slice(0, BRIDGE_LOG_LIMIT))
  }, [])

  const clear = useCallback(() => setEntries([]), [])

  // Ссылка на объект журнала стабильна: он попадает в зависимости эффекта открытия фрейма.
  return useMemo(() => ({ entries, push, clear }), [entries, push, clear])
}

/** Короткая сводка параметров кадра для строки ленты. */
export function summarize(value: unknown, limit = 96): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return clip(value, limit)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? '—' : clip(text, limit)
  } catch {
    return String(value)
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function pretty(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload)
  } catch {
    return String(payload)
  }
}

export function BridgeLogPanel({
  log, className,
}: { log: BridgeLog; className?: string }) {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <Panel className={className}>
      <PanelHeader
        title="Обмен с приложением"
        count={<CounterChip>{log.entries.length}</CounterChip>}
        right={
          <button
            type="button"
            onClick={() => { log.clear(); setOpenId(null) }}
            disabled={log.entries.length === 0}
            className="text-[12px] font-semibold text-accent disabled:text-text-tertiary hover:enabled:underline"
          >
            Очистить
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {log.entries.length === 0 ? (
          <EmptyState
            title="Кадров пока нет"
            description="Мост оживёт, когда страница приложения подключит BX24.js и вызовет BX24.init()"
          />
        ) : (
          <ul>
            {log.entries.map((e) => {
              const expanded = openId === e.id
              return (
                <li key={e.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpenId((cur) => (cur === e.id ? null : e.id))}
                    className={cn(
                      'flex w-full flex-col gap-[2px] px-[12px] py-[8px] text-left transition-colors duration-100',
                      expanded ? 'bg-accent-soft' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-[8px]">
                      <span className="shrink-0 font-mono text-[11px] text-text-tertiary tabular">
                        {formatTimeMs(e.at)}
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          'shrink-0 font-mono text-[12px] leading-none',
                          e.dir === 'in' ? 'text-accent' : 'text-text-tertiary',
                        )}
                      >
                        {e.dir === 'in' ? '←' : '→'}
                      </span>
                      <span className="sr-only">{e.dir === 'in' ? 'от приложения:' : 'от портала:'}</span>
                      <span
                        className={cn(
                          'min-w-0 truncate font-mono text-[11px] font-semibold',
                          e.failed ? 'text-danger' : 'text-text-primary',
                        )}
                      >
                        {e.label}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-text-secondary">{e.summary}</span>
                  </button>
                  {expanded ? (
                    <JsonViewer className="mx-[12px] mb-[10px]" size="sm" code={pretty(e.payload)} maxHeight={280} />
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Panel>
  )
}
