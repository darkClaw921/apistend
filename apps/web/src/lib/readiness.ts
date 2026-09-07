import type { Readiness } from '@apistend/shared'
import type { ChipTone } from '@apistend/ui'

/** Подписи готовности мока — колонка «Мок» на «Каталоге API». */
export const READINESS_LABEL: Record<Readiness, string> = {
  ready: 'Готов',
  updating: 'В работе',
  planned: 'Запланирован',
}

export const READINESS_TONE: Record<Readiness, ChipTone> = {
  ready: 'success',
  updating: 'warning',
  planned: 'neutral',
}

/** Откуда взят ответ. Показывается в панели деталей, чтобы неполнота была видна. */
export const SOURCE_LABEL: Record<string, string> = {
  example: 'пример из спецификации',
  schema: 'сгенерирован по схеме',
  generic: 'пустой конверт сервиса',
}
