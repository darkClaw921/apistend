'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import { Bell, CircleAlert, CircleX, Info } from 'lucide-react'
import { DropdownPanel, EmptyState, cn } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { AlertItem, AlertsResponse } from '@/lib/types'

/**
 * Колокольчик. Показывает уведомления песочницы — те же, что на «Обзоре»,
 * но доступные с любого экрана.
 *
 * Раньше кнопка была нарисована и ничего не делала, хотя уведомления лежали
 * в базе и приходили в составе обзора.
 *
 * В новом макете колокольчик переехал из шапки в сайдбар. Оставить его в обоих
 * местах было нельзя: две одинаковые кнопки с одной и той же красной точкой
 * на каждом экране — это не два входа в функцию, а сомнение, какая из них твоя.
 */

const ICON = {
  danger: CircleX,
  warning: CircleAlert,
  info: Info,
} as const

const TONE: Record<string, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-accent',
}

export function NotificationsBell({ dot = false, className }: {
  /** Точка «уведомления есть». Считается на сервере, см. /api/auth/me. */
  dot?: boolean
  /** Ширина кнопки задаётся снаружи: в развёрнутом сайдбаре она 32, в свёрнутом — во всю полосу. */
  className?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Список тянем один раз при открытии: он меняется редко, а шапка висит
  // на каждом экране — опрашивать сервер постоянно незачем.
  useEffect(() => {
    if (!open || alerts) return
    void (async () => {
      try {
        setAlerts((await api.get<AlertsResponse>('/api/alerts')).alerts)
        setError(null)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Не удалось загрузить уведомления')
      }
    })()
  }, [open, alerts])

  return (
    <div className={cn('relative shrink-0', className ?? 'w-[32px]')}>
      <button
        type="button"
        aria-label="Уведомления"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-[32px] w-full items-center justify-center rounded-[6px] border border-night-line bg-night-2 text-nav-text transition-colors hover:border-nav-border hover:text-nav-text-active"
      >
        <Bell size={15} aria-hidden />
        {dot ? (
          <span className="absolute top-[6px] right-[6px] h-[6px] w-[6px] rounded-full bg-night-alert" aria-hidden />
        ) : null}
      </button>

      {open ? (
        <DropdownPanel onClose={() => setOpen(false)} align="left" label="Уведомления" className="w-[300px] sm:w-[340px]">
          <p className="border-b border-border px-[14px] py-[10px] text-[12px] font-semibold text-text-primary">
            Уведомления
          </p>

          {error ? (
            <EmptyState title="Не загрузилось" description={error} />
          ) : alerts === null ? (
            <p className="px-[14px] py-[16px] text-[12px] text-text-tertiary">Загрузка…</p>
          ) : alerts.length === 0 ? (
            <EmptyState title="Пока тихо" description="Ошибки и превышения лимитов появятся здесь" />
          ) : (
            <ul className="max-h-[320px] overflow-y-auto scrollbar-thin">
              {alerts.map((a) => {
                const Icon = ICON[a.severity as keyof typeof ICON] ?? Info
                const body = (
                  <>
                    <Icon size={14} className={`mt-[2px] shrink-0 ${TONE[a.severity] ?? 'text-accent'}`} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-[1.4] text-text-primary">{a.title}</span>
                      <span className="block text-[12px] text-text-tertiary">{a.meta}</span>
                    </span>
                  </>
                )
                return (
                  <li key={a.id} className="border-b border-border last:border-b-0">
                    {a.link ? (
                      <button
                        type="button"
                        onClick={() => { setOpen(false); router.push(a.link as Route) }}
                        className="flex w-full gap-[10px] px-[14px] py-[11px] text-left hover:bg-bg"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex gap-[10px] px-[14px] py-[11px]">{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </DropdownPanel>
      ) : null}
    </div>
  )
}
