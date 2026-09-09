---
title: Каталог
description: Сервисы, методы и их происхождение, справочник событий вебхуков — данные, по которым видно, что именно умеет стенд.
order: 700
group: API управления
---

Каталог — единственная часть Management API, не привязанная к песочнице: это
общие данные о том, что стенд умеет подменять. Область для всех трёх маршрутов —
`catalog:read`.

## GET /services

Сервисы, которые APIStend умеет подменять.

```bash
curl -s "$STEND/api/v1/services" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "services": [
    {
      "code": "bitrix24",
      "title": "Bitrix24",
      "apiVersion": "REST API v1",
      "replacesUrl": "<portal>.bitrix24.ru/rest/",
      "mockBaseUrl": "http://localhost:8080/b24/",
      "methodsCount": 1685,
      "status": "ok",
      "snapshotDate": "2026-09-07",
      "routing": "path-only",
      "rateLimit": {
        "limit": 2,
        "windowMs": 1000,
        "burst": 50,
        "statusCode": 503,
        "retryAfterSeconds": null,
        "description": "Около 2 запросов в секунду, бакет 50. При превышении — 503 QUERY_LIMIT_EXCEEDED"
      },
      "nativeAuth": {
        "kind": "path",
        "headers": null,
        "description": "Ключ в пути входящего вебхука /rest/{user_id}/{code}/{method}.json либо параметр auth="
      }
    }
  ],
  "totalMethods": 2421
}
```

`methodsCount`, `snapshotDate` и `totalMethods` берутся из самого каталога,
а не из настроек, и меняются с каждой волной пополнения. Сервис со статусом
`planned` заведён, но методов у него пока нет. `mockBaseUrl` — префикс, который
подставляется вместо боевого адреса из `replacesUrl`.

## GET /methods

Поиск по каталогу. Фильтры складываются по «и».

:::params Параметры
| Параметр | Значение |
| --- | --- |
| `service` | `bitrix24`, `ozon`, `wildberries` |
| `group` | группа метода |
| `readiness` | `ready`, `updating`, `planned` |
| `q` | поиск по пути, названию и описанию, регистр не важен |
| `limit`, `cursor` | постраничность |
:::

```bash
curl -s "$STEND/api/v1/methods?service=ozon&limit=1" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "items": [
    {
      "id": "ozon:GET:/v1/actions",
      "serviceCode": "ozon",
      "httpMethod": "GET",
      "path": "/v1/actions",
      "title": "Список акций",
      "description": "Метод для получения списка акций Ozon, в которых можно участвовать.",
      "group": "Акции Ozon",
      "tag": "Акции Ozon",
      "version": "v1",
      "readiness": "ready",
      "deprecated": false,
      "origin": {
        "responseSource": "example",
        "extraction": "mirror",
        "sourceUrl": "https://docs.ozon.ru/api/seller/#operation/Promos",
        "snapshotDate": "2026-04-16",
        "license": null
      }
    }
  ],
  "nextCursor": "ozon:GET:/v1/actions",
  "total": 420
}
```

Порядок методов задан снимком спецификации и между запросами не меняется,
поэтому курсор указывает на конкретную запись — но он действителен только при
том же наборе фильтров.

## GET /methods/{id}

Идентификатор — «сервис:ГЛАГОЛ:/путь». Кодировать его нужно целиком
(`encodeURIComponent`): двоеточия и слэши внутри пути иначе разъедутся
по сегментам адреса.

```bash
ID=$(node -pe 'encodeURIComponent("bitrix24:POST:/rest/crm.deal.list")')
curl -s "$STEND/api/v1/methods/$ID" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "id": "bitrix24:POST:/rest/crm.deal.list",
  "serviceCode": "bitrix24",
  "httpMethod": "POST",
  "path": "/rest/crm.deal.list",
  "title": "Получить список сделок",
  "group": "CRM",
  "readiness": "ready",
  "deprecated": true,
  "origin": {
    "responseSource": "example",
    "extraction": "parsed",
    "sourceUrl": "https://apidocs.bitrix24.ru/api-reference/crm/deals/crm-deal-list.html",
    "snapshotDate": "2026-09-07",
    "license": "MIT"
  },
  "upstreamHost": "https://portal.bitrix24.ru",
  "successStatus": 200,
  "latencyMs": 180,
  "scenarios": [
    { "scenario": "success", "statusCode": 200, "title": "Успешный ответ", "isDefault": true },
    { "scenario": "invalid_token", "statusCode": 401, "title": "Неверный или отозванный токен", "isDefault": false },
    { "scenario": "rate_limit", "statusCode": 503, "title": "Сервис временно недоступен", "isDefault": false },
    { "scenario": "timeout", "statusCode": 504, "title": "Таймаут 30 с", "isDefault": false }
  ],
  "mockUrl": "http://localhost:8080/b24/rest/crm.deal.list",
  "unifiedUrl": "http://localhost:8080/v1/bitrix24/rest/crm.deal.list",
  "rateLimit": {
    "limit": 2, "windowMs": 1000, "burst": 50, "statusCode": 503,
    "retryAfterSeconds": null,
    "description": "Около 2 запросов в секунду, бакет 50. При превышении — 503 QUERY_LIMIT_EXCEEDED"
  },
  "nativeAuth": {
    "kind": "path", "headers": null,
    "description": "Ключ в пути входящего вебхука /rest/{user_id}/{code}/{method}.json либо параметр auth="
  }
}
```

Кроме показанного ответ несёт `params` (имя, где передаётся, тип,
обязательность, описание), `responseExample`, `responseSchemaRef`
и `requestSchemaRef`.

Блок `origin` — то же происхождение, что и в заголовках ответа мока: по нему
видно, снят ли ответ с примера из спецификации или собран по схеме. Несуществующий
идентификатор даёт 404:

```json
{
  "error": "NOT_FOUND",
  "message": "Метод «bitrix24:POST:/crm.deal.list» не найден в каталоге"
}
```

## GET /events

Справочник для подписок: коды событий, правила доставки сервиса и пример тела.

```bash
curl -s "$STEND/api/v1/events" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "services": [
    {
      "code": "bitrix24",
      "title": "Bitrix24",
      "webhook": {
        "contentType": "application/x-www-form-urlencoded",
        "timeoutMs": 30000,
        "retries": 0,
        "retryDelaysMs": [],
        "successRule": "status_2xx",
        "expectedResponseBody": null,
        "signature": "application_token",
        "signatureHeader": null,
        "maxBatchSize": 1,
        "suspendsAfterFailures": false,
        "notes": "…"
      },
      "events": [
        {
          "code": "ONCRMDEALADD",
          "title": "Создана сделка",
          "aliasInMockup": null,
          "sampleContentType": "application/x-www-form-urlencoded",
          "sampleBody": "event=ONCRMDEALADD&event_handler_id=975&data%5BFIELDS%5D%5BID%5D=7401&ts=1788949382&auth%5Bdomain%5D=localhost%3A8080&…"
        }
      ]
    }
  ]
}
```

Пример показан целиком, вместе с конвертом сервиса: у Bitrix24 это
form-urlencoded с PHP-скобками, у Wildberries — JSON со списком `events[]`.
Обработчик, написанный под «просто полезные поля», в бою не заработает.
Значения в примере демонстрационные: токен и `requestId` в настоящей доставке
будут другими.

:::next
- [Вебхуки и доставки](/docs/api-upravleniya/resursy-vebhuki) — подписка на событие из этого справочника
- [Заголовки честности](/docs/mok-api/zagolovki-chestnosti) — то же происхождение в ответах шлюза
:::
