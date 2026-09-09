---
title: Рецепты
description: Окружение под CI одним скриптом, ключ подрядчику с ограниченными правами, пересоздание песочницы перед прогоном и выгрузка журнала за период.
order: 740
group: API управления
---

Четыре задачи, ради которых Management API обычно и берут. Скрипты
не псевдокод — они выполнены на стенде целиком.

Во всех примерах:

```bash
export STEND=http://localhost:8080
export STEND_KEY=stend_sk_…   # серверный ключ
```

## Окружение под CI одним скриптом

Прогон тестов должен получать чистую песочницу и свой ключ, а не пользоваться
общими. Скрипт печатает переменные, которые дальше подхватывает job.

```bash
#!/usr/bin/env bash
set -euo pipefail

API="$STEND/api/v1"
NAME="ci-${GITHUB_RUN_ID:-local}"

api() {
  local method=$1 path=$2
  shift 2
  curl -sS -X "$method" "$API$path" \
    -H "Authorization: Bearer $STEND_KEY" \
    -H 'Content-Type: application/json' "$@"
}

# Песочница под прогон: без задержки и без случайных ошибок,
# иначе тесты падают на ровном месте.
SANDBOX=$(api POST /sandboxes \
  -d "{\"name\":\"$NAME\",\"project\":\"CI\",\"dataVolume\":\"min\",\"latencyMs\":0,\"errorRate\":0}")
SANDBOX_ID=$(printf '%s' "$SANDBOX" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')

# Ключ песочницы — им ходит код интеграции.
KEY=$(api POST "/keys?sandboxId=$SANDBOX_ID" \
  -d '{"name":"CI","services":["bitrix24","ozon","wildberries"]}')

echo "APISTEND_SANDBOX_ID=$SANDBOX_ID"
printf '%s' "$KEY" | node -pe '"APISTEND_KEY=" + JSON.parse(require("fs").readFileSync(0,"utf8")).secret'
```

```
APISTEND_SANDBOX_ID=cmttys5y5000ntqm3y097rtwh
APISTEND_KEY=stend_sbx_950e2eba9ca74a46f41b18545e276260
```

Полученный ключ сразу работает на шлюзе:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$STEND/oz/v3/posting/fbs/list" \
  -H 'Client-Id: 1' -H "Api-Key: $APISTEND_KEY" \
  -H 'Content-Type: application/json' -d '{"limit":1}'
# 200
```

Уборка после прогона — одним запросом, вместе с ключом:

```bash
curl -sS -X DELETE "$STEND/api/v1/sandboxes/$APISTEND_SANDBOX_ID" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d "{\"confirmName\":\"$NAME\"}"
```

```json
{
  "ok": true,
  "id": "cmttys5y5000ntqm3y097rtwh",
  "name": "ci-local",
  "removed": { "keys": 1, "webhooks": 0, "mocks": 0, "scenarios": 0, "bursts": 0, "requestLogs": 0, "b24Apps": 0, "overlay": 0 }
}
```

:::warning Держите серверный ключ CI не в той песочнице, которую сносите
Ключ выпускается внутри песочницы и перестаёт работать вместе с ней. Если
`STEND_KEY` выпущен в песочнице прогона, уборка обрубит доступ следующему шагу.
:::

## Ключ подрядчику с ограниченными правами

Подрядчику, который разбирает падения, нужен журнал — и больше ничего.

```bash
curl -sS -X POST "$STEND/api/v1/keys" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{
    "name": "Подрядчик: только логи",
    "kind": "server",
    "services": ["bitrix24"],
    "scopes": ["logs:read", "sandboxes:read"]
  }'
```

```json
{
  "id": "cmtty1zn80000tqm3zy5prwmf",
  "kind": "server",
  "mask": "stend_sk_13ee••••••51d8",
  "scopes": ["logs:read", "sandboxes:read"],
  "fullAccess": false,
  "secret": "stend_sk_13eedc3bfddbce93949c2dd70c8551d8",
  "warning": "Сохраните ключ: полностью он показывается только сейчас"
}
```

Проверьте границы сразу, не дожидаясь вопросов:

```bash
curl -s "$STEND/api/v1/logs?limit=1" -H "Authorization: Bearer $CONTRACTOR_KEY" | head -c 80
# {"items":[{"id":"cmtty1cj7003o7am3ecx44grz","publicId":"req_5b2248c388", …

