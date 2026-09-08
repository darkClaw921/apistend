import { Braces, Database, KeyRound, ScrollText, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Секция «Возможности». Макет: «Section Features» в APIStend.pen.
 *
 * Композиция макета: центрированная шапка, затем ряд из двух карточек разной
 * ширины (широкая «Ответы» + узкая «Ошибки» на 420 px) и ряд из трёх равных.
 * Пропсов нет: секция ничего не считает и ничего не запрашивает — весь её текст
 * статичен, поэтому компонент серверный.
 */

/** Строка сравнения ответов. Один массив на оба блока — в этом и смысл карточки:
 *  боевой сервис и мок отдают буквально одно и то же, расхождение было бы багом. */
const COMPARE_LINES = [
  { key: '"posting_number"', value: '"0193-1"' },
  { key: '"status"', value: '"awaiting_packaging"' },
  { key: '"in_process_at"', value: '"2026-09-08T…"' },
] as const

/** Ошибки, которые умеет отдавать мок по требованию. Цвет — по тяжести сбоя. */
const ERROR_ROWS = [
  { code: '401', label: 'Неверный токен', rowBg: 'bg-night-danger-bg', tint: 'text-night-danger' },
  { code: '429', label: 'Превышен лимит', rowBg: 'bg-night-warn-bg', tint: 'text-night-warn' },
  { code: '500', label: 'Ошибка сервиса', rowBg: 'bg-night-danger-bg', tint: 'text-night-danger' },
  // Таймаут — не ошибка сервиса, поэтому строка нейтральная, без цвета тяжести.
  { code: 'timeout', label: 'Ответ дольше 30 с', rowBg: 'bg-code-surface', tint: 'text-nav-text' },
] as const

const SMALL_FEATURES = [
  {
    icon: Database,
    // Голубого тона иконки из макета в тёмном слое токенов нет,
    // поэтому взят акцентный — единственный синий в наборе.
    box: 'bg-night-accent-bg',
    tint: 'text-night-accent',
    title: 'Демо-данные, которые не меняются',
    // В макете здесь стояло «1 240 сделок, 3 480 товаров и 890 заказов». Таких чисел
    // в системе нет: объём набора задаётся солью детерминированного генератора,
    // а не фиксированным количеством записей. Оставлена суть — воспроизводимость.
    desc: 'Один и тот же запрос всегда даёт один и тот же ответ: снимки экранов и контрактные тесты не «плывут». Сброс — одной кнопкой.',
  },
  {
    icon: ScrollText,
    box: 'bg-night-ok-bg',
    tint: 'text-night-ok',
    title: 'Логи каждого запроса',
    desc: 'Тело запроса, ответ, задержка и ключ. Видно, что именно отправила ваша интеграция и почему получила 400.',
  },
  {
    icon: KeyRound,
    box: 'bg-night-warn-bg',
    tint: 'text-code-number',
    title: 'Ключи и доступ команды',
    desc: 'Отдельный ключ для CI, QA и каждого разработчика. Права, срок жизни и мгновенный отзыв доступа.',
  },
] as const

export function Features() {
  return (
    <section id="features" className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[40px]">
        <header className="flex flex-col items-center gap-[14px] text-center">
          <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent">ВОЗМОЖНОСТИ</p>
          <h2 className="max-w-[900px] text-[28px] leading-[34px] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
            Всё, чего не хватает боевому аккаунту на этапе разработки
          </h2>
          <p className="max-w-[720px] text-[16px] leading-[26px] text-nav-text">
            Песочница ведёт себя как боевой сервис: те же поля, те же сбои, те же лимиты — но
            управляемые вами.
          </p>
        </header>

        {/* Разная ширина карточек нужна только там, где два блока кода помещаются
            рядом. До этого обе идут на всю ширину друг под другом. */}
        <div className="flex flex-col gap-[16px] lg:flex-row lg:items-start">
          <article className="flex flex-1 flex-col gap-[18px] rounded-[14px] border border-night-line bg-night-2 p-[20px] md:p-[24px]">
            <IconBox icon={Braces} box="bg-night-accent-bg" tint="text-night-accent" />
            <h3 className="text-[20px] leading-[26px] font-semibold tracking-[-0.3px] text-white">
              Ответ совпадает с боевым API до последнего поля
            </h3>
            <p className="text-[14px] leading-[22px] text-nav-text">
              Схемы, вложенность, форматы дат, пагинация и пустые значения — как в документации
              сервиса. Код интеграции не придётся переписывать при переходе на продакшен.
            </p>
            <div className="grid gap-[12px] sm:grid-cols-2">
              <ComparePane label="Боевой Ozon" />
              <ComparePane label="APIStend" accent />
            </div>
          </article>

          <article className="flex flex-col gap-[16px] rounded-[14px] border border-night-line bg-night-2 p-[20px] md:p-[24px] lg:w-[420px] lg:shrink-0">
            <IconBox icon={TriangleAlert} box="bg-night-danger-bg" tint="text-night-danger" />
            <h3 className="text-[20px] font-semibold tracking-[-0.3px] text-white">
              Ошибки по требованию
            </h3>
            <p className="text-[14px] leading-[22px] text-nav-text">
              Один переключатель — и метод отдаёт нужный сбой. Проверьте ретраи и обработку лимитов
              до релиза.
            </p>
            <ul className="flex flex-col gap-[8px]">
              {ERROR_ROWS.map((row) => (
                <li
                  key={row.code}
                  className={`flex items-center gap-[10px] rounded-[6px] px-[12px] py-[8px] ${row.rowBg}`}
                >
                  <span
                    className={`w-[56px] shrink-0 font-mono text-[12px] font-bold ${row.tint}`}
                  >
                    {row.code}
                  </span>
                  <span className="text-[13px] text-night-text">{row.label}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>

        <div className="grid gap-[16px] md:grid-cols-3">
          {SMALL_FEATURES.map((f) => (
            <article
              key={f.title}
              className="flex flex-col gap-[12px] rounded-[14px] border border-night-line bg-night-2 p-[20px] md:p-[24px]"
            >
              <IconBox icon={f.icon} box={f.box} tint={f.tint} />
              <h3 className="text-[17px] leading-[22px] font-semibold tracking-[-0.2px] text-white">
                {f.title}
              </h3>
              <p className="text-[14px] leading-[22px] text-nav-text">{f.desc}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

/** Квадрат с иконкой над заголовком карточки. Радиус 10 px вместо 11 px из макета —
 *  проект держит радиусы на шкале 6/10/14/20. */
function IconBox({
  icon: Icon,
  box,
  tint,
}: {
  icon: LucideIcon
  box: string
  tint: string
}) {
  return (
    <span className={`flex h-[40px] w-[40px] items-center justify-center rounded-[10px] ${box}`}>
      <Icon size={20} className={tint} aria-hidden />
    </span>
  )
}

/**
 * Один из двух блоков кода в карточке «Ответы». JSON намеренно одинаковый.
 * `accent` отличает колонку APIStend: синяя точка и акцентная подпись.
 */
function ComparePane({ label, accent = false }: { label: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-[8px] overflow-hidden rounded-[6px] border border-night-3 bg-code-bg p-[14px]">
      <div className="flex items-center gap-[7px]">
        {/* Серый маркер боевого сервиса: точного токена под оттенок из макета
            нет, code-muted — ближайший нейтральный на тёмном. */}
        <span
          className={`h-[6px] w-[6px] shrink-0 rounded-full ${accent ? 'bg-accent' : 'bg-code-muted'}`}
          aria-hidden
        />
        <span
          className={`text-[11px] font-semibold tracking-[0.3px] ${accent ? 'text-night-accent' : 'text-code-muted'}`}
        >
          {label}
        </span>
      </div>
      {/* Строки не переносятся: ломать JSON по словам нечитаемо, поэтому узкий
          экран прокручивает блок, а не страницу. */}
      <div className="overflow-x-auto scrollbar-thin">
        <pre className="font-mono text-[11px] leading-[18px]">
          <code>
            {COMPARE_LINES.map((line, i) => (
              <span key={line.key} className="block whitespace-nowrap">
                <span className="text-code-key">{line.key}</span>
                <span className="text-code-text">: </span>
                <span className="text-code-string">{line.value}</span>
                {i < COMPARE_LINES.length - 1 ? <span className="text-code-text">,</span> : null}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}
