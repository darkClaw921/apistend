---
title: Области доступа
description: Полный список scopes, что даёт каждая, правило «право на запись включает чтение» и запрет выдавать больше, чем есть у себя.
order: 610
group: API управления
---

Области доступа (scopes) ограничивают серверный ключ. Ключ с пустым списком —
полный доступ; так работают все ключи, выданные до появления областей, и так же
выглядит «ключ для себя». Ограниченный ключ обязан перечислить области явно.

## Полный список

Список живёт в `apps/api/src/lib/mgmt.ts` и целиком отдаётся в `GET /api/v1/meta`
и в поле `x-scopes` спецификации OpenAPI.

:::params Области доступа
| Область | Что даёт |
| --- | --- |
| `*` | полный доступ |
| `account:read` | профиль и сводка аккаунта |
| `account:write` | изменение профиля, пароля, сессий |
| `sandboxes:read` | список и настройки песочниц |
| `sandboxes:write` | создание, изменение, сброс песочниц |
| `keys:read` | список ключей |
| `keys:write` | выпуск, ротация и отзыв ключей |
| `webhooks:read` | подписки и журнал доставок |
| `webhooks:write` | создание подписок и тестовые отправки |
| `scenarios:read` | сценарии симуляции |
| `scenarios:write` | создание и запуск сценариев |
| `bursts:read` | состояние серий событий |
| `bursts:write` | запуск и остановка серий событий |
| `mocks:read` | свои моки |
| `mocks:write` | создание и изменение своих моков |
| `logs:read` | журнал запросов |
| `logs:write` | очистка журнала запросов |
| `catalog:read` | каталог методов и сервисов |
| `apps:read` | локальные приложения Bitrix24 и их токены |
| `apps:write` | создание, установка и удаление приложений |
| `console:write` | вызов методов через консоль |
| `tunnel:read` | состояние туннелей CLI |
:::

## Право на запись включает чтение

Проверка устроена так: область считается выданной, если она перечислена явно,
если выдана `*`, если список пуст — или если запрошено чтение ресурса, на запись
которого право есть. Возможность изменить вебхук без возможности его прочитать
не имеет смысла, а держать в ключе обе строки — лишний повод ошибиться.

То есть `webhooks:write` даёт и `webhooks:read`. Обратное неверно.

## Какая область нужна маршруту

Область каждого маршрута указана в его описании в спецификации OpenAPI —
строкой «Требуемая область доступа». Сводно:

:::params Маршруты по областям
| Область | Маршруты |
| --- | --- |
| `account:read` | `GET /account`, `GET /account/sessions` |
| `account:write` | `PATCH /account`, `DELETE /account`, `POST /account/password`, `DELETE /account/sessions/{id}`, `POST /account/sessions/revoke-all` |
| `sandboxes:read` | `GET /sandboxes`, `GET /sandboxes/{sandboxId}` |
| `sandboxes:write` | `POST /sandboxes`, `PATCH /sandboxes/{sandboxId}`, `DELETE /sandboxes/{sandboxId}`, `POST /sandboxes/{sandboxId}/reset` |
| `keys:read` | `GET /keys`, `GET /keys/{id}` |
| `keys:write` | `POST /keys`, `PATCH /keys/{id}`, `DELETE /keys/{id}`, `POST /keys/{id}/revoke`, `POST /keys/{id}/rotate` |
| `webhooks:read` | `GET /webhooks`, `GET /webhooks/{id}`, `GET /webhooks/{id}/deliveries`, `GET /deliveries/{id}` |
| `webhooks:write` | `POST /webhooks`, `PATCH /webhooks/{id}`, `DELETE /webhooks/{id}`, `POST /webhooks/{id}/test`, `POST /webhooks/retry-failed`, `POST /deliveries/{id}/retry` |
| `scenarios:read` | `GET /scenarios`, `GET /scenarios/{id}` |
| `scenarios:write` | `POST /scenarios`, `PATCH /scenarios/{id}`, `DELETE /scenarios/{id}`, `POST /scenarios/{id}/run` |
| `bursts:read` | `GET /bursts`, `GET /bursts/{id}` |
| `bursts:write` | `POST /bursts`, `POST /bursts/{id}/stop` |
| `mocks:read` | `GET /mocks`, `GET /mocks/{id}`, `POST /mocks/preview` |
| `mocks:write` | `POST /mocks`, `PATCH /mocks/{id}`, `DELETE /mocks/{id}`, `POST /mocks/{id}/enable`, `POST /mocks/{id}/disable`, `POST /mocks/import` |
| `logs:read` | `GET /logs`, `GET /logs/{id}`, `GET /logs/export`, `GET /usage`, `GET /alerts` |
| `logs:write` | `POST /logs/clear`, `POST /alerts/{id}/read` |
| `catalog:read` | `GET /services`, `GET /methods`, `GET /methods/{id}`, `GET /events` |
| `apps:read` | `GET /apps`, `GET /apps/{id}` |
| `apps:write` | `POST /apps`, `PATCH /apps/{id}`, `DELETE /apps/{id}` |
| `console:write` | `POST /console/execute` |
| `tunnel:read` | `GET /tunnel/status` |
:::

