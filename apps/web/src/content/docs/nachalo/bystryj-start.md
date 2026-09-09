---
title: Быстрый старт
description: Поднять стенд, получить ключ и увидеть первый ответ мока — от нуля до ответа за пять минут.
order: 110
group: Начало
---

Ниже — путь от пустой машины до первого ответа мока и до записи об этом вызове
в журнале. Все команды и весь вывод в этом разделе сняты с работающего стенда,
а не составлены по памяти.

## Шаг 1. Поднимите стенд

:::tabs
== через docker compose

```bash
docker compose up
```

Compose поднимает базу, шлюз и кабинет: API на порту 8080, веб на 3100.
Миграции накатываются сами; на пустой базе заводятся демо-данные с ключами,
вход: логин `demo`, пароль `apistend2026`.

== через pnpm

```bash
docker compose up -d postgres
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

В контейнере остаётся только база, остальное работает из исходников: правки
подхватываются на лету, без пересборки образа.
:::

Проверить, что шлюз жив, можно без всякого ключа:

```bash
curl -s localhost:8080/health
```

```json
{"ok":true,"services":["bitrix24","ozon","wildberries"],"methods":2421,"memoryMb":178}
```

Поле `methods` — это то, сколько записей сейчас в каталоге вашего стенда; оно
меняется с каждой волной пополнения, поэтому и приходит из базы, а не из текста.
Ответ `/health` длиннее показанного: в нём ещё счётчики кешей, доля выборки
журнала и срок хранения логов.

:::warning Про JWT_SECRET
Значение `JWT_SECRET` в `.env.example` помечено как `dev-only-change-me`.
Этим же секретом подписываются хеши ключей доступа, так что для любого стенда,
до которого можно достучаться не с вашей машины, замените его:
`openssl rand -base64 32`.
:::

## Шаг 2. Заведите аккаунт

Регистрация — логин и пароль от восьми символов; входа через сторонние
провайдеры нет. Почта необязательна и на вход не влияет: писем сервис не шлёт,
восстановления пароля по ней нет. Имя и название проекта тоже необязательны:
без имени подписью служит логин, без проекта — «Первый проект».

Логин — латиница, цифры, точка, дефис и подчёркивание, от 3 до 40 символов.
Регистр не важен: `Ivan` и `ivan` — один и тот же аккаунт.

Проще всего зарегистрироваться в кабинете на `localhost:3100/register`. То же
самое из терминала:

```bash
curl -s -X POST localhost:8080/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"login":"you","password":"apistend2026","project":"Интеграция 1С"}'
```

```json
{
  "user": {"id":"cmttxymew0007…","login":"you","email":null,"name":"You","initials":"Y"},
  "sandbox": {"id":"cmttxymf70008…","name":"sandbox-01","project":"Интеграция 1С"},
  "apiKey": "stend_sbx_732e…"
}
```

Регистрация сразу заводит песочницу `sandbox-01` и в ней ключ «Первый ключ»
на все сервисы стенда: без них продуктом нельзя пользоваться, поэтому отдельного
шага «создайте песочницу» нет.

:::danger Ключ показывается один раз
В базе лежит только хеш ключа и его края — начало и хвост для маски
`stend_sbx_732e••••••e8c7`. Поле `apiKey` в ответе на регистрацию и поле `secret`
в ответе на создание ключа — единственные моменты, когда полное значение покидает
сервер. Не сохранили — заведите новый ключ, восстановить существующий нельзя.
:::

## Шаг 3. Создайте свой ключ (необязательно)

Ключ из регистрации уже работает. Отдельный ключ имеет смысл заводить под
конкретный сервис или конкретную интеграцию — тогда чужой код не сможет
ходить туда, куда ему не надо:

```bash
curl -s -X POST localhost:8080/api/keys \
  -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"Проверка документации","kind":"sandbox","services":["wildberries"]}'
