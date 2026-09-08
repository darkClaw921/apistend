'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { DropdownPanel } from '@apistend/ui'
import type { Route } from 'next'

/**
 * Навигация лендинга на узком экране.
 *
 * Правило адаптива в макете доводит секции до одной колонки, но про меню молчит:
 * на макете оно нарисовано только в широкой раскладке. Пряталось оно классом
 * `hidden lg:flex`, то есть на телефоне навигации не было вовсе — а вместе с ней
 * и половины лендинга, потому что попасть в разделы иначе нельзя.
 *
 * Отдельный клиентский компонент: сама навигация остаётся серверной, состояние
 * нужно только здесь.
 */
export function LandingNavMobile({
  links,
}: {
  links: ReadonlyArray<{ label: string; href: string }>
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative ml-auto lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
        aria-expanded={open}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[6px] border border-[#2C3742] text-nav-text transition-colors hover:text-white"
      >
        {open ? <X size={17} aria-hidden /> : <Menu size={17} aria-hidden />}
      </button>

      {open ? (
        <DropdownPanel onClose={() => setOpen(false)} label="Меню" className="w-[200px]">
          <ul className="flex flex-col py-[6px]">
            {links.map((item) => (
              <li key={item.label}>
                {item.href.startsWith('#') ? (
                  <a
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block px-[14px] py-[9px] text-[14px] text-text-secondary hover:bg-bg hover:text-text-primary"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link
                    href={item.href as Route}
                    onClick={() => setOpen(false)}
                    className="block px-[14px] py-[9px] text-[14px] text-text-secondary hover:bg-bg hover:text-text-primary"
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-[8px] border-t border-border p-[12px]">
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="text-center text-[13px] text-text-secondary hover:text-text-primary"
            >
              Войти
            </Link>
            <Link
              href="/register"
              onClick={() => setOpen(false)}
              className="rounded-[6px] bg-accent px-[16px] py-[9px] text-center text-[13px] font-semibold text-white"
            >
              Начать бесплатно
            </Link>
          </div>
        </DropdownPanel>
      ) : null}
    </div>
  )
}
