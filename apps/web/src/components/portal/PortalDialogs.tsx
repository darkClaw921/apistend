'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { ButtonPrimary, ButtonSecondary, Panel, cn } from '@apistend/ui'
import type { B24PortalDeal } from '@/lib/b24'
import { dealPath, formatMoney, type PortalStaff } from './PortalChrome'

/**
 * Системные диалоги портала и слайдер.
 *
 * Приложение вызывает BX24.selectUser и получает выбранного сотрудника — но выбирает
 * его портал, а не приложение. Поэтому формат ответа боевой: {id, name} у сотрудников,
 * {deal: [...]} у сущностей CRM. Приложение, разобравшее ответ здесь, разберёт и в бою.
 */

export type DialogSpec =
  | { readonly kind: 'user'; readonly multiple: boolean }
  | { readonly kind: 'access'; readonly blocked: readonly string[] }
  | { readonly kind: 'crm'; readonly multiple: boolean; readonly entityTypes: readonly string[] }

export interface DialogRequest {
  readonly spec: DialogSpec
  readonly resolve: (value: unknown) => void
}

export function PortalDialogs({
  request, staff, deals, onResolve,
}: {
  request: DialogRequest | null
  staff: readonly PortalStaff[]
  deals: readonly B24PortalDeal[]
  onResolve: (value: unknown) => void
}) {
  if (!request) return null
  const { spec } = request

  if (spec.kind === 'user') {
    return (
      <DialogShell
        title={spec.multiple ? 'Выбор сотрудников' : 'Выбор сотрудника'}
        subtitle={spec.multiple ? 'BX24.selectUsers' : 'BX24.selectUser'}
        onCancel={() => onResolve(null)}
      >
        <UserPicker staff={staff} multiple={spec.multiple} onResolve={onResolve} />
      </DialogShell>
    )
  }

  if (spec.kind === 'access') {
    return (
      <DialogShell title="Выбор прав доступа" subtitle="BX24.selectAccess" onCancel={() => onResolve(null)}>
        <AccessPicker staff={staff} blocked={spec.blocked} onResolve={onResolve} />
      </DialogShell>
    )
  }

  return (
    <DialogShell title="Выбор сущности CRM" subtitle="BX24.selectCRM" onCancel={() => onResolve(null)}>
      <CrmPicker deals={deals} multiple={spec.multiple} entityTypes={spec.entityTypes} onResolve={onResolve} />
    </DialogShell>
  )
}

/**
 * Оболочка диалога. Диалог живёт внутри области портала, а не поверх всего кабинета:
 * его показывает портал, и приложение обязано видеть именно это.
 */
function DialogShell({
  title, subtitle, onCancel, children,
}: { title: string; subtitle: string; onCancel: () => void; children: ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="absolute inset-0 z-40 flex items-center justify-center bg-nav-bg/40 p-[24px]"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <Panel className="max-h-full w-full max-w-[460px]">
        <div className="flex shrink-0 items-center gap-[10px] border-b border-border px-[16px] py-[12px]">
          <h2 className="text-[14px] font-semibold text-text-primary">{title}</h2>
          <span className="font-mono text-[11px] text-text-tertiary">{subtitle}</span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Закрыть"
            className="ml-auto text-text-tertiary hover:text-text-secondary"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        {children}
      </Panel>
    </div>
  )
}

function PickerFooter({
  hint, disabled, onCancel, onSubmit,
}: { hint: string; disabled: boolean; onCancel: () => void; onSubmit: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-[10px] border-t border-border bg-surface-2 px-[16px] py-[10px]">
      <span className="text-[11px] text-text-tertiary">{hint}</span>
      <div className="ml-auto flex gap-[8px]">
        <ButtonSecondary tone="quiet" onClick={onCancel}>Отмена</ButtonSecondary>
        <ButtonPrimary onClick={onSubmit} disabled={disabled}>Выбрать</ButtonPrimary>
      </div>
    </div>
  )
}

function PickerRow({
  selected, onClick, title, subtitle, code, disabled,
}: {
  selected: boolean
  onClick: () => void
  title: string
  subtitle: string
  code?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center gap-[10px] border-b border-border px-[16px] py-[9px] text-left last:border-b-0 transition-colors',
        disabled ? 'cursor-not-allowed opacity-50' : selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-text-primary">{title}</span>
        <span className="truncate text-[11px] text-text-tertiary">{subtitle}</span>
      </span>
      {code ? <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{code}</span> : null}
    </button>
  )
}

