import type { ReactNode } from 'react'
import type { ServiceCode } from '@apistend/shared'
import { SERVICE_PROFILES } from '@apistend/shared'
import { cn } from '../lib/cn.ts'

/**
 * Бейджи и чипы. design-handoff/02-components.md, пп. 4, 5, 16.
 *
 * Правило пары цветов: насыщенный цвет — текст и иконка, *-soft — фон. Никогда наоборот.
 */

const METHOD_TONE: Record<string, string> = {
  GET: 'text-success bg-success-soft',
  POST: 'text-accent bg-accent-soft',
  PUT: 'text-warning bg-warning-soft',
  PATCH: 'text-warning bg-warning-soft',
  DELETE: 'text-danger bg-danger-soft',
  HEAD: 'text-text-secondary bg-surface-2',
  OPTIONS: 'text-text-secondary bg-surface-2',
}

/** Method Badge: паддинг 3×7, радиус 4, mono 11/700, трекинг 0.4. Всегда слева от пути. */
export function MethodBadge({ method, className }: { method: string; className?: string }) {
  const upper = method.toUpperCase()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] px-[7px] py-[3px]',
        'font-mono text-[11px] font-bold tracking-[0.4px]',
        METHOD_TONE[upper] ?? METHOD_TONE.GET,
        className,
      )}
    >
      {upper}
    </span>
  )
}

export type ChipTone = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'

const CHIP_TONE: Record<ChipTone, { text: string; bg: string; dot: string }> = {
  success: { text: 'text-success', bg: 'bg-success-soft', dot: 'bg-success' },
  warning: { text: 'text-warning', bg: 'bg-warning-soft', dot: 'bg-warning' },
  danger: { text: 'text-danger', bg: 'bg-danger-soft', dot: 'bg-danger' },
  info: { text: 'text-info', bg: 'bg-info-soft', dot: 'bg-info' },
  accent: { text: 'text-accent', bg: 'bg-accent-soft', dot: 'bg-accent' },
  neutral: { text: 'text-text-tertiary', bg: 'bg-surface-2', dot: 'bg-text-tertiary' },
}

/**
 * Status Chip: паддинг 4×10, радиус 20, зазор 6, точка 6×6, текст 12/500.
 * Точка обязательна: статус не должен передаваться одним лишь цветом (пункт доступности).
 */
export function StatusChip({
  tone = 'neutral', dot = true, children, className,
}: { tone?: ChipTone; dot?: boolean; children: ReactNode; className?: string }) {
  const t = CHIP_TONE[tone]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-[6px] rounded-[20px] px-[10px] py-[4px]',
        'text-[12px] font-medium whitespace-nowrap',
        t.bg, t.text, className,
      )}
    >
      {dot ? <span className={cn('h-[6px] w-[6px] shrink-0 rounded-full', t.dot)} aria-hidden /> : null}
      {children}
    </span>
  )
}

/** Тон по коду ответа: 2xx — success, 3xx/4xx — warning, 401/403/5xx — danger. */
export function statusCodeTone(code: number): ChipTone {
  if (code >= 200 && code < 300) return 'success'
  if (code === 401 || code === 403 || code >= 500) return 'danger'
  if (code >= 400) return 'warning'
  return 'info'
}

/** Чип кода ответа в таблице: паддинг 3×8, радиус 4, mono 11/600. */
export function StatusCodeChip({ code, className }: { code: number; className?: string }) {
  const t = CHIP_TONE[statusCodeTone(code)]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-[5px] rounded-[4px] px-[8px] py-[3px]',
        'font-mono text-[11px] font-semibold tabular',
        t.bg, t.text, className,
      )}
    >
      <span className={cn('h-[5px] w-[5px] shrink-0 rounded-full', t.dot)} aria-hidden />
      {code}
    </span>
  )
}

/** Счётчик в шапке панели: паддинг 2×7, радиус 20, фон surface-2, mono 11/600. */
export function CounterChip({
  children, tone = 'neutral', className,
}: { children: ReactNode; tone?: ChipTone; className?: string }) {
  const t = CHIP_TONE[tone]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[20px] px-[7px] py-[2px]',
        'font-mono text-[11px] font-semibold tabular',
        tone === 'neutral' ? 'bg-surface-2 text-text-secondary' : cn(t.bg, t.text),
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Клавиатурный чип ⌘K: паддинг 2×7, радиус 4, фон surface-2, граница border. */
export function KbdChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex shrink-0 items-center rounded-[4px] border border-border bg-surface-2',
        'px-[7px] py-[2px] font-mono text-[11px] font-normal text-text-tertiary',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Чип плейсхолдера {{uuid}} в правой колонке редактора своих моков. */
export function PlaceholderChip({
  children, onClick, className,
}: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center rounded-[4px] bg-surface-2 px-[6px] py-[2px]',
        'font-mono text-[11px] text-placeholder transition-colors hover:bg-surface-3',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Точка сервиса 7–8 px перед названием. Единственное, для чего берутся цвета brand-*. */
export function ServiceDot({ service, size = 8, className }: { service: ServiceCode; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, backgroundColor: `var(--color-${SERVICE_PROFILES[service].brandToken})` }}
      className={cn('inline-block shrink-0 rounded-full', className)}
    />
  )
}

/** Квадрат сервиса с буквой B / O / W — в строке вебхука и в списке базовых адресов. */
export function ServiceSquare({
  service, size = 26, className,
}: { service: ServiceCode; size?: number; className?: string }) {
  const p = SERVICE_PROFILES[service]
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        backgroundColor: `var(--color-${p.brandToken})`,
        fontSize: Math.round(size * 0.46),
        borderRadius: size >= 40 ? 10 : 6,
      }}
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold text-white', className)}
    >
      {p.letter}
    </span>
  )
}

/** Маленький цветной чип сервиса B24 / OZ / WB — колонка «Доступные сервисы». */
export function ServiceChip({ service, className }: { service: ServiceCode; className?: string }) {
  const p = SERVICE_PROFILES[service]
  return (
    <span
      style={{ color: `var(--color-${p.brandToken})`, backgroundColor: `color-mix(in srgb, var(--color-${p.brandToken}) 12%, transparent)` }}
      className={cn('inline-flex shrink-0 items-center rounded-[4px] px-[6px] py-[2px] text-[11px] font-semibold', className)}
    >
      {p.shortCode}
    </span>
  )
}
