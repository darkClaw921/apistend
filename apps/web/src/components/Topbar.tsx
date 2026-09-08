'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { BookOpen, Menu, Search } from 'lucide-react'
import { Dialog, IconButton, KbdChip, SearchField } from '@apistend/ui'
import { useOptionalShell } from './AppShell'
import { GlobalSearch } from './GlobalSearch'
import { NotificationsBell } from './NotificationsBell'

/**
 * Шапка — высота 64, фон surface, нижняя граница.
 * Слева хлебные крошки 11 px и заголовок экрана 17/700, трекинг −0.2.
 * Справа: глобальный поиск 280 px, две Icon Button, одно основное действие.
 *
 * Поле поиска — не поле, а кнопка, открывающая палитру: набирать в узкой
 * строке шапки список результатов некуда, а по ⌘K её ждут в любом месте.
 * Пропсы search/onSearchChange сохранены — экраны передают в них своё
 * состояние, и ломать их сигнатуру ради этого незачем.
 *
 * До 1024 px поле уступает место заголовку и сворачивается в лупу. Оно занимает
 * фиксированные 280 px и не сжимается, из-за чего на узком экране на заголовок
 * оставалось 55 px и «Каталог API» превращался в «Кат…».
 */
export function Topbar({
  breadcrumb, title, action, search, onSearchChange, showTools = true,
}: {
  breadcrumb: string
  title: string
  /** Ровно одно основное действие на экран — правило макета. */
  action?: ReactNode
  search: string
  onSearchChange: (v: string) => void
  /**
   * Инструменты шапки. Поиск и документация остаются и гостю — каталог открыт
   * без входа, и искать по нему он вправе; уведомления показываются только
   * вошедшему, потому что берутся из его песочницы.
   */
  showTools?: boolean
}) {
  const router = useRouter()
  // Гость каталога сайдбара не имеет — и кнопки меню у него не будет.
  const shell = useOptionalShell()
  const [searchOpen, setSearchOpen] = useState(false)

  // ⌘K нарисован в макете с самого начала — теперь он что-то делает.
  useEffect(() => {
    if (!showTools) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showTools])

  return (
    <header className="flex h-[64px] shrink-0 items-center gap-[10px] border-b border-border bg-surface px-[24px]">
      {shell ? (
        <button
          type="button"
          onClick={shell.openMenu}
          aria-label="Открыть меню"
          className="-ml-[6px] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg lg:hidden"
        >
          <Menu size={18} aria-hidden />
        </button>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[11px] text-text-tertiary">{breadcrumb}</span>
        <h1 className="truncate text-[17px] font-bold tracking-[-0.2px] text-text-primary">{title}</h1>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-[10px]">
        {showTools ? (
          <>
            <div className="relative max-lg:hidden">
              <SearchField
                value={search}
                onValueChange={onSearchChange}
                onFocus={() => setSearchOpen(true)}
                placeholder="Поиск методов, сервисов, логов"
                width={280}
                aria-label="Глобальный поиск"
                readOnly
              />
              <span className="pointer-events-none absolute top-1/2 right-[10px] -translate-y-1/2">
                <KbdChip>⌘K</KbdChip>
              </span>
            </div>
            <IconButton aria-label="Поиск" className="lg:hidden" onClick={() => setSearchOpen(true)}>
              <Search size={16} aria-hidden />
            </IconButton>
            <IconButton aria-label="Документация" onClick={() => router.push('/catalog')}>
              <BookOpen size={16} aria-hidden />
            </IconButton>
            {shell ? <NotificationsBell /> : null}
          </>
        ) : null}
        {action}
      </div>

      {searchOpen ? (
        <Dialog title="Поиск по каталогу" onClose={() => setSearchOpen(false)} width={640}>
          <GlobalSearch onClose={() => setSearchOpen(false)} />
        </Dialog>
      ) : null}
    </header>
  )
}
