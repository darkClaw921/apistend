import { prisma } from '../db.ts'

/**
 * Счётчики использования ключей.
 *
 * Колонки lastUsedAt и requestsPerDay видны на экране «Ключи и токены».
 * Обновлять их запросом к базе на каждый вызов мока нельзя: это ровно один
 * лишний UPDATE на каждый запрос, и под нагрузкой он становится узким местом
 * раньше, чем сам мок.
 *
 * Поэтому копим приращения в памяти и сбрасываем пачкой раз в 10 секунд.
 * Цена — счётчик может отставать на эти 10 секунд; для витрины это приемлемо.
 */

const FLUSH_INTERVAL_MS = 10_000

interface Usage {
  count: number
  lastUsedAt: Date
}

const pending = new Map<string, Usage>()
let timer: NodeJS.Timeout | null = null

export function recordKeyUsage(apiKeyId: string, at: Date = new Date()): void {
  const current = pending.get(apiKeyId)
  if (current) {
    current.count++
    current.lastUsedAt = at
  } else {
    pending.set(apiKeyId, { count: 1, lastUsedAt: at })
  }

  timer ??= setTimeout(() => void flushKeyUsage(), FLUSH_INTERVAL_MS)
}

export async function flushKeyUsage(): Promise<number> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (pending.size === 0) return 0

  const batch = [...pending.entries()]
  pending.clear()

  try {
    // Каждому ключу — свой UPDATE, но их столько же, сколько активных ключей,
    // а не столько, сколько запросов.
    await prisma.$transaction(
      batch.map(([id, usage]) =>
        prisma.apiKey.update({
          where: { id },
          data: { requestsPerDay: { increment: usage.count }, lastUsedAt: usage.lastUsedAt },
        }),
      ),
    )
    return batch.length
  } catch (error) {
    process.stderr.write(`[key-usage] не удалось обновить ${batch.length} ключей: ${String(error)}\n`)
    return 0
  }
}

export function keyUsageStats(): { pendingKeys: number } {
  return { pendingKeys: pending.size }
}