```

```json
{
  "key": {"id":"cmtty1kse003p…","name":"Проверка документации","mask":"stend_sbx_b47e••••••fa66"},
  "secret": "stend_sbx_b47e…",
  "warning": "Сохраните ключ: полностью он показывается только сейчас"
}
```

То же самое делает кнопка «Создать ключ» на экране «Ключи и токены» в кабинете —
запрос ходит с cookie сессии, поэтому в curl нужен `-b cookies.txt` (сохранить
её можно флагом `-c cookies.txt` при регистрации или входе).

:::params Что задаётся у ключа
| Поле | Обяз. | Что значит |
| --- | --- | --- |
| `name` | да | название в списке, от 2 до 80 символов |
| `kind` | нет | `sandbox` — ключ песочницы (`stend_sbx_…`), `server` — серверный ключ для CLI (`stend_sk_…`). По умолчанию `sandbox` |
| `services` | да | к каким сервисам ключ пускает: `bitrix24`, `ozon`, `wildberries` |
| `rotationDays` | нет | срок напоминания о замене, по умолчанию 90. Сам ключ от этого не протухает |
| `scopes` | нет | области доступа к Management API; имеют смысл только при `kind: server`. Пустой список — полный доступ |
:::

Незнакомый или отозванный ключ отвечает 401 в родном конверте сервиса,
а причину кладёт в служебный заголовок:

```
HTTP/1.1 401 Unauthorized
x-apistend-error: key-unknown-or-revoked

{"error":"NO_AUTH_FOUND","error_description":"Wrong authorization data"}
```

## Шаг 4. Сделайте первый запрос

Подставьте адрес стенда вместо боевого. Ключ кладите туда же, куда его кладёт
клиентская библиотека сервиса.

:::tabs
== Wildberries

```bash
KEY=stend_sbx_…
curl -si localhost:8080/wb/api/v3/warehouses -H "Authorization: $KEY"
```

== Ozon Seller

```bash
curl -si -X POST localhost:8080/oz/v3/posting/fbs/list \
  -H "Client-Id: 123" -H "Api-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

== Bitrix24

```bash
curl -si localhost:8080/b24/rest/crm.deal.list -H "X-Mock-Key: $KEY"
```

У Bitrix24 работает и родная адресация входящего вебхука —
`localhost:8080/rest/1/$KEY/crm.deal.list.json`, и параметр `auth=`.
:::

Живой ответ на первую из этих команд:

```
HTTP/1.1 200 OK
access-control-allow-origin: *
content-type: application/json
x-request-id: fd92ca05545b4fe9edcf61a7c1189c58
x-ratelimit-limit: 300
x-ratelimit-remaining: 299
x-ratelimit-reset: 1
x-apistend-request-id: fd92ca05545b4fe9edcf61a7c1189c58
x-apistend-source: schema
x-apistend-readiness: updating
x-apistend-scenario: success
x-apistend-upstream: https://marketplace-api.wildberries.ru
x-apistend-snapshot: 2026-09-07
x-apistend-cors: added-by-sandbox

[{"name":"ул. Троицкая, Подольск, Московская обл.","officeId":90414,"id":68574,
  "cargoType":1,"deliveryType":1,"isDeleting":false,"isProcessing":true}, …]
```

Верхняя половина — заголовки самого Wildberries: `Content-Type` без `charset`,
`X-Request-Id` из 32 знаков, счётчик лимита. Ровно это увидела бы ваша библиотека
в бою, и ровно поэтому подмена адреса её не ломает. У Ozon набор другой,
у Битрикс24 — третий.

Нижняя половина — `X-APIStend-*`: их в бою нет, они говорят, откуда взялось тело
и насколько готов мок этого метода. Здесь ответ собран по схеме, а не взят готовым
примером из спецификации.
Разбор всех заголовков — в разделе [Заголовки ответа](/docs/mok-api/zagolovki-chestnosti).

## Шаг 5. Найдите вызов в журнале

Журнал открывается на экране «Логи» кабинета — `localhost:3100/logs`.
Искать удобно по `X-APIStend-Request-Id` из ответа: это и есть публичный
идентификатор записи, и у Wildberries с Ozon он совпадает с боевым заголовком
(`X-Request-Id` и `x-o3-trace-id` соответственно). Из терминала — тот же журнал, что видит кабинет:

```bash
curl -s -b cookies.txt 'localhost:8080/api/logs?limit=3'
```

