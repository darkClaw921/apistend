'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { SCENARIOS } from '@apistend/shared'
import type { ServiceSummary } from '@/lib/types'

/**
 * Секция «Ваш стек»: один и тот же запрос на пяти языках — меняется только адрес.
 * Макет: «Section Stack» в APIStend.pen.
 *
 * Клиентская: вкладки и копирование должны работать по-настоящему.
 *
 * Адрес мока в примерах не написан руками: в макете стоит https://api.apistend.ru/ozon,
 * а у продукта адресация путевая (<origin>/oz/…) и готовый адрес приходит
 * в service.mockBaseUrl. Боевой адрес в закомментированной строке — service.replacesUrl.
 */

/** Метод настоящий: POST /v3/posting/fbs/list есть в каталоге Ozon Seller API. */
const OZON_PATH = '/v3/posting/fbs/list'

/**
 * Тело запроса — обязательные поля метода из каталога (filter, limit, offset)
 * плюс необязательный dir. Значения dir по спецификации — asc/desc.
 */
const BODY_JSON = '{"dir":"asc","filter":{},"limit":50,"offset":0}'

interface Snippet {
  id: string
  label: string
  /** base — адрес мока без хвостового слэша, live — боевой адрес сервиса. */
  build: (base: string, live: string) => string
}

const SNIPPETS: readonly Snippet[] = [
  {
    id: 'curl',
    label: 'curl',
    build: (base, live) => `# боевой адрес закомментирован — остальной код не меняется
# BASE=${live}
BASE=${base}

curl -X POST "$BASE${OZON_PATH}" \\
  -H "X-Mock-Key: $APISTEND_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${BODY_JSON}'`,
  },
  {
    id: 'js',
    label: 'JavaScript',
    build: (base, live) => `// боевой адрес закомментирован — остальной код не меняется
// const BASE = '${live}'
const BASE = '${base}'

const res = await fetch(\`\${BASE}${OZON_PATH}\`, {
  method: 'POST',
  headers: {
    'X-Mock-Key': process.env.APISTEND_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ dir: 'asc', filter: {}, limit: 50, offset: 0 }),
})
const data = await res.json()`,
  },
  {
    id: 'python',
    label: 'Python',
    // requests сам ставит Content-Type: application/json, когда тело идёт через json=.
    build: (base, live) => `# боевой адрес закомментирован — остальной код не меняется
# BASE = "${live}"
BASE = "${base}"

r = requests.post(
    f"{BASE}${OZON_PATH}",
    headers={"X-Mock-Key": os.environ["APISTEND_KEY"]},
    json={"dir": "asc", "filter": {}, "limit": 50, "offset": 0},
)
data = r.json()`,
  },
  {
    id: 'php',
    label: 'PHP',
    // Guzzle с опцией json тоже проставляет Content-Type сам.
    // (object) [] нужен, чтобы пустой filter уехал как {}, а не как [].
    build: (base, live) => `// боевой адрес закомментирован — остальной код не меняется
// $base = '${live}';
$base = '${base}';

$client = new GuzzleHttp\\Client();
$res = $client->post($base . '${OZON_PATH}', [
    'headers' => ['X-Mock-Key' => getenv('APISTEND_KEY')],
    'json' => ['dir' => 'asc', 'filter' => (object) [], 'limit' => 50, 'offset' => 0],
]);
$data = json_decode((string) $res->getBody(), true);`,
  },
  {
    id: 'go',
    label: 'Go',
    build: (base, live) => `// боевой адрес закомментирован — остальной код не меняется
// const base = "${live}"
const base = "${base}"

body := []byte(\`${BODY_JSON}\`)
req, _ := http.NewRequest(http.MethodPost, base+"${OZON_PATH}", bytes.NewReader(body))
req.Header.Set("X-Mock-Key", os.Getenv("APISTEND_KEY"))
req.Header.Set("Content-Type", "application/json")

res, err := http.DefaultClient.Do(req)`,
  },
]

/** Инструменты, которым хватает обычного HTTP: ни SDK, ни плагина не нужно. */
const TOOLS = ['Postman', 'Insomnia', 'Bruno', 'axios', 'requests', 'Guzzle', 'k6', 'Newman']

type Tone = 'text' | 'string' | 'number' | 'key' | 'comment'

const TONE_CLASS: Record<Tone, string> = {
  text: 'text-code-text',
  string: 'text-code-string',
  number: 'text-code-number',
  key: 'text-code-key',
  comment: 'text-code-muted',
}

