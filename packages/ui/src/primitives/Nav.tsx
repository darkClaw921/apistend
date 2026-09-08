import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * Сайдбар. Макет «Screen Template v2» в APIStend.pen.
 *
 * Пункт: паддинг 7×10, радиус 6, зазор 10, иконка 16, текст 13.
 * Активный в новом макете подсвечен приглушённо (nav-active), а не акцентом:
 * акцент в сайдбаре теперь занят кнопкой тарифа внизу, и два синих пятна
 * на одной панели спорили бы друг с другом.
 */

/** Заголовок группы: 12/500, цвет night-dim. Раньше был мелким капслоком. */
export function NavSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-[10px] pt-[10px] pb-[6px] text-[12px] font-medium text-night-dim">
      {children}
    </div>
  )
}

/**
 * Пункт меню. Компонент презентационный: ссылку рендерит вызывающая сторона
 * через render-проп, чтобы пакет не зависел от роутера.
 */
export function NavItem({
  icon, label, active, badge, compact, render,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  /** Счётчик справа — число методов каталога, своих моков и т.п. */
  badge?: ReactNode
  /** Свёрнутый сайдбар: только иконка по центру, подпись уходит в title. */
  compact?: boolean
  render: (props: { className: string; children: ReactNode }) => ReactNode
}) {
  const className = cn(
    'flex items-center rounded-[6px] text-[13px] transition-colors duration-150',
    compact ? 'justify-center px-0 py-[8px]' : 'gap-[10px] px-[10px] py-[7px]',
    active
      ? 'bg-nav-active font-semibold text-nav-text-active'
      : 'font-medium text-night-text hover:bg-nav-bg-2 hover:text-nav-text-active',
  )
  return (
    <>
      {render({
        className,
        children: (
          <>
            {icon}
            {compact ? null : (
              <>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {badge}
              </>
            )}
          </>
        ),
      })}
    </>
  )
}

/** Счётчик у пункта меню: пилюля с моноширинным числом. */
export function NavBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-[20px] bg-night-3 px-[6px] py-[1px] font-mono text-[10px] text-nav-text">
      {children}
    </span>
  )
}
