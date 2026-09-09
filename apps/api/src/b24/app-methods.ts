import {
  B24_APP_ERRORS, B24_APP_STATUS_LOCAL, B24_LIFECYCLE_EVENTS, B24_SCOPES,
  bindableB24Placements, findB24Placement,
} from '@apistend/shared'
import { prisma } from '../db.ts'
import { clientEndpoint, memberIdFor, portalUser, portalUserName } from './portal.ts'
import type { AppContext } from './tokens.ts'

/**
 * REST-методы, отвечающие о состоянии самого приложения.
 *
 * Их нельзя отдать движку моков: движок — чистая функция от (метод, сценарий, объём
 * данных), а здесь ответ зависит от того, что приложение уже успело сделать.
 * placement.get обязан вернуть именно те виджеты, которые зарегистрировал
 * placement.bind минуту назад, иначе проверить свою установку разработчик не сможет.
 *
 * Всё, чего в этом списке нет, уходит в движок обычным порядком.
 */

/** Методы, у которых scope не проверяется. Список боевой: это «базовый» уровень. */
const BASIC_METHODS = new Set([
  'app.info', 'profile', 'scope', 'method.get', 'methods', 'server.time', 'access.name',
  'event.bind', 'event.unbind', 'event.get', 'batch',
  'app.option.get', 'app.option.set', 'user.option.get', 'user.option.set',
])

/**
 * Какое право нужно методу.
 *
 * Соответствие по префиксу — то же правило, по которому его определяет боевой портал.
 * Возвращает null, если метод базовый или префикс неизвестен: выдумывать право
 * для незнакомого метода нельзя, иначе мок начнёт отказывать там, где бой отвечает.
 */
export function scopeForMethod(method: string): string | null {
  const name = method.toLowerCase()
  if (BASIC_METHODS.has(name)) return null

  const prefix = name.split('.')[0] ?? ''
  const byPrefix: Record<string, string> = {
    crm: 'crm',
    task: 'task', tasks: 'task',
    user: 'user', department: 'department',
    placement: 'placement',
    im: 'im', imbot: 'imbot', imconnector: 'imconnector', imopenlines: 'imopenlines',
    entity: 'entity', disk: 'disk', calendar: 'calendar', bizproc: 'bizproc',
    catalog: 'catalog', sale: 'sale', salescenter: 'salescenter', delivery: 'delivery',
    telephony: 'telephony', voximplant: 'telephony',
    lists: 'lists', log: 'log', landing: 'landing', timeman: 'timeman',
    sonet_group: 'sonet_group', socialnetwork: 'sonet_group',
    documentgenerator: 'documentgenerator', messageservice: 'messageservice',
    pay_system: 'pay_system', cashbox: 'cashbox', booking: 'booking',
    biconnector: 'biconnector', rpa: 'rpa', pull: 'pull', vote: 'vote',
  }
  return byPrefix[prefix] ?? null
}

export interface AppMethodResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** Конверт time, который боевой портал добавляет к каждому ответу. */
export function buildTimeEnvelope(startedAt: number): Record<string, unknown> {
  const start = startedAt / 1000
  const finish = Date.now() / 1000
  return {
    start,
    finish,
    duration: finish - start,
    processing: Math.max(finish - start - 0.001, 0),
    date_start: new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    date_finish: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    operating: 0,
    // Заголовков лимита у Битрикс24 нет: остаток ресурсоёмкости клиент читает
    // отсюда. Документация лимитов прямо предписывает ориентироваться
    // на operating_reset_at — момент, когда счётчик operating обнулится.
    operating_reset_at: Math.floor(Date.now() / 1000) + 600,
  }
}

export function isAppMethod(method: string): boolean {
  const name = method.toLowerCase()
  return (
    name === 'app.info' ||
    name === 'profile' ||
    name === 'user.current' ||
    name === 'scope' ||
    name === 'method.get' ||
    name === 'methods' ||
    name === 'server.time' ||
    name === 'access.name' ||
    name.startsWith('placement.') ||
    name.startsWith('event.')
  )
}

/**
 * Выполняет метод в контексте приложения.
 *
 * Возвращает null, если метод не наш — вызывающий отдаёт его движку.
 */
