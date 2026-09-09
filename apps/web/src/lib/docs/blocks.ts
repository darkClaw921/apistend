/**
 * Разбор блоков-директив в markdown документации.
 *
 * Почему свой проход перед marked, а не расширение marked: расширения marked
 * работают на уровне токенов и не умеют смотреть внутрь себя рекурсивно без
 * повторного вызова лексера с потерей контекста. Директивы у нас вложенные
 * (вкладки содержат обычный markdown, внутри которого может быть заметка),
 * и разложить их построчно до лексера — короче и предсказуемее.
 *
 * Синтаксис (описан для авторов в content/docs/README-авторам.md):
 *
 *   :::note Заголовок
 *   Текст заметки.
 *   :::
 *
 * Заголовок необязателен. Внутри — обычный markdown, включая вложенные директивы.
 * Внутри :::tabs панели разделяются строкой «== Название вкладки».
 */

export type DocNode =
  /** Кусок обычного markdown — уходит в marked.lexer как есть. */
  | { kind: 'markdown'; text: string }
  /** Директива :::name arg … ::: с разобранным содержимым. */
  | { kind: 'container'; name: string; arg: string; children: DocNode[] }

const OPEN = /^:::([A-Za-z][\w-]*)[ \t]*(.*)$/
const CLOSE = /^:::[ \t]*$/
const FENCE = /^(\s{0,3})(`{3,}|~{3,})/
/** Разделитель панелей внутри :::tabs. */
const TAB = /^==[ \t]+(.+?)[ \t]*$/

/** Открыт ли на строке i блок кода — чтобы ::: внутри примера остался текстом. */
function scanFence(line: string, fence: string | null): string | null {
  const m = FENCE.exec(line)
  if (!m) return fence
  const marker = m[2]!
  if (fence === null) return marker[0]!.repeat(3)
  // Закрывает только маркер того же типа и не короче открывающего.
  return marker[0] === fence[0] && marker.length >= fence.length ? null : fence
}

/** Собирает подряд идущие строки в один markdown-узел, пропуская пустые хвосты. */
function pushText(out: DocNode[], lines: string[]): void {
  const text = lines.join('\n')
  if (text.trim().length > 0) out.push({ kind: 'markdown', text })
  lines.length = 0
}

function parseLines(lines: string[]): DocNode[] {
  const out: DocNode[] = []
  const buf: string[] = []
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const nextFence = scanFence(line, fence)
    if (fence !== null || nextFence !== null) {
      fence = nextFence
      buf.push(line)
      continue
    }

    const open = OPEN.exec(line)
    if (!open) {
      buf.push(line)
      continue
    }

    // Нашли директиву — ищем её закрывающую строку, считая вложенные.
    const inner: string[] = []
    let depth = 1
    let innerFence: string | null = null
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]!
      const f = scanFence(l, innerFence)
      if (innerFence !== null || f !== null) {
        innerFence = f
        inner.push(l)
        continue
      }
      if (OPEN.test(l)) depth++
      else if (CLOSE.test(l)) {
        depth--
        if (depth === 0) break
      }
      inner.push(l)
    }

    pushText(out, buf)
    const name = open[1]!.toLowerCase()
    const arg = (open[2] ?? '').trim()
    out.push({
      kind: 'container',
      name,
      arg,
      children: name === 'tabs' ? parseTabs(inner) : parseLines(inner),
    })
    // Незакрытая директива съедает остаток файла — это заметно при первом же
    // просмотре страницы и лучше, чем молча потерянный кусок текста.
    i = j
  }

  pushText(out, buf)
  return out
}

/** Панели вкладок: каждая становится контейнером tab с названием в arg. */
function parseTabs(lines: string[]): DocNode[] {
  const out: DocNode[] = []
  let title: string | null = null
  let buf: string[] = []
  let fence: string | null = null

  const flush = () => {
    if (title === null) return
    out.push({ kind: 'container', name: 'tab', arg: title, children: parseLines(buf) })
    buf = []
  }

  for (const line of lines) {
    const next = scanFence(line, fence)
    if (fence !== null || next !== null) {
      fence = next
      buf.push(line)
      continue
    }
    const m = TAB.exec(line)
    if (m) {
      flush()
      title = m[1]!
      continue
    }
    buf.push(line)
  }
  flush()
  return out
}

export function parseDocBlocks(markdown: string): DocNode[] {
  return parseLines(markdown.replace(/\r\n/g, '\n').split('\n'))
}
