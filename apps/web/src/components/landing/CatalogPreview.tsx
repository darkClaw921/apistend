import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { SERVICE_PROFILES } from '@apistend/shared'
import type { ChipTone } from '@apistend/ui'
import { ServiceDot, cn, formatInt, formatMethods, plural } from '@apistend/ui'
import { READINESS_LABEL, READINESS_TONE } from '@/lib/readiness'
import type { CatalogListItem } from '@/lib/types'

/**
 * Секция «Каталог». Макет: «Section Catalog» в APIStend.pen (экспорт 11_Section_Catalog.html).
 *
 * Шапка с числами и кнопкой, таблица из шести настоящих методов и подвал со ссылкой
 * на полный каталог. Все числа и все строки приходят пропсами: «105 методов и 14 типов
 * событий» в макете — заглушка дизайнера, а строки таблицы там придуманы вместе
 * с описаниями. Компонент серверный.
 */

export interface CatalogPreviewProps {
  /** Всего методов в каталоге. null — API недоступен, число из заголовка убираем. */
  totalMethods: number | null
  /** Сколько типов событий вебхуков знает каталог событий. Считается из пакета. */
  eventTypes: number
  /** Витрина каталога. Пустой массив — API недоступен, таблицу не рисуем. */
  featured: CatalogListItem[]
}

/** Строк в макете ровно шесть; придёт больше — остальное живёт в каталоге. */
const ROW_LIMIT = 6

/** Бейдж глагола на тёмном: примитив MethodBadge из @apistend/ui рассчитан на светлый кабинет. */
const METHOD_TONE: Record<string, string> = {
  GET: 'bg-night-ok-bg text-night-ok',
  POST: 'bg-night-accent-bg text-night-accent',
  PUT: 'bg-night-warn-bg text-night-warn',
  PATCH: 'bg-night-warn-bg text-night-warn',
  DELETE: 'bg-night-danger-bg text-night-danger',
}

/**
 * Чип готовности. Подпись и тон берём из общего справочника (lib/readiness.ts),
 * чтобы на лендинге и в каталоге они назывались одинаково: в макете стоит
 * «Обновляется», а в продукте это состояние называется «В работе».
 *
 * Сам StatusChip свёрстан для светлого кабинета, и цвет точки задаётся внутри тоном —
 * снаружи классом его не перекрыть, поэтому чип собран по месту, как в Services.
 */
const CHIP_TONE: Record<ChipTone, { chip: string; dot: string }> = {
  success: { chip: 'bg-night-ok-bg text-night-ok', dot: 'bg-night-ok' },
  warning: { chip: 'bg-night-warn-bg text-night-warn', dot: 'bg-night-warn' },
  danger: { chip: 'bg-night-danger-bg text-night-danger', dot: 'bg-night-danger' },
  info: { chip: 'bg-night-accent-bg text-night-accent', dot: 'bg-night-accent' },
  accent: { chip: 'bg-night-accent-bg text-night-accent', dot: 'bg-night-accent' },
  neutral: { chip: 'bg-night-3 text-night-dim', dot: 'bg-night-dim' },
}

/**
 * Заголовок собираем из того, что пришло. Нет числа методов — предложение остаётся
 * без него; нет обоих чисел — остаётся нейтральная строка, но не выдуманное число
 * и не пустая дыра на месте заголовка.
 */
function headline(totalMethods: number | null, eventTypes: number): string {
  const parts: string[] = []
  if (totalMethods !== null) parts.push(formatMethods(totalMethods))
  if (Number.isFinite(eventTypes) && eventTypes > 0) {
    parts.push(`${formatInt(eventTypes)} ${plural(eventTypes, 'тип', 'типа', 'типов')} событий`)
  }
  if (parts.length === 0) return 'Каталог методов и событий вебхуков'
  return `${parts.join(' и ')} уже готовы`
}

