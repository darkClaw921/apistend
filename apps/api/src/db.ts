import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from './env.ts'

/**
 * Подключение к базе.
 *
 * Prisma 7: соединение идёт через драйвер-адаптер, а не через url в схеме.
 *
 * Размер пула. Под высоким RPS соблазн поставить его побольше, но это ошибка:
 * PostgreSQL держит процесс на каждое соединение, и сотня коннектов с одного
 * инстанса деградирует базу, а не ускоряет приложение. Горячий путь мок-шлюза
 * до базы вообще не доходит (ключи в LRU, логи пачками), поэтому пула
 * из десятка соединений хватает; при нескольких инстансах общее число
 * коннектов = pool × instances, и это надо держать в уме при масштабировании.
 */
const adapter = new PrismaPg({
  connectionString: env.databaseUrl,
  max: env.dbPoolSize,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

export const prisma = new PrismaClient({
  adapter,
  log: ['warn', 'error'],
})

export type { Prisma } from '@prisma/client'
