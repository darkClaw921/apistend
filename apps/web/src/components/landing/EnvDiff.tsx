import { Braces, FileCode, KeyRound, RotateCcw, type LucideIcon } from 'lucide-react'
import { cn } from '@apistend/ui'
import type { ServiceSummary } from '@/lib/types'

/**
 * Секция «Переключение»: слева — что меняется в проекте, справа — дифф файла .env.
 * Макет: «Section Env Diff» в APIStend.pen.
 *
 * Дифф собирается из пропса `services`, а не из вёрстки. В макете нарисованы адреса
 * ozon.mock.apistend.dev / wb.mock.apistend.dev / b24.mock.apistend.dev — поддоменов
 * с чужими марками у продукта нет и не будет: адресация путевая, готовый адрес
 * приходит в service.mockBaseUrl. Минус-строка — service.replacesUrl.
 */

type DiffLine =
  | { kind: 'context' | 'del' | 'add'; text: string }
  | { kind: 'gap' }

/**
 * Имена переменных окружения взяты из макета: так их называют в проектах,
 * которые подключают эти API. Данными они не приходят, поэтому — таблица по коду
 * сервиса с запасным вариантом из shortCode на случай нового сервиса в каталоге.
 */
const ENV_NAMES: Record<string, string> = {
  bitrix24: 'B24_REST_URL',
  ozon: 'OZON_API_URL',
  wildberries: 'WB_API_URL',
}

/**
 * replacesUrl хранится хостом без схемы (`api-seller.ozon.ru`), а mockBaseUrl —
 * готовым адресом со схемой. В .env строки должны выглядеть одинаково, поэтому
 * недостающую схему дописываем — это форматирование, а не новый адрес.
 */
function withScheme(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

const LINE_STYLE = {
  context: 'text-code-muted',
  del: 'bg-night-danger-bg text-night-danger',
  add: 'bg-night-ok-bg text-code-string',
} as const

export function EnvDiff({ services }: { services: ServiceSummary[] }) {
  // API недоступен — рисовать дифф не из чего: адреса выдумывать нельзя, а пустая
  // рамка с шапкой «.env» ничего не объясняет. Секция просто не показывается.
  if (services.length === 0) return null

  const lines: DiffLine[] = []
  for (const [index, service] of services.entries()) {
    if (index > 0) lines.push({ kind: 'gap' })
    const name = ENV_NAMES[service.code] ?? `${service.shortCode.toUpperCase()}_API_URL`
    lines.push({ kind: 'context', text: `# ${service.title}` })
    lines.push({ kind: 'del', text: `- ${name}=${withScheme(service.replacesUrl)}` })
    lines.push({ kind: 'add', text: `+ ${name}=${service.mockBaseUrl}` })
  }
  lines.push({ kind: 'gap' })
  // Ключ песочницы не меняется при переключении — показываем его как неизменённую
  // строку. Тело ключа не выдумываем: stend_sbx_ — настоящий префикс (apps/api/src/lib/keys.ts).
  lines.push({ kind: 'context', text: 'API_KEY=stend_sbx_…' })

  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length

  const points: Array<{ Icon: LucideIcon; text: string; sub?: Array<{ code: string; text: string }> }> = [
    {
      Icon: RotateCcw,
      text: 'Возврат на боевой — обратной заменой, без релиза',
    },
    {
      // В макете здесь «Заголовок авторизации тот же: X-Mock-Key вместо боевого токена».
      // Это неточно: шлюз принимает и наш X-Mock-Key, и родную авторизацию сервиса —
      // именно поэтому клиентскую библиотеку не приходится править. Подробности берём
      // из service.nativeAuth, а не из памяти.
      Icon: KeyRound,
      text: 'Авторизация не переписывается: шлюз принимает и заголовок X-Mock-Key, и родной способ сервиса',
      sub: services.map((s) => ({ code: s.shortCode, text: s.nativeAuth })),
    },
    {
      Icon: Braces,
      text: 'Схема ответа совпадает — типы и парсеры не переписываются',
    },
  ]

  return (
    <section className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[40px] lg:flex-row lg:items-center lg:gap-[56px]">
        <div className="flex flex-col gap-[20px] lg:w-[520px] lg:shrink-0">
          <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent">ПЕРЕКЛЮЧЕНИЕ</p>

          <h2 className="text-[30px] leading-[36px] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
            Одна замена в .env — и весь код ходит в песочницу
          </h2>

          <p className="text-[16px] leading-[26px] text-nav-text">
            Не нужно форковать клиент, писать заглушки и разводить в коде if (isTest).
            Меняется только базовый адрес — сигнатуры, заголовки и схемы ответов остаются прежними.
          </p>

          <ul className="flex flex-col gap-[12px] pt-[4px]">
            {points.map(({ Icon, text, sub }) => (
              <li key={text} className="flex items-start gap-[12px]">
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-night-accent-bg">
                  <Icon size={14} className="text-night-accent" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-[20px] text-nav-text">{text}</p>
                  {sub ? (
                    <ul className="mt-[6px] flex flex-col gap-[4px]">
                      {sub.map((row) => (
                        <li key={row.code} className="text-[12px] leading-[17px] text-code-muted">
                          <span className="font-mono text-night-dim">{row.code}</span> — {row.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0 flex-1 overflow-hidden rounded-[14px] border border-nav-border bg-code-bg">
          <div className="flex items-center gap-[10px] border-b border-nav-border bg-code-surface px-[16px] py-[13px]">
            <FileCode size={14} className="shrink-0 text-code-muted" aria-hidden />
            <span className="flex-1 font-mono text-[12px] font-semibold text-code-text">.env</span>
            {/* Счётчик — из фактического числа строк диффа, а не константа из макета. */}
            <span className="font-mono text-[11px] font-bold text-code-string">+{added}</span>
            <span className="font-mono text-[11px] font-bold text-night-danger">−{removed}</span>
          </div>

          {/* Строки .env длинные и переносить их нельзя — иначе дифф читается неверно.
              Поэтому блок прокручивается по горизонтали внутри себя: min-w-max держит
              фон строки на всю ширину самой длинной, а страница скролл не получает. */}
          <div className="scrollbar-thin overflow-x-auto py-[14px]">
            <div className="min-w-max">
              {lines.map((line, i) =>
                line.kind === 'gap' ? (
                  <div key={`gap-${i}`} className="h-[8px]" aria-hidden />
                ) : (
                  <div
                    key={`${line.kind}-${i}`}
                    className={cn(
                      'px-[16px] py-[4px] font-mono text-[12px] leading-[16px] whitespace-pre',
                      LINE_STYLE[line.kind],
                    )}
                  >
                    {line.text}
                  </div>
                ),
              )}
            </div>
          </div>

          {/* В макете здесь нижняя строка «$ apistend env --write — заменит адреса сам».
              Такой команды у CLI нет (есть listen, login, logout, whoami, status, trigger),
              а придумывать замену ради заполнения места нельзя — строка убрана целиком. */}
        </div>
      </div>
    </section>
  )
}
