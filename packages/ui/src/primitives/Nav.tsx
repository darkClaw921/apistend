import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * Сайдбар. design-handoff/02-components.md, п. 15 и screens/00-app-shell.md.
 * Пункт: паддинг 8×10, радиус 6, зазор 10, иконка 16, текст 13.
 * Активный: фон accent, белый текст, вес 600.
 */

/** Заголовок раздела: 10/600, трекинг 0.8, цвет nav-section, отступ сверху 10, снизу 6. */
export function NavSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-[10px] pt-[10px] pb-[6px] text-[10px] font-semibold tracking-[0.8px] text-nav-section uppercase">
      {children}
    </div>
  )
}

/**
 * Пункт меню. Компонент презентационный: ссылку рендерит вызывающая сторона
 * через render-проп, чтобы пакет не зависел от роутера.
 */
export function NavItem({
  icon, label, active, render,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  render: (props: { className: string; children: ReactNode }) => ReactNode
}) {
  const className = cn(
    'flex items-center gap-[10px] rounded-[6px] px-[10px] py-[8px] text-[13px] transition-colors duration-150',
    active
      ? 'bg-accent font-semibold text-white'
      : 'font-medium text-nav-text hover:bg-nav-bg-2 hover:text-nav-text-active',
  )
  return <>{render({ className, children: <>{icon}<span className="truncate">{label}</span></> })}</>
}
