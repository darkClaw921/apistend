---
title: Вебхуки и доставки
description: Подписки на события, профиль доставки сервиса, тестовая отправка, журнал доставок и повторы неудачных.
order: 660
group: API управления
---

Вебхук — подписка «событие сервиса → ваш обработчик». Доставка бывает публичной
(APIStend делает запрос сам) и локальной (событие идёт через `apistend listen`
на вашу машину).

## GET /webhooks

Область: `webhooks:read`. Подписки в порядке создания — тот же порядок, что
на экране «Вебхуки и сценарии». Фильтры: `status`, `serviceCode`, `event`.

```bash
curl -s "$STEND/api/v1/webhooks?limit=1" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "items": [
    {
      "id": "cmtt67iwt000b53m3dp1i6r0i",
      "serviceCode": "ozon",
      "event": "TYPE_NEW_POSTING",
      "httpMethod": "POST",
      "target": "public",
      "targetUrl": "https://api.acme-erp.ru/hooks/ozon/orders",
      "targetPath": null,
      "status": "failing",
      "appId": null,
      "lastAttemptAt": "2026-09-09T10:16:42.751Z",
      "successRate24h": 98.2,
      "createdAt": "2026-09-08T21:17:25.757Z",
      "updatedAt": "2026-09-09T10:16:42.752Z"
    }
  ],
  "nextCursor": "cmtt67iwt000b53m3dp1i6r0i"
}
```

Секрет подписи в списке не отдаётся: он нужен поштучно и не должен попадать
в лог целой страницей. Подписки с заполненным `appId` заведены приложением
Bitrix24 через `event.bind`.

## POST /webhooks

Область: `webhooks:write`. Ответ — 201.

:::params Тело запроса
| Поле | Обязательное | Значение |
| --- | --- | --- |
| `serviceCode` | да | `bitrix24`, `ozon` или `wildberries` |
| `event` | да | код события; должен принадлежать этому сервису |
| `target` | да | `public` или `local` |
| `targetUrl` | для `public` | полный адрес `http://…` или `https://…` |
| `targetPath` | для `local` | путь со слэша; базовый адрес задаёт `apistend listen` |
| `httpMethod` | нет | `POST` (по умолчанию), `PUT`, `PATCH` |
| `status` | нет | `active` (по умолчанию) или `paused` |
| `secret` | нет | свой секрет подписи, 16–200 символов |
:::

```bash
curl -s -X POST "$STEND/api/v1/webhooks" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"serviceCode":"bitrix24","event":"ONCRMDEALADD","target":"local","targetPath":"/hooks/doc"}'
```

```json
{
  "id": "cmtty4s070009tqm3274mgg16",
  "serviceCode": "bitrix24",
  "event": "ONCRMDEALADD",
  "httpMethod": "POST",
  "target": "local",
  "targetUrl": null,
  "targetPath": "/hooks/doc",
  "status": "active",
  "appId": null,
  "successRate24h": 100,
  "secret": "stend_whsec_a7dd3df7e62059f1",
  "delivery": {
    "contentType": "application/x-www-form-urlencoded",
    "timeoutMs": 30000,
    "maxAttempts": 1,
    "retryDelaysMs": [],
    "successRule": "status_2xx",
    "signature": "application_token",
    "signatureHeader": null,
    "notes": "Событие несёт только идентификатор (data[FIELDS][ID]) — значения полей не передаются, клиент обязан дёрнуть crm.deal.get. Тело — form-urlencoded, не JSON. Повторов нет."
  }
}
```

Блок `delivery` — профиль доставки сервиса: сколько будет попыток, какой таймаут,
что считается успехом и чем подписывается тело. Он не настраивается: это правила
боевого сервиса, а не APIStend.

Событие проверяется по каталогу — чужое или несуществующее даёт 400
с отдельным кодом:

```json
{
  "error": "EVENT_SERVICE_MISMATCH",
  "message": "Событие «ONCRMDEALADD» принадлежит сервису bitrix24, а не ozon"
}
```

```json
{ "error": "UNKNOWN_EVENT", "message": "Событие «NOPE_EVENT» не поддерживается" }
```

:::warning Публичный адрес проверяется до создания
Запрос по нему делает сервер APIStend, поэтому внутренние адреса
(`localhost`, `10/8`, `192.168/16`, `169.254/16`, `::1` и имена, которые в них
разрешаются) отклоняются кодом `TARGET_NOT_ALLOWED`. Для своей машины есть
`target: "local"` и `apistend listen`.

Проверка выключается переменной `WEBHOOK_ALLOW_PRIVATE_TARGETS`, и в режиме
разработки она выключена по умолчанию — там приватный адрес принимается.
:::

## GET /webhooks/{id}

Область: `webhooks:read`. В отличие от списка отдаёт `secret` и `delivery`.
Секрет доступен и после создания: им проверяется подпись в обработчике.

## PATCH /webhooks/{id}

Область: `webhooks:write`. Меняются цель, событие, метод, состояние и секрет.
Сервис не меняется — событие и формат тела у другого сервиса другие, для этого
заводится новая подписка.

- `status` принимает только `active` и `paused`. Состояние `failing` выставляет
  диспетчер после серии неудач, и снимается оно переводом в `active` — сама
  по себе успешная доставка паузу не снимает, ровно как в бою.
- `secret` меняется присланным значением или флагом `rotateSecret: true`.
  Смена необратима: подписи, посчитанные старым секретом, перестанут сходиться.

Ответ перечисляет изменённые поля в `changed`.

## DELETE /webhooks/{id}

Область: `webhooks:write`. Вместе с подпиской каскадом уходят её доставки
из журнала и записи серий.

При непустом журнале запрос отклоняется, пока не передан `?withDeliveries=true`:

