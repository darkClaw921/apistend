#!/usr/bin/env python3
"""
Подтверждение владения доменом для Let's Encrypt через DNS API Beget.

Зачем это вообще нужно. Wildcard-сертификат (*.apistend.ru) Let's Encrypt выдаёт
ТОЛЬКО по проверке dns-01: подтверждение через файл на сервере (http-01) для
маски поддоменов не принимается в принципе. Значит на время выпуска нужно
завести TXT-запись _acme-challenge.apistend.ru, а домен обслуживают
DNS-серверы Beget — отсюда обращение к их API.

Скрипт вызывается самим certbot: сначала как auth (завести запись), потом как
cleanup (убрать). Что делать, он определяет по имени, под которым его позвали,
либо по первому аргументу — так один файл заменяет два.

Две вещи, из-за которых наивная реализация не работает:

1. Выпуск на apistend.ru И *.apistend.ru требует ДВУХ разных TXT-записей
   с ОДНИМ именем _acme-challenge.apistend.ru. certbot зовёт hook по разу
   на каждый домен, а метод changeRecords у Beget не добавляет запись,
   а ЗАМЕНЯЕТ весь набор записей этого имени. Вторая запись затирала бы первую,
   и проверка первого домена падала бы. Поэтому значения копятся в файле
   состояния и отправляются полным списком.

2. Изменения DNS расходятся не мгновенно. После записи скрипт ждёт, пока
   значение не начнёт отдавать сам авторитативный сервер зоны, и только потом
   возвращает управление certbot. Без ожидания проверка срабатывает раньше
   раздачи записи — и не каждый раз, а через раз, что хуже стабильного отказа.

Учётные данные берутся из /etc/apistend/beget.env (BEGET_LOGIN и BEGET_PASSWORD)
либо из окружения. В самом репозитории их нет и быть не должно.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

API = "https://api.beget.com/api"
STATE_DIR = "/run/apistend-acme"
PROPAGATION_TIMEOUT = 300
PROPAGATION_STEP = 10


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"beget-dns-hook: {message}", file=sys.stderr)
    sys.exit(1)


def credentials() -> tuple[str, str]:
    login = os.environ.get("BEGET_LOGIN")
    password = os.environ.get("BEGET_PASSWORD")

    env_file = os.environ.get("BEGET_ENV_FILE", "/etc/apistend/beget.env")
    if (not login or not password) and os.path.exists(env_file):
        with open(env_file, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                value = value.strip().strip('"').strip("'")
                if name.strip() == "BEGET_LOGIN" and not login:
                    login = value
                if name.strip() == "BEGET_PASSWORD" and not password:
                    password = value

    if not login or not password:
        fail(
            f"нет учётных данных API Beget. Положите их в {env_file} "
            "двумя строками: BEGET_LOGIN=… и BEGET_PASSWORD=… (права 0600, владелец root)"
        )
    return login, password


def api_call(method: str, payload: dict) -> dict:
    login, password = credentials()
    query = urllib.parse.urlencode(
        {
            "login": login,
            "passwd": password,
            "input_format": "json",
            "output_format": "json",
            "input_data": json.dumps(payload, ensure_ascii=False),
        }
    )
    request = urllib.request.Request(f"{API}/{method}?{query}", method="GET")
    with urllib.request.urlopen(request, timeout=60) as response:
        body = json.loads(response.read().decode("utf-8"))

    # У Beget два уровня статуса: транспортный и прикладной. Ошибка приходит
    # с кодом 200, поэтому проверять надо оба, иначе отказ выглядит успехом.
    if body.get("status") != "success":
        fail(f"{method}: {body.get('error_text') or body}")
    answer = body.get("answer", {})
    if isinstance(answer, dict) and answer.get("status") != "success":
        fail(f"{method}: {answer.get('errors') or answer}")
    return answer.get("result", {}) if isinstance(answer, dict) else {}


def state_path(fqdn: str) -> str:
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    return os.path.join(STATE_DIR, f"{fqdn}.json")


def read_state(fqdn: str) -> list[str]:
    path = state_path(fqdn)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_state(fqdn: str, values: list[str]) -> None:
    path = state_path(fqdn)
    if values:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(values, handle)
        os.chmod(path, 0o600)
    elif os.path.exists(path):
        os.remove(path)


def put_txt(fqdn: str, values: list[str]) -> None:
    """
    Полный набор TXT-записей имени. Пустой список стирает запись целиком:
    отдельного метода удаления у Beget нет, и это не оплошность API,
    а его модель — набор записей задаётся целиком.
    """
    records = {"TXT": [{"priority": 10, "value": value} for value in values]}
    api_call("dns/changeRecords", {"fqdn": fqdn, "records": records})


def authoritative_servers(zone: str) -> list[str]:
    try:
        out = subprocess.run(
            ["dig", "+short", "NS", zone], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.strip().rstrip(".") for line in out.splitlines() if line.strip()]


def wait_for_propagation(fqdn: str, value: str, zone: str) -> None:
    """
    Ждём, пока значение начнёт отдавать авторитативный сервер зоны.

    Спрашиваем именно его, а не общедоступный резолвер: у резолвера в кеше
    может лежать отрицательный ответ, и ожидание растянулось бы на TTL впустую,
    тогда как Let's Encrypt всё равно идёт к авторитативному.
    """
    servers = authoritative_servers(zone)
    if not servers:
        print("beget-dns-hook: NS зоны не определились, жду фиксированные 60 с")
        time.sleep(60)
        return

    deadline = time.time() + PROPAGATION_TIMEOUT
    while time.time() < deadline:
        seen = True
        for server in servers:
            try:
                out = subprocess.run(
                    ["dig", "+short", f"@{server}", "TXT", fqdn],
                    capture_output=True,
                    text=True,
                    timeout=30,
                ).stdout
            except (OSError, subprocess.SubprocessError):
                seen = False
                break
            if value not in out:
                seen = False
                break
        if seen:
            # Небольшой запас: Let's Encrypt опрашивает несколько своих точек,
            # и они могут прийти к серверу чуть позже нас.
            time.sleep(5)
            return
        time.sleep(PROPAGATION_STEP)

    fail(f"запись {fqdn} не разошлась по серверам зоны за {PROPAGATION_TIMEOUT} с")


def main() -> None:
    domain = os.environ.get("CERTBOT_DOMAIN")
    validation = os.environ.get("CERTBOT_VALIDATION")
    if not domain or not validation:
        fail("скрипт вызывается самим certbot: нужны CERTBOT_DOMAIN и CERTBOT_VALIDATION")

    mode = sys.argv[1] if len(sys.argv) > 1 else ("cleanup" if "cleanup" in sys.argv[0] else "auth")
    # Для *.example.ru certbot передаёт CERTBOT_DOMAIN без звёздочки, но подстраховаться дёшево.
    zone = domain.lstrip("*.")
    fqdn = f"_acme-challenge.{zone}"

    values = read_state(fqdn)

    if mode == "auth":
        if validation not in values:
            values.append(validation)
        put_txt(fqdn, values)
        write_state(fqdn, values)
        print(f"beget-dns-hook: {fqdn} → {len(values)} TXT, жду распространения")
        wait_for_propagation(fqdn, validation, zone)
        return

    if mode == "cleanup":
        values = [value for value in values if value != validation]
        put_txt(fqdn, values)
        write_state(fqdn, values)
        print(f"beget-dns-hook: {fqdn} очищен, осталось записей: {len(values)}")
        return

    fail(f"неизвестный режим «{mode}», ожидались auth или cleanup")


if __name__ == "__main__":
    main()
