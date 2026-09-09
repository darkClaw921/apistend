import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { AlertTriangle, ArrowRight, Info, Lightbulb, OctagonAlert } from 'lucide-react'
import { CodeBlock, StatusChip } from '@apistend/ui'
import { marked, type Token, type Tokens } from 'marked'
import type { DocNode } from '@/lib/docs/blocks'
import { DocTabs } from './DocTabs'
import type { DocHeading } from '@/lib/docs/source'

/**
 * Рендер markdown документации React-компонентами.
 *
 * Готовый HTML строкой (marked.parse + dangerouslySetInnerHTML) не годится:
 * блоки кода должны быть настоящим <CodeBlock> из дизайн-системы — с кнопкой
 * копирования и подсветкой по токенам code-*, а таблицы и заметки — теми же
 * поверхностями, что на остальных экранах. Поэтому разбираем текст лексером
 * и раскладываем токены по компонентам.
 *
 * Идентификаторы заголовков не считаются здесь заново: они приходят готовыми
 * из collectHeadings, той же функции, которая построила оглавление справа.
 * Два независимых счётчика однажды разошлись бы, и оглавление перестало бы
 * попадать в свои разделы.
 */

/** Очередь заголовков: рендер разбирает её в том же порядке, в каком считал сборщик. */
interface Ctx { headings: DocHeading[]; at: number }

/** CodeBlock знает три языка. Всё, что не JSON и не команда, — обычный текст. */
function mapLanguage(lang: string): 'json' | 'shell' | 'text' {
  const l = lang.toLowerCase().split(/\s+/)[0] ?? ''
  if (l === 'json' || l === 'jsonc' || l === 'json5') return 'json'
  if (l === 'sh' || l === 'bash' || l === 'shell' || l === 'zsh' || l === 'console') return 'shell'
  return 'text'
}

function isExternal(href: string): boolean {
  return /^[a-z]+:/i.test(href) || href.startsWith('//')
}

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  const cls = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent'
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls}>
        {children}
      </a>
    )
  }
  // Якоря внутри страницы ведём обычным <a>: клиентский переход по маршруту
  // ради прокрутки к соседнему абзацу — лишняя работа.
  if (href.startsWith('#')) return <a href={href} className={cls}>{children}</a>
  return <Link href={href as Route} className={cls}>{children}</Link>
}

/* ───────────────────────── строчные токены ───────────────────────── */

function Inline({ tokens }: { tokens: Token[] | undefined }): ReactNode {
  if (!tokens) return null
  return tokens.map((token, i) => <Fragment key={i}>{renderInline(token)}</Fragment>)
}

function renderInline(token: Token): ReactNode {
  const t = token as Tokens.Generic & { text?: string; tokens?: Token[] }
  switch (token.type) {
    case 'text':
      return t.tokens ? <Inline tokens={t.tokens} /> : t.text
    case 'strong':
      return <strong className="font-semibold text-text-primary"><Inline tokens={t.tokens} /></strong>
    case 'em':
      return <em className="italic"><Inline tokens={t.tokens} /></em>
    case 'del':
      return <del className="text-text-tertiary"><Inline tokens={t.tokens} /></del>
    case 'codespan':
      return (
        <code className="rounded-[4px] border border-border bg-surface-2 px-[5px] py-[1px] font-mono text-[0.9em] text-text-primary">
          {t.text}
        </code>
      )
    case 'link':
      return <Anchor href={(token as Tokens.Link).href}><Inline tokens={t.tokens} /></Anchor>
    case 'br':
      return <br />
    case 'escape':
      return t.text
    case 'image': {
      const img = token as Tokens.Image
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={img.href} alt={img.text} className="my-[16px] rounded-[10px] border border-border" />
    }
    case 'html':
      // Сырой HTML в документации не рендерим: markdown здесь — весь набор
      // выразительных средств, а вставка разметки мимо дизайн-системы ломает
      // и вид, и правило «цвета только из токенов».
      return null
    default:
      return t.text ?? null
  }
}

/* ───────────────────────── блочные токены ───────────────────────── */

function Blocks({ tokens, ctx }: { tokens: Token[]; ctx: Ctx }): ReactNode {
  return tokens.map((token, i) => <Fragment key={i}>{renderBlock(token, ctx)}</Fragment>)
}

