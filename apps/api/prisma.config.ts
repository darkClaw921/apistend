import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { defineConfig, env } from 'prisma/config'

// .env лежит в корне монорепозитория — CLI Prisma запускается из apps/api,
// поэтому путь задаём явно, а не полагаемся на автоподхват.
const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../.env'), quiet: true })

/**
 * Prisma 7: адрес базы задаётся здесь, а не в schema.prisma.
 * Рантайм подключается через драйвер-адаптер @prisma/adapter-pg (см. src/db.ts).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
})
