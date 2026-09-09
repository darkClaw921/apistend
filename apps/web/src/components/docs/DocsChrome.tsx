'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { usePathname } from 'next/navigation'
import { BookOpen, Menu, PlugZap, Search, X } from 'lucide-react'
import { Dialog, KbdChip, cn } from '@apistend/ui'
import type { DocGroup, SearchEntry } from '@/lib/docs/source'
import { DocsSearch } from './DocsSearch'

/**
 * Каркас документации: тёмная шапка с поиском, тёмное дерево разделов слева
 * и колонка содержимого.
 *
 * Документация — часть сайта, а не отдельный продукт, поэтому и шапка, и дерево
 * собраны на тех же токенах, что лендинг (night-*) и сайдбар кабинета (nav-*).
 * Своя шапка, а не LandingNav: там пять пунктов лендинга и две кнопки входа,
 * а здесь на их месте нужен поиск — он в документации главный инструмент.
 *
 * Дерево строится из пропса, который слой выше собрал из фронтматтера файлов.
 * Второго списка разделов в коде нет.
 */

/** Адрес страницы документации. typedRoutes не выводит его из шаблонной строки. */
function href(slug: string): Route {
  return (slug ? `/docs/${slug}` : '/docs') as Route
}

function NavTree({ tree, pathname, onNavigate }: { tree: DocGroup[]; pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Разделы документации" className="flex flex-col gap-[18px] px-[12px] py-[18px]">
      {tree.map((group) => (
        <div key={group.title || 'root'}>
          {group.title ? (
            <p className="px-[10px] pb-[7px] text-[10px] font-semibold tracking-[0.6px] text-nav-section uppercase">
              {group.title}
            </p>
          ) : null}
          <ul className="flex flex-col gap-[1px]">
            {group.items.map((item) => {
              const active = pathname === href(item.slug)
              return (
                <li key={item.slug}>
                  <Link
                    href={href(item.slug)}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-[6px] px-[10px] py-[7px] text-[13px] transition-colors',
                      active
                        ? 'bg-nav-active font-medium text-nav-text-active'
                        : 'text-nav-text hover:bg-nav-active hover:text-nav-text-active',
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function DocsChrome({
  tree, index, children,
}: { tree: DocGroup[]; index: SearchEntry[]; children: ReactNode }) {
  const pathname = usePathname()
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // ⌘K — как в кабинете. Клавиша одна и та же во всём продукте.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Переход по разделу закрывает шторку: иначе она остаётся поверх открытой страницы.
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 border-b border-nav-border bg-night">
        <div className="flex h-[64px] items-center gap-[12px] px-[16px] lg:px-[24px]">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Разделы документации"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[6px] text-nav-text hover:text-white lg:hidden"
          >
            <Menu size={18} aria-hidden />
          </button>

          <Link href="/" className="flex shrink-0 items-center gap-[10px]">
            <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] bg-accent">
              <PlugZap size={16} className="text-white" aria-hidden />
            </span>
            <span className="text-[16px] font-bold tracking-[-0.3px] text-white">APIStend</span>
          </Link>
          <Link
            href="/docs"
            className="hidden shrink-0 items-center gap-[6px] rounded-[6px] bg-night-3 px-[9px] py-[4px] text-[12px] font-medium text-night-text sm:flex"
          >
            <BookOpen size={13} aria-hidden /> Документация
          </Link>

          {/*
            Поле поиска — кнопка, а не input: набор всё равно идёт в палитре,
            а два поля ввода на экране (здесь и в открытом окне) спорили бы за фокус.
          */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="ml-auto flex h-[34px] min-w-0 flex-1 items-center gap-[8px] rounded-[6px] border border-nav-border bg-night-2 px-[10px] text-left text-[13px] text-nav-text transition-colors hover:border-night-line sm:max-w-[280px]"
          >
            <Search size={14} className="shrink-0" aria-hidden />
            <span className="truncate">Поиск по документации</span>
            <KbdChip className="ml-auto hidden border-nav-border bg-night-3 text-nav-text sm:inline-flex">⌘K</KbdChip>
          </button>

          <Link
            href="/catalog"
            className="hidden shrink-0 text-[13px] font-medium text-nav-text transition-colors hover:text-white md:block"
          >
            Каталог методов
          </Link>
          <Link
            href="/login"
            className="hidden shrink-0 rounded-[6px] bg-accent px-[14px] py-[8px] text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover md:block"
          >
            Войти
          </Link>
        </div>
      </header>

      {/*
        Раскладка занимает всё окно: дерево разделов прижато к левому краю,
        как в любой документации, а по центру оставшегося места идёт текст.
        Ограничивать всю раскладку по ширине и центрировать её целиком нельзя —
        на широком мониторе она повисает посреди экрана с пустыми полями по краям.
        Ширину ограничивает только колонка текста, внутри main.
      */}
      <div className="flex items-start">
        {/* Дерево на широком экране: своя прокрутка, шапка остаётся на месте. */}
        <aside className="sticky top-[64px] hidden h-[calc(100vh-64px)] w-[264px] shrink-0 overflow-y-auto scrollbar-thin border-r border-nav-border bg-nav-bg lg:block">
          <NavTree tree={tree} pathname={pathname} />
        </aside>

        {children}
      </div>

      {/* До lg дерево живёт в шторке: 264 px на телефоне съели бы всю ширину текста. */}
      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-50 bg-nav-bg/50 lg:hidden" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="fixed inset-y-0 left-0 z-50 w-[min(280px,85vw)] overflow-y-auto scrollbar-thin bg-nav-bg lg:hidden">
            <div className="flex items-center justify-between border-b border-nav-border px-[16px] py-[14px]">
              <span className="text-[13px] font-semibold text-white">Документация</span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Закрыть"
                className="text-nav-text hover:text-white"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <NavTree tree={tree} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
          </div>
        </>
      ) : null}

      {searchOpen ? (
        <Dialog title="Поиск по документации" onClose={() => setSearchOpen(false)} width={640}>
          <DocsSearch index={index} onClose={() => setSearchOpen(false)} />
        </Dialog>
      ) : null}
    </div>
  )
}
