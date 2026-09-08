import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * Таблица. design-handoff/02-components.md, п. 8.
 *
 * Размечена семантически (table/thead/tbody) — пункт чек-листа доступности.
 * Ширины колонок фиксированные в px, последняя содержательная колонка тянется.
 */

export interface Column<T> {
  key: string
  header: ReactNode
  /** Ширина в px. Не задана — колонка тянется. */
  width?: number
  align?: 'left' | 'right'
  render: (row: T, index: number) => ReactNode
  /** Моноширинный шрифт: пути, коды, время, идентификаторы. */
  mono?: boolean
  /**
   * Классы колонки целиком: применяются к col, th и td.
   * Так колонку можно скрыть на узком экране (`max-xl:hidden`) — без этого
   * скрывались бы только ячейки, а заголовок и ширина оставались бы на месте.
   */
  className?: string
}

export type RowTone = 'default' | 'selected' | 'error' | 'warning'

/** Подсветка строк: ошибочные — danger-soft 40 %, 429 — warning-soft 40 %, выбранная — accent-soft. */
const ROW_TONE: Record<RowTone, string> = {
  default: 'hover:bg-surface-2',
  selected: 'bg-accent-soft',
  error: 'bg-danger-soft/40 hover:bg-danger-soft/60',
  warning: 'bg-warning-soft/40 hover:bg-warning-soft/60',
}

export function DataTable<T>({
  columns, rows, rowKey, rowTone, onRowClick, dense, className, emptyState,
}: {
  columns: ReadonlyArray<Column<T>>
  rows: readonly T[]
  rowKey: (row: T, index: number) => string
  rowTone?: (row: T, index: number) => RowTone
  onRowClick?: (row: T, index: number) => void
  /** Плотный режим: строки 36 px, как в «Логах запросов». */
  dense?: boolean
  className?: string
  emptyState?: ReactNode
}) {
  if (rows.length === 0 && emptyState) return <>{emptyState}</>

  return (
    <table className={cn('w-full table-fixed border-collapse', className)}>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} className={c.className} style={c.width ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead className="sticky top-0 z-10">
        <tr className="bg-surface-2">
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={cn(
                'border-b border-border py-[9px] text-[11px] font-semibold tracking-[0.3px] text-text-tertiary',
                dense ? 'px-[12px]' : 'px-[16px]',
                c.align === 'right' ? 'text-right' : 'text-left',
                c.className,
              )}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const tone = rowTone?.(row, i) ?? 'default'
          return (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row, i) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row, i)
                      }
                    }
                  : undefined
              }
              aria-selected={tone === 'selected' || undefined}
              className={cn(
                'border-b border-border transition-colors duration-100 last:border-b-0',
                ROW_TONE[tone],
                onRowClick && 'cursor-pointer',
              )}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'truncate align-middle',
                    // Плотный режим («Логи запросов»): строка 36 px и узкие боковые
                    // отступы, иначе восемь колонок не помещаются в 792 px.
                    dense ? 'px-[12px] py-[9px] text-[13px]' : 'px-[16px] py-[12px] text-[13px]',
                    c.mono ? 'font-mono text-[12px] tabular' : '',
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.className,
                  )}
                >
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Строка-заголовок группы в списке методов: название сервиса, точка, счётчик. */
export function GroupRow({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-[8px] border-b border-border bg-surface-2/60 px-[16px] py-[7px]">
      {left}
      {right ? <div className="ml-auto text-[11px] text-text-tertiary tabular">{right}</div> : null}
    </div>
  )
}