export function CatalogPreview({ totalMethods, eventTypes, featured }: CatalogPreviewProps) {
  const rows = featured.slice(0, ROW_LIMIT)

  /*
    «И ещё N методов» считаем от показанных строк, а не от длины featured: если ведущий
    передаст больше шести, лишние в таблицу не попадут и вычитать их было бы неправдой.
    Без totalMethods строки нет вовсе — число «сколько ещё» взять неоткуда.
  */
  const rest = totalMethods === null ? null : totalMethods - rows.length

  return (
    <section id="catalog" className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[32px]">
        {/* Ниже md кнопка уходит под заголовок: рядом с ним она отнимает у строки
            те же 180 px, из-за которых заголовок ломается на четыре строки. */}
        <header className="flex flex-col gap-[20px] md:flex-row md:items-end md:justify-between md:gap-[24px]">
          <div className="flex min-w-0 flex-col gap-[14px]">
            <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent uppercase">
              Каталог
            </p>
            <h2 className="text-[28px] leading-[1.15] font-bold tracking-[-1px] text-balance text-white md:text-[38px] md:leading-[44px]">
              {headline(totalMethods, eventTypes)}
            </h2>
          </div>

          <Link
            href="/catalog"
            className="inline-flex w-fit shrink-0 items-center gap-[8px] rounded-[6px] border border-nav-border bg-night-2 px-[20px] py-[12px] text-[14px] font-semibold text-white transition-colors hover:border-night-accent"
          >
            Открыть каталог
            <ArrowUpRight size={15} className="shrink-0" aria-hidden />
          </Link>
        </header>

        {/*
          Таблица собрана flex-строками, а не <table>: у table-fixed тянущаяся колонка
          уже однажды схлопывалась в ноль ширины, а здесь колонки прячутся по ширине
          экрана — описание первым, следом название сервиса. Путь не прячется никогда:
          без него строка перестаёт что-либо значить.
        */}
        {rows.length > 0 ? (
          <div className="overflow-hidden rounded-[14px] border border-night-line bg-night-2">
            <ul>
              {rows.map((item, i) => {
                const tone = CHIP_TONE[READINESS_TONE[item.readiness]]

                return (
                  <li
                    key={item.id}
                    className={cn(
                      'flex items-center gap-[12px] px-[16px] py-[14px] md:gap-[16px] md:px-[24px] md:py-[16px]',
                      i > 0 && 'border-t border-night-line',
                    )}
                  >
                    <span className="flex shrink-0 items-center gap-[8px] lg:w-[150px]">
                      <ServiceDot service={item.serviceCode} />
                      {/* Название прячется вторым — с md. truncate работает только на блоке,
                          поэтому md:block, а не md:inline: на lg колонка фиксированные 150 px
                          и «Ozon Seller API» обязан обрезаться, а не растягивать строку. */}
                      <span className="hidden min-w-0 flex-1 truncate text-[13px] font-medium text-white md:block">
                        {SERVICE_PROFILES[item.serviceCode].title}
                      </span>
                    </span>

                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center justify-center rounded-[4px] px-[7px] py-[3px]',
                        'font-mono text-[11px] font-bold tracking-[0.4px]',
                        METHOD_TONE[item.httpMethod.toUpperCase()] ?? 'bg-night-3 text-night-dim',
                      )}
                    >
                      {item.httpMethod.toUpperCase()}
                    </span>

                    {/* На узком путь переносится по словам, а не обрезается: это единственная
                        колонка, по которой строку можно узнать. С md он снова в одну строку. */}
                    <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-white md:truncate md:text-[13px] lg:max-w-[300px]">
                      {item.path}
                    </code>

                    <span className="hidden min-w-0 flex-1 truncate text-[13px] text-nav-text xl:block">
                      {item.description || item.title}
                    </span>

                    <span
                      className={cn(
                        'ml-auto inline-flex shrink-0 items-center gap-[6px] rounded-[20px] px-[10px] py-[4px]',
                        'text-[12px] font-medium whitespace-nowrap',
                        tone.chip,
                      )}
                    >
                      <span className={cn('h-[6px] w-[6px] shrink-0 rounded-full', tone.dot)} aria-hidden />
                      {READINESS_LABEL[item.readiness]}
                    </span>
                  </li>
                )
              })}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-[8px] border-t border-night-line bg-code-surface px-[16px] py-[16px] md:px-[24px]">
              {/*
                В макете подпись перечисляет группы каталога («задачи, отзывы, поставки,
                цены, аналитика»). Состав групп приходит не сюда, а в /catalog, и списком
                из вёрстки он бы разошёлся с настоящим — оставлено только число.
              */}
              {rest !== null && rest > 0 ? (
                <p className="text-[13px] text-nav-text">И ещё {formatMethods(rest)} в каталоге</p>
              ) : null}
              <Link
                href="/catalog"
                className="ml-auto text-[13px] font-semibold text-night-accent transition-colors hover:text-night-accent-2"
              >
                Смотреть все →
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
