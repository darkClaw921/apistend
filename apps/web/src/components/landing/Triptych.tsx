import Link from 'next/link'
import type { Route } from 'next'
import { ArrowDown, ArrowRight, LaptopMinimal } from 'lucide-react'
import { SERVICE_LIST } from '@apistend/shared'
import { cn, formatInt, formatMethods } from '@apistend/ui'

/**
 * Секция «Мокай. Отлаживай. Подключай.». Макет: «Section Triptych» в APIStend.pen
 * (экспорт 10_Section_Triptych.html).
 *
 * Три колонки с разделителями: у каждой своё слово, свой маленький макет-иллюстрация,
 * описание и ссылка. Компонент серверный: стейта и эффектов здесь нет, единственное
 * число приходит пропсом.
 */

export interface TriptychProps {
  /** Всего методов в каталоге. null — API недоступен, число из фразы убираем. */
  totalMethods: number | null
}

const LINK_CLASS =
  'mt-auto inline-flex w-fit items-center gap-[6px] text-[13px] font-semibold text-night-accent transition-colors hover:text-night-accent-2'

/** Бейдж глагола на тёмном: примитив MethodBadge из @apistend/ui рассчитан на светлый кабинет. */
const METHOD_TONE: Record<string, string> = {
  GET: 'bg-night-ok-bg text-night-ok',
  POST: 'bg-night-accent-bg text-night-accent',
}

/**
 * Три пути для колонки «Мокай». Сверены с собственным каталогом проекта
 * (packages/mock-engine/generated/*.catalog.json), а не взяты из макета: у Bitrix24
 * там нарисовано /rest/1/crm.deal.list — сегмент с номером пользователя есть только
 * во входящих вебхуках портала, в каталоге путь /rest/crm.deal.list. У Wildberries
 * макет показывает GET /api/v3/stocks/{id}, но у этого пути в спецификации есть
 * только POST, PUT и DELETE, — берём настоящий GET из того же каталога.
 */
const MOCK_ROWS = [
  { method: 'POST', path: '/rest/crm.deal.list' },
  { method: 'POST', path: '/v3/posting/fbs/list' },
  { method: 'GET', path: '/api/v1/feedbacks' },
] as const

/**
 * Строки журнала для колонки «Отлаживай». В макете справа стоят задержки
 * («74 мс», «1 240 мс») — мы их не измеряем, а выдуманное время ответа читалось бы
 * как обещание производительности. Вместо задержки показываем то, что журнал правда
 * хранит: код ответа и имя сценария. Пары «путь → сценарий» тоже настоящие:
 * 429 стоит на Wildberries (у Bitrix24 при превышении лимита не 429, а 503),
 * 500 — на Ozon, где сценарий server_error есть.
 */
const LOG_ROWS = [
  { time: '12:04:31', line: 'POST /v3/posting/fbs/list', result: '200 · success', tone: 'text-night-ok' },
  { time: '12:03:58', line: 'POST /api/v3/stocks/{warehouseId}', result: '429 · rate_limit', tone: 'text-night-warn' },
  { time: '12:02:11', line: 'POST /v1/analytics/data', result: '500 · server_error', tone: 'text-night-danger' },
] as const

/**
 * Адрес, на который CLI отдаёт вебхуки. Ровно тот же, что в команде из секции
 * «Вебхуки на localhost»: `apistend listen --forward localhost:3000/webhooks`.
 */
const FORWARD_TARGET = 'localhost:3000/webhooks'

/** Колонка «Мокай»: три пути каталога с бейджами глаголов. */
function MockRows() {
  return (
    <div className="flex min-h-[168px] w-full flex-col justify-center gap-[8px] rounded-[10px] border border-night-line bg-code-surface p-[16px]">
      {MOCK_ROWS.map((row) => (
        <p
          key={row.path}
          className="flex items-center gap-[8px] rounded-[6px] border border-night-line bg-night-2 px-[10px] py-[8px]"
        >
          <span
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-[4px] px-[7px] py-[3px]',
              'font-mono text-[11px] font-bold tracking-[0.4px]',
              METHOD_TONE[row.method],
            )}
          >
            {row.method}
          </span>
          {/* Путь длиннее ячейки обрезаем: это иллюстрация, полный список — в каталоге по ссылке ниже. */}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-nav-text">{row.path}</span>
        </p>
      ))}
    </div>
  )
}

/** Колонка «Отлаживай»: три строки журнала запросов. */
function LogRows() {
  return (
    /* В макете у этой карточки свой фон #0D1218 и граница посветлее — отдельных токенов
       под них нет. Берём ближайшую пару тёмного слоя: фон страницы и nav-border. */
    <div className="flex min-h-[168px] w-full flex-col justify-center gap-[8px] rounded-[10px] border border-nav-border bg-night p-[16px]">
      {LOG_ROWS.map((row) => (
        <p key={row.line} className="flex items-center gap-[10px] font-mono text-[10.5px]">
          {/* Ниже 640 время уходит: время, путь и результат в одну строку там не помещаются. */}
          <span className="tabular hidden shrink-0 text-code-muted sm:inline">{row.time}</span>
          <span className="min-w-0 flex-1 truncate text-night-dim">{row.line}</span>
          <span className={cn('shrink-0', row.tone)}>{row.result}</span>
        </p>
      ))}
    </div>
  )
}

