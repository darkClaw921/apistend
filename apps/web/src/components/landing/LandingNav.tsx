import Link from 'next/link'
import { PlugZap } from 'lucide-react'
import { LandingNavMobile } from './LandingNavMobile'

/**
 * Шапка лендинга. Макет: секция «Nav» в APIStend.pen (экспорт 00_Nav.html).
 *
 * Лендинг перерисован целиком тёмным, поэтому фон шапки теперь тот же, что
 * у секций, — bg-night. Раньше стоял bg-nav-bg от старой схемы «светлый лендинг
 * с тёмной шапкой»: на новом фоне он давал заметную ступеньку на границе с hero.
 *
 * Пункты — настоящие ссылки, как и требует макет. Те, что ведут к секциям этой же
 * страницы, — обычные якоря, а не Link: якорь работает и до гидратации, и при
 * отключённом JS. «Документация» раньше уходила в каталог методов, потому что
 * страницы документации не существовало; теперь она есть — /docs, — и пункт ведёт
 * туда, где написано, как стендом пользоваться. Каталог методов остался доступен
 * из футера и с первой же страницы документации. Состав и порядок пунктов
 * совпадают с макетом, новых в нём не появилось.
 *
 * Якоря записаны от корня («/#features»), а не голым фрагментом. Причина: эта
 * шапка рисуется не только на лендинге — CatalogShell показывает её гостю на
 * /catalog, где секций «Возможности», «Сервисы», «Вебхуки» и «Цены» нет вовсе,
 * и голый «#features» там оставлял бы гостя на месте, только меняя адрес.
 * Адрес с корнем на самом лендинге браузер видит как тот же документ и просто
 * прокручивает к секции (без перезагрузки), а из каталога уводит на лендинг
 * и прокручивает там.
 */
const NAV_LINKS = [
  { label: 'Возможности', href: '/#features' },
  { label: 'Сервисы', href: '/#services' },
  { label: 'Вебхуки', href: '/#webhooks' },
  { label: 'Документация', href: '/docs' },
  { label: 'Цены', href: '/#pricing' },
] as const

const LINK_CLASS = 'text-[14px] font-medium text-nav-text transition-colors hover:text-white'

/**
 * Ссылка на секцию этой же страницы: и голый фрагмент, и адрес с корнем.
 * Такие ведём обычным <a>: Link на «/#features» с лендинга затеял бы
 * клиентский переход по маршруту вместо простой прокрутки к фрагменту.
 */
function isLandingAnchor(href: string) {
  return href.startsWith('#') || href.startsWith('/#')
}

export function LandingNav() {
  return (
    /*
      Внешний блок держит фон во всю ширину, внутренний — контентную колонку 1280:
      макет нарисован на 1440 с полями 80, то есть 1280 содержимого.

      Высота 77 задана числом, а не вертикальным padding'ом: в макете это
      20 + 37 + 20, где 37 — кнопка (10 + строка 14/normal + 10). У нас базовый
      line-height 1.5, поэтому те же 20px padding'а дали бы 81.
    */
    <nav aria-label="Разделы лендинга" className="bg-night px-[20px] md:px-[80px]">
      <div className="mx-auto flex h-[77px] max-w-[1280px] items-center justify-between gap-[20px]">
        {/* Логотип и пункты в макете — одна группа с отступом 40 между ними. */}
        <div className="flex min-w-0 items-center gap-[24px] lg:gap-[40px]">
          <Link href="/" className="flex shrink-0 items-center gap-[10px]">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-accent">
              <PlugZap size={17} className="text-white" aria-hidden />
            </span>
            <span className="text-[17px] font-bold tracking-[-0.3px] text-white">APIStend</span>
          </Link>

          <ul className="hidden items-center gap-[28px] lg:flex">
            {NAV_LINKS.map((item) => (
              <li key={item.label}>
                {isLandingAnchor(item.href) ? (
                  <a href={item.href} className={LINK_CLASS}>{item.label}</a>
                ) : (
                  <Link href={item.href} className={LINK_CLASS}>{item.label}</Link>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/*
          До lg пять пунктов и две кнопки в строку не помещаются, а в макете узкой
          раскладки шапки нет. Уводим разделы под кнопку — иначе на телефоне
          попасть в них нечем.
        */}
        <LandingNavMobile links={NAV_LINKS} />

        <div className="hidden items-center gap-[16px] lg:flex">
          {/* «Войти» в новом макете белый, а не приглушённый: это вторая точка входа. */}
          <Link
            href="/login"
            className="shrink-0 text-[14px] font-medium text-white transition-colors hover:text-night-text"
          >
            Войти
          </Link>
          <Link
            href="/register"
            className="shrink-0 rounded-[6px] bg-accent px-[18px] py-[10px] text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            Начать бесплатно
          </Link>
        </div>
      </div>
    </nav>
  )
}
