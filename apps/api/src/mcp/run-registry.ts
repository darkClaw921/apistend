import { LruCache } from '@apistend/mock-engine'

/**
 * Запуски акторов, сделанные через мок MCP.
 *
 * Агент почти никогда не ограничивается одним вызовом: он запускает актора,
 * получает `runId` и `datasetId`, а потом отдельным вызовом забирает элементы
 * датасета — часто уже в следующем витке диалога. Без реестра второй вызов
 * уходил бы в мок REST и возвращал образец из спецификации Apify
 * (`[{"foo":"bar"}]`) вместо строк, которые только что отдал запуск. Агент,
 * проверяющий свой разбор выдачи, увидел бы разрыв ровно там, где боевой Apify
 * его не даёт.
 *
 * Реестр живёт в памяти процесса и переживает только его. Это осознанно:
 * запуска на самом деле не было, хранить его в базе — значит выдавать
 * образец за состояние. Идентификаторы запуска и датасета детерминированы
 * (актор + вход), поэтому повторный вызов после перезапуска даёт те же
 * идентификаторы и снова наполняет реестр.
 */

export interface RecordedRun {
  readonly run: Record<string, unknown>
  readonly datasetId: string
  readonly items: readonly Record<string, unknown>[]
}

/**
 * Потолок — тысяча запусков.
 *
 * Отладочный цикл агента — это десятки запусков за сессию, а элементы одного
 * запуска ограничены сверху самим образцом (не больше пятидесяти строк).
 */
const runs = new LruCache<RecordedRun>(1_000)
const datasets = new LruCache<RecordedRun>(1_000)

export function recordRun(entry: RecordedRun): void {
  runs.set(String(entry.run.id), entry)
  datasets.set(entry.datasetId, entry)
}

export function runById(runId: string): RecordedRun | undefined {
  return runs.get(runId)
}

export function runByDatasetId(datasetId: string): RecordedRun | undefined {
  return datasets.get(datasetId)
}
