import Link from 'next/link'
import type { Route } from 'next'
import { ArrowRight, MessageSquarePlus } from 'lucide-react'
import { cn, formatDate, formatInt, formatMethods } from '@apistend/ui'
import type { ServiceSummary } from '@/lib/types'

/**
 * Секция «Сервисы» тёмного лендинга. Макет: Section Services в APIStend.pen.
 *
 * Все числа карточки приходят из живого каталога (`services`), а не из вёрстки:
 * каталог наполняется волнами, и витрина обязана показывать то, что есть сейчас,
 * вместе с датой снимка документации.
 */

type SampleMethod = 'GET' | 'POST'

interface Sample {
  readonly method: SampleMethod
  readonly path: string
}

/** Трекер проекта: страницы контактов у проекта нет, обсуждения идут в issues. */
const GITHUB_ISSUES = 'https://github.com/darkClaw921/apistend/issues'

/**
 * Три показательных пути на сервис. Раньше жили в page.tsx как SERVICE_SAMPLES —
 * это витринные данные одной секции, им место рядом с разметкой.
 *
 * Глаголы не выдуманы и не взяты из макета: сверены с собственным каталогом проекта
 * (packages/mock-engine/generated/*.catalog.json). У Bitrix24 все методы POST —
 * имя метода лежит в пути, а глагол смысла не несёт. Для /api/v3/stocks/{warehouseId}
 * в спецификации WB три глагола; берём POST — это чтение остатков, как и соседние примеры.
 */
const SERVICE_SAMPLES: Record<ServiceSummary['code'], readonly Sample[]> = {
  bitrix24: [
    { method: 'POST', path: '/rest/crm.deal.list' },
    { method: 'POST', path: '/rest/crm.contact.add' },
    { method: 'POST', path: '/rest/tasks.task.list' },
  ],
  ozon: [
    { method: 'POST', path: '/v3/posting/fbs/list' },
    { method: 'POST', path: '/v3/product/info/list' },
    { method: 'POST', path: '/v1/review/list' },
  ],
  wildberries: [
    { method: 'GET', path: '/api/v3/orders/new' },
    { method: 'POST', path: '/api/v3/stocks/{warehouseId}' },
    { method: 'POST', path: '/content/v2/get/cards/list' },
  ],
}

/** Бейдж глагола на тёмном: примитив MethodBadge рассчитан на светлый фон кабинета. */
const METHOD_TONE: Record<SampleMethod, string> = {
  GET: 'bg-night-ok-bg text-night-ok',
  POST: 'bg-night-accent-bg text-night-accent',
}

/**
 * Чип статуса. Свёрстан по месту по той же причине, что и бейдж: у StatusChip
 * цвет точки задаётся внутри тоном, классом снаружи его не перекрыть.
 */
const STATUS_TONE: Record<ServiceSummary['status'], { label: string; chip: string; dot: string }> = {
  ok: { label: 'работает', chip: 'bg-night-ok-bg text-night-ok', dot: 'bg-night-ok' },
  updating: { label: 'обновляется', chip: 'bg-night-warn-bg text-night-warn', dot: 'bg-night-warn' },
  planned: { label: 'скоро', chip: 'bg-night-3 text-night-dim', dot: 'bg-night-dim' },
}

/**
 * formatMethods даёт «42 метода» одной строкой, а в макете число и слово стоят
 * на разных строках. Слово отделяем от числа, чтобы не заводить второе правило склонения.
 */
function methodsWord(n: number): string {
  return formatMethods(n).slice(formatInt(n).length).trim()
}

