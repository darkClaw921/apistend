'use client'

import { Fragment, useState } from 'react'
import { ArrowDown, Check, Cloud, Copy, LaptopMinimal, Terminal } from 'lucide-react'
import { SERVICE_PROFILES, findEvent } from '@apistend/shared'
import { META_SEP, NBSP, cn, formatEvents } from '@apistend/ui'

/**
 * Секция «Вебхуки на localhost». Макет: «Section Webhooks Local» в APIStend.pen.
 *
 * Компонент клиентский ради одной вещи — кнопки копирования команды:
 * она обязана положить строку в буфер и показать, что положила.
 */

/** Настоящая команда CLI: у пакета есть listen, а флаг --forward — её штатный аргумент. */
const COMMAND = 'npx apistend listen --forward localhost:3000/webhooks'

/**
 * Третий пункт в макете — «агент поднимается контейнером рядом с тестами».
 * Контейнера нет: в репозитории ни одного Dockerfile, docker-compose.yml поднимает
 * только postgres, .github/workflows агента не запускает. Агент — это npm-пакет
 * apistend (packages/cli, bin apistend), и в CI он запускается ровно так же, как
 * на ноутбуке: npx, а ключ читается из APISTEND_API_KEY (packages/cli/src/config.ts),
 * то есть из секретов репозитория. Про это и пишем — и так же сказано в секции
 * «Интеграции», чтобы лендинг не спорил сам с собой.
 */
const BULLETS = [
  'Одна команда в терминале — и события идут на ваш порт',
  'Повтор любого события в один клик, история доставок сохраняется',
  'Работает в CI: тот же npx, ключ — из секретов репозитория',
] as const

/**
 * Макет подписывает первую карточку «событие posting.created». Такого кода
 * у Ozon нет: в каталоге событий это алиас настоящего TYPE_NEW_POSTING
 * (packages/shared/src/events.ts). Берём код из каталога, а не из макета.
 */
const NEW_POSTING = findEvent('posting.created')

const FLOW = [
  {
    title: 'APIStend',
    sub: NEW_POSTING ? `событие ${NEW_POSTING.code}` : 'исходящее событие сервиса',
    // В макете облако выкрашено в синий Ozon. Марка сервиса на нашей же карточке
    // вводила бы в заблуждение, да и правила проекта разрешают брендовый цвет
    // только точке или квадрату логотипа — берём акцент тёмного слоя.
    Icon: Cloud,
    iconClass: 'text-night-accent',
  },
  {
    // tnl-8f21 — документированный формат короткого идентификатора сессии
    // (ReadyFrame.displayId в packages/shared/src/tunnel.ts), а не выдуманный номер.
    title: 'APIStend CLI',
    sub: `защищённый канал${META_SEP}tnl-8f21`,
    Icon: Terminal,
    iconClass: 'text-night-accent',
  },
  {
    title: 'Ваше приложение',
    sub: 'POST http://localhost:3000/webhooks',
    Icon: LaptopMinimal,
    iconClass: 'text-night-ok',
  },
] as const

interface DeliveryLine {
  readonly time: string
  /** Настоящий код события из packages/shared/src/events.ts. */
  readonly eventCode: string
  /** Только код ответа приложения: короткая часть, она всегда остаётся в первой строке. */
  readonly status: string
  /**
   * Приписка о повторе доставки — отдельным полем, а не хвостом статуса:
   * на узком экране она уезжает во вторую строку, и склеенной строкой это не сделать.
   * null — повторять нечего (успешная доставка) или сервис не повторяет вовсе.
   */
  readonly retry: string | null
  readonly tone: 'ok' | 'warn'
}

/**
 * Первая ступень лестницы повторов Wildberries. Строку «повтор через …»
 * не выдумываем и не пишем цифрой: берём из профиля сервиса.
 */
const WB_FIRST_RETRY_MS = SERVICE_PROFILES.wildberries.webhook.retryDelaysMs[0]

