---
title: Сценарии и серии
description: Сохранённые заготовки отправки событий, запуск серий, потолки инстанса, отслеживание прогресса и остановка.
order: 670
group: API управления
---

Серия (burst) — нагрузочная отправка событий на вебхук: `count` событий
со скоростью `ratePerSec`. Сценарий — сохранённая заготовка такой серии,
чтобы не собирать её параметры заново.

## GET /scenarios

Область: `scenarios:read`. Сценарии песочницы по алфавиту.

```bash
curl -s "$STEND/api/v1/scenarios?limit=1" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "items": [
    {
      "id": "cmtt67ixo000o53m3k6thyid7",
      "name": "Воронка сделки Bitrix24",
      "serviceCode": "bitrix24",
      "event": "ONCRMDEALUPDATE",
      "stepsCount": 500,
      "ratePerSec": 250,
      "errorRate": 0,
      "delayMs": 4,
      "repeats": 1,
      "status": "ready",
      "progress": 0,
      "runningBurstId": null,
      "actualRatePerSec": null,
      "lagging": false,
      "lastRunAt": "2026-09-09T05:12:00.000Z",
      "lastRunNote": "Последний запуск 08:12 · без ошибок"
    }
  ],
  "nextCursor": "cmtt67ixo000o53m3k6thyid7"
}
```

У идущего сценария `status` — `running`, а `progress` и `actualRatePerSec`
берутся из памяти процесса: опрос чаще раза в секунду показывает движение,
а не последнее записанное значение.

## POST /scenarios

Область: `scenarios:write`. Ответ — 201.

:::params Тело запроса
| Поле | Обязательное | Значение |
| --- | --- | --- |
| `name` | да | 1–80 символов |
| `serviceCode` | да | `bitrix24`, `ozon` или `wildberries` |
| `event` | да | событие этого сервиса |
| `stepsCount` | да | 1–1 000 000 |
| `ratePerSec` | да | 1–10 000 |
| `errorRate` | нет | 0–100, по умолчанию 0 |
:::

```bash
curl -s -X POST "$STEND/api/v1/scenarios" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Док: поток сделок","serviceCode":"bitrix24","event":"ONCRMDEALADD","stepsCount":100,"ratePerSec":20}'
```

```json
{
  "id": "cmttya4v5000gtqm3sqf1f98b",
  "name": "Док: поток сделок",
  "serviceCode": "bitrix24",
  "event": "ONCRMDEALADD",
  "stepsCount": 100,
  "ratePerSec": 20,
  "errorRate": 0,
  "delayMs": 50,
  "repeats": 1,
  "status": "ready",
  "progress": 0,
  "runningBurstId": null,
  "lastRunAt": null,
  "lastRunNote": null
}
```

`delayMs` считается из `ratePerSec` и отдельно не задаётся. Событие должно
принадлежать указанному сервису — иначе 400 `VALIDATION`:

```json
{
  "error": "VALIDATION",
  "message": "Событие «ONCRMDEALADD» принадлежит сервису bitrix24, а не ozon"
}
```

Сам по себе сценарий ничего не отправляет.

## PATCH и DELETE /scenarios/{id}

Область: `scenarios:write`.

`PATCH` меняет только переданные поля. Идущий сценарий изменить нельзя (409):
количество событий и скорость уже отданы в расписание, и правка расходилась бы
с прогрессом. Остановите серию через `POST /bursts/{id}/stop` и повторите.

`DELETE` необратим. Записи о прошлых запусках остаются в `/bursts`, но теряют
связь со сценарием — сколько их, сказано в `detachedRuns`:

```json
{
  "ok": true,
  "id": "cmttya4v5000gtqm3sqf1f98b",
  "name": "Док: поток сделок",
  "detachedRuns": 0,
  "stoppedBurstId": null
}
```

Идущий сценарий удаляется только с `?force=true`: иначе серия продолжила бы слать
события, а следить за ней было бы уже нечем. С `force=true` серия сначала
останавливается, её идентификатор придёт в `stoppedBurstId`.

## POST /scenarios/{id}/run

Область: `scenarios:write`. Ответ — 202: серия принята и идёт в фоне.

Вебхук подбирается по паре «сервис + событие» сценария, приоритет у активного.
Если подписки нет — 409:

```json
{
  "error": "NO_WEBHOOK_FOR_EVENT",
  "message": "Нет вебхука на событие «ONCRMDEALADD» сервиса bitrix24 — событиям некуда идти. Создайте подписку и повторите"
}
```

Сценарий не запускается поверх самого себя: две серии с одним `scenarioId`
писали бы прогресс друг поверх друга.

## POST /bursts

Область: `bursts:write`. Ответ — 202.

Получателя задают либо `webhookId`, либо `event` (тогда вебхук ищется
по событию, приоритет у активного) — ровно одно из двух. `count` и `ratePerSec`
обязательны, `errorRate` — доля доставок, которым сервер имитирует сбой отправки,
чтобы проверить ветку обработки ошибок в приложении.

```bash
curl -s -X POST "$STEND/api/v1/bursts" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"webhookId":"'"$WH"'","count":5,"ratePerSec":5,"errorRate":20}'
```

