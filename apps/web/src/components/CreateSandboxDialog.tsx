'use client'

import { useState } from 'react'
import { ButtonPrimary, ButtonSecondary, Dialog } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { Field, FormError } from './Field'

/**
 * Создание песочницы.
 *
 * Песочница — граница всего, что принадлежит работе: своих ключей, вебхуков,
 * своих моков, журнала запросов и личных изменений демо-данных. Вторая нужна
 * ровно тогда, когда работ две: одна под отлаживаемую интеграцию, другая под
 * демонстрацию заказчику или под автотесты, которые сбрасывают данные.
 *
 * Возможность была в Management API с самого начала, а в кабинете её не было,
 * и меню честно писало «вторая песочница пока не заводится». Теперь заводится.
 */
export function CreateSandboxDialog({
  onClose, onCreated,
}: {
  onClose: () => void
  /** Получает идентификатор новой песочницы: кабинет сразу на неё переключается. */
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [project, setProject] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const created = await api.post<{ id: string }>('/api/v1/sandboxes', {
        name: name.trim(),
        project: project.trim() || 'Без названия',
      })
      onCreated(created.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать песочницу')
      setPending(false)
    }
  }

  return (
    <Dialog title="Новая песочница" onClose={onClose} width={440}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-[14px] p-[20px]">
        <Field
          label="Имя"
          hint="Короткое, латиницей — оно видно в переключателе"
          value={name}
          onChange={setName}
          placeholder="sandbox-02"
          autoFocus
        />

        <Field
          label="Проект"
          hint="Показывается в хлебных крошках. Можно оставить пустым"
          value={project}
          onChange={setProject}
          placeholder="Интеграция с 1С"
        />

        <p className="text-[12px] leading-[1.5] text-text-tertiary">
          Песочница создаётся пустой: ключи, вебхуки и свои моки в неё не переносятся.
          Ключ для неё выпускается отдельно на экране «Ключи и токены».
        </p>

        {error ? <FormError>{error}</FormError> : null}

        <div className="flex gap-[8px]">
          <ButtonSecondary onClick={onClose} className="flex-1">Отмена</ButtonSecondary>
          <ButtonPrimary type="submit" disabled={pending || name.trim().length < 2} className="flex-1">
            {pending ? 'Создаём…' : 'Создать и перейти'}
          </ButtonPrimary>
        </div>
      </form>
    </Dialog>
  )
}
