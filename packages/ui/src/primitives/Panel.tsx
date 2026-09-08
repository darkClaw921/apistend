import type { HTMLAttributes, Ref, ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * Panel — базовый контейнер всех экранов. design-handoff/02-components.md, п. 7.
 *
 * Фон surface, граница 1 px, радиус 10, overflow hidden.
 * Тело скроллится само: страница целиком не скроллится (пункт чек-листа каркаса).
 * Никаких вложенных карточек в карточках: панель → строка → содержимое строки.
 */

export function Panel({
  className, children, ref, ...rest
}: HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> }) {
  return (
    <section
      ref={ref}
      {...rest}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-surface',
        className,
      )}
    >
      {children}
    </section>
  )
}

/** Шапка панели: паддинг 13–14×16, нижняя граница. Слева заголовок 14/600, справа мета или вкладки. */
export function PanelHeader({
  title, count, right, icon, subtitle, className,
}: {
  title: ReactNode
  count?: ReactNode
  right?: ReactNode
  icon?: ReactNode
  subtitle?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-center gap-[10px] border-b border-border px-[16px] py-[13px]',
        className,
      )}
    >
      {icon}
      <h2 className="truncate text-[14px] font-semibold text-text-primary">{title}</h2>
      {count}
      {subtitle ? <span className="truncate text-[12px] text-text-tertiary">{subtitle}</span> : null}
      {/* Правый блок не сжимается: заголовок уступает место действиям, а не наоборот. */}
      {right ? <div className="ml-auto flex shrink-0 items-center gap-[10px]">{right}</div> : null}
    </header>
  )
}

/** Тело панели. Собственный скролл, шапка и футер остаются на месте. */
export function PanelBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('min-h-0 flex-1 overflow-y-auto scrollbar-thin', className)}>
      {children}
    </div>
  )
}

/** Футер: паддинг 12–14×16, фон surface-2, верхняя граница. Слева пояснение, справа действие. */
export function PanelFooter({
  left, right, className,
}: { left?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <footer
      className={cn(
        'flex shrink-0 items-center gap-[12px] border-t border-border bg-surface-2 px-[16px] py-[12px]',
        className,
      )}
    >
      {/* Пояснение слева ужимается, действия справа — нет. Без min-w-0 длинная
          подпись («Показано 1–40 из 2 095 методов · снимок …») выдавливала
          пагинацию за край панели и налезала на неё. */}
      {left ? <div className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">{left}</div> : null}
      {right ? <div className="ml-auto flex shrink-0 items-center gap-[16px]">{right}</div> : null}
    </footer>
  )
}

/** Надзаголовок блока: 10/600, ВЕРХНИЙ РЕГИСТР, трекинг 0.6. */
export function Overline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-[10px] font-semibold tracking-[0.6px] text-text-tertiary uppercase', className)}>
      {children}
    </span>
  )
}
