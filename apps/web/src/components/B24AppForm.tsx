'use client'

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { ButtonPrimary, ButtonSecondary, Panel, SearchField, SegmentControl, formatInt } from '@apistend/ui'
import {
  B24_REFRESH_TTL_MAX_SECONDS, B24_REFRESH_TTL_MIN_SECONDS, B24_REFRESH_TTL_SECONDS,
  B24_TOKEN_TTL_MAX_SECONDS, B24_TOKEN_TTL_MIN_SECONDS, B24_TOKEN_TTL_PRESETS,
  B24_TOKEN_TTL_SECONDS, clampRefreshTtl, clampTokenTtl,
} from '@apistend/shared'
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

/**
 * Короткие сроки refresh_token для быстрого выбора.
 *
 * Боевые 180 суток проверить нечем: до них не доживает ни одна отладка. А ветка
 * «обновлять уже нечем» — refresh_token тоже истёк, приложение обязано отправить
 * пользователя проходить установку заново — пишется реже всего и ломается чаще всего.
 */
const REFRESH_TTL_PRESETS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 60, label: 'минута' },
  { seconds: 300, label: '5 минут' },
  { seconds: 3600, label: 'час' },
  { seconds: 86_400, label: 'сутки' },
  { seconds: B24_REFRESH_TTL_SECONDS, label: '180 суток' },
]

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/**
 * Срок словами: «10 секунд», «час», «180 суток».
 *
 * Живёт рядом с формой, а не в @apistend/ui: подписи должны совпадать
 * с B24_TOKEN_TTL_PRESETS дословно, иначе выбранное в форме и показанное
 * в карточке приложения читаются как разные значения. Карточка берёт его отсюда.
 */
export function formatTokenTtl(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    const days = seconds / 86_400
    return days === 1 ? 'сутки' : `${formatInt(days)} ${plural(days, 'сутки', 'суток', 'суток')}`
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600
    return hours === 1 ? 'час' : `${formatInt(hours)} ${plural(hours, 'час', 'часа', 'часов')}`
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60
    return minutes === 1 ? 'минута' : `${formatInt(minutes)} ${plural(minutes, 'минута', 'минуты', 'минут')}`
  }
  return `${formatInt(seconds)} ${plural(seconds, 'секунда', 'секунды', 'секунд')}`
}

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
  // Сроки держим строками: пустое поле и «3e2» должны доживать до проверки границ,
  // а не превращаться в NaN прямо под курсором.
  const [tokenTtl, setTokenTtl] = useState(String(app?.tokenTtlSeconds ?? B24_TOKEN_TTL_SECONDS))
  const [refreshTtl, setRefreshTtl] = useState(String(app?.refreshTtlSeconds ?? B24_REFRESH_TTL_SECONDS))
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
  // Границы те же, что проверит сервер: промах должен быть виден до отправки.
  const tokenTtlValue = Number(tokenTtl.trim())
  const refreshTtlValue = Number(refreshTtl.trim())
  const tokenTtlValid = Number.isInteger(tokenTtlValue) && clampTokenTtl(tokenTtlValue) === tokenTtlValue
  const refreshTtlValid = Number.isInteger(refreshTtlValue) && clampRefreshTtl(refreshTtlValue) === refreshTtlValue
  const tokenPreset = B24_TOKEN_TTL_PRESETS.find((p) => p.seconds === tokenTtlValue)
  const valid = title.trim().length >= 2 && codeValid && handlerValid && installValid
    && tokenTtlValid && refreshTtlValid

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
          tokenTtlSeconds: tokenTtlValue,
          refreshTtlSeconds: refreshTtlValue,
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

          <div className="flex flex-col gap-[8px]">
            <div className="flex items-baseline justify-between gap-[10px]">
              <span className="text-[12px] font-medium text-text-secondary">Срок жизни токенов</span>
              <span className="text-[11px] text-text-tertiary">в бою — час и 180 суток</span>
            </div>

            <SegmentControl
              segments={B24_TOKEN_TTL_PRESETS.map((p) => ({ value: String(p.seconds), label: p.label }))}
              value={tokenTtl.trim()}
              onChange={setTokenTtl}
            />
            <span className="text-[11px] leading-[1.4] text-text-tertiary">
              {tokenPreset
                ? tokenPreset.hint
                : `Своё значение: от ${formatTokenTtl(B24_TOKEN_TTL_MIN_SECONDS)} до ${formatTokenTtl(B24_TOKEN_TTL_MAX_SECONDS)}`}
            </span>

            <div className="grid grid-cols-2 gap-[10px]">
              <Field
                label="access_token, секунд"
                value={tokenTtl}
                onChange={setTokenTtl}
                inputMode="numeric"
                hint={
                  tokenTtlValid
                    ? `Выданная пара проживёт ${formatTokenTtl(tokenTtlValue)}`
                    : `Допустимо целое от ${formatInt(B24_TOKEN_TTL_MIN_SECONDS)} до ${formatInt(B24_TOKEN_TTL_MAX_SECONDS)} секунд`
                }
              />
              <Field
                label="refresh_token, секунд"
                value={refreshTtl}
                onChange={setRefreshTtl}
                inputMode="numeric"
                hint={
                  refreshTtlValid
                    ? `Обменять на новую пару можно ${formatTokenTtl(refreshTtlValue)}; боевое значение — 180 суток`
                    : `Допустимо целое от ${formatInt(B24_REFRESH_TTL_MIN_SECONDS)} до ${formatInt(B24_REFRESH_TTL_MAX_SECONDS)} секунд`
                }
              />
            </div>

            <div className="flex flex-wrap items-center gap-[6px]">
              <span className="text-[11px] text-text-tertiary">Короткий refresh_token:</span>
              {REFRESH_TTL_PRESETS.map((p) => (
                <button
                  key={p.seconds}
                  type="button"
                  onClick={() => setRefreshTtl(String(p.seconds))}
                  className={`rounded-[4px] px-[7px] py-[3px] text-[11px] ${
                    p.seconds === refreshTtlValue
                      ? 'bg-accent-soft text-accent'
                      : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <p className="text-[11px] leading-[1.4] text-text-tertiary">
              Боевой портал всегда выдаёт access_token на час, и настройки срока у него нет.
              Короткий срок нужен ровно для одной проверки: дождаться 401 expired_token и увидеть,
              как приложение само меняет refresh_token на новую пару. Обновлять по расписанию не надо —
              документация Bitrix24 предписывает дождаться ошибки.
            </p>

            {tokenTtlValid && tokenTtlValue !== B24_TOKEN_TTL_SECONDS ? (
              <p className="rounded-[6px] bg-warning-soft px-[10px] py-[7px] text-[11px] leading-[1.4] text-warning">
                {formatTokenTtl(tokenTtlValue)} вместо часа — расхождение с боем: такого срока
                на настоящем портале приложение не увидит никогда. Перед переносом верните 3600,
                иначе проверенным окажется поведение, которого в бою не будет.
              </p>
            ) : null}
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
