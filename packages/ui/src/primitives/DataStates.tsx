import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ButtonSecondary } from './Button.tsx'
import { cn } from '../lib/cn.ts'

/**
 * Три обязательных состояния данных для каждой таблицы и списка.
 * design-handoff/02-components.md, раздел «Состояния данных».
 * В макете нарисованы только наполненные состояния — эти три добавлены по правилу.
 */

/** Скелетон: прямоугольники surface-2, радиус 4, высота 12–14, мягкая пульсация 1.2 с. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-[16px] border-b border-border px-[16px] py-[12px] last:border-b-0">
          <span className="animate-skeleton h-[13px] w-[64px] shrink-0 rounded-[4px] bg-surface-2" />
          <span className="animate-skeleton h-[13px] flex-1 rounded-[4px] bg-surface-2" style={{ animationDelay: `${i * 80}ms` }} />
          <span className="animate-skeleton h-[13px] w-[80px] shrink-0 rounded-[4px] bg-surface-2" style={{ animationDelay: `${i * 120}ms` }} />
        </div>
      ))}
      <span className="sr-only">Загрузка</span>
    </div>
  )
}

/**
 * Пустое состояние. Эталон — пустая группа «Wildberries Аналитика» на «Каталоге API»:
 * иконка 20 px, заголовок 14/600, пояснение 13 px, без иллюстраций.
 */
export function EmptyState({
  icon, title, description, action, className,
}: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-[8px] px-[24px] py-[40px] text-center', className)}>
      {icon ? <span className="text-text-tertiary">{icon}</span> : null}
      <p className="text-[14px] font-semibold text-text-primary">{title}</p>
      {description ? <p className="max-w-[420px] text-[13px] leading-[1.5] text-text-secondary">{description}</p> : null}
      {action ? <div className="mt-[4px]">{action}</div> : null}
    </div>
  )
}

/** Ошибка загрузки: иконка triangle-alert danger, текст ошибки и кнопка «Повторить». */
export function ErrorState({
  message, onRetry, className,
}: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-[10px] px-[24px] py-[40px] text-center', className)} role="alert">
      <TriangleAlert size={20} className="text-danger" aria-hidden />
      <p className="text-[14px] font-semibold text-text-primary">Не удалось загрузить данные</p>
      <p className="max-w-[420px] text-[13px] leading-[1.5] text-text-secondary">{message}</p>
      {onRetry ? <ButtonSecondary onClick={onRetry}>Повторить</ButtonSecondary> : null}
    </div>
  )
}
