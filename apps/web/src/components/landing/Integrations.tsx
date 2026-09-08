import {
  Boxes,
  Container,
  Database,
  GitBranch,
  GitMerge,
  Hammer,
  MessageCircle,
  Send,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

/**
 * Секция «Интеграции». Макет — 12_Section_Integrations.
 *
 * Главная правка против макета — смысловая. Сетка 3×3 в макете читается как список
 * готовых коннекторов («мы поддерживаем n8n, Make, Jenkins…»), которых у нас нет
 * и не планируется. На самом деле это утверждение о совместимости: песочница —
 * обычный HTTP-адрес с ключом, поэтому её вызывает всё, что умеет HTTP-запрос.
 * Поэтому плитки перенесены как есть, но подпись под сеткой прямо говорит,
 * что отдельных модулей мы не поставляем.
 */

type Tile = {
  readonly label: string
  readonly Icon: LucideIcon
}

/* Иконки взяты из макета один в один, кроме двух первых: в lucide 1.x брендовых
   иконок (github, gitlab) больше нет. Заменены на ближайшие по смыслу git-иконки,
   разные между собой, чтобы соседние плитки не выглядели одинаково. */
const TILES: readonly Tile[] = [
  { label: 'GitHub Actions', Icon: GitBranch },
  { label: 'GitLab CI', Icon: GitMerge },
  { label: 'Docker', Icon: Container },
  { label: 'Postman', Icon: Send },
  { label: 'n8n', Icon: Workflow },
  { label: 'Make', Icon: Boxes },
  { label: '1С', Icon: Database },
  { label: 'Jenkins', Icon: Hammer },
  { label: 'Telegram', Icon: MessageCircle },
]

/* Кнопка «Смотреть интеграции» из макета вела бы на несуществующую страницу.
   Уводим в каталог примеров — там лежит рабочее локальное приложение Bitrix24.
   «Документация CLI» — на npm: README пакета и есть справочник команд,
   в каталоге docs/ лежат только заметки по деплою и локальным приложениям. */
const EXAMPLES_URL = 'https://github.com/darkClaw921/apistend/tree/main/examples'
const CLI_DOCS_URL = 'https://www.npmjs.com/package/apistend'

export function Integrations() {
  return (
    <section id="integrations" className="bg-night px-[20px] py-[88px] md:px-[80px]">
      {/* Ниже lg колонки складываются: текст наверх, сетка под него. */}
      <div className="mx-auto grid max-w-[1280px] items-center gap-[40px] lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-[56px]">
        <div>
          <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent uppercase">
            Интеграции
          </p>
          <h2 className="mt-[20px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
            Встраивается в процесс, который у вас уже есть
          </h2>
          {/* В макете: «Песочница поднимается в CI рядом с тестами». Это обещание
              self-hosted-запуска, которого мы не даём: песочница живёт на нашем
              шлюзе. Переписано в то, что верно на самом деле. */}
          <p className="mt-[20px] text-[16px] leading-[26px] text-nav-text">
            Песочница — это обычный HTTP-адрес с ключом, а агент доставки вебхуков —
            пакет apistend из npm. И то и другое одинаково запускается в CI, в контейнере
            и на ноутбуке; ключ хранится в секретах репозитория.
          </p>

          <div className="mt-[26px] flex flex-wrap gap-[10px]">
            {/* Внешние адреса — обычный <a>: next/link здесь ничего не даёт. */}
            <a
              href={EXAMPLES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-[6px] bg-accent px-[20px] py-[12px] text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Посмотреть рабочий пример
            </a>
            <a
              href={CLI_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-[6px] border border-nav-border px-[20px] py-[12px] text-[14px] font-medium text-white transition-colors hover:bg-night-2"
            >
              Документация CLI
            </a>
          </div>
        </div>

        <div>
          <ul className="grid grid-cols-1 gap-[12px] sm:grid-cols-2 lg:grid-cols-3">
            {TILES.map(({ label, Icon }) => (
              <li
                key={label}
                /* Фиксированные 92 px из макета остаются с двух колонок; в одну
                   колонку девять таких плиток дают лишнюю простыню, поэтому там
                   высота меньше. */
                className="flex min-h-[76px] flex-col items-center justify-center gap-[10px] rounded-[10px] border border-night-line bg-night-2 px-[10px] py-[16px] sm:min-h-[92px]"
              >
                <Icon size={22} className="shrink-0 text-nav-text" aria-hidden />
                <span className="text-center text-[11px] font-medium text-night-dim">{label}</span>
              </li>
            ))}
          </ul>

          {/* Этой строки в макете нет. Без неё сетка читается как список готовых
              коннекторов — а их нет ни одного. */}
          <p className="mt-[14px] text-[12px] leading-[18px] text-code-muted">
            Готовых модулей под эти инструменты мы не поставляем — они и не нужны:
            в каждом меняется базовый адрес и заголовок с ключом.
          </p>
        </div>
      </div>
    </section>
  )
}
