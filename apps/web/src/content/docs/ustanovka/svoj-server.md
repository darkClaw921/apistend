---
title: Развёртывание на своём сервере
description: Сборка образа, обратный прокси и TLS, миграции, резервные копии базы.
order: 830
group: Установка
---

Стенд, до которого можно достучаться не с вашей машины, отличается от локального
четырьмя вещами: своим `JWT_SECRET`, отключённым сидом, запретом приватных адресов
доставки и обратным прокси с TLS перед обоими сервисами. Всё остальное — тот же
`docker compose`.

## Сборка образа под свой адрес

Адрес API попадает в клиентский код кабинета на этапе сборки, поэтому собирать
образ надо с тем адресом, по которому API увидит браузер:

```bash
docker compose build --build-arg NEXT_PUBLIC_API_URL=https://stend.example.com
```

Тот же адрес нужен API, чтобы правильно называть себя в кабинете и в туннеле:
`APISTEND_PUBLIC_ORIGIN=https://stend.example.com`.

## Что поправить в compose

:::params Отличия от локального стенда
| Переменная | Значение | Почему |
| --- | --- | --- |
| `JWT_SECRET` | свой, из `openssl rand -base64 32` | значение по умолчанию напечатано в публичном репозитории |
| `APISTEND_SEED` | `0` | иначе на пустой базе заведётся демо-аккаунт с общеизвестным паролем |
| `WEB_ORIGIN` | внешний адрес кабинета | это единственный origin, которому разрешён CORS с cookie |
| `APISTEND_PUBLIC_ORIGIN` | внешний адрес API, обязательно `https://` | из него строится схема WebSocket-туннеля: на `http://` CLI получит `ws://` вместо `wss://` |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | убрать строку | в образе `NODE_ENV=production`, и без переопределения приватные адреса запрещены — на общем сервере это и нужно |
:::

Секреты держите не в `docker-compose.yml`, а в `.env` рядом с ним или в окружении:
compose подставляет их в `${JWT_SECRET}` при разборе файла.

Публиковать порты 8080 и 3100 наружу не нужно — их закрывает прокси. Порт базы
не публикуйте вовсе.

## Обратный прокси

Один домен на всё. На API уходят перечисленные поимённо префиксы, остальное — кабинету:

`/api/`, `/rest/`, `/oauth/`, `/v1/`, `/b24/`, `/oz/`, `/wb/`, `/custom/`, `/health`.

`/rest/` нужен именно в корне: портал Bitrix24 отдаёт приложению голый `DOMAIN`,
а приложение само склеивает `<схема>://<DOMAIN>/rest/<метод>`.

```nginx
# Туннель идёт первым и с ^~: этот префикс должен выиграть у регулярного
# выражения ниже, иначе WebSocket попадёт в общую ветку без Upgrade.
location ^~ /v1/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_read_timeout 3600s;
}

location ~ ^/(api|rest|oauth|b24|oz|wb|custom)/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
}

location = /health {
    proxy_pass http://127.0.0.1:8080;
}

location / {
    proxy_pass http://127.0.0.1:3100;
}
```

Три вещи здесь не косметические:

- **`Upgrade` нужен только в `/v1/`.** Там единственный WebSocket — `/v1/tunnel/connect`,
  туннель `apistend listen`. Оттуда же длинный `proxy_read_timeout`: соединение
  живёт часами.
- **`X-Forwarded-Proto` и `X-Forwarded-Host` обязательны.** Адрес туннеля API строит
  из заголовков запроса, и без них CLI получит `ws://` вместо `wss://`.
- **`X-Forwarded-For` ставится, а не дописывается.** Fastify поднят с `trustProxy: true`
  и берёт из цепочки крайний левый адрес: при дописывании клиент смог бы назначить
  себе любой IP в журнале запросов.

## TLS

Сертификат — обычным `certbot` с автопродлением по `certbot.timer`; по HTTP только
редирект на HTTPS.

Если лендинг и кабинет отрисовываются на том же сервере, куда смотрит домен, заведите
домен в `/etc/hosts` на петлю: серверные компоненты Next делают `fetch`
на `APISTEND_PUBLIC_ORIGIN` изнутри машины.

## Миграции

Схему приложение само не накатывает. В контейнере это делает точка входа:
`prisma migrate deploy` выполняется перед стартом сервера и применяет только
неприменённое.

При запуске из исходников то же самое руками:

```bash
pnpm --filter @apistend/api exec prisma migrate deploy
```

`migrate deploy`, а не `migrate dev`: второй умеет пересоздавать базу и на сервере
неуместен.

Проверить состояние:

```console
$ pnpm --filter @apistend/api exec prisma migrate status
11 migrations found in prisma/migrations

Database schema is up to date!
```

## Резервные копии

Копия нужна не «на всякий случай», а как единственный способ вернуться назад:
миграции необратимы, и откат кода схему не откатывает.

```bash
docker exec apistend-postgres pg_dump -U apistend -d apistend --format=custom \
  > /var/backups/apistend-$(date +%F).pgdump
```

Восстановление в пустую базу:

```bash
docker exec -i apistend-postgres pg_restore -U apistend -d apistend --clean --if-exists \
  < /var/backups/apistend-2026-09-09.pgdump
```

Дамп кладите в cron ежедневно и храните несколько последних. Тома Docker в бэкап
файловой системы обычно не попадают — проверьте, что попадает именно каталог с дампами.

:::note Что не нужно бэкапить
Каталог методов лежит в репозитории собранным (`packages/mock-engine/generated`),
спецификации — в `specs/`. Всё это восстанавливается из git.
:::

## Про ресурсы

Оценка с нашего сервера, а не измерение вашего: на одном vCPU и 1,9 ГБ памяти
стенд работает, но сборка кабинета в такую память не помещается без запаса.
Мы держим 4 ГБ swap с `vm.swappiness=10` и ограничиваем кучу Node
(`--max-old-space-size`: 1400 на сборку, 768 у API, 384 у кабинета), а кабинет
останавливаем на время сборки. Без этого `next build` завершается
невнятным «Killed» от OOM-killer.

:::next
- [Обновление и откат](/docs/ustanovka/obnovlenie-i-otkat) — порядок действий при релизе
- [Переменные окружения](/docs/ustanovka/peremennye-okruzheniya) — полный список настроек
:::
