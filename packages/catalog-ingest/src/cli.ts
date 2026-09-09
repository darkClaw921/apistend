/**
 * Сборка каталога: спецификации -> JSON для движка моков.
 *
 * Запуск: pnpm ingest [сервис...]
 * YAML в рантайме не парсим — разница на этих объёмах примерно пятидесятикратная.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogBundle } from '@apistend/shared'
import type { OpenApiDoc } from './openapi.ts'
import { ingestWildberries } from './wildberries.ts'
import { ingestOzon } from './ozon.ts'
import { ingestBitrix24 } from './bitrix24.ts'
import { ingestApify } from './apify.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const outDir = join(repoRoot, 'packages/mock-engine/generated')

interface Ingestor {
  code: string
  title: string
  run: () => { bundle: CatalogBundle; mergedSpec: OpenApiDoc; warnings: string[] }
}

const INGESTORS: Ingestor[] = [
  {
    code: 'wildberries',
    title: 'Wildberries',
    run: () => ingestWildberries(join(repoRoot, 'specs/wildberries')),
  },
  {
    code: 'ozon',
    title: 'Ozon Seller API',
    run: () => ingestOzon(join(repoRoot, 'specs/ozon')),
  },
  {
    code: 'apify',
    title: 'Apify API v2',
    run: () => ingestApify(join(repoRoot, 'specs/apify')),
  },
  {
    code: 'bitrix24',
    title: 'Bitrix24 REST API',
    run: () => {
      // Спека распакована в .cache: 84 МБ markdown в репозиторий не кладём.
      // Русские формулировки — отдельным оверлеем: MIT-репозиторий только английский.
      const result = ingestBitrix24(join(repoRoot, '.cache/b24restdocs'), {
        ruOverlayPath: join(repoRoot, '.cache/b24ru/pages.json'),
        ruOverridesPath: join(repoRoot, 'specs/bitrix24/ru-overrides.json'),
      })
      return { bundle: result.bundle, mergedSpec: {}, warnings: result.warnings }
    },
  },
]

const requested = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')))
const wanted = (name: string) => requested.size === 0 || requested.has(name)

mkdirSync(outDir, { recursive: true })

const out = (line = '') => process.stdout.write(`${line}\n`)
let totalMethods = 0

for (const ingestor of INGESTORS) {
  if (!wanted(ingestor.code)) continue

  out(`${ingestor.title}: разбираю спецификации…`)
  let result: ReturnType<Ingestor['run']>
  try {
    result = ingestor.run()
  } catch (error) {
    out(`  ✗ пропущен: ${(error as Error).message}`)
    out()
    continue
  }

  const { bundle, mergedSpec, warnings } = result
  writeFileSync(join(outDir, `${ingestor.code}.catalog.json`), JSON.stringify(bundle))
  writeFileSync(join(outDir, `${ingestor.code}.spec.json`), JSON.stringify(mergedSpec))

  const byGroup = new Map<string, number>()
  const bySource = new Map<string, number>()
  for (const m of bundle.methods) {
    byGroup.set(m.group, (byGroup.get(m.group) ?? 0) + 1)
    bySource.set(m.responseSource, (bySource.get(m.responseSource) ?? 0) + 1)
  }

  out(`  методов: ${bundle.methods.length}, снимок ${bundle.snapshotDate}`)
  out('  по разделам:')
  for (const [g, n] of [...byGroup].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    out(`    ${String(n).padStart(4)}  ${g}`)
  }
  if (byGroup.size > 12) out(`    ${String(byGroup.size - 12).padStart(4)}  разделов не показано`)

  out('  источник ответа:')
  for (const [s, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    const pct = ((n / bundle.methods.length) * 100).toFixed(0)
    out(`    ${String(n).padStart(4)}  ${s.padEnd(8)} ${pct} %`)
  }

  if (warnings.length > 0) {
    out(`  предупреждений: ${warnings.length}`)
    for (const w of warnings.slice(0, 5)) out(`    ! ${w}`)
    if (warnings.length > 5) out(`    … и ещё ${warnings.length - 5}`)
  }
  out()
  totalMethods += bundle.methods.length
}

out(`Готово. Всего методов: ${totalMethods}`)
out(`Артефакты: ${outDir}`)
