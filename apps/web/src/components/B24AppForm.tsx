'use client'

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { ButtonPrimary, ButtonSecondary, Panel, SearchField, SegmentControl } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import type { B24AppDetail, B24AppKind, B24ScopeOption } from '@/lib/b24'
import { Field, FormError } from './Field'

/**
 * Регистрация локального приложения. Состав полей повторяет форму боевого портала:
 * разработчик заполняет здесь то же самое, что заполнял бы в разделе «Приложения
 * для разработчиков», и переносит карточку на бой без переделки.
 *
 * Отдельного переключателя вида в боевой форме нет — там вид выводится из того,
 * какие поля заполнены. Здесь он спрашивается явно: иначе исчезновение половины
 * полей выглядит случайностью.
 */

/** Подписи вида для формы: в переключателе места хватает. */
export const B24_APP_KIND_LABEL: Readonly<Record<B24AppKind, string>> = {
  server_ui: 'Серверное с интерфейсом',
  api_only: 'Только API',
}

/** То же для чипа в таблице, где колонка узкая и длинная подпись обрезается. */
export const B24_APP_KIND_SHORT: Readonly<Record<B24AppKind, string>> = {
  server_ui: 'С интерфейсом',
  api_only: 'Только API',
}

/** Права, отмеченные в новой карточке: без них не работают ни CRM, ни виджеты. */
const DEFAULT_SCOPE = ['crm', 'placement']

const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
}

/** Код приложения — только латиница: русские буквы боевой портал в нём не принимает. */
function codeFromTitle(title: string): string {
  const latin = [...title.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('')
  return latin.replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 48)
}

/** Портал открывает обработчик как страницу, поэтому годится только http и https. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

interface Props {
  scopes: B24ScopeOption[]
  /** Задано — форма редактирует карточку, иначе создаёт новую. */
  app?: B24AppDetail
  onCancel: () => void
  onSaved: (app: B24AppDetail) => void
}

