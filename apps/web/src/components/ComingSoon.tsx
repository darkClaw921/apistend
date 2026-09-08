'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { CircleDashed, ArrowRight } from 'lucide-react'
import { Panel, EmptyState } from '@apistend/ui'
import { useProjectCrumb } from './AppShell'
import { Topbar } from './Topbar'

/**
 * Честная заглушка для экранов, которые придут следующими волнами.
 *
 * Показываем, чего именно ещё нет и что уже работает, вместо пустой страницы
 * или, того хуже, нарисованных данных, за которыми ничего не стоит.
 */
export function ComingSoon({
  title, wave, description, ready,
}: {
  title: string
  wave: string
  description: string
  /**
   * Куда пойти вместо этого экрана. Адрес задаётся явно: раньше он выводился
   * из подписи (`item === 'Каталог API' ? … : '/keys'`), и любая новая подпись
   * молча вела в «Ключи и токены».
   */
  ready: ReadonlyArray<{ label: string; href: Route }>
}) {
  const [search, setSearch] = useState('')
  // Крошка собирается из проекта пользователя, а не задаётся строкой:
  // раньше в каждой заглушке стоял демонстрационный «Интеграция 1С».
  const crumb = useProjectCrumb(title)
  return (
    <>
      <Topbar breadcrumb={crumb} title={title} search={search} onSearchChange={setSearch} />
      <main className="flex min-h-0 flex-1 items-center justify-center p-[24px]">
        <Panel className="w-full max-w-[560px]">
          <EmptyState
            icon={<CircleDashed size={20} aria-hidden />}
            title={`Экран «${title}» ещё не собран — ${wave}`}
            description={description}
          />
          <div className="border-t border-border bg-surface-2 px-[16px] py-[12px]">
            <p className="mb-[8px] text-[11px] font-semibold tracking-[0.6px] text-text-tertiary uppercase">
              Уже работает
            </p>
            <ul className="flex flex-wrap gap-[8px]">
              {ready.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="inline-flex items-center gap-[6px] rounded-[6px] border border-border-strong bg-surface px-[12px] py-[7px] text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
                  >
                    {item.label}
                    <ArrowRight size={12} aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </main>
    </>
  )
}
