/**
 * Замер пропускной способности мок-шлюза.
 *
 * Ключей должно быть много: лимиты в моке считаются на ключ (эмуляция боевого API),
 * поэтому одним ключом измеряется не шлюз, а лимитер.
 *
 * Запуск: node scripts/loadtest.mjs <файл-с-ключами> <файл-с-путями> [сек] [параллельность]
 */
import { readFileSync } from 'node:fs'
import { Agent, request } from 'node:http'

const keys = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
const paths = readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean)
const DURATION_MS = Number(process.argv[4] ?? 10) * 1000
const CONCURRENCY = Number(process.argv[5] ?? 100)

if (keys.length === 0 || paths.length === 0) { console.error('пустые ключи или пути'); process.exit(1) }

// keep-alive обязателен: без него меряется скорость установки TCP-соединений
const agent = new Agent({ keepAlive: true, maxSockets: CONCURRENCY + 10 })

const latencies = []
let done = 0, errors = 0, bytes = 0
const codes = new Map()
const stopAt = Date.now() + DURATION_MS

function once(path, key) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const req = request(
      { host: '127.0.0.1', port: 8080, path, method: 'GET', agent,
        headers: { authorization: key, 'x-mock-delay': '0' } },
      (res) => {
        let size = 0
        res.on('data', (c) => { size += c.length })
        res.on('end', () => {
          latencies.push(Number(process.hrtime.bigint() - t0) / 1e6)
          codes.set(res.statusCode, (codes.get(res.statusCode) ?? 0) + 1)
          bytes += size; done++; resolve()
        })
      },
    )
    req.on('error', () => { errors++; resolve() })
    req.end()
  })
}

async function worker(i) {
  let n = i
  while (Date.now() < stopAt) {
    await once(paths[n % paths.length], keys[(n + i) % keys.length])
    n++
  }
}

const started = Date.now()
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
const elapsed = (Date.now() - started) / 1000
agent.destroy()

latencies.sort((a, b) => a - b)
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]?.toFixed(1) ?? '—'
const ok = [...codes].filter(([c]) => c < 400).reduce((n, [, v]) => n + v, 0)

console.log(`
  ключей / путей : ${keys.length} / ${paths.length}
  параллельность : ${CONCURRENCY}
  длительность   : ${elapsed.toFixed(1)} с
  запросов       : ${done}   ошибок транспорта: ${errors}
  RPS            : ${(done / elapsed).toFixed(0)}
  успешных       : ${((ok / done) * 100).toFixed(1)} %
  задержка p50   : ${pct(0.5)} мс
  задержка p95   : ${pct(0.95)} мс
  задержка p99   : ${pct(0.99)} мс
  трафик         : ${(bytes / 1024 / 1024 / elapsed).toFixed(1)} МБ/с
  коды           : ${[...codes].sort((a,b)=>a[0]-b[0]).map(([c, n]) => `${c}:${n}`).join(' ')}
`)
