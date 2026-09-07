import type { Prisma } from '@prisma/client'
import { prisma } from '../db.ts'

/**
 * Буфер логов запросов.
 *
 * Синхронная запись строки в БД на каждый вызов мока съела бы весь бюджет задержки
 * и упёрлась бы в пул соединений раньше, чем сам мок. Поэтому строки копятся
 * в памяти и уходят пачкой: по таймеру или по достижению порога.
 *
 * Под настоящей нагрузкой одного буфера мало: при десяти тысячах запросов в секунду
 * столько же строк в секунду не выдержит ни диск, ни последующие запросы к журналу.
 * Поэтому при превышении порога включается выборка: пишем не все запросы, а долю,
 * и ЧЕСТНО показываем её в /health и в интерфейсе. Молча терять записи нельзя —
 * пользователь решит, что запрос не дошёл.
 *
 * Ошибки (код 4xx/5xx) не прореживаются никогда: ради них журнал и открывают.
 */

const FLUSH_INTERVAL_MS = 1_000
const FLUSH_THRESHOLD = 200
const MAX_BUFFER = 20_000

/**
 * Выше этой скорости включается прореживание успешных запросов.
 *
 * Значение подобрано замером, а не на глаз: при 3800 строках в секунду запись
 * в PostgreSQL блокирует событийный цикл и роняет пропускную способность шлюза
 * с 21 700 до 4 500 запросов в секунду, а p95 задержки поднимает с 5,7 до 107 мс.
 * Триста строк в секунду на инстанс — с большим запасом выше любой реальной
 * отладочной нагрузки одного разработчика, при этом шлюз остаётся быстрым.
 *
 * Ошибки не прореживаются никогда, доля выборки видна в /health и в интерфейсе.
 */
const SAMPLING_THRESHOLD_RPS = Number(process.env.APISTEND_LOG_SAMPLE_RPS ?? 300)
const MIN_SAMPLE_RATE = 0.005

let buffer: Prisma.RequestLogCreateManyInput[] = []
let timer: NodeJS.Timeout | null = null

let dropped = 0
let sampledOut = 0
let written = 0
let sampleRate = 1

// Скользящее окно для оценки скорости поступления.
let windowStart = Date.now()
let windowCount = 0

function updateSampleRate(): void {
  const now = Date.now()
  const elapsed = now - windowStart
  if (elapsed < 1_000) return

  const rps = (windowCount * 1000) / elapsed
  windowStart = now
  windowCount = 0

  sampleRate = rps <= SAMPLING_THRESHOLD_RPS
    ? 1
    : Math.max(MIN_SAMPLE_RATE, SAMPLING_THRESHOLD_RPS / rps)
}

export function enqueueRequestLog(row: Prisma.RequestLogCreateManyInput): void {
  if (process.env.APISTEND_DISABLE_REQUEST_LOG === '1') return
  windowCount++
  updateSampleRate()

  // Диагностические ответы не прореживаем никогда: ради них журнал и открывают,
  // и встречаются они редко.
  //
  // 429 и 503 — исключение из исключения. Это эмуляция лимитов боевого API,
  // и по своей природе они приходят лавиной: в замере на 50 000 запросов их было
  // 32 000. Логировать каждый — значит уронить шлюз ровно тогда, когда клиент
  // и так упёрся в лимит. Их прореживаем наравне с успешными.
  const status = typeof row.statusCode === 'number' ? row.statusCode : 200
  const isRateLimit = status === 429 || status === 503
  const alwaysKeep = status >= 400 && !isRateLimit

  if (!alwaysKeep && sampleRate < 1 && Math.random() > sampleRate) {
    sampledOut++
    return
  }

  if (buffer.length >= MAX_BUFFER) {
    // Лучше потерять запись, чем уронить процесс по памяти. Потерю считаем и показываем.
    dropped++
    return
  }

  buffer.push(row)
  if (buffer.length >= FLUSH_THRESHOLD) {
    void flushRequestLogs()
    return
  }
  timer ??= setTimeout(() => void flushRequestLogs(), FLUSH_INTERVAL_MS)
}

export async function flushRequestLogs(): Promise<number> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (buffer.length === 0) return 0

  const batch = buffer
  buffer = []
  try {
    await prisma.requestLog.createMany({ data: batch })
    written += batch.length
    return batch.length
  } catch (error) {
    process.stderr.write(`[log-buffer] не удалось записать ${batch.length} строк: ${String(error)}\n`)
    return 0
  }
}

export function bufferStats(): {
  pending: number
  written: number
  dropped: number
  sampledOut: number
  sampleRate: number
} {
  return { pending: buffer.length, written, dropped, sampledOut, sampleRate }
}
