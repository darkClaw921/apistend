/**
 * Проверка токена npm ПЕРЕД публикацией.
 *
 * Без неё провал вылезает уже после того, как provenance подписан и записан
 * в прозрачный журнал Sigstore: запись там остаётся навсегда, а пакета нет.
 *
 * Два типовых случая, которые ловим:
 * 1. Токен истёк или отозван — реестр отвечает 401 на /-/whoami.
 * 2. Granular-токен ограничен областью (например @user) и не может создать
 *    безобластной пакет: реестр отвечает 403 «You may not perform that action
 *    with these credentials» уже на попытке PUT.
 *
 * Запуск: node scripts/check-npm-token.mjs <имя-пакета>
 * Токен — в NPM_TOKEN.
 */

const REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const token = process.env.NPM_TOKEN
const pkg = process.argv[2]

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!token) fail('Не задан NPM_TOKEN')
if (!pkg) fail('Не передано имя пакета: node scripts/check-npm-token.mjs <пакет>')

const get = async (path) => {
  const res = await fetch(`${REGISTRY}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { status: res.status, body: null }
  return { status: res.status, body: await res.json() }
}

const who = await get('/-/whoami')
if (who.status === 401) fail('Токен не принят реестром: истёк или отозван')
if (!who.body?.username) fail(`Реестр ответил ${who.status} на /-/whoami`)
process.stdout.write(`Аккаунт: ${who.body.username}\n`)

const tokens = await get('/-/npm/v1/tokens')
if (!tokens.body?.objects) {
  // Список токенов доступен не всякому токену — это не повод останавливать релиз.
  process.stdout.write('Область токена проверить не удалось, продолжаю\n')
  process.exit(0)
}

// Свой токен опознаём по хвосту: реестр отдаёт его маской вида «npm_Q87x...uRc2».
const tail = token.slice(-4)
const mine = tokens.body.objects.filter((t) => String(t.token ?? '').endsWith(tail))
const covers = (scope) => pkg === scope || pkg.startsWith(`${scope}/`)

for (const t of mine) {
  const named = (t.scopes ?? []).map((s) => s.name).filter(Boolean)
  if (named.length > 0 && !named.some(covers)) {
    fail(
      `Токен «${t.name}» ограничен областями ${named.join(', ')} и не покрывает пакет ${pkg}.\n` +
      'На npmjs.com откройте токен и выберите «All packages», иначе реестр вернёт 403.',
    )
  }
  if (t.expiry && new Date(t.expiry) < new Date()) {
    fail(`Токен «${t.name}» истёк ${t.expiry}`)
  }
}

process.stdout.write(`Токен покрывает ${pkg}\n`)
