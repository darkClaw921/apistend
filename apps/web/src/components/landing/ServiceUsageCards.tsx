'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { ServiceSquare, cn, formatDate, formatInt } from '@apistend/ui'
import { API_URL } from '@/lib/api'
import type { ServiceSummary } from '@/lib/types'

/**
 * Витрина сервисов на первом экране: сервис, объём каталога и то, как им пользуются.
 *
 * Раньше здесь лежали шесть карточек отдельных методов — они отвечали на вопрос
 * «что за метод», хотя человек на первом экране ещё выбирает сервис, а не метод.
 *
 * Все четыре числа — настоящие: методы приходят из каталога движка, запросы
 * и пользователи считаются по журналу. Ноль показывается как ноль: витрина,
 * рисующая несуществующую популярность, обесценивает и остальные цифры на странице.
 *
 * Компонент клиентский только ради обновления счётчиков: первый показ приходит
 * с сервера вместе со страницей, дальше раз в полминуты цифры обновляются сами —
 * «сейчас в песочницах» иначе устаревало бы к моменту, когда его прочитают.
 */

const REFRESH_MS = 30_000

export function ServiceUsageCards({ initial }: { initial: ServiceSummary[] }) {
  const [services, setServices] = useState(initial)

  useEffect(() => {
    if (initial.length === 0) return
    let alive = true

    const tick = async () => {
      try {
        const response = await fetch(`${API_URL}/api/services`, { cache: 'no-store' })
        if (!response.ok) return
        const data = (await response.json()) as { services: ServiceSummary[] }
        if (alive && data.services.length > 0) setServices(data.services)
      } catch {
        // Сеть отвалилась — оставляем последние известные числа: пустая витрина
        // хуже слегка устаревшей.
      }
    }

    const timer = setInterval(() => void tick(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [initial.length])

  if (services.length === 0) return null

  // На планшете три карточки в ряд ужимают заголовок сервиса до многоточия,
  // поэтому третья колонка появляется только с 1024 px.
  return (
    <div className="mt-[40px] grid w-full gap-[16px] md:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => (
        <ServiceCard key={service.code} service={service} />
      ))}
    </div>
  )
}

function ServiceCard({ service }: { service: ServiceSummary }) {
  const usage = service.usage
  const online = usage?.usersOnline ?? 0

  return (
    <Link
      href={{ pathname: '/catalog', query: { service: service.code } }}
      /* min-w-0: карточка — элемент сетки, а у него min-width: auto, и длинный
         адрес в моноширинном шрифте задавал бы ей минимальную ширину. */
      className="group flex h-full min-w-0 flex-col gap-[14px] rounded-[12px] border border-night-line bg-night-2 p-[18px] text-left transition-colors hover:border-night-accent"
    >
      <div className="flex items-center gap-[10px]">
        <ServiceSquare service={service.code} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-white">{service.title}</span>
          <span className="block truncate text-[11px] text-night-dim">{service.apiVersion}</span>
        </span>
        <ArrowUpRight
          size={16}
          className="shrink-0 text-night-dim transition-colors group-hover:text-night-accent"
          aria-hidden
        />
      </div>

      {/* Заменяет боевой адрес — то, ради чего сервис вообще подключают. */}
      <p className="truncate font-mono text-[11px] text-code-muted" title={service.replacesUrl}>
        {service.replacesUrl}
      </p>

      <dl className="grid grid-cols-2 gap-x-[12px] gap-y-[12px] border-t border-night-line pt-[14px]">
        <Metric value={formatInt(service.methodsCount)} label="методов" />
        <Metric value={formatInt(usage?.requestsTotal ?? 0)} label="запросов через стенд" />
        {/* У Apify вместо счётчика разработчиков — акторы: их снимок и есть то,
            ради чего этот сервис здесь, а «0 разработчиков за 30 дней» на новом
            сервисе показывает не популярность, а его возраст. У остальных
            сервисов акторов не бывает, и метрика остаётся прежней. */}
        {typeof service.actorsCount === 'number' ? (
          <Metric value={formatInt(service.actorsCount)} label="акторов в снимке" />
        ) : (
          <Metric value={formatInt(usage?.users ?? 0)} label="разработчиков за 30 дней" />
        )}
        <Metric
          value={formatInt(online)}
          label="сейчас в песочницах"
          /* Точка горит, только когда кто-то действительно есть: зелёный кружок
             рядом с нулём читается как «всё хорошо», а не как «никого». */
          dot={online > 0}
        />
      </dl>

      {service.snapshotDate ? (
        <p className="mt-auto pt-[4px] text-[11px] text-code-muted">
          снимок документации {formatDate(service.snapshotDate)}
        </p>
      ) : null}
    </Link>
  )
}

function Metric({ value, label, dot = false }: { value: string; label: string; dot?: boolean }) {
  return (
    <div className="min-w-0">
      <dd className="flex items-center gap-[6px] font-mono text-[18px] leading-[1.1] font-semibold text-white tabular">
        {dot ? (
          <span className="h-[6px] w-[6px] shrink-0 animate-pulse rounded-full bg-night-ok" aria-hidden />
        ) : null}
        {value}
      </dd>
      <dt className={cn('mt-[3px] text-[11px] leading-[1.3] text-night-dim')}>{label}</dt>
    </div>
  )
}
