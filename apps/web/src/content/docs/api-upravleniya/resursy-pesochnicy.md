---
title: Песочницы
description: Создание второй и последующих песочниц, настройки задержки и доли ошибок, сброс демо-данных и удаление с подтверждением.
order: 640
group: API управления
---

Задержку и долю ошибок правит и кабинет — ползунками на экране «Ключи и токены»,
которые сохраняются этим же маршрутом. Вторую песочницу кабинет тоже заводит:
меню аккаунта в сайдбаре, пункт «Новая песочница». А вот сменить объём данных
или удалить песочницу можно только отсюда.

## GET /sandboxes

Область: `sandboxes:read`. Все песочницы аккаунта в порядке создания.

```bash
curl -s "$STEND/api/v1/sandboxes?limit=2" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "items": [
    {
      "id": "cmtt67ivj000153m3oir9dc6f",
      "name": "sandbox-01",
      "project": "Интеграция 1С",
      "status": "ok",
      "dataVolume": "medium",
      "latencyMs": 250,
      "errorRate": 5,
      "isDefault": true,
      "counts": { "keys": 8, "webhooks": 7, "mocks": 10 },
      "lastResetAt": "2026-09-08T22:46:28.168Z",
      "createdAt": "2026-09-08T21:17:25.711Z",
      "updatedAt": "2026-09-08T22:46:28.168Z"
    }
  ],
  "nextCursor": null
}
```

`isDefault` помечает песочницу, которую возьмут запросы без `sandboxId`.
Счётчики считаются на лету; отозванные ключи в `counts.keys` не попадают —
так же считает и кабинет.

## POST /sandboxes

Область: `sandboxes:write`. Ответ — 201.

:::params Тело запроса
| Поле | Обязательное | Значение |
| --- | --- | --- |
| `name` | да | 2–40 символов, уникально в пределах аккаунта |
| `project` | нет | 1–80 символов, по умолчанию `Без названия` |
| `dataVolume` | нет | `min` / `medium` / `full`, по умолчанию `medium` |
| `latencyMs` | нет | 0–3000, по умолчанию 250 |
| `errorRate` | нет | 0–50 (проценты), по умолчанию 5 |
:::

```bash
curl -s -X POST "$STEND/api/v1/sandboxes" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"ci-doc","project":"Документация","dataVolume":"min","latencyMs":0,"errorRate":0}'
```

```json
{
  "id": "cmtty4eoh0006tqm356k1tp23",
  "name": "ci-doc",
  "project": "Документация",
  "status": "ok",
  "dataVolume": "min",
  "latencyMs": 0,
  "errorRate": 0,
  "isDefault": false,
  "counts": { "keys": 0, "webhooks": 0, "mocks": 0 },
  "lastResetAt": "2026-09-09T10:18:49.553Z",
  "createdAt": "2026-09-09T10:18:49.553Z",
  "updatedAt": "2026-09-09T10:18:49.553Z"
}
```

Новая песочница пустая: ключи, вебхуки и моки в неё не переносятся, ключ для неё
выпускается отдельно — `POST /api/v1/keys?sandboxId=…`. Занятое имя даёт 409:

```json
{
  "error": "CONFLICT",
  "message": "Песочница с именем «sandbox-01» у аккаунта уже есть. Выберите другое имя"
}
```

## Что означают настройки

- `dataVolume` — соль генератора демо-данных. После её смены движок отдаёт другой
  набор записей, и идентификаторы из прошлых ответов перестают совпадать.
- `latencyMs` — потолок задержки шлюза. Фактическая задержка равна минимуму
  из настройки песочницы и задержки самого метода, а заголовок `X-Mock-Delay`
  перебивает обе.
- `errorRate` — доля запросов, которым шлюз ответит ошибкой вместо успешного
  сценария.
- `status` — пометка для человека: шлюз его не смотрит, запросы к песочнице
  со статусом `paused` продолжают работать.

## GET и PATCH /sandboxes/{sandboxId}

Области: `sandboxes:read` и `sandboxes:write`. `PATCH` меняет только переданные
поля; принимает те же `name`, `project`, `dataVolume`, `latencyMs`, `errorRate`
плюс `status` (`ok` или `paused`).

```bash
curl -s -X PATCH "$STEND/api/v1/sandboxes/$SB" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"latencyMs":0,"errorRate":0}'
```

Новые значения задержки и доли ошибок начинают действовать сразу, дожидаться
истечения кеша ключей не нужно.

## POST /sandboxes/{sandboxId}/reset

Область: `sandboxes:write`. Возвращает демо-данные к исходному виду: удаляет
личные изменения (созданные, изменённые и удалённые пользователем записи)
и переставляет `lastResetAt`.

```bash
curl -s -X POST "$STEND/api/v1/sandboxes/$SB/reset" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "sandboxId": "cmtty4eoh0006tqm356k1tp23",
  "removed": 0,
  "lastResetAt": "2026-09-09T10:18:49.795Z"
}
```

Базовый набор демо-данных общий для всех аккаунтов и только на чтение —
сбрасывать в нём нечего. Ключи, вебхуки, сценарии, свои моки и журнал запросов
сброс не трогает: их удаляет только удаление песочницы.

## DELETE /sandboxes/{sandboxId}

Область: `sandboxes:write`. Подтверждение — имя песочницы в `confirmName`.

:::danger Необратимо и с продолжением
Вместе с песочницей удаляются её ключи, вебхуки с журналом доставок, сценарии,
серии событий, свои моки, журнал запросов, локальные приложения Bitrix24
и личные изменения демо-данных. Ключи этой песочницы перестают работать сразу —
и в Management API, и на мок-шлюзе.
:::

```bash
curl -s -X DELETE "$STEND/api/v1/sandboxes/$SB" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"confirmName":"ci-doc"}'
```

```json
{
  "ok": true,
  "id": "cmtty4eoh0006tqm356k1tp23",
  "name": "ci-doc",
  "removed": {
    "keys": 1, "webhooks": 0, "mocks": 1, "scenarios": 0,
    "bursts": 0, "requestLogs": 0, "b24Apps": 0, "overlay": 0
  }
}
```

Неверное подтверждение — 400:

```json
{
  "error": "CONFIRM_MISMATCH",
  "message": "Удаление необратимо. Повторите имя песочницы в поле confirmName — ожидается «ci-doc»"
}
```

Последнюю песочницу аккаунта удалить нельзя — 422:

```json
{
  "error": "UNPROCESSABLE",
  "message": "Это последняя песочница аккаунта, удалить её нельзя: ключи, вебхуки и моки существуют только внутри песочницы. Создайте новую через POST /api/v1/sandboxes, перенесите работу в неё и удалите эту. Личные данные текущей песочницы чистит POST /api/v1/sandboxes/:sandboxId/reset"
}
```

## Подводные камни

- Удаление песочницы, в которой выпущен ваш собственный ключ, обрывает доступ:
  ключ перестаёт работать вместе с ней. Держите ключ CI в той песочнице,
  которую не пересоздаёте, — или выпускайте новый ключ сразу после создания
  новой песочницы.
- Спецификация OpenAPI не объявляет 422 у `DELETE /sandboxes/{sandboxId}`,
  хотя маршрут им отвечает. Сгенерированный клиент может отдать этот ответ
  как необработанную ошибку транспорта.

:::next
- [Ключи](/docs/api-upravleniya/resursy-klyuchi) — выпустить ключ в новой песочнице
- [Рецепты](/docs/api-upravleniya/recepty) — снести и пересоздать песочницу перед прогоном тестов
:::
