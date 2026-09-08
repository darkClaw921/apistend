import Link from 'next/link'
import { Check, CircleDashed, Zap } from 'lucide-react'

/**
 * Секция «Цены». Макет — 13_Section_Pricing.
 *
 * Раскладка макета сохранена целиком: заголовок, плашка беты, два столбца
 * 480 + 24 + 480, акцентная рамка у правой карточки, кнопка на /register
 * и «Текущий тариф» у левой. Переписано содержание, потому что в макете
 * оно описывает продукт, которого нет:
 *
 * - «SSO и роли в команде», «SLA 99,9 % и выделенный менеджер», «Запись и
 *   повтор ответов боевого API» и подзаголовок про SSO, закрытый контур и SLA.
 *   Ролей и SSO нет в schema.prisma, экран «Команда» — заглушка ComingSoon,
 *   в боевой API шлюз не ходит вовсе (записывать нечего), обязательств по SLA
 *   никто не брал. Соседняя секция Trust.tsx убрала ровно эти пункты как
 *   недоказуемые — держать их через экран друг от друга нельзя.
 * - «Логи за 24 часа» у Free против «30 дней» у Pro. Ретеншен один на всех:
 *   apps/api/src/lib/retention.ts, 30 дней по умолчанию, /health отдаёт
 *   retention.retentionDays. Разного срока по тарифам в коде нет.
 * - «Одна песочница и один ключ» против «неограниченных». Ключей уже сейчас
 *   можно завести сколько угодно (apps/api/src/routes/keys.ts, лимита нет),
 *   а песочница ровно одна у любого аккаунта — сайдбар так и пишет.
 * - «990 ₽/мес» зачёркнутой ценой и бейдж «Популярный». Цену никто не
 *   назначал, биллинга в репозитории нет, а «популярный» — статистика,
 *   которой у нас не существует.
 * - «Сценарии симуляции и повторы событий» и «Установка в закрытый контур»
 *   стояли в платном списке, хотя доступны всем прямо сейчас: сценарии —
 *   apps/api/src/routes/webhooks.ts и панель на экране «Вебхуки», установка
 *   к себе — MIT и docker-compose.yml.
 * - «Без лимита на количество запросов». Лимиты как раз есть и применяются:
 *   apps/api/src/lib/rate-limit.ts, шлюз отдаёт 429/503 и заголовки
 *   x-ratelimit-*, и соседние секции про это прямо пишут. Правда в другом —
 *   у нас нет квот и счёта за объём (auth.ts отдаёт usage.hasLimits: false).
 *
 * Главная правка — устройство секции. Разделения Free/Pro в продукте сегодня
 * нет: проверки тарифа нет ни в одном маршруте, planLabel в базе — подпись
 * под именем в сайдбаре, а не право доступа. Поэтому два столбца больше
 * не «дешевле/дороже», а «что уже работает» и «чего ещё нет». Правый список
 * намеренно не галочки, а пунктирные кружки CircleDashed — тот же знак, каким
 * кабинет помечает несобранные экраны (ComingSoon.tsx): галочка читалась бы
 * как «это есть и входит в тариф». У каждого пункта справа стоит источник —
 * так же, как в карточках Trust.tsx, чтобы список нельзя было принять за
 * роадмап, придуманный на лендинге.
 *
 * Подписи столбцов «FREE» и «PRO» из макета заменены на «Сейчас» и «Позже»:
 * оставить их, объясняя тут же, что тарифов нет, значило бы спорить с самим
 * собой в двух строках друг от друга.
 *
 * Тексты написаны для посетителя, а не для ревьюера: обоснования вида
 * «planLabel в базе» и «/health отдаёт retention.retentionDays» живут здесь,
 * в комментарии, и в самой секции им не место — читателю лендинга наши имена
 * колонок ничего не говорят.
 *
 * Заголовок «Простые цены.» из макета оставлен: цена сейчас действительно
 * одна и она нулевая — это не преувеличение, а буквальное описание.
 * Подпись кнопки «Бесплатно на время беты» заменена на «Создать аккаунт»:
 * про бесплатность говорит плашка беты, а кнопке достаточно назвать действие,
 * которое она выполняет.
 * Пропсов нет, весь текст статичен — компонент серверный.
 */

