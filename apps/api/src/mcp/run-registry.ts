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
  /** Запуск в форме, объявленной в outputSchema инструмента call-actor. */
  readonly run: Record<string, unknown>
  /**
   * Тот же запуск в форме RunShort из OpenAPI Apify — так его отдаёт список
   * запусков, и только там есть фактическая стоимость `usageTotalUsd`.
   */
  readonly short: Record<string, unknown>
  readonly datasetId: string
  readonly items: readonly Record<string, unknown>[]
}

/**
 * Потолок — тысяча запусков.
 *
 * Отладочный цикл агента — это десятки запусков за сессию, а элементы одного
 * запуска ограничены сверху самим образцом (не больше пятидесяти строк).
 */
const MAX_RUNS = 1_000
const runs = new LruCache<RecordedRun>(MAX_RUNS)
const datasets = new LruCache<RecordedRun>(MAX_RUNS)

/**
 * Порядок запусков — для списка.
 *
 * LRU перестраивается при каждом ЧТЕНИИ, а список запусков должен идти в
 * порядке их начала: агент, читающий последний запуск, иначе получал бы тот,
 * который сам же перед этим и посмотрел.
 */
let ordered: RecordedRun[] = []

export function recordRun(entry: RecordedRun): void {
  const runId = String(entry.run.runId)
  runs.set(runId, entry)
  datasets.set(entry.datasetId, entry)
  // Повторный запуск с тем же входом даёт тот же идентификатор: в списке он
  // должен остаться одной строкой, а не размножиться по числу вызовов.
  ordered = ordered.filter((x) => String(x.run.runId) !== runId)
  ordered.push(entry)
  if (ordered.length > MAX_RUNS) ordered = ordered.slice(-MAX_RUNS)
}

/** Запуски песочницы в порядке их начала — от раннего к позднему. */
export function recordedRuns(): readonly RecordedRun[] {
  return ordered
}

export function runById(runId: string): RecordedRun | undefined {
  return runs.get(runId)
}

export function runByDatasetId(datasetId: string): RecordedRun | undefined {
  return datasets.get(datasetId)
}
