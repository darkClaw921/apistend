import type { Sandbox } from '@prisma/client'
import type { ServiceCode } from '@apistend/shared'
import { productPool } from '@apistend/mock-engine'
import { handleCardsUpdate, handleCharacteristicsDirectory, applyWbCardOverlay } from './wb-content.ts'
import { handlePriceUpload, handleTaskHistory, applyWbPriceOverlay } from './wb-prices.ts'
import { handleMediaSave, handleMediaFile } from './wb-media.ts'
import { handleAttributesUpdate, handleImportInfo, applyOzonAttributesOverlay } from './ozon-content.ts'
import { handlePriceImport, applyOzonPriceInfoOverlay, applyOzonPriceListOverlay } from './ozon-prices.ts'
import { handlePicturesImport, applyOzonImagesOverlay } from './ozon-pictures.ts'

/**
 * Точка входа для операций, которые общая проекция каталога не умеет:
 * запись «Применить» в разборе карточки (название, описание, характеристики,
 * цена, фото) и их аналоги на Ozon, а ещё один особый случай чтения —
 * справочник характеристик предмета (см. ниже).
 *
 * Устроено как `respondAsApp` для локальных приложений Bitrix24 в gateway.ts:
 * ответ строится сам, минуя движок моков вовсе. Для записи это потому, что
 * состояние правок песочницы лежит в overlay (см. store.ts) и не имеет
 * отношения к тому, что генерирует движок. Для справочника характеристик —
 * потому, что общая проекция каталога путает его с товарным списком: запись
 * `{subjectID, subjectName, name}` похожа на запись справочника по предметам
 * (комиссии, тарифы), и движок разворачивал бы её по ОДНОЙ НА КАЖДЫЙ предмет
 * каталога сразу, вперемешку, игнорируя запрошенный `{subjectId}` из пути, —
 * а `name` получал бы значение «название товара», а не «название характеристики».
 */

export interface OverlayResult {
  readonly status: number
  readonly body: unknown
}

function firstValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

const CHARCS_PATH = /^\/content\/v2\/object\/charcs\/(\d+)$/

export async function interceptOverlayWrite(
  service: ServiceCode,
  httpMethod: string,
  path: string,
  sandbox: Sandbox,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>,
): Promise<OverlayResult | null> {
  if (service === 'wildberries') {
    if (httpMethod === 'POST' && path === '/content/v2/cards/update') return handleCardsUpdate(sandbox, body)
    if (httpMethod === 'POST' && path === '/api/v2/upload/task') return handlePriceUpload(sandbox, body)
    if (httpMethod === 'GET' && path === '/api/v2/history/tasks') {
      return handleTaskHistory(sandbox, firstValue(query.uploadID))
    }
    if (httpMethod === 'POST' && path === '/content/v3/media/save') return handleMediaSave(sandbox, body)
    if (httpMethod === 'POST' && path === '/content/v3/media/file') return handleMediaFile(sandbox, headers)
    if (httpMethod === 'GET') {
      const subjectMatch = CHARCS_PATH.exec(path)
      if (subjectMatch) {
        return handleCharacteristicsDirectory(Number(subjectMatch[1]), productPool(sandbox.dataVolume))
      }
    }
    return null
  }
  if (service === 'ozon') {
    if (httpMethod === 'POST' && path === '/v1/product/attributes/update') return handleAttributesUpdate(sandbox, body)
    if (httpMethod === 'POST' && path === '/v1/product/import/info') return handleImportInfo(sandbox, body)
    if (httpMethod === 'POST' && path === '/v1/product/import/prices') return handlePriceImport(sandbox, body)
    if (httpMethod === 'POST' && path === '/v1/product/pictures/import') return handlePicturesImport(sandbox, body)
    return null
  }
  return null
}

/**
 * Наложение overlay на уже собранный движком ответ чтения.
 *
 * Возвращает `true`, если тело действительно поменялось, — тогда вызывающая
 * сторона обязана пересериализовать его заново; движок отдаёт готовую JSON-
 * строку, и без этого сигнала правка осталась бы только в объекте, а клиенту
 * ушла бы прежняя строка. Для песочницы без единой правки все merge-функции
 * сами уходят пустыми (readOverlayMap не находит строк) — лишней записи
 * в базу или траты времени на чтение это не добавляет ни на один запрос
 * сверх одного дешёвого SELECT по индексу `(sandboxId, serviceCode, entityType)`.
 */
export async function applyOverlayToRead(
  service: ServiceCode,
  path: string,
  sandboxId: string,
  body: unknown,
): Promise<boolean> {
  if (service === 'wildberries') {
    if (path === '/content/v2/get/cards/list') return applyWbCardOverlay(sandboxId, body)
    if (path === '/api/v2/list/goods/filter') return applyWbPriceOverlay(sandboxId, body)
    return false
  }
  if (service === 'ozon') {
    if (path === '/v4/product/info/attributes') return applyOzonAttributesOverlay(sandboxId, body)
    if (path === '/v5/product/info/prices') return applyOzonPriceInfoOverlay(sandboxId, body)
    if (path === '/v3/product/info/list') {
      // Три overlay сразу: этот метод один показывает и характеристики,
      // и цену, и фото — как и при записи, порознь их не проверить.
      const attrs = await applyOzonAttributesOverlay(sandboxId, body)
      const price = await applyOzonPriceListOverlay(sandboxId, body)
      const images = await applyOzonImagesOverlay(sandboxId, body)
      return attrs || price || images
    }
    return false
  }
  return false
}