export function Services({ services }: { services: ServiceSummary[] }) {
  return (
    <section id="services" className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[40px]">
        <header className="flex flex-col items-center gap-[14px] text-center">
          <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent uppercase">
            Сервисы
          </p>
          <h2 className="max-w-[900px] text-[28px] leading-[1.15] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
            Три сервиса, на которых чаще всего ломаются интеграции
          </h2>
          <p className="max-w-[720px] text-[16px] leading-[26px] text-nav-text">
            Схемы запросов, коды ошибок, пагинация и лимиты повторены один в один.
            Ответ отличается от боевого только данными.
          </p>
        </header>

        {services.length === 0 ? (
          /*
            API недоступен — карточек нет, но секция остаётся на странице.
            Раньше здесь стоял `return null`, и вместе с секцией со страницы
            пропадал якорь id="services", на который ссылаются и шапка (LandingNav),
            и футер: ровно в аварийном режиме обе ссылки вели в никуда.
            Подставить карточки неоткуда — состав каталога, числа методов и даты
            снимков приходят из API, придумать их в вёрстке нельзя. Поэтому вместо
            карточек прямая строка. Так же устроен запасной вид в StackTabs.
          */
          <p className="rounded-[14px] border border-night-line bg-night-2 px-[20px] py-[28px] text-center text-[14px] leading-[1.5] text-nav-text">
            Список сервисов сейчас недоступен: каталог не ответил. Попробуйте обновить страницу.
          </p>
        ) : (
          <>
            {/*
              На 768 три колонки дают ~190 px под карточку — путь вроде
              /api/v3/stocks/{warehouseId} там уже не читается. Поэтому три колонки
              только с lg, на планшете две.
            */}
            <div className="grid gap-[16px] md:grid-cols-2 lg:grid-cols-3">
              {services.map((service) => {
                const status = STATUS_TONE[service.status]
                const samples = SERVICE_SAMPLES[service.code]

                return (
                  <article
                    key={service.code}
                    /* min-w-0: карточка — элемент сетки, а у него min-width: auto,
                       и моноширинный путь без переносов задавал ей минимальную ширину;
                       на 320 px из-за этого появлялся горизонтальный скролл страницы. */
                    className="flex min-w-0 flex-col gap-[16px] rounded-[14px] border border-night-line bg-night-2 p-[24px]"
                  >
                    {/*
                      Отступление от макета: до xl чип статуса уходит на свою строку
                      под заголовок. Причина измерена, а не придумана: на 1024 карточка
                      в трёх колонках оставляет 229 px содержимого, из них 40 px забирает
                      квадрат и ~85 px — чип, и заголовку доставалось 83 px. «Ozon Seller
                      API» превращался в «Ozon S…», «Wildberries» — в «Wildbe…». Пути ниже
                      обрезаются осознанно (полный список — в каталоге по ссылке), а имя
                      сервиса — то единственное, ради чего карточку вообще читают.
                      basis-full переносит чип на отдельную строку; с xl ширины хватает,
                      и он возвращается в ряд, как в макете.
                    */}
                    <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[10px]">
                      {/*
                        ServiceSquare рисует одну букву (B/O/W), а в макете на квадрате
                        двух-трёхзначная метка B24 / OZ / WB. Берём её из данных (shortCode),
                        цвет марки — той же переменной токена, что и в примитиве.
                      */}
                      <span
                        aria-hidden
                        style={{ backgroundColor: `var(--color-${service.brandToken})` }}
                        className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[10px] text-[13px] font-bold text-white"
                      >
                        {service.shortCode}
                      </span>

                      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        {/* truncate только с xl: там чип снова в ряду и ширина ограничена. */}
                        <h3 className="text-[18px] font-semibold tracking-[-0.3px] text-white xl:truncate">
                          {service.title}
                        </h3>
                        <p className="truncate font-mono text-[11px] text-code-muted">{service.apiVersion}</p>
                      </div>

                      {/* Обёртка нужна, чтобы basis-full растянул строку, а не сам чип. */}
                      <div className="basis-full xl:basis-auto">
                        <span
                          className={cn(
                            'inline-flex items-center gap-[6px] rounded-[20px] px-[10px] py-[4px]',
                            'text-[11px] font-medium whitespace-nowrap',
                            status.chip,
                          )}
                        >
                          <span className={cn('h-[5px] w-[5px] shrink-0 rounded-full', status.dot)} aria-hidden />
                          {status.label}
                        </span>
                      </div>
                    </div>

                    <ul className="flex flex-col gap-[6px] border-t border-night-3 pt-[16px]">
                      {samples.map((sample) => (
                        <li
                          key={sample.path}
                          className="flex items-center gap-[8px] rounded-[6px] bg-night px-[9px] py-[7px]"
                        >
                          <span
                            className={cn(
                              'inline-flex shrink-0 items-center justify-center rounded-[4px] px-[7px] py-[3px]',
                              'font-mono text-[11px] font-bold tracking-[0.4px]',
                              METHOD_TONE[sample.method],
                            )}
                          >
                            {sample.method}
                          </span>
                          {/* Путь длиннее ячейки обрезаем: полный список — в каталоге по ссылке ниже. */}
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-nav-text">
                            {sample.path}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/*
                      В макете здесь три числа: методы, «96 мс задержка» и «61 240 запросов».
                      Задержку по сервису и число запросов мы не измеряем — вместо выдуманных
                      чисел показываем то, что знаем: сколько методов в каталоге и на какую дату
                      снят снимок документации.
                    */}
                    <div className="flex gap-[8px] border-t border-night-3 pt-[16px]">
                      <p className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span className="font-mono text-[14px] font-semibold text-white">
                          {formatInt(service.methodsCount)}
                        </span>
                        <span className="text-[11px] text-code-muted">{methodsWord(service.methodsCount)}</span>
                      </p>
                      <p className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        {/* Снимка может не быть — тогда прочерк, а не подставленная дата. */}
                        <span className="font-mono text-[14px] font-semibold text-white">
                          {service.snapshotDate ? formatDate(service.snapshotDate) : '—'}
                        </span>
                        <span className="text-[11px] text-code-muted">снимок документации</span>
                      </p>
                    </div>

                    {/*
                      Описание лимита длинное («Около 2 запросов в секунду, бакет 50…») и в ячейку
                      третьего числа не влезает. Сокращать его нельзя: короткая версия с другим
                      числом была бы выдумкой, — поэтому отдельная строка целиком.
                    */}
                    <p className="text-[11px] leading-[1.5] text-code-muted">
                      <span className="text-night-dim">Лимиты: </span>
                      {service.rateLimit}
                    </p>

                    <Link
                      href={`/catalog?service=${service.code}` as Route}
                      className="mt-auto inline-flex w-fit items-center gap-[6px] text-[13px] font-semibold text-night-accent transition-colors hover:text-night-accent-2"
                    >
                      Смотреть методы
                      <ArrowRight size={14} aria-hidden />
                    </Link>
                  </article>
                )
              })}
            </div>

            {/*
              В макете полоса заканчивалась перечислением «Скоро: Яндекс Маркет, СБИС,
              МойСклад, Авито и 1С-Битрикс Магазин» и ссылкой «Дорожная карта →».
              Ссылку убрали раньше — дорожной карты у проекта нет. Но и само перечисление
              оставалось обещанием этой несуществующей карты: пять названий, никакого срока
              и ничего в репозитории, чем это подтвердить. Сервисов в коде ровно три
              (SERVICE_CODES в packages/shared/src/services.ts), четвёртый нигде не заведён.
              Поэтому вместо обещания — то, что правда есть: состав каталога и живой адрес,
              куда написать про недостающий сервис. Ссылка та же, что в FinalCta и футере.
            */}
            <p className="flex items-start gap-[12px] rounded-[10px] border border-night-line bg-night-2 px-[20px] py-[16px] text-[14px] leading-[1.5] text-nav-text">
              <MessageSquarePlus size={16} className="mt-[3px] shrink-0 text-code-muted" aria-hidden />
              <span>
                Других сервисов в песочнице пока нет — только те, что выше. Не хватает своего?{' '}
                <a
                  href={GITHUB_ISSUES}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-night-accent transition-colors hover:text-night-accent-2"
                >
                  Напишите в трекер
                </a>
                : обсуждения проекта идут там.
              </span>
            </p>
          </>
        )}
      </div>
    </section>
  )
}
