# Развёртывание на проде

Прод — один сервер `apistend.ru` (155.212.138.41, Ubuntu 26.04, 1 vCPU, 1,9 ГБ RAM,
14 ГБ диска). На нём же стоит self-hosted раннер GitHub Actions, поэтому деплой
не требует ни SSH-ключей в секретах репозитория, ни доступа снаружи.

## Как едет релиз

```
пуш в main → CI (ubuntu-latest) → зелёный → Deploy (раннер на проде)
```

`Deploy` подписан на `workflow_run` от `CI`, а не на `push`. Иначе деплой уезжал бы
одновременно с тестами и успевал обновить прод раньше, чем те упадут.

Три условия в `if` джобы — не перестраховка. Раннер стоит на самом проде,
а репозиторий публичный:

| Условие | Что отсекает |
| --- | --- |
| `github.repository == 'darkClaw921/apistend'` | форк, где раннер оказался бы виден |
| `workflow_run.event == 'push'` | **главное**: CI гоняется и на `pull_request`, в том числе из форков |
| `workflow_run.head_branch == 'main'` | зелёный CI на любой другой ветке |

Код берётся по `workflow_run.head_sha` — тот самый коммит, который проверил CI,
а не текущая голова `main`.

Ручной прогон — `workflow_dispatch` в интерфейсе Actions.

## Что происходит на сервере

1. `actions/checkout` с `clean: false` — иначе `git clean -ffdx` сносит `node_modules`,
   а на одном ядре это добавляет к каждому деплою около десяти минут.
2. `pnpm install --frozen-lockfile --prod=false`. Флаг обязателен: при
   `NODE_ENV=production` pnpm выбросил бы `prisma` и `dotenv`, а `dotenv`
   импортируется в рантайме (`apps/api/src/env.ts`).
3. `prisma generate` и `prisma migrate deploy`. Приложение схему само не накатывает.
4. Останов кабинета, `next build`, запуск обоих сервисов.
   Мок-шлюз во время сборки продолжает отвечать — падает только кабинет.
5. Проверка `/health` и корня кабинета, до тридцати попыток.

API **не собирается**: `tsc -p tsconfig.build.json` падает на `TS5096`, а результат
всё равно нерабочий. Node 26 снимает типы на лету, сервис запускает `node src/server.ts`.
Корневой `pnpm build` тоже не годится — turbo тянет туда сборку api и валит вместе с ней
параллельную сборку кабинета.

## Раскладка сервера

| Что | Где |
| --- | --- |
| Рабочая копия | `/home/deploy/actions-runner/_work/apistend/apistend`, стабильный путь `/srv/apistend/app` |
| Переменные | `/etc/apistend/app.env` (0640, `root:deploy`) |
| Секреты БД и JWT | `/etc/apistend/secrets.env` |
| Сервисы | `apistend-api.service` → 127.0.0.1:8080, `apistend-web.service` → 127.0.0.1:3100 |
| PostgreSQL | контейнер `apistend-postgres`, `/srv/apistend/postgres/compose.yml`, слушает только петлю |
| nginx | `/etc/nginx/sites-available/apistend` |
| Раннер | `actions.runner.darkClaw921-apistend.apistend-prod.service`, пользователь `deploy` |

Раннер работает не от root. Единственное, что ему позволено делать от root, —
два скрипта из `/etc/sudoers.d/apistend`: `apistend-restart` и `apistend-web-stop`.
Именно обёртки, а не `systemctl` в sudoers: так подставить произвольный юнит
аргументом нельзя.

## Маршрутизация nginx

Один домен на всё. На API уходят поимённо перечисленные префиксы, остальное —
Next.js:

`/api/` (включая `/api/v1/` — библиотека BX24.js), `/rest/`, `/oauth/`, `/v1/`,
`/b24/`, `/oz/`, `/wb/`, `/custom/`, `/health`.

`/rest/` нужен именно в корне: портал отдаёт приложению голый `DOMAIN`, и приложение
само склеивает `<схема>://<DOMAIN>/rest/<метод>`.

В `/v1/` живёт WebSocket-туннель `apistend listen` — отсюда `proxy_read_timeout 3600s`
и проброс `Upgrade`/`Connection`. `X-Forwarded-Proto` и `X-Forwarded-Host` обязательны:
адрес туннеля API строит из заголовков запроса, и без них CLI получит `ws://` вместо
`wss://`.

## Память и диск

1,9 ГБ RAM — это и сборка, и PostgreSQL, и оба Node-процесса. Поэтому:

- 4 ГБ swap, `vm.swappiness=10`. Без него OOM-killer убивает `next build`
  с невнятным «Killed».
- `--max-old-space-size`: 1400 на сборку, 768 у API, 384 у кабинета.
- Кабинет останавливается на время сборки.

## Сид на проде не запускается

`pnpm db:seed` создаёт `demo@apistend.ru` с паролем, напечатанным в README публичного
репозитория, и выводит все ключи в stdout — то есть в лог Actions. Учётные записи
на проде заводятся через обычную регистрацию.

## TLS

`apistend-tls.timer` раз в пять минут проверяет через публичный DNS, указывает ли
`apistend.ru` на этот сервер, и при первом совпадении выпускает сертификат
(`certbot --nginx --redirect`), после чего выключается. Обновление — штатный
`certbot.timer`.

В `/etc/hosts` домен заведён на петлю: лендинг — серверный компонент и делает
`fetch` на `APISTEND_PUBLIC_ORIGIN` изнутри машины.
