---
title: Заголовки честности
description: X-APIStend-Source, Readiness, Snapshot, Upstream и остальные метаданные ответа — что означает каждый и зачем читать их в тестах.
order: 230
group: Мок-API
---

Мок обязан быть неотличим от боевого сервиса по телу и коду ответа — и обязан
быть отличим по метаданным. Иначе им нельзя пользоваться осознанно: непонятно,
взято тело из документации или собрано по схеме, готов ли мок метода и на какую
дату снята спецификация. Всё это шлюз пишет в заголовки.

## Успешный ответ

:::params
| Заголовок | Значения | Что означает |
| --- | --- | --- |
| `X-APIStend-Source` | `example`, `schema`, `generic` | откуда взято тело |
| `X-APIStend-Readiness` | `ready`, `updating`, `planned` | готовность мока этого метода |
| `X-APIStend-Scenario` | значение `X-Mock-Scenario` | какой сценарий отработал |
| `X-APIStend-Upstream` | хост боевого сервиса | что подменяет этот адрес |
| `X-APIStend-Snapshot` | дата вида `2026-09-07` | на какую дату снята спецификация метода |
| `X-Request-Id` | `req_a50c51dbe8` | тот же идентификатор виден в журнале кабинета |
| `X-APIStend-Cors` | `added-by-sandbox` | CORS добавлен песочницей, в бою его не будет |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining` | числа | ёмкость ведра и остаток |
:::

Живой ответ выглядит так:

```
HTTP/1.1 200 OK
x-apistend-cors: added-by-sandbox
x-ratelimit-limit: 300
x-ratelimit-remaining: 299
content-type: application/json; charset=utf-8
x-request-id: req_a50c51dbe8
x-apistend-source: schema
x-apistend-readiness: updating
x-apistend-scenario: success
x-apistend-upstream: https://marketplace-api.wildberries.ru
x-apistend-snapshot: 2026-09-07
```

## Три яруса ответа

`X-APIStend-Source` — это ярус, на котором собрали тело.

:::params
| Значение | Как собрано | Чему можно верить |
| --- | --- | --- |
| `example` | пример ответа из документации сервиса | и форме, и значениям — они из документации |
| `schema` | генерация по схеме ответа + демо-данные | форме: набор полей и типы из спецификации, значения выдуманы |
| `generic` | пустой, но валидный для сервиса конверт | только тому, что клиент не упадёт на разборе |
:::

Ярус связан с готовностью: `example` — `ready`, `schema` — `updating`,
`generic` — `planned`. Так метод и помечен в каталоге.

Ответ метода без примера и без схемы у Bitrix24 выглядит буквально так:

```json
{"result":[],"total":0}
```

У Ozon в этом случае `{"result":{}}`, у Wildberries `{}`, а метод с успешным
кодом 204 отвечает пустым телом.

:::note Зачем это в тестах
Тест, который проверяет разбор ответа, имеет право работать с любым ярусом.
Тест, который проверяет бизнес-логику по значениям полей, на `schema`
и `generic` проверяет выдуманные данные. Прочитайте `X-APIStend-Source`
в тесте и пометьте такой случай явно, вместо того чтобы удивляться
расхождению с боем.
:::

## Особые источники

Кроме трёх ярусов каталога, `X-APIStend-Source` принимает два значения,
у которых другое происхождение:

- `custom-mock` — ответ отдал ваш собственный мок по префиксу `/custom/`;
- `app-context` — ответ про состояние портала Bitrix24 для локального
  приложения (`app.info`, `placement.*`, `event.*`). Такие ответы зависят
  от того, что приложение установило и зарегистрировало, а не от каталога.
  Рядом приходит `X-APIStend-App` с `client_id` приложения.

## Заголовки на ошибках

:::params
| Заголовок | Когда приходит |
| --- | --- |
| `X-APIStend-Error` | ключ не подошёл: `key-missing`, `key-unknown-or-revoked`, `key-scope` |
| `X-APIStend-Key-Services` | вместе с `key-scope`: список сервисов ключа |
| `X-APIStend-Did-You-Mean` | путь не найден: до трёх похожих путей каталога |
| `X-APIStend-Scenario` | сработал сценарий ошибки, в том числе `timeout` |
| `Retry-After`, `X-RateLimit-Retry` | превышение лимита у Ozon и Wildberries |
:::

На ответе с ошибкой авторизации заголовков `X-APIStend-Source`, `Readiness`
и `Snapshot` нет: метод до каталога не дошёл.

## Подводные камни

:::warning Браузер видит не все заголовки
В `Access-Control-Expose-Headers` перечислены `x-request-id`,
`x-apistend-source`, `x-apistend-readiness`, `x-apistend-scenario`,
`x-apistend-upstream`, `x-apistend-snapshot`, `x-apistend-did-you-mean`,
`x-apistend-error`, `x-apistend-cors`, `x-ratelimit-limit`,
`x-ratelimit-remaining`, `retry-after`. Всё остальное — включая
`x-apistend-key-services`, `x-apistend-app` и `x-ratelimit-retry` —
из кода страницы не читается.
:::

- Имена заголовков приходят в нижнем регистре; сравнивайте без учёта регистра.
- `X-APIStend-Snapshot` — дата снимка спецификации, а не дата ответа.
  У методов одного сервиса она общая.
- `X-APIStend-Upstream` показывает реальный хост метода. У Wildberries это
  не один адрес: `marketplace-api`, `content-api`, `advert-api` и другие.

:::next
- [Лимиты](/docs/mok-api/limity) — откуда берутся числа в `X-RateLimit-*`
- [Каталог методов](/catalog) — готовность и снимок по каждому методу
:::
