'use client'

import { useState } from 'react'
import { ButtonSecondary, Overline, formatInt } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { WebhookItem } from '@/lib/types'

/**
 * Создание сценария нагрузки: событие, сколько отправить и с какой скоростью.
 *
 * Событие выбирается из уже заведённых вебхуков, а не из общего справочника:
 * сценарий без получателя запускать некуда, и лучше не дать создать такой,
 * чем показать ошибку в момент запуска.
 */

interface Props {
  webhooks: WebhookItem[]
  limits: { maxRatePerSec: number; maxCount: number; maxConcurrent: number }
  onCancel: () => void
  onCreated: () => void
  onError: (message: string) => void
}

const FIELD =
  'w-full rounded-[6px] border border-border-strong bg-surface px-[10px] py-[7px] text-[12px] ' +
  'text-text-primary outline-none focus:border-accent'

export function ScenarioForm({ webhooks, limits, onCancel, onCreated, onError }: Props) {
  const usable = webhooks.filter((w) => w.status !== 'disabled')
  const [webhookId, setWebhookId] = useState(usable[0]?.id ?? '')
  const [count, setCount] = useState('200')
  const [rate, setRate] = useState('50')
  const [errorRate, setErrorRate] = useState('0')
  const [saving, setSaving] = useState(false)

  const selected = usable.find((w) => w.id === webhookId)
  const numCount = Number(count)
  const numRate = Number(rate)
  const valid =
    selected !== undefined &&
    Number.isFinite(numCount) && numCount >= 1 && numCount <= limits.maxCount &&
    Number.isFinite(numRate) && numRate >= 1 && numRate <= limits.maxRatePerSec

  async function submit() {
    if (!selected || !valid) return
    setSaving(true)
    try {
      await api.post('/api/scenarios', {
        // Имя собираем сами: в панели высотой в треть экрана отдельное поле
        // вытесняло бы кнопку за нижний край, а событие и параметры различают
        // сценарии не хуже придуманного названия.
        name: `${selected.event} · ${formatInt(numCount)} по ${formatInt(numRate)}/с`,
        serviceCode: selected.serviceCode,
        event: selected.event,
        stepsCount: Math.round(numCount),
        ratePerSec: Math.round(numRate),
        errorRate: Math.max(0, Math.min(100, Math.round(Number(errorRate) || 0))),
      })
      onCreated()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не удалось создать сценарий')
    } finally {
      setSaving(false)
    }
  }

  if (usable.length === 0) {
    return (
      <div className="border-b border-border p-[14px] text-[12px] text-text-secondary">
        Сначала заведите вебхук — сценарию нужно, куда слать события.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[8px] border-b border-border bg-surface-2 p-[14px]">
      <div className="flex flex-col gap-[4px]">
        <Overline>Событие и получатель</Overline>
        <select className={FIELD} value={webhookId} onChange={(e) => setWebhookId(e.target.value)}>
          {usable.map((w) => (
            <option key={w.id} value={w.id}>
              {w.event} → {w.target === 'local' ? `${w.targetPath} (локально)` : w.targetUrl}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-3 gap-[8px]">
        <div className="flex flex-col gap-[4px]">
          <Overline>Событий</Overline>
          <input
            className={`${FIELD} font-mono tabular`} inputMode="numeric"
            value={count} onChange={(e) => setCount(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-[4px]">
          <Overline>Соб/с</Overline>
          <input
            className={`${FIELD} font-mono tabular`} inputMode="numeric"
            value={rate} onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-[4px]">
          <Overline>Ошибок, %</Overline>
          <input
            className={`${FIELD} font-mono tabular`} inputMode="numeric"
            value={errorRate} onChange={(e) => setErrorRate(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-[10px]">
        <p className="min-w-0 flex-1 font-mono text-[11px] leading-[14px] text-text-tertiary">
          {valid
            ? `≈ ${formatInt(Math.ceil(numCount / numRate))} с работы`
            : `1…${formatInt(limits.maxCount)} событий, 1…${formatInt(limits.maxRatePerSec)} соб/с`}
        </p>
        <ButtonSecondary tone="quiet" onClick={onCancel}>Отмена</ButtonSecondary>
        <ButtonSecondary tone="quiet" disabled={!valid || saving} onClick={() => void submit()}>
          {saving ? 'Создаю…' : 'Создать'}
        </ButtonSecondary>
      </div>
    </div>
  )
}
