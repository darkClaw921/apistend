'use client'

import type { ReactNode } from 'react'
import { AppWindow, Handshake, HardDrive, ListChecks, MessageSquare, Newspaper, Puzzle } from 'lucide-react'
import { SegmentControl, ServiceSquare, StatusChip, cn, formatInt } from '@apistend/ui'
import type { B24MenuItem, B24Portal } from '@/lib/b24'

/**
 * Обвязка демонстрационного портала: шапка, левое меню, заголовок рабочей области.
 *
 * Это не копия интерфейса Bitrix24, а узнаваемая обстановка вокруг фрейма: разработчик
 * должен видеть приложение там же, где увидит его в бою — сбоку меню, сверху домен
 * и сотрудник, в центре его собственная страница.
 */

export interface PortalStaff {
  readonly id: number
  readonly name: string
  readonly position: string
  readonly isAdmin: boolean
}

/**
 * Сотрудники портала.
 *
 * Список повторяет PORTAL_USERS сервера: диалог выбора обязан возвращать тех же людей,
 * которых приложение получит из user.get. Иначе выбранный id ничему в REST
 * не соответствует, и приложение, сохранившее его, сломается на первом же вызове.
 */
export const PORTAL_STAFF: readonly PortalStaff[] = [
  { id: 1, name: 'Анна Ковалёва', position: 'Руководитель отдела продаж', isAdmin: true },
  { id: 6, name: 'Дмитрий Соколов', position: 'Менеджер по продажам', isAdmin: false },
  { id: 9, name: 'Ольга Титова', position: 'Менеджер по продажам', isAdmin: false },
  { id: 14, name: 'Павел Жуков', position: 'Технический специалист', isAdmin: false },
  { id: 21, name: 'Мария Лебедева', position: 'Бухгалтер', isAdmin: false },
]

/** Список сотрудников с учётом того, кого порталом считает сервер. */
export function portalStaff(portal: B24Portal): PortalStaff[] {
  const current = portal.currentUser
  const known = PORTAL_STAFF.find((s) => s.id === current.id)
  if (known) return [...PORTAL_STAFF]
  return [{ id: current.id, name: current.name, position: 'Администратор портала', isAdmin: current.isAdmin }, ...PORTAL_STAFF]
}

/** Путь карточки сделки. Он же уходит в PLACEMENT_OPTIONS.URI и принимается BX24.openPath. */
export function dealPath(id: string): string {
  return `/crm/deal/details/${id}/`
}

export function formatMoney(raw: string): string {
  const value = Number(raw)
  return Number.isFinite(value) ? `${formatInt(Math.round(value))} ₽` : '—'
}

/** Места открытия приложения. Совпадают с тем, как их видит разработчик в placement.bind. */
export type PortalSurface = 'page' | 'deal' | 'slider'

export function PortalTopbar({
  portal, staff, actingId, onActingChange, surface, onSurfaceChange, logOpen, onLogToggle, onReopen, reopening,
}: {
  portal: B24Portal
  staff: readonly PortalStaff[]
  actingId: number
  onActingChange: (id: number) => void
  surface: PortalSurface
  onSurfaceChange: (surface: PortalSurface) => void
  logOpen: boolean
  onLogToggle: () => void
  onReopen: () => void
  reopening: boolean
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-[12px] border-b border-border bg-surface px-[14px] py-[10px]">
      <span className="flex items-center gap-[8px]">
        <ServiceSquare service="bitrix24" size={24} />
        <span className="flex flex-col">
          <span className="font-mono text-[12px] leading-tight font-semibold text-text-primary">{portal.domain}</span>
          <span className="text-[10px] leading-tight text-text-tertiary">Демонстрационный портал</span>
        </span>
      </span>

      {/* PROTOCOL приложение получает в query-строке и обязано его увидеть. */}
      <StatusChip
        tone={portal.protocol === '1' ? 'success' : 'neutral'}
        className="cursor-default"
      >
        <span title="Боевой Bitrix24 принимает только https. Локальному порталу это не нужно, и приложение видит PROTOCOL=0.">
          {portal.protocol === '1' ? 'https' : 'http'}
        </span>
      </StatusChip>

      <label className="flex items-center gap-[6px]">
        <span className="text-[11px] text-text-tertiary">Сотрудник</span>
        <select
          value={actingId}
          onChange={(e) => onActingChange(Number(e.target.value))}
          className="rounded-[6px] border border-border-strong bg-surface px-[8px] py-[5px] text-[12px] text-text-primary outline-none focus:border-accent"
        >
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.isAdmin ? ' — администратор' : ''}
            </option>
          ))}
        </select>
      </label>

      <SegmentControl
        segments={[
          { value: 'page', label: 'Основная страница' },
          { value: 'deal', label: 'Карточка сделки' },
          { value: 'slider', label: 'Слайдер' },
        ]}
        value={surface}
        onChange={(v) => onSurfaceChange(v as PortalSurface)}
      />

      <div className="ml-auto flex items-center gap-[8px]">
        <button
          type="button"
          onClick={onReopen}
          disabled={reopening}
          className="rounded-[6px] border border-border-strong bg-surface px-[12px] py-[7px] text-[12px] font-semibold text-text-secondary transition-colors hover:enabled:bg-surface-2 disabled:text-text-tertiary"
        >
          {reopening ? 'Открываем…' : 'Открыть заново'}
        </button>
        <button
          type="button"
          onClick={onLogToggle}
          aria-pressed={logOpen}
          className={cn(
            'rounded-[6px] border px-[12px] py-[7px] text-[12px] font-semibold transition-colors',
            logOpen ? 'border-accent bg-accent-soft text-accent' : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-2',
          )}
        >
          Журнал моста
        </button>
      </div>
    </header>
  )
}