/** Колонка «Подключай»: три сервиса, стрелка и адрес приложения на машине разработчика. */
function WebhookChain() {
  return (
    <div className="flex min-h-[168px] w-full flex-col items-center justify-center gap-[8px] rounded-[10px] border border-night-line bg-code-surface p-[16px]">
      <div className="flex items-start justify-center gap-[8px]">
        {SERVICE_LIST.map((service) => (
          /* Цвет марки — только на квадрате и только переменной токена, как в ServiceSquare;
             сам примитив рисует одну букву, а в макете короткий код B24 / OZ / WB. */
          <span
            key={service.code}
            aria-hidden
            style={{ backgroundColor: `var(--color-${service.brandToken})` }}
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] text-[11px] font-bold text-white"
          >
            {service.shortCode}
          </span>
        ))}
      </div>

      <ArrowDown size={16} className="shrink-0 text-code-muted" aria-hidden />

      <span className="flex max-w-full items-center gap-[8px] rounded-[6px] border border-nav-border bg-night-2 px-[12px] py-[9px]">
        <LaptopMinimal size={15} className="shrink-0 text-night-accent" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[11px] text-white">{FORWARD_TARGET}</span>
      </span>
    </div>
  )
}

/**
 * Ссылка колонки. Якорь на соседнюю секцию этой же страницы — обычный <a>:
 * он работает и до гидратации, так же сделано в шапке лендинга.
 */
function ColumnLink({ href, label }: { href: string; label: string }) {
  const body = (
    <>
      {label}
      <ArrowRight size={14} className="shrink-0" aria-hidden />
    </>
  )

  if (href.startsWith('#')) {
    return (
      <a href={href} className={LINK_CLASS}>
        {body}
      </a>
    )
  }

  return (
    <Link href={href as Route} className={LINK_CLASS}>
      {body}
    </Link>
  )
}

/**
 * Сколько в каталоге сервисов — берём из пакета: в макете «трёх сервисов» вшито
 * в текст и устареет на четвёртом сервисе.
 */
const SERVICE_COUNT_WORD: Record<number, string> = { 1: 'одного', 2: 'двух', 3: 'трёх', 4: 'четырёх' }

function servicesPhrase(): string {
  const n = SERVICE_LIST.length
  if (n === 1) return 'одного сервиса'
  return `${SERVICE_COUNT_WORD[n] ?? formatInt(n)} сервисов`
}


export function Triptych({ totalMethods }: TriptychProps) {
  const columns = [
    {
      word: 'Мокай.',
      Visual: MockRows,
      /* В макете «Каталог из 105 методов» — заглушка дизайнера. Число приходит из
         каталога; если API не ответил, фраза живёт без числа, а не с выдуманным. */
      desc:
        totalMethods === null
          ? `Каталог методов ${servicesPhrase()}. Ответы, коды ошибок и пагинация — как в боевом API.`
          : `Каталог ${servicesPhrase()}: ${formatMethods(totalMethods)}. Ответы, коды ошибок и пагинация — как в боевом API.`,
      link: { label: 'Открыть каталог', href: '/catalog' },
    },
    {
      word: 'Отлаживай.',
      Visual: LogRows,
      /*
        Макет обещает «трассировку» — такой функции нет. В журнале есть тело запроса
        и ответа, заголовки, имя сценария и повтор запроса в консоли: про них и пишем.
        Сценарии 401, 429 и 500 названы верно, все три есть в каталоге (401 у Bitrix24
        и Wildberries, 429 у Ozon и Wildberries, 500 у Ozon и Wildberries).
      */
      desc: 'Журнал каждого запроса: тело, заголовки и сценарий — 401, 429, 500 или таймаут. Любой запрос повторяется в консоли.',
      link: { label: 'Смотреть логи', href: '/logs' },
    },
    {
      word: 'Подключай.',
      Visual: WebhookChain,
      /* Из фразы макета убрано «за пару минут»: сколько занимает сборка своего мока,
         мы не замеряли, а обещание срока — такая же выдумка, как и метрика. */
      desc: 'Вебхуки приходят на localhost через CLI, а недостающие ручки добавляются своими моками.',
      link: { label: 'Как это работает', href: '#webhooks' },
    },
  ]

  return (
    <section className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[40px]">
        <h2 className="text-center text-[28px] leading-[1.15] font-bold tracking-[-1px] text-balance text-white md:text-[38px] md:leading-[44px]">
          Мокай. Отлаживай. Подключай.
        </h2>

        {/* Разделители макета — вертикальные линии между колонками. Ниже md колонки
            складываются в одну, и линия становится горизонтальной: вертикальная там
            резала бы столбец пополам. Границу вешаем на саму колонку по индексу,
            а не через divide-*, — так видно, у какой колонки она появляется. */}
        <div className="grid grid-cols-1 md:grid-cols-3">
          {columns.map((column, i) => (
            <div
              key={column.word}
              className={cn(
                'flex flex-col items-center gap-[18px] py-[28px] md:px-[24px] md:py-0 lg:px-[32px]',
                i === 0 && 'pt-0',
                i === columns.length - 1 && 'pb-0',
                i > 0 && 'border-t border-night-line md:border-t-0 md:border-l',
              )}
            >
              <h3 className="w-full text-center text-[24px] font-bold tracking-[-0.8px] text-white md:text-[30px]">
                {column.word}
              </h3>

              <column.Visual />

              <p className="w-full text-center text-[14px] leading-[22px] text-nav-text">{column.desc}</p>

              <ColumnLink href={column.link.href} label={column.link.label} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
