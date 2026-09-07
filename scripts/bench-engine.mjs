/** Пропускная способность движка моков без HTTP и без БД. */
import { MockEngine } from '../packages/mock-engine/src/index.ts'

const engine = MockEngine.load(['wildberries'])
const methods = engine.catalog('wildberries')
const bySource = { example: [], schema: [], generic: [] }
for (const m of methods) (bySource[m.responseSource] ??= []).push(m)

const NOW = new Date('2026-09-07T12:00:00Z')
const mk = (m) => ({
  service: 'wildberries', httpMethod: m.httpMethod,
  path: m.path.replace(/\{[^}]+\}/g, '777'), query: {}, headers: {}, body: null,
  requestId: 'req_bench', scenario: 'success', now: NOW, salt: 'sandbox-01',
})

function bench(label, list, iterations) {
  if (list.length === 0) return
  const reqs = list.map(mk)
  // прогрев
  for (let i = 0; i < 200; i++) engine.handle(reqs[i % reqs.length])
  const t0 = process.hrtime.bigint()
  let bytes = 0
  for (let i = 0; i < iterations; i++) {
    const r = engine.handle(reqs[i % reqs.length])
    bytes += JSON.stringify(r.body ?? null).length
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(
    `  ${label.padEnd(9)} ${String(list.length).padStart(4)} методов  ` +
    `${(iterations / (ms / 1000)).toFixed(0).padStart(8)} оп/с  ` +
    `${(ms / iterations).toFixed(3).padStart(7)} мс/оп  ` +
    `средний ответ ${(bytes / iterations / 1024).toFixed(1)} КБ`,
  )
}

console.log(`\nДвижок моков: ${methods.length} методов Wildberries\n`)
bench('example', bySource.example, 20_000)
bench('schema', bySource.schema, 20_000)
bench('generic', bySource.generic, 20_000)
bench('всё', methods, 20_000)
console.log()
