# Образ APIStend: и шлюз с API, и кабинет.
#
# Один образ на оба сервиса, а не два. Монорепозиторий ставит зависимости общим
# деревом (pnpm workspaces), кабинет импортирует @apistend/ui и @apistend/shared
# как исходники, а API держит каталог методов из packages/mock-engine. Разделять
# это на два образа значило бы дважды ставить одно и то же дерево; отличаются
# сервисы только командой запуска.
#
# Стадий три: deps (только зависимости — слой переживает правку кода),
# build (генерация клиента Prisma и сборка кабинета) и runtime.

# ─────────────────────────── deps ───────────────────────────
FROM node:26-bookworm-slim AS deps
WORKDIR /app

# openssl нужен клиенту Prisma в рантайме; python3 и g++ — сборке argon2,
# если под эту версию Node нет готового бинарника.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# corepack из образов Node убрали, поэтому ставим pnpm явно и той же версией,
# что стоит в packageManager корневого package.json.
ARG PNPM_VERSION=10.33.4
RUN npm install -g "pnpm@$PNPM_VERSION"

# Сначала только манифесты: слой с установленными зависимостями не будет
# пересобираться из-за правки в исходниках.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/mock-engine/package.json packages/mock-engine/
COPY packages/catalog-ingest/package.json packages/catalog-ingest/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

# Схема Prisma нужна уже здесь: у apps/api есть postinstall с prisma generate,
# и без схемы установка падает. Каталог маленький, а его изменение и так обязано
# заново генерировать клиент — инвалидация слоя здесь правильная.
COPY apps/api/prisma apps/api/prisma

# --prod=false обязателен: при NODE_ENV=production pnpm выбросил бы prisma
# и dotenv, а dotenv импортируется в рантайме (apps/api/src/env.ts).
RUN pnpm install --frozen-lockfile --prod=false

# ─────────────────────────── build ──────────────────────────
FROM deps AS build
WORKDIR /app

COPY . .

# Клиент Prisma генерируется под платформу образа, а не хостовую.
#
# DATABASE_URL здесь — заглушка: prisma.config.ts требует переменную, но
# generate к базе не подключается. Настоящий адрес приходит из compose
# в рантайме.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    pnpm --filter @apistend/api exec prisma generate

# Адрес API попадает в клиентский код на этапе сборки. По умолчанию — тот,
# по которому его видит браузер с машины разработчика (порт опубликован наружу).
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @apistend/web run build

# ────────────────────────── runtime ─────────────────────────
FROM node:26-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ARG PNPM_VERSION=10.33.4
RUN npm install -g "pnpm@$PNPM_VERSION"

ENV NODE_ENV=production

# Дерево целиком, вместе с node_modules и .next: кабинет собран без standalone,
# а API работает прямо с TypeScript-исходников (node --experimental-strip-types),
# как и на боевом сервере.
COPY --from=build /app /app

COPY deploy/docker-entrypoint.sh /usr/local/bin/apistend-entrypoint
RUN chmod +x /usr/local/bin/apistend-entrypoint

# Пользователь node есть в базовом образе; под root сервисы не запускаем.
RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/local/bin/apistend-entrypoint"]
