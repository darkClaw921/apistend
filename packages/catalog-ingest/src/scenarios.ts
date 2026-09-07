import type { MethodScenario } from '@apistend/shared'

/**
 * Сценарии ответа метода. В макете их четыре на карточке метода
 * («200 Сделка создана», «400 Некорректный STAGE_ID», «401 Демо-токен истёк», «429 Лимит»).
 * Строим их из кодов, реально объявленных в спецификации, — выдумывать нельзя.
 */

const ERROR_TITLES: Record<number, string> = {
  400: 'Некорректный запрос',
  401: 'Неверный или отозванный токен',
  402: 'Доступ к методу не оплачен',
  403: 'Недостаточно прав',
  404: 'Ресурс не найден',
  409: 'Конфликт состояния',
  422: 'Не прошла валидация',
  429: 'Превышен лимит боевого API',
  500: 'Ошибка сервиса',
  503: 'Сервис временно недоступен',
}

const SCENARIO_BY_STATUS: Record<number, string> = {
  401: 'invalid_token',
  403: 'invalid_token',
  404: 'not_found',
  429: 'rate_limit',
  500: 'server_error',
  503: 'rate_limit',
}

export function buildScenarios(successStatus: number, errorStatuses: readonly number[]): MethodScenario[] {
  const out: MethodScenario[] = [
    {
      scenario: 'success',
      statusCode: successStatus,
      title: successStatus === 201 ? 'Создано' : successStatus === 204 ? 'Выполнено, тела нет' : 'Успешный ответ',
      isDefault: true,
    },
  ]

  const used = new Set<string>(['success'])
  for (const status of errorStatuses) {
    const scenario = SCENARIO_BY_STATUS[status]
    // Коды без собственного сценария (402, 409, 422) в список не попадают:
    // мок умеет отдавать только то, что реально реализовано.
    if (!scenario || used.has(scenario)) continue
    used.add(scenario)
    out.push({
      scenario,
      statusCode: status,
      title: ERROR_TITLES[status] ?? `Ошибка ${status}`,
      isDefault: false,
    })
  }

  // Таймаут доступен всегда: это поведение транспорта, а не код ответа.
  out.push({ scenario: 'timeout', statusCode: 504, title: 'Таймаут 30 с', isDefault: false })
  return out
}
