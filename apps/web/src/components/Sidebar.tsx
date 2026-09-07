'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, LibraryBig, Boxes, Terminal, ScrollText, Webhook, GitBranch,
  Database, AppWindow, KeyRound, Users, Settings, PlugZap, ChevronsUpDown, EllipsisVertical,
} from 'lucide-react'
import { NavItem, NavSection, formatInt } from '@apistend/ui'
import type { Me } from '@/lib/types'

/**
 * Сайдбар — 248 px, фон nav-bg, не сжимается.
 * design-handoff/screens/00-app-shell.md.
 *
 * Верхний и нижний блоки прижаты к краям. В блоке использования НЕТ прогресс-бара:
 * лимитов на запросы у продукта нет, и это отдельный пункт чек-листа приёмки.
 */

const SECTIONS = [
  {
    title: 'Обзор',
    items: [
      { href: '/overview', label: 'Обзор', icon: LayoutDashboard },
      { href: '/catalog', label: 'Каталог API', icon: LibraryBig },
      { href: '/services', label: 'Сервисы', icon: Boxes },
    ],
  },
  {
    title: 'Работа',
    items: [
      { href: '/console', label: 'Консоль запросов', icon: Terminal },
      { href: '/logs', label: 'Логи запросов', icon: ScrollText },
      { href: '/webhooks', label: 'Вебхуки', icon: Webhook },
      { href: '/scenarios', label: 'Сценарии', icon: GitBranch },
      { href: '/mocks', label: 'Свои моки', icon: Database },
      { href: '/apps', label: 'Локальные приложения', icon: AppWindow },
    ],
  },
  {
    title: 'Проект',
    items: [
      { href: '/keys', label: 'Ключи и токены', icon: KeyRound },
      { href: '/team', label: 'Команда', icon: Users },
      { href: '/settings', label: 'Настройки', icon: Settings },
    ],
  },
] as const

export function Sidebar({ me, requestsThisMonth }: { me: Me; requestsThisMonth: number }) {
  const pathname = usePathname()
  const sandbox = me.sandboxes[0]

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col justify-between bg-nav-bg">
      <div className="flex flex-col gap-[8px] px-[12px] py-[16px]">
        <Link href="/overview" className="flex items-center gap-[10px] p-[8px]">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-accent">
            <PlugZap size={17} className="text-white" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[15px] leading-tight font-bold text-nav-text-active">APIStend</span>
            <span className="truncate text-[10px] text-nav-text">демо-API для интеграций</span>
          </span>
        </Link>

        <button
          type="button"
          className="flex items-center gap-[8px] rounded-[6px] border border-nav-border bg-nav-bg-2 px-[10px] py-[9px] text-left transition-colors hover:border-[#33404F]"
        >
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-success" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-[10px] text-nav-text">Песочница</span>
            <span className="truncate font-mono text-[12px] text-nav-text-active">
              {sandbox?.name ?? '—'}
            </span>
          </span>
          <ChevronsUpDown size={14} className="ml-auto shrink-0 text-nav-text" aria-hidden />
        </button>

        <nav>
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <NavSection>{section.title}</NavSection>
              <ul className="flex flex-col gap-[2px]">
                {section.items.map((item) => {
                  const Icon = item.icon
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
                  return (
                    <li key={item.href}>
                      <NavItem
                        icon={<Icon size={16} className="shrink-0" aria-hidden />}
                        label={item.label}
                        active={active}
                        render={({ className, children }) => (
                          <Link
                            href={item.href}
                            className={className}
                            aria-current={active ? 'page' : undefined}
                          >
                            {children}
                          </Link>
                        )}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="flex flex-col gap-[10px] px-[12px] pt-[12px] pb-[16px]">
        <div className="rounded-[6px] bg-nav-bg-2 p-[12px]">
          <div className="flex items-baseline justify-between gap-[8px]">
            <span className="text-[11px] text-nav-text">Запросов за месяц</span>
            <span className="font-mono text-[11px] font-semibold text-nav-text-active tabular">
              {formatInt(requestsThisMonth)}
            </span>
          </div>
          {/* Прогресс-бара здесь нет и не должно быть: лимитов у продукта нет. */}
          <p className="mt-[6px] text-[11px] text-nav-section">Без лимитов на запросы</p>
        </div>

        <div className="flex items-center gap-[10px]">
          <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-[#2E3A48] text-[11px] font-semibold text-nav-text-active">
            {me.user.initials}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] font-medium text-nav-text-active">{me.user.name}</span>
            <span className="truncate text-[10px] text-nav-text">{me.user.planLabel}</span>
          </span>
          <EllipsisVertical size={14} className="ml-auto shrink-0 text-nav-text" aria-hidden />
        </div>
      </div>
    </aside>
  )
}
