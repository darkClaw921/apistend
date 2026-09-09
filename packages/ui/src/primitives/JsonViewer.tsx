'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { CodeBlock } from './CodeBlock.tsx'

/**
 * Просмотр JSON: подсветка, сворачивание узлов, прокрутка.
 *
 * Появился из простой жалобы: ответ в консоли не пролистывался и не сворачивался.
 * Первое было настоящей ошибкой вёрстки — `overflow-auto` снаружи не побеждал
 * `overflow-hidden` внутри CodeBlock, потому что cn() это clsx, а не tailwind-merge:
 * в разметке оказывались оба класса, и выигрывал тот, что позже в таблице стилей.
 *
 * Второе — недостающая возможность. Ответ метода каталога — это сотни строк,
 * и читать их сплошной простынёй нельзя: чтобы понять форму ответа, нужно свернуть
 * всё и разворачивать по одной ветке. Именно это здесь и делается.
 *
 * Что показывается у свёрнутого узла — не многоточие, а размер: «{ 7 полей }»
 * и «[ 128 ]». По ним видно, стоит ли разворачивать, и виден размер выдачи,
 * ради которого в каталог часто и заходят. Скобки печатаются вокруг подписи,
 * а не входят в неё: иначе получается «{ { 7 полей } }».
 *
 * Невалидный JSON не прячется и не глотается: он показывается как есть обычным
 * блоком кода. Тело ответа мока бывает и не-JSON (пустой ответ 204, текст ошибки
 * шлюза), и подменять его словами «не удалось разобрать» — терять то единственное,
 * что человек пришёл посмотреть.
 */

const CLS = {
  key: 'text-code-key',
  string: 'text-code-string',
  number: 'text-code-number',
  punct: 'text-code-text',
  muted: 'text-code-muted',
} as const

/** Сколько уровней раскрыто при первом показе. */
const DEFAULT_DEPTH = 2

/**
 * Порог, после которого узел показывается свёрнутым независимо от глубины.
 *
 * Массив на тысячу элементов, раскрытый по умолчанию, — это не «удобно видно
 * сразу», а замерший на секунду браузер и потерянная форма ответа.
 */
const BIG_NODE = 100

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100
  if (tail >= 11 && tail <= 14) return many
  switch (n % 10) {
    case 1: return one
    case 2:
    case 3:
    case 4: return few
    default: return many
  }
}

/**
 * Подпись свёрнутого узла: размер, а не многоточие.
 *
 * Без скобок: открывающая и закрывающая печатаются отдельно, вокруг подписи.
 * Со скобками внутри получалось «{ { 9 полей } }» — увидел при проверке в браузере.
 */
function summary(value: Json): string {
  if (Array.isArray(value)) return String(value.length)
  const n = Object.keys(value as Record<string, Json>).length
  return `${n} ${plural(n, 'поле', 'поля', 'полей')}`
}

function Leaf({ value }: { value: Json }) {
  if (value === null) return <span className={CLS.muted}>null</span>
  if (typeof value === 'string') return <span className={CLS.string}>&quot;{value}&quot;</span>
  if (typeof value === 'number') return <span className={CLS.number}>{value}</span>
  if (typeof value === 'boolean') return <span className={CLS.number}>{String(value)}</span>
  return null
}