export function B24AppForm({ scopes, app, onCancel, onSaved }: Props) {
  const [title, setTitle] = useState(app?.title ?? '')
  const [code, setCode] = useState(app?.code ?? '')
  // Пока код не правили руками, он идёт следом за названием.
  const [codeTouched, setCodeTouched] = useState(app !== undefined)
  const [kind, setKind] = useState<B24AppKind>(app?.kind ?? 'server_ui')
  const [handlerUrl, setHandlerUrl] = useState(app?.handlerUrl ?? '')
  const [installUrl, setInstallUrl] = useState(app?.installUrl ?? '')
  const [menuTitle, setMenuTitle] = useState(app?.menuTitle ?? '')
  const [scope, setScope] = useState<string[]>(app?.scope ?? DEFAULT_SCOPE)
  const [scopeQuery, setScopeQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const visibleScopes = useMemo(() => {
    const q = scopeQuery.trim().toLowerCase()
    if (q === '') return scopes
    return scopes.filter((s) => s.code.includes(q) || s.title.toLowerCase().includes(q))
  }, [scopes, scopeQuery])

  const codeValid = CODE_PATTERN.test(code)
  const handlerValid = kind === 'api_only' || isHttpUrl(handlerUrl)
  const installValid = installUrl.trim() === '' || isHttpUrl(installUrl)
  const valid = title.trim().length >= 2 && codeValid && handlerValid && installValid

  function toggleScope(value: string) {
    setScope((s) => (s.includes(value) ? s.filter((x) => x !== value) : [...s, value]))
  }

  function changeTitle(value: string) {
    setTitle(value)
    if (!codeTouched) setCode(codeFromTitle(value))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setPending(true)
    setError(null)
    try {
      const res = await api.post<{ app: B24AppDetail }>(
        app ? `/api/b24/apps/${app.id}/update` : '/api/b24/apps',
        {
          title: title.trim(),
          code,
          kind,
          scope,
          handlerUrl: kind === 'server_ui' ? handlerUrl.trim() : undefined,
          installUrl: installUrl.trim() === '' ? undefined : installUrl.trim(),
          menuTitle: kind === 'server_ui' && menuTitle.trim() !== '' ? menuTitle.trim() : undefined,
        },
      )
      onSaved(res.app)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить приложение')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={app ? 'Изменить приложение' : 'Создать приложение'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-nav-bg/40 p-[24px]"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <Panel className="max-h-full w-full max-w-[560px]">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-[16px] py-[13px]">
          <h2 className="text-[14px] font-semibold text-text-primary">
            {app ? `Приложение «${app.title}»` : 'Новое локальное приложение'}
          </h2>
          <button type="button" onClick={onCancel} aria-label="Закрыть"
            className="text-text-tertiary hover:text-text-secondary">
            <X size={16} aria-hidden />
          </button>
        </div>

        <form id="b24-app-form" onSubmit={submit}
          className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto scrollbar-thin p-[16px]">
          <Field
            label="Название приложения"
            value={title}
            onChange={changeTitle}
            required
            autoFocus
            hint="Так приложение подписано в списке приложений портала"
          />

          <Field
            label="Код приложения"
            value={code}
            onChange={(v) => { setCodeTouched(true); setCode(v) }}
            required
            hint={
              codeValid || code === ''
                ? 'Латиница, цифры, точка, дефис и подчёркивание. Боевой портал выдаёт локальному приложению код вида local.5f3c1e2b — здесь можно задать читаемый.'
                : 'Только латиница, цифры, точка, дефис и подчёркивание; первый символ — буква или цифра'
            }
          />

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-text-secondary">Вид приложения</span>
            <SegmentControl
              segments={[
                { value: 'server_ui', label: B24_APP_KIND_LABEL.server_ui },
                { value: 'api_only', label: B24_APP_KIND_LABEL.api_only },
              ]}
              value={kind}
              onChange={(v) => setKind(v as B24AppKind)}
            />
            <span className="text-[11px] leading-[1.4] text-text-tertiary">
              {kind === 'server_ui'
                ? 'Портал открывает приложение во фрейме и передаёт токены POST-запросом.'
                : 'Интерфейса нет: приложение получает токены на обработчик установки и дальше ходит в REST само.'}
            </span>
          </div>

          {kind === 'server_ui' ? (
            <Field
              label="Путь вашего обработчика"
              value={handlerUrl}
              onChange={setHandlerUrl}
              required
              placeholder="http://localhost:3000/b24/handler"
              hint={
                handlerUrl === '' || isHttpUrl(handlerUrl)
                  ? 'Этот адрес портал откроет во фрейме. Боевой Bitrix24 требует здесь https и отказывает localhost — APIStend принимает и то и другое.'
                  : 'Адрес не разбирается: нужен полный URL со схемой http или https'
              }
            />
          ) : null}

          <Field
            label="Путь для первоначальной установки"
            value={installUrl}
            onChange={setInstallUrl}
            placeholder={kind === 'server_ui' ? 'http://localhost:3000/b24/install' : 'http://localhost:3000/b24/onappinstall'}
            hint={
              installUrl !== '' && !isHttpUrl(installUrl)
                ? 'Адрес не разбирается: нужен полный URL со схемой http или https'
                : kind === 'server_ui'
                  ? 'Мастер установки. Показывается один раз, и до вызова BX24.installFinish() приложение считается неустановленным: события не доставляются, виджеты не показываются.'
                  : 'Сюда придёт ONAPPINSTALL — POST с токенами. Мастер установки не открывается, приложение обязано ответить сервером.'
            }
          />

          {kind === 'server_ui' ? (
            <Field
              label="Название пункта меню"
              value={menuTitle}
              onChange={setMenuTitle}
              hint="Под этим именем приложение появится в левом меню портала"
            />
          ) : null}

          <div className="flex flex-col gap-[8px]">
            <div className="flex items-baseline justify-between gap-[10px]">
              <span className="text-[12px] font-medium text-text-secondary">Права доступа</span>
              <span className="font-mono text-[11px] text-text-tertiary tabular">выбрано {scope.length}</span>
            </div>

            {scope.length > 0 ? (
              <div className="flex flex-wrap gap-[6px]">
                {scope.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleScope(s)}
                    aria-label={`Убрать право ${s}`}
                    className="inline-flex items-center gap-[5px] rounded-[4px] bg-accent-soft px-[7px] py-[3px] font-mono text-[11px] text-accent hover:bg-surface-3"
                  >
                    {s}
                    <X size={11} aria-hidden />
                  </button>
                ))}
              </div>
            ) : null}

            <SearchField
              value={scopeQuery}
              onValueChange={setScopeQuery}
              placeholder="Поиск по коду или названию"
              width="full"
              matches={visibleScopes.length}
            />

            <div className="max-h-[180px] overflow-y-auto scrollbar-thin rounded-[6px] border border-border">
              {visibleScopes.map((s) => (
                <label
                  key={s.code}
                  className="flex cursor-pointer items-center gap-[10px] border-b border-border px-[10px] py-[7px] last:border-b-0 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={scope.includes(s.code)}
                    onChange={() => toggleScope(s.code)}
                    className="h-[14px] w-[14px] shrink-0 accent-accent"
                  />
                  <span className="w-[132px] shrink-0 truncate font-mono text-[12px] text-text-primary">{s.code}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">{s.title}</span>
                </label>
              ))}
              {visibleScopes.length === 0 ? (
                <p className="px-[10px] py-[12px] text-center text-[12px] text-text-tertiary">Ничего не нашлось</p>
              ) : null}
            </div>

            <p className="text-[11px] leading-[1.4] text-text-tertiary">
              Права проверяются на каждом вызове REST: без нужного портал отвечает insufficient_scope.
              Без placement приложение не сможет зарегистрировать ни одного виджета.
            </p>
          </div>

          {error ? <FormError>{error}</FormError> : null}
        </form>

        <div className="flex shrink-0 gap-[8px] border-t border-border bg-surface-2 px-[16px] py-[12px]">
          <ButtonSecondary onClick={onCancel} className="flex-1">Отмена</ButtonSecondary>
          <ButtonPrimary type="submit" form="b24-app-form" disabled={!valid || pending} className="flex-1">
            {pending ? 'Сохраняем…' : app ? 'Сохранить' : 'Создать приложение'}
          </ButtonPrimary>
        </div>
      </Panel>
    </div>
  )
}
