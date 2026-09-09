---
title: Свои моки
description: Эндпоинты /custom/*, плейсхолдеры в теле ответа, проверка шаблона без сохранения и импорт из OpenAPI.
order: 680
group: API управления
---

Свой мок — собственный эндпоинт в ветке `/custom/…`, которого нет ни у одного
из сервисов стенда. Он живёт в песочнице и отвечает всем, у кого есть её ключ.

## GET /mocks

Область: `mocks:read`. Моки песочницы, недавно изменённые сверху. Фильтры:
`status` (`active` / `draft` / `disabled`), `httpMethod`, `q` (поиск).

```bash
curl -s "$STEND/api/v1/mocks?limit=1" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "items": [
    {
      "id": "cmtty0fr4001a7am3kkjo785z",
      "sandboxId": "cmtt67ivj000153m3oir9dc6f",
      "httpMethod": "GET",
      "path": "/custom/erp3/orders",
      "url": "http://localhost:8080/custom/erp3/orders",
      "title": "Список заказов.",
      "status": "draft",
      "responseStatusCode": 200,
      "contentType": "application/json",
      "delayMs": 250,
      "templatingEnabled": true,
      "rulesCount": 0,
      "responseBodyLength": 31,
      "callsCount": 0,
      "createdAt": "2026-09-09T10:15:44.320Z",
      "updatedAt": "2026-09-09T10:15:44.320Z"
    }
  ],
  "nextCursor": "cmtty0fr4001a7am3kkjo785z"
}
```

Тело ответа, заголовки и правила в список не попадают — за ними в
`GET /mocks/{id}`.

## POST /mocks

Область: `mocks:write`. Ответ — 201.

:::params Тело запроса
| Поле | Обязательное | Значение |
| --- | --- | --- |
| `httpMethod` | да | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | да | начинается с `/custom/`, 9–300 символов |
| `title` | да | 2–120 символов |
| `status` | нет | `draft` (по умолчанию), `active`, `disabled` |
| `responseStatusCode` | нет | 200–599, по умолчанию 200 |
| `contentType` | нет | по умолчанию `application/json` |
| `delayMs` | нет | 0–3000, по умолчанию 250 |
| `templatingEnabled` | нет | по умолчанию `true` |
| `responseBody` | нет | до 200 000 символов |
| `headers` | нет | объект «строка → строка» |
| `rules` | нет | массив правил |
:::

```bash
curl -s -X POST "$STEND/api/v1/mocks" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"httpMethod":"GET","path":"/custom/doc/ping","title":"Пинг","responseBody":"{\"ok\":true,\"id\":\"{{uuid}}\"}"}'
```

```json
{
  "id": "cmtty4es00008tqm3d2hk1p7k",
  "sandboxId": "cmtty4eoh0006tqm356k1tp23",
  "httpMethod": "GET",
  "path": "/custom/doc/ping",
  "url": "http://localhost:8080/custom/doc/ping",
  "title": "Пинг",
  "status": "draft",
  "responseStatusCode": 200,
  "contentType": "application/json",
  "delayMs": 250,
  "templatingEnabled": true,
  "rulesCount": 0,
  "responseBodyLength": 27,
  "callsCount": 0,
  "responseBody": "{\"ok\":true,\"id\":\"{{uuid}}\"}",
  "headers": {},
  "rules": []
}
```

По умолчанию мок создаётся черновиком и публично не отвечает — включите его
через `POST /mocks/{id}/enable`. Пара «метод + путь» уникальна в песочнице:
повтор даёт 409.

Ошибка в пути объясняется по полям:

```json
{
  "error": "VALIDATION",
  "message": "Некорректные данные запроса",
  "issues": [
    "body.path: Слишком маленькое значение: ожидалось, что string будет иметь >=9 символов",
    "body.path: Путь мока начинается с /custom/ — по этому адресу его вызывает песочница",
    "body.title: Название не короче 2 символов"
  ]
}
```

:::warning headers и rules сохраняются, но не применяются
Поля `headers` и `rules` записываются как есть, однако движок `/custom/*` их пока
не использует: он отдаёт тело, код ответа и `contentType`.
:::

## GET, PATCH и DELETE /mocks/{id}

`GET` (область `mocks:read`) отдаёт шаблон тела как есть, без подстановки
плейсхолдеров.

`PATCH` (`mocks:write`) меняет только присланные поля. Смена метода или пути
переносит мок на другой адрес: старый перестаёт отвечать сразу, а занятый новый
даёт 409. Счётчик вызовов при переносе не сбрасывается.

`DELETE` (`mocks:write`) необратим: шаблон ответа и счётчик вызовов пропадают
вместе с моком. Записи журнала запросов остаются — они принадлежат песочнице,
а не моку.

```json
{
  "ok": true,
  "id": "cmttya4zy000htqm3ly1uo6y9",
  "httpMethod": "GET",
  "path": "/custom/doc-import/orders",
  "title": "Заказы",
  "callsCount": 0
}
```

## POST /mocks/{id}/enable и /disable

Область: `mocks:write`. Переводят мок в `active` и `disabled` соответственно.
Выключенный мок сохраняет тело и счётчик вызовов, но адрес перестаёт отвечать;
черновик и выключенный мок отвечают на шлюзе 409 `MOCK_NOT_ACTIVE`.

Повторный вызов ничего не меняет и не считается ошибкой — в ответе рядом
с обычными полями приходят `previousStatus` и `changed`.

## POST /mocks/preview

Область: `mocks:read`. Подставляет плейсхолдеры в присланный текст и ничего
не сохраняет — ни мока, ни записи в журнале. Песочница здесь не нужна.

```bash
curl -s -X POST "$STEND/api/v1/mocks/preview" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"template":"{\"id\":\"{{uuid}}\",\"n\":{{randomInt 1 9}},\"who\":\"{{faker.company}}\",\"echo\":\"{{request.body.name}}\",\"oops\":\"{{nosuch}}\"}","sampleBody":{"name":"ACME"},"seed":"doc"}'
```

```json
{
  "rendered": "{\"id\":\"8ee3170b-051c-4172-8bf3-0f0a9485229a\",\"n\":7,\"who\":\"ООО «Северный кофе»\",\"echo\":\"ACME\",\"oops\":\"{{nosuch}}\"}",
  "validJson": true,
  "unresolved": ["{{nosuch}}"],
  "placeholders": [
    { "code": "{{uuid}}", "description": "уникальный идентификатор" },
    { "code": "{{now}}", "description": "текущие дата и время" },
    { "code": "{{now +3d}}", "description": "сдвиг даты вперёд" },
    { "code": "{{randomInt a b}}", "description": "случайное число" },
    { "code": "{{faker.company}}", "description": "название компании" },
    { "code": "{{faker.city}}", "description": "город" },
    { "code": "{{request.body.*}}", "description": "поле из тела запроса" },
    { "code": "{{params.id}}", "description": "параметр из пути /custom/orders/{id}" }
  ]
}
```

- `validJson` говорит, останется ли результат разбираемым JSON;
- `unresolved` показывает подстановки, оставшиеся в тексте нетронутыми — обычно
  это опечатка в имени;
- `placeholders` — весь набор, который понимает движок.

Результат детерминированный: один и тот же шаблон и `seed` дают один и тот же
текст, поэтому его можно сравнивать в тестах. Подставить образцы данных помогают
`sampleBody`, `sampleQuery`, `sampleParams` и `path`.

## POST /mocks/import

Область: `mocks:write`. Ответ — 201. Создаёт по моку на каждую операцию
спецификации OpenAPI 3.x (JSON или YAML) в поле `document`.

:::params Тело запроса
| Поле | Обязательное | Значение |
| --- | --- | --- |
| `document` | да | текст спецификации, до 5 000 000 символов |
| `pathPrefix` | нет | начинается с `/custom`, по умолчанию `/custom/imported` |
| `status` | нет | `draft` (по умолчанию), `active`, `disabled` |
| `limit` | нет | 1–200, по умолчанию 100 |
:::

```json
{
  "createdCount": 1,
  "skippedCount": 0,
  "leftOver": 0,
  "limit": 100,
  "created": [
    {
      "id": "cmttya4zy000htqm3ly1uo6y9",
      "httpMethod": "GET",
      "path": "/custom/doc-import/orders",
      "title": "Заказы"
    }
  ],
  "skipped": []
}
```

Тело ответа берётся из примера в спецификации; операции без примера получают
`{}` — придуманный по схеме ответ хуже пустого, потому что выглядит настоящим.
Повторный импорт того же файла безопасен: существующие пары «метод + путь»
попадают в `skipped` с причиной `duplicate`. Операции сверх `limit`
не создаются и считаются в `leftOver`.

:::next
- [Свои моки в кабинете](/docs/kabinet/svoi-moki) — тот же механизм мышкой
- [Импорт OpenAPI](/docs/kabinet/import-openapi) — что именно читает импорт
:::
