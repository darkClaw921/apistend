'use client'

import type { ReactNode } from 'react'
import { StatusChip, Tabs, formatTime } from '@apistend/ui'
import type { B24PlacementItem, B24PortalDeal } from '@/lib/b24'
import { dealPath, formatMoney } from './PortalChrome'

/**
 * Упрощённая карточка сделки — обстановка для вкладки CRM_DEAL_DETAIL_TAB.
 *
 * Приложению важны две вещи: что его вкладка стоит в одном ряду с вкладками портала
 * и что в PLACEMENT_OPTIONS приходит ID именно этой сделки. Всё остальное в карточке —
 * фон, и он честно об этом говорит, вместо того чтобы притворяться работающим.
 */

export type PortalWidget = B24PlacementItem & { appId: string; appTitle: string }

/** Собственные вкладки портала. Значения не пересекаются с идентификаторами виджетов. */
export const DEAL_TAB_GENERAL = 'portal:general'
export const DEAL_TAB_TIMELINE = 'portal:timeline'

export function DealCard({
  deal, deals, onDealChange, widgets, activeTab, onTabChange, refreshedAt, children,
}: {
  deal: B24PortalDeal | null
  deals: readonly B24PortalDeal[]
  onDealChange: (id: string) => void
  widgets: readonly PortalWidget[]
  activeTab: string
  onTabChange: (tab: string) => void
  /** Когда приложение в последний раз попросило placement.call('reloadData'). */
  refreshedAt: Date | null
  children: ReactNode
}) {
  if (!deal) {
    return (
      <div className="p-[24px]">
        <p className="text-[13px] leading-[1.5] text-text-secondary">
          Сделок в песочнице нет: каталог моков не собран, и портал не может показать карточку.
          Вкладку приложения по-прежнему можно открыть на основной странице.
        </p>
      </div>
    )
  }

  const fields: Array<readonly [string, string]> = [
    ['Название', deal.title],
    ['Стадия', deal.stage],
    ['Сумма', formatMoney(deal.opportunity)],
    ['Контакт', deal.contact || '—'],
    ['ID сделки', deal.id],
    ['PLACEMENT_OPTIONS.URI', dealPath(deal.id)],
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-[10px] border-b border-border bg-surface px-[16px] py-[12px]">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-bold tracking-[-0.2px] text-text-primary">{deal.title}</span>
          <span className="truncate font-mono text-[11px] text-text-tertiary">{dealPath(deal.id)}</span>
        </span>
        <StatusChip tone="info">{deal.stage}</StatusChip>
        <span className="text-[13px] font-semibold text-text-primary tabular">{formatMoney(deal.opportunity)}</span>
        {refreshedAt ? (
          <StatusChip tone="accent">данные обновлены в {formatTime(refreshedAt)}</StatusChip>
        ) : null}
        <label className="ml-auto flex items-center gap-[6px]">
          <span className="text-[11px] text-text-tertiary">Сделка</span>
          <select
            value={deal.id}
            onChange={(e) => onDealChange(e.target.value)}
            className="rounded-[6px] border border-border-strong bg-surface px-[8px] py-[5px] text-[12px] text-text-primary outline-none focus:border-accent"
          >
            {deals.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        </label>
      </header>

      <Tabs
        className="shrink-0 bg-surface"
        value={activeTab}
        onChange={onTabChange}
        items={[
          { value: DEAL_TAB_GENERAL, label: 'Общее' },
          { value: DEAL_TAB_TIMELINE, label: 'Дела и история' },
          ...widgets.map((w) => ({ value: w.id, label: w.title ?? w.appTitle })),
        ]}
      />

      <div className="min-h-0 flex-1">
        {activeTab === DEAL_TAB_GENERAL ? (
          <dl className="grid grid-cols-2 gap-x-[24px] gap-y-[12px] p-[16px]">
            {fields.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-[2px]">
                <dt className="text-[11px] text-text-tertiary">{label}</dt>
                <dd className="truncate font-mono text-[12px] text-text-primary">{value}</dd>
              </div>
            ))}
            {widgets.length === 0 ? (
              <p className="col-span-2 text-[12px] leading-[1.5] text-text-tertiary">
                Вкладок приложений в этой карточке нет: ни одно установленное приложение не привязано
                к CRM_DEAL_DETAIL_TAB. Привязка делается вызовом placement.bind — до неё портал вкладку
                не покажет, и в бою тоже.
              </p>
            ) : null}
          </dl>
        ) : activeTab === DEAL_TAB_TIMELINE ? (
          <p className="max-w-[520px] p-[16px] text-[13px] leading-[1.5] text-text-secondary">
            Таймлайн сделки APIStend не воспроизводит: он ничего не добавляет к отладке
            приложения. Вкладка нужна, чтобы было видно — виджет приложения стоит в одном
            ряду с вкладками портала и переключается так же.
          </p>
        ) : (
          children
        )}
      </div>
    </div>
  )
}
