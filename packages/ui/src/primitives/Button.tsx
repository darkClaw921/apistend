import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * Кнопки. Значения — design-handoff/02-components.md, пп. 1–3.
 * Правило макета: одна Button Primary на экран, всегда в правом верхнем углу шапки.
 */

type BaseProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  iconRight?: ReactNode
  children?: ReactNode
}

/** Фон accent, текст 13/600, радиус 6, паддинг 10×16, зазор 8. */
export function ButtonPrimary({
  icon, iconRight, children, className, size = 'md', ...rest
}: BaseProps & { size?: 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-[8px] rounded-[6px] whitespace-nowrap',
        'bg-accent text-white transition-colors duration-150 ease-out',
        'hover:bg-accent-hover active:translate-y-px',
        'disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-text-tertiary disabled:translate-y-0',
        size === 'lg' ? 'px-[24px] py-[14px] text-[15px] font-semibold' : 'px-[16px] py-[10px] text-[13px] font-semibold',
        className,
      )}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  )
}

/**
 * Фон surface, граница border-strong, текст 13/500.
 * Паддинг 9×15 — на 1 px меньше основной кнопки, компенсация границы.
 */
export function ButtonSecondary({
  icon, iconRight, children, className, tone = 'default', ...rest
}: BaseProps & { tone?: 'default' | 'quiet' | 'danger' }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-[8px] rounded-[6px] whitespace-nowrap border',
        'transition-colors duration-150 ease-out',
        tone === 'danger'
          ? 'border-danger bg-danger px-[16px] py-[10px] text-[13px] font-semibold text-white hover:brightness-110'
          : tone === 'quiet'
            ? 'border-border-strong bg-surface px-[12px] py-[7px] text-[12px] font-semibold text-text-secondary hover:bg-surface-2'
            : 'border-border-strong bg-surface px-[15px] py-[9px] text-[13px] font-medium text-text-primary hover:bg-surface-2',
        'disabled:cursor-not-allowed disabled:border-border disabled:text-text-tertiary disabled:hover:bg-surface',
        className,
      )}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  )
}

/** Квадрат 34×34, граница border, иконка 16 px. Обязателен aria-label. */
export function IconButton({
  children, className, 'aria-label': ariaLabel, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label': string }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      {...rest}
      className={cn(
        'inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[6px]',
        'border border-border bg-surface text-text-secondary',
        'transition-colors duration-150 ease-out hover:bg-surface-2',
        'disabled:cursor-not-allowed disabled:text-text-tertiary',
        className,
      )}
    >
      {children}
    </button>
  )
}