```json
{
  "summary": {"total":15,"errorRate":33.33,"avgLatencyMs":211,"p95LatencyMs":1502},
  "sampling": {"sampleRate":1,"sampledOut":0},
  "rows": [
    {"publicId":"fd92ca05545b4fe9edcf61a7c1189c58","serviceCode":"wildberries","httpMethod":"GET",
     "endpoint":"/api/v3/warehouses","statusCode":200,"durationMs":5,"sizeBytes":721}
  ]
}
```

Тело успешного ответа в журнале не хранится: оно детерминировано и
восстанавливается движком по методу и объёму демо-данных при открытии карточки
запроса. Тела ошибок хранятся — в их конверте есть идентификатор запроса и метка
времени, восстановить их неоткуда.

## Проверьте сценарий ошибки

Ответ переключается заголовком `X-Mock-Scenario`. Значения — те же, что
в кабинете:

:::params Значения X-Mock-Scenario
| Значение | Что возвращает |
| --- | --- |
| `success` | обычный успешный ответ |
| `invalid_token` | ошибка авторизации в формате сервиса |
| `not_found` | объект не найден |
| `rate_limit` | превышение лимита, с кодом и заголовками этого сервиса |
| `server_error` | ошибка на стороне сервиса |
| `timeout` | соединение держится 30 секунд, потом приходит ошибка таймаута |
:::

```bash
curl -si localhost:8080/wb/api/v3/warehouses \
  -H "Authorization: $KEY" -H 'X-Mock-Scenario: rate_limit'
```

```
HTTP/1.1 429 Too Many Requests
content-type: application/json
x-request-id: 36170ddaa809e86093bdbecb84fd2482
x-ratelimit-limit: 300
x-ratelimit-remaining: 0
x-ratelimit-reset: 20
x-ratelimit-retry: 20
x-apistend-scenario: rate_limit

{"title":"Too Many Requests","detail":"rate limit exceeded","code":"TooManyRequests",
 "requestId":"36170ddaa809e86093bdbecb84fd2482","origin":"ag-api","status":429,
 "statusText":"too_many_requests","timestamp":"2026-09-09T10:14:24.992Z"}
```

Поле `requestId` в теле повторяет заголовок `X-Request-Id` — так же, как в бою.

Тот же сценарий у Bitrix24 даёт не 429, а `503 QUERY_LIMIT_EXCEEDED`:

```
HTTP/1.1 503 Service Unavailable

{"error":"QUERY_LIMIT_EXCEEDED","error_description":"Too many requests"}
```

Мок повторяет поведение конкретного сервиса, а не общее представление о лимитах.

## Подводные камни первых минут

- **Новая песочница по умолчанию врёт в пяти процентах случаев.** Доля случайных
  ошибок у свежей песочницы — 5 %: примерно каждый двадцатый успешный запрос
  подменяется на `server_error`. Это настройка, а не сбой; поставьте её в ноль
  ползунком на экране «Ключи и токены» — или запросом
  `PATCH /api/v1/sandboxes/{sandboxId}` с `{"errorRate": 0}`, если сейчас
  проверяете не обработку сбоев.
- **Ответ приходит не мгновенно.** Стандартная искусственная задержка песочницы —
  250 мс. Фактическая равна минимуму из настройки песочницы и задержки самого
  метода, а заголовок `X-Mock-Delay` (0–3000 мс) перебивает обе.
- **Опечатка в имени сценария не ошибка.** Неизвестное значение `X-Mock-Scenario`
  молча трактуется как `success`. Что именно отработало, всегда видно
  в `X-APIStend-Scenario` ответа.
- **`timeout` держит соединение полминуты.** Это не зависание стенда: сценарий
  так и задуман, ответ придёт через 30 секунд.
- **Опечатка в пути даёт родной 404 сервиса**, но с подсказкой в служебном
  заголовке: `x-apistend-did-you-mean: /api/v3/warehouses, /api/v3/warehouses/{warehouseId}, …`

:::next
- [Основные понятия](/docs/nachalo/osnovnye-ponyatiya) — песочница, ключи, объём данных, сценарии и сброс
- [Совместимость и ограничения](/docs/nachalo/sovmestimost-i-ogranicheniya) — что мок повторяет точно, а что нет
- [Заголовки ответа](/docs/mok-api/zagolovki-chestnosti) — происхождение ответа в метаданных
:::
