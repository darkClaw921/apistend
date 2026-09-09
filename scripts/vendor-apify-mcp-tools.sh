#!/usr/bin/env bash
# Снимаем описания инструментов боевого MCP-сервера Apify.
#
# Зачем вендорить, а не писать руками: имя, схема входа и схема выхода —
# это интерфейс, по которому клиент проверяет ответ; переписанные «близко к тексту»
# они перестанут быть тем же интерфейсом. Снимаем ровно то, что отдаёт mcp.apify.com,
# и фиксируем дату и sha256 — так же, как поступаем с OpenAPI.
#
# Без токена Apify отдаёт только четыре инструмента поиска и документации.
# С токеном — полный набор по умолчанию, включая call-actor и работу с хранилищами;
# именно его и стоит снимать. Токен берётся ТОЛЬКО из переменной окружения
# APIFY_TOKEN и никуда не записывается: ни в снимок, ни в манифест, ни в лог.
#
#   APIFY_TOKEN=… ./scripts/vendor-apify-mcp-tools.sh
set -euo pipefail

if [ -n "${APIFY_TOKEN:-}" ]; then
  TOOLS='(полный набор по токену)'
  URL='https://mcp.apify.com'
  AUTH=(-H "Authorization: Bearer $APIFY_TOKEN")
else
  echo "APIFY_TOKEN не задан — снимаю анонимный набор из четырёх инструментов." >&2
  TOOLS='search-actors,fetch-actor-details,search-apify-docs,fetch-apify-docs'
  URL="https://mcp.apify.com?tools=$TOOLS"
  AUTH=()
fi
OUT="$(cd "$(dirname "$0")/.." && pwd)/specs/apify"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

hello='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"apistend-vendor","version":"1.0.0"}}}'

echo "  ↔ initialize"
curl -sSfL -D "$TMP/hdr" -o "$TMP/init" -X POST "$URL" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$hello"

session=$(grep -i '^mcp-session-id:' "$TMP/hdr" | tr -d '\r' | cut -d' ' -f2)
[ -n "$session" ] || { echo "не выдан mcp-session-id" >&2; exit 1; }

curl -sSfL -o /dev/null -X POST "$URL" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $session" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

echo "  ↓ tools/list"
curl -sSfL -o "$TMP/tools" -X POST "$URL" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $session" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

node -e "
const fs = require('node:fs')

// Ответ приходит кадром SSE: строка event, строка id, строка data.
const frame = (file) => {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('data: '))
  if (!line) throw new Error('в ответе нет кадра data: ' + file)
  return JSON.parse(line.slice(6))
}

const init = frame('$TMP/init').result
const tools = frame('$TMP/tools').result.tools

fs.writeFileSync('$OUT/mcp-tools.json', JSON.stringify({
  capturedAt: new Date().toISOString(),
  sourceUrl: 'https://mcp.apify.com',
  toolsQuery: '$TOOLS',
  note: '$TOOLS' === '(полный набор по токену)'
    ? 'Полный набор по умолчанию, снятый по токену. Без токена mcp.apify.com отдаёт только четыре инструмента поиска и документации.'
    : 'Анонимный набор: остальные инструменты mcp.apify.com отдаёт только по токену.',
  protocolVersion: init.protocolVersion,
  serverInfo: init.serverInfo,
  capabilities: init.capabilities,
  instructions: init.instructions,
  tools,
}, null, 2) + '\n')

process.stdout.write('  инструментов: ' + tools.length + ', протокол ' + init.protocolVersion +
  ', сервер ' + init.serverInfo.name + ' ' + init.serverInfo.version + '\n')
"

sha=$(shasum -a 256 "$OUT/mcp-tools.json" | cut -d' ' -f1)
printf 'mcp-tools.json\t%s\t%s\n' "$sha" "$(wc -c < "$OUT/mcp-tools.json" | tr -d ' ')" >> "$OUT/MANIFEST.tsv"

echo "Готово: $OUT/mcp-tools.json"