export async function callAppMethod(
  ctx: AppContext,
  method: string,
  params: Record<string, unknown>,
): Promise<AppMethodResult | null> {
  const name = method.toLowerCase()

  switch (name) {
    case 'app.info':
      return { status: 200, body: { result: appInfo(ctx) } }
    case 'profile':
      return { status: 200, body: { result: profile(ctx) } }
    case 'user.current':
      return { status: 200, body: { result: currentUser(ctx) } }
    case 'scope':
      return { status: 200, body: { result: scopeList(ctx, params) } }
    case 'method.get':
      return { status: 200, body: { result: methodGet(ctx, params) } }
    case 'methods':
      return { status: 200, body: { result: ctx.app.scope } }
    case 'server.time':
      return { status: 200, body: { result: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00') } }
    case 'access.name':
      return { status: 200, body: { result: accessName(params) } }
    case 'placement.list':
      return { status: 200, body: { result: placementList(ctx, params) } }
    case 'placement.get':
      return { status: 200, body: { result: await placementGet(ctx) } }
    case 'placement.bind':
      return placementBind(ctx, params)
    case 'placement.unbind':
      return placementUnbind(ctx, params)
    case 'event.get':
      return { status: 200, body: { result: await eventGet(ctx) } }
    case 'event.bind':
      return eventBind(ctx, params)
    case 'event.unbind':
      return eventUnbind(ctx, params)
    default:
      return null
  }
}

function appInfo(ctx: AppContext): Record<string, unknown> {
  return {
    // Числовой ID приложения на портале. Боевой портал нумерует их подряд;
    // берём стабильное число из cuid, чтобы значение не менялось между вызовами.
    ID: numericId(ctx.app.id),
    CODE: ctx.app.code,
    VERSION: ctx.app.version,
    STATUS: B24_APP_STATUS_LOCAL,
    // Ключевое поле: до installFinish портал не доставляет события и не показывает
    // виджеты. Приложение обязано уметь это увидеть.
    INSTALLED: ctx.app.state === 'installed',
    PAYMENT_EXPIRED: 'N',
    DAYS: null,
    LANGUAGE_ID: 'ru',
    LICENSE: 'ru_demo',
    LICENSE_TYPE: 'demo',
    LICENSE_FAMILY: 'demo',
  }
}

function profile(ctx: AppContext): Record<string, unknown> {
  const user = portalUser(ctx.token.portalUserId)
  return {
    ID: String(user.id),
    ADMIN: user.isAdmin,
    NAME: user.name,
    LAST_NAME: user.lastName,
    PERSONAL_GENDER: '',
    PERSONAL_PHOTO: null,
    TIME_ZONE: 'Europe/Moscow',
    TIME_ZONE_OFFSET: 10800,
    STATUS: 'employee',
  }
}

/**
 * user.current обязан описывать того же сотрудника, что и profile.
 *
 * Через движок этот метод отдавал бы пользователя из спецификации, и приложение
 * видело бы противоречие: токен выписан на Анну Ковалёву, а user.current
 * возвращает John Smith. В бою такого расхождения нет.
 */
function currentUser(ctx: AppContext): Record<string, unknown> {
  const user = portalUser(ctx.token.portalUserId)
  return {
    ID: String(user.id),
    ACTIVE: true,
    NAME: user.name,
    LAST_NAME: user.lastName,
    SECOND_NAME: '',
    EMAIL: `${translit(user.name)}.${translit(user.lastName)}@example.com`.toLowerCase(),
    LAST_LOGIN: new Date().toISOString().replace(/\.\d{3}Z$/, '+03:00'),
    DATE_REGISTER: '2025-01-09T00:00:00+03:00',
    IS_ONLINE: 'Y',
    TIME_ZONE: 'Europe/Moscow',
    TIMESTAMP_X: new Date().toISOString().replace(/\.\d{3}Z$/, '+03:00'),
    WORK_POSITION: user.position,
    UF_DEPARTMENT: [1],
    USER_TYPE: 'employee',
  }
}

const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

function translit(value: string): string {
  return value.toLowerCase().split('').map((ch) => TRANSLIT[ch] ?? ch).join('')
}

function scopeList(ctx: AppContext, params: Record<string, unknown>): string[] {
  // full=true — все права сервиса, иначе выданные приложению. Так же у боевого метода.
  const full = params.full === true || params.full === 'true' || params.full === 1 || params.full === '1'
  return full ? B24_SCOPES.map((s) => s.code) : [...ctx.app.scope]
}

function methodGet(ctx: AppContext, params: Record<string, unknown>): Record<string, unknown> {
  const name = String(params.name ?? '')
  const required = scopeForMethod(name)
  return {
    method: name,
    isExisting: name.length > 0,
    isAvailable: required === null || ctx.app.scope.includes(required),
  }
}

function accessName(params: Record<string, unknown>): Record<string, string> {
  const raw = params.ACCESS ?? params.access
  const codes = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []
  const out: Record<string, string> = {}
  for (const code of codes) {
    if (code === 'AU') out[code] = 'Все авторизованные пользователи'
    else if (/^U(\d+)$/.test(code)) out[code] = portalUserName(portalUser(Number(code.slice(1))))
    else if (/^SG(\d+)$/.test(code)) out[code] = `Рабочая группа №${code.slice(2)}`
    else out[code] = code
  }
  return out
}

function placementList(ctx: AppContext, params: Record<string, unknown>): string[] {
  const scope = typeof params.SCOPE === 'string' ? params.SCOPE : typeof params.scope === 'string' ? params.scope : null
  const full = params.FULL === true || params.FULL === 'true' || params.full === true
  const scopes = full ? B24_SCOPES.map((s) => s.code) : ctx.app.scope
  const available = bindableB24Placements(scope ? [scope] : scopes)
  return available.map((p) => p.code)
}

async function placementGet(ctx: AppContext): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.b24AppPlacement.findMany({
    where: { appId: ctx.app.id },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({
    placement: row.placement,
    userId: 0,
    handler: row.handler,
    options: row.options ?? [],
    title: row.title ?? '',
    description: row.description ?? '',
    langAll: row.groupName
      ? { ru: { TITLE: row.title ?? '', DESCRIPTION: row.description ?? '', GROUP_NAME: row.groupName } }
      : {},
  }))
}

async function placementBind(
  ctx: AppContext,
  params: Record<string, unknown>,
): Promise<AppMethodResult> {
  const placement = String(params.PLACEMENT ?? params.placement ?? '').toUpperCase()
  const handler = String(params.HANDLER ?? params.handler ?? '')

  if (!placement || !handler) return restError('ERROR_ARGUMENT', 'Wrong argument')

  const definition = findB24Placement(placement)
  // Боевой портал отвечает ERROR_PLACEMENT_NOT_FOUND и на неизвестный код,
  // и на код, право для которого приложению не выдано. Разделять эти случаи
  // он не стал — не станем и мы.
  if (!definition || definition.code === 'DEFAULT') {
    return restError('ERROR_PLACEMENT_NOT_FOUND', 'Placement is not found')
  }
  if (definition.scope !== null && !ctx.app.scope.includes(definition.scope)) {
    return restError('ERROR_PLACEMENT_NOT_FOUND', 'Placement is not found')
  }

  // Единственное отличие от боевого портала во всём разделе, и оно намеренное:
  // ERROR_WRONG_HANDLER_URL на localhost здесь не выдаётся. Ради этого продукт
  // и существует. Схему всё же проверяем — она обязана быть http или https.
  if (!/^https?:\/\//i.test(handler)) {
    return restError('ERROR_UNSUPPORTED_PROTOCOL', 'Unsupported protocol')
  }

  const existing = await prisma.b24AppPlacement.count({ where: { appId: ctx.app.id, placement } })
  const already = await prisma.b24AppPlacement.findFirst({
    where: { appId: ctx.app.id, placement, handler },
  })
  if (!already && existing >= definition.maxHandlers) {
    return restError('ERROR_PLACEMENT_MAX_COUNT', 'Placement max count exceeded')
  }

  const data = {
    title: optionalString(params.TITLE ?? params.title),
    description: optionalString(params.DESCRIPTION ?? params.description),
    groupName: optionalString(params.GROUP_NAME ?? params.groupName),
    options: (params.OPTIONS ?? params.options ?? {}) as object,
  }

  if (already) {
    await prisma.b24AppPlacement.update({ where: { id: already.id }, data })
  } else {
    await prisma.b24AppPlacement.create({ data: { appId: ctx.app.id, placement, handler, ...data } })
  }

  return { status: 200, body: { result: true } }
}

async function placementUnbind(
  ctx: AppContext,
  params: Record<string, unknown>,
): Promise<AppMethodResult> {
  const placement = String(params.PLACEMENT ?? params.placement ?? '').toUpperCase()
  if (!placement) return restError('ERROR_ARGUMENT', 'Wrong argument')

  const handler = optionalString(params.HANDLER ?? params.handler)
  const where = handler
    ? { appId: ctx.app.id, placement, handler }
    : { appId: ctx.app.id, placement }
  const removed = await prisma.b24AppPlacement.deleteMany({ where })

  // Боевой count увеличивается дважды на запись: один раз при поиске, второй
  // после удаления. Странно, но воспроизводимо — приложения, сверяющие число,
  // должны получить то же значение.
  return { status: 200, body: { result: { count: removed.count * 2 } } }
}

async function eventGet(ctx: AppContext): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.webhook.findMany({
    // События жизненного цикла приложение не регистрировало — портал шлёт их
    // на адрес из карточки, и в event.get им не место.
    where: { appId: ctx.app.id, event: { notIn: [...B24_LIFECYCLE_EVENTS] } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({
    event: row.event,
    handler: row.targetUrl ?? '',
    auth_type: 0,
    offline: 0,
    options: [],
  }))
}

/**
 * event.bind заводит обычную подписку — ту же, что создаёт пользователь на экране
 * «Вебхуки», только с пометкой приложения. Так событие приложения попадает
 * в общий журнал доставок и подчиняется той же политике повторов, что и всё
 * остальное у Bitrix24: повторов нет вовсе.
 */
async function eventBind(ctx: AppContext, params: Record<string, unknown>): Promise<AppMethodResult> {
  const event = String(params.event ?? params.EVENT ?? '').toUpperCase()
  const handler = String(params.handler ?? params.HANDLER ?? '')
  if (!event || !handler) return restError('ERROR_ARGUMENT', 'Wrong argument')
  if (!/^https?:\/\//i.test(handler)) {
    return restError('ERROR_UNSUPPORTED_PROTOCOL', 'Unsupported protocol')
  }

  const existing = await prisma.webhook.findFirst({
    where: { appId: ctx.app.id, event, targetUrl: handler },
  })
  if (existing) {
    await prisma.webhook.update({ where: { id: existing.id }, data: { status: 'active' } })
    return { status: 200, body: { result: true } }
  }

  await prisma.webhook.create({
    data: {
      sandboxId: ctx.sandbox.id,
      appId: ctx.app.id,
      serviceCode: 'bitrix24',
      event,
      httpMethod: 'POST',
      target: 'public',
      targetUrl: handler,
      // Подпись доставки у Bitrix24 — это application_token в теле, отдельного
      // секрета подписки не существует. Кладём тот же токен, чтобы приложение
      // сверяло одно значение и во фрейме, и в событии.
      secret: ctx.app.applicationToken,
      status: 'active',
    },
  })

  return { status: 200, body: { result: true } }
}

async function eventUnbind(ctx: AppContext, params: Record<string, unknown>): Promise<AppMethodResult> {
  const event = String(params.event ?? params.EVENT ?? '').toUpperCase()
  if (!event) return restError('ERROR_ARGUMENT', 'Wrong argument')
  const handler = optionalString(params.handler ?? params.HANDLER)

  const removed = await prisma.webhook.deleteMany({
    where: handler
      ? { appId: ctx.app.id, event, targetUrl: handler }
      : { appId: ctx.app.id, event },
  })
  return { status: 200, body: { result: { count: removed.count } } }
}

function restError(error: string, description: string): AppMethodResult {
  return { status: 400, body: { error, error_description: description } }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Стабильное трёхзначное число из cuid — для полей, где боевой портал даёт числовой ID. */
function numericId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return (h % 900) + 100
}

/** member_id портала. Вынесено сюда, чтобы шлюз не тянул модуль portal напрямую. */
export function memberId(sandboxId: string): string {
  return memberIdFor(sandboxId)
}

export { clientEndpoint }

/** Ошибки контекста приложения, которых у ключа песочницы не бывает. */
export const APP_ERRORS = B24_APP_ERRORS
