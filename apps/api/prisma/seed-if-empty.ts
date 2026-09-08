/**
 * Сид, который отрабатывает только на пустой базе.
 *
 * Нужен контейнеру: `docker compose up` обязан давать рабочий стенд с первого
 * раза, но перезапуск контейнера не должен затирать демо-аккаунт вместе с тем,
 * что в нём успели наделать. Обычный `pnpm db:seed` пересоздаёт демо-аккаунт
 * всегда — это правильно, когда его зовут руками, и неправильно на каждом старте.
 *
 * Проверяем именно «нет ни одного пользователя», а не «нет демо-аккаунта»:
 * если демо-аккаунт удалили осознанно, возвращать его на следующем рестарте
 * ещё хуже, чем не насеять вовсе.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(here, '../../../.env'), quiet: true })

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

const users = await prisma.user.count()
await prisma.$disconnect()

if (users > 0) {
  process.stdout.write(`База не пуста (пользователей: ${users}) — сид пропущен\n`)
} else {
  // Импорт запускает сид: seed.ts вызывает main() на уровне модуля.
  await import('./seed.ts')
}
