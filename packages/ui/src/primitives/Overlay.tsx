'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { Panel } from './Panel.tsx'

/**
 * Оверлеи: модальное окно и выпадающая панель.
 *
 * В макете их нет — раздел «Что в макете НЕ нарисовано» предписывает собирать
 * такие вещи из готовых компонентов. Раньше каждый диалог собирал оверлей сам,
 * и повторялась не только вёрстка, но и её пробелы: окно не закрывалось по Escape,
 * фокус оставался на странице под ним. Здесь это сделано один раз.
 */

/** Закрытие по Escape. Отдельным хуком, потому что нужно обоим оверлеям. */
function useEscape(onClose: () => void): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
}

export function Dialog({
  title, onClose, children, width = 480, footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  /** Ширина окна в пикселях. Форма с двумя колонками просит больше 480. */
  width?: number
  footer?: ReactNode
}) {
  const box = useRef<HTMLElement>(null)
  useEscape(onClose)

  useEffect(() => {
    const node = box.current
    if (!node) return
    // Содержимое могло навести фокус само — например, палитра поиска ставит его
    // на поле ввода. Эффекты детей выполняются раньше родительского, поэтому
    // без этой проверки окно каждый раз перетягивало бы фокус на «Закрыть».
    if (node.contains(document.activeElement)) return
    // Иначе уводим фокус внутрь: без этого первый Tab уходит на страницу под окном.
    node
      .querySelector<HTMLElement>('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])')
      ?.focus()
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-nav-bg/40 p-[24px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Panel ref={box} className="max-h-full w-full" style={{ maxWidth: width }}>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-[16px] py-[13px]">
          <h2 className="text-[14px] font-semibold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="text-text-tertiary hover:text-text-secondary"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>

        {footer ? (
          <div className="shrink-0 border-t border-border px-[16px] py-[12px]">{footer}</div>
        ) : null}
      </Panel>
    </div>
  )
}

/**
 * Панель, выпадающая из-под кнопки: уведомления, меню на узком экране.
 *
 * Прозрачная подложка на весь экран нужна не для затемнения, а чтобы клик мимо
 * панели закрывал её — без неё пришлось бы вешать слушателя на document
 * и разбираться, был ли клик внутри.
 */
export function DropdownPanel({
  onClose, children, align = 'right', className, label,
}: {
  onClose: () => void
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
  label: string
}) {
  useEscape(onClose)

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={label}
        className={cn(
          // Теней в дизайн-системе нет: панели отделяются границей, не подъёмом.
          'absolute top-[calc(100%+8px)] z-50 overflow-hidden rounded-[10px] border border-border bg-surface',
          align === 'right' ? 'right-0' : 'left-0',
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}

/**
 * Правая панель-деталка. На широком экране — обычная колонка, до 1280 px —
 * шторка поверх содержимого.
 *
 * Так требует макет каркаса: «До 1280 px правую панель-деталку сворачивать
 * в шторку» (design-handoff/screens/00-app-shell.md). Без этого на узком экране
 * деталка выдавливала список до полутора сотен пикселей, и читать в нём было
 * нечего.
 */
export function DetailPane({
  open, onClose, children, className,
}: {
  /** Показана ли шторка на узком экране. На xl и шире значение не влияет ни на что. */
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-40 bg-nav-bg/40 xl:hidden" onClick={onClose} aria-hidden />
      ) : null}
      <div
        className={cn(
          'flex min-h-0 flex-col',
          'max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-50 max-xl:w-[min(460px,100vw)]',
          'max-xl:transition-transform max-xl:p-[12px]',
          open ? 'max-xl:translate-x-0' : 'max-xl:translate-x-full',
          className,
        )}
      >
        {open ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть панель"
            className="absolute top-[20px] right-[20px] z-10 flex h-[28px] w-[28px] items-center justify-center rounded-[6px] bg-surface text-text-tertiary hover:text-text-secondary xl:hidden"
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
        {children}
      </div>
    </>
  )
}
