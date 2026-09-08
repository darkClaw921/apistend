'use client'

import { useEffect, useState } from 'react'
import { API_URL } from './api'

/**
 * Живое состояние сервиса — один запрос к /health.
 *
 * Нужно в трёх местах сразу: подпись на экранах входа и регистрации, полоса под
 * hero на лендинге и отбивка футера. В макете во всех трёх стоит зелёная точка
 * с надписью «все системы работают» — это утверждение, а не измерение, поэтому
 * везде спрашиваем сервис и пишем то, что он ответил.
 *
 * Хук вместо копии в каждом компоненте: три одинаковых useEffect однажды разойдутся,
 * и разойдутся молча — сломанный из них будет вечно показывать «работает».
 */
export type ServiceHealth = 'checking' | 'ok' | 'down'

export function useServiceHealth(): ServiceHealth {
  const [state, setState] = useState<ServiceHealth>('checking')

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/health`)
      .then((r) => { if (!cancelled) setState(r.ok ? 'ok' : 'down') })
      .catch(() => { if (!cancelled) setState('down') })
    return () => { cancelled = true }
  }, [])

  return state
}
