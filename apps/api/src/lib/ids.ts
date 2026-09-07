import { randomBytes, randomUUID } from 'node:crypto'

/** req_8f3c21a0d7 — идентификатор запроса, показывается в панели деталей лога. */
export function requestId(): string {
  return `req_${randomBytes(5).toString('hex')}`
}

/** evt_01J8Z6K2QF — идентификатор доставки события. */
export function deliveryId(): string {
  return `evt_${randomBytes(6).toString('hex')}`
}

/** tnl-8f21 — короткий идентификатор сессии туннеля для интерфейса. */
export function tunnelDisplayId(deviceId: string): string {
  let h = 0
  for (let i = 0; i < deviceId.length; i++) h = (Math.imul(h, 31) + deviceId.charCodeAt(i)) >>> 0
  return `tnl-${h.toString(16).padStart(8, '0').slice(0, 4)}`
}

export { randomUUID }
