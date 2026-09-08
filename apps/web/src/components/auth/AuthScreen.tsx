'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { PlugZap } from 'lucide-react'
import { API_URL } from '@/lib/api'

/**
 * Каркас экранов входа и регистрации. Макет: «Экран — Вход» и «Экран — Регистрация»
 * в APIStend.pen.
 *
 * Экран тёмный и разделён надвое: слева форма на 620 px, справа витрина —
 * терминал, три метрики и комментарии. Это единственная часть продукта
 * с собственной тёмной раскладкой, поэтому цвета заданы значениями токенов
 * напрямую: переменные темы кабинета здесь дали бы светлый фон.
 *
 * Ниже 1280 витрина уходит: терминал в 708 px не сжимается, а форма важнее.
 */

const C = {
  page: '#090D13',
  column: '#0D1218',
  line: '#1B2531',
  lineStrong: '#202A36',
  chip: '#111821',
  white: '#FFFFFF',
  muted: '#9AA6B6',
  dim: '#5C6A7A',
  accent: '#3B54F5',
  ok: '#3DD68C',
} as const

export function AuthScreen({
  children, showcase,
}: {
  children: ReactNode
  /** Правая колонка: терминал, метрики, комментарии. */
  showcase: ReactNode
}) {
  return (
    <div className="flex min-h-screen" style={{ background: C.page }}>
      <div
        className="flex w-full flex-col items-center justify-between gap-[32px] py-[40px] xl:w-[620px] xl:shrink-0"
        style={{ background: C.column, borderRight: `1px solid ${C.line}` }}
      >
        <AuthTop />
        <main className="w-full max-w-[396px] px-[24px]">{children}</main>
        <AuthBottom />
      </div>

      {/* Витрина нужна на широком экране: 708 px терминала не ужимаются. */}
      <div className="hidden flex-1 flex-col justify-center gap-[22px] p-[56px] xl:flex">
        {showcase}
      </div>
    </div>
  )
}

function AuthTop() {
  return (
    <header className="flex w-full max-w-[620px] shrink-0 items-center justify-between px-[48px]">
      <Link href="/" className="flex items-center gap-[10px]">
        <span
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px]"
          style={{ background: C.accent }}
        >
          <PlugZap size={17} color={C.white} aria-hidden />
        </span>
        <span className="text-[16px] font-bold tracking-[-0.3px]" style={{ color: C.white }}>
          APIStend
        </span>
      </Link>

      {/* В макете здесь номер версии. Показываем то, что правда: продукт в бете —
          так же написано на лендинге и в подписи плана внутри кабинета. */}
      <span
        className="rounded-[4px] px-[8px] py-[3px] font-mono text-[11px]"
        style={{ background: C.chip, border: `1px solid ${C.lineStrong}`, color: C.dim }}
      >
        бета
      </span>
    </header>
  )
}

/**
 * Нижняя строка. В макете рядом со статусом стоит «99,98%» — придуманная цифра;
 * вместо неё спрашиваем /health и говорим то, что он ответил.
 */
function AuthBottom() {
  const [state, setState] = useState<'checking' | 'ok' | 'down'>('checking')

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/health`)
      .then((r) => { if (!cancelled) setState(r.ok ? 'ok' : 'down') })
      .catch(() => { if (!cancelled) setState('down') })
    return () => { cancelled = true }
  }, [])

  const label = state === 'checking' ? 'проверяем сервис…'
    : state === 'ok' ? 'все системы работают'
    : 'сервис недоступен'

  return (
    <footer className="flex w-full max-w-[620px] shrink-0 items-center justify-between px-[48px]">
      <span className="font-mono text-[11px]" style={{ color: C.dim }}>© 2026 APIStend</span>
      <span className="flex items-center gap-[7px] font-mono text-[11px]" style={{ color: C.dim }}>
        <span
          className="h-[6px] w-[6px] shrink-0 rounded-full"
          style={{ background: state === 'down' ? '#C22B2B' : state === 'ok' ? C.ok : C.dim }}
          aria-hidden
        />
        {label}
      </span>
    </footer>
  )
}

/** Заголовок формы: строка-кикер моноширинным, название и подпись. */
export function AuthHeading({
  kicker, title, subtitle,
}: { kicker: string; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[12px]" style={{ color: C.dim }}>{kicker}</span>
      <h1
        className="mt-[10px] text-[32px] leading-[1.15] font-bold tracking-[-1px]"
        style={{ color: C.white }}
      >
        {title}
      </h1>
      <p className="mt-[8px] text-[14px] leading-[1.5]" style={{ color: C.muted }}>{subtitle}</p>
    </div>
  )
}

/** Строка «Ещё нет песочницы? → Создать за минуту». */
export function AuthSwitch({ question, href, label }: { question: string; href: '/login' | '/register'; label: string }) {
  return (
    <p className="flex justify-center gap-[6px] text-[13px]" style={{ color: C.muted }}>
      {question}
      <Link href={href} className="font-semibold hover:underline" style={{ color: C.accent }}>
        {label}
      </Link>
    </p>
  )
}

/**
 * Блок входа из терминала.
 *
 * В макете здесь одноразовый код и `apistend login --code`. Такой команды нет:
 * device-flow из первой версии вырезан осознанно, вход в CLI идёт серверным
 * ключом. Показываем настоящую команду.
 */
export function CliHint({ command, hint }: { command: string; hint: string }) {
  return (
    <div
      className="flex flex-col gap-[7px] rounded-[6px] px-[14px] py-[12px]"
      style={{ background: '#0A0E14', border: `1px solid ${C.line}` }}
    >
      <span className="flex items-baseline gap-[8px] overflow-hidden font-mono text-[11px]">
        <span style={{ color: C.dim }}>$</span>
        <span className="truncate" style={{ color: '#7FB3FF' }}>{command}</span>
      </span>
      <span className="font-mono text-[10px]" style={{ color: C.dim }}>{hint}</span>
    </div>
  )
}

export const AUTH_COLORS = C
