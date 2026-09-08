'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { DropdownPanel } from '@apistend/ui'
import type { Route } from 'next'

/**
 * Тот же разбор адреса, что и в LandingNav: якорь секции лендинга приходит сюда
 * как «/#features» — от корня, потому что эта же шапка висит и на /catalog, где
 * таких секций нет. Свою копию держим здесь, а не импортируем из LandingNav:
 * LandingNav импортирует этот файл, обратный импорт замкнул бы модули в круг.
 */
function isLandingAnchor(href: string) {
  return href.startsWith('#') || href.startsWith('/#')
}

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
 *
 * Логика прежняя; после перекраски лендинга в тёмное поменяны только цвета —
 * панель была светлой (белая на bg-night светила фонарём), а рамка кнопки стояла
 * литералом вместо токена.
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
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[6px] border border-nav-border text-nav-text transition-colors hover:text-white"
      >
        {open ? <X size={17} aria-hidden /> : <Menu size={17} aria-hidden />}
      </button>

      {open ? (
        /*
          DropdownPanel — общий примитив кабинета, у него в основе светлые
          bg-surface и border-border. Здесь фон тёмный, поэтому цвета
          перекрываем с `!`: `cn` в пакете — это clsx без tailwind-merge, обе
          пары классов доедут до разметки, а Tailwind расставляет утилиты одного
          свойства по алфавиту (bg-night-2 раньше bg-surface) — без важности
          победил бы белый.
        */
        <DropdownPanel
          onClose={() => setOpen(false)}
          label="Меню"
          className="w-[220px] border-night-line! bg-night-2!"
        >
          <ul className="flex flex-col py-[6px]">
            {links.map((item) => (
              <li key={item.label}>
                {isLandingAnchor(item.href) ? (
                  <a
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block px-[14px] py-[9px] text-[14px] text-night-text hover:bg-night-3 hover:text-white"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link
                    href={item.href as Route}
                    onClick={() => setOpen(false)}
                    className="block px-[14px] py-[9px] text-[14px] text-night-text hover:bg-night-3 hover:text-white"
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-[8px] border-t border-night-line p-[12px]">
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="text-center text-[13px] text-night-text hover:text-white"
            >
              Войти
            </Link>
            <Link
              href="/register"
              onClick={() => setOpen(false)}
              className="rounded-[6px] bg-accent px-[16px] py-[9px] text-center text-[13px] font-semibold text-white hover:bg-accent-hover"
            >
              Начать бесплатно
            </Link>
          </div>
        </DropdownPanel>
      ) : null}
    </div>
  )
}