/** Разделы портала. Кликабелен только CRM: он ведёт в карточку сделки, где живут вкладки приложений. */
const PORTAL_SECTIONS = [
  { code: 'feed', title: 'Лента', icon: Newspaper },
  { code: 'chat', title: 'Чат и звонки', icon: MessageSquare },
  { code: 'tasks', title: 'Задачи', icon: ListChecks },
  { code: 'crm', title: 'CRM', icon: Handshake },
  { code: 'disk', title: 'Диск', icon: HardDrive },
] as const

export function PortalSidebar({
  menu, activeIndex, surface, onSelectApp, onOpenCrm,
}: {
  menu: readonly B24MenuItem[]
  /** Индекс выбранного пункта меню приложений; −1 — открыто не из меню. */
  activeIndex: number
  surface: PortalSurface
  onSelectApp: (index: number) => void
  onOpenCrm: () => void
}) {
  return (
    <nav className="flex w-[196px] shrink-0 flex-col gap-[10px] overflow-y-auto scrollbar-thin border-r border-border bg-surface px-[8px] py-[12px]">
      <ul className="flex flex-col gap-[1px]">
        {PORTAL_SECTIONS.map((s) => {
          const Icon = s.icon
          if (s.code !== 'crm') {
            return (
              <li
                key={s.code}
                title="Раздел портала показан для обстановки: APIStend воспроизводит открытие приложений, а не сам Bitrix24"
                className="flex cursor-default items-center gap-[9px] rounded-[6px] px-[9px] py-[7px] text-[13px] text-text-tertiary"
              >
                <Icon size={15} className="shrink-0" aria-hidden />
                <span className="truncate">{s.title}</span>
              </li>
            )
          }
          return (
            <li key={s.code}>
              <button
                type="button"
                onClick={onOpenCrm}
                aria-current={surface === 'deal' ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-[9px] rounded-[6px] px-[9px] py-[7px] text-left text-[13px] transition-colors',
                  surface === 'deal'
                    ? 'bg-accent font-semibold text-white'
                    : 'font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                )}
              >
                <Icon size={15} className="shrink-0" aria-hidden />
                <span className="truncate">{s.title}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="px-[9px] pt-[6px] text-[10px] font-semibold tracking-[0.6px] text-text-tertiary uppercase">
        Приложения
      </div>

      {menu.length === 0 ? (
        <p className="px-[9px] text-[11px] leading-[1.5] text-text-tertiary">
          Пункты появятся после установки приложения: до installFinish портал виджеты не показывает.
        </p>
      ) : (
        <ul className="flex flex-col gap-[1px]">
          {menu.map((item, index) => {
            const active = surface === 'page' && index === activeIndex
            const Icon = item.placement === 'DEFAULT' ? AppWindow : Puzzle
            return (
              <li key={`${item.appId}-${item.placement}-${index}`}>
                <button
                  type="button"
                  onClick={() => onSelectApp(index)}
                  aria-current={active ? 'page' : undefined}
                  title={`${item.placement} → ${item.handler}`}
                  className={cn(
                    'flex w-full items-center gap-[9px] rounded-[6px] px-[9px] py-[7px] text-left text-[13px] transition-colors',
                    active
                      ? 'bg-accent font-semibold text-white'
                      : 'font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                  )}
                >
                  <Icon size={15} className="shrink-0" aria-hidden />
                  <span className="truncate">{item.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-auto px-[9px] text-[10px] leading-[1.5] text-text-tertiary">
        Разделы портала — обстановка. Работают приложения: их страницы открываются
        ровно так же, как открыл бы боевой Bitrix24.
      </p>
    </nav>
  )
}

/** Заголовок рабочей области: чем портал считает открытое сейчас приложение. */
export function WorkspaceHeader({
  title, placement, appSid, install, right,
}: {
  title: string
  placement: string
  appSid: string | null
  install: boolean
  right?: ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-[10px] border-b border-border bg-surface px-[16px] py-[9px]">
      <span className="truncate text-[13px] font-semibold text-text-primary">{title}</span>
      {install ? <StatusChip tone="warning">Мастер установки</StatusChip> : null}
      <span className="ml-auto flex items-center gap-[10px] font-mono text-[11px] text-text-tertiary">
        <span>PLACEMENT={placement}</span>
        {appSid ? <span className="hidden xl:inline">APP_SID={appSid}</span> : null}
      </span>
      {right}
    </div>
  )
}
