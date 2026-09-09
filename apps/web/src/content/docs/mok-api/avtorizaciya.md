---
title: Авторизация
description: Шлюз принимает ключ там же, где его ждёт боевой сервис: путь вебхука Bitrix24, Client-Id и Api-Key у Ozon, Authorization у Wildberries.
order: 210
group: Мок-API
---

Смысл подмены адреса пропадает, если ради песочницы приходится переписывать
авторизацию. Поэтому шлюз принимает ключ во всех местах, куда его кладут
клиентские библиотеки каждого сервиса, — и дополнительно два универсальных
варианта для своего кода.

## Где шлюз ищет ключ

Источники проверяются в этом порядке; побеждает первый непустой.

:::params
| Откуда | Пример | Чей это способ |
| --- | --- | --- |
| `X-Mock-Key` | `X-Mock-Key: stend_sbx_…` | универсальный |
| `Api-Key` | `Api-Key: stend_sbx_…` | Ozon |
| `Authorization` | `Authorization: stend_sbx_…` | Wildberries (без префикса) |
| `Authorization: Bearer` | `Authorization: Bearer stend_sbx_…` | универсальный |
| `?auth=` | `/rest/crm.deal.list.json?auth=stend_sbx_…` | Bitrix24 |
| путь вебхука | `/rest/1/stend_sbx_…/crm.deal.list.json` | Bitrix24 |
| поле `auth` в теле | `auth=stend_sbx_…` или `{"auth":"stend_sbx_…"}` | Bitrix24 |
:::

Ключ — это строка, начинающаяся с `stend_sbx_` (ключ песочницы) или `stend_sk_`
(серверный ключ). Всё остальное отбрасывается сразу, без обращения к базе.

## Примеры по сервисам

:::tabs
== Bitrix24

Входящий вебхук — секрет в пути. Идентификатор пользователя и суффикс
`.json` шлюз отрезает сам:

```bash
curl -s -X POST "localhost:8080/b24/rest/1/$KEY/crm.deal.list.json"
```

То же самое параметром `auth` или полем `auth` в теле:

```bash
curl -s "localhost:8080/rest/crm.deal.fields.json?auth=$KEY"
curl -s -X POST localhost:8080/b24/rest/crm.deal.fields.json -d "auth=$KEY"
```

== Ozon

```bash
curl -s -X POST localhost:8080/oz/v3/product/info/list \
  -H "Client-Id: 123" -H "Api-Key: $KEY" \
  -H "Content-Type: application/json" -d '{}'
```

Значение `Client-Id` шлюз не проверяет: продавца определяет ключ песочницы.
Заголовок нужен только затем, чтобы ваш клиент отправлял привычный набор.

== Wildberries

```bash
curl -s localhost:8080/wb/api/v3/warehouses -H "Authorization: $KEY"
```

Wildberries шлёт токен без префикса `Bearer`; шлюз принимает оба варианта.
:::

## Когда ключ не подошёл

Тело ответа совпадает с боевым до последнего поля — иначе клиентская
библиотека разобрала бы его иначе, чем в бою. Причина отказа уходит
в служебный заголовок `X-APIStend-Error`.

:::params
| Значение `X-APIStend-Error` | Что случилось |
| --- | --- |
| `key-missing` | ключа в запросе не нашлось ни в одном из мест |
| `key-unknown-or-revoked` | ключ есть, но он неизвестен, отозван или просрочен |
| `key-scope` | ключ действителен, но этот сервис в него не входит |
:::

Ответ Wildberries на запрос без ключа — родной конверт сервиса, код 401:

```json
{"title":"Unauthorized","detail":"invalid API access token: empty main token","code":"Unauthorized","requestId":"0dcf08a519c89fe14c98a7c727fd116f","origin":"ag-api","status":401,"statusText":"unauthorized","timestamp":"2026-09-09T10:15:46.623Z"}
```

У Bitrix24 в той же ситуации — `{"error":"NO_AUTH_FOUND"}` с кодом 401,
у Ozon — `{"code":16,"message":"Client-Id and Api-Key headers are required","details":[]}`.

При `key-scope` шлюз дополнительно показывает, на какие сервисы ключ выдан:

```
x-apistend-error: key-scope
x-apistend-key-services: bitrix24
```

:::note Эти два заголовка браузеру не видны
`X-APIStend-Key-Services` и `X-APIStend-App` не входят в список
`Access-Control-Expose-Headers`, поэтому из кода страницы они не читаются.
Смотреть их следует из серверного клиента, из curl или в журнале запросов.
:::

## Подводные камни

:::warning Ключ виден в пути и в журнале сервера
Секрет в пути `/rest/{user}/{code}/…` — родной способ Bitrix24, но такой адрес
попадает в логи прокси и в историю оболочки. Из журнала APIStend значения
`Authorization`, `X-Mock-Key` и `Api-Key` вырезаются, а вот сам путь запроса
сохраняется как есть.
:::

- Разбор ключа кешируется на 30 секунд, включая отрицательный результат:
  перебор мусорных ключей не бьёт в базу на каждом запросе. При отзыве
  и ротации ключа кеш сбрасывается, поэтому отзыв срабатывает сразу.
- Ключ проверяется до маршрутизации: на несуществующий путь без ключа
  вы получите 401, а не 404.
- Серверный ключ (`stend_sk_…`) шлюз тоже принимает — он привязан к той же
  песочнице. Для кода приложения выдавайте ключ песочницы.

:::next
- [Управление ответом](/docs/mok-api/upravlenie-otvetom) — сценарии и задержка
- [Лимиты](/docs/mok-api/limity) — что происходит при превышении
:::