```json
{
  "error": "CONFLICT",
  "message": "Журнал вебхука не пуст, доставок в нём: 1. Они удалятся вместе с подпиской. Повторите запрос с ?withDeliveries=true, либо переведите вебхук в paused, если нужен только простой"
}
```

Это подтверждение, а не переключатель: доставки удаляются в любом случае.

```bash
curl -s -X DELETE "$STEND/api/v1/webhooks/$WH?withDeliveries=true" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "ok": true,
  "id": "cmtty4s070009tqm3274mgg16",
  "event": "ONCRMDEALADD",
  "deletedDeliveries": 1,
  "deletedBursts": 0,
  "interruptedBursts": 0
}
```

## POST /webhooks/{id}/test

Область: `webhooks:write`. Ответ — 202. То же, что кнопка «Тест» в кабинете:
одно событие с демонстрационным телом уходит получателю и попадает в журнал
доставок обычной записью.

```json
{
  "deliveryId": "evt_822ce903867d",
  "webhookId": "cmtty4s070009tqm3274mgg16",
  "state": "queued",
  "target": "local",
  "targetUrl": "/hooks/doc"
}
```

`state: "queued"` у локальной доставки означает, что отдавать некому — агент
`apistend listen` не подключён; событие уйдёт само, как только он появится.
Пауза отправке теста не мешает: проверять адрес нужно как раз на выключенной
подписке.

## GET /webhooks/{id}/deliveries

Область: `webhooks:read`. Журнал доставок подписки, свежие сверху. Фильтр
`state`: `queued`, `dispatched`, `succeeded`, `failed`, `no_response`, `dropped`.

```json
{
  "items": [
    {
      "id": "cmtt67ixi000i53m3i12pau9o",
      "webhookId": "cmtt67iwt000b53m3dp1i6r0i",
      "event": "TYPE_NEW_POSTING",
      "serviceCode": "ozon",
      "timestamp": "2026-09-09T07:42:18.000Z",
      "state": "succeeded",
      "attempt": 1,
      "maxAttempts": 10,
      "statusCode": 200,
      "durationMs": 186,
      "nextRetryAt": null,
      "targetDisplay": "/ozon/orders",
      "errorKind": null,
      "errorMessage": null,
      "burstId": null
    }
  ],
  "nextCursor": "cmtt67ixi000i53m3i12pau9o"
}
```

`queued` — ждёт отправки или повтора (время повтора в `nextRetryAt`),
`dispatched` — отправлено, ответа ещё нет, `no_response` — ответ так и не пришёл
в отведённое время.

## GET /deliveries/{id}

Область: `webhooks:read`. Всё, что ушло получателю, и что он ответил.

```json
{
  "id": "evt_822ce903867d",
  "event": "ONCRMDEALADD",
  "serviceCode": "bitrix24",
  "state": "queued",
  "attempt": 1,
  "maxAttempts": 1,
  "contentType": "application/x-www-form-urlencoded",
  "requestHeaders": {
    "user-agent": "APIStend-Webhooks/1.0",
    "content-type": "application/x-www-form-urlencoded",
    "x-apistend-delivery-id": "evt_822ce903867d"
  },
  "rawBody": "event=ONCRMDEALADD&event_handler_id=975&data%5BFIELDS%5D%5BID%5D=7468&ts=1788949146&auth%5Bdomain%5D=demo.bitrix24.ru&…",
  "responseBody": null,
  "retryPolicy": { "retriesAllowed": false, "retryDelaysMs": [], "timeoutMs": 30000 }
}
```

Тело — сырое, в нативном для сервиса формате: у Bitrix24 это form-urlencoded,
а не JSON. Истории попыток по одной записи нет — строка журнала переписывается
на каждой попытке, видны только её номер и время следующей.

Доставка ищется в текущей песочнице; для другой укажите `?sandboxId=`.

## POST /deliveries/{id}/retry

Область: `webhooks:write`. Возвращает доставку в очередь с первой попытки
и сразу пробует отдать её получателю. Исход прошлой попытки затирается — журнал
хранит только последнюю.

Повторяются только `failed`, `no_response` и `dropped`. Сервисам без повторов
(Bitrix24) отказывается кодом `UNPROCESSABLE`: боевой портал доставку
не повторяет, и мок не должен создавать другое впечатление — новое событие туда
отправляется через `POST /webhooks/{id}/test`.

## POST /webhooks/retry-failed

Область: `webhooks:write`. Возвращает в очередь доставки в состояниях `failed`
и `no_response`, свежие первыми. Тело — необязательные `webhookId` (сузить
до одной подписки) и `limit` (1–200, по умолчанию 50).

Ответ — `{ scanned, queued, skipped, skippedServices, hasMore, deliveryIds }`.
Отправляет их планировщик в течение пары секунд, поэтому ответ говорит
о поставленном в очередь, а не о доставленном. Доставки сервисов без повторов
пропускаются, их коды перечислены в `skippedServices`.

## Подводные камни

- Профили доставки у сервисов разные, и это видно в `delivery`: у Bitrix24 одна
  попытка и таймаут 30 с, у Ozon одиннадцать попыток с растущими паузами
  и успех только при теле `{"result": true}`, у Wildberries — подпись
  HMAC-SHA256. Справочник целиком отдаёт
  [`GET /events`](/docs/api-upravleniya/resursy-katalog).
- Спецификация OpenAPI не объявляет 409 у `DELETE /webhooks/{id}`, хотя маршрут
  им отвечает при непустом журнале.

:::next
- [Сценарии и серии](/docs/api-upravleniya/resursy-scenarii) — нагрузочная отправка событий
- [Туннель](/docs/api-upravleniya/resursy-tunnel) — состояние `apistend listen`
:::
