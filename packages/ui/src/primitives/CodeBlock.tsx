'use client'

import { useState, type ReactNode } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '../lib/cn.ts'

/**
 * Блок кода и терминал. design-handoff/02-components.md, п. 11.
 *
 * Подсветка идёт строго по токенам code-*: ключи, строки, числа, служебное.
 * Плейсхолдеры {{…}} внутри строк красятся в code-template — это отдельное требование
 * экрана «Свои моки» и пункт чек-листа приёмки.
 */

type Tok = { t: string; cls: string }

const CLS = {
  key: 'text-code-key',
  string: 'text-code-string',
  number: 'text-code-number',
  punct: 'text-code-text',
  muted: 'text-code-muted',
  template: 'text-code-template',
} as const

/** Разбивает строковый литерал на куски, выделяя плейсхолдеры {{…}}. */
function splitTemplate(raw: string, base: string): Tok[] {
  const out: Tok[] = []
  const re = /\{\{[^}]*\}\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push({ t: raw.slice(last, m.index), cls: base })
    out.push({ t: m[0], cls: CLS.template })
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push({ t: raw.slice(last), cls: base })
  return out
}

/**
 * Небольшой токенайзер JSON. Полноценный парсер тут не нужен и вреден:
 * подсвечивать надо и невалидный JSON, который пользователь печатает в редакторе.
 */
export function highlightJson(line: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]!

    if (ch === '"') {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === '"') break
        j++
      }
      const raw = line.slice(i, Math.min(j + 1, line.length))
      // Ключ — если сразу после закрывающей кавычки идёт двоеточие.
      const after = line.slice(j + 1).match(/^\s*:/)
      out.push(...splitTemplate(raw, after ? CLS.key : CLS.string))
      i = j + 1
      continue
    }

    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(line.slice(i))
    if (num && (i === 0 || !/[\w"]/.test(line[i - 1] ?? ''))) {
      out.push({ t: num[0], cls: CLS.number })
      i += num[0].length
      continue
    }

    const word = /^(true|false|null)\b/.exec(line.slice(i))
    if (word) {
      out.push({ t: word[0], cls: CLS.number })
      i += word[0].length
      continue
    }

    out.push({ t: ch, cls: CLS.punct })
    i++
  }
  return out
}

export function CodeBlock({
  code, language = 'json', showLineNumbers, onCopy, copyable = true,
  size = 'md', radius = 6, className, maxLines, wrap = false, maxHeight,
}: {
  code: string
  language?: 'json' | 'shell' | 'text'
  showLineNumbers?: boolean
  onCopy?: () => void
  copyable?: boolean
  size?: 'sm' | 'md'
  radius?: 6 | 14
  className?: string
  /**
   * Показать только первые N строк.
   *
   * Именно предпросмотр, а не способ уместить длинный текст: остальные строки
   * не показываются никак, и добраться до них нельзя. Для длинного текста,
   * который человек должен прочитать или скопировать целиком, есть maxHeight —
   * он ограничивает высоту, оставляя прокрутку.
   */
  maxLines?: number
  /**
   * Переносить длинные строки вместо горизонтальной прокрутки.
   *
   * Нужно там, где строка — не код, а адрес или проза. Горизонтальная прокрутка
   * для них плохой ответ: полосы на macOS скрыты, а колесо мыши без Shift
   * по горизонтали не крутит, и текст оказывается недостижим.
   */
  wrap?: boolean
  /** Максимальная высота в пикселях. Всё, что выше, прокручивается по вертикали. */
  maxHeight?: number
}) {
  const [copied, setCopied] = useState(false)
  const allLines = code.split('\n')
  const lines = maxLines ? allLines.slice(0, maxLines) : allLines
  const hiddenLines = allLines.length - lines.length

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      onCopy?.()
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Буфер обмена недоступен (не https, нет разрешения) — молча ничего не делаем.
    }
  }

  return (
    <div
      style={{ borderRadius: radius }}
      className={cn('relative overflow-hidden bg-code-bg', className)}
    >
      {copyable ? (
        <button
          type="button"
          onClick={copy}
          aria-label="Копировать"
          className="absolute top-[10px] right-[10px] z-10 text-code-muted transition-colors hover:text-code-text"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      ) : null}
      <pre
        style={maxHeight ? { maxHeight } : undefined}
        className={cn(
          'scrollbar-thin px-[14px] py-[12px] font-mono',
          // Перенос вместо горизонтальной прокрутки: адрес и проза должны
          // читаться целиком, не уезжая за край.
          wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto',
          maxHeight ? 'overflow-y-auto' : undefined,
          size === 'sm' ? 'text-[11px] leading-[1.25]' : 'text-[12px] leading-[1.35]',
        )}
      >
        <code className="text-code-text">
          {lines.map((line, i) => (
            <span key={i} className="grid grid-cols-[auto_1fr] gap-x-[12px]">
              {showLineNumbers ? (
                <span className="w-[16px] shrink-0 text-right text-code-muted select-none tabular">{i + 1}</span>
              ) : null}
              <span>
                {language === 'json'
                  ? highlightJson(line).map((tok, k) => (
                      <span key={k} className={tok.cls}>{tok.t}</span>
                    ))
                  : line}
                {'\n'}
              </span>
            </span>
          ))}
        </code>
      </pre>
      {hiddenLines > 0 ? (
        // Молча обрезанный текст выглядит как весь текст. Кнопка «Копировать»
        // при этом копирует его целиком — про это тоже надо сказать.
        <p className="border-t border-white/5 px-[14px] py-[7px] text-[11px] text-code-muted">
          и ещё {hiddenLines} {pluralLines(hiddenLines)} — копирование заберёт целиком
        </p>
      ) : null}
    </div>
  )
}

function pluralLines(n: number): string {
  const tail = n % 100
  if (tail >= 11 && tail <= 14) return 'строк'
  switch (n % 10) {
    case 1: return 'строка'
    case 2:
    case 3:
    case 4: return 'строки'
    default: return 'строк'
  }
}

/** Шапка терминала: фон code-surface, три точки 9 px, имя файла mono 11 px. */
export function TerminalFrame({
  fileName, children, className,
}: { fileName: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-[14px] border border-nav-border bg-code-bg', className)}>
      <div className="flex items-center gap-[8px] border-b border-nav-border bg-code-surface px-[14px] py-[10px]">
        <span className="flex gap-[6px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-[9px] w-[9px] rounded-full bg-[#3A4553]" />
          ))}
        </span>
        <span className="ml-[6px] font-mono text-[11px] text-code-muted">{fileName}</span>
      </div>
      {children}
    </div>
  )
}

/** Строка команды: $ приглушённый, команда — code-key, аргументы — code-string. */
export function ShellLine({ command, args }: { command: string; args?: string }) {
  return (
    <span className="font-mono text-[12px] leading-[1.4]">
      <span className="text-code-muted">$ </span>
      <span className="text-code-key">{command}</span>
      {args ? <span className="text-code-string"> {args}</span> : null}
    </span>
  )
}
