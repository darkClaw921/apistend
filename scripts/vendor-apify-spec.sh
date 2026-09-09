#!/usr/bin/env bash
# Вендорим OpenAPI Apify.
#
# Единственный из четырёх сервисов, чью спецификацию отдаёт сам вендор,
# по прямой ссылке и без антибота: docs.apify.com/api/openapi.json.
# Ни зеркала, ни браузерного воркера здесь не нужно — extraction: 'spec'.
#
# info.version в спеке уже помечен датой сборки (v2-2026-09-02T154542Z);
# её же берём как дату снимка, а не «сегодня»: снимок датируется тем, когда
# его собрал Apify, а не тем, когда мы его скачали.
set -euo pipefail

SRC="https://docs.apify.com/api/openapi.json"
OUT="$(cd "$(dirname "$0")/.." && pwd)/specs/apify"
mkdir -p "$OUT"

echo "  ↓ openapi.json"
curl -sSfL "$SRC" -o "$OUT/openapi.json"

sha=$(shasum -a 256 "$OUT/openapi.json" | cut -d' ' -f1)
bytes=$(wc -c < "$OUT/openapi.json" | tr -d ' ')
version=$(node -e "process.stdout.write(require('$OUT/openapi.json').info.version)")
# Дата из версии спеки: v2-2026-09-02T154542Z -> 2026-09-02.
snapshot=$(printf '%s' "$version" | sed -E 's/^v2-([0-9]{4}-[0-9]{2}-[0-9]{2}).*$/\1/')
methods=$(node -e "
const s=require('$OUT/openapi.json');
let n=0;
for (const item of Object.values(s.paths||{}))
  for (const m of Object.keys(item))
    if (['get','post','put','patch','delete','head','options'].includes(m)) n++;
process.stdout.write(String(n));
")

printf 'file\tsha256\tbytes\n' > "$OUT/MANIFEST.tsv"
printf 'openapi.json\t%s\t%s\n' "$sha" "$bytes" >> "$OUT/MANIFEST.tsv"

cat > "$OUT/SOURCE.json" <<JSON
{
  "service": "apify",
  "sourceUrl": "https://docs.apify.com/api/v2",
  "specUrl": "$SRC",
  "specVersion": "$version",
  "specLicense": null,
  "snapshotDate": "$snapshot",
  "methodCount": $methods,
  "note": "Спецификацию публикует сам вендор по прямой ссылке, без антибота и зеркал: extraction = spec. Дата снимка взята из info.version самой спецификации, а не из даты скачивания."
}
JSON

echo "Готово: $methods операций, снимок $snapshot, $bytes байт в $OUT"
