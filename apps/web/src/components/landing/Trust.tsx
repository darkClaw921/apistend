import { Container, FlaskConical, Scale, Server } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Секция «Свой контур». Макет — 14_Section_Trust.
 *
 * Раскладка макета сохранена целиком: заголовок, подзаголовок, две кнопки,
 * ряд чипов и три карточки в ряд. Содержание переписано, потому что в макете
 * оно неправда:
 *
 * - три карточки с отзывами (Илья Королёв, Мария Соколова, Дмитрий Власов) —
 *   выдуманные люди и выдуманные цитаты, публиковать их нельзя;
 * - чипы «152-ФЗ» и «ISO 27001» — сертификации у проекта нет, соответствие
 *   никто не подтверждал;
 * - чип «SSO / SAML», как и SSO с ролями в подзаголовке, — не реализовано;
 * - «SLA 99,9 %» — обязательства с такой цифрой никто не брал;
 * - кнопка «Как устроена безопасность» вела на страницу, которой нет.
 *
 * Вместо этого — то, что проверяется в репозитории: MIT в LICENSE, запуск
 * у себя (docker-compose.yml + быстрый старт в README), синтетические
 * демо-данные вместо боевых (README, раздел «Как собирается ответ мока»).
 * Пропсов нет, весь текст статичен — компонент серверный.
 */

const GITHUB = 'https://github.com/darkClaw921/apistend'
/** Вторая кнопка макета вела в никуда. Ведём в файл, который и поднимает базу
 *  при установке к себе, — он существует и говорит ровно то, что обещает чип. */
const COMPOSE = 'https://github.com/darkClaw921/apistend/blob/main/docker-compose.yml'

const CHIPS: readonly { icon: LucideIcon; label: string }[] = [
  { icon: Scale, label: 'Открытый код, MIT' },
  { icon: Server, label: 'On-premise' },
  { icon: Container, label: 'Docker Compose' },
  { icon: FlaskConical, label: 'Синтетические данные' },
]

/** Три факта на месте трёх отзывов: тот же визуальный вес, но каждое
 *  утверждение проверяется в репозитории. */
const FACTS: readonly { icon: LucideIcon; text: string; label: string; source: string }[] = [
  {
    icon: Scale,
    text: 'Открыт весь продукт, а не демо-часть: мок-шлюз, каталог методов, кабинет и CLI лежат в одном репозитории. Лицензия MIT — можно прочитать, форкнуть и собрать самому.',
    label: 'Лицензия MIT',
    source: 'LICENSE в корне репозитория',
  },
  {
    icon: Server,
    text: 'Ставится на вашу машину или ваш сервер: база поднимается из docker-compose.yml, шлюз и веб запускаются рядом. При установке к себе ключи, журнал запросов и трафик не выходят за периметр.',
    label: 'Установка к себе',
    source: 'быстрый старт — в README',
  },
  {
    icon: FlaskConical,
    text: 'Боевых данных сервисов в системе нет вообще: ответы собираются из официальных спецификаций и детерминированного генератора. Утекать нечему — ни клиентов, ни заказов, ни чужих ключей.',
    label: 'Синтетические демо-данные',
    source: 'источники и даты снимков — NOTICE.md',
  },
]

export function Trust() {
  return (
    <section className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col items-center">
        <h2 className="max-w-[820px] text-center text-[28px] leading-[34px] font-bold tracking-[-0.8px] text-white md:text-[38px] md:leading-[44px] md:tracking-[-1px]">
          Можно поставить в свой контур целиком
        </h2>
        <p className="mt-[14px] max-w-[680px] text-center text-[16px] leading-[26px] text-nav-text">
          Код открыт под MIT, база поднимается из docker-compose.yml, демо-данные синтетические.
          При установке к себе ключи и трафик остаются внутри вашей сети.
        </p>

        {/* Обе кнопки внешние — обычный <a>, Link здесь ничего не даёт.
            Радиус 6 px вместо 8 px из макета: шкала радиусов проекта 6/10/14/20. */}
        <div className="mt-[26px] flex flex-wrap justify-center gap-[10px]">
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-[6px] bg-accent px-[22px] py-[12px] text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            Исходный код
          </a>
          <a
            href={COMPOSE}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-[8px] rounded-[6px] border border-nav-border bg-night-2 px-[21px] py-[11px] text-[14px] font-medium text-white transition-colors hover:bg-night-3"
          >
            Запуск у себя
            <span className="font-mono text-[13px] text-nav-text">docker-compose.yml</span>
          </a>
        </div>

        <ul className="mt-[28px] flex flex-wrap justify-center gap-[10px]">
          {CHIPS.map((chip) => (
            <li
              key={chip.label}
              className="flex items-center gap-[8px] rounded-[20px] border border-night-line bg-night-2 px-[14px] py-[9px] text-[12px] font-medium text-nav-text"
            >
              <chip.icon size={14} className="shrink-0 text-night-dim" aria-hidden />
              {chip.label}
            </li>
          ))}
        </ul>

        <div className="mt-[40px] grid w-full gap-[20px] md:grid-cols-3">
          {FACTS.map((fact) => (
            <article
              key={fact.label}
              className="flex flex-col gap-[18px] rounded-[14px] border border-night-line bg-night-2 p-[24px]"
            >
              {/* flex-1 у текста, чтобы подписи карточек стояли на одной линии
                  при разной длине факта — в макете это давала фиксированная сетка. */}
              <p className="flex-1 text-[14px] leading-[22px] text-white">{fact.text}</p>
              <div className="flex items-center gap-[10px] border-t border-night-line pt-[16px]">
                {/* В макете здесь аватар с инициалами автора отзыва. Автора больше
                    нет, место занимает иконка факта — вес блока сохраняется. */}
                <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[10px] bg-code-surface">
                  <fact.icon size={16} className="text-night-accent" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className="text-[13px] font-semibold text-white">{fact.label}</span>
                  <span className="text-[11px] leading-[15px] text-code-muted">{fact.source}</span>
                </span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
