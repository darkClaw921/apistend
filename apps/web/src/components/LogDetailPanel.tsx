'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, ExternalLink, Copy, Check } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, JsonViewer, MethodBadge, Overline, Panel, PanelFooter,
  SkeletonRows, StatusCodeChip, Tabs, EmptyState, formatBytes, formatDateTimeMs, formatMs, meta,
} from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { LogDetail, LogRow } from '@/lib/types'

/**
 * Панель деталей запроса — 336 px. design-handoff/screens/04-request-logs.md, п. 4.
 *
 * Тело успешного ответа в журнале не хранится: оно детерминировано и восстанавливается
 * движком. Об этом честно сообщаем подписью, иначе пользователь решит, что видит
 * запись, а не пересчёт.
 */
export function LogDetailPanel({ row, onClose }: { row: LogRow | null; onClose: () => void }) {
  const router = useRouter()
  const [detail, setDetail] = useState<LogDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('response')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!row) { setDetail(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    api.get<LogDetail>(`/api/logs/${row.id}`)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'Не удалось загрузить запрос') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [row])

  if (!row) {
    return (
      <Panel className="h-full w-full">
        <EmptyState
          title="Запрос не выбран"
          description="Выберите строку журнала, чтобы увидеть тело запроса, ответ и заголовки"
        />
      </Panel>
    )
  }

  const pretty = (raw: string | null) => {
    if (!raw) return '—'
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }

  return (
    <Panel className="h-full w-full">
      <div className="flex shrink-0 items-center gap-[10px] border-b border-border px-[16px] py-[13px]">
        <h2 className="text-[14px] font-semibold text-text-primary">Детали запроса</h2>
        <div className="ml-auto flex items-center gap-[8px]">
          <button type="button" aria-label="Открыть в новой вкладке" className="text-text-tertiary hover:text-text-secondary">
            <ExternalLink size={14} aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label="Закрыть панель" className="text-text-tertiary hover:text-text-secondary">
            <X size={14} aria-hidden />
          </button>
        </div>
      </div>

      {loading && !detail ? (
        <SkeletonRows rows={6} />
      ) : error ? (
        <div className="p-[16px] text-[13px] text-danger">{error}</div>
      ) : detail ? (
        <>
          <div className="shrink-0 border-b border-border p-[16px]">
            <div className="mb-[10px] flex flex-wrap items-center gap-[8px]">
              <MethodBadge method={detail.httpMethod} />
              <StatusCodeChip code={detail.statusCode} />
              <span className="font-mono text-[12px] text-text-secondary tabular">{formatMs(detail.durationMs)}</span>
              <span className="font-mono text-[12px] text-text-secondary tabular">{formatBytes(detail.sizeBytes)}</span>
            </div>
            {detail.upstreamUrl ? (
              <p className="mb-[10px] flex items-start gap-[6px] font-mono text-[12px] break-all text-text-primary">
                <span className="min-w-0 flex-1">{detail.upstreamUrl}</span>
                <button type="button" aria-label="Копировать боевой адрес"
                  onClick={() => { void navigator.clipboard.writeText(detail.upstreamUrl!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                  className="shrink-0 text-text-tertiary hover:text-text-secondary">
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </p>
            ) : null}
            <dl className="flex flex-col gap-[5px] rounded-[6px] bg-surface-2 p-[10px] text-[11px]">
              <Row label="ID запроса" value={detail.publicId} mono />
              <Row label="Время" value={formatDateTimeMs(detail.timestamp)} mono />
              <Row label="Сценарий" value={detail.scenario} mono />
              <Row label="Ключ доступа" value={detail.apiKeyName ?? '—'} mono />
              <Row label="IP клиента" value={detail.clientIp ?? '—'} mono />
            </dl>
          </div>

          <Tabs
            items={[
              { value: 'response', label: 'Ответ' },
              { value: 'request', label: 'Запрос' },
              { value: 'headers', label: 'Заголовки' },
            ]}
            value={tab}
            onChange={setTab}
          />

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-[16px]">
            {tab === 'response' ? (
              <>
                <div className="mb-[6px] flex items-baseline justify-between gap-[8px]">
                  <Overline>Тело ответа</Overline>
                  {detail.responseBodyReproduced ? (
                    <span className="text-[10px] text-text-tertiary">восстановлено движком</span>
                  ) : null}
                </div>
                {/* Тело ответа бывает в сотни строк — деревом его можно свернуть. */}
                <JsonViewer size="sm" code={pretty(detail.responseBody)} maxHeight={420} />
                {detail.responseBodyReproduced ? (
                  <p className="mt-[8px] text-[11px] leading-[1.4] text-text-tertiary">
                    Ответы моков детерминированы, поэтому журнал их не хранит, а пересчитывает
                    тем же движком. Результат совпадает с тем, что получил клиент.
                  </p>
                ) : null}
              </>
            ) : tab === 'request' ? (
              <>
                <Overline>Тело запроса</Overline>
                <JsonViewer className="mt-[6px]" size="sm" code={pretty(detail.requestBody)} maxHeight={420} />
              </>
            ) : (
              <>
                <Overline>Заголовки запроса</Overline>
                <CodeBlock
                  className="mt-[6px]" size="sm" language="text"
                  code={Object.entries(detail.requestHeaders ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join('\n') || '—'}
                />
                <div className="mt-[12px]">
                  <Overline>Заголовки ответа</Overline>
                  <CodeBlock
                    className="mt-[6px]" size="sm" language="text"
                    code={Object.entries(detail.responseHeaders ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join('\n') || '—'}
                  />
                </div>
              </>
            )}
          </div>

          <PanelFooter
            left={meta(detail.serviceCode, detail.responseSource)}
            right={
              <ButtonPrimary
                onClick={() => router.push(`/console?replay=${encodeURIComponent(detail.publicId)}`)}
              >
                Повторить в консоли
              </ButtonPrimary>
            }
          />
        </>
      ) : null}
    </Panel>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-[10px]">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className={`truncate text-text-secondary ${mono ? 'font-mono' : ''}`} title={value}>{value}</dd>
    </div>
  )
}
