'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog } from '@apistend/ui'
import { api, ApiError, setActiveSandbox } from '@/lib/api'
import type { Me } from '@/lib/types'
import { Sidebar } from './Sidebar'
import { GlobalSearch } from './GlobalSearch'

/**
 * Каркас приложения: сайдбар 248 + шапка 64 + область контента с паддингом 24.
 *
 * Экраны нарисованы под фиксированную высоту: страница целиком не скроллится,
 * скроллятся тела панелей. Отсюда h-screen + overflow-hidden на контейнере.
 */

interface ShellState {
  me: Me
  sandboxId: string
  /** Название проекта пользователя — то, что стоит в хлебных крошках. */
  project: string
  refresh: () => Promise<void>
  /**
   * Переключить активную песочницу.
   *
   * Выбор запоминается в браузере: перезагрузка страницы не должна возвращать
   * человека в первую песочницу, если он работает во второй.
   */
  switchSandbox: (id: string) => void
  /**
   * Открыть сайдбар-шторку на узком экране. Живёт в контексте, а не в пропсах
   * каждого экрана: шапку рисуют одиннадцать страниц, и протаскивать через все
   * одно и то же значение незачем.
   */
  openMenu: () => void
  /**
   * Открыть палитру поиска. Раньше она жила внутри шапки, но в новом макете
   * поиск есть и в сайдбаре: два владельца одного диалога означали бы два
   * обработчика ⌘K и два наложенных окна по одному нажатию.
   */
  openSearch: () => void
}

/**
 * Экспортируется ради каркаса каталога: тот открыт и гостям, поэтому не может
 * использовать AppShell целиком, но обязан дать вошедшему тот же контекст.
 */
export const ShellContext = createContext<ShellState | null>(null)

/** Ключ в localStorage: выбранная песочница. */
const SANDBOX_KEY = 'apistend.sandboxId'

/**
 * Выбор активной песочницы. Общий для кабинета и каталога.
 *
 * Хранится в браузере: перезагрузка страницы не должна возвращать человека
 * в первую песочницу, если он работает во второй.
 */
export function useSandboxSelection(): {
  storedSandboxId: string
  switchSandbox: (id: string) => void
} {
  // Читается при монтировании, а не при отрисовке: на сервере localStorage нет,
  // и обращение к нему прямо в теле компонента уронило бы серверную отрисовку.
  const [storedSandboxId, setStoredSandboxId] = useState('')

  useEffect(() => {
    try {
      setStoredSandboxId(localStorage.getItem(SANDBOX_KEY) ?? '')
    } catch {
      // Хранилище недоступно (приватный режим, запрет) — работаем с первой песочницей.
    }
  }, [])

  function switchSandbox(id: string) {
    setStoredSandboxId(id)
    setActiveSandbox(id)
    try {
      localStorage.setItem(SANDBOX_KEY, id)
    } catch {
      // Не сохранилось — выбор всё равно действует до перезагрузки.
    }
    // Данные всех экранов принадлежат песочнице, и показывать чужие, пока
    // страница не перезагружена, нельзя. Полная перезагрузка проще и надёжнее,
    // чем просить одиннадцать экранов перечитать себя.
    window.location.reload()
  }

  return { storedSandboxId, switchSandbox }
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext)
  if (!ctx) throw new Error('useShell вызван вне AppShell')
  return ctx
}

/**
 * То же, но без исключения: null означает гостя.
 * Нужен каталогу — единственному экрану, открытому без входа.
 */
export function useOptionalShell(): ShellState | null {
  return useContext(ShellContext)
}

/**
 * Хлебная крошка «Проект «X» / Раздел».
 *
 * Имя проекта было зашито строкой в каждом экране — «Проект «Интеграция 1С»»
 * из демо-данных. Любой зарегистрировавшийся видел на всех одиннадцати экранах
 * чужой проект. Берём его из сессии; гостю (каталог открыт без входа)
 * возвращаем только раздел.
 */
export function useProjectCrumb(section: string): string {
  const shell = useOptionalShell()
  return shell ? `Проект «${shell.project}» / ${section}` : section
}

/**
 * Палитра поиска каркаса: состояние, горячая клавиша и сам диалог.
 *
 * Отдельным хуком — потому что каркасов два: обычный кабинет и каталог,
 * открытый гостю. Дублировать в них ⌘K означало бы однажды разойтись.
 */
export function useSearchPalette(): { openSearch: () => void; searchDialog: ReactNode } {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return {
    openSearch: () => setOpen(true),
    searchDialog: open ? (
      <Dialog title="Поиск по каталогу" onClose={() => setOpen(false)} width={640}>
        <GlobalSearch onClose={() => setOpen(false)} />
      </Dialog>
    ) : null,
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const { storedSandboxId, switchSandbox } = useSandboxSelection()
  const { openSearch, searchDialog } = useSearchPalette()

  async function load() {
    try {
      setMe(await api.get<Me>('/api/auth/me'))
      setError(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace('/login')
        return
      }
      setError(e instanceof Error ? e.message : 'Не удалось загрузить профиль')
    }
  }

  useEffect(() => {
    void load()
    // Загружаем профиль один раз при монтировании каркаса.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-[12px] text-center">
          <p className="text-[14px] font-semibold text-text-primary">Не удалось загрузить данные</p>
          <p className="text-[13px] text-text-secondary">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-[6px] border border-border-strong bg-surface px-[15px] py-[9px] text-[13px] font-medium"
          >
            Повторить
          </button>
        </div>
      </div>
    )
  }

  if (!me) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <span className="animate-skeleton text-[13px] text-text-tertiary">Загрузка…</span>
      </div>
    )
  }

  // Сохранённый выбор действителен, только пока такая песочница существует:
  // удалённая или чужая молча уводила бы все экраны в 404.
  const known = me.sandboxes.find((s) => s.id === storedSandboxId)
  const active = known ?? me.sandboxes[0]
  const sandboxId = active?.id ?? ''
  const project = active?.project ?? 'Без названия'
  setActiveSandbox(sandboxId)

  return (
    <ShellContext.Provider
      value={{
        me,
        sandboxId,
        project,
        refresh: load,
        switchSandbox,
        openMenu: () => setMenuOpen(true),
        openSearch,
      }}
    >
      <div className="flex h-screen overflow-hidden bg-bg">
        <Sidebar
          me={me}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onSearch={openSearch}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
      {searchDialog}
    </ShellContext.Provider>
  )
}
