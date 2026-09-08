#!/bin/sh
# Точка входа контейнера APIStend.
#
# Один образ обслуживает два сервиса, роль выбирается аргументом: api или web.
# Миграции и сид накатывает только api — двум контейнерам одновременно делать
# это на одной базе незачем, а web без базы обходится вовсе.
set -e

role="${1:-api}"

case "$role" in
  api)
    # migrate deploy идемпотентна: применяет только неприменённое.
    pnpm --filter @apistend/api exec prisma migrate deploy

    # Сид — только на пустой базе. Иначе перезапуск контейнера затирал бы
    # демо-аккаунт вместе с тем, что в нём успели наделать.
    if [ "${APISTEND_SEED:-1}" = "1" ]; then
      node --experimental-strip-types apps/api/prisma/seed-if-empty.ts
    fi

    exec node --experimental-strip-types apps/api/src/server.ts
    ;;

  web)
    # next start, а не dev: образ собран, пересборка в рантайме не нужна.
    exec pnpm --filter @apistend/web exec next start --port "${WEB_PORT:-3100}" --hostname 0.0.0.0
    ;;

  *)
    echo "apistend-entrypoint: неизвестная роль «$role», ожидались api или web" >&2
    exit 64
    ;;
esac
