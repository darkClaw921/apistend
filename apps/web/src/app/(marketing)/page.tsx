import Link from 'next/link'
import { PlugZap, ArrowRight, Timer, Zap, Check, CornerDownRight, ArrowDown } from 'lucide-react'
import { API_URL } from '@/lib/api'
import { formatInt, formatMethods, ServiceSquare, ServiceDot } from '@apistend/ui'
import { isServiceCode } from '@apistend/shared'
import { LandingNav } from '@/components/landing/LandingNav'
import { HeroTerminal } from '@/components/landing/HeroTerminal'
import { PricingCards } from '@/components/landing/PricingCards'

/**
 * Публичный лендинг. design-handoff/screens/08-landing.md.
 *
 * Все числа — из живого каталога, а не из вёрстки: каталог наполняется волнами,
 * и витрина обязана показывать то, что есть на самом деле, вместе с датой снимка.
 */

// Числа берём при каждом запросе: каталог меняется между волнами ингеста.
export const dynamic = 'force-dynamic'

interface ServiceSummary {
  code: string
  title: string
  letter: string
  apiVersion: string
  brandToken: string
  replacesUrl: string
  mockBaseUrl: string
  methodsCount: number
  snapshotDate: string | null
}

async function loadServices(): Promise<{ services: ServiceSummary[]; totalMethods: number } | null> {
  try {
    const res = await fetch(`${API_URL}/api/services`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as { services: ServiceSummary[]; totalMethods: number }
  } catch {
    // Лендинг обязан открываться, даже если API недоступен: покажем «—» вместо чисел.
    return null
  }
}

const SERVICE_SAMPLES: Record<string, string[]> = {
  bitrix24: ['/rest/crm.deal.list', '/rest/crm.contact.add', '/rest/tasks.task.list'],
  ozon: ['/v3/posting/fbs/list', '/v3/product/info/list', '/v1/review/list'],
  wildberries: ['/api/v3/orders/new', '/api/v3/stocks/{warehouseId}', '/content/v2/get/cards/list'],
}

export default async function LandingPage() {
  const data = await loadServices()
  const total = data?.totalMethods ?? null

  return (
    <div className="min-h-screen bg-surface">
      <LandingNav />

      {/* 2. Hero */}
      <section className="bg-nav-bg px-[20px] py-[72px] md:px-[80px] md:py-[96px]">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-[56px] lg:flex-row lg:items-center">
          <div className="w-full lg:w-[600px] lg:shrink-0">
            <span className="inline-flex items-center gap-[8px] rounded-[20px] border border-[#2C3A63] bg-[#1B2440] px-[12px] py-[6px] text-[12px] text-[#A6B4FF]">
              Новое · вебхуки приходят прямо на localhost
            </span>
            <h1 className="mt-[20px] text-[40px] leading-[1.08] font-bold tracking-[-2px] text-white md:text-[56px]">
              Демо-API Bitrix24, Ozon и Wildberries для ваших интеграций
            </h1>
            <p className="mt-[20px] max-w-[520px] text-[17px] leading-[1.6] text-nav-text">
              Точные копии боевых API с теми же схемами ответов, ошибками и вебхуками.
              Разрабатывайте и тестируйте интеграции, пока доступ к продакшену ещё не выдали.
            </p>
            <div className="mt-[28px] flex flex-wrap gap-[12px]">
              <Link
                href="/register"
                className="inline-flex items-center gap-[8px] rounded-[6px] bg-accent px-[24px] py-[14px] text-[15px] font-semibold text-white transition-colors hover:bg-accent-hover"
              >
                Создать песочницу <ArrowRight size={16} aria-hidden />
              </Link>
              <Link
                href="/catalog"
                className="inline-flex items-center gap-[8px] rounded-[6px] border border-[#2C3742] px-[24px] py-[14px] text-[15px] font-semibold text-white transition-colors hover:bg-nav-bg-2"
              >
                Каталог методов
              </Link>
            </div>
            <ul className="mt-[24px] flex flex-wrap gap-[20px] text-[13px] text-nav-text">
              {['Без карты', 'Без лимита на запросы', 'Ответ за 40 мс'].map((t) => (
                <li key={t} className="inline-flex items-center gap-[6px]">
                  <Check size={14} className="text-[#3DD68C]" aria-hidden /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 flex-1">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* 3. Сервисы */}
      <section className="px-[20px] py-[88px] md:px-[80px]">
        <div className="mx-auto max-w-[1280px]">
          <p className="text-[11px] font-semibold tracking-[0.8px] text-accent uppercase">Сервисы</p>
          <h2 className="mt-[12px] max-w-[720px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-text-primary md:text-[38px]">
            Три маркетплейса и CRM, которые чаще всего ломают интеграции
          </h2>
          <p className="mt-[14px] max-w-[640px] text-[15px] leading-[1.6] text-text-secondary">
            Мы повторяем схемы запросов, коды ошибок, пагинацию и лимиты. Ответ отличается только данными.
          </p>

          <div className="mt-[36px] grid gap-[20px] md:grid-cols-3">
            {(data?.services ?? []).map((s) => (
              <article key={s.code} className="flex flex-col rounded-[14px] border border-border bg-surface p-[28px]">
                {isServiceCode(s.code) ? <ServiceSquare service={s.code} size={46} /> : null}
                <h3 className="mt-[16px] text-[20px] font-semibold text-text-primary">{s.title}</h3>
                <p className="mt-[4px] font-mono text-[12px] text-text-tertiary">{s.apiVersion}</p>
                <ul className="mt-[16px] flex flex-col gap-[6px]">
                  {(SERVICE_SAMPLES[s.code] ?? []).map((path) => (
                    <li key={path} className="flex items-center gap-[8px] font-mono text-[12px] text-text-secondary">
                      <CornerDownRight size={13} className="shrink-0 text-text-tertiary" aria-hidden />
                      <span className="truncate">{path}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex items-baseline justify-between gap-[10px] border-t border-border pt-[16px]">
                  <span className="text-[13px] font-semibold text-text-primary">
                    {formatMethods(s.methodsCount)}
                  </span>
                  <Link href="/catalog" className="inline-flex items-center gap-[5px] text-[12px] font-semibold text-accent">
                    Смотреть <ArrowRight size={12} aria-hidden />
                  </Link>
                </div>
                {s.snapshotDate ? (
                  <p className="mt-[8px] text-[11px] text-text-tertiary">Снимок документации {s.snapshotDate}</p>
                ) : null}
              </article>
            ))}
          </div>

          <div className="mt-[24px] flex items-center gap-[10px] rounded-[10px] bg-surface-2 px-[16px] py-[14px]">
            <Timer size={16} className="shrink-0 text-text-tertiary" aria-hidden />
            <p className="text-[13px] text-text-secondary">
              Скоро: Яндекс Маркет, СБИС, МойСклад, Авито и 1С-Битрикс: Магазин.
            </p>
          </div>
        </div>
      </section>

      {/* 4. Возможности */}
      <section className="bg-bg px-[20px] py-[88px] md:px-[80px]">
        <div className="mx-auto max-w-[1280px]">
          <p className="text-[11px] font-semibold tracking-[0.8px] text-accent uppercase">Возможности</p>
          <h2 className="mt-[12px] max-w-[720px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-text-primary md:text-[38px]">
            Всё, чего не хватает боевому аккаунту на этапе разработки
          </h2>

          <div className="mt-[36px] grid gap-[20px] lg:grid-cols-[1fr_420px]">
            <Feature
              title="Ответ совпадает с боевым API до последнего поля"
              text="Схемы, вложенность, форматы дат, пагинация и пустые значения — из документации сервиса. Мок отдаёт пример из спецификации, если он там есть, и честно помечает, когда ответ построен по схеме."
            />
            <Feature
              title="Ошибки по требованию"
              text="Один переключатель — и метод отдаёт нужный сбой. Проверяйте ретраи и обработку лимитов до релиза."
              chips={['401', '429', '500', 'timeout']}
            />
          </div>

          <div className="mt-[20px] grid gap-[20px] md:grid-cols-3">
            <Feature title="Демо-данные, которые не меняются" text="Один и тот же запрос всегда даёт один и тот же ответ: снимки экранов и контрактные тесты не «плывут»." />
            <Feature title="Логи каждого запроса" text="Тело запроса, ответ, задержка и ключ. Видно, что именно отправила интеграция и почему сервис ответил ошибкой." />
            <Feature title="Ключи и доступ команды" text="Отдельный ключ на CI и на каждого разработчика. Права, срок жизни и мгновенный отзыв без деплоя." />
          </div>
        </div>
      </section>

      {/* 5. Вебхуки на localhost */}
      <section className="bg-nav-bg px-[20px] py-[88px] md:px-[80px]">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-[56px] lg:flex-row">
          <div className="w-full lg:w-[600px] lg:shrink-0">
            <p className="text-[11px] font-semibold tracking-[0.8px] text-accent uppercase">Вебхуки</p>
            <h2 className="mt-[12px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-white md:text-[38px]">
              События приходят прямо в приложение на вашем компьютере
            </h2>
            <p className="mt-[16px] max-w-[520px] text-[15px] leading-[1.6] text-nav-text">
              Bitrix24, Ozon и Wildberries умеют слать вебхуки только на публичный адрес.
              APIStend доставляет их на локальный порт через свой агент — без туннелей, VPN и проброса портов.
            </p>
            <ul className="mt-[24px] flex flex-col gap-[12px]">
              {[
                'Одна команда в терминале — и события идут на ваш порт',
                'Повтор любого события в один клик, история доставок сохраняется',
                'Работает в CI: агент поднимается контейнером рядом с тестами',
              ].map((t) => (
                <li key={t} className="flex items-start gap-[10px] text-[14px] leading-[1.5] text-nav-text">
                  <span className="mt-[2px] flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full bg-[#1B2440]">
                    <Check size={12} className="text-[#A6B4FF]" aria-hidden />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
            <div className="mt-[24px] rounded-[6px] bg-[#0A0E14] px-[16px] py-[14px] font-mono text-[13px]">
              <span className="text-code-muted">$ </span>
              <span className="text-code-key">npx apistend listen</span>
              <span className="text-code-string"> --forward localhost:3000/webhooks</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
            {[
              { title: 'APIStend', sub: 'событие posting.created' },
              { title: 'APIStend CLI', sub: 'websocket · сессия tnl-8f21' },
              { title: 'Ваше приложение', sub: 'POST localhost:3000/webhooks' },
            ].map((step, i) => (
              <div key={step.title}>
                <div className="rounded-[10px] border border-nav-border bg-code-surface px-[16px] py-[14px]">
                  <p className="text-[14px] font-semibold text-white">{step.title}</p>
                  <p className="mt-[2px] font-mono text-[11px] text-code-muted">{step.sub}</p>
                </div>
                {i < 2 ? (
                  <div className="flex justify-center py-[6px]">
                    <ArrowDown size={16} className="text-code-muted" aria-hidden />
                  </div>
                ) : null}
              </div>
            ))}
            <div className="mt-[10px] rounded-[10px] border border-nav-border bg-code-bg p-[14px] font-mono text-[11px] leading-[1.7]">
              <p className="text-code-muted">журнал доставок</p>
              <p><span className="text-code-muted">10:42:18</span> <span className="text-code-string">posting.created</span> <span className="text-[#3DD68C]">200 OK</span> <span className="text-code-muted">12 мс</span></p>
              <p><span className="text-code-muted">10:41:52</span> <span className="text-code-string">stocks.changed</span> <span className="text-[#3DD68C]">200 OK</span> <span className="text-code-muted">9 мс</span></p>
              <p><span className="text-code-muted">10:44:01</span> <span className="text-code-string">crm.deal.stage.changed</span> <span className="text-[#3DD68C]">200 OK</span> <span className="text-code-muted">14 мс</span></p>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Как это работает */}
      <section className="px-[20px] py-[88px] md:px-[80px]">
        <div className="mx-auto max-w-[1280px]">
          <p className="text-[11px] font-semibold tracking-[0.8px] text-accent uppercase">Как это работает</p>
          <h2 className="mt-[12px] max-w-[720px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-text-primary md:text-[38px]">
            Первый успешный запрос — через пять минут после регистрации
          </h2>
          <ol className="mt-[36px] grid gap-[24px] md:grid-cols-3">
            {[
              { n: '01', t: 'Создайте песочницу', d: 'Регистрация по почте, без карты. Отдельные песочницы на каждый проект и стенд.' },
              { n: '02', t: 'Подмените базовый адрес', d: 'В коде интеграции меняется одна строка — остальное остаётся как есть.', code: data?.services[2]?.mockBaseUrl },
              { n: '03', t: 'Проверьте сценарии', d: 'Включите ошибки и задержки, проверьте ретраи и повторы. Когда всё зелено — возвращайте боевой адрес.' },
            ].map((step) => (
              <li key={step.n}>
                <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[10px] bg-accent-soft font-mono text-[15px] font-bold text-accent">
                  {step.n}
                </span>
                <h3 className="mt-[14px] text-[19px] font-semibold text-text-primary">{step.t}</h3>
                <p className="mt-[6px] text-[14px] leading-[1.55] text-text-secondary">{step.d}</p>
                {step.code ? (
                  <p className="mt-[10px] truncate rounded-[6px] bg-code-bg px-[12px] py-[10px] font-mono text-[12px] text-code-string">
                    {step.code}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 7. Каталог */}
      <section className="bg-bg px-[20px] py-[88px] md:px-[80px]">
        <div className="mx-auto max-w-[1280px]">
          <div className="flex flex-wrap items-end justify-between gap-[16px]">
            <h2 className="max-w-[720px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-text-primary md:text-[38px]">
              {total === null ? 'Каталог методов уже готов' : `${formatMethods(total)} уже готовы`}
            </h2>
            <Link
              href="/catalog"
              className="inline-flex items-center gap-[8px] rounded-[6px] border border-border-strong bg-surface px-[15px] py-[9px] text-[13px] font-medium text-text-primary"
            >
              Открыть каталог <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
          <p className="mt-[12px] max-w-[640px] text-[15px] leading-[1.6] text-text-secondary">
            Каталог собран из официальной документации сервисов. У каждого метода видно,
            откуда взят ответ и какого числа снят снимок спецификации.
          </p>

          <div className="mt-[28px] overflow-hidden rounded-[14px] border border-border bg-surface">
            {(data?.services ?? []).flatMap((s) =>
              (SERVICE_SAMPLES[s.code] ?? []).slice(0, 2).map((path) => (
                <div key={`${s.code}${path}`} className="flex items-center gap-[16px] border-b border-border px-[20px] py-[14px] last:border-b-0">
                  <span className="flex w-[130px] shrink-0 items-center gap-[8px]">
                    {isServiceCode(s.code) ? <ServiceDot service={s.code} /> : null}
                    <span className="truncate text-[13px] text-text-primary">{s.title}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary">{path}</span>
                  <span className="shrink-0 rounded-[20px] bg-success-soft px-[10px] py-[3px] text-[12px] font-medium text-success">Готов</span>
                </div>
              )),
            )}
          </div>
          {total !== null ? (
            <p className="mt-[14px] text-[13px] text-text-tertiary">
              И ещё {formatInt(Math.max(0, total - 6))} методов в каталоге.
            </p>
          ) : null}
        </div>
      </section>

      <PricingCards />

      {/* 9. CTA */}
      <section className="border-t border-[#242E3A] bg-[#111821] px-[20px] py-[72px] text-center md:px-[80px]">
        <h2 className="mx-auto max-w-[720px] text-[32px] leading-[1.15] font-bold tracking-[-1px] text-white md:text-[42px]">
          Перестаньте ждать доступ к боевому API
        </h2>
        <p className="mx-auto mt-[14px] max-w-[560px] text-[15px] leading-[1.6] text-nav-text">
          Песочница поднимается за пять секунд. Первый запрос к Bitrix24, Ozon или Wildberries — сразу после регистрации.
        </p>
        <div className="mt-[24px] flex flex-wrap justify-center gap-[12px]">
          <Link href="/register" className="inline-flex items-center gap-[8px] rounded-[6px] bg-accent px-[24px] py-[14px] text-[15px] font-semibold text-white">
            Создать песочницу <ArrowRight size={16} aria-hidden />
          </Link>
          <Link href="/catalog" className="inline-flex items-center rounded-[6px] border border-[#2C3742] px-[24px] py-[14px] text-[15px] font-semibold text-white">
            Поговорить с командой
          </Link>
        </div>
        <p className="mt-[18px] text-[13px] text-[#6C7A8A]">Без карты · без лимитов на запросы · отказ в один клик</p>
      </section>

      {/* 10. Футер */}
      <footer className="px-[20px] py-[56px] md:px-[80px]">
        <div className="mx-auto max-w-[1280px]">
          <div className="grid gap-[32px] md:grid-cols-4">
            <div>
              <span className="flex items-center gap-[10px]">
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-accent">
                  <PlugZap size={17} className="text-white" aria-hidden />
                </span>
                <span className="text-[15px] font-bold text-text-primary">APIStend</span>
              </span>
              <p className="mt-[12px] max-w-[240px] text-[13px] leading-[1.55] text-text-secondary">
                Демо-копии боевых API для разработки и тестирования интеграций.
              </p>
            </div>
            {[
              { title: 'Продукт', links: ['Каталог методов', 'Вебхуки', 'Свои моки', 'Цены'] },
              { title: 'Разработчикам', links: ['Документация', 'Быстрый старт', 'CLI', 'Примеры на GitHub'] },
              { title: 'Компания', links: ['О проекте', 'Дорожная карта', 'Контакты'] },
            ].map((col) => (
              <div key={col.title}>
                <p className="text-[13px] font-semibold text-text-primary">{col.title}</p>
                <ul className="mt-[10px] flex flex-col gap-[8px]">
                  {col.links.map((l) => (
                    <li key={l}><span className="text-[13px] text-text-secondary">{l}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-[32px] border-t border-border pt-[20px]">
            <p className="text-[12px] leading-[1.6] text-text-tertiary">
              © 2026 APIStend. Демо-копии не связаны с ООО «1С-Битрикс», ООО «Интернет Решения» (Ozon)
              и ООО «Вайлдберриз». Названия и товарные знаки принадлежат правообладателям
              и используются исключительно для указания совместимости.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

function Feature({ title, text, chips }: { title: string; text: string; chips?: string[] }) {
  return (
    <article className="rounded-[14px] border border-border bg-surface p-[24px]">
      <h3 className="text-[17px] font-semibold text-text-primary">{title}</h3>
      <p className="mt-[8px] text-[14px] leading-[1.55] text-text-secondary">{text}</p>
      {chips ? (
        <ul className="mt-[14px] flex flex-wrap gap-[8px]">
          {chips.map((c) => (
            <li key={c} className="rounded-[4px] bg-danger-soft px-[8px] py-[3px] font-mono text-[12px] font-semibold text-danger">
              {c}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}
