---
title: Приложения Bitrix24
description: Локальные приложения портала: client_id и client_secret, адреса демо-портала, правка настроек с ростом version и удаление с ONAPPUNINSTALL.
order: 710
group: API управления
---

APIStend играет роль портала Bitrix24 и заводит локальные приложения так же,
как боевой портал: выдаёт пару `client_id` / `client_secret`, адреса OAuth и REST,
токен приложения для подписи событий. Управление этим — маршруты `/apps`.

## GET /apps

Область: `apps:read`. Приложения песочницы, свежие сверху. Фильтры: `state`
(`awaiting_install` / `installed` / `uninstalled`) и `kind` (`server_ui` /
`api_only`).

`client_secret` в списке не отдаётся — он есть в карточке и в ответе на создание.

## POST /apps

Область: `apps:write`. Ответ — 201.

:::params Тело запроса
| Поле | Обязательное | Значение |
| --- | --- | --- |
| `title` | да | 1–120 символов |
| `scope` | да | минимум одно право портала, например `crm` |
| `code` | нет | `[a-z0-9._-]`, 2–60 символов; без него собирается из названия |
| `kind` | нет | `server_ui` (по умолчанию) или `api_only` |
| `handlerUrl` | нет | адрес обработчика |
| `installUrl` | нет | адрес страницы установки |
| `menuTitle` | нет | подпись в меню портала |
| `tokenTtlSeconds` | нет | 5–86 400 |
| `refreshTtlSeconds` | нет | 60–15 552 000 |
:::

```bash
curl -s -X POST "$STEND/api/v1/apps" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Док-приложение","scope":["crm"],"handlerUrl":"http://localhost:3000/b24/handler"}'
```

```json
{
  "id": "cmtty9mn9000dtqm3zv9o6tx6",
  "code": "dok.prilozhenie",
  "title": "Док-приложение",
  "kind": "server_ui",
  "state": "awaiting_install",
  "scope": ["crm"],
  "handlerUrl": "http://localhost:3000/b24/handler",
  "installUrl": null,
  "menuTitle": null,
  "clientId": "local.af12a67b574515.26459786",
  "version": 1,
  "tokenTtlSeconds": 3600,
  "refreshTtlSeconds": 15552000,
  "installedAt": null,
  "lastInstallNote": null,
  "counts": { "placements": 0, "tokens": 0, "subscriptions": 0 },
  "clientSecret": "HT5AowqxooZz3LEWylTPLBgZJ5YtFEJtE66dROPvstGtzK72B9",
  "applicationToken": "1ab9fa3f79cef2eeb438fa31adc40109",
  "portal": {
    "domain": "localhost:8080",
    "memberId": "91ad1462931fde1c6d287b604a7f9546",
    "clientEndpoint": "http://localhost:8080/rest/",
    "serverEndpoint": "http://localhost:8080/oauth/rest/"
  },
  "placements": []
}
```

`client_id` и `client_secret` выдаются один раз и потом не меняются — как
в боевом портале, где перевыпуска нет. Приложение создаётся в состоянии
`awaiting_install`: пока его не открыли во фрейме (или, для `api_only`, пока
не доставлен `ONAPPINSTALL`), `app.info` отвечает `INSTALLED: false`.

Занятый код приложения даёт 409.

## GET /apps/{id}

Область: `apps:read`. В отличие от списка отдаёт `clientSecret`,
`applicationToken`, зарегистрированные виджеты (`placement.bind`) и адреса
демо-портала, по которым приложение проходит OAuth и вызывает REST.

## PATCH /apps/{id}

Область: `apps:write`. Меняются только переданные поля. Любая правка поднимает
`version`: боевой портал делает так же, и приложение по изменившемуся номеру
понимает, что настройки пора перечитать. Код приложения, `client_id`
и `client_secret` не меняются никогда, установку правка не сбрасывает.

## DELETE /apps/{id}

Область: `apps:write`. Подтверждение — код приложения (поле `code`)
в `confirmName`.

```bash
curl -s -X DELETE "$STEND/api/v1/apps/$APP_ID" \
  -H "Authorization: Bearer $STEND_KEY" -H 'Content-Type: application/json' \
  -d '{"confirmName":"dok.prilozhenie"}'
```

```json
{
  "ok": true,
  "app": { "id": "cmtty9mn9000dtqm3zv9o6tx6", "code": "dok.prilozhenie", "title": "Док-приложение" },
  "tokensRevoked": 0,
  "subscriptionsRemoved": 0,
  "placementsRemoved": 0,
  "uninstallDelivery": {
    "deliveryId": "evt_145e6cd3d1c5",
    "state": "dispatched",
    "target": "public",
    "targetUrl": "http://localhost:3000/b24/handler"
  }
}
```

:::danger Удаление необратимо
Запись удаляется целиком вместе с `client_id`, `client_secret`, токенами
и виджетами. Состояние `uninstalled` здесь не используется: надгробие держало бы
занятым код приложения, и создать заново приложение с тем же кодом стало бы
нельзя. В боевом портале удаление тоже не оставляет ничего, а повторное
добавление выдаёт новую пару `client_id` / `client_secret`.
:::

Перед удалением на адрес приложения уходит `ONAPPUNINSTALL` — как в бою,
без токенов в `auth[]`. Записи журнала доставок остаются: подтверждение того,
что событие ушло, нужно как раз после удаления.

Подтверждение обязательно именно кодом: он не совпадёт, если в адрес попал
идентификатор соседней записи.

:::next
- [Локальные приложения](/docs/bitrix24/lokalnye-prilozheniya) — как приложение работает с порталом
- [Карточка приложения](/docs/bitrix24/kartochka-prilozheniya) — те же поля в кабинете
:::
