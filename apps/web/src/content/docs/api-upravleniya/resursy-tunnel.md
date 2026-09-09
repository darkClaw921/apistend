---
title: Туннель
description: Состояние агента apistend listen: подключён ли он, кто подключался последним и сколько доставок ждёт своей очереди.
order: 720
group: API управления
---

Локальные вебхуки доставляются через агента — команду `apistend listen`. Один
маршрут отвечает на вопрос, слушает ли кто-то события прямо сейчас.

## GET /tunnel/status

Область: `tunnel:read`. Только чтение — подключением управляет CLI.

```bash
curl -s "$STEND/api/v1/tunnel/status" -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "sandboxId": "cmtt67ivj000153m3oir9dc6f",
  "connected": true,
  "agent": {
    "sessionId": "tnl-ef80",
    "agentVersion": "apistend-cli 1.5.1",
    "deviceId": "8e2381b9af3c19aa",
    "forwardUrl": "http://localhost:3000/webhooks",
    "connectedAt": "2026-09-09T10:15:26.617Z",
    "lastSeenAt": "2026-09-09T10:15:29.664Z",
    "latencyMs": 0,
    "eventsLastHour": 3,
    "failedDeliveries": 0,
    "inflight": 0
  },
  "lastSession": {
    "sessionId": "tnl-ef80",
    "deviceName": "MacBook-Pro-Igor.local",
    "agentVersion": "apistend-cli 1.5.1",
    "forwardUrl": "http://localhost:3000/webhooks",
    "connectedAt": "2026-09-09T10:15:26.617Z",
    "lastSeenAt": "2026-09-09T10:15:26.617Z",
    "createdAt": "2026-09-09T10:15:26.590Z"
  },
  "queuedDeliveries": 0
}
```

:::params Поля ответа
| Поле | Что означает |
| --- | --- |
| `connected` | держится ли соединение прямо сейчас |
| `agent` | живая сессия; `null`, как только соединение оборвалось |
| `agent.inflight` | доставки, отданные агенту и ещё не подтверждённые |
| `lastSession` | последняя выданная сессия — остаётся и после отключения |
| `queuedDeliveries` | события на локальный адрес, ждущие агента |
:::

Пока агента нет, события не теряются, а копятся: `queuedDeliveries` — это и есть
их количество. Как только `apistend listen` подключится, очередь начнёт
разбираться.

## Как этим пользоваться

Проверка перед прогоном, в котором участвуют локальные вебхуки:

```bash
CONNECTED=$(curl -s "$STEND/api/v1/tunnel/status" -H "Authorization: Bearer $STEND_KEY" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).connected")

if [ "$CONNECTED" != "true" ]; then
  echo "apistend listen не подключён — локальные события пойдут в очередь"
  exit 1
fi
```

Без агента запуск серии событий на локальный вебхук отклоняется:

```json
{
  "error": "NO_AGENT",
  "message": "Вебхук доставляет на localhost, а агент не подключён. Запустите apistend listen и повторите"
}
```

## Подводные камни

- Состояние агента живёт в памяти процесса, который держит соединение. При
  нескольких инстансах APIStend ответ показывает состояние только того процесса,
  которому достался запрос.
- `lastSession` остаётся в базе и после отключения: по ней видно, кто и когда
  подключался последним, но она не означает, что соединение живо, — для этого
  есть `connected`.
- Сессии туннеля привязаны к ключу: удаление ключа удаляет их каскадом
  (`tunnelSessionsRemoved` в ответе `DELETE /keys/{id}`).

:::next
- [Вебхуки и доставки](/docs/api-upravleniya/resursy-vebhuki) — локальные подписки
- [Сценарии и серии](/docs/api-upravleniya/resursy-scenarii) — нагрузка на локальный обработчик
:::
