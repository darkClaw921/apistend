'use client'

import type { ReactNode } from 'react'
import { BookOpen, Bell } from 'lucide-react'
import { IconButton, SearchField, KbdChip } from '@apistend/ui'

/**
 * Шапка — высота 64, фон surface, нижняя граница.
 * Слева хлебные крошки 11 px и заголовок экрана 17/700, трекинг −0.2.
 * Справа: глобальный поиск 280 px, две Icon Button, одно основное действие.
 */
export function Topbar({
  breadcrumb, title, action, search, onSearchChange,
}: {
  breadcrumb: string
  title: string
  /** Ровно одно основное действие на экран — правило макета. */
  action?: ReactNode
  search: string
  onSearchChange: (v: string) => void
}) {
  return (
    <header className="flex h-[64px] shrink-0 items-center gap-[10px] border-b border-border bg-surface px-[24px]">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[11px] text-text-tertiary">{breadcrumb}</span>
        <h1 className="truncate text-[17px] font-bold tracking-[-0.2px] text-text-primary">{title}</h1>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-[10px]">
        <div className="relative">
          <SearchField
            value={search}
            onValueChange={onSearchChange}
            placeholder="Поиск методов, сервисов, логов"
            width={280}
            aria-label="Глобальный поиск"
          />
          {search.length === 0 ? (
            <span className="pointer-events-none absolute top-1/2 right-[10px] -translate-y-1/2">
              <KbdChip>⌘K</KbdChip>
            </span>
          ) : null}
        </div>
        <IconButton aria-label="Документация">
          <BookOpen size={16} aria-hidden />
        </IconButton>
        <IconButton aria-label="Уведомления">
          <Bell size={16} aria-hidden />
        </IconButton>
        {action}
      </div>
    </header>
  )
}