/**
 * Журнал доставок. В макете здесь posting.created, stocks.changed и
 * crm.deal.stage.changed — ни одного настоящего кода: первые два переименованы,
 * а события «смена стадии» у Bitrix24 не существует вовсе, стадия приезжает
 * обычным ONCRMDEALUPDATE.
 *
 * Неудачную доставку с повтором макет вешает как раз на событие Bitrix24 —
 * это прямая неправда: retryDelaysMs у профиля bitrix24 пуст, портал не повторяет
 * доставку вообще, а вместо этого замедляет очередь. Поэтому строка с повтором
 * стоит на Wildberries, у которого повторы есть, а строки 2 и 3 поменяны местами.
 */
const LOG: readonly DeliveryLine[] = [
  { time: '10:42:18', eventCode: 'TYPE_NEW_POSTING', status: '200 OK', retry: null, tone: 'ok' },
  { time: '10:39:05', eventCode: 'ONCRMDEALUPDATE', status: '200 OK', retry: null, tone: 'ok' },
  {
    time: '10:31:44',
    eventCode: 'stocks_changed',
    status: '500',
    // Профиля без лестницы повторов приписки не получает: число выдумывать нечем.
    retry:
      WB_FIRST_RETRY_MS === undefined
        ? null
        : `повтор через ${Math.round(WB_FIRST_RETRY_MS / 1000)}${NBSP}с`,
    tone: 'warn',
  },
]

/** Метка сервиса (B24 / OZ / WB) для строки журнала: коды событий у сервисов разные. */
function serviceShortCode(eventCode: string): string | null {
  const event = findEvent(eventCode)
  return event ? SERVICE_PROFILES[event.serviceCode].shortCode : null
}