function Node({
  name, value, depth, last, isArrayItem,
}: {
  name?: string
  value: Json
  depth: number
  last: boolean
  isArrayItem?: boolean
}) {
  const branching = Array.isArray(value) || isObject(value)
  const size = branching
    ? (Array.isArray(value) ? value.length : Object.keys(value as Record<string, Json>).length)
    : 0
  // Большой узел свёрнут независимо от глубины: см. BIG_NODE.
  const [open, setOpen] = useState(branching && depth < DEFAULT_DEPTH && size <= BIG_NODE)

  const label = name === undefined ? null : (
    <>
      <span className={CLS.key}>&quot;{name}&quot;</span>
      <span className={CLS.punct}>: </span>
    </>
  )

  if (!branching) {
    return (
      <div style={{ paddingLeft: depth * 14 }} className="whitespace-pre-wrap break-words">
        {/* Отступ под треугольник, чтобы значения выстроились по одной линии
            с ключами узлов, у которых треугольник есть. */}
        <span className="inline-block w-[14px]" aria-hidden />
        {label}
        <Leaf value={value} />
        {last ? null : <span className={CLS.punct}>,</span>}
      </div>
    )
  }

  const open_ = Array.isArray(value) ? '[' : '{'
  const close = Array.isArray(value) ? ']' : '}'
  const entries: Array<[string | undefined, Json]> = Array.isArray(value)
    ? value.map((v) => [undefined, v])
    : Object.entries(value as Record<string, Json>)

  return (
    <div>
      <div style={{ paddingLeft: depth * 14 }} className="whitespace-pre-wrap break-words">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Свернуть' : 'Развернуть'}
          className="inline-flex w-[14px] shrink-0 align-[-2px] text-code-muted hover:text-code-text"
        >
          {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
        </button>
        {label}
        <span className={CLS.punct}>{open_}</span>
        {open ? null : (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={cn(CLS.muted, 'hover:text-code-text')}
            >
              {summary(value)}
            </button>{' '}
            <span className={CLS.punct}>{close}</span>
            {last ? null : <span className={CLS.punct}>,</span>}
          </>
        )}
      </div>

      {open ? (
        <>
          {entries.map(([k, v], i) => (
            <Node
              key={k ?? i}
              name={k}
              value={v}
              depth={depth + 1}
              last={i === entries.length - 1}
              isArrayItem={k === undefined}
            />
          ))}
          <div style={{ paddingLeft: depth * 14 }}>
            <span className="inline-block w-[14px]" aria-hidden />
            <span className={CLS.punct}>{close}</span>
            {last ? null : <span className={CLS.punct}>,</span>}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function JsonViewer({
  code, value, size = 'md', className, maxHeight, fill = false,
}: {
  /** Исходный текст. Если это не JSON, показывается как обычный блок кода. */
  code?: string
  /** Уже разобранное значение. Имеет приоритет над code. */
  value?: unknown
  size?: 'sm' | 'md'
  className?: string
  /** Ограничение высоты в пикселях; всё, что выше, прокручивается. */
  maxHeight?: number
  /** Занять всю высоту родителя и прокручиваться внутри неё. */
  fill?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const parsed = useMemo<{ ok: true; data: Json } | { ok: false; text: string }>(() => {
    if (value !== undefined) return { ok: true, data: value as Json }
    const text = code ?? ''
    try {
      return { ok: true, data: JSON.parse(text) as Json }
    } catch {
      return { ok: false, text }
    }
  }, [code, value])

  const pretty = useMemo(
    () => (parsed.ok ? JSON.stringify(parsed.data, null, 2) : parsed.text),
    [parsed],
  )

  // Не-JSON показываем как есть: подменять его сообщением об ошибке разбора
  // значит прятать то единственное, ради чего сюда смотрят.
  if (!parsed.ok) {
    return (
      <CodeBlock
        code={parsed.text}
        language="text"
        size={size}
        className={className}
        maxHeight={maxHeight}
        fill={fill}
        wrap
      />
    )
  }

  // Скаляр верхнего уровня разворачивать не во что — обычный блок читается лучше.
  if (!Array.isArray(parsed.data) && !isObject(parsed.data)) {
    return (
      <CodeBlock code={pretty} language="json" size={size} className={className} maxHeight={maxHeight} fill={fill} />
    )
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(pretty)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Буфер обмена недоступен (не https, нет разрешения) — молча ничего не делаем.
    }
  }

  return (
    <div
      className={cn(
        'relative rounded-[6px] bg-code-bg',
        fill ? 'flex h-full min-h-0 flex-col' : undefined,
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Копировать"
        className="absolute top-[10px] right-[10px] z-10 text-code-muted transition-colors hover:text-code-text"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <div
        style={maxHeight && !fill ? { maxHeight } : undefined}
        className={cn(
          'scrollbar-thin overflow-auto px-[14px] py-[12px] font-mono text-code-text',
          fill ? 'min-h-0 flex-1' : undefined,
          size === 'sm' ? 'text-[11px] leading-[1.45]' : 'text-[12px] leading-[1.5]',
        )}
      >
        <Node value={parsed.data} depth={0} last />
      </div>
    </div>
  )
}
