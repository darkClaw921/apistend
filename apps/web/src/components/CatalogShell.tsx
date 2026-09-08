'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '@/lib/api'
import type { Me } from '@/lib/types'
import { Sidebar } from './Sidebar'
import { ShellContext } from './AppShell'
import { LandingNav } from './landing/LandingNav'

/**
 * Каркас каталога — единственного экрана, открытого и без входа.
 *
 * Каталог показывает то, что API отдаёт публично, и лендинг ведёт сюда гостя
 * кнопкой «Каталог методов». Обычный AppShell для этого не годится: он требует
 * сессию и уводит на форму входа, из-за чего половина лендинга упиралась
 * в тупик.
 *
 * Вошедший видит привычный сайдбар, гость — шапку лендинга, откуда можно
 * завести песочницу. Сам экран каталога в обоих случаях один и тот же.
 */
export function CatalogShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)

  async function loadMe() {
    try {
      setMe(await api.get<Me>('/api/auth/me'))
    } catch (e) {
      // 401 — обычное дело: страница открыта гостю. Любая другая ошибка тоже
      // не повод прятать каталог, он всё равно грузится отдельным запросом.
      setMe(null)
      if (!(e instanceof ApiError)) throw e
    } finally {
      setReady(true)
    }
  }

  useEffect(() => {
    void loadMe()
    // Профиль запрашивается один раз при монтировании каркаса.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // До ответа о профиле каркас не выбран: показать сайдбар и тут же убрать
  // (или наоборот) — заметный скачок вёрстки.
  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <span className="animate-skeleton text-[13px] text-text-tertiary">Загрузка…</span>
      </div>
    )
  }

  if (!me) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-bg">
        <LandingNav />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    )
  }

  const sandboxId = me.sandboxes[0]?.id ?? ''

  return (
    <ShellContext.Provider value={{ me, sandboxId, refresh: loadMe }}>
      <div className="flex h-screen overflow-hidden bg-bg">
        <Sidebar me={me} requestsThisMonth={me.usage.requestsThisMonth} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </ShellContext.Provider>
  )
}
