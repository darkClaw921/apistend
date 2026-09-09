import Link from 'next/link'
import type { Route } from 'next'
import { GitBranch, Package, PlugZap, type LucideIcon } from 'lucide-react'
import { FooterStatus } from './FooterStatus'

/**
 * Футер лендинга. Макет: «Footer» в APIStend.pen (экспорт 16_Footer.html).
 *
 * Раскладка перенесена как в макете: слева бренд с описанием и кнопками-иконками,
 * справа колонки ссылок, внизу отбивка со статусом и копирайтом. Изменён состав:
 * в макете пять колонок и восемнадцать пунктов, из которых существуют единицы —
 * «Дорожная карта», «Блог», «Контакты», «Оферта», «Справочник ошибок», «Статус
 * сервиса» и четыре правовые страницы не существуют ни как страница, ни как файл
 * в репозитории. Мёртвый пункт в футере хуже отсутствующего, поэтому колонки
 * собраны заново из настоящих адресов: якорей этой страницы, каталога методов
 * и файлов репозитория. Осталось три колонки — сетка разложена под три, а не
 * добита заглушками до пяти.
 *
 * Якоря секций записаны от корня («/#features»), одной формой с шапкой. Шапке
 * корень нужен всерьёз: LandingNav рисуется гостю ещё и на /catalog (CatalogShell),
 * где ни одной из этих секций нет и голый «#features» никуда не вёл. Сам футер
 * сегодня стоит только на лендинге ((marketing)/page.tsx), но запись держим ту же,
 * чтобы пункт, перенесённый отсюда в шапку, не начал молча вести в никуда.
 * На лендинге такой адрес для браузера — тот же документ: просто прокрутка
 * к секции, без перезагрузки.
 */

const GITHUB = 'https://github.com/darkClaw921/apistend'
const NPM = 'https://www.npmjs.com/package/apistend'

type FooterLinkItem = { label: string; href: string; external?: boolean }

/* Проверено: examples/ и LICENSE на месте в репозитории, а каждый адрес /docs/…
   ниже отвечает страницей из src/content/docs — ни одна ссылка не ведёт в никуда. */
const FOOTER_COLUMNS: ReadonlyArray<{ title: string; links: ReadonlyArray<FooterLinkItem> }> = [
  {
    title: 'Продукт',
    links: [
      { label: 'Сервисы', href: '/#services' },
      { label: 'Возможности', href: '/#features' },
      { label: 'Вебхуки', href: '/#webhooks' },
      { label: 'Каталог методов', href: '/catalog' },
      { label: 'Цены', href: '/#pricing' },
    ],
  },
  {
    title: 'Разработчикам',
    links: [
      /* Пункт вёл в /tree/main/docs, где справочника не было. Теперь раздел
         документации есть на самом сайте — /docs, — и три пункта ниже ведут
         в его страницы, а не в markdown на GitHub. */
      { label: 'Документация', href: '/docs' },
      { label: 'Быстрый старт', href: '/docs/nachalo/bystryj-start' },
      { label: 'Локальные приложения Bitrix24', href: '/docs/bitrix24/lokalnye-prilozheniya' },
      /* Пункт макета «CLI и агент»: пакет apistend — это и есть CLI с командой
         listen, но описан он теперь у нас, а не только в карточке npm. */
      { label: 'CLI apistend', href: '/docs/sobytiya/cli' },
      { label: 'Примеры интеграций', href: `${GITHUB}/tree/main/examples`, external: true },
    ],
  },
  {
    title: 'Проект',
    links: [
      { label: 'О проекте', href: `${GITHUB}#readme`, external: true },
      { label: 'Исходный код', href: GITHUB, external: true },
      /* Замена «Контактов» из макета: формы обратной связи нет, обсуждения идут
         в трекере — туда же ведёт кнопка «Поговорить с командой» в CTA. */
      { label: 'Задачи и обсуждения', href: `${GITHUB}/issues`, external: true },
      { label: 'Лицензия MIT', href: `${GITHUB}/blob/main/LICENSE`, external: true },
    ],
  },
]

