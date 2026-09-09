'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { ButtonPrimary, ButtonSecondary, CodeBlock, Panel, ServiceChip } from '@apistend/ui'
import { SERVICE_LIST } from '@apistend/shared'
import type { ServiceCode } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import { Field, FormError } from './Field'

/**
 * Создание ключа. Модального окна в макете нет — собрано из готовых компонентов,
 * как и предписано разделом «Что в макете НЕ нарисовано».
 *
 * Полный ключ показывается ровно один раз, сразу после создания.
 */
export function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [kind, setKind] = useState<'sandbox' | 'server'>('sandbox')
  const [services, setServices] = useState<ServiceCode[]>(['bitrix24', 'ozon', 'wildberries', 'apify'])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  function toggle(code: ServiceCode) {
    setServices((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await api.post<{ secret: string }>('/api/keys', {
        name, subtitle: subtitle || undefined, kind, services, rotationDays: 90,
      })
      setSecret(res.secret)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать ключ')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Создать ключ"
      className="fixed inset-0 z-50 flex items-center justify-center bg-nav-bg/40 p-[24px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Panel className="w-full max-w-[480px]">
        <div className="flex items-center justify-between border-b border-border px-[16px] py-[13px]">
          <h2 className="text-[14px] font-semibold text-text-primary">
            {secret ? 'Ключ создан' : 'Создать ключ'}
          </h2>
          <button type="button" onClick={secret ? onCreated : onClose} aria-label="Закрыть"
            className="text-text-tertiary hover:text-text-secondary">
            <X size={16} aria-hidden />
          </button>
        </div>

        {secret ? (
          <div className="flex flex-col gap-[12px] p-[16px]">
            <p className="text-[13px] leading-[1.5] text-text-secondary">
              Сохраните ключ: полностью он показывается только сейчас. Дальше в интерфейсе
              будет видна только маска.
            </p>
            <CodeBlock code={secret} language="text" />
            <ButtonPrimary onClick={onCreated} className="w-full">Готово</ButtonPrimary>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-[14px] p-[16px]">
            <Field label="Название ключа" value={name} onChange={setName} required autoFocus
              hint="Например: Продакшн-интеграция 1С" />
            <Field label="Подпись (необязательно)" value={subtitle} onChange={setSubtitle}
              hint="Например: Сервер обмена · 1С:УТ 11" />

            <div className="flex flex-col gap-[6px]">
              <span className="text-[12px] font-medium text-text-secondary">Тип ключа</span>
              <div className="flex gap-[8px]">
                {([
                  ['sandbox', 'Ключ песочницы', 'stend_sbx_… — им ходит ваш код'],
                  ['server', 'Серверный ключ', 'stend_sk_… — им авторизуется CLI'],
                ] as const).map(([value, label, hint]) => (
                  <button key={value} type="button" onClick={() => setKind(value)}
                    className={`flex flex-1 flex-col items-start gap-[2px] rounded-[6px] border px-[10px] py-[8px] text-left ${
                      kind === value ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-2'
                    }`}>
                    <span className="text-[12px] font-medium text-text-primary">{label}</span>
                    <span className="font-mono text-[10px] text-text-tertiary">{hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-[6px]">
              <span className="text-[12px] font-medium text-text-secondary">Доступные сервисы</span>
              <div className="flex flex-wrap gap-[8px]">
                {SERVICE_LIST.map((s) => (
                  <button key={s.code} type="button" onClick={() => toggle(s.code)}
                    aria-pressed={services.includes(s.code)}
                    className={`inline-flex items-center gap-[6px] rounded-[6px] border px-[10px] py-[7px] text-[12px] ${
                      services.includes(s.code) ? 'border-accent bg-accent-soft text-text-primary' : 'border-border bg-surface text-text-secondary'
                    }`}>
                    <ServiceChip service={s.code} />
                    {s.title}
                  </button>
                ))}
              </div>
            </div>

            {error ? <FormError>{error}</FormError> : null}

            <div className="flex gap-[8px]">
              <ButtonSecondary onClick={onClose} className="flex-1">Отмена</ButtonSecondary>
              <ButtonPrimary type="submit" disabled={pending || services.length === 0 || name.length < 2} className="flex-1">
                {pending ? 'Создаём…' : 'Создать ключ'}
              </ButtonPrimary>
            </div>
          </form>
        )}
      </Panel>
    </div>
  )
}