```json
{
  "id": "cmttyl1ds000ltqm3hqhza1ym",
  "scenarioId": null,
  "webhookId": "cmttyl1aj000ktqm33l0j7kxe",
  "serviceCode": "bitrix24",
  "event": "ONCRMDEALADD",
  "target": "public",
  "targetUrl": "http://127.0.0.1:8099/api/v1/meta",
  "count": 5,
  "ratePerSec": 5,
  "errorRate": 20,
  "requestedCount": 5,
  "requestedRatePerSec": 5,
  "capped": [],
  "estimatedSeconds": 1,
  "limits": { "maxCount": 100000, "maxRatePerSec": 500, "maxConcurrent": 3 }
}
```

Значения выше потолков инстанса обрезаются, а не отвергаются, и обрезка
перечисляется в `capped`:

```json
{
  "count": 100000,
  "ratePerSec": 500,
  "requestedCount": 500000,
  "requestedRatePerSec": 5000,
  "capped": ["количество ограничено до 100000", "скорость ограничена до 500 соб/с"],
  "estimatedSeconds": 200,
  "limits": { "maxCount": 100000, "maxRatePerSec": 500, "maxConcurrent": 3 }
}
```

Потолки задаются переменными `BURST_MAX_COUNT`, `BURST_MAX_RATE`
и `BURST_MAX_CONCURRENT`; значения в `limits` — те, что действуют на этом
инстансе.

:::params Отказы запуска серии
| Код | HTTP | Когда |
| --- | --- | --- |
| `NO_WEBHOOK` | 404 | вебхук не найден в этой песочнице |
| `WEBHOOK_PAUSED` | 409 | подписка на паузе или выключена |
| `NO_AGENT` | 409 | доставка на localhost, а `apistend listen` не подключён |
| `TOO_MANY_BURSTS` | 422 | уже идёт максимум серий для песочницы |
| `BAD_PARAMS` | 400 | количество и скорость должны быть положительными |
:::

```json
{
  "error": "NO_AGENT",
  "message": "Вебхук доставляет на localhost, а агент не подключён. Запустите apistend listen и повторите"
}
```

## GET /bursts и GET /bursts/{id}

Область: `bursts:read`. Идущие и завершённые серии одним списком, свежие сверху.
Фильтры: `state`, `webhookId`, `scenarioId`.

```json
{
  "items": [
    {
      "id": "cmtty1y1y003t7am3eeq4z7qo",
      "state": "done",
      "phase": null,
      "webhookId": "cmtt67ix8000f53m3tuq1bkmt",
      "scenarioId": null,
      "serviceCode": "bitrix24",
      "event": "ONCRMDEALUPDATE",
      "count": 50,
      "ratePerSec": 25,
      "errorRate": 30,
      "sent": 50,
      "succeeded": 35,
      "failed": 15,
      "actualRatePerSec": 24,
      "throttledTicks": null,
      "elapsedMs": 2124,
      "startedAt": "2026-09-09T10:16:54.694Z",
      "finishedAt": "2026-09-09T10:16:56.818Z",
      "note": "50 из 50 событий · 25 соб/с фактически"
    }
  ],
  "nextCursor": "cmtty1y1y003t7am3eeq4z7qo",
  "limits": { "maxCount": 100000, "maxRatePerSec": 500, "maxConcurrent": 3 }
}
```

- `phase` у идущей серии: `sending` — события ещё отправляются,
  `settling` — ждём последние ответы.
- `throttledTicks` — сколько тактов по 100 мс серию притормаживали из-за того,
  что приложение не успевало отвечать.
- `actualRatePerSec` у завершённой серии посчитана за всё время её жизни, включая
  ожидание последних ответов, поэтому она чуть ниже; точное значение на момент
  отправки записано в `note`.
- `interrupted` — серия, которую застал перезапуск сервера: расписание живёт
  в памяти и рестарт не переживает.

## POST /bursts/{id}/stop

Область: `bursts:write`. Останавливает отправку. Уже отправленные события
не отзываются — доставки останутся в журнале, а серия перейдёт в `stopped`
в течение секунды, дописав итог в `note`.

```json
{
  "id": "cmttyl5de000mtqm33ypv1hm2",
  "stopped": true,
  "sent": 450,
  "count": 100000,
  "scenarioId": null,
  "note": "Отправка прекращена на 450 событии из 100000. Уже отправленное отозвать нельзя"
}
```

Завершённая серия даёт 409: останавливать в ней нечего.

## Подводные камни

- Серия на локальный вебхук требует подключённого `apistend listen`. Состояние
  агента проверяется через [`GET /tunnel/status`](/docs/api-upravleniya/resursy-tunnel).
- Потолок одновременных серий отвечает 422, а не 429: код 429 в Management API
  занят ограничением частоты и приходит с `Retry-After`.
- Прогресс идущей серии живёт в памяти процесса. При перезапуске APIStend серия
  переходит в `interrupted`, и её нужно запускать заново.

:::next
- [Вебхуки и доставки](/docs/api-upravleniya/resursy-vebhuki) — куда именно уходят события серии
- [Логи и сводка](/docs/api-upravleniya/resursy-logi) — что осталось в журнале после прогона
:::
