/**
 * Проверка адреса получателя вебхука.
 *
 * Публичную доставку делает сервер APIStend, поэтому адрес из песочницы — это запрос,
 * который сервер выполнит от своего имени. Без проверки любой пользователь мог бы
 * заставить его ходить во внутреннюю сеть (169.254.169.254 и прочие метаданные),
 * а серия событий превращает это ещё и в усилитель нагрузки на чужой адрес.
 *
 * Имя резолвим: запрет только по литералу обходится доменом, который указывает
 * на приватный адрес. От перепривязки DNS между проверкой и запросом это не спасает —
 * полное решение требует своего резолвера в агенте доставки; ограничение осознанное
 * и записано здесь, а не забыто.
 *
 * В разработке приватные адреса разрешены: API и приложение живут на одной машине.
 * Переключатель — WEBHOOK_ALLOW_PRIVATE_TARGETS.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { env } from '../env.ts'

export type TargetVerdict = { ok: true } | { ok: false; reason: string }

/** Диапазоны, которые не должен видеть общий сервис доставки. Экспортировано ради теста. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // метаданные облаков
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  if (v === 6) {
    const s = address.toLowerCase()
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fc') || s.startsWith('fd')) return true // уникальные локальные
    if (s.startsWith('fe80')) return true // link-local
    // IPv4, завёрнутый в IPv6. Записывается двумя способами, и адресную строку
    // браузер с new URL приводит ко второму: ::ffff:127.0.0.1 превращается
    // в ::ffff:7f00:1. Пока разбиралась только десятичная форма, обёрнутый
    // localhost проходил проверку насквозь.
    const decimal = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (decimal) return isPrivateAddress(decimal[1]!)

    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
    if (hex) {
      const high = parseInt(hex[1]!, 16)
      const low = parseInt(hex[2]!, 16)
      const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
      return isPrivateAddress(v4)
    }
    return false
  }
  return false
}

export async function checkPublicTarget(rawUrl: string): Promise<TargetVerdict> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'Адрес получателя разобрать не удалось' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Поддерживаются только адреса http и https' }
  }
  if (env.allowPrivateWebhookTargets) return { ok: true }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: privateReason(host) }
      : { ok: true }
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { ok: false, reason: privateReason(host) }
  }

  try {
    const addresses = await lookup(host, { all: true })
    const bad = addresses.find((a) => isPrivateAddress(a.address))
    if (bad) return { ok: false, reason: privateReason(`${host} → ${bad.address}`) }
  } catch {
    return { ok: false, reason: `Имя ${host} не разрешается в адрес` }
  }
  return { ok: true }
}

function privateReason(what: string): string {
  return `Адрес ${what} внутренний. Для доставки на свою машину используйте локальный получатель и apistend listen`
}
