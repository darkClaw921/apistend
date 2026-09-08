'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { Me } from '@/lib/types'
import { Sidebar } from './Sidebar'

/**
 * Каркас приложения: сайдбар 248 + шапка 64 + область контента с паддингом 24.
 *
 * Экраны нарисованы под фиксированную высоту: страница целиком не скроллится,
 * скроллятся тела панелей. Отсюда h-screen + overflow-hidden на контейнере.
 */

interface ShellState {
  me: Me
  sandboxId: string
  refresh: () => Promise<void>
  /**
   * Открыть сайдбар-шторку на узком экране. Живёт в контексте, а не в пропсах
   * каждого экрана: шапку рисуют одиннадцать страниц, и протаскивать через все
   * одно и то же значение незачем.
   */
  openMenu: () => void
}

/**
 * Экспортируется ради каркаса каталога: тот открыт и гостям, поэтому не может
 * использовать AppShell целиком, но обязан дать вошедшему тот же контекст.
 */
export const ShellContext = createContext<ShellState | null>(null)

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

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

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

  const sandboxId = me.sandboxes[0]?.id ?? ''

  return (
    <ShellContext.Provider value={{ me, sandboxId, refresh: load, openMenu: () => setMenuOpen(true) }}>
      <div className="flex h-screen overflow-hidden bg-bg">
        <Sidebar
          me={me}
          requestsThisMonth={me.usage.requestsThisMonth}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </ShellContext.Provider>
  )
}