curl -s "$STEND/api/v1/keys" -H "Authorization: Bearer $CONTRACTOR_KEY"
```

```json
{
  "error": "FORBIDDEN",
  "message": "Ключу не выдана область доступа «keys:read» (список ключей). Выданы: logs:read, sandboxes:read"
}
```

Этот ключ не сможет ни выпустить ключ шире себя, ни расширить себя правкой,
ни прокрутить чужой ключ с большими правами. Когда работа закончена:

```bash
curl -sS -X DELETE "$STEND/api/v1/keys/$CONTRACTOR_KEY_ID" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"confirmName":"Подрядчик: только логи"}'
```

Отзыв (`POST /keys/{id}/revoke`) вместо удаления оставит запись в списке
и связь с записями журнала — так видно, кто и когда ключом ходил.

## Пересоздать песочницу перед прогоном

Два способа, и они разные.

:::tabs
== Сброс демо-данных

Быстро и без потерь: удаляет только личные изменения поверх демо-данных
и переставляет `lastResetAt`. Ключи, вебхуки, моки, сценарии и журнал остаются
на месте.

```bash
curl -sS -X POST "$STEND/api/v1/sandboxes/$SANDBOX_ID/reset" \
  -H "Authorization: Bearer $STEND_KEY"
```

```json
{
  "sandboxId": "cmtty4eoh0006tqm356k1tp23",
  "removed": 0,
  "lastResetAt": "2026-09-09T10:18:49.795Z"
}
```

== Снести и создать заново

Полная чистота: уходит всё, включая ключи и журнал. После этого нужен новый ключ.

```bash
curl -sS -X DELETE "$STEND/api/v1/sandboxes/$SANDBOX_ID" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d "{\"confirmName\":\"$SANDBOX_NAME\"}"

curl -sS -X POST "$STEND/api/v1/sandboxes" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$SANDBOX_NAME\",\"dataVolume\":\"min\",\"latencyMs\":0,\"errorRate\":0}"
```
:::

Порядок именно такой: имя песочницы уникально в пределах аккаунта, и создать
одноимённую до удаления старой нельзя — придёт 409. Удалить последнюю песочницу
аккаунта тоже нельзя — 422; в этом случае создайте новую, перенесите работу
и удалите старую.

Если из прогона нужно убрать только историю вызовов, песочницу трогать незачем:

```bash
curl -sS -X POST "$STEND/api/v1/logs/clear" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"confirm":true}'
```

## Выгрузить журнал за период

Выгрузка отдаёт до `limit` записей за раз и честно сообщает, что упёрлась
в потолок.

```bash
curl -sS "$STEND/api/v1/logs/export?from=2026-09-01T00:00:00%2B03:00&to=2026-09-08T00:00:00%2B03:00&limit=10000" \
  -H "Authorization: Bearer $STEND_KEY" -o logs.json
```

```json
{
  "format": "json",
  "generatedAt": "2026-09-09T10:18:03.489Z",
  "count": 2,
  "truncated": true,
  "rows": ["…"]
}
```

`truncated: true` означает, что записей больше, чем вошло. Забирайте период
по кускам — по суткам или по часам:

```bash
for day in 01 02 03 04 05 06 07; do
  curl -sS "$STEND/api/v1/logs/export?from=2026-09-${day}T00:00:00Z&to=2026-09-${day}T23:59:59Z&format=csv" \
    -H "Authorization: Bearer $STEND_KEY" -o "logs-2026-09-$day.csv"
  sleep 10
done
```

:::warning Шесть выгрузок в минуту
У `logs/export` своё ограничение частоты, не связанное с общей нормой. Без паузы
цикл упрётся в 429 на седьмом шаге:

```json
{
  "error": "RATE_LIMITED",
  "message": "Выгрузок журнала не больше 6 в минуту. Повторите через 10 с или сузьте период полями from и to"
}
```
:::

Формат `csv` отдаётся с BOM и разделителем «;» — файл открывается в Excel
с русской локалью без плясок. Заголовок первой строки:

```
Время;Сервис;Метод;Эндпоинт;Код;Задержка, мс;Размер, байт;Сценарий;Ключ;ID запроса
```

Если нужны тела запросов и ответов, выгрузка их не отдаёт: они доступны только
поштучно в [`GET /logs/{id}`](/docs/api-upravleniya/resursy-logi).

:::next
- [Соглашения](/docs/api-upravleniya/soglasheniya) — общие правила, на которых держатся все рецепты
- [Области доступа](/docs/api-upravleniya/oblasti-dostupa) — как урезать ключ ровно до нужного
:::
