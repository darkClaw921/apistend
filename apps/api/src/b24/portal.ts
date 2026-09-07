import { createHash, randomBytes } from 'node:crypto'
import { env } from '../env.ts'

/**
 * Демонстрационный портал Bitrix24.
 *
 * Приложение получает от портала три адреса и строит по ним всю работу:
 * DOMAIN (откуда его открыли), client_endpoint (куда слать REST) и server_endpoint
 * (куда идти за токенами). У нас все три указывают на один хост — так же, как
 * в коробочном Bitrix24, где сервер авторизации локальный.
 *
 * DOMAIN — именно хост, без схемы и без пути: приложение склеивает его само,
 * подставляя схему из PROTOCOL. Поэтому шлюз обязан отвечать на /rest/… в корне,
 * а не только на /b24/rest/… — иначе разработчик получит 404 на первом же вызове
 * и решит, что мок сломан.
 */

/** Хост портала: то, что приходит в DOMAIN. */
export function portalDomain(): string {
  return new URL(env.publicOrigin).host
}

/** PROTOCOL: «1» — https, «0» — http. У localhost всегда «0», и это честно. */
export function portalProtocol(): '0' | '1' {
  return env.publicOrigin.startsWith('https://') ? '1' : '0'
}

/** Базовый адрес REST портала — то, что уходит в client_endpoint. */
export function clientEndpoint(): string {
  return `${env.publicOrigin}/rest/`
}

/** Базовый адрес сервера авторизации — то, что уходит в server_endpoint. */
export function serverEndpoint(): string {
  return `${env.publicOrigin}/oauth/rest/`
}

/** Адрес библиотеки, которую приложение подключает вместо //api.bitrix24.tech/api/v1/. */
export function bx24JsUrl(): string {
  return `${env.publicOrigin}/api/v1/`
}

/**
 * member_id — постоянный идентификатор портала, не зависящий от домена.
 * Считается от песочницы: в боевом Bitrix24 он тоже не меняется от переезда портала.
 */
export function memberIdFor(sandboxId: string): string {
  return createHash('sha256').update(`apistend:member:${sandboxId}`).digest('hex').slice(0, 32)
}

/** client_id локального приложения: боевой формат local.<14 hex>.<8 цифр>. */
export function generateClientId(): string {
  const left = randomBytes(7).toString('hex')
  const right = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')
  return `local.${left}.${right}`
}

/** client_secret: 50 символов, как у боевого портала. */
export function generateClientSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(50)
  let out = ''
  for (let i = 0; i < 50; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

/**
 * Токены портала: 32 символа из строчных букв и цифр.
 * Формат снят с боевых значений (s1morf609228iwyjjpvfv6wsvuja4p8u) — приложения
 * иногда валидируют длину, и 64-символьный hex сломал бы такую проверку.
 */
export function generateOpaqueToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(32)
  let out = ''
  for (let i = 0; i < 32; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

/** APPLICATION_TOKEN и APP_SID — 32 hex, как в дампах документации. */
export function generateHexToken(): string {
  return randomBytes(16).toString('hex')
}

export interface PortalUser {
  readonly id: number
  readonly name: string
  readonly lastName: string
  readonly position: string
  readonly isAdmin: boolean
}

/**
 * Сотрудники портала.
 *
 * Список фиксированный и небольшой: он нужен диалогам выбора (BX24.selectUser)
 * и полю user_id в токене. Первый — администратор: именно от его имени
 * открывается приложение, а placement.bind и event.bind боевой портал
 * разрешает только администратору.
 */
export const PORTAL_USERS: readonly PortalUser[] = [
  { id: 1, name: 'Анна', lastName: 'Ковалёва', position: 'Руководитель отдела продаж', isAdmin: true },
  { id: 6, name: 'Дмитрий', lastName: 'Соколов', position: 'Менеджер по продажам', isAdmin: false },
  { id: 9, name: 'Ольга', lastName: 'Титова', position: 'Менеджер по продажам', isAdmin: false },
  { id: 14, name: 'Павел', lastName: 'Жуков', position: 'Технический специалист', isAdmin: false },
  { id: 21, name: 'Мария', lastName: 'Лебедева', position: 'Бухгалтер', isAdmin: false },
]

export function portalUser(id: number): PortalUser {
  return PORTAL_USERS.find((u) => u.id === id) ?? PORTAL_USERS[0]!
}

export function portalUserName(user: PortalUser): string {
  return `${user.name} ${user.lastName}`
}

export interface PortalDeal {
  readonly id: string
  readonly title: string
  readonly stage: string
  readonly opportunity: string
  readonly contact: string
}

/**
 * Сделки для карточки, в которую встраивается вкладка приложения.
 *
 * Берутся из того же движка моков, что отвечает на crm.deal.list — не из отдельного
 * набора демо-данных. Иначе вкладка показывала бы сделку, которой нет в REST,
 * и первый же вызов crm.deal.get из приложения вернул бы другую.
 */
export async function portalDeals(limit = 8): Promise<PortalDeal[]> {
  try {
    // Импорт отложенный: шлюз тянет токены приложений, токены — этот модуль,
    // и статическая ссылка на шлюз замкнула бы граф в кольцо.
    const { engine } = await import('../gateway.ts')
    const result = engine.handle({
      service: 'bitrix24',
      httpMethod: 'POST',
      path: '/rest/crm.deal.list',
      query: {},
      headers: {},
      body: null,
      requestId: 'portal',
      scenario: 'success',
      now: new Date(),
      salt: 'medium',
    })
    const parsed = JSON.parse(result.serialized) as { result?: unknown }
    const rows = Array.isArray(parsed.result) ? parsed.result : []
    return rows.slice(0, limit).map((raw, i) => {
      const row = (raw ?? {}) as Record<string, unknown>
      return {
        id: String(row.ID ?? row.id ?? 1000 + i),
        title: String(row.TITLE ?? row.title ?? `Сделка №${1000 + i}`),
        stage: String(row.STAGE_ID ?? 'NEW'),
        opportunity: String(row.OPPORTUNITY ?? '0'),
        contact: String(row.CONTACT_ID ?? row.ASSIGNED_BY_ID ?? ''),
      }
    })
  } catch {
    // Каталог может быть не собран (pnpm ingest не запускали) — портал обязан
    // открыться и без него, просто без карточки сделки.
    return []
  }
}
