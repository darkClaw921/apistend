#!/usr/bin/env bash
# Вендорим OpenAPI Ozon Seller API.
#
# Официальный docs.ozon.ru/api/seller/swagger.json закрыт JS-антиботом: обычный HTTP-клиент
# получает петлю редиректов ?__rr=N, затем 403 и HTML-страницу челленджа. Поэтому берём
# зеркало PCDCK/ozon-mcp и сверяем sha256 с манифестом, который зеркало публикует рядом.
#
# Зеркало отстаёт от живой спеки: 420 методов против 467. Это отражено в поле snapshotDate
# и должно быть видно пользователю в каталоге — показывать 467, имея 420, нельзя.
set -euo pipefail

BASE="https://raw.githubusercontent.com/PCDCK/ozon-mcp/main/src/ozon_mcp/data"
OUT="$(cd "$(dirname "$0")/.." && pwd)/specs/ozon"
mkdir -p "$OUT"

echo "  ↓ swagger_meta.json"
curl -sSfL "$BASE/swagger_meta.json" -o "$OUT/MIRROR_META.json"

echo "  ↓ seller_swagger.json"
curl -sSfL "$BASE/seller_swagger.json" -o "$OUT/seller.json"

expected=$(python3 -c "import json;print(json.load(open('$OUT/MIRROR_META.json'))['seller']['sha256'])")
actual=$(shasum -a 256 "$OUT/seller.json" | cut -d' ' -f1)
if [ "$expected" != "$actual" ]; then
  echo "ОШИБКА: sha256 не совпал с манифестом зеркала" >&2
  echo "  ожидали: $expected" >&2
  echo "  получили: $actual" >&2
  exit 1
fi
echo "  ✓ sha256 совпал с манифестом зеркала"

refreshed=$(python3 -c "import json;print(json.load(open('$OUT/MIRROR_META.json'))['refreshed_at'][:10])")
count=$(python3 -c "import json;print(json.load(open('$OUT/MIRROR_META.json'))['seller']['method_count'])")

cat > "$OUT/SOURCE.json" <<JSON
{
  "service": "ozon",
  "sourceUrl": "https://docs.ozon.ru/api/seller/",
  "mirrorUrl": "https://github.com/PCDCK/ozon-mcp",
  "mirrorLicense": "MIT",
  "specLicense": null,
  "snapshotDate": "$refreshed",
  "mirrorMethodCount": $count,
  "liveMethodCount": 467,
  "note": "Официальный docs.ozon.ru закрыт JS-антиботом. Зеркало отстаёт от живой спеки: $count методов против 467 живых. Разница закрывается браузерным воркером — задача вне критического пути."
}
JSON

echo "Готово: $count методов, снимок $refreshed, $OUT"
