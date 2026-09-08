import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * Финальный призыв. Макет — 15_Section_CTA.
 *
 * «Поговорить с командой» ведёт в трекер: проект открытый, страницы контактов
 * и формы обратной связи нет, а обсуждения идут в issues — так же сделано
 * в текущем лендинге и на экранах входа.
 */

const GITHUB_ISSUES = 'https://github.com/darkClaw921/apistend/issues'

export function FinalCta() {
  return (
    <section className="border-t border-night-3 bg-night px-[20px] py-[88px] text-center md:px-[80px]">
      <h2 className="mx-auto max-w-[920px] text-[32px] leading-[1.15] font-bold tracking-[-1.2px] text-white md:text-[42px] md:leading-[48px]">
        Перестаньте ждать доступ к боевому API
      </h2>
      {/* «За пять секунд» и «сегодня же» из макета убраны: время подъёма песочницы
          мы не замеряли, и замерять там нечего — регистрация одним запросом заводит
          и песочницу, и ключ (apps/api/src/routes/auth.ts), причём сразу на все три
          сервиса (services: ['bitrix24', 'ozon', 'wildberries']), а полный ключ
          возвращается в том же ответе. Это и говорим вместо срока — и другими
          словами, чем первый шаг секции «Как это работает». */}
      <p className="mx-auto mt-[24px] max-w-[640px] text-[16px] leading-[27px] text-nav-text md:text-[17px]">
        Ключ сразу на все три сервиса выдаётся при регистрации. Им же уходит первый
        запрос к Bitrix24, Ozon или Wildberries.
      </p>

      <div className="mt-[24px] flex flex-wrap justify-center gap-[12px]">
        <Link
          href="/register"
          className="inline-flex items-center gap-[8px] rounded-[6px] bg-accent px-[26px] py-[15px] text-[15px] font-semibold text-white transition-colors hover:bg-accent-hover"
        >
          Создать песочницу
          <ArrowRight size={16} aria-hidden />
        </Link>
        {/* Внешняя ссылка — обычный <a>: Link здесь ничего не даёт. */}
        <a
          href={GITHUB_ISSUES}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center rounded-[6px] border border-nav-border px-[24px] py-[14px] text-[15px] font-medium text-white transition-colors hover:bg-night-2"
        >
          Поговорить с командой
        </a>
      </div>

      {/* В макете третий пункт — «данные не покидают ваш контур». На нашем хостинге
          это неправда: контур клиента появляется только при установке к себе.
          Поэтому пункт переписан в то, что действительно есть.

          Второй пункт был «без лимитов на запросы» — тоже неправда: лимиты боевых
          сервисов эмулируются (apps/api/src/lib/rate-limit.ts), и на превышении шлюз
          отдаёт 429/503. Правда в другом: запросы никуда не записываются в счёт,
          квоты на объём нет вовсе — /api/auth/me отдаёт usage.hasLimits: false. */}
      <p className="mx-auto mt-[24px] max-w-[820px] text-[13px] text-night-dim">
        Без карты · без квот на объём запросов · можно поставить в свой контур
      </p>
    </section>
  )
}
