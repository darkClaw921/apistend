'use client'

import { useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, WrapText } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { highlightJson } from './CodeBlock.tsx'

/**
 * Редактируемое поле JSON с подсветкой.
 *
 * До него тело запроса в консоли было голой `<textarea>`: моноширинный, но
 * совершенно серый текст, в котором не видно ни ключей, ни строк, ни где
 * потерялась запятая. Показывать ответ подсвеченным, а запрос — нет странно
 * вдвойне: ошибаются как раз в запросе.
 *
 * Подсветка редактируемого текста делается наложением, иначе никак: браузер
 * не умеет красить содержимое textarea. Снизу лежит подсвеченный `<pre>`,
 * сверху — та же textarea с прозрачным текстом и видимой кареткой. Оба слоя
 * обязаны совпадать по шрифту, размеру, межстрочному интервалу и отступам
 * до пикселя, иначе подсветка «поедет» относительно курсора; поэтому метрики
 * заданы здесь один раз и общими константами, а не по месту.
 *
 * Прокрутка слоёв синхронизируется вручную: у textarea своя, у pre своя,
 * и без синхронизации при длинном теле подсветка отстаёт от текста.
 */

/** Общие метрики обоих слоёв. Расходиться им нельзя. */
const METRICS = 'px-[12px] py-[12px] font-mono text-[12px] leading-[1.35]'

export function JsonEditor({
  value, onChange, placeholder, className, minHeight = 280, label = 'Тело запроса',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  minHeight?: number
  /** Для подписи кнопки и сообщений. */
  label?: string
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const [formatted, setFormatted] = useState(false)

  const state = useMemo<{ ok: true } | { ok: false; message: string } | null>(() => {
    if (value.trim().length === 0) return null
    try {
      JSON.parse(value)
      return { ok: true }
    } catch (e) {
      // Сообщение браузера («Unexpected token } in JSON at position 42») точнее
      // любого своего: в нём есть позиция. Оставляем его как есть.
      return { ok: false, message: (e as Error).message }
    }
  }, [value])

  const lines = value.split('\n')

  function format() {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2))
      setFormatted(true)
      setTimeout(() => setFormatted(false), 1200)
    } catch {
      // Невалидный JSON форматировать нечем; ошибка и так показана под полем.
    }
  }

  return (
    <div className={cn('flex flex-col gap-[6px]', className)}>
      <div className="relative w-full overflow-hidden rounded-[6px] bg-code-bg" style={{ height: minHeight }}>
        {/* Нижний слой: подсветка. Не принимает события — все клики уходят в textarea. */}
        <pre
          ref={preRef}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words text-code-text',
            METRICS,
          )}
        >
          <code>
            {lines.map((line, i) => (
              <span key={i}>
                {highlightJson(line).map((tok, k) => (
                  <span key={k} className={tok.cls}>{tok.t}</span>
                ))}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>

        {/* Верхний слой: сам ввод. Текст прозрачный, видна только каретка. */}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            // Слои прокручиваются раздельно: без этого подсветка отстаёт от текста.
            const pre = preRef.current
            if (!pre) return
            pre.scrollTop = e.currentTarget.scrollTop
            pre.scrollLeft = e.currentTarget.scrollLeft
          }}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
          className={cn(
            'absolute inset-0 w-full resize-none overflow-auto whitespace-pre-wrap break-words bg-transparent',
            'text-transparent caret-white outline-none placeholder:text-code-muted',
            METRICS,
          )}
        />
      </div>

      <div className="flex min-h-[18px] items-start justify-between gap-[10px]">
        <span className="text-[11px] leading-[1.4]">
          {state === null ? (
            <span className="text-text-tertiary">Пусто — запрос уйдёт без тела</span>
          ) : state.ok ? (
            <span className="text-success">JSON валиден</span>
          ) : (
            <span className="flex items-start gap-[4px] text-danger">
              <AlertCircle size={12} className="mt-[1px] shrink-0" aria-hidden />
              {state.message}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={format}
          disabled={state === null || !state.ok}
          className="flex shrink-0 items-center gap-[4px] text-[11px] text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:text-text-tertiary"
        >
          {formatted ? <Check size={12} aria-hidden /> : <WrapText size={12} aria-hidden />}
          {formatted ? 'Отформатировано' : 'Форматировать'}
        </button>
      </div>
    </div>
  )
}
