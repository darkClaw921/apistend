'use client'

import type { InputHTMLAttributes, ReactNode } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../lib/cn.ts'

/**
 * Поля и переключатели. design-handoff/02-components.md, пп. 6, 9, 10, 12, 13.
 */

/** Search Field: ширина 236–280, паддинг 8×12, радиус 6, иконка 15 px, плейсхолдер 13 px. */
export function SearchField({
  value, onValueChange, placeholder, width = 280, matches, className, ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'width'> & {
  value: string
  onValueChange: (v: string) => void
  placeholder: string
  width?: number | 'full'
  /** Счётчик совпадений справа — появляется, когда что-то введено. */
  matches?: number
}) {
  return (
    <div
      style={width === 'full' ? undefined : { width }}
      className={cn(
        'group flex shrink-0 items-center gap-[8px] rounded-[6px] border border-border bg-surface px-[12px] py-[8px]',
        'transition-shadow duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(59,84,245,0.12)]',
        width === 'full' && 'w-full',
        className,
      )}
    >
      <Search size={15} className="shrink-0 text-text-tertiary" aria-hidden />
      <input
        {...rest}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden"
      />
      {matches !== undefined && value.length > 0 ? (
        <span className="shrink-0 text-[11px] text-text-tertiary tabular whitespace-nowrap">
          {matches} совпадени{matches % 10 === 1 && matches % 100 !== 11 ? 'е' : matches % 10 >= 2 && matches % 10 <= 4 && (matches % 100 < 12 || matches % 100 > 14) ? 'я' : 'й'}
        </span>
      ) : null}
    </div>
  )
}

export interface Segment {
  value: string
  label: ReactNode
  count?: number
}

/**
 * Сегмент-контрол. Обёртка surface-2, радиус 6, паддинг 3, зазор 3.
 * Активный сегмент: фон surface, граница border, текст 12/600.
 */
export function SegmentControl({
  segments, value, onChange, className,
}: { segments: readonly Segment[]; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('inline-flex shrink-0 gap-[3px] rounded-[6px] bg-surface-2 p-[3px]', className)}>
      {segments.map((s) => {
        const active = s.value === value
        return (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.value)}
            className={cn(
              'inline-flex items-center gap-[6px] rounded-[5px] px-[12px] py-[6px] whitespace-nowrap transition-colors duration-150',
              active
                ? 'border border-border bg-surface text-[12px] font-semibold text-text-primary'
                : 'border border-transparent text-[12px] font-medium text-text-secondary hover:text-text-primary',
            )}
          >
            {s.label}
            {s.count !== undefined ? (
              <span className={cn('font-mono text-[11px] tabular', active ? 'text-accent' : 'text-text-tertiary')}>
                {s.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export interface TabItem {
  value: string
  label: ReactNode
  count?: number
}

/** Вкладки: ряд с нижней границей, зазор 24. Активная — 13/600 + нижняя граница 2 px accent. */
export function Tabs({
  items, value, onChange, className,
}: { items: readonly TabItem[]; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('flex shrink-0 items-end gap-[24px] border-b border-border px-[16px]', className)}>
      {items.map((t) => {
        const active = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'inline-flex items-center gap-[6px] border-b-2 pt-[14px] pb-[12px] whitespace-nowrap transition-colors duration-150',
              active
                ? 'border-accent text-[13px] font-semibold text-text-primary'
                : 'border-transparent text-[13px] font-medium text-text-secondary hover:text-text-primary',
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className="font-mono text-[11px] text-text-tertiary tabular">{t.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** Тумблер 36×20, кружок 16×16, отступ 2 px. */
export function Toggle({
  checked, onChange, label, className,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[20px] w-[36px] shrink-0 rounded-[10px] transition-colors duration-150',
        checked ? 'bg-accent' : 'bg-surface-3',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white transition-[left] duration-150 ease-out',
          checked ? 'left-[18px]' : 'left-[2px]',
        )}
      />
    </button>
  )
}

/**
 * Слайдер. Трек surface-3 высотой 5, заполнение accent.
 * Над треком: слева надзаголовок, справа значение mono 12/600. Под треком — границы диапазона.
 */
export function Slider({
  label, value, min, max, step = 1, onChange, formatValue, minLabel, maxLabel, className,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  formatValue: (v: number) => string
  minLabel: string
  maxLabel: string
  className?: string
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <div className={cn('flex flex-col gap-[8px]', className)}>
      <div className="flex items-baseline justify-between gap-[12px]">
        <span className="text-[13px] text-text-primary">{label}</span>
        <span className="font-mono text-[12px] font-semibold text-accent tabular">{formatValue(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-surface-3) ${pct}%)`,
        }}
        className={cn(
          'h-[5px] w-full cursor-pointer appearance-none rounded-[3px]',
          '[&::-webkit-slider-thumb]:h-[14px] [&::-webkit-slider-thumb]:w-[14px] [&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface',
          '[&::-moz-range-thumb]:h-[14px] [&::-moz-range-thumb]:w-[14px] [&::-moz-range-thumb]:rounded-full',
          '[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:bg-accent',
        )}
      />
      <div className="flex justify-between text-[10px] text-text-tertiary">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  )
}