function renderBlock(token: Token, ctx: Ctx): ReactNode {
  switch (token.type) {
    case 'space':
      return null

    case 'heading': {
      const h = token as Tokens.Heading
      if (h.depth === 1) {
        // Заголовок страницы рисует шаблон из фронтматтера — второй h1 в тексте
        // сделал бы на странице два первых заголовка.
        return <h2 className="mt-[36px] mb-[12px] text-[22px] leading-[1.3] font-semibold text-text-primary"><Inline tokens={h.tokens} /></h2>
      }
      if (h.depth === 2 || h.depth === 3) {
        const id = ctx.headings[ctx.at++]?.id
        return h.depth === 2 ? (
          <h2 id={id} className="mt-[38px] mb-[12px] scroll-mt-[88px] border-b border-border pb-[8px] text-[19px] leading-[1.35] font-semibold text-text-primary">
            <Inline tokens={h.tokens} />
          </h2>
        ) : (
          <h3 id={id} className="mt-[26px] mb-[8px] scroll-mt-[88px] text-[15px] leading-[1.4] font-semibold text-text-primary">
            <Inline tokens={h.tokens} />
          </h3>
        )
      }
      return <h4 className="mt-[20px] mb-[6px] text-[14px] font-semibold text-text-primary"><Inline tokens={(token as Tokens.Heading).tokens} /></h4>
    }

    case 'paragraph':
      return (
        <p className="my-[12px] text-[14px] leading-[1.65] text-text-secondary">
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
        </p>
      )

    case 'code': {
      const c = token as Tokens.Code
      return (
        <div className="my-[18px]">
          <CodeBlock code={c.text} language={mapLanguage(c.lang ?? '')} radius={6} />
        </div>
      )
    }

    case 'blockquote':
      return (
        <blockquote className="my-[16px] border-l-[3px] border-border-strong pl-[14px] text-[14px] leading-[1.65] text-text-secondary italic">
          <Blocks tokens={(token as Tokens.Blockquote).tokens} ctx={ctx} />
        </blockquote>
      )

    case 'hr':
      return <hr className="my-[28px] border-0 border-t border-border" />

    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, i) => (
        <li key={i} className="text-[14px] leading-[1.65] text-text-secondary marker:text-text-tertiary">
          <Blocks tokens={item.tokens} ctx={ctx} />
        </li>
      ))
      return list.ordered ? (
        <ol start={Number(list.start) || 1} className="my-[12px] list-decimal space-y-[4px] pl-[22px] [&_p]:my-[4px]">{items}</ol>
      ) : (
        <ul className="my-[12px] list-disc space-y-[4px] pl-[22px] [&_p]:my-[4px]">{items}</ul>
      )
    }

    case 'table':
      return <MdTable token={token as Tokens.Table} />

    case 'html':
      return null

    case 'text': {
      const t = token as Tokens.Text
      return t.tokens ? <Inline tokens={t.tokens} /> : t.text
    }

    default:
      return null
  }
}

/**
 * Таблица. Своя, а не DataTable из дизайн-системы: та строится по описанию
 * колонок с фиксированными ширинами, а в документации колонки задаёт автор
 * markdown-ом и ширины заранее неизвестны. Поверхности и границы — те же токены.
 *
 * Обёртка со своим горизонтальным скроллом обязательна: без неё широкая таблица
 * растягивает страницу и та начинает ездить вбок на 320 px.
 */