function UserPicker({
  staff, multiple, onResolve,
}: { staff: readonly PortalStaff[]; multiple: boolean; onResolve: (value: unknown) => void }) {
  const [picked, setPicked] = useState<number[]>([])

  function toggle(id: number) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {staff.map((s) => (
          <PickerRow
            key={s.id}
            selected={picked.includes(s.id)}
            title={s.name}
            subtitle={s.position}
            code={`ID ${s.id}`}
            onClick={() => {
              if (multiple) { toggle(s.id); return }
              // Одиночный выбор закрывает диалог сразу — как и в боевом портале.
              onResolve({ id: s.id, name: s.name })
            }}
          />
        ))}
      </div>
      {multiple ? (
        <PickerFooter
          hint={`Выбрано ${picked.length}`}
          disabled={picked.length === 0}
          onCancel={() => onResolve(null)}
          onSubmit={() =>
            onResolve(
              staff.filter((s) => picked.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
            )
          }
        />
      ) : null}
    </>
  )
}

/**
 * Права доступа боевого портала кодируются строкой: U1 — сотрудник, D1 — подразделение,
 * AU — все авторизованные. Приложение сохраняет именно код, поэтому формат важнее списка.
 */
function AccessPicker({
  staff, blocked, onResolve,
}: { staff: readonly PortalStaff[]; blocked: readonly string[]; onResolve: (value: unknown) => void }) {
  const options = [
    { id: 'AU', name: 'Все авторизованные пользователи', hint: 'Любой сотрудник портала' },
    { id: 'D1', name: 'Вся компания', hint: 'Корневое подразделение' },
    ...staff.map((s) => ({ id: `U${s.id}`, name: s.name, hint: s.position })),
  ]
  const [picked, setPicked] = useState<string[]>([])

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {options.map((o) => (
          <PickerRow
            key={o.id}
            selected={picked.includes(o.id)}
            disabled={blocked.includes(o.id)}
            title={o.name}
            subtitle={o.hint}
            code={o.id}
            onClick={() => setPicked((cur) => (cur.includes(o.id) ? cur.filter((x) => x !== o.id) : [...cur, o.id]))}
          />
        ))}
      </div>
      <PickerFooter
        hint={`Выбрано ${picked.length}`}
        disabled={picked.length === 0}
        onCancel={() => onResolve(null)}
        onSubmit={() => onResolve(options.filter((o) => picked.includes(o.id)).map((o) => ({ id: o.id, name: o.name })))}
      />
    </>
  )
}

function CrmPicker({
  deals, multiple, entityTypes, onResolve,
}: {
  deals: readonly B24PortalDeal[]
  multiple: boolean
  entityTypes: readonly string[]
  onResolve: (value: unknown) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const otherTypes = entityTypes.filter((t) => t.toLowerCase() !== 'deal')

  function result(ids: readonly string[]): unknown {
    return {
      deal: deals
        .filter((d) => ids.includes(d.id))
        .map((d) => ({
          id: d.id,
          type: 'deal',
          place: 'DEAL',
          title: d.title,
          desc: `${d.stage} · ${formatMoney(d.opportunity)}`,
          url: dealPath(d.id),
        })),
    }
  }

  return (
    <>
      {otherTypes.length > 0 ? (
        <p className="shrink-0 border-b border-border bg-warning-soft/50 px-[16px] py-[8px] text-[11px] leading-[1.5] text-text-secondary">
          Приложение просило {otherTypes.join(', ')}. В демонстрационном портале заведены только сделки —
          остальные сущности CRM доступны через REST, но выбирать их не из чего.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {deals.length === 0 ? (
          <p className="px-[16px] py-[24px] text-center text-[13px] text-text-secondary">
            Сделок в песочнице нет: каталог моков не собран.
          </p>
        ) : (
          deals.map((d) => (
            <PickerRow
              key={d.id}
              selected={picked.includes(d.id)}
              title={d.title}
              subtitle={`${d.stage} · ${formatMoney(d.opportunity)}`}
              code={`ID ${d.id}`}
              onClick={() => {
                if (multiple) {
                  setPicked((cur) => (cur.includes(d.id) ? cur.filter((x) => x !== d.id) : [...cur, d.id]))
                  return
                }
                onResolve(result([d.id]))
              }}
            />
          ))
        )}
      </div>
      {multiple ? (
        <PickerFooter
          hint={`Выбрано ${picked.length}`}
          disabled={picked.length === 0}
          onCancel={() => onResolve(null)}
          onSubmit={() => onResolve(result(picked))}
        />
      ) : null}
    </>
  )
}

/**
 * Слайдер портала: фрейм поверх страницы. Так открывается BX24.openApplication
 * и точки встраивания с surface slider — виджет не заменяет страницу, а лежит на ней.
 */
export function AppSlider({
  title, subtitle, onClose, children,
}: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-30 flex justify-end bg-nav-bg/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <section
        aria-label={`Слайдер приложения «${title}»`}
        className="flex h-full w-[74%] min-w-[420px] flex-col border-l border-border bg-surface"
      >
        <header className="flex shrink-0 items-center gap-[10px] border-b border-border px-[16px] py-[10px]">
          <span className="truncate text-[13px] font-semibold text-text-primary">{title}</span>
          <span className="font-mono text-[11px] text-text-tertiary">{subtitle}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть слайдер"
            className="ml-auto text-text-tertiary hover:text-text-secondary"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
      </section>
    </div>
  )
}
