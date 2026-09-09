import type { ActorSnapshotEntry } from './apify-actors.ts'

/**
 * Фактическая стоимость прогона — `usageTotalUsd`.
 *
 * Зачем она в песочнице. Клиент, который списывает деньги за запуск актора,
 * берёт факт из списка запусков, а не оценку: оценка считается до прогона по
 * ожидаемому числу элементов, факт — после, по тому, что вышло на самом деле.
 * Пока мок не отдаёт факта, эта ветка биллинга не проверяется вообще — списание
 * идёт по оценке и на песочнице, и в бою, а расхождение вылезает на живых
 * деньгах.
 *
 * Откуда берутся числа:
 *   • тариф актора — из снимка магазина (`pricing`), то есть настоящий тариф
 *     настоящего актора: 0,0023 $ за элемент датасета у одного, помесячная
 *     аренда у другого;
 *   • тариф вычислений — 0,25 $ за compute unit, публично объявленная цена
 *     платформы Apify. Compute unit — это гигабайт-час: память запуска,
 *     умноженная на его длительность.
 *
 * Что здесь НЕ моделируется: PAY_PER_EVENT с ценой за конкретное событие.
 * Снимок магазина цен событий не содержит (в карточке актора они не отдаются),
 * и выдумать их значило бы посчитать чужой прайс по своим правилам. Такие
 * акторы считаются по вычислениям — как считался бы прогон бесплатного.
 */

/** Цена одного compute unit (гигабайт-часа) у платформы Apify, доллары. */
const COMPUTE_UNIT_USD = 0.25

/** Память запуска по умолчанию, если актор её не объявил. */
const DEFAULT_MEMORY_MBYTES = 1024

export interface RunCostInput {
  readonly actor: ActorSnapshotEntry
  readonly itemCount: number
  readonly runTimeSecs: number
}

export interface RunCost {
  readonly usageTotalUsd: number
  readonly computeUnits: number
  /** По какому тарифу посчитано: пригодится в разборе, откуда взялась сумма. */
  readonly model: string
}

export function runCost({ actor, itemCount, runTimeSecs }: RunCostInput): RunCost {
  const memoryMbytes =
    (actor.defaultRunOptions?.memoryMbytes as number | undefined) ?? DEFAULT_MEMORY_MBYTES
  const computeUnits = round((memoryMbytes / 1024) * (runTimeSecs / 3600), 6)

  const perItem = actor.pricing.find(
    (p) => p.model === 'PRICE_PER_DATASET_ITEM' && typeof p.pricePerUnitUsd === 'number',
  )
  if (perItem?.pricePerUnitUsd) {
    return {
      usageTotalUsd: round(itemCount * perItem.pricePerUnitUsd, 4),
      computeUnits,
      model: 'PRICE_PER_DATASET_ITEM',
    }
  }

  return {
    usageTotalUsd: round(computeUnits * COMPUTE_UNIT_USD, 4),
    computeUnits,
    model: actor.pricing[0]?.model ?? 'FREE',
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
