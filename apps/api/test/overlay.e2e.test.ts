import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { productPool } from '@apistend/mock-engine'
import { buildServer } from '../src/server.ts'
import { prisma } from '../src/db.ts'
import { generateKey, hashPassword } from '../src/lib/keys.ts'
import { invalidateKeyCache } from '../src/lib/api-key.ts'
import { resetRateLimits } from '../src/lib/rate-limit.ts'

/**
 * «Применить» в разборе карточки — запись поверх каталога, а не ответ,
 * который забывается сразу после отправки.
 *
 * Проверяется ровно то, чего раньше не было: `cards/update`/`upload/task`/
 * `media/save` отвечали успехом, но следующее чтение отдавало прежние
 * данные — кнопка «Применить» работала бы на стенде только на вид.
 */

let api: Awaited<ReturnType<typeof buildServer>>
let userId = ''
let key = ''
let otherKey = ''

const pool = productPool('medium')

async function call(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; key?: string } = {},
) {
  const response = await api.inject({
    method: (init.method ?? 'GET') as 'GET',
    url,
    headers: {
      authorization: `Bearer ${init.key ?? key}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    payload: init.body,
  })
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, any>) : null,
  }
}

async function makeSandboxKey(login: string) {
  const user = await prisma.user.create({
    data: {
      login,
      passwordHash: await hashPassword('apistend-overlay-e2e-2026'),
      name: 'Тест overlay',
      initials: 'ТО',
    },
  })
  const sandbox = await prisma.sandbox.create({
    data: { userId: user.id, name: `overlay-${randomBytes(4).toString('hex')}`, project: 'e2e', latencyMs: 0, errorRate: 0 },
  })
  const generated = generateKey('server')
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id,
      name: 'ключ overlay',
      kind: 'server',
      prefix: generated.prefix,
      suffix: generated.suffix,
      keyHash: generated.hash,
      services: ['wildberries', 'ozon'],
      scopes: [],
      status: 'active',
    },
  })
  return { userId: user.id, key: generated.full }
}

beforeAll(async () => {
  api = await buildServer()
  await api.ready()

  const main = await makeSandboxKey(`overlay-${randomBytes(4).toString('hex')}`)
  userId = main.userId
  key = main.key
  const other = await makeSandboxKey(`overlay-b-${randomBytes(4).toString('hex')}`)
  otherKey = other.key

  invalidateKeyCache()
  resetRateLimits()
})

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
  await api.close()
})

describe('Wildberries — контент карточки', () => {
  const product = pool[0]!

  it('cards/update сохраняет название, описание и характеристики, а cards/list их отдаёт', async () => {
    const update = await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{
        nmID: product.nmId,
        vendorCode: product.vendorCode,
        sizes: [{ chrtID: product.chrtId, techSize: '0', skus: [product.barcode] }],
        title: 'Новое название после разбора карточки',
        description: 'Новое описание, исправленное продавцом.',
        characteristics: [{ id: 14177449, value: ['красный'] }],
      }],
    })
    expect(update.status).toBe(200)
    expect(update.body).toMatchObject({ error: false })

    const list = await call('/wb/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { filter: { textSearch: String(product.nmId) } } },
    })
    const card = list.body!.cards.find((c: any) => c.nmID === product.nmId)
    expect(card.title).toBe('Новое название после разбора карточки')
    expect(card.description).toBe('Новое описание, исправленное продавцом.')
    expect(card.characteristics).toEqual([{ id: 14177449, name: 'Цвет', value: ['красный'] }])
  })

  it('другая песочница той же правки не видит', async () => {
    const list = await call('/wb/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { filter: { textSearch: String(product.nmId) } } },
      key: otherKey,
    })
    const card = list.body!.cards.find((c: any) => c.nmID === product.nmId)
    expect(card.title).not.toBe('Новое название после разбора карточки')
  })

  it('неизвестный nmID отклоняется, а не отвечает успехом', async () => {
    const res = await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{ nmID: 999999999, vendorCode: 'ART-x', sizes: [{ skus: ['1'] }], title: 'x' }],
    })
    expect(res.status).toBe(400)
    expect(res.body!.error).toBe(true)
  })

  it('обязательные поля и лимит длины названия проверяются', async () => {
    const missingSizes = await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{ nmID: product.nmId, vendorCode: product.vendorCode }],
    })
    expect(missingSizes.status).toBe(400)

    const longTitle = await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{
        nmID: product.nmId, vendorCode: product.vendorCode,
        sizes: [{ skus: ['1'] }], title: 'а'.repeat(61),
      }],
    })
    expect(longTitle.status).toBe(400)
  })

  it('неизвестная характеристика отклоняется', async () => {
    const res = await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{
        nmID: product.nmId, vendorCode: product.vendorCode,
        sizes: [{ skus: ['1'] }], characteristics: [{ id: 1, value: ['x'] }],
      }],
    })
    expect(res.status).toBe(400)
    expect(res.body!.errorText).toContain('some items failed validation')
  })
})

describe('Wildberries — справочник характеристик предмета', () => {
  it('отдаёт характеристики только запрошенного предмета — с их настоящими именами', async () => {
    const product = pool[8]!
    const res = await call(`/wb/content/v2/object/charcs/${product.subjectId}`)
    expect(res.status).toBe(200)
    const data = res.body!.data as any[]
    expect(data.length).toBeGreaterThan(0)
    // Один и тот же subjectID у всех строк — тот, что спросили, а не вперемешку.
    expect(new Set(data.map((c) => c.subjectID))).toEqual(new Set([product.subjectId]))
    expect(data.every((c) => c.subjectName === product.subjectName)).toBe(true)
    // name — название характеристики («Цвет»), а не название товара.
    expect(data.map((c) => c.name)).toContain('Цвет')
    expect(data.map((c) => c.name)).not.toContain(product.title)
  })

  it('характеристика из справочника — та же, что принимает cards/update и отдаёт cards/list', async () => {
    const product = pool[9]!
    const directory = await call(`/wb/content/v2/object/charcs/${product.subjectId}`)
    const color = (directory.body!.data as any[]).find((c) => c.name === 'Цвет')
    expect(color).toBeTruthy()

    const update = await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{
        nmID: product.nmId, vendorCode: product.vendorCode, sizes: [{ skus: ['1'] }],
        characteristics: [{ id: color.charcID, value: ['зелёный'] }],
      }],
    })
    expect(update.status).toBe(200)

    const list = await call('/wb/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { filter: { textSearch: String(product.nmId) } } },
    })
    const card = list.body!.cards.find((c: any) => c.nmID === product.nmId)
    expect(card.characteristics).toEqual([{ id: color.charcID, name: 'Цвет', value: ['зелёный'] }])
  })
})

describe('Wildberries — цены', () => {
  const product = pool[1]!

  it('upload/task сохраняет цену и скидку, list/goods/filter их отдаёт, history/tasks подтверждает обработку', async () => {
    const upload = await call('/wb/api/v2/upload/task', {
      method: 'POST',
      body: { data: [{ nmID: product.nmId, price: 5000, discount: 20 }] },
    })
    expect(upload.status).toBe(200)
    const taskId = upload.body!.data.id
    expect(typeof taskId).toBe('number')

    const filtered = await call(`/wb/api/v2/list/goods/filter?filterNmID=${product.nmId}`)
    const good = filtered.body!.data.listGoods[0]
    expect(good.discount).toBe(20)
    expect(good.sizes[0].price).toBe(5000)
    expect(good.sizes[0].discountedPrice).toBe(4000)

    const history = await call(`/wb/api/v2/history/tasks?uploadID=${taskId}`)
    expect(history.body!.data).toMatchObject({ uploadID: taskId, status: 3, overAllGoodsNumber: 1, successGoodsNumber: 1 })
  })

  it('цена и скидка не могут быть пустыми одновременно, а неизвестный nmID отклоняется', async () => {
    const neither = await call('/wb/api/v2/upload/task', { method: 'POST', body: { data: [{ nmID: product.nmId }] } })
    expect(neither.status).toBe(400)

    const unknown = await call('/wb/api/v2/upload/task', { method: 'POST', body: { data: [{ nmID: 999999999, price: 100 }] } })
    expect(unknown.status).toBe(400)
  })
})

describe('Wildberries — медиа', () => {
  it('media/save заменяет фото, cards/list их отдаёт', async () => {
    const product = pool[2]!
    const save = await call('/wb/content/v3/media/save', {
      method: 'POST',
      body: { nmId: product.nmId, data: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] },
    })
    expect(save.status).toBe(200)

    const list = await call('/wb/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { filter: { textSearch: String(product.nmId) } } },
    })
    const card = list.body!.cards.find((c: any) => c.nmID === product.nmId)
    expect(card.photos).toHaveLength(2)
    expect(card.photos[0].big).toBe('https://example.com/a.jpg')
  })

  it('media/file добавляет один файл по заголовкам X-Nm-Id/X-Photo-Number', async () => {
    const product = pool[3]!
    const upload = await call('/wb/content/v3/media/file', {
      method: 'POST',
      headers: { 'x-nm-id': String(product.nmId), 'x-photo-number': '1' },
    })
    expect(upload.status).toBe(200)

    const list = await call('/wb/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { filter: { textSearch: String(product.nmId) } } },
    })
    const card = list.body!.cards.find((c: any) => c.nmID === product.nmId)
    expect(card.photos).toHaveLength(1)
  })
})

describe('Ozon — характеристики и описание', () => {
  const product = pool[4]!

  it('attributes/update сохраняет описание, import/info подтверждает статус, product/info/attributes его отдаёт', async () => {
    const update = await call('/oz/v1/product/attributes/update', {
      method: 'POST',
      body: {
        items: [{
          offer_id: product.vendorCode,
          attributes: [{ id: 4191, values: [{ value: 'Новое описание товара на Ozon' }] }],
        }],
      },
    })
    expect(update.status).toBe(200)
    const taskId = update.body!.task_id
    expect(taskId).toBeTypeOf('number')

    const status = await call('/oz/v1/product/import/info', { method: 'POST', body: { task_id: String(taskId) } })
    expect(status.body!.result.items[0]).toMatchObject({ offer_id: product.vendorCode, status: 'imported' })

    const read = await call('/oz/v4/product/info/attributes', {
      method: 'POST',
      body: { filter: { offer_id: [product.vendorCode] }, limit: 10 },
    })
    const item = read.body!.result.find((i: any) => i.offer_id === product.vendorCode)
    const description = item.attributes.find((a: any) => a.id === 4191)
    expect(description.values[0].value).toBe('Новое описание товара на Ozon')
  })

  it('неизвестный offer_id отклоняется', async () => {
    const res = await call('/oz/v1/product/attributes/update', {
      method: 'POST',
      body: { items: [{ offer_id: 'нет-такого-артикула', attributes: [{ id: 4191, values: [{ value: 'x' }] }] }] },
    })
    expect(res.status).toBe(404)
  })
})

describe('Ozon — цены', () => {
  const product = pool[5]!

  it('import/prices сохраняет цену синхронно, info/prices её отдаёт', async () => {
    const upload = await call('/oz/v1/product/import/prices', {
      method: 'POST',
      body: { prices: [{ offer_id: product.vendorCode, price: '4200', old_price: '5000' }] },
    })
    expect(upload.status).toBe(200)
    expect(upload.body!.result[0]).toMatchObject({ offer_id: product.vendorCode, updated: true })

    const read = await call('/oz/v5/product/info/prices', {
      method: 'POST',
      body: { filter: { offer_id: [product.vendorCode] }, limit: 10 },
    })
    const item = read.body!.items.find((i: any) => i.offer_id === product.vendorCode)
    expect(item.price.price).toBe('4200')
    expect(item.price.old_price).toBe('5000')
  })
})

describe('Ozon — изображения', () => {
  const product = pool[6]!

  it('pictures/import сохраняет изображения, product/info/list их отдаёт', async () => {
    const upload = await call('/oz/v1/product/pictures/import', {
      method: 'POST',
      body: { product_id: product.chrtId, images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'] },
    })
    expect(upload.status).toBe(200)
    expect(upload.body!.result.pictures).toHaveLength(2)

    const read = await call('/oz/v3/product/info/list', {
      method: 'POST',
      body: { offer_id: [product.vendorCode] },
    })
    const item = read.body!.items.find((i: any) => i.offer_id === product.vendorCode)
    expect(item.images).toEqual(['https://example.com/1.jpg', 'https://example.com/2.jpg'])
  })
})

describe('Состояние переживает повторные запросы', () => {
  it('второе чтение после того же применения отдаёт то же самое', async () => {
    const product = pool[7]!
    await call('/wb/content/v2/cards/update', {
      method: 'POST',
      body: [{ nmID: product.nmId, vendorCode: product.vendorCode, sizes: [{ skus: ['1'] }], title: 'Устойчивое название' }],
    })
    for (let i = 0; i < 3; i++) {
      const list = await call('/wb/content/v2/get/cards/list', {
        method: 'POST',
        body: { settings: { filter: { textSearch: String(product.nmId) } } },
      })
      const card = list.body!.cards.find((c: any) => c.nmID === product.nmId)
      expect(card.title).toBe('Устойчивое название')
    }
  })
})
