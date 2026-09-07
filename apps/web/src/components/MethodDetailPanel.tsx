'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BookOpen, Copy, Check } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, MethodBadge, Overline, Panel,
  PanelFooter, PanelHeader, SkeletonRows, StatusChip, StatusCodeChip, ErrorState,
  EmptyState, formatMs, meta,
} from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { MethodDetail } from '@/lib/types'
import { READINESS_LABEL, READINESS_TONE, SOURCE_LABEL } from '@/lib/readiness'

/**
 * Панель деталей метода — 372 px. design-handoff/screens/02-api-catalog.md, п. 3.
 *
 * Разделы: описание, параметры, сценарии ответа, задержка.
 * Отдельно показываем происхождение метода: из какой спецификации он взят и какого
 * числа снят снимок. Без этого каталог, наполняемый волнами, вводил бы в заблуждение.
 */
export function MethodDetailPanel({
  methodId, totalCatalog,
}: { methodId: string | null; totalCatalog: number }) {
  const router = useRouter()
  const [detail, setDetail] = useState<MethodDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!methodId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api.get<MethodDetail>(`/api/catalog/${encodeURIComponent(methodId)}`)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'Не удалось загрузить метод') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [methodId])

  async function copyUrl() {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.exampleUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер обмена недоступен */ }
  }

  if (!methodId) {
    return (
      <Panel className="w-[372px] shrink-0">
        <EmptyState
          title="Метод не выбран"
          description={
            totalCatalog > 0
              ? 'Выберите строку в списке слева, чтобы увидеть параметры и сценарии ответа'
              : 'Каталог пуст: запустите pnpm ingest'
          }
        />
      </Panel>
    )
  }

  return (
    <Panel className="w-[372px] shrink-0">
      {loading && !detail ? (
        <SkeletonRows rows={8} />
      ) : error ? (
        <ErrorState message={error} />
      ) : detail ? (
        <>
          <div className="shrink-0 border-b border-border p-[16px]">
            <div className="mb-[10px] flex items-center gap-[8px]">
              <MethodBadge method={detail.httpMethod} />
              <StatusChip tone={READINESS_TONE[detail.readiness]}>
                Мок {READINESS_LABEL[detail.readiness].toLowerCase()}
              </StatusChip>
              <button
                type="button"
                onClick={copyUrl}
                aria-label="Копировать адрес метода"
                className="ml-auto text-text-tertiary transition-colors hover:text-text-secondary"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="mb-[6px] font-mono text-[14px] break-all text-text-primary">{detail.path}</p>
            <h2 className="mb-[6px] text-[15px] font-semibold text-text-primary">{detail.title}</h2>
            <p className="text-[11px] text-text-tertiary">
              {meta(detail.group, detail.version, `снимок ${detail.snapshotDate}`, detail.deprecated && 'устарел')}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <section className="border-b border-border p-[16px]">
              <Overline>Описание</Overline>
              <p className="mt-[8px] text-[13px] leading-[1.5] text-text-secondary">
                {detail.description || detail.title}
              </p>
            </section>

            <section className="border-b border-border p-[16px]">
              <Overline>Параметры запроса</Overline>
              {detail.params.length === 0 ? (
                <p className="mt-[8px] text-[12px] text-text-tertiary">Параметров нет</p>
              ) : (
                <ul className="mt-[8px] flex flex-col gap-[10px]">
                  {detail.params.slice(0, 20).map((p) => (
                    <li key={`${p.in}:${p.name}`}>
                      <div className="flex flex-wrap items-baseline gap-[6px]">
                        <span className="font-mono text-[12px] text-text-primary">{p.name}</span>
                        <span className="text-[11px] text-text-tertiary">{p.type}</span>
                        <span className="text-[11px] text-text-tertiary">· {p.in}</span>
                        {p.required ? (
                          <span className="rounded-[4px] bg-danger-soft px-[5px] py-[1px] text-[10px] font-medium text-danger">
                            обяз.
                          </span>
                        ) : (
                          <span className="rounded-[4px] bg-surface-2 px-[5px] py-[1px] text-[10px] text-text-tertiary">
                            опц.
                          </span>
                        )}
                      </div>
                      {p.description ? (
                        <p className="mt-[2px] text-[11px] leading-[1.4] text-text-secondary">{p.description}</p>
                      ) : null}
                    </li>
                  ))}
                  {detail.params.length > 20 ? (
                    <li className="text-[11px] text-text-tertiary">
                      и ещё {detail.params.length - 20} — полный список в документации сервиса
                    </li>
                  ) : null}
                </ul>
              )}
            </section>

            <section className="border-b border-border p-[16px]">
              <div className="flex items-baseline justify-between">
                <Overline>Сценарии ответа</Overline>
                <span className="text-[11px] text-text-tertiary">{detail.scenarios.length} сценария</span>
              </div>
              <ul className="mt-[8px] flex flex-col gap-[6px]">
                {detail.scenarios.map((s) => (
                  <li
                    key={s.scenario}
                    className={`flex items-center gap-[10px] rounded-[6px] border px-[10px] py-[8px] ${
                      s.isDefault ? 'border-accent bg-accent-soft' : 'border-border bg-surface'
                    }`}
                  >
                    <StatusCodeChip code={s.statusCode} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">{s.title}</span>
                    {s.isDefault ? (
                      <span className="shrink-0 text-[11px] font-medium text-accent">по умолчанию</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-[8px] text-[11px] leading-[1.4] text-text-tertiary">
                Коды 429 и 503 — эмуляция ограничений боевого API. {detail.rateLimit.description}.
                Собственных лимитов у APIStend нет.
              </p>
            </section>

            <section className="border-b border-border p-[16px]">
              <div className="flex items-baseline justify-between">
                <Overline>Задержка ответа</Overline>
                <span className="font-mono text-[12px] font-semibold text-accent tabular">
                  {formatMs(detail.latencyMs)}
                </span>
              </div>
              <p className="mt-[6px] text-[11px] leading-[1.4] text-text-tertiary">
                Применяется ко всем сценариям метода. Переопределяется заголовком{' '}
                <span className="font-mono">X-Mock-Delay</span>, диапазон 0–3000 мс.
              </p>
            </section>

            <section className="p-[16px]">
              <Overline>Откуда взят ответ</Overline>
              <dl className="mt-[8px] flex flex-col gap-[6px] text-[11px]">
                <div className="flex justify-between gap-[10px]">
                  <dt className="text-text-tertiary">Источник ответа</dt>
                  <dd className="text-text-secondary">{SOURCE_LABEL[detail.responseSource]}</dd>
                </div>
                <div className="flex justify-between gap-[10px]">
                  <dt className="text-text-tertiary">Боевой хост</dt>
                  <dd className="truncate font-mono text-text-secondary">{detail.upstreamHost}</dd>
                </div>
                <div className="flex justify-between gap-[10px]">
                  <dt className="text-text-tertiary">Авторизация</dt>
                  <dd className="text-right text-text-secondary">{detail.nativeAuth.description}</dd>
                </div>
              </dl>
              <div className="mt-[10px]">
                <Overline>Пример вызова</Overline>
                <CodeBlock
                  className="mt-[6px]"
                  size="sm"
                  language="text"
                  code={`${detail.httpMethod} ${detail.exampleUrl}`}
                />
              </div>
            </section>
          </div>

          <PanelFooter
            left={
              <a href={detail.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[6px] text-accent hover:underline">
                <BookOpen size={12} aria-hidden />
                Документация
              </a>
            }
            right={
              <ButtonPrimary onClick={() => router.push(`/console?method=${encodeURIComponent(detail.id)}`)}>
                Открыть в консоли
              </ButtonPrimary>
            }
          />
        </>
      ) : null}
    </Panel>
  )
}
