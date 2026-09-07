'use client'

import { formatInt } from '@apistend/ui'

/**
 * Почасовой график активности. design-handoff/screens/04-request-logs.md, п. 1.
 *
 * «Только столбчатая диаграмма: подписи и столбцы связаны раскладкой, без абсолютного
 * позиционирования» — поэтому это grid, а не canvas и не absolute.
 */
export function HourlyChart({
  buckets,
}: { buckets: Array<{ hour: string; total: number; errors: number }> }) {
  if (buckets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-tertiary">
        Запросов за период не было
      </div>
    )
  }

  const max = Math.max(...buckets.map((b) => b.total), 1)

  return (
    <div className="flex h-full flex-col gap-[6px]">
      <div className="flex items-center gap-[14px] text-[11px] text-text-tertiary">
        <span className="ml-auto inline-flex items-center gap-[5px]">
          <span className="h-[7px] w-[7px] rounded-full bg-accent" aria-hidden /> Успешные
        </span>
        <span className="inline-flex items-center gap-[5px]">
          <span className="h-[7px] w-[7px] rounded-full bg-danger" aria-hidden /> Ошибки
        </span>
      </div>

      <ol
        className="flex min-h-0 flex-1 items-end gap-[3px]"
        aria-label="Активность по часам"
      >
        {buckets.map((b) => {
          const heightPct = (b.total / max) * 100
          const errorPct = b.total > 0 ? (b.errors / b.total) * 100 : 0
          const hour = new Date(b.hour).getHours()
          return (
            <li
              key={b.hour}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${String(hour).padStart(2, '0')}:00 — ${formatInt(b.total)} запросов, ошибок ${formatInt(b.errors)}`}
            >
              <span
                style={{ height: `${Math.max(heightPct, 2)}%` }}
                className="flex w-full flex-col justify-end overflow-hidden rounded-t-[2px] bg-accent"
              >
                {b.errors > 0 ? (
                  <span style={{ height: `${errorPct}%` }} className="w-full bg-danger" aria-hidden />
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>

      <div className="flex justify-between text-[10px] text-text-tertiary tabular">
        {[0, 0.25, 0.5, 0.75, 1].map((p) => {
          const b = buckets[Math.min(buckets.length - 1, Math.floor((buckets.length - 1) * p))]
          return <span key={p}>{b ? `${String(new Date(b.hour).getHours()).padStart(2, '0')}:00` : ''}</span>
        })}
      </div>
    </div>
  )
}
