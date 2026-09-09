/**
 * Клиент к API кабинета.
 *
 * credentials: 'include' обязателен: сессия живёт в httpOnly-cookie, и без него
 * запрос уйдёт без неё. Веб и API на разных портах, но домен один (localhost),
 * поэтому SameSite=Lax cookie отдаёт.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'

/**
 * Тот же API, но для запросов с сервера (отрисовка лендинга).
 *
 * Обычно совпадает с API_URL. Расходятся они там, где браузер и Next видят
 * сервис по разным адресам, — например в docker compose: снаружи это
 * опубликованный localhost:8080, а изнутри контейнера «localhost» указывал бы
 * на сам Next, и лендинг рисовался бы без единого числа из каталога.
 */
export const SERVER_API_URL = process.env.APISTEND_INTERNAL_API_URL ?? API_URL

/**
 * Выбранная песочница.
 *
 * Живёт здесь, а не прокидывается в каждый вызов, по числу этих вызовов: экранов
 * одиннадцать, запросов в них — десятки, и забытый в одном месте `?sandboxId=`
 * означал бы, что этот экран молча показывает данные ЧУЖОЙ песочницы. Параметр
 * добавляется один раз, в общем месте, и добавляется всем.
 *
 * Эндпоинтам, которым песочница не нужна (вход, каталог, сводка сервисов),
 * лишний параметр не мешает: они его не читают.
 */
let activeSandboxId = ''

export function setActiveSandbox(id: string): void {
  activeSandboxId = id
}

/** Дописывает выбранную песочницу, не трогая уже указанную явно. */
function withSandbox(path: string): string {
  if (!activeSandboxId) return path
  if (path.includes('sandboxId=')) return path
  return `${path}${path.includes('?') ? '&' : '?'}sandboxId=${encodeURIComponent(activeSandboxId)}`
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: string[]

  constructor(status: number, code: string, message: string, issues: string[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.issues = issues
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${withSandbox(path)}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Не удалось выполнить запрос. Повторить?')
  }

  const text = await response.text()
  const data: unknown = text ? safeParse(text) : null

  if (!response.ok) {
    const body = (data ?? {}) as { error?: string; message?: string; issues?: string[] }
    throw new ApiError(
      response.status,
      body.error ?? 'ERROR',
      body.message ?? body.issues?.[0] ?? errorTextFor(response.status),
      body.issues ?? [],
    )
  }
  return data as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Тексты ошибок — дословно из design-handoff/04-content-ru.md. */
function errorTextFor(status: number): string {
  switch (status) {
    case 401: return 'Неверный или отозванный ключ'
    case 404: return 'Метод не найден в этой песочнице'
    case 429: return 'Превышен лимит боевого API (эмуляция)'
    case 500: return 'Ошибка сервиса — так отвечает боевой API в этом сценарии'
    default: return 'Не удалось выполнить запрос. Повторить?'
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