/**
 * Раскраска примеров. Разбирать пять языков по-настоящему тут незачем:
 * в сниппетах есть только комментарии, строки, числа и десяток ключевых слов.
 * Источник правды — сама строка кода, поэтому в буфер уходит ровно то, что видно.
 */
const TOKEN_RE =
  /('[^']*'|"[^"]*"|`[^`]*`|https?:\/\/[^\s"'`]+)|(\b\d+\b)|(\B-[A-Za-z]\b|\b(?:curl|const|await|fetch|new|import|requests|json_decode|getenv|http|bytes|os|JSON|process)\b)/g

function tokenize(line: string): Array<{ tone: Tone; text: string }> {
  if (/^\s*(#|\/\/)/.test(line)) return [{ tone: 'comment', text: line }]

  const parts: Array<{ tone: Tone; text: string }> = []
  let cursor = 0
  for (const match of line.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0
    if (start > cursor) parts.push({ tone: 'text', text: line.slice(cursor, start) })
    const tone: Tone = match[1] ? 'string' : match[2] ? 'number' : 'key'
    parts.push({ tone, text: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < line.length) parts.push({ tone: 'text', text: line.slice(cursor) })
  return parts
}

/** replacesUrl приходит хостом без схемы — дописываем её, это форматирование, а не новый адрес. */
function withScheme(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

export function StackTabs({ services }: { services: ServiceSummary[] }) {
  const [activeId, setActiveId] = useState(SNIPPETS[0]?.id ?? 'curl')
  const [copied, setCopied] = useState(false)

  // Примеры написаны на методе Ozon, поэтому и адрес нужен именно этого сервиса:
  // подставить чужой mockBaseUrl к пути /v3/posting/fbs/list — получить нерабочий вызов.
  const ozon = services.find((s) => s.code === 'ozon')

  const code = useMemo(() => {
    if (!ozon) return ''
    const snippet = SNIPPETS.find((s) => s.id === activeId) ?? SNIPPETS[0]
    if (!snippet) return ''
    return snippet.build(ozon.mockBaseUrl.replace(/\/$/, ''), withScheme(ozon.replacesUrl))
  }, [activeId, ozon])

  // «Скопировано» само гаснет: галочка навсегда выглядит как сломанная кнопка.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      // Буфер недоступен (нет разрешения, не https) — молчим: обещать успех нельзя,
      // а выделить и скопировать код руками читатель может и так.
    }
  }

  return (
    <section id="stack" className="bg-night px-[20px] py-[64px] md:px-[80px] md:py-[88px]">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-[36px]">
        <header className="flex flex-col items-center gap-[14px] text-center">
          <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent">ВАШ СТЕК</p>
          <h2 className="max-w-[820px] text-[30px] leading-[36px] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
            Тот же клиент, тот же код, другой адрес
          </h2>
          <p className="max-w-[680px] text-[16px] leading-[26px] text-nav-text">
            Никакого SDK и вендор-лока: обычный HTTP-запрос из вашего языка и инструмента.
          </p>
        </header>

        {ozon ? (
          <div className="overflow-hidden rounded-[14px] border border-nav-border bg-code-bg">
            {/* Полоса вкладок: на узком экране вкладки скроллятся внутри себя,
                кнопка копирования остаётся на месте. */}
            <div className="flex items-center gap-[10px] border-b border-nav-border bg-code-surface px-[14px] py-[10px]">
              <div className="flex min-w-0 flex-1 gap-[4px] overflow-x-auto scrollbar-thin">
                {SNIPPETS.map((snippet) => {
                  const active = snippet.id === activeId
                  return (
                    <button
                      key={snippet.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setActiveId(snippet.id)
                        setCopied(false)
                      }}
                      className={`shrink-0 rounded-[5px] px-[11px] py-[5px] font-mono text-[12px] whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-night-line font-semibold text-code-text'
                          : 'text-code-muted hover:text-night-text'
                      }`}
                    >
                      {snippet.label}
                    </button>
                  )
                })}
              </div>

              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? 'Код скопирован' : 'Скопировать код'}
                className="shrink-0 rounded-[6px] p-[5px] text-code-muted transition-colors hover:text-night-text"
              >
                {copied ? (
                  <Check size={14} className="text-night-ok" aria-hidden />
                ) : (
                  <Copy size={14} aria-hidden />
                )}
              </button>
            </div>

            <div className="flex flex-col lg:flex-row">
              {/* min-h держит высоту панели одинаковой на всех вкладках: без него
                  переключение языка дёргает страницу. */}
              <div className="flex min-w-0 flex-1 flex-col gap-[10px] p-[20px] lg:min-h-[232px]">
                <pre className="overflow-x-auto scrollbar-thin font-mono text-[12.5px] leading-[18px]">
                  <code>
                    {code.split('\n').map((line, index, all) => (
                      <Fragment key={index}>
                        {tokenize(line).map((part, partIndex) => (
                          <span key={partIndex} className={TONE_CLASS[part.tone]}>
                            {part.text}
                          </span>
                        ))}
                        {index < all.length - 1 ? '\n' : null}
                      </Fragment>
                    ))}
                  </code>
                </pre>

                {/* В макете здесь «← 200 OK · 41 мс · схема совпадает с боевой».
                    41 мс — выдуманное число: задержку конкретного ответа мы не измеряем,
                    поэтому строка осталась без миллисекунд. */}
                <p className="font-mono text-[12.5px] leading-[18px] text-night-ok">
                  ← 200 OK · схема совпадает с боевой
                </p>
              </div>

              <aside className="flex flex-col gap-[14px] border-t border-nav-border p-[20px] lg:w-[340px] lg:shrink-0 lg:border-t-0 lg:border-l">
                <SidePoints service={ozon} />
              </aside>
            </div>
          </div>
        ) : (
          /* API недоступен — адреса мока нет, а выдумывать его нельзя. Панель с кодом
             не рисуем, но секция остаётся: якорь #stack ведёт из шапки, а три пункта
             ниже верны и без данных. */
          <div className="rounded-[14px] border border-nav-border bg-code-bg p-[20px]">
            <div className="grid gap-[20px] md:grid-cols-3">
              <SidePoints />
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-[10px]">
          {TOOLS.map((tool) => (
            <span
              key={tool}
              className="rounded-[20px] border border-night-line bg-night-2 px-[14px] py-[8px] font-mono text-[12px] text-nav-text"
            >
              {tool}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * Колонка «Что важно». Заголовок общий, поэтому в раскладке без панели
 * (API недоступен) выводится тот же список, только в три колонки.
 *
 * Тексты пунктов — из макета, но подробности взяты из данных и кода шлюза:
 * лимит сервиса приходит в service.rateLimit, список режимов ошибок — SCENARIOS
 * из @apistend/shared. В макете в третьем пункте стояло «401, 429, 500 или таймаута»:
 * коды ответа у каждого сервиса свои (у Ozon отказ авторизации — 403), поэтому
 * называем не коды, а настоящие имена сценариев и заголовок, который их включает.
 */
function SidePoints({ service }: { service?: ServiceSummary }) {
  const errorModes = SCENARIOS.filter((s) => s !== 'success').join(', ')

  const points: Array<{ title: string; text: string; note?: string }> = [
    {
      title: 'Заголовок авторизации',
      text: 'X-Mock-Key вместо боевого токена — одна строка в клиенте',
    },
    {
      title: 'Пагинация и лимиты',
      text: 'limit и offset уходят в мок как есть, при превышении частоты — 429, как в боевом API',
      ...(service ? { note: `${service.shortCode} — ${service.rateLimit}` } : {}),
    },
    {
      title: 'Ошибки по требованию',
      text: 'Тот же запрос отвечает ошибкой в конверте сервиса — режим включает заголовок X-Mock-Scenario',
      note: errorModes,
    },
  ]

  return (
    <>
      {/* Заголовок колонки живёт вместе с пунктами, чтобы обе раскладки собирались отсюда. */}
      <p className="text-[10px] font-semibold tracking-[0.6px] text-code-muted md:col-span-3">
        ЧТО ВАЖНО
      </p>
      {points.map((point) => (
        <div key={point.title} className="flex flex-col gap-[4px]">
          {/* В макете заголовок пункта #E4E9F0 — своего токена у этого оттенка нет,
              берём ближайший из тёмного слоя. */}
          <p className="text-[13px] font-semibold text-night-text">{point.title}</p>
          <p className="text-[12px] leading-[17px] text-night-dim">{point.text}</p>
          {point.note ? (
            <p className="font-mono text-[11px] leading-[16px] text-code-muted">{point.note}</p>
          ) : null}
        </div>
      ))}
    </>
  )
}
