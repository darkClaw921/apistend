import type { CatalogListItem, ServiceSummary } from './types'

/**
 * Сборка коллекции Postman из каталога методов.
 *
 * Делается целиком в браузере: каталог открыт и гостю, а серверный экспорт
 * пришлось бы закрывать сессией — как закрыт экспорт журнала запросов.
 * Данных для коллекции хватает тех, что уже загружены на экран.
 *
 * Ключ и идентификатор клиента вынесены в переменные коллекции: подставил свои
 * в Postman — и запросы уходят в песочницу без правки каждого метода.
 */

interface PostmanHeader {
  key: string
  value: string
  type: 'text'
}

interface PostmanItem {
  name: string
  request: {
    method: string
    header: PostmanHeader[]
    url: {
      raw: string
      protocol: string
      host: string[]
      port?: string
      path: string[]
      query?: Array<{ key: string; value: string }>
    }
    description?: string
  }
}

interface PostmanFolder {
  name: string
  item: PostmanItem[]
}

const KEY_VAR = '{{apistend_key}}'

/**
 * Заголовки авторизации — нативные для каждого сервиса, а не общий X-Mock-Key.
 *
 * В этом смысл продукта: интеграция подменяет базовый адрес и больше ничего,
 * поэтому и коллекция должна выглядеть так же, как коллекция к боевому API.
 * Bitrix24 выбивается — у него ключ идёт параметром auth=, а не заголовком.
 */
function authHeaders(service: string): PostmanHeader[] {
  if (service === 'ozon') {
    return [
      { key: 'Client-Id', value: '{{ozon_client_id}}', type: 'text' },
      { key: 'Api-Key', value: KEY_VAR, type: 'text' },
    ]
  }
  if (service === 'wildberries') {
    return [{ key: 'Authorization', value: KEY_VAR, type: 'text' }]
  }
  return []
}

function buildItem(m: CatalogListItem, baseUrl: string): PostmanItem {
  // mockBaseUrl уже заканчивается слэшем, path начинается с него.
  const base = baseUrl.replace(/\/$/, '')
  const raw = `${base}${m.path}`
  const url = new URL(raw)
  const query = m.serviceCode === 'bitrix24' ? [{ key: 'auth', value: KEY_VAR }] : undefined

  const header = authHeaders(m.serviceCode)
  if (m.httpMethod !== 'GET') header.push({ key: 'Content-Type', value: 'application/json', type: 'text' })

  return {
    name: `${m.httpMethod} ${m.path} — ${m.title}`,
    request: {
      method: m.httpMethod,
      header,
      url: {
        raw: query ? `${raw}?auth=${KEY_VAR}` : raw,
        // Postman хранит адрес разобранным: схема, домен по сегментам, путь.
        // Целиком origin в host этот формат не принимает.
        protocol: url.protocol.replace(':', ''),
        host: url.hostname.split('.'),
        ...(url.port ? { port: url.port } : {}),
        path: url.pathname.split('/').filter(Boolean),
        ...(query ? { query } : {}),
      },
      description: m.description || undefined,
    },
  }
}

export function buildPostmanCollection(
  methods: CatalogListItem[],
  services: ServiceSummary[],
  filterNote: string,
): unknown {
  const byService = new Map<string, ServiceSummary>(services.map((s) => [s.code, s]))
  const folders = new Map<string, PostmanFolder>()

  for (const m of methods) {
    const service = byService.get(m.serviceCode)
    // Без базового адреса запрос собрать не из чего — такой метод пропускаем,
    // молча выкидывать его в коллекцию с битым URL хуже.
    if (!service) continue

    let folder = folders.get(m.serviceCode)
    if (!folder) {
      folder = { name: service.title, item: [] }
      folders.set(m.serviceCode, folder)
    }
    folder.item.push(buildItem(m, service.mockBaseUrl))
  }

  return {
    info: {
      name: 'APIStend — демо-API',
      description:
        `Методы демо-API APIStend. ${filterNote}\n\n` +
        'Подставьте свой ключ песочницы в переменную apistend_key (Ключи и токены → создать ключ). ' +
        'Для Ozon дополнительно нужен ozon_client_id — подойдёт любое число, боевой шлюз его проверяет, ' +
        'а песочница принимает как есть.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'apistend_key', value: '', type: 'string' },
      { key: 'ozon_client_id', value: '123456', type: 'string' },
    ],
    item: [...folders.values()],
  }
}

/**
 * Отдаёт файл через Blob, а не через window.open с адресом сервера: каталог
 * открыт гостям, а серверная выгрузка потребовала бы сессии.
 */
export function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
