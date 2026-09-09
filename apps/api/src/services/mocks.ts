import type { CustomMock } from '@prisma/client'
import { parse as parseYaml } from 'yaml'
import { prisma } from '../db.ts'
import {
  cleanText, extractResponse, firstSentence, iterateOperations, makeResolver,
  type OpenApiDoc,
} from '@apistend/catalog-ingest'

/**
 * Общая часть «своих моков» для кабинета и для Management API.
 *
 * Разбор спецификации и проверка занятости пары «метод + путь» нужны обоим
 * маршрутам одинаково, а разойдясь, они разошлись бы молча: кабинет продолжил бы
 * пропускать дубли при импорте, а публичный API — падать на них пятисоткой.
 * Поэтому логика живёт здесь, а маршруты остаются только про форму запроса
 * и форму ответа. Кабинетный routes/mocks.ts переедет сюда отдельно.
 */

/** Методы, которые умеет обслуживать движок /custom/*: HEAD и OPTIONS ему нечего отдавать. */
export const MOCKABLE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type MockableMethod = (typeof MOCKABLE_METHODS)[number]

export const MOCK_STATUSES = ['active', 'draft', 'disabled'] as const
export type MockStatus = (typeof MOCK_STATUSES)[number]

/**
 * Мок достижим только по ветке /custom/* — другого обработчика у него нет.
 * Путь вне этой ветки создаёт мок, который никогда не ответит.
 */
export const MOCK_PATH_PREFIX = '/custom/'

/** Колонка path в базе не ограничена, но склейка длинных путей в импорте — см. importMocksFromSpec. */
export const MOCK_PATH_MAX_LENGTH = 300

/** P2002 — нарушение уникального индекса (sandboxId, httpMethod, path). */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'
}

/**
 * Занята ли пара «метод + путь» в песочнице.
 *
 * exceptId — для правки: мок не конфликтует сам с собой, иначе PATCH, не меняющий
 * путь, отвечал бы 409 на собственную запись.
 *
 * Проверка не отменяет обработку P2002 у вызывающего: между SELECT и INSERT
 * помещается параллельный запрос. Она нужна ради внятного сообщения в обычном
 * случае, а уникальный индекс — ради правильности в редком.
 */
export function findMockConflict(
  sandboxId: string,
  httpMethod: string,
  path: string,
  exceptId?: string,
): Promise<CustomMock | null> {
  return prisma.customMock.findFirst({
    where: { sandboxId, httpMethod, path, ...(exceptId ? { id: { not: exceptId } } : {}) },
  })
}

/** Имена параметров из шаблона пути: /custom/orders/{id}/lines/{line} → [id, line] */
export function pathParamNames(path: string): string[] {
  return path.split('/')
    .filter((s) => s.startsWith('{') && s.endsWith('}') && s.length > 2)
    .map((s) => s.slice(1, -1))
}

/**
 * OpenAPI приходит и в JSON, и в YAML. Сначала пробуем JSON — он строже
 * и дешевле, и только потом подключаем разбор YAML.
 *
 * Ошибка возвращается значением, а не исключением: оба вызывающих отвечают на неё
 * своим кодом (кабинет — PARSE_FAILED, Management API — 400 VALIDATION),
 * и ловить исключение ради этого обоим одинаково незачем.
 */
export function parseSpec(raw: string): { ok: true; doc: OpenApiDoc } | { ok: false; message: string } {
  const text = raw.trim()
  let doc: OpenApiDoc
  try {
    doc = (text.startsWith('{') ? JSON.parse(text) : parseYaml(text)) as OpenApiDoc
  } catch (e) {
    return { ok: false, message: `Не удалось разобрать файл: ${e instanceof Error ? e.message : 'неизвестная ошибка'}` }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, message: 'Файл разобран, но это не документ OpenAPI' }
  if (!doc.paths || Object.keys(doc.paths).length === 0) {
    return { ok: false, message: 'В файле нет ни одного пути (paths)' }
  }
  return { ok: true, doc }
}

export interface ImportOptions {
  sandboxId: string
  /** Куда сложить импортированное: /custom/imported + путь из спецификации. */
  pathPrefix: string
  status: MockStatus
  /** Потолок за один вызов: спецификация на тысячу операций забьёт песочницу. */
  limit: number
}

export interface ImportedMock {
  id: string
  httpMethod: string
  path: string
  title: string
}

export interface SkippedOperation {
  httpMethod: string
  path: string
  /** duplicate — такой мок уже есть; path_too_long — путь длиннее допустимого. */
  reason: 'duplicate' | 'path_too_long'
}

export interface ImportResult {
  created: ImportedMock[]
  skipped: SkippedOperation[]
  /** Операции, до которых импорт не дошёл из-за limit. Молчать о них нельзя. */
  leftOver: number
}

/**
 * Создаёт моки по операциям спецификации.
 *
 * Тело ответа — пример из спецификации, если он там есть. Выдумывать ответ
 * по схеме здесь не станем: мок, отдающий придуманное, хуже мока, отдающего
 * пустой объект, — второй хотя бы честен.
 *
 * Дубли пропускаются, а не роняют импорт: повторный импорт того же файла —
 * обычное дело, и половина созданных моков при падении на середине хуже,
 * чем отчёт «столько-то пропущено».
 */
export async function importMocksFromSpec(doc: OpenApiDoc, options: ImportOptions): Promise<ImportResult> {
  const resolve = makeResolver(doc)
  const prefix = options.pathPrefix.replace(/\/$/, '')
  const created: ImportedMock[] = []
  const skipped: SkippedOperation[] = []
  let leftOver = 0

  for (const { path, method, op } of iterateOperations(doc)) {
    if (!MOCKABLE_METHODS.includes(method as MockableMethod)) continue
    if (created.length >= options.limit) {
      // Здесь напрашивается break, но тогда остаток спецификации исчезает молча:
      // ответ «создано 100» на файле из 460 операций читается как «всё готово».
      leftOver++
      continue
    }

    const mockPath = `${prefix}${path}`
    // Обрезка склеила бы разные операции в один путь, и вторая ушла бы в дубли.
    if (mockPath.length > MOCK_PATH_MAX_LENGTH) {
      skipped.push({ httpMethod: method, path: mockPath.slice(0, 80), reason: 'path_too_long' })
      continue
    }

    const response = extractResponse(op, resolve)
    const title = firstSentence(cleanText(op.summary ?? op.description ?? path), 110) || path

    try {
      const mock = await prisma.customMock.create({
        data: {
          sandboxId: options.sandboxId,
          httpMethod: method,
          path: mockPath,
          title: title.slice(0, 120),
          status: options.status,
          responseStatusCode: response.successStatus,
          contentType: 'application/json',
          delayMs: 250,
          templatingEnabled: true,
          // null в примере равнозначен его отсутствию: строка «null» в теле ответа
          // выглядит как ошибка, а обещали пустой объект.
          responseBody: response.example == null
            ? '{}'
            : JSON.stringify(response.example, null, 2).slice(0, 200_000),
          headers: {},
          rules: [],
        },
      })
      created.push({ id: mock.id, httpMethod: mock.httpMethod, path: mock.path, title: mock.title })
    } catch (e) {
      if (isUniqueViolation(e)) skipped.push({ httpMethod: method, path: mockPath, reason: 'duplicate' })
      else throw e
    }
  }

  return { created, skipped, leftOver }
}
