---
title: Логи и сводка
description: Журнал запросов и его фильтры, карточка запроса, выгрузка в JSON и CSV, очистка, сводка использования, уведомления и консоль.
order: 690
group: API управления
---

Журнал — общий для мок-шлюза и консоли: в него попадает каждый вызов песочницы.
Хранится 30 дней, старше удаляет ретеншен.

## GET /logs

Область: `logs:read`. Свежие сверху, фильтры складываются по «и».

:::params Фильтры
| Параметр | Значение |
| --- | --- |
| `service` | `bitrix24`, `ozon`, `wildberries` |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` |
| `status` | точный код (`404`) или класс (`5xx`) |
| `apiKeyId` | вызовы одного ключа |
| `endpoint` | подстрока пути, без учёта регистра |
| `from`, `to` | границы периода в ISO 8601, смещение допускается |
:::

```bash
curl -s "$STEND/api/v1/logs?limit=2&status=5xx" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "items": [
    {
      "id": "cmtt83s560002f1m3aa66u2pz",
      "publicId": "req_3363c57194",
      "timestamp": "2026-09-08T22:10:30.330Z",
      "serviceCode": "bitrix24",
      "httpMethod": "POST",
      "endpoint": "/rest/crm.deal.list",
      "statusCode": 500,
      "durationMs": 182,
      "sizeBytes": 77,
      "scenario": "server_error",
      "responseSource": "error",
      "apiKeyId": "cmtt67ivy000353m3v16wfa44",
      "apiKeyName": "CI / автотесты"
    }
  ],
  "nextCursor": "cmtt83s560002f1m3aa66u2pz"
}
```

Неверный формат `status` объясняется отдельно:

```json
{
  "error": "VALIDATION",
  "message": "Некорректные данные запроса",
  "issues": ["query.status: Ожидается код ответа «404» или класс «5xx»"]
}
```

Тела запросов и ответов в списке не отдаются.

## GET /logs/{id}

Область: `logs:read`. Полная запись. Идентификатором служит и внутренний `id`
из списка, и публичный `publicId` (`req_…`) из заголовка `X-Request-Id`.

```bash
curl -s "$STEND/api/v1/logs/req_d21aff7bf1" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "id": "cmtty0oo8001g7am3to5x7fvq",
  "publicId": "req_d21aff7bf1",
  "serviceCode": "ozon",
  "httpMethod": "POST",
  "endpoint": "/v3/posting/fbs/list",
  "statusCode": 200,
  "durationMs": 181,
  "sizeBytes": 4218,
  "scenario": "success",
  "responseSource": "example",
  "apiKeyName": "Мобильное приложение",
  "sandboxId": "cmtt67ivj000153m3oir9dc6f",
  "upstreamUrl": "https://api-seller.ozon.ru/v3/posting/fbs/list",
  "clientIp": "127.0.0.1",
  "requestHeaders": {},
  "requestBody": "{\"limit\":2}",
  "responseHeaders": {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "req_31b01b94e5",
    "x-apistend-source": "example",
    "x-apistend-readiness": "ready",
    "x-apistend-scenario": "success",
    "x-apistend-upstream": "https://api-seller.ozon.ru",
    "x-apistend-snapshot": "2026-04-16"
  },
  "responseBody": "{\"result\":{\"postings\":[…]}}",
  "responseBodyReproduced": true
}
```

Тело успешного ответа в журнале не хранится: оно детерминировано
и восстанавливается тем же движком, который его сформировал, — байт в байт.
Такой ответ помечен `responseBodyReproduced: true`. Если метод к этому времени
выбыл из каталога, восстанавливать нечего и `responseBody` остаётся `null`.

Ключи в заголовках и телах маскируются: `stend_sk_1a2b••••7f9c`.

## GET /logs/export

Область: `logs:read`. Те же фильтры, что у списка, но без постраничности и без
тел: одна выгрузка за раз. Параметры `format` (`json` по умолчанию или `csv`)
и `limit` (по умолчанию 10 000).

:::tabs
== JSON

```bash
curl -s "$STEND/api/v1/logs/export?limit=2&from=2026-09-09T00:00:00Z" \
  -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "format": "json",
  "generatedAt": "2026-09-09T10:18:03.489Z",
  "count": 2,
  "truncated": true,
  "rows": [
    {
      "id": "cmttx38ns0001uom326tk930p",
      "publicId": "req_5532971963",
      "timestamp": "2026-09-09T09:49:55.480Z",
      "serviceCode": "bitrix24",
      "httpMethod": "GET",
      "endpoint": "/crm.deal.list",
      "statusCode": 404,
      "durationMs": 9,
      "sizeBytes": 74,
      "scenario": "success",
      "responseSource": "error",
      "apiKeyId": "cmtt67ivy000353m3v16wfa44",
      "apiKeyName": "CI / автотесты"
    }
  ]
}
```

== CSV

```bash
curl -s -D- -o logs.csv "$STEND/api/v1/logs/export?format=csv&limit=3" \
  -H "Authorization: Bearer $STEND_KEY"
