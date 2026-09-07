# APIStend

[![CI](https://github.com/darkClaw921/apistend/actions/workflows/ci.yml/badge.svg)](https://github.com/darkClaw921/apistend/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/apistend?label=apistend)](https://www.npmjs.com/package/apistend)
[![Лицензия MIT](https://img.shields.io/badge/лицензия-MIT-blue.svg)](LICENSE)

Сервис демо-копий боевых API **Bitrix24**, **Ozon Seller** и **Wildberries**.
Разработчик подменяет базовый адрес боевого API на адрес песочницы и получает те же
схемы ответов, те же коды ошибок и те же события — включая доставку вебхуков
на `localhost` через npm-пакет [`apistend`](packages/cli).

```bash
# было
curl https://api-seller.ozon.ru/v3/posting/fbs/list -H "Api-Key: $REAL"
# стало — тот же путь, тот же формат ответа, никаких боевых данных
curl http://localhost:8080/oz/v3/posting/fbs/list -H "Api-Key: $STEND"
```

## Что внутри

| | |
| --- | --- |
| Методов в каталоге | **2 421** — Bitrix24 1 685, Ozon 420, Wildberries 316 |
| Источник | официальные OpenAPI и документация сервисов, снимки зафиксированы по sha256 |
| Формат событий | нативный для каждого сервиса, включая политику повторов и подписи |
| Доставка на localhost | WebSocket-туннель, публичный адрес не нужен |
| Нагрузочная проверка | серии событий с заданной скоростью и количеством |

Каждый метод каталога несёт происхождение: откуда взят ответ (`example` / `schema` /
`generic`), каким способом получен (`spec` / `mirror` / `parsed`), ссылку на страницу
документации и дату снимка. Неполнота видна, а не замаскирована.

## Быстрый старт

```bash
docker compose up -d postgres
pnpm install
cp .env.example .env          # при необходимости поправьте JWT_SECRET
pnpm db:migrate
pnpm db:seed                  # демо-данные + ключи
pnpm dev                      # API :8080, веб :3100
```

Вход: `demo@apistend.ru` / `apistend2026`.

Каталог методов лежит в репозитории собранным — `pnpm ingest` нужен только чтобы
пересобрать его из спецификаций (см. «Пересборка каталога»).

## Проверить мок из терминала

```bash
KEY=<ключ из вывода pnpm db:seed>

# подстановка вместо боевого адреса
curl -s localhost:8080/wb/api/v3/warehouses -H "Authorization: $KEY" | jq

# Bitrix24: имя метода в пути, ключ там же, где его ждёт портал
curl -s 'localhost:8080/b24/rest/crm.deal.list' -H "X-Mock-Key: $KEY" | jq '.result[0], .total'

# сценарии ответа
curl -si localhost:8080/wb/api/v3/warehouses -H "Authorization: $KEY" \
  -H 'X-Mock-Scenario: rate_limit' | head -20
```

Шлюз принимает ключ там же, где его ждёт боевой сервис: `Authorization` (WB),
`Client-Id` + `Api-Key` (Ozon), путь `/rest/{user}/{code}/` или `auth=` (Bitrix24),
плюс универсальный `X-Mock-Key`.

## Вебхуки на localhost

```bash
npx apistend login --api-key stend_sk_…
npx apistend listen --forward localhost:3000/webhooks
npx apistend trigger ONCRMDEALUPDATE
```

Приложение получает подлинный формат сервиса. У Bitrix24 это
`x-www-form-urlencoded` с PHP-скобками и **только идентификатором объекта** —
как боевой портал; значений полей в событии нет, за ними клиент обязан сходить
в `crm.deal.get`.

### Нагрузочная проверка

```bash
npx apistend trigger ONCRMDEALUPDATE --count 5000 --rate 200 --watch
```

Показывается фактическая скорость, а не заказанная. Если приложение не успевает
отвечать, серия притормаживает и пишет об этом — иначе замер показывал бы скорость
записи в сокет, а не скорость обработки. То же самое доступно на экране «Вебхуки»
кнопкой «Запустить» у сценария.

## Состав

| Пакет | Назначение |
| --- | --- |
| `apps/web` | Next.js 16: лендинг и кабинет |
| `apps/api` | Fastify: мок-шлюз, каталог, ключи, логи, вебхуки, туннель |
| `packages/cli` | npm-пакет `apistend` |
| `packages/mock-engine` | резолвер ответов, детерминированная генерация, кеш |
| `packages/catalog-ingest` | спецификации и документация → каталог методов |
| `packages/ui` | дизайн-система по `design-handoff` |
| `packages/shared` | профили сервисов, конверты ошибок, протокол туннеля |

Дизайн — в `design-handoff/`. Он источник истины: экран принят, когда совпадает
с PNG при ширине 1440 px.

## Как устроен ответ мока

Три яруса по приоритету:

1. **Пример из спецификации** — 1 445 методов Bitrix24, 177 Ozon, 81 WB.
2. **Схема + датасет** — `openapi-sampler` даёт скелет, детерминированный филлер
   подставляет значения. Детерминизм не через `faker.seed()`, а чистой функцией
   `value = f(hash(соль, тип, id, путь_поля))`.
3. **Пустой конверт сервиса** — схемы нет, метод честно помечен `planned`.

Ответ мока — чистая функция от (метод, сценарий, объём датасета), это закреплено
тестом на детерминизм. Поэтому он кешируется без оговорок: **20 500 запросов
в секунду при p95 6,3 мс** против 4 546 и 107 мс до кеширования.

## Пересборка каталога

```bash
pnpm vendor:b24   # 25 МБ документации Bitrix24 (MIT) + русские тексты
pnpm ingest       # спецификации -> packages/mock-engine/generated
```

Ozon и Wildberries закрыты анти-ботом от обычных HTTP-клиентов, поэтому их
спецификации вендорятся в `specs/` с фиксацией sha256 и даты снимка.

## Релиз пакета `apistend`

Публикацию делает GitHub Actions по тегу — руками `npm publish` не запускается,
иначе в npm однажды уедет сборка с чьей-то машины, а не из репозитория.

```bash
# 1. поднять версию в packages/cli/package.json и в VERSION в packages/cli/src/cli.ts
# 2. тег обязан совпадать с версией — иначе workflow остановится
git tag apistend-v1.5.1 && git push origin apistend-v1.5.1
```

**Токена в секретах нет и не нужно.** Пакет настроен на доверенную публикацию:
npm обменивает OIDC-токен GitHub Actions на право записи именно в `apistend`
и только из `.github/workflows/publish-cli.yml` этого репозитория. Красть
из секретов нечего, срок действия ничему не истекает, provenance выдаётся сам —
на странице в npm видно, из какого коммита и прогона собран пакет.

Перед публикацией workflow собирает пакет, показывает содержимое tarball
и проверяет, что установленный из него `apistend` запускается.

Разовый прогон без публикации — вкладка Actions → «Публикация apistend в npm» →
Run workflow с включённым «Собрать и проверить, но не публиковать».

## Диагностика

`GET /health` показывает попадания кешей, долю выборки журнала, потери и RSS.
Журнал запросов выше 300 строк в секунду прореживается — доля выборки видна
и в `/health`, и в интерфейсе.

## Правовое

APIStend не связан с правообладателями; названия сервисов используются для указания
совместимости. Источники, лицензии и даты снимков — в [NOTICE.md](NOTICE.md).
Код — под [MIT](LICENSE).
