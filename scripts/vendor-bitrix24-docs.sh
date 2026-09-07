#!/usr/bin/env bash
# Вендорим документацию Bitrix24 REST API.
#
# У Bitrix24 нет OpenAPI. Официальный источник — репозиторий документации
# github.com/bitrix24/b24restdocs под MIT: единственный из трёх сервисов,
# где условия использования заявлены явно.
#
# 25 МБ архива и 84 МБ распакованного markdown в репозиторий не кладём: качаем
# в .cache (он в .gitignore) и фиксируем sha256 в specs/bitrix24/SOURCE.json.
# В git попадает только собранный каталог.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache"
OUT="$ROOT/specs/bitrix24"
mkdir -p "$CACHE" "$OUT"

URL="https://codeload.github.com/bitrix24/b24restdocs/tar.gz/refs/heads/main"

echo "  ↓ b24restdocs.tar.gz"
curl -sSfL "$URL" -o "$CACHE/b24restdocs.tar.gz"

sha=$(shasum -a 256 "$CACHE/b24restdocs.tar.gz" | cut -d' ' -f1)
bytes=$(wc -c < "$CACHE/b24restdocs.tar.gz" | tr -d ' ')

rm -rf "$CACHE/b24restdocs"
mkdir -p "$CACHE/b24restdocs"
tar xzf "$CACHE/b24restdocs.tar.gz" -C "$CACHE/b24restdocs" --strip-components=1

files=$(find "$CACHE/b24restdocs/api-reference" -name '*.md' | wc -l | tr -d ' ')

cat > "$OUT/SOURCE.json" <<JSON
{
  "service": "bitrix24",
  "sourceUrl": "https://github.com/bitrix24/b24restdocs",
  "docsUrl": "https://apidocs.bitrix24.com/",
  "license": "MIT",
  "licenseHolder": "Copyright (c) 2024 Bitrix24",
  "snapshotDate": "$(date -u +%Y-%m-%d)",
  "tarballSha256": "$sha",
  "tarballBytes": $bytes,
  "markdownFiles": $files,
  "note": "OpenAPI у Bitrix24 нет. Документация разбирается парсером Diplodoc-YFM (packages/catalog-ingest/src/yfm.ts). Схемы ответа как типа в источнике нет ни у одного метода — ответы строятся из JSON-примеров документации.",
  "russianTexts": {
    "sourceUrl": "https://apidocs.bitrix24.ru/",
    "license": null,
    "note": "MIT-репозиторий b24restdocs существует только на английском: ветки ru у него нет, /ru/ на apidocs.bitrix24.com отдаёт 404. Русские формулировки (заголовок, описание, подписи параметров) берутся с apidocs.bitrix24.ru по тем же путям скриптом scripts/fetch-bitrix24-ru.mjs. Явной лицензии у этого хоста нет — как и у спецификаций Ozon и Wildberries. Структура методов (имена, типы, обязательность, примеры ответа) остаётся из MIT-источника."
  }
}
JSON

echo "  ✓ sha256 $sha"
echo "Готово: $files файлов документации, распаковано в $CACHE/b24restdocs"
