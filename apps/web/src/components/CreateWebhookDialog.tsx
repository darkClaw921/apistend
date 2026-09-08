'use client'

import { useEffect, useState } from 'react'
import { ButtonPrimary, ButtonSecondary, CodeBlock, Dialog, SegmentControl } from '@apistend/ui'
import type { ServiceCode } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import type { EventsResponse } from '@/lib/types'
import { Field, FormError } from './Field'

/**
 * Создание вебхука. Модального окна в макете нет — собрано из готовых
 * компонентов, как и предписано разделом «Что в макете НЕ нарисовано».
 *
 * Справочник событий берётся с сервера: коды нативные (ONCRMDEALADD,
 * TYPE_NEW_POSTING), и придумывать их в форме нельзя — сервер отвергнет
 * незнакомое событие, как и боевой портал.
 */
export function CreateWebhookDialog({
  onClose, onCreated, forwardUrl,
}: {
  onClose: () => void
  onCreated: () => void
  /** Базовый адрес агента: показывается рядом с путём локальной доставки. */
  forwardUrl: string | null
}) {
  const [catalog, setCatalog] = useState<EventsResponse | null>(null)
  const [service, setService] = useState<ServiceCode>('bitrix24')
  const [event, setEvent] = useState('')
  const [target, setTarget] = useState<'local' | 'public'>('local')
  const [targetPath, setTargetPath] = useState('/webhooks/apistend')
  const [targetUrl, setTargetUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setCatalog(await api.get<EventsResponse>('/api/events'))
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Не удалось загрузить справочник событий')
      }
    })()
  }, [])

  const current = catalog?.services.find((s) => s.code === service)

  // Событие принадлежит сервису, поэтому при смене сервиса выбор сбрасывается
  // на первое событие нового — иначе форма отправила бы чужой код.
  useEffect(() => {
    setEvent(current?.events[0]?.code ?? '')
  }, [current])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await api.post<{ secret: string }>('/api/webhooks', {
        serviceCode: service,
        event,
        target,
        // Поля взаимоисключающие: у локальной доставки в модели лежит
        // относительный путь, базу подставляет apistend listen.
        ...(target === 'local' ? { targetPath } : { targetUrl }),
      })
      setSecret(res.secret)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать вебхук')
    } finally {
      setPending(false)
    }
  }

  if (secret) {
    return (
      <Dialog title="Вебхук создан" onClose={onCreated}>
        <div className="flex flex-col gap-[12px] p-[16px]">
          <p className="text-[13px] leading-[1.5] text-text-secondary">
            Секрет подписи — им сервис подписывает тело события. Полностью показывается
            только сейчас.
          </p>
          <CodeBlock code={secret} language="text" />
          <ButtonPrimary onClick={onCreated} className="w-full">Готово</ButtonPrimary>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Новый вебхук" onClose={onClose} width={520}>
      <form onSubmit={submit} className="flex flex-col gap-[14px] p-[16px]">
        <div className="flex flex-col gap-[6px]">
          <span className="text-[12px] font-medium text-text-secondary">Сервис</span>
          <SegmentControl
            segments={(catalog?.services ?? []).map((s) => ({ value: s.code, label: s.title }))}
            value={service}
            onChange={(v) => setService(v as ServiceCode)}
          />
        </div>

        <div className="flex flex-col gap-[6px]">
          <label htmlFor="wh-event" className="text-[12px] font-medium text-text-secondary">Событие</label>
          <select
            id="wh-event"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            className="rounded-[6px] border border-border-strong bg-surface px-[12px] py-[9px] text-[13px] text-text-primary outline-none focus:border-accent"
          >
            {(current?.events ?? []).map((ev) => (
              <option key={ev.code} value={ev.code}>{ev.title} · {ev.code}</option>
            ))}
          </select>
          {current ? (
            <span className="text-[11px] leading-[1.5] text-text-tertiary">{current.webhook.notes}</span>
          ) : null}
        </div>

        <div className="flex flex-col gap-[6px]">
          <span className="text-[12px] font-medium text-text-secondary">Куда доставлять</span>
          <SegmentControl
            segments={[
              { value: 'local', label: 'На мою машину' },
              { value: 'public', label: 'На адрес' },
            ]}
            value={target}
            onChange={(v) => setTarget(v as 'local' | 'public')}
          />
        </div>

        {target === 'local' ? (
          <Field
            label="Путь"
            value={targetPath}
            onChange={setTargetPath}
            required
            placeholder="/webhooks/apistend"
            hint={
              forwardUrl
                ? `Базовый адрес даёт агент: ${forwardUrl}`
                : 'Базовый адрес задаёт apistend listen --forward, здесь только путь'
            }
          />
        ) : (
          <Field
            label="Адрес получателя"
            value={targetUrl}
            onChange={setTargetUrl}
            required
            placeholder="https://example.com/hooks/apistend"
            hint="Запрос сделает сервер APIStend, поэтому внутренние адреса он отклонит"
          />
        )}

        {error ? <FormError>{error}</FormError> : null}

        <div className="flex justify-end gap-[10px]">
          <ButtonSecondary onClick={onClose} type="button">Отмена</ButtonSecondary>
          <ButtonPrimary type="submit" disabled={pending || !event}>
            {pending ? 'Создаю…' : 'Создать'}
          </ButtonPrimary>
        </div>
      </form>
    </Dialog>
  )
}