/** Работает сегодня и одинаково у всех: тариф нигде не проверяется. */
const AVAILABLE_TODAY = [
  'Все демо-API: Bitrix24, Ozon Seller API, Wildberries',
  'Каталог методов и консоль запросов',
  'Вебхуки на localhost через apistend listen',
  'Сценарии симуляции и повторы доставок',
  'Ключей сколько нужно — лимита на количество нет',
  'Журнал запросов 30 дней — один срок на все аккаунты',
  'Ни квот, ни счёта за объём: лимиты в ответах эмулируют боевые',
  'Установка к себе: MIT и docker-compose.yml',
] as const

/** Чего ещё нет. Каждый пункт — то, что репозиторий и сам кабинет уже говорят
 *  о себе; ничего сверх этого сюда дописывать нельзя. */
const NOT_BUILT_YET: readonly { text: string; source: string }[] = [
  {
    text: 'Команда: приглашения, роли и ключ на каждого разработчика',
    source: 'экран «Команда» в кабинете помечен как несобранный',
  },
  {
    text: 'Вторая песочница на аккаунт',
    source: 'сейчас песочница ровно одна — у всех без исключения',
  },
  {
    text: 'Свой срок хранения журнала',
    source: 'сейчас 30 дней, одинаково для всех',
  },
]