function MdTable({ token }: { token: Tokens.Table }) {
  return (
    <div className="my-[18px] overflow-x-auto scrollbar-thin rounded-[10px] border border-border">
      <table className="w-full min-w-[420px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-surface-2">
            {token.header.map((cell, i) => (
              <th
                key={i}
                style={{ textAlign: token.align[i] ?? 'left' }}
                className="border-b border-border px-[14px] py-[9px] text-[11px] font-semibold tracking-[0.4px] text-text-tertiary uppercase"
              >
                <Inline tokens={cell.tokens} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, r) => (
            <tr key={r} className="border-b border-border last:border-0">
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{ textAlign: token.align[c] ?? 'left' }}
                  className={
                    c === 0
                      ? 'px-[14px] py-[9px] align-top font-mono text-[12px] text-text-primary'
                      : 'px-[14px] py-[9px] align-top leading-[1.55] text-text-secondary'
                  }
                >
                  <Inline tokens={cell.tokens} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────────────────── директивы ───────────────────────── */

const CALLOUT = {
  note: { icon: Info, tone: 'border-info/30 bg-info-soft', title: 'text-info', label: 'Заметка' },
  tip: { icon: Lightbulb, tone: 'border-success/30 bg-success-soft', title: 'text-success', label: 'Совет' },
  warning: { icon: AlertTriangle, tone: 'border-warning/40 bg-warning-soft', title: 'text-warning', label: 'Важно' },
  danger: { icon: OctagonAlert, tone: 'border-danger/40 bg-danger-soft', title: 'text-danger', label: 'Осторожно' },
} as const

type CalloutName = keyof typeof CALLOUT

function Callout({ name, title, children }: { name: CalloutName; title: string; children: ReactNode }) {
  const c = CALLOUT[name]
  const Icon = c.icon
  return (
    <div className={`my-[18px] flex gap-[10px] rounded-[10px] border px-[14px] py-[12px] ${c.tone}`}>
      <Icon size={16} className={`mt-[2px] shrink-0 ${c.title}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] font-semibold ${c.title}`}>{title || c.label}</p>
        <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-[6px] [&_p]:text-[13px]">{children}</div>
      </div>
    </div>
  )
}

/**
 * Нумерованные шаги. Внутри директивы автор пишет обычный нумерованный список;
 * первая строка пункта становится названием шага, остальное — телом.
 * Так шаг остаётся читаемым списком в исходнике markdown.
 */
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="my-[20px] space-y-[2px]">
      {items.map((item, i) => (
        <li key={i} className="relative flex gap-[14px] pb-[18px] last:pb-0">
          {/* Линия соединяет кружки и обрывается на последнем шаге. */}
          {i < items.length - 1 ? (
            <span className="absolute top-[26px] bottom-[2px] left-[12px] w-px bg-border" aria-hidden />
          ) : null}
          <span className="relative z-10 flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[12px] font-semibold text-accent">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>p:first-child]:font-medium [&>p:first-child]:text-text-primary">
            {item}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Карточки-ссылки на соседние разделы: список ссылок превращается в сетку. */
function Cards({ links, heading }: { links: Tokens.ListItem[]; heading?: string }) {
  return (
    <div className="my-[22px]">
      {heading ? (
        <p className="mb-[10px] text-[11px] font-semibold tracking-[0.6px] text-text-tertiary uppercase">{heading}</p>
      ) : null}
      <div className="grid gap-[10px] sm:grid-cols-2">
        {links.map((item, i) => {
          const link = findLink(item.tokens)
          if (!link) return null
          // Хвост после ссылки — описание карточки: «[Заголовок](/docs/x) — про что».
          const rest = plainTail(item.tokens)
          const body = (
            <>
              <span className="flex items-center gap-[8px] text-[14px] font-semibold text-text-primary">
                {link.text}
                <ArrowRight size={14} className="shrink-0 text-accent" aria-hidden />
              </span>
              {rest ? <span className="mt-[4px] block text-[13px] leading-[1.55] text-text-secondary">{rest}</span> : null}
            </>
          )
          const cls = 'block rounded-[10px] border border-border bg-surface px-[14px] py-[12px] transition-colors hover:border-border-strong hover:bg-surface-2'
          return isExternal(link.href) ? (
            <a key={i} href={link.href} target="_blank" rel="noreferrer noopener" className={cls}>{body}</a>
          ) : (
            <Link key={i} href={link.href as Route} className={cls}>{body}</Link>
          )
        })}
      </div>
    </div>
  )
}

function findLink(tokens: Token[] | undefined): { href: string; text: string } | null {
  for (const token of tokens ?? []) {
    if (token.type === 'link') {
      const l = token as Tokens.Link
      return { href: l.href, text: l.text }
    }
    const nested = findLink((token as Tokens.Generic).tokens as Token[] | undefined)
    if (nested) return nested
  }
  return null
}

/** Текст пункта после ссылки, без ведущего тире. */
function plainTail(tokens: Token[] | undefined): string {
  let seen = false
  let out = ''
  function walk(list: Token[] | undefined) {
    for (const token of list ?? []) {
      if (token.type === 'link') { seen = true; continue }
      const nested = (token as Tokens.Generic).tokens as Token[] | undefined
      if (nested && nested.length > 0) { walk(nested); continue }
      if (seen) out += (token as Tokens.Generic).text ?? ''
    }
  }
  walk(tokens)
  return out.replace(/^\s*[—–-]\s*/, '').trim()
}

/**
 * Таблица параметров. От обычной отличается только разметкой ячеек: имя —
 * моноширинным, тип — нейтральным чипом, «да»/«нет» в колонке обязательности —
 * чипом со статусом. Разметка берётся из содержимого, а не из номера колонки:
 * набор колонок автор задаёт сам, и жёсткая привязка «третья колонка — флаг»
 * ломалась бы на таблице без него.
 */
function ParamsTable({ token, caption }: { token: Tokens.Table; caption?: string }) {
  const YES = new Set(['да', 'yes', 'обязательный', 'обязателен'])
  const NO = new Set(['нет', 'no', 'необязательный'])

  return (
    <div className="my-[18px]">
      {caption ? <p className="mb-[8px] text-[13px] font-semibold text-text-primary">{caption}</p> : null}
      <div className="overflow-x-auto scrollbar-thin rounded-[10px] border border-border">
        <table className="w-full min-w-[420px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-surface-2">
              {token.header.map((cell, i) => (
                <th key={i} className="border-b border-border px-[14px] py-[9px] text-left text-[11px] font-semibold tracking-[0.4px] text-text-tertiary uppercase">
                  <Inline tokens={cell.tokens} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {token.rows.map((row, r) => (
              <tr key={r} className="border-b border-border last:border-0">
                {row.map((cell, c) => {
                  const raw = cell.text.trim().toLowerCase()
                  if (c === 0) {
                    return (
                      <td key={c} className="px-[14px] py-[9px] align-top font-mono text-[12px] font-semibold whitespace-nowrap text-text-primary">
                        {/* Имя параметра почти всегда пишут в апострофах — колонка
                            и так моноширинная, а чип внутри чипа выглядит мусором. */}
                        {cell.text.trim().replace(/^`+|`+$/g, '')}
                      </td>
                    )
                  }
                  if (YES.has(raw) || NO.has(raw)) {
                    return (
                      <td key={c} className="px-[14px] py-[9px] align-top">
                        <StatusChip tone={YES.has(raw) ? 'accent' : 'neutral'}>{cell.text.trim()}</StatusChip>
                      </td>
                    )
                  }
                  return (
                    <td key={c} className="px-[14px] py-[9px] align-top leading-[1.55] text-text-secondary">
                      <Inline tokens={cell.tokens} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ───────────────────────── сборка ───────────────────────── */

function renderNodes(nodes: DocNode[], ctx: Ctx): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderNode(node, ctx)}</Fragment>)
}

function renderNode(node: DocNode, ctx: Ctx): ReactNode {
  if (node.kind === 'markdown') return <Blocks tokens={marked.lexer(node.text)} ctx={ctx} />

  if (node.name in CALLOUT) {
    return <Callout name={node.name as CalloutName} title={node.arg}>{renderNodes(node.children, ctx)}</Callout>
  }

  if (node.name === 'tabs') {
    const panels = node.children.filter((c) => c.kind === 'container' && c.name === 'tab')
    if (panels.length === 0) return renderNodes(node.children, ctx)
    return (
      <DocTabs
        titles={panels.map((p) => (p.kind === 'container' ? p.arg : ''))}
        panels={panels.map((p) => (p.kind === 'container' ? renderNodes(p.children, ctx) : null))}
      />
    )
  }

  if (node.name === 'steps') {
    // Шаги описываются нумерованным списком; всё, что не список, рисуем как есть.
    const items: ReactNode[] = []
    for (const child of node.children) {
      if (child.kind !== 'markdown') continue
      for (const token of marked.lexer(child.text)) {
        if (token.type !== 'list') continue
        for (const item of (token as Tokens.List).items) {
          items.push(<Blocks tokens={item.tokens} ctx={ctx} />)
        }
      }
    }
    return items.length > 0 ? <Steps items={items} /> : renderNodes(node.children, ctx)
  }

  if (node.name === 'params') {
    for (const child of node.children) {
      if (child.kind !== 'markdown') continue
      for (const token of marked.lexer(child.text)) {
        if (token.type === 'table') return <ParamsTable token={token as Tokens.Table} caption={node.arg} />
      }
    }
    return renderNodes(node.children, ctx)
  }

  if (node.name === 'cards' || node.name === 'next') {
    const items: Tokens.ListItem[] = []
    for (const child of node.children) {
      if (child.kind !== 'markdown') continue
      for (const token of marked.lexer(child.text)) {
        if (token.type === 'list') items.push(...(token as Tokens.List).items)
      }
    }
    const heading = node.name === 'next' ? node.arg || 'Дальше читайте' : node.arg
    return items.length > 0 ? <Cards links={items} heading={heading} /> : null
  }

  // Неизвестная директива — печатаем содержимое, а не молчим: пропавший кусок
  // текста заметить труднее, чем текст без оформления.
  return renderNodes(node.children, ctx)
}

export function DocMarkdown({ nodes, headings }: { nodes: DocNode[]; headings: DocHeading[] }) {
  return <>{renderNodes(nodes, { headings, at: 0 })}</>
}
