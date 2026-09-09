import { prisma } from '../db.ts'

/**
 * Ретеншен журнала запросов.
 *
 * Срок в 30 дней не выдуман: он написан в интерфейсе, в «Опасной зоне» на экране
 * ключей — «История запросов сохранится в логах 30 дней». Раз обещано, должно исполняться.
 *
 * Удаляем пачками и с паузой между ними: одна большая DELETE по таблице на десятки
 * миллионов строк держит блокировки и мешает записи новых логов.
 *
 * Правильное решение при росте — секционирование по дням и DROP PARTITION вместо DELETE.
 * До первых миллионов строк это преждевременно, поэтому пока пачечное удаление,
 * а место под секции оставлено индексом (sandboxId, timestamp).
 */

const RETENTION_DAYS = Number(process.env.APISTEND_LOG_RETENTION_DAYS ?? 30)
const BATCH = 5_000
const PAUSE_MS = 200
const INTERVAL_MS = 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let lastRun: { at: string; deleted: number } | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function purgeOldLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000)
  let deleted = 0

  for (;;) {
    // Prisma не умеет DELETE ... LIMIT, поэтому сначала выбираем идентификаторы пачки.
    const batch = await prisma.requestLog.findMany({
      where: { timestamp: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    })
    if (batch.length === 0) break

    const { count } = await prisma.requestLog.deleteMany({
      where: { id: { in: batch.map((r) => r.id) } },
    })
    deleted += count
    if (batch.length < BATCH) break
    await sleep(PAUSE_MS)
  }

  lastRun = { at: new Date().toISOString(), deleted }
  return deleted
}

/**
 * Просроченные сессии кабинета.
 *
 * Строка auth_sessions живёт две недели и после этого бесполезна: readSession
 * сверяет срок и такую сессию не принимает, а список активных сессий её прячет.
 * Но никто её не удалял, и таблица росла на каждый вход навсегда. Здесь их немного,
 * поэтому без пачек: обычный DELETE по индексируемому полю.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await prisma.authSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return count
}

export function startRetentionJob(log: (msg: string) => void): void {
  if (timer) return
  const run = () => {
    void purgeOldLogs()
      .then((n) => { if (n > 0) log(`ретеншен: удалено ${n} записей журнала старше ${RETENTION_DAYS} дней`) })
      .catch((e) => log(`ретеншен: ошибка — ${String(e)}`))
    void purgeExpiredSessions()
      .then((n) => { if (n > 0) log(`ретеншен: удалено ${n} просроченных сессий кабинета`) })
      .catch((e) => log(`ретеншен сессий: ошибка — ${String(e)}`))
  }
  // Первый прогон с задержкой: старт приложения не должен упираться в уборку.
  setTimeout(run, 30_000).unref()
  timer = setInterval(run, INTERVAL_MS)
  timer.unref()
}

export function stopRetentionJob(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function retentionStats(): { retentionDays: number; lastRun: typeof lastRun } {
  return { retentionDays: RETENTION_DAYS, lastRun }
}
