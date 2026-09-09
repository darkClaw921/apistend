#!/usr/bin/env bash
#
# Подтверждение владения доменом для Let's Encrypt через собственный acme-dns.
#
# Второй способ выпустить wildcard, помимо ключа от API регистратора
# (deploy/beget-dns-hook.py). Разница в том, что здесь у нас вообще нет доступа
# к основной зоне: в панели регистратора один раз добавляется CNAME
#
#   _acme-challenge.apistend.ru → <поддомен>.auth.apistend.ru
#
# и дальше проверка ходит по этой ссылке в нашу собственную служебную зону,
# которую обслуживает acme-dns на этом же сервере. Пароль регистратора при этом
# нигде не хранится, а продление работает само: certbot зовёт этот скрипт
# при каждом обновлении.
#
# Тонкость, из-за которой схема вообще работает: проверяющий идёт по CNAME
# до конца, и TXT-запись ему отдаёт acme-dns. Поэтому обе половины выпуска —
# и apistend.ru, и *.apistend.ru — обслуживаются одной ссылкой: acme-dns хранит
# до двух значений на поддомен, ровно столько, сколько нужно такому выпуску.
#
# Учётные данные лежат в /etc/apistend/acme-dns.json — их выдаёт сам acme-dns
# при регистрации, это не пароль человека и не доступ к домену.
set -euo pipefail

CREDS="${ACME_DNS_CREDS:-/etc/apistend/acme-dns.json}"
API="${ACME_DNS_API:-http://127.0.0.1:8081}"

die() { echo "acme-dns-hook: $*" >&2; exit 1; }

[ -f "$CREDS" ] || die "нет $CREDS — сначала зарегистрируйте поддомен: curl -s -X POST $API/register"
[ -n "${CERTBOT_VALIDATION:-}" ] || die "скрипт вызывается самим certbot: нужна переменная CERTBOT_VALIDATION"

read -r user key subdomain < <(
  python3 - "$CREDS" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    data = json.load(handle)
print(data['username'], data['password'], data['subdomain'])
PY
)

case "${1:-auth}" in
  auth)
    # Очистки как таковой у acme-dns нет: он хранит два последних значения
    # и вытесняет старое сам. Отдельный cleanup поэтому ничего не делает —
    # и это правильно: удалять запись между двумя проверками одного выпуска
    # означало бы уронить вторую половину.
    response=$(curl -s -X POST "$API/update" \
      -H "X-Api-User: $user" \
      -H "X-Api-Key: $key" \
      -d "{\"subdomain\": \"$subdomain\", \"txt\": \"$CERTBOT_VALIDATION\"}")
    echo "acme-dns-hook: $response"
    case "$response" in
      *txt*) ;;
      *) die "acme-dns не принял запись: $response" ;;
    esac

    # Ждём, пока значение начнёт отдавать сам acme-dns через публичную цепочку:
    # проверяющий пойдёт тем же путём, и опережать его нельзя.
    for _ in $(seq 1 30); do
      if dig +short TXT "_acme-challenge.${CERTBOT_DOMAIN#\*.}" | grep -qF "$CERTBOT_VALIDATION"; then
        sleep 5
        exit 0
      fi
      sleep 10
    done
    die "запись не разошлась за 5 минут — проверьте CNAME _acme-challenge.${CERTBOT_DOMAIN#\*.}"
    ;;

  cleanup)
    exit 0
    ;;

  *)
    die "неизвестный режим «$1», ожидались auth или cleanup"
    ;;
esac
