'use client'

import { useState } from 'react'
import { ButtonPrimary, ButtonSecondary, Dialog } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { Field, FormError } from './Field'

/**
 * Создание своего мока. Модального окна в макете нет — собрано из готовых
 * компонентов, как и предписано разделом «Что в макете НЕ нарисовано».
 *
 * Заготовки не украшение: движок шаблонов поддерживает ровно семь подстановок,
 * и увидеть их проще на готовом теле, чем прочитать в списке чипов.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

interface Template {
  id: string
  label: string
  hint: string
  path: string
  httpMethod: (typeof METHODS)[number]
  title: string
  responseStatusCode: number
  body: string
}

/** Консоль умеет и HEAD с OPTIONS, а свой мок — нет: приводим к ближайшему. */
function normalizeMethod(m: string): (typeof METHODS)[number] {
  const upper = m.toUpperCase()
  return (METHODS as readonly string[]).includes(upper) ? (upper as (typeof METHODS)[number]) : 'GET'
}

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    label: 'Пустой',
    hint: 'Ответ 200 и пустой объект — дальше правится в редакторе',
    path: '/custom/example',
    httpMethod: 'GET',
    title: 'Новый мок',
    responseStatusCode: 200,
    body: '{\n  "ok": true\n}',
  },
  {
    id: 'list',
    label: 'Список с пагинацией',
    hint: 'Конверт со списком и счётчиком — как у боевых списочных методов',
    path: '/custom/orders',
    httpMethod: 'GET',
    title: 'Список заказов',
    responseStatusCode: 200,
    body: [
      '{',
      '  "items": [',
      '    { "id": "{{uuid}}", "company": "{{faker.company}}", "city": "{{faker.city}}",',
      '      "amount": {{randomInt 1000 90000}}, "created_at": "{{now}}" }',
      '  ],',
      '  "total": {{randomInt 10 500}},',
      '  "next": null',
      '}',
    ].join('\n'),
  },
  {
    id: 'echo',
    label: 'Эхо запроса',
    hint: 'Возвращает то, что прислали: видно, как подставляются поля тела',
    path: '/custom/echo',
    httpMethod: 'POST',
    title: 'Эхо запроса',
    responseStatusCode: 200,
    body: [
      '{',
      '  "received": "{{request.body.name}}",',
      '  "query": "{{query.mode}}",',
      '  "at": "{{now}}"',
      '}',
    ].join('\n'),
  },
  {
    id: 'error',
    label: 'Ошибка лимита',
    hint: '429 с телом ошибки — чтобы проверить ретраи интеграции',
    path: '/custom/limited',
    httpMethod: 'GET',
    title: 'Превышен лимит',
    responseStatusCode: 429,
    body: '{\n  "error": "TOO_MANY_REQUESTS",\n  "retry_after": 30\n}',
  },
]

export function CreateMockDialog({
  onClose, onCreated, preset,
}: {
  onClose: () => void
  onCreated: (id: string) => void
  /**
   * Заготовка из другого экрана: консоль сохраняет ответ, который только что
   * получила, как свой мок — ровно то, что предлагает макет строкой
   * «сохранить как свой мок/запрос».
   */
  preset?: {
    httpMethod: string
    path: string
    title: string
    responseStatusCode: number
    responseBody: string
  }
}) {
  const [templateId, setTemplateId] = useState(preset ? 'preset' : 'blank')
  const template = preset && templateId === 'preset'
    ? { ...preset, id: 'preset', label: 'Из консоли', hint: '', httpMethod: normalizeMethod(preset.httpMethod), body: preset.responseBody }
    : (TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0]!)

  const [httpMethod, setHttpMethod] = useState<(typeof METHODS)[number]>(normalizeMethod(preset?.httpMethod ?? template.httpMethod))
  const [path, setPath] = useState(preset?.path ?? template.path)
  const [title, setTitle] = useState(preset?.title ?? template.title)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Выбор заготовки переписывает поля: пользователь ещё ничего не вводил вручную,
  // а если вводил — он это видит и поправит здесь же.
  function pickTemplate(id: string) {
    const t = TEMPLATES.find((x) => x.id === id)
    if (!t) return
    setTemplateId(id)
    setHttpMethod(t.httpMethod)
    setPath(t.path)
    setTitle(t.title)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const created = await api.post<{ id: string }>('/api/mocks', {
        httpMethod,
        path,
        title,
        status: 'draft',
        responseStatusCode: template.responseStatusCode,
        contentType: 'application/json',
        delayMs: 250,
        templatingEnabled: true,
        responseBody: template.body,
      })
      onCreated(created.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать мок')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog title="Новый мок" onClose={onClose} width={560}>
      <form onSubmit={submit} className="flex flex-col gap-[14px] p-[16px]">
        {preset ? (
          <p className="rounded-[6px] border border-border bg-bg px-[12px] py-[10px] text-[12px] leading-[1.5] text-text-secondary">
            Тело ответа взято из последнего вызова в консоли. Дальше его можно править
            в редакторе моков и добавить плейсхолдеры.
          </p>
        ) : (
        <div className="flex flex-col gap-[6px]">
          <span className="text-[12px] font-medium text-text-secondary">Заготовка</span>
          <div className="grid grid-cols-2 gap-[8px]">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pickTemplate(t.id)}
                className={`rounded-[8px] border p-[10px] text-left transition-colors ${
                  t.id === templateId
                    ? 'border-accent bg-accent-soft'
                    : 'border-border bg-surface hover:bg-bg'
                }`}
              >
                <span className="block text-[13px] font-semibold text-text-primary">{t.label}</span>
                <span className="mt-[3px] block text-[11px] leading-[1.4] text-text-tertiary">{t.hint}</span>
              </button>
            ))}
          </div>
        </div>
        )}

        <div className="flex gap-[10px]">
          <div className="flex w-[130px] shrink-0 flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-text-secondary">Метод</span>
            <select
              value={httpMethod}
              onChange={(e) => setHttpMethod(e.target.value as (typeof METHODS)[number])}
              aria-label="HTTP-метод"
              className="rounded-[6px] border border-border-strong bg-surface px-[12px] py-[9px] text-[13px] text-text-primary outline-none focus:border-accent"
            >
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <Field
              label="Путь"
              value={path}
              onChange={setPath}
              required
              placeholder="/custom/orders"
              hint="Мок отвечает по этому пути на домене песочницы"
            />
          </div>
        </div>

        <Field label="Название" value={title} onChange={setTitle} required />

        {error ? <FormError>{error}</FormError> : null}

        <div className="flex justify-end gap-[10px]">
          <ButtonSecondary onClick={onClose} type="button">Отмена</ButtonSecondary>
          <ButtonPrimary type="submit" disabled={pending}>
            {pending ? 'Создаю…' : 'Создать'}
          </ButtonPrimary>
        </div>
      </form>
    </Dialog>
  )
}
