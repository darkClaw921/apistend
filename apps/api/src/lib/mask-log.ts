import { maskSecretsInText } from './keys.ts'

/**
 * Маскирование секретов в том, что попадает в журнал запросов и в его выдачу.
 *
 * Записей в журнал пишет несколько источников: мок-шлюз, консоль кабинета и консоль
 * Management API. Каждый из них раньше решал вопрос по-своему, и консоль кабинета
 * не решала вовсе — рабочий ключ песочницы ложился в базу открытым текстом.
 * Общий модуль убирает выбор: где пишем и где читаем журнал, там и зовём это.
 *
 * Ключ приходит не только заголовком: у Bitrix24 он лежит в параметре auth,
 * и клиентские библиотеки дублируют его в теле запроса.
 */

export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike }

const SECRET_HEADERS = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'x-mock-key',
  'cookie',
  'set-cookie',
])

export function maskJson(value: unknown): JsonLike {
  if (typeof value === 'string') return maskSecretsInText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(maskJson)
  if (value && typeof value === 'object') {
    const out: { [key: string]: JsonLike } = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = maskJson(item)
    return out
  }
  // undefined сюда тоже приходит: в JSON его всё равно нет.
  return null
}

/** Заголовок авторизации не маскируется по частям — он заменяется целиком. */
export function maskHeaders(value: unknown): JsonLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return maskJson(value)
  const out: { [key: string]: JsonLike } = {}
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? '••••••' : maskJson(item)
  }
  return out
}

export function maskText(value: string | null): string | null {
  return value === null ? null : maskSecretsInText(value)
}
