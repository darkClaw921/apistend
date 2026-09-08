/**
 * Публичная поверхность пакета.
 *
 * Пакет писался как инструмент сборки каталога и запускался только через cli.ts,
 * поэтому поле exports в package.json указывало на несуществующий файл. Разбор
 * OpenAPI понадобился и в рантайме — импорту своих моков из спецификации, —
 * и повторять его второй раз в apps/api было бы хуже, чем открыть здесь.
 *
 * Наружу выходит только разбор OpenAPI: остальные модули (ингест Bitrix24,
 * Ozon, Wildberries, сценарии) — build-time инструменты, им в рантайме
 * делать нечего.
 */
export {
  HTTP_METHODS,
  cleanText,
  extractParams,
  extractResponse,
  firstSentence,
  iterateOperations,
  makeResolver,
  resolveHost,
} from './openapi.ts'

export type {
  ExtractedParam,
  ExtractedResponse,
  OpenApiDoc,
  Operation,
  PathItem,
} from './openapi.ts'
