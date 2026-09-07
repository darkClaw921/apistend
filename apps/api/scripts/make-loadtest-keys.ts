/**
 * Создаёт N ключей для нагрузочного теста — имитация многих пользователей.
 * Лимиты в моке считаются на ключ, поэтому одним ключом потолок шлюза не измерить.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../../.env'), quiet: true })

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })
const hash = (k: string) => createHmac('sha256', process.env.JWT_SECRET!).update(k).digest('hex')

const count = Number(process.argv[2] ?? 40)
const sandbox = await prisma.sandbox.findFirst({ orderBy: { createdAt: 'asc' } })
if (!sandbox) throw new Error('нет песочницы — сначала pnpm db:seed')

await prisma.apiKey.deleteMany({ where: { sandboxId: sandbox.id, name: { startsWith: 'loadtest-' } } })

const keys: string[] = []
for (let i = 0; i < count; i++) {
  const body = randomBytes(16).toString('hex')
  const full = `stend_sbx_${body}`
  keys.push(full)
  await prisma.apiKey.create({
    data: {
      sandboxId: sandbox.id, name: `loadtest-${i}`, kind: 'sandbox',
      prefix: `stend_sbx_${body.slice(0, 4)}`, suffix: body.slice(-4), keyHash: hash(full),
      services: ['bitrix24', 'ozon', 'wildberries'],
    },
  })
}
process.stdout.write(keys.join('\n') + '\n')
await prisma.$disconnect()
