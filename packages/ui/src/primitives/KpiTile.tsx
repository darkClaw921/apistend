import type { ReactNode } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '../lib/cn.ts'

/**
 * KPI-плитка. design-handoff/02-components.md, п. 14.
 * Значение 26/700, трекинг −0.6. Чип изменения: рост — success, ухудшение — warning.
 */

export type DeltaTone = 'good' | 'bad' | 'neutral'

export function KpiTile({
  label, value, icon, delta, deltaTone = 'neutral', deltaSuffix, className,
}: {
  label: string
  value: ReactNode
  icon?: ReactNode
  delta?: string
  deltaTone?: DeltaTone
  /** «к вчера», «за неделю», «за 24 ч» — подпись справа от чипа. */
  deltaSuffix?: string
  className?: string
}) {
  const tone =
    deltaTone === 'good'
      ? 'bg-success-soft text-success'
      : deltaTone === 'bad'
        ? 'bg-warning-soft text-warning'
        : 'bg-surface-2 text-text-secondary'

  const showTrend = deltaTone !== 'neutral'
  const down = delta?.startsWith('−') || delta?.startsWith('-')

  return (
    <div className={cn('flex flex-col gap-[10px] rounded-[10px] border border-border bg-surface p-[16px]', className)}>
      <div className="flex items-center gap-[8px]">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        {icon ? <span className="ml-auto text-text-tertiary">{icon}</span> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-[10px]">
        <span className="text-[26px] leading-none font-bold tracking-[-0.6px] text-text-primary tabular">{value}</span>
        {delta ? (
          <span className={cn('inline-flex items-center gap-[4px] rounded-[20px] px-[7px] py-[3px] text-[11px] font-medium', tone)}>
            {showTrend ? (down ? <TrendingDown size={12} aria-hidden /> : <TrendingUp size={12} aria-hidden />) : null}
            {delta}
          </span>
        ) : null}
        {deltaSuffix ? <span className="text-[11px] text-text-tertiary">{deltaSuffix}</span> : null}
      </div>
    </div>
  )
}
