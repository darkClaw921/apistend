#!/usr/bin/env bash
# Вендорим OpenAPI Wildberries.
#
# Официальный dev.wildberries.ru отдаёт 498 (антибот) и HTTP-клиентам недоступен,
# поэтому берём зеркало eslazarev/wildberries-sdk (MIT, обновляется кроном ежедневно).
# Фиксируем sha256 и дату снимка: каталог обязан честно показывать, чем он наполнен.
#
# 05-orders-dbs.yaml НЕ берём — это дубль 05-dbs.yaml (проверено: те же 20 операций).
set -euo pipefail

BASE="https://raw.githubusercontent.com/eslazarev/wildberries-sdk/main/specs"
OUT="$(cd "$(dirname "$0")/.." && pwd)/specs/wildberries"
mkdir -p "$OUT"

FILES=(
  01-general 02-items 03-orders-fbs 04-orders-dbw 05-dbs
  06-in-store-pickup 07-orders-fbw 08-promotion 09-communications
  10-rates 11-analytics 12-reports 13-finances 14-wbd
)

: > "$OUT/MANIFEST.tsv"
printf 'file\tsha256\tbytes\n' >> "$OUT/MANIFEST.tsv"

for f in "${FILES[@]}"; do
  echo "  ↓ $f.yaml"
  curl -sSfL "$BASE/$f.yaml" -o "$OUT/$f.yaml"
  sha=$(shasum -a 256 "$OUT/$f.yaml" | cut -d' ' -f1)
  bytes=$(wc -c < "$OUT/$f.yaml" | tr -d ' ')
  printf '%s\t%s\t%s\n' "$f.yaml" "$sha" "$bytes" >> "$OUT/MANIFEST.tsv"
done

cat > "$OUT/SOURCE.json" <<JSON
{
  "service": "wildberries",
  "sourceUrl": "https://dev.wildberries.ru/api/swagger/yaml/ru/",
  "mirrorUrl": "https://github.com/eslazarev/wildberries-sdk/tree/main/specs",
  "mirrorLicense": "MIT",
  "specLicense": null,
  "snapshotDate": "$(date -u +%Y-%m-%d)",
  "note": "Официальный dev.wildberries.ru отдаёт HTTP 498 (антибот). Зеркало обновляется ежедневно кроном. Файл 05-orders-dbs.yaml исключён как дубль 05-dbs.yaml."
}
JSON

echo "Готово: $(ls -1 "$OUT"/*.yaml | wc -l | tr -d ' ') файлов в $OUT"