```

```
HTTP/1.1 200 OK
content-type: text/csv; charset=utf-8
content-disposition: attachment; filename="apistend-logs-2026-09-09.csv"
```

```
Время;Сервис;Метод;Эндпоинт;Код;Задержка, мс;Размер, байт;Сценарий;Ключ;ID запроса
2026-09-08T02:10:48.257Z;ozon;POST;/v3/posting/fbs/list;200;218;66386;success;CI / автотесты;req_b50148ed000
```
:::

Разделитель — точка с запятой, в начале файла BOM: иначе Excel с русской
локалью раскладывает строку в одну колонку и портит кириллицу.

Больше `limit` записей не отдаётся. В JSON об этом говорит `truncated: true`,
в CSV — заголовок `X-Truncated: true`, потому что в самом файле сказать об этом
негде. Забрать остальное можно, сузив период полями `from` и `to`.

:::warning У выгрузки своё ограничение частоты
Шесть выгрузок в минуту на ключ — отдельное ведро, не связанное с общей нормой
в 240 запросов. Каждая выгрузка читает десятки тысяч записей в памяти того же
процесса, что обслуживает мок-шлюз.

```json
{
  "error": "RATE_LIMITED",
  "message": "Выгрузок журнала не больше 6 в минуту. Повторите через 10 с или сузьте период полями from и to"
}
```
:::

## POST /logs/clear

Область: `logs:write`. Удаляет записи безвозвратно, поэтому требует
`confirm: true`.

```bash
curl -s -X POST "$STEND/api/v1/logs/clear" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"confirm":true,"before":"2026-09-01T00:00:00Z","service":"ozon"}'
```

Ответ — `{ deleted, sandboxId, before, service }`. Без `before` удаляются все
записи песочницы; с `before` — только сделанные раньше указанного момента.
Записи удаляются пачками, поэтому на большом журнале ответ приходит
не мгновенно.

Без подтверждения:

```json
{
  "error": "VALIDATION",
  "message": "Некорректные данные запроса",
  "issues": ["body.confirm: Очистка журнала необратима: передайте confirm: true"]
}
```

## GET /usage

Область: `logs:read`. Счётчики по всем песочницам аккаунта сразу; `?sandboxId=`
сужает их до одной.

```bash
curl -s "$STEND/api/v1/usage" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "generatedAt": "2026-09-09T10:15:33.470Z",
  "sandboxIds": ["cmtt67ivj000153m3oir9dc6f"],
  "today": { "requests": 36, "errors": 2, "errorRatePercent": 5.56, "avgLatencyMs": 195 },
  "last30d": { "requests": 1410, "errors": 43, "errorRatePercent": 3.05, "avgLatencyMs": 225 },
  "byService": [
    { "serviceCode": "wildberries", "title": "Wildberries", "requests": 488, "errors": 17, "avgLatencyMs": 221 },
    { "serviceCode": "ozon", "title": "Ozon Seller API", "requests": 466, "errors": 9, "avgLatencyMs": 228 },
    { "serviceCode": "bitrix24", "title": "Bitrix24", "requests": 454, "errors": 17, "avgLatencyMs": 226 }
  ],
  "bySandbox": [
    { "sandboxId": "cmtt67ivj000153m3oir9dc6f", "name": "sandbox-01", "project": "Интеграция 1С", "requests": 1410 }
  ],
  "logSampling": { "sampleRate": 1, "sampledOut": 0, "dropped": 0, "complete": true },
  "retentionDays": 30
}
```

«Сегодня» — с начала суток по часовому поясу сервера. «30 дней» — скользящее
окно, совпадающее со сроком хранения журнала, поэтому цифры за окно не стареют
скачком. Песочница без вызовов остаётся в списке с нулём: её отсутствие
читалось бы как ошибка доступа.

Блок `logSampling` — про честность цифр: выше порога нагрузки журнал пишет
не все успешные вызовы, а долю (`sampleRate`), и тогда `requests` меньше
реального числа запросов. Ошибки не прореживаются никогда. Счётчики берутся
из процесса, обслуживающего запрос, считаются с его запуска и относятся ко всем
аккаунтам сразу — это показатель нагрузки на APIStend, а не ваш личный расход.

## GET /alerts и POST /alerts/{id}/read

Области: `logs:read` и `logs:write`. То, что показывает колокольчик в кабинете:
истекающие ключи, сбои доставки вебхуков, всплески ошибок. Фильтры `severity`
(`info` / `warning` / `danger`) и `unreadOnly=true`.

```json
{
  "items": [
    {
      "id": "cmtt67iwp000a53m3cpjak0c4",
      "sandboxId": "cmtt67ivj000153m3oir9dc6f",
      "severity": "info",
      "title": "Ozon: добавлены 4 новых метода",
      "meta": "Аналитика продаж и остатки на складах",
      "icon": "boxes",
      "link": "/catalog?service=ozon",
      "readAt": null,
      "createdAt": "2026-09-08T21:17:25.753Z"
    }
  ],
  "nextCursor": "cmtt67iwp000a53m3cpjak0c4"
}
```

`POST /alerts/{id}/read` проставляет `readAt` и отвечает
`{ id, readAt, alreadyRead }`. Повторный вызов время не меняет: «прочитано» —
это момент, когда уведомление разобрали в первый раз. Снять пометку нельзя.
Кабинет прочитанность пока не показывает — колокольчик там всегда полный.

## POST /console/execute

Область: `console:write`. Тот же серверный прокси, которым работает консоль
кабинета: APIStend вызывает мок сам и возвращает ответ целиком. Через браузер
так не сделать — боевые Ozon и Wildberries запросы из браузера не разрешают,
и мок повторяет это поведение.

```bash
curl -s -X POST "$STEND/api/v1/console/execute" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"serviceCode":"ozon","httpMethod":"POST","path":"/v3/posting/fbs/list","body":{"limit":1}}'
```

```json
{
  "requestId": "req_b2bc39e1b8",
  "status": 200,
  "durationMs": 180,
  "sizeBytes": 4218,
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "req_b2bc39e1b8",
    "x-apistend-source": "example",
    "x-apistend-readiness": "ready",
    "x-apistend-scenario": "success",
    "x-apistend-upstream": "https://api-seller.ozon.ru",
    "x-apistend-snapshot": "2026-04-16"
  },
  "body": { "result": { "postings": ["…"] } },
  "scenario": "success",
  "responseSource": "example",
  "readiness": "ready",
  "upstreamUrl": "https://api-seller.ozon.ru/v3/posting/fbs/list",
  "simulated": false,
  "note": null,
  "apiKey": { "id": "cmtt67iw2000453m37pr4p4vv", "name": "Мобильное приложение", "mask": "stend_sbx_c40d••••••7ae5" },
  "method": { "id": "ozon:POST:/v3/posting/fbs/list", "title": "Список отправлений", "group": "Обработка заказов FBS и rFBS" }
}
```

Произвольный адрес сюда передать нельзя, только сервис и путь: иначе маршрут стал
бы открытым прокси для чужих серверов.

:::note Вызов идёт от имени ключа песочницы
Не того серверного ключа, которым вы авторизовались: ключ песочницы попадает
в журнал и в лимит частоты сервиса. Без `apiKeyId` он подбирается по сервису.
Если ключ упёрся в лимит своего сервиса, сценарий подменяется на `rate_limit` —
так же, как это сделал бы боевой сервис.
:::

Поле `scenario` принимает `success`, `invalid_token`, `not_found`, `rate_limit`,
`server_error`, `timeout`. Сценарий `timeout` возвращается сразу и в журнал
не пишется: держать соединение тридцать секунд ради предсказуемого ответа
незачем. Остальные выполняются по-настоящему и видны в журнале — по
`X-Request-Id` из поля `requestId`.

:::next
- [Журнал запросов в кабинете](/docs/kabinet/zhurnal-zaprosov) — те же данные экраном
- [Рецепты](/docs/api-upravleniya/recepty) — выгрузить журнал за период
:::
