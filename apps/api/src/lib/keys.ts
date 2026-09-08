import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { env } from '../env.ts'

/**
 * Ключи доступа.
 *
 * Префиксы из макета: stend_sbx_… — ключ песочницы (им ходит код пользователя),
 * stend_sk_… — серверный ключ (им авторизуется CLI).
 * Полный ключ показывается один раз при создании, дальше только маска.
 *
 * Почему ключи хешируются HMAC-SHA256, а не argon2, в отличие от паролей:
 * ключ проверяется на КАЖДОМ запросе к мок-шлюзу, а argon2id с memoryCost 19 МБ
 * занимает десятки миллисекунд — это сожгло бы весь бюджет задержки (в макете 41 мс).
 * Подбор здесь не при чём: ключ — 128 бит криптослучайности, а не пароль человека,
 * словарной атаки на него не существует. Пароли пользователей остаются на argon2id.
 */

export type KeyKind = 'sandbox' | 'server'

const PREFIX: Record<KeyKind, string> = { sandbox: 'stend_sbx_', server: 'stend_sk_' }

export interface GeneratedKey {
  /** Полный ключ. Показывается пользователю ровно один раз. */
  full: string
  /** stend_sbx_7f3a — начало, видно всегда. */
  prefix: string
  /** 4c21 — хвост, видно всегда. */
  suffix: string
  /** Значение для колонки keyHash. */
  hash: string
}

export function generateKey(kind: KeyKind): GeneratedKey {
  const body = randomBytes(16).toString('hex')
  const full = `${PREFIX[kind]}${body}`
  return {
    full,
    prefix: `${PREFIX[kind]}${body.slice(0, 4)}`,
    suffix: body.slice(-4),
    hash: hashApiKey(full),
  }
}

/** Детерминированный хеш для поиска по уникальному индексу. */
export function hashApiKey(full: string): string {
  return createHmac('sha256', env.jwtSecret).update(full).digest('hex')
}

export function keyKindOf(raw: string): KeyKind | null {
  if (raw.startsWith(PREFIX.server)) return 'server'
  if (raw.startsWith(PREFIX.sandbox)) return 'sandbox'
  return null
}

export function maskOf(prefix: string, suffix: string): string {
  return `${prefix}••••••${suffix}`
}

/** Сравнение без утечки по времени — для секретов подписи вебхуков. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ── пароли пользователей: тут argon2id уместен ──

const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

/**
 * Прячет секреты в тексте, который уходит в журнал запросов.
 *
 * Ключ приходит не только заголовком: у Bitrix24 он лежит в параметре auth,
 * и интеграции часто дублируют его в теле. Тело запроса — данные пользователя,
 * их журнал хранит, и вместе с ними сохранялся рабочий ключ открытым текстом.
 * Оставляем начало и хвост — ровно столько, чтобы узнать свой ключ в списке.
 */
export function maskSecretsInText(text: string): string {
  return text.replace(
    /(stend_(?:sbx|sk|whsec)_)([0-9a-f]{8,})/gi,
    (_all, prefix: string, body: string) => `${prefix}${body.slice(0, 4)}••••${body.slice(-4)}`,
  )
}
