'use client'

import { formatDate, formatInt, plural } from '@apistend/ui'
import { useServiceHealth } from '@/lib/health'
import type { ServiceSummary } from '@/lib/types'

/**
 * Узкая полоса под hero. Макет: «Section Status» в APIStend.pen.
 *
 * В макете здесь четыре придуманные метрики («99,98 % uptime за 90 дней»,
 * «41 мс p95», «1,24 млн запросов сегодня», «0 инцидентов за месяц») и ссылка
 * на status.apistend.ru. Ничего из этого мы не измеряем, статус-страницы нет —
 * перенесена только раскладка. В ячейках стоит то, что мы правда знаем:
 * размер каталога, число сервисов, число типов событий вебхуков и дата снимка
 * документации. Ссылка на статус-страницу убрана.
 *
 * Компонент клиентский целиком: живой индикатор справа спрашивает /health
 * в useEffect, а полоса слишком мала, чтобы делить её на два файла ради
 * серверного рендера четырёх чисел.
 */

/** Число, которого у нас нет. Пустую ячейку не оставляем и не выдумываем ноль. */
const DASH = '—'

export interface StatusStripProps {
  services: ServiceSummary[]
  totalMethods: number | null
  eventTypes: number
}

export function StatusStrip({ services, totalMethods, eventTypes }: StatusStripProps) {
  /* Пустой список сервисов означает «API не ответил», а не «сервисов ноль»,
     поэтому в этой ячейке прочерк, а не 0. */
  const serviceCount = services.length
  const snapshot = freshestSnapshot(services)

  const cells: Array<{ value: string; label: string }> = [
    {
      value: totalMethods === null ? DASH : formatInt(totalMethods),
      label: `${plural(totalMethods ?? 0, 'метод', 'метода', 'методов')} в каталоге`,
    },
    {
      value: serviceCount === 0 ? DASH : formatInt(serviceCount),
      label: plural(serviceCount, 'сервис', 'сервиса', 'сервисов'),
    },
    {
      value: formatInt(eventTypes),
      label: `${plural(eventTypes, 'тип', 'типа', 'типов')} событий вебхуков`,
    },
    {
      value: snapshot ? formatDate(snapshot) : DASH,
      label: 'снимок документации',
    },
  ]

  return (
    <section className="border-y border-night-line bg-night">
      {/* На узком ячейки идут сеткой 2×2, индикатор — строкой ниже: в одну
          строку четыре моноширинные подписи и чип не помещаются до ~1024. */}
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[18px] px-[20px] py-[22px] md:px-[80px] lg:flex-row lg:items-center lg:justify-between lg:gap-[24px]">
        <div className="grid grid-cols-2 gap-x-[24px] gap-y-[16px] lg:flex lg:flex-row lg:items-center lg:gap-[24px] xl:gap-[32px]">
          {cells.map((cell, i) => (
            <div
              key={cell.label}
              /* Разделители из макета — это левая граница ячейки: она тянется
                 на высоту ячейки, а не на 30 px, зато не ломает сетку на узком.
                 На lg отступы ужаты до 24 px, иначе строка не влезает в 1024. */
              className={
                'flex flex-col gap-[3px]' +
                (i > 0 ? ' lg:border-l lg:border-night-3 lg:pl-[24px] xl:pl-[32px]' : '')
              }
            >
              <span className="font-mono text-[17px] font-bold text-white">{cell.value}</span>
              {/* Подпись переносится на узком (в макете nowrap) — иначе горизонтальный скролл. */}
              <span className="font-mono text-[11px] leading-[1.35] text-code-muted lg:whitespace-nowrap">
                {cell.label}
              </span>
            </div>
          ))}
        </div>

        <LiveStatus />
      </div>
    </section>
  )
}

/**
 * Живой индикатор. Спрашиваем /health общим хуком useServiceHealth и пишем ровно
 * то, что он ответил: «все системы работают» из макета без проверки было бы
 * утверждением, которого мы не можем подтвердить.
 */
function LiveStatus() {
  const state = useServiceHealth()

  const label = state === 'checking' ? 'проверяем сервис…'
    : state === 'ok' ? 'все системы работают'
    : 'сервис недоступен'

  /* В макете чип один — зелёный. Состояний три, поэтому «недоступен» и
     «проверяем» берут парные токены danger/night-3 той же формы. */
  const tone = state === 'ok' ? 'bg-night-ok-bg text-night-ok'
    : state === 'down' ? 'bg-night-danger-bg text-night-danger'
    : 'bg-night-3 text-night-dim'

  const dot = state === 'ok' ? 'bg-night-ok'
    : state === 'down' ? 'bg-night-danger'
    : 'bg-night-dim'

  return (
    <span
      role="status"
      className={`flex w-fit shrink-0 items-center gap-[7px] rounded-[20px] px-[12px] py-[6px] font-mono text-[11px] font-medium ${tone}`}
    >
      <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  )
}

/** Самый свежий снимок из всех сервисов. snapshotDate приходит как YYYY-MM-DD,
    поэтому сравнение строк совпадает с хронологией. */
function freshestSnapshot(services: ServiceSummary[]): string | null {
  let latest: string | null = null
  for (const s of services) {
    if (s.snapshotDate && (latest === null || s.snapshotDate > latest)) latest = s.snapshotDate
  }
  return latest
}
