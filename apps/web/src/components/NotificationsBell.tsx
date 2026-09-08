'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import { Bell, CircleAlert, CircleX, Info } from 'lucide-react'
import { DropdownPanel, EmptyState, IconButton } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { AlertItem, AlertsResponse } from '@/lib/types'

/**
 * Колокольчик в шапке. Показывает уведомления песочницы — те же, что на «Обзоре»,
 * но доступные с любого экрана.
 *
 * Раньше кнопка была нарисована и ничего не делала, хотя уведомления лежали
 * в базе и приходили в составе обзора.
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

export function NotificationsBell() {
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
    <div className="relative">
      <IconButton aria-label="Уведомления" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Bell size={16} aria-hidden />
      </IconButton>

      {open ? (
        <DropdownPanel onClose={() => setOpen(false)} label="Уведомления" className="w-[340px]">
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
