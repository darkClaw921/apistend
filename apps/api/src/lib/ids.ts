import { randomBytes, randomUUID } from 'node:crypto'
import type { ServiceCode } from '@apistend/shared'
import { SERVICE_PROFILES } from '@apistend/shared'

/** req_8f3c21a0d7 — идентификатор запроса, показывается в панели деталей лога. */
export function requestId(): string {
  return `req_${randomBytes(5).toString('hex')}`
}

/**
 * Идентификатор вызова мок-шлюза — в том формате, в каком его отдаёт боевой сервис.
 *
 * Один и тот же идентификатор уходит клиенту в родном заголовке (X-Request-Id у WB,
 * x-o3-trace-id у Ozon), в поле requestId конверта ошибки WB и в журнал запросов.
 * Единственность здесь принципиальна: разработчик приносит в поддержку то число,
 * которое увидела его библиотека, и найтись оно должно с первого раза.
 *
 * У Битрикс24 такого заголовка нет вовсе, поэтому там остаётся собственный формат
 * APIStend — он виден только в x-apistend-request-id и в кабинете.
 */
export function gatewayRequestId(service: ServiceCode): string {
  switch (SERVICE_PROFILES[service].native.requestIdFormat) {
    case 'hex32':
      return randomBytes(16).toString('hex')
    case 'hex16':
      return randomBytes(8).toString('hex')
    default:
      return requestId()
  }
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
