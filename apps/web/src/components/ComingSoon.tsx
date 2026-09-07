'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CircleDashed, ArrowRight } from 'lucide-react'
import { Panel, EmptyState } from '@apistend/ui'
import { Topbar } from './Topbar'

/**
 * Честная заглушка для экранов, которые придут следующими волнами.
 *
 * Показываем, чего именно ещё нет и что уже работает, вместо пустой страницы
 * или, того хуже, нарисованных данных, за которыми ничего не стоит.
 */
export function ComingSoon({
  breadcrumb, title, wave, description, ready,
}: {
  breadcrumb: string
  title: string
  wave: string
  description: string
  ready: string[]
}) {
  const [search, setSearch] = useState('')
  return (
    <>
      <Topbar breadcrumb={breadcrumb} title={title} search={search} onSearchChange={setSearch} />
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
                <li key={item}>
                  <Link
                    href={item === 'Каталог API' ? '/catalog' : item === 'Консоль запросов' ? '/console' : '/keys'}
                    className="inline-flex items-center gap-[6px] rounded-[6px] border border-border-strong bg-surface px-[12px] py-[7px] text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
                  >
                    {item}
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
