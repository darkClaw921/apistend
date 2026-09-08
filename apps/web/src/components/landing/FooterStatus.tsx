'use client'

import { cn } from '@apistend/ui'
import { useServiceHealth } from '@/lib/health'

/**
 * Живой индикатор в отбивке футера. Макет: «Footer Status» в 16_Footer.
 *
 * В макете точка всегда зелёная и подпись всегда «Все системы работают» —
 * это утверждение, а не измерение. Спрашиваем /health через общий хук
 * useServiceHealth и говорим то, что он ответил.
 *
 * Вынесено в отдельный файл, потому что 'use client' действует на весь модуль:
 * иначе клиентским стал бы весь футер ради одной точки. Импортируется только
 * из LandingFooter.tsx.
 */
export function FooterStatus() {
  const state = useServiceHealth()

  /* Классы записаны литералами: Tailwind собирает утилиты по тексту исходника
     и склеенное из переменных имя в сборку не попадёт. */
  const view = state === 'ok'
    ? { label: 'Все системы работают', dot: 'bg-night-ok', text: 'text-night-ok' }
    : state === 'down'
      ? { label: 'Сервис недоступен', dot: 'bg-night-danger', text: 'text-night-danger' }
      : { label: 'Проверяем сервис…', dot: 'bg-night-dim', text: 'text-night-dim' }

  return (
    <span role="status" className={cn('flex shrink-0 items-center gap-[7px] text-[12px] font-medium', view.text)}>
      <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', view.dot)} aria-hidden />
      {view.label}
    </span>
  )
}
