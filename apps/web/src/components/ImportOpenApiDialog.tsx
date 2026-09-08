'use client'

import { useState } from 'react'
import { FileUp } from 'lucide-react'
import { ButtonPrimary, ButtonSecondary, Dialog } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { Field, FormError } from './Field'

interface ImportResult {
  created: number
  skipped: number
  examples: string[]
  /** Операции, до которых импорт не дошёл из-за потолка за один заход. */
  leftOver: number
  limit: number
}

/**
 * Импорт своих моков из OpenAPI 3.x.
 *
 * Файл уходит на сервер целиком: разбор там делает тот же код, которым собран
 * каталог Ozon и Wildberries (@apistend/catalog-ingest). Повторять разбор
 * в браузере ради одной кнопки было бы вторым источником правды.
 */
export function ImportOpenApiDialog({
  onClose, onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [document, setDocument] = useState('')
  const [pathPrefix, setPathPrefix] = useState('/custom/imported')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setDocument(await file.text())
    setError(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      setResult(await api.post('/api/mocks/import', { document, pathPrefix, status: 'draft' }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось импортировать файл')
    } finally {
      setPending(false)
    }
  }

  if (result) {
    return (
      <Dialog title="Импорт завершён" onClose={onImported}>
        <div className="flex flex-col gap-[12px] p-[16px]">
          <p className="text-[13px] leading-[1.55] text-text-secondary">
            Создано моков: <b className="text-text-primary">{result.created}</b>.
            {result.skipped > 0 ? ` Пропущено как уже существующие: ${result.skipped}.` : ''}
          </p>
          {result.leftOver > 0 ? (
            // Потолок в 100 операций за заход раньше срабатывал молча, и ответ
            // «создано 100» на файле из 460 читался как «импортировано всё».
            <p className="rounded-[6px] border border-warning/40 bg-warning-soft px-[12px] py-[10px] text-[12px] leading-[1.5] text-text-secondary">
              За потолком в {result.limit} операций осталось ещё{' '}
              <b className="text-text-primary">{result.leftOver}</b>. Повторите импорт того же
              файла — уже созданные моки пропустятся как дубли, и очередь продвинется дальше.
            </p>
          ) : null}
          {result.examples.length > 0 ? (
            <ul className="flex flex-col gap-[4px] rounded-[6px] border border-border bg-bg p-[12px]">
              {result.examples.map((e) => (
                <li key={e} className="font-mono text-[12px] text-text-secondary">{e}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-[12px] leading-[1.5] text-text-tertiary">
            Все импортированные моки — черновики: они не отвечают, пока их не включить.
            Тело ответа взято из примера в спецификации; там, где примера не было,
            стоит пустой объект.
          </p>
          <ButtonPrimary onClick={onImported} className="w-full">Готово</ButtonPrimary>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Импорт из OpenAPI" onClose={onClose} width={520}>
      <form onSubmit={submit} className="flex flex-col gap-[14px] p-[16px]">
        <label className="flex cursor-pointer flex-col items-center gap-[8px] rounded-[8px] border border-dashed border-border-strong bg-bg px-[16px] py-[24px] text-center hover:border-accent">
          <FileUp size={20} className="text-text-tertiary" aria-hidden />
          <span className="text-[13px] font-medium text-text-primary">
            {fileName ?? 'Выберите файл спецификации'}
          </span>
          <span className="text-[11px] text-text-tertiary">OpenAPI 3.x — JSON или YAML</span>
          <input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(e) => void pickFile(e)} className="hidden" />
        </label>

        <Field
          label="Префикс пути"
          value={pathPrefix}
          onChange={setPathPrefix}
          hint="Добавляется к путям из файла. Начинается с /custom — по этому адресу песочница обслуживает свои моки"
        />

        {error ? <FormError>{error}</FormError> : null}

        <div className="flex justify-end gap-[10px]">
          <ButtonSecondary onClick={onClose} type="button">Отмена</ButtonSecondary>
          <ButtonPrimary type="submit" disabled={pending || document.length === 0}>
            {pending ? 'Импортирую…' : 'Импортировать'}
          </ButtonPrimary>
        </div>
      </form>
    </Dialog>
  )
}
