'use client'

import { useState, type ReactNode } from 'react'
import { cn } from '@apistend/ui'

/**
 * Вкладки внутри страницы документации: «через docker compose» / «через pnpm».
 *
 * Отдельный клиентский компонент — единственное место документации, где нужен
 * стейт. Всё остальное на странице остаётся серверным и статическим.
 *
 * Панели приходят уже отрендеренными: переключение показывает и прячет готовую
 * разметку, поэтому содержимое всех вкладок есть в HTML и попадает в поиск
 * браузера и в индексацию.
 */
export function DocTabs({ titles, panels }: { titles: string[]; panels: ReactNode[] }) {
  const [active, setActive] = useState(0)

  return (
    <div className="my-[20px] overflow-hidden rounded-[10px] border border-border bg-surface">
      <div role="tablist" className="flex gap-[2px] overflow-x-auto scrollbar-thin border-b border-border bg-surface-2 px-[8px]">
        {titles.map((title, i) => (
          <button
            key={title}
            type="button"
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={cn(
              'shrink-0 border-b-2 px-[12px] py-[10px] text-[13px] font-medium whitespace-nowrap transition-colors',
              i === active
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
          >
            {title}
          </button>
        ))}
      </div>
      {panels.map((panel, i) => (
        <div key={i} role="tabpanel" hidden={i !== active} className="px-[16px] py-[4px]">
          {panel}
        </div>
      ))}
    </div>
  )
}
