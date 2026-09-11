import type { Prisma } from '@prisma/client'
import { prisma } from '../db.ts'

/**
 * Хранилище изменений продавца поверх общего каталога песочницы.
 *
 * Модель `SandboxOverlay` в схеме существовала и до этой правки (сброс
 * песочницы уже удаляет её строки — `POST /api/sandbox/reset`), но ничего
 * в неё не писало и ничего из неё не читало: «Применить» в разборе карточки
 * (правка названия, описания, характеристик, цены, фото) отвечала успехом
 * и не сохраняла ничего, а следующее чтение карточки отдавало прежние данные.
 *
 * Ключ строки — `(sandboxId, serviceCode, entityType, externalId)`, и это
 * ровно то, что делает состояние приватным для ключа: sandboxId приходит
 * из авторизации запроса, и одна песочница не может ни прочитать, ни
 * перезаписать overlay другой. `externalId` — артикул WB (nmID) или его
 * аналог у Ozon (offer_id/product_id/id загрузки) в виде строки.
 */

export type OverlayServiceCode = 'wildberries' | 'ozon'

/** Правки карточки контента: название, описание, характеристики. */
export interface WbCardOverlay {
  readonly title?: string
  readonly description?: string
  readonly characteristics?: ReadonlyArray<{ readonly id: number; readonly name: string; readonly value: unknown }>
}

/** Цена и скидка размера — тем же способом, каким их задаёт `/api/v2/upload/task`. */
export interface WbPriceOverlay {
  readonly price?: number
  readonly discount?: number
}

/** Медиафайлы карточки — полный список, «новые заменяют старые», как в бою. */
export interface WbPhotosOverlay {
  readonly photos: readonly string[]
}

/** Загрузка цен: какие nmID в неё входили — для отчёта о состоянии. */
export interface WbTaskOverlay {
  readonly nmIds: readonly number[]
}

/** Правки товара Ozon: название и характеристики (включая зарезервированное поле описания). */
export interface OzonItemOverlay {
  readonly name?: string
  readonly attributes?: ReadonlyArray<{ readonly id: number; readonly values: readonly unknown[] }>
}

export interface OzonPriceOverlay {
  readonly price?: number
  readonly oldPrice?: number
}

export interface OzonImagesOverlay {
  readonly images: readonly string[]
}

export interface OzonTaskOverlay {
  readonly offerIds: readonly string[]
}

/** Имена типов записей overlay — они же ключ, по которому строка ищется и переносится в JSON. */
export type OverlayEntityType =
  | 'wb-card' | 'wb-price' | 'wb-photos' | 'wb-task'
  | 'ozon-item' | 'ozon-price' | 'ozon-images' | 'ozon-task'

/** Одна запись поверх карточки: одна строка на (сервис, тип, внешний id) в песочнице. */
export async function readOverlay<T>(
  sandboxId: string,
  service: OverlayServiceCode,
  entityType: OverlayEntityType,
  externalId: string,
): Promise<T | null> {
  const row = await prisma.sandboxOverlay.findUnique({
    where: { sandboxId_serviceCode_entityType_externalId: { sandboxId, serviceCode: service, entityType, externalId } },
  })
  if (!row || row.deleted || row.data === null) return null
  return row.data as T
}

/** Все записи одного типа в песочнице — для наложения на списковый ответ разом, без запроса на каждый nmID. */
export async function readOverlayMap<T>(
  sandboxId: string,
  service: OverlayServiceCode,
  entityType: OverlayEntityType,
): Promise<ReadonlyMap<string, T>> {
  const rows = await prisma.sandboxOverlay.findMany({
    where: { sandboxId, serviceCode: service, entityType, deleted: false },
  })
  return new Map(
    rows.filter((r) => r.data !== null).map((r) => [r.externalId, r.data as T]),
  )
}

/**
 * Пишет запись overlay — целиком заменяет предыдущую.
 *
 * Не слияние: «Применить» в разборе карточки присылает итоговое состояние
 * поля (новое название целиком, а не патч к старому), и повторное
 * применение той же правки обязано давать тот же результат, а не
 * накапливать историю патчей.
 */
export async function writeOverlay<T extends object>(
  sandboxId: string,
  service: OverlayServiceCode,
  entityType: OverlayEntityType,
  externalId: string,
  // Конкретные типы (WbCardOverlay и т.д.) — простые объекты данных, но не
  // структурно совместимы с InputJsonValue (у него есть индексная сигнатура,
  // у них — нет): Prisma в рантайме это не волнует, ей нужен обычный JSON.
  // Параметр держит собственный тип T нетронутым — приведение происходит
  // только для самой Prisma, а не на границе вызова writeOverlay.
  data: T,
): Promise<void> {
  const json = data as unknown as Prisma.InputJsonValue
  await prisma.sandboxOverlay.upsert({
    where: { sandboxId_serviceCode_entityType_externalId: { sandboxId, serviceCode: service, entityType, externalId } },
    create: { sandboxId, serviceCode: service, entityType, externalId, data: json },
    update: { data: json, deleted: false },
  })
}