:::note Сводка и уведомления живут в области журнала
`GET /usage` и `GET /alerts` требуют `logs:read`, а не `account:read`:
и то и другое считается по журналу запросов. Пометка уведомления прочитанным —
это запись, поэтому `POST /alerts/{id}/read` требует `logs:write`.
:::

## Отказ 403

Если области нет, ответ приходит до выполнения запроса и перечисляет выданное:

```bash
curl -s "$STEND/api/v1/keys" -H "Authorization: Bearer $LIMITED_KEY"
```

```json
{
  "error": "FORBIDDEN",
  "message": "Ключу не выдана область доступа «keys:read» (список ключей). Выданы: logs:read, sandboxes:read"
}
```

## Нельзя выдать больше, чем имеешь

Ключ не может выпустить, изменить или прокрутить ключ шире себя. Иначе один
`keys:write` превращался бы в полный доступ за два запроса.

:::steps
1. Ключ с ограниченными правами выпускает более узкий ключ

   Это разрешено: `logs:read` у выдающего есть.

   ```bash
   curl -s -X POST "$STEND/api/v1/keys" \
     -H "Authorization: Bearer $LIMITED_KEY" -H 'Content-Type: application/json' \
     -d '{"name":"doc-narrow","services":["bitrix24"],"kind":"server","scopes":["logs:read"]}'
   ```

2. Тот же ключ пробует выдать область, которой у него нет

   ```json
   {
     "error": "FORBIDDEN",
     "message": "Нельзя выдать области «account:write»: их нет у вызывающего ключа. Выданы: «keys:write», «logs:read»"
   }
   ```

3. И пробует выпустить ключ вообще без списка областей

   Пустой список — это полный доступ, поэтому такой запрос тоже отклоняется.

   ```json
   {
     "error": "FORBIDDEN",
     "message": "Ключ без списка scopes получает полный доступ, а у вызывающего ключа доступ ограничен. Перечислите области явно, не шире выданных: «keys:write», «logs:read»"
   }
   ```
:::

То же правило работает в трёх местах:

- `POST /keys` — выпуск нового ключа;
- `PATCH /keys/{id}` — правка областей: собственному ключу можно только урезать
  права, а не добавить;
- `POST /keys/{id}/rotate` — ротация выдаёт на руки рабочий секрет, поэтому
  прокрутить можно только ключ не шире собственных прав. Иначе ключ
  с одним `keys:write` прокручивал бы ключ с полным доступом и получал его права.

## Ключу песочницы области не назначаются

Ключ `stend_sbx_…` в Management API не принимается, поэтому его области ни на что
не влияли бы, а в списке показывали бы права, которых нет. Запрос отклоняется:

```json
{
  "error": "UNPROCESSABLE",
  "message": "Области доступа задаются только серверному ключу: ключом песочницы Management API не пользуются, его scopes ни на что не влияют. Уберите scopes или укажите kind=server"
}
```

Код ответа — 422.

## Подводные камни

- Урезание прав действует немедленно: правка `scopes` сбрасывает кеш разбора
  ключей. Ждать полминуты, как было бы без сброса, не нужно.
- Признак `fullAccess` в карточке ключа — готовый ответ на вопрос «это ключ
  без ограничений?»: он равен `true` у серверного ключа с пустым списком
  или с `*`.
- У cookie-сессии областей нет — всегда полный доступ. Проверять ограничения
  ключа через браузер бессмысленно.

:::next
- [Ключи](/docs/api-upravleniya/resursy-klyuchi) — выпуск, ротация, отзыв и удаление
- [Рецепты](/docs/api-upravleniya/recepty) — ключ подрядчику с ограниченными правами
:::