export function WebhooksLocal({ eventTypes }: { eventTypes: number }) {
  const [copied, setCopied] = useState(false)

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Буфер обмена недоступен (не https, нет разрешения) — молча ничего не делаем.
    }
  }

  // Число приходит пропсом и считается из каталога событий. Если оно почему-то
  // не число — предложение с ним просто не показываем, а не печатаем заглушку.
  const hasEventTypes = Number.isFinite(eventTypes) && eventTypes > 0

  return (
    <section id="webhooks" className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[40px] lg:flex-row lg:items-center lg:gap-[56px]">
        {/* Левая колонка. В макете жёсткие 600 px — ниже 1280 отдаём половину строки,
            ниже 1024 колонки складываются в одну. */}
        <div className="flex w-full flex-col gap-[22px] lg:w-[50%] lg:shrink-0 xl:w-[600px]">
          <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent">ВЕБХУКИ</p>

          <h2 className="text-[30px] leading-[36px] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
            События приходят прямо в приложение на вашем компьютере
          </h2>

          <p className="text-[16px] leading-[26px] text-nav-text">
            Ozon, Wildberries и Bitrix24 умеют слать вебхуки только на публичный адрес.
            APIStend доставляет их на localhost через свой агент — без туннелей, белых IP
            и проброса портов.
            {hasEventTypes
              ? ` Все ${formatEvents(eventTypes)} каталога приходят в том же формате, что и у боевого сервиса.`
              : null}
          </p>

          <ul className="flex flex-col gap-[12px]">
            {BULLETS.map((text) => (
              <li key={text} className="flex items-start gap-[10px] text-[15px] leading-[22px] text-night-text">
                <span className="mt-[1px] flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[6px] bg-night-accent-bg">
                  <Check size={12} className="text-night-accent" aria-hidden />
                </span>
                {text}
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-[12px] rounded-[6px] border border-nav-border bg-night px-[14px] py-[12px]">
            <span className="shrink-0 font-mono text-[12.5px] text-code-muted" aria-hidden>
              $
            </span>
            {/* Команда длиннее узкого экрана: прокручиваем её внутри строки,
                чтобы страница не поехала вбок. */}
            <code className="min-w-0 flex-1 overflow-x-auto scrollbar-thin font-mono text-[12.5px] whitespace-nowrap text-code-string">
              {COMMAND}
            </code>
            <button
              type="button"
              onClick={copyCommand}
              aria-label={copied ? 'Команда скопирована' : 'Копировать команду'}
              className="shrink-0 rounded-[6px] p-[2px] text-code-muted transition-colors hover:text-night-text"
            >
              {copied ? (
                <Check size={15} className="text-night-ok" aria-hidden />
              ) : (
                <Copy size={15} aria-hidden />
              )}
            </button>
            <span role="status" aria-live="polite" className="sr-only">
              {copied ? 'Скопировано' : ''}
            </span>
          </div>
        </div>

        {/* Правая колонка: путь события и журнал доставок. */}
        <div className="flex w-full min-w-0 flex-1 flex-col gap-[10px]">
          {FLOW.map((step, i) => (
            <Fragment key={step.title}>
              <div className="flex items-center gap-[14px] rounded-[10px] border border-nav-border bg-code-surface p-[16px]">
                <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-night-3">
                  <step.Icon size={19} className={step.iconClass} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="text-[14px] font-semibold text-white">{step.title}</span>
                  <span className="overflow-x-auto scrollbar-thin font-mono text-[11px] whitespace-nowrap text-code-muted">
                    {step.sub}
                  </span>
                </span>
              </div>
              {i < FLOW.length - 1 ? (
                <div className="flex justify-center py-[2px]">
                  <ArrowDown size={16} className="text-code-muted" aria-hidden />
                </div>
              ) : null}
            </Fragment>
          ))}

          <div className="flex flex-col gap-[9px] rounded-[10px] border border-nav-border bg-night p-[16px]">
            <p className="text-[10px] font-semibold tracking-[0.8px] text-code-muted">
              ДОСТАВКА В РЕАЛЬНОМ ВРЕМЕНИ
            </p>
            {LOG.map((line) => {
              const shortCode = serviceShortCode(line.eventCode)
              const tone = line.tone === 'ok' ? 'text-night-ok' : 'text-night-warn'
              return (
                <p
                  key={line.eventCode}
                  className="flex flex-wrap items-center gap-x-[10px] gap-y-[2px] font-mono text-[11px]"
                >
                  <span className="tabular shrink-0 text-code-muted">{line.time}</span>
                  {/* Метки сервиса в макете нет. Коды событий у разных сервисов
                      непохожи, и без метки строка читается как каша. */}
                  {shortCode ? <span className="shrink-0 text-code-muted">{shortCode}</span> : null}
                  <span className="min-w-0 flex-1 truncate text-code-text">{line.eventCode}</span>
                  <span className={cn('shrink-0', tone)}>{line.status}</span>
                  {/* Приписка о повторе ниже sm уходит отдельной строкой (w-full), и только
                      с 640 px встаёт обратно в строку. Замер в iframe 375 px: строка
                      журнала — 301 px, слитный статус «500 · повтор через 10 с» забирал
                      113 px, и коду события доставалось 53 px из нужных 92 — на экране
                      висело «stocks_…». Код события — единственное, чем строка отличается
                      от соседней, поэтому ширина достаётся ему, а приписке — вторая
                      строка: терять её совсем нельзя, повторы здесь и показываем. */}
                  {line.retry ? (
                    <>
                      {/* Разделитель нужен, только когда приписка стоит в одной строке
                          со статусом; во второй строке точка в начале читается мусором. */}
                      <span className="hidden shrink-0 text-code-muted sm:inline" aria-hidden>
                        {META_SEP.trim()}
                      </span>
                      <span className={cn('w-full shrink-0 text-right sm:w-auto', tone)}>
                        {line.retry}
                      </span>
                    </>
                  ) : null}
                </p>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
