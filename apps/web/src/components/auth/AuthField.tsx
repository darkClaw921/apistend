'use client'

import { useId, useState, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff, TriangleAlert, type LucideIcon } from 'lucide-react'
import { AUTH_COLORS as C } from './AuthScreen'

/**
 * Поле формы входа и регистрации. Макет: «Экран — Вход», блок Field.
 *
 * Подпись моноширинная и синяя — как имя ключа в JSON; справа от неё
 * необязательная вторая подпись (подсказка). Внутри поля иконка слева,
 * значение моноширинным, справа — переключатель показа пароля.
 */
export function AuthField({
  label, hint, icon: Icon, value, onChange, type = 'text', suffix, ...rest
}: {
  label: string
  hint?: string
  icon: LucideIcon
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'email' | 'password'
  /** Приписка справа от значения — например «.sandbox» у имени проекта. */
  suffix?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const id = useId()
  const [focused, setFocused] = useState(false)
  const [shown, setShown] = useState(false)
  const isPassword = type === 'password'

  return (
    <div className="flex flex-col gap-[7px]">
      <span className="flex items-center justify-between">
        <label htmlFor={id} className="font-mono text-[11px]" style={{ color: '#7FB3FF' }}>
          {label}
        </label>
        {hint ? <span className="font-mono text-[11px]" style={{ color: C.dim }}>{hint}</span> : null}
      </span>

      <span
        className="flex items-center gap-[10px] rounded-[6px] px-[14px] py-[12px] transition-colors"
        style={{
          background: C.chip,
          border: `1.5px solid ${focused ? C.accent : C.lineStrong}`,
        }}
      >
        <Icon size={15} className="shrink-0" color={focused ? C.accent : C.dim} aria-hidden />
        <input
          {...rest}
          id={id}
          type={isPassword && shown ? 'text' : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
          style={{ color: C.white }}
        />
        {suffix ? (
          <span className="shrink-0 font-mono text-[13px]" style={{ color: C.dim }}>{suffix}</span>
        ) : null}
        {isPassword ? (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
            className="shrink-0"
          >
            {shown
              ? <EyeOff size={15} color={C.dim} aria-hidden />
              : <Eye size={15} color={C.dim} aria-hidden />}
          </button>
        ) : null}
      </span>
    </div>
  )
}

/** Основное действие формы: кнопка во всю ширину с чипом ↵, как в макете. */
export function AuthSubmit({ pending, children }: { pending: boolean; children: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full items-center justify-center gap-[8px] rounded-[6px] px-[20px] py-[14px] text-[14px] font-semibold transition-opacity disabled:opacity-60"
      style={{ background: C.accent, color: C.white }}
    >
      {children}
      <span
        className="rounded-[4px] px-[6px] py-[1px] font-mono text-[12px]"
        style={{ background: '#FFFFFF26' }}
        aria-hidden
      >
        ↵
      </span>
    </button>
  )
}

export function AuthError({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-[8px] rounded-[6px] px-[12px] py-[10px] text-[12px]"
      style={{ background: '#2A1518', border: '1px solid #4A2226', color: '#F5A3A3' }}
    >
      <TriangleAlert size={14} className="mt-[1px] shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
