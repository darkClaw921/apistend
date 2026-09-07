/**
 * Пакетный вызов Bitrix24: метод batch.
 *
 * Его использует BX24.callBatch и почти каждая клиентская библиотека — без него
 * приложение, написанное как обычно, получит 404 на самом ходовом методе портала.
 *
 * Две особенности, которые обязаны совпадать с боевыми:
 *   — результаты лежат не плоско, а в пяти параллельных словарях
 *     (result / result_error / result_total / result_next / result_time)
 *     с одинаковыми ключами команд;
 *   — параметр одной команды может ссылаться на результат предыдущей
 *     выражением $result[ключ][путь]. Команды поэтому выполняются
 *     строго по очереди, а не параллельно.
 */

/** Боевой предел: больше 50 команд портал не принимает. */
export const BATCH_MAX_COMMANDS = 50

export interface BatchCommandResult {
  readonly body: Record<string, unknown>
  readonly status: number
}

export type BatchRunner = (method: string, params: Record<string, unknown>) => Promise<BatchCommandResult>

/** Разбирает cmd: и объект {key: 'crm.deal.get?id=1'}, и массив строк. */
export function parseBatchCommands(raw: unknown): Array<{ key: string; method: string; query: string }> {
  const out: Array<{ key: string; method: string; query: string }> = []
  const push = (key: string, value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0) return
    const at = value.indexOf('?')
    out.push({
      key,
      method: at === -1 ? value.trim() : value.slice(0, at).trim(),
      query: at === -1 ? '' : value.slice(at + 1),
    })
  }

  if (Array.isArray(raw)) {
    raw.forEach((value, i) => push(String(i), value))
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) push(key, value)
  }
  return out
}

/**
 * Разворачивает query-строку команды в параметры.
 *
 * Ключи приходят в PHP-скобках (filter[>OPPORTUNITY]=50000), и разбирать их
 * приходится вручную: URLSearchParams отдаёт плоские пары.
 */
export function parseCommandParams(query: string): Record<string, unknown> {
  if (!query) return {}
  const flat: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(query)) flat[key] = value
  return expandBracketKeys(flat)
}

/**
 * Разворачивает плоские ключи с PHP-скобками во вложенный объект.
 *
 * Разбор тела form-urlencoded на входе шлюза намеренно плоский: он общий для трёх
 * сервисов, и скобки есть только у Bitrix24. Разворачиваем здесь, где точно известно,
 * что запрос к Bitrix24 и что параметры нужны разобранными.
 */
export function expandBracketKeys(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(flat)) {
    const match = /^([^[]+)((\[[^\]]*\])*)$/.exec(rawKey)
    if (!match || !match[2]) {
      out[rawKey] = value
      continue
    }
    const path = [...match[2].matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? '')
    assignPath(out, [match[1]!, ...path], value)
  }
  return out
}

function assignPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node: Record<string, unknown> = target
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    const next = node[key]
    if (typeof next !== 'object' || next === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  const last = path[path.length - 1]!
  if (last === '') {
    // Пустые скобки — добавление в конец списка: fields[]=A&fields[]=B.
    const keys = Object.keys(node)
    node[String(keys.length)] = value
  } else {
    node[last] = value
  }
}

/** Подставляет $result[команда][путь] значениями уже выполненных команд. */
export function resolveReferences(
  params: Record<string, unknown>,
  results: Record<string, unknown>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return resolveOne(value, results)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return value
  }
  return walk(params) as Record<string, unknown>
}

function resolveOne(value: string, results: Record<string, unknown>): unknown {
  if (!value.startsWith('$result[')) return value
  const path = [...value.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? '')
  let node: unknown = results
  for (const key of path) {
    if (node === null || typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[key]
  }
  return node ?? null
}

/**
 * Выполняет пакет.
 *
 * halt=1 останавливает обработку на первой ошибке — остальные команды
 * не выполняются и в ответе просто отсутствуют, как в бою.
 */
export async function runBatch(
  params: Record<string, unknown>,
  run: BatchRunner,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const commands = parseBatchCommands(params.cmd)
  if (commands.length === 0) {
    return {
      status: 400,
      body: { error: 'ERROR_BATCH_LENGTH_EXCEEDED', error_description: 'Batch length exceeded' },
    }
  }
  if (commands.length > BATCH_MAX_COMMANDS) {
    return {
      status: 400,
      body: { error: 'ERROR_BATCH_LENGTH_EXCEEDED', error_description: 'Max batch length exceeded' },
    }
  }

  const halt = params.halt === 1 || params.halt === '1' || params.halt === true

  const result: Record<string, unknown> = {}
  const resultError: Record<string, unknown> = {}
  const resultTotal: Record<string, unknown> = {}
  const resultNext: Record<string, unknown> = {}
  const resultTime: Record<string, unknown> = {}

  for (const command of commands) {
    const commandParams = resolveReferences(parseCommandParams(command.query), result)
    const outcome = await run(command.method, commandParams)
    const body = outcome.body

    if (typeof body.error === 'string') {
      resultError[command.key] = {
        error: body.error,
        error_description: body.error_description ?? '',
      }
      if (halt) break
      continue
    }

    result[command.key] = body.result ?? null
    if (body.total !== undefined) resultTotal[command.key] = body.total
    if (body.next !== undefined) resultNext[command.key] = body.next
    if (body.time !== undefined) resultTime[command.key] = body.time
  }

  return {
    status: 200,
    body: {
      result: {
        result,
        result_error: resultError,
        result_total: resultTotal,
        result_next: resultNext,
        result_time: resultTime,
      },
    },
  }
}
