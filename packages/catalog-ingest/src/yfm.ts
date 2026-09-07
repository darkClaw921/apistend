/**
 * Разбор Diplodoc-YFM — формата, в котором Bitrix24 публикует документацию REST API.
 *
 * OpenAPI у Bitrix24 нет: официальный источник (github.com/bitrix24/b24restdocs, MIT) —
 * это markdown с собственными расширениями. Разбирать приходится вручную, потому что
 * обычный markdown-парсер не знает ни таблиц `#| ... |#`, ни `{% note %}`, ни `{% list tabs %}`.
 *
 * Парсер намеренно снисходителен: документация из 2456 файлов неизбежно неоднородна,
 * и падать на одном кривом файле нельзя. Всё, что не удалось разобрать, возвращается
 * пустым, а метод получает честный статус готовности пониже.
 */

export interface YfmCell {
  raw: string
  text: string
}

export interface YfmRow {
  cells: YfmCell[]
}

/** Снимает разметку YFM/markdown, оставляя читаемый текст. */
export function stripMarkup(raw: string, maxLen = 400): string {
  let text = raw
    // Блоки кода целиком вырезаем: в описание они не идут.
    .replace(/```[\s\S]*?```/g, ' ')
    // Заметки {% note ... %} ... {% endnote %}
    .replace(/\{%\s*note[\s\S]*?\{%\s*endnote\s*%\}/g, ' ')
    // Прочие директивы {% ... %}
    .replace(/\{%[^%]*%\}/g, ' ')
    // Якоря {#anchor}
    .replace(/\{#[^}]*\}/g, ' ')
    // Ссылки [текст](адрес) -> текст
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // HTML
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length > maxLen) {
    const cut = text.slice(0, maxLen)
    const lastSpace = cut.lastIndexOf(' ')
    text = `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLen)}…`
  }
  return text
}

/**
 * Разбирает таблицу YFM вида:
 *   #|
 *   || **Name**
 *   `type` | **Description** ||
 *   || **fields**
 *   [`object`](...) | Описание ||
 *   |#
 *
 * Строки разделены `||`, ячейки внутри строки — одиночным `|`.
 * Одиночные `|` внутри блоков кода и инлайн-кода игнорируются: иначе описание
 * с примером таблицы разрывает строку посередине.
 */
export function parseYfmTable(block: string): YfmRow[] {
  const inner = block.replace(/^\s*#\|\s*/, '').replace(/\s*\|#\s*$/, '')
  const rows: YfmRow[] = []

  // Разбиваем на строки по «||», уважая границы блоков кода.
  const chunks = splitTopLevel(inner, '||')
  for (const chunk of chunks) {
    const trimmed = chunk.trim()
    if (trimmed.length === 0) continue
    const cells = splitTopLevel(trimmed, '|').map((raw) => ({ raw: raw.trim(), text: stripMarkup(raw) }))
    if (cells.length > 0) rows.push({ cells })
  }
  return rows
}

/** Делит строку по разделителю, пропуская содержимое ``` ``` и `…`. */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = []
  let buffer = ''
  let i = 0
  let inFence = false
  let inInline = false

  while (i < text.length) {
    if (text.startsWith('```', i)) {
      inFence = !inFence
      buffer += '```'
      i += 3
      continue
    }
    if (!inFence && text[i] === '`') {
      inInline = !inInline
      buffer += '`'
      i++
      continue
    }
    if (!inFence && !inInline && text.startsWith(delimiter, i)) {
      // «||» не должен срабатывать на «|» при поиске одиночного разделителя.
      if (delimiter === '|' && (text.startsWith('||', i) || (i > 0 && text[i - 1] === '|'))) {
        buffer += text[i]
        i++
        continue
      }
      parts.push(buffer)
      buffer = ''
      i += delimiter.length
      continue
    }
    buffer += text[i]
    i++
  }
  parts.push(buffer)
  return parts
}

/** Находит все таблицы `#| ... |#` в тексте. */
export function findTables(text: string): string[] {
  const out: string[] = []
  // Хвостовые пробелы после «#|» есть в 870 строках документации — без них
  // 199 методов оставались бы с пустой таблицей параметров.
  const re = /^#\|[ \t]*$[\s\S]*?^\|#[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[0])
  return out
}

/** Возвращает содержимое секции по заголовку любого уровня до следующего заголовка того же или выше. */
export function section(text: string, headingPattern: RegExp): string | null {
  const lines = text.split('\n')
  let start = -1
  let level = 0

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!)
    if (!m) continue
    if (start === -1 && headingPattern.test(m[2]!)) {
      start = i + 1
      level = m[1]!.length
      continue
    }
    if (start !== -1 && m[1]!.length <= level) {
      return lines.slice(start, i).join('\n')
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n')
}

/** Первый блок ```json из текста, разобранный в объект. null, если его нет или он невалиден. */
export function firstJsonBlock(text: string): unknown | null {
  const re = /```json\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]!.trim()
    try {
      return JSON.parse(raw)
    } catch {
      // Документация местами содержит псевдо-JSON с комментариями и многоточиями.
      // Пробуем следующий блок, а не падаем.
    }
  }
  return null
}

/** Все блоки ```json, включая невалидные (возвращаются как строки). */
export function jsonBlocks(text: string): string[] {
  const out: string[] = []
  const re = /```json\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1]!.trim())
  return out
}