/**
 * Кнопки-иконки. В макете их три (github, send, youtube), но канала в Telegram
 * и на YouTube у проекта нет — оставлены две с настоящими адресами.
 * Брендовых иконок в lucide 1.x больше нет, поэтому берём ближайшие по смыслу,
 * как уже сделано в Compatible.
 */
const SOCIALS: ReadonlyArray<{ label: string; href: string; Icon: LucideIcon }> = [
  { label: 'Исходный код на GitHub', href: GITHUB, Icon: GitBranch },
  { label: 'Пакет apistend в npm', href: NPM, Icon: Package },
]

export function LandingFooter() {
  return (
    <footer className="border-t border-night-3 bg-night px-[20px] pt-[56px] pb-[32px] md:px-[80px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[40px]">
        {/* До lg бренд стоит над колонками, а не слева от них. На 768 строка футера
            даёт 608 px: 280 px бренда и отбивка 40 оставляли трём колонкам по 83 px,
            а одному заголовку «Разработчикам» нужен 101 — колонки налезали друг
            на друга. Во всю ширину те же три колонки получают по 189 px. */}
        <div className="flex flex-col gap-[32px] lg:flex-row lg:gap-[40px]">
          <div className="flex flex-col items-start gap-[14px] lg:w-[280px] lg:shrink-0">
            <Link href="/" className="flex items-center gap-[10px]">
              <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] bg-accent">
                <PlugZap size={16} className="text-white" aria-hidden />
              </span>
              <span className="text-[16px] font-bold tracking-[-0.3px] text-white">APIStend</span>
            </Link>

            <p className="text-[13px] leading-[21px] text-nav-text">
              Демо-копии российских API для разработки и тестирования интеграций.
            </p>

            <ul className="flex items-center gap-[8px] pt-[6px]">
              {SOCIALS.map(({ label, href, Icon }) => (
                <li key={label}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={label}
                    title={label}
                    /* В экспорте радиус 8 px, но в проекте шкала 6/10/14/20 — ближайший. */
                    className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-code-surface text-nav-text transition-colors hover:text-white"
                  >
                    <Icon size={15} aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Три колонки вместо пяти: на телефоне — две, дальше все три в строку. */}
          <nav
            aria-label="Разделы сайта"
            className="grid flex-1 grid-cols-2 gap-x-[20px] gap-y-[32px] sm:grid-cols-3"
          >
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title} className="flex flex-col items-start gap-[12px]">
                <p className="text-[13px] font-semibold text-white">{col.title}</p>
                <ul className="flex flex-col gap-[12px]">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <FooterLink {...link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        {/*
          Отбивка. В макете справа стоят «Политика конфиденциальности» и «Условия
          использования» — таких страниц нет, обе ссылки убраны. Копирайт занял
          освободившееся место справа; текст оговорки о товарных знаках взят
          дословно из текущего лендинга — он юридически выверен.
        */}
        <div className="flex flex-col gap-[16px] border-t border-night-line pt-[24px] md:flex-row md:items-center md:justify-between md:gap-[24px]">
          <FooterStatus />
          <p className="text-[12px] leading-[1.6] text-code-muted md:max-w-[860px] md:text-right">
            © 2026 APIStend. Демо-копии не связаны с ООО «1С-Битрикс», ООО «Интернет Решения» (Ozon)
            и ООО «Вайлдберриз». Названия и товарные знаки принадлежат правообладателям
            и используются исключительно для указания совместимости.
          </p>
        </div>
      </div>
    </footer>
  )
}

const LINK_CLASS = 'text-[13px] text-nav-text transition-colors hover:text-white'

function FooterLink({ label, href, external }: FooterLinkItem) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {label}
      </a>
    )
  }
  // Якорь лендинга — обычной ссылкой: работает и до гидратации, а Link на
  // «/#features» затеял бы клиентский переход вместо прокрутки к фрагменту.
  if (href.startsWith('#') || href.startsWith('/#')) {
    return <a href={href} className={LINK_CLASS}>{label}</a>
  }
  // typedRoutes проверяет только литералы, а href здесь приходит из массива —
  // приведение типа тут предписано документацией Next.
  return <Link href={href as Route} className={LINK_CLASS}>{label}</Link>
}
