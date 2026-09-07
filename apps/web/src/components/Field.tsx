'use client'

import type { ReactNode } from 'react'
import { useId } from 'react'
import { TriangleAlert } from 'lucide-react'

/** Поле формы. Стили из 02-components.md, п. 6 (Search Field), приведённые к текстовому вводу. */
export function Field({
  label, value, onChange, type = 'text', hint, ...rest
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'email' | 'password'
  hint?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const id = useId()
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-[12px] font-medium text-text-secondary">{label}</label>
      <input
        {...rest}
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[6px] border border-border-strong bg-surface px-[12px] py-[9px] text-[13px] text-text-primary outline-none transition-shadow placeholder:text-text-tertiary focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,84,245,0.12)]"
      />
      {hint ? <span className="text-[11px] text-text-tertiary">{hint}</span> : null}
    </div>
  )
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-[8px] rounded-[6px] bg-danger-soft px-[12px] py-[9px] text-[12px] text-danger">
      <TriangleAlert size={14} className="mt-[1px] shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
