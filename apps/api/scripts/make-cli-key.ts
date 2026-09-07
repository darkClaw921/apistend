/** Создаёт серверный ключ stend_sk_ для CLI и печатает его. Только для разработки. */
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../../.env'), quiet: true })

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })
const name = process.argv[2] ?? 'CLI · локальная доставка'

const sandbox = await prisma.sandbox.findFirst({ orderBy: { createdAt: 'asc' } })
if (!sandbox) throw new Error('нет песочницы — сначала pnpm db:seed')

const body = randomBytes(16).toString('hex')
const full = `stend_sk_${body}`
await prisma.apiKey.deleteMany({ where: { sandboxId: sandbox.id, name } })
await prisma.apiKey.create({
  data: {
    sandboxId: sandbox.id, name, subtitle: 'apistend listen', kind: 'server',
    prefix: `stend_sk_${body.slice(0, 4)}`, suffix: body.slice(-4),
    keyHash: createHmac('sha256', process.env.JWT_SECRET!).update(full).digest('hex'),
    services: ['bitrix24', 'ozon', 'wildberries'],
  },
})
process.stdout.write(`${full}\n`)
await prisma.$disconnect()
