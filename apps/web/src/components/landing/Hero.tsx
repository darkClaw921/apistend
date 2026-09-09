'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Search, Terminal } from 'lucide-react'
import { ServiceSquare, cn, formatMethods } from '@apistend/ui'
import { SERVICE_PROFILES, type Readiness } from '@apistend/shared'
import type { ServiceSummary } from '@/lib/types'
import { ServiceUsageCards } from './ServiceUsageCards'
import { READINESS_LABEL } from '@/lib/readiness'

/**
 * Первый экран лендинга. Макет «Лендинг — APIStend», секция Hero.
 *
 * Композиция центральная: плашка «Новое», заголовок с числом методов, подзаголовок,
 * поиск по каталогу, вторичная плашка и витрина из шести настоящих методов каталога.
 *
 * Секция целиком клиентская: поле поиска держит значение в стейте и уводит на каталог
 * через router.push. Делить файл на серверную обёртку и клиентское поле нечего —
 * кроме формы здесь только разметка, а секция обязана лежать в одном файле.
 */

/** Тёмные пары для бейджа HTTP-метода: MethodBadge из @apistend/ui рассчитан на светлый фон. */
const HTTP_TONE: Record<string, string> = {
  GET: 'bg-night-ok-bg text-night-ok',
  POST: 'bg-night-accent-bg text-night-accent',
  PUT: 'bg-night-warn-bg text-night-warn',
  PATCH: 'bg-night-warn-bg text-night-warn',
  DELETE: 'bg-night-danger-bg text-night-danger',
}
const HTTP_TONE_FALLBACK = 'bg-night-3 text-night-dim'

/** Цвет точки готовности. Подпись рядом — из READINESS_LABEL, общая с каталогом. */
const READINESS_DOT: Record<Readiness, string> = {
  ready: 'bg-night-ok',
  updating: 'bg-night-warn',
  planned: 'bg-night-dim',
}

export function Hero({
  totalMethods,
  services,
}: {
  /** Всего методов в каталоге. null — API недоступен, число в тексте не показываем. */
  totalMethods: number | null
  /**
   * Сервисы с живыми счётчиками. Пустой массив — API недоступен, витрину не рисуем.
   *
   * Раньше здесь была витрина из шести отдельных методов. На первом экране человек
   * ещё выбирает сервис, а не метод, и три карточки сервиса с настоящими числами
   * отвечают на его вопрос точнее, чем шесть случайных методов из каталога.
   */
  services: ServiceSummary[]
}) {

  return (
    <section className="bg-night px-[20px] pt-[56px] pb-[72px] md:px-[80px]">
      <div className="mx-auto flex max-w-[1280px] flex-col items-center text-center">
        <Link
          href="#webhooks"
          className="inline-flex items-center gap-[8px] rounded-[24px] border border-nav-border bg-night-accent-bg px-[14px] py-[6px] transition-colors hover:border-night-accent"
        >
          <span className="shrink-0 rounded-[20px] bg-accent px-[8px] py-[2px] text-[11px] font-semibold text-white">
            Новое
          </span>
          <span className="text-[13px] font-medium text-night-accent-2">
            Вебхуки приходят прямо на localhost
          </span>
          <ArrowRight size={13} className="shrink-0 text-night-accent-2" aria-hidden />
        </Link>

        {/* В макете число «105 методов» — заглушка дизайнера. Показываем то, что пришло
            из каталога; без ответа API строка живёт без числа, а не с выдуманным. */}
        <h1 className="mt-[28px] max-w-[1000px] text-[34px] leading-[1.08] font-bold tracking-[-1px] text-balance text-white sm:text-[44px] md:text-[60px] md:leading-[65px] md:tracking-[-2.2px]">
          {totalMethods === null ? (
            'Демо-API для ваших интеграций'
          ) : (
            <>
              <span className="text-night-accent">{formatMethods(totalMethods)}</span> демо-API для
              ваших интеграций
            </>
          )}
        </h1>

        {/* «Без лимитов» из макета убрано: лимиты как раз воспроизводятся —
            apps/api/src/lib/rate-limit.ts, шлюз при исчерпании ведра отдаёт 429 (503 у
            Bitrix24), и соседние секции этим прямо хвалятся. Свободно у нас другое:
            регистрация просит только почту и пароль (apps/api/src/routes/auth.ts),
            карта не нужна нигде. */}
        <p className="mt-[20px] max-w-[760px] text-[15px] leading-[24px] text-nav-text md:text-[17px] md:leading-[27px]">
          APIStend — песочница с точными копиями Bitrix24, Ozon Seller API и Wildberries. Те же
          схемы ответов, коды ошибок и вебхуки, только без боевого аккаунта и без карты.
        </p>

        <HeroSearch />

        {/* Из фразы макета убраны «за 30 секунд»: сколько занимает регистрация,
            мы не замеряли, а срок в интерфейсе — такое же выдуманное число, как метрика.
            Смысл кнопки («не искать чужое, а завести своё») держится и без него. */}
        <Link
          href="/register"
          className="mt-[14px] inline-flex items-center gap-[8px] rounded-[8px] border border-nav-border bg-code-surface px-[16px] py-[9px] text-[13px] font-medium text-night-text transition-colors hover:border-night-dim"
        >
          <Terminal size={14} className="shrink-0" aria-hidden />
          Или создайте свою песочницу
        </Link>

        <ServiceUsageCards initial={services} />

        <Link
          href="/catalog"
          className="mt-[26px] inline-flex items-center gap-[7px] text-[14px] font-semibold text-white transition-colors hover:text-night-accent"
        >
          {totalMethods === null ? 'Открыть каталог' : `Открыть весь каталог — ${formatMethods(totalMethods)}`}
          <ArrowRight size={15} className="shrink-0" aria-hidden />
        </Link>
      </div>
    </section>
  )
}

/**
 * Поиск по каталогу. Страница /catalog читает параметр q и подставляет его в поле,
 * поэтому достаточно увести на неё с запросом в адресе.
 */
function HeroSearch() {
  const router = useRouter()
  const [value, setValue] = useState('')

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const q = value.trim()
    // Пустой запрос — просто каталог: пустой ?q= в адресе ничего не фильтрует.
    router.push(q ? `/catalog?q=${encodeURIComponent(q)}` : '/catalog')
  }

  return (
    <form
      onSubmit={onSubmit}
      role="search"
      className="mt-[28px] flex w-full max-w-[640px] flex-col gap-[10px] sm:flex-row"
    >
      <label className="flex flex-1 items-center gap-[10px] rounded-[8px] border border-nav-border bg-code-surface px-[16px] py-[14px] focus-within:border-accent">
        <Search size={16} className="shrink-0 text-code-muted" aria-hidden />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Найдите метод: crm.deal, остатки, отправления…"
          aria-label="Поиск метода в каталоге"
          className="w-full min-w-0 bg-transparent text-[14px] text-white placeholder:text-night-dim focus:outline-none"
        />
      </label>
      <button
        type="submit"
        className="shrink-0 rounded-[8px] bg-accent px-[22px] py-[14px] text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
      >
        Найти метод
      </button>
    </form>
  )
}