export function PricingCards() {
  return (
    <section
      id="pricing"
      className="bg-night px-[20px] py-[64px] md:px-[80px] md:pt-[96px] md:pb-[104px]"
    >
      <div className="mx-auto flex max-w-[1280px] flex-col items-center">
        <h2 className="max-w-[900px] text-center text-[40px] leading-[46px] font-bold tracking-[-1.6px] text-white md:text-[56px] md:leading-[62px] md:tracking-[-2px]">
          Простые цены.
        </h2>
        <p className="mt-[16px] max-w-[640px] text-center text-[16px] leading-[26px] text-nav-text md:text-[17px] md:leading-[27px]">
          Точнее — цена пока одна и она нулевая. Тарифов в продукте нет, доступ
          у всех аккаунтов одинаковый.
        </p>

        {/* Плашка беты: рамки такого синего (#2C3A63) в наборе токенов нет —
            берём акцент с прозрачностью, фон и текст по токенам. Радиус 20 px
            вместо 24 px из макета: проект держит радиусы на шкале 6/10/14/20.
            Текст был «всем аккаунтам тариф Pro бесплатно» — тарифа Pro не
            существует, поэтому говорим то, что проверяется в коде. */}
        <p className="mt-[26px] flex items-center gap-[9px] rounded-[20px] border border-accent/40 bg-night-accent-bg px-[18px] py-[10px] text-[13px] leading-[18px] font-medium text-night-accent-2 md:text-[14px]">
          <Zap size={15} className="shrink-0" aria-hidden />
          Бета: платить не за что — карта не нужна и нигде не спрашивается
        </p>

        {/* 480 + 24 + 480 из макета. Ниже md карточки идут одна под другой. */}
        <div className="mt-[48px] grid w-full max-w-[984px] gap-[24px] md:grid-cols-2">
          <article className="flex flex-col rounded-[14px] border border-nav-border bg-night-2 p-[24px] md:p-[32px]">
            <p className="text-[12px] font-bold tracking-[1.4px] text-night-dim">СЕЙЧАС</p>

            <p className="mt-[14px] flex flex-wrap items-end gap-[8px]">
              <span className="text-[38px] leading-[42px] font-bold tracking-[-1.6px] text-white md:text-[44px] md:leading-[48px]">
                0 ₽
              </span>
              <span className="pb-[5px] text-[14px] text-night-dim">в месяц</span>
            </p>

            <p className="mt-[16px] text-[14px] leading-[22px] text-nav-text">
              Всё, что перечислено ниже, доступно любому аккаунту сразу после регистрации.
              Платного доступа, который дал бы больше, сейчас не существует.
            </p>

            {/* flex-1 у списка вместо фиксированных 548 px высоты карточки:
                на узком экране список выше, а нижняя строка всё равно должна
                стоять у края карточки. */}
            <ul className="mt-[26px] flex flex-1 flex-col gap-[14px]">
              {AVAILABLE_TODAY.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-[12px] text-[14px] leading-[20px] text-night-text"
                >
                  <Check size={16} className="mt-[2px] shrink-0 text-night-ok" aria-hidden />
                  {f}
                </li>
              ))}
            </ul>

            {/* Было похоже на вторую кнопку: рамка, заливка, радиус, полужирный
                текст по центру — люди в такое жмут, а жать тут нечего. Теперь это
                подпись под чертой: ни фона, ни рамки, ни радиуса, обычный кегль
                приглушённым цветом — состояние, а не элемент управления. */}
            <p className="mt-[28px] flex items-center justify-center gap-[8px] border-t border-night-line pt-[20px] text-[13px] leading-[18px] text-night-dim">
              <Check size={15} className="shrink-0 text-night-ok" aria-hidden />
              Текущий тариф — он единственный
            </p>
          </article>

          {/* Акцентная рамка макета осталась на правой карточке: единственное
              действие секции — регистрация — по-прежнему здесь. */}
          <article className="flex flex-col rounded-[14px] border-2 border-accent bg-night-2 p-[24px] md:p-[32px]">
            <p className="text-[12px] font-bold tracking-[1.4px] text-night-accent">ПОЗЖЕ</p>

            <p className="mt-[14px] flex flex-wrap items-end gap-[10px]">
              <span className="text-[38px] leading-[42px] font-bold tracking-[-1.6px] text-white md:text-[44px] md:leading-[48px]">
                Цены нет
              </span>
              <span className="pb-[5px] text-[14px] text-nav-text">пока нечего продавать</span>
            </p>

            <p className="mt-[16px] text-[14px] leading-[22px] text-nav-text">
              Платным станет то, чего сегодня в продукте нет. Ниже — не список возможностей,
              а список пропусков: этого пока нельзя ни купить, ни получить бесплатно.
            </p>

            <ul className="mt-[26px] flex flex-1 flex-col gap-[16px]">
              {NOT_BUILT_YET.map((item) => (
                <li key={item.text} className="flex items-start gap-[12px]">
                  <CircleDashed size={16} className="mt-[2px] shrink-0 text-night-dim" aria-hidden />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="text-[14px] leading-[20px] text-night-text">{item.text}</span>
                    <span className="text-[12px] leading-[16px] text-code-muted">
                      {item.source}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            {/* Заполняет низ карточки не галочками, а объяснением, зачем здесь
                кнопка: список выше — про будущее, а регистрация даёт настоящее.
                Черта та же, что у соседа, — низ карточек читается одинаково. */}
            <p className="mt-[26px] border-t border-night-line pt-[18px] text-[13px] leading-[19px] text-night-dim">
              Регистрация даёт ровно то, что в левом столбце: другого доступа сейчас нет.
            </p>

            <Link
              href="/register"
              className="mt-[28px] block rounded-[6px] bg-accent px-[20px] py-[14px] text-center text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Создать аккаунт
            </Link>
          </article>
        </div>

        {/* В макете здесь было «останется бесплатным навсегда» и обещание
            предупредить за 30 дней — обязательства, которые никто не брал
            и которые нечем подтвердить. Заменено на проверяемое. */}
        <p className="mt-[28px] max-w-[720px] text-center text-[13px] leading-[20px] text-night-dim">
          Появится платное — на этом месте появится цена. Пока её нет, правый столбец
          честнее читать как «чего ждать», а не как «что вы купите».
        </p>
      </div>
    </section>
  )
}
