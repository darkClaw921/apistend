/**
 * Серии событий: N доставок с заданной скоростью.
 *
 * Ради чего это отдельный движок, а не цикл вызовов dispatchWebhook.
 *
 * 1. Одиночная отправка делает два похода в базу на событие — чтение вебхука
 *    и запись доставки. На двухстах событиях в секунду это четыреста запросов
 *    в секунду ради данных, которые не меняются. Здесь вебхук читается один раз
 *    за серию, а доставки пишутся пачкой на такт.
 * 2. Расписание должно быть общим. Отдельный таймер на серию при трёх сериях даёт
 *    три несинхронизированных источника нагрузки и рваную кривую; один такт на всех
 *    даёт ровный поток и позволяет честно измерить фактическую скорость.
 * 3. Нагрузочному тесту нужна обратная связь. Если приложение не успевает отвечать,
 *    очередь неподтверждённых доставок растёт — серия притормаживает и пишет об этом,
 *    вместо того чтобы наливать в сокет и рисовать несуществующую скорость.
 *
 * Состояние расписания живёт в памяти процесса. Перезапуск его теряет, поэтому
 * незавершённые серии при старте помечаются `interrupted` — притворяться,
 * что они продолжаются, нельзя.
 */

import type { Webhook } from '@prisma/client'
import { SERVICE_PROFILES, type ServiceCode } from '@apistend/shared'
import { prisma } from '../db.ts'
import { env } from '../env.ts'
import { getSession } from '../tunnel/registry.ts'
import { buildDelivery, recordDeliveryResult, sendPrepared } from './dispatcher.ts'

/** Шаг расписания. Десять тактов в секунду: мельче — дороже, крупнее — заметная зернистость. */
const TICK_MS = 100
/** Сколько ждать последние ответы сверх таймаута сервиса, прежде чем подводить итог. */
const SETTLE_GRACE_MS = 2_000
/** Не отдаём приложению больше, чем столько неотвеченных доставок. */
const INFLIGHT_LIMIT_FACTOR = 2
const MIN_INFLIGHT_LIMIT = 20
/** Прогресс в базу пишем не чаще этого — иначе счётчик сам станет нагрузкой. */
const PROGRESS_FLUSH_MS = 1_000

export interface BurstRequest {
  sandboxId: string
  webhookId: string
  count: number
  ratePerSec: number
  /** Доля доставок, которым имитируется сбой отправки. */
  errorRate?: number
  scenarioId?: string
}

export interface BurstStartResult {
  burstId: string
  event: string
  serviceCode: string
  transport: 'local' | 'public'
  target: string
  count: number
  ratePerSec: number
  /** Что именно обрезано потолками. Пусто — приняли как просили. */
  capped: string[]
  estimatedSeconds: number
}

export type BurstError =
  | 'NO_WEBHOOK'
  | 'WEBHOOK_PAUSED'
  | 'NO_AGENT'
  | 'TOO_MANY_BURSTS'
  | 'BAD_PARAMS'

interface Runner {
  id: string
  webhook: Webhook
  sandboxId: string
  count: number
  ratePerSec: number
  errorRate: number
  scenarioId: string | null
  /** Дробный остаток расписания: при 7 событиях в секунду такт даёт 0,7 события. */
  carry: number
  sent: number
  index: number
  startedAt: number
  lastFlushAt: number
  /** Такты, пропущенные из-за того, что приложение не успевало отвечать. */
  throttledTicks: number
  stopping: boolean
  note: string | null
  /**
   * Момент, когда отправка кончилась и мы ждём последние ответы.
   * Без этой фазы итог серии подводится раньше, чем приложение успевает ответить
   * на последние доставки, и в сводке недосчитывается успешных.
   */
  settlingSince: number | null
}

const runners = new Map<string, Runner>()
let timer: NodeJS.Timeout | null = null
/**
 * Такт занят. setInterval не ждёт завершения предыдущего вызова: если запись пачки
 * в базу заняла больше ста миллисекунд, следующий такт входит в advance параллельно,
 * оба видят старое значение sent и отправляют лишнее. На медленной машине серия
 * из 120 событий уходила в 140 — CI это и поймал.
 */
let ticking = false
let logLine: (msg: string) => void = () => {}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Ставит серию в работу.
 * Возвращает описание принятой серии либо код отказа — коды разные,
 * потому что «нет вебхука» и «агент не подключён» чинятся по-разному.
 */
export async function startBurst(req: BurstRequest): Promise<BurstStartResult | BurstError> {
  if (!Number.isFinite(req.count) || !Number.isFinite(req.ratePerSec)) return 'BAD_PARAMS'
  if (req.count < 1 || req.ratePerSec < 1) return 'BAD_PARAMS'

  const webhook = await prisma.webhook.findFirst({
    where: { id: req.webhookId, sandboxId: req.sandboxId },
  })
  if (!webhook) return 'NO_WEBHOOK'
  if (webhook.status === 'paused' || webhook.status === 'disabled') return 'WEBHOOK_PAUSED'

  // Локальная доставка без агента насыпала бы тысячи строк в очередь и ничего не проверила.
  if (webhook.target === 'local' && !getSession(req.sandboxId)) return 'NO_AGENT'

  const active = [...runners.values()].filter((r) => r.sandboxId === req.sandboxId).length
  if (active >= env.burstMaxConcurrent) return 'TOO_MANY_BURSTS'

  const count = clamp(req.count, 1, env.burstMaxCount)
  const ratePerSec = clamp(req.ratePerSec, 1, env.burstMaxRatePerSec)
  const errorRate = clamp(req.errorRate ?? 0, 0, 100)

  const capped: string[] = []
  if (count !== Math.round(req.count)) capped.push(`количество ограничено до ${count}`)
  if (ratePerSec !== Math.round(req.ratePerSec)) capped.push(`скорость ограничена до ${ratePerSec} соб/с`)

  const burst = await prisma.eventBurst.create({
    data: {
      sandboxId: req.sandboxId,
      webhookId: webhook.id,
      scenarioId: req.scenarioId ?? null,
      event: webhook.event,
      serviceCode: webhook.serviceCode,
      count,
      ratePerSec,
      requestedCount: Math.round(req.count),
      requestedRatePerSec: Math.round(req.ratePerSec),
      errorRate,
    },
  })

  runners.set(burst.id, {
    id: burst.id,
    webhook,
    sandboxId: req.sandboxId,
    count,
    ratePerSec,
    errorRate,
    scenarioId: req.scenarioId ?? null,
    carry: 0,
    sent: 0,
    index: 0,
    startedAt: Date.now(),
    lastFlushAt: Date.now(),
    throttledTicks: 0,
    stopping: false,
    note: null,
    settlingSince: null,
  })
  ensureTimer()

  if (req.scenarioId) {
    await prisma.scenario.updateMany({
      where: { id: req.scenarioId },
      data: { status: 'running', progress: 0, lastRunAt: new Date(), lastRunNote: null },
    })
  }

  return {
    burstId: burst.id,
    event: webhook.event,
    serviceCode: webhook.serviceCode,
    transport: webhook.target === 'local' ? 'local' : 'public',
    target: webhook.target === 'local' ? (webhook.targetPath ?? '/') : (webhook.targetUrl ?? ''),
    count,
    ratePerSec,
    capped,
    estimatedSeconds: Math.ceil(count / ratePerSec),
  }
}

export function stopBurst(burstId: string): boolean {
  const runner = runners.get(burstId)
  if (!runner) return false
  runner.stopping = true
  runner.note = 'Остановлено вручную'
  return true
}

/** Идущие серии песочницы — из памяти, чтобы прогресс был текущим, а не последним записанным. */
export function liveBursts(sandboxId: string) {
  return [...runners.values()]
    .filter((r) => r.sandboxId === sandboxId)
    .map((r) => ({
      id: r.id,
      event: r.webhook.event,
      serviceCode: r.webhook.serviceCode,
      sent: r.sent,
      count: r.count,
      ratePerSec: r.ratePerSec,
      // Фактическая скорость: то, ради чего нагрузочный тест и запускают.
      actualRatePerSec: actualRate(r),
      throttledTicks: r.throttledTicks,
      elapsedMs: Date.now() - r.startedAt,
      // «sending» — ещё шлём, «settling» — всё отправлено, ждём последние ответы.
      phase: r.settlingSince === null ? ('sending' as const) : ('settling' as const),
    }))
}

/** Скорость считаем по фазе отправки: ожидание последних ответов её бы занизило. */
function actualRate(r: Runner): number {
  const until = r.settlingSince ?? Date.now()
  const seconds = (until - r.startedAt) / 1000
  return seconds > 0.2 ? Math.round(r.sent / seconds) : 0
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref()
}

async function tick(): Promise<void> {
  if (ticking) return
  if (runners.size === 0) {
    if (timer) clearInterval(timer)
    timer = null
    return
  }
  ticking = true
  try {
    await advanceAll()
  } finally {
    ticking = false
  }
}

async function advanceAll(): Promise<void> {
  for (const runner of [...runners.values()]) {
    try {
      await advance(runner)
    } catch (e) {
      runner.stopping = true
      // P2003 — внешний ключ: вебхук удалили посреди серии. Это не сбой движка,
      // и в журнале должно стоять понятное человеку объяснение, а не текст драйвера.
      const gone = String((e as { code?: string }).code) === 'P2003'
      runner.note = gone ? 'Вебхук удалён во время серии' : `Сбой серии: ${String(e)}`
      runner.settlingSince = Date.now()
      logLine(`серия ${runner.id}: ${runner.note}`)
      try {
        await finish(runner)
      } catch {
        runners.delete(runner.id)
      }
    }
  }
}

async function advance(runner: Runner): Promise<void> {
  if (runner.settlingSince !== null) {
    await settle(runner)
    return
  }
  if (runner.stopping || runner.sent >= runner.count) {
    runner.settlingSince = Date.now()
    await settle(runner)
    return
  }

  const session = runner.webhook.target === 'local' ? getSession(runner.sandboxId) : null
  if (runner.webhook.target === 'local' && !session) {
    // Агент отвалился посреди серии: продолжать некуда, копить очередь бессмысленно.
    runner.stopping = true
    runner.note = 'Агент отключился — серия прервана'
    runner.settlingSince = Date.now()
    await settle(runner)
    return
  }

  // Приложение не успевает отвечать: не наливаем в сокет, а притормаживаем и считаем такты.
  const inflightLimit = Math.max(MIN_INFLIGHT_LIMIT, runner.ratePerSec * INFLIGHT_LIMIT_FACTOR)
  if (session && session.inflight.size >= inflightLimit) {
    runner.throttledTicks++
    return
  }

  runner.carry += (runner.ratePerSec * TICK_MS) / 1000
  const batch = Math.min(Math.floor(runner.carry), runner.count - runner.sent)
  if (batch <= 0) return
  runner.carry -= batch

  const now = new Date()
  const rows = Array.from({ length: batch }, () =>
    buildDelivery(runner.webhook, { index: runner.index++, now, burstId: runner.id }),
  )

  // Одна запись на такт вместо batch записей: при 200 соб/с это 10 запросов в секунду вместо 200.
  await prisma.webhookDelivery.createMany({ data: rows })

  // Имитация сбоя отправки: событие создано и видно в журнале, но наружу не уходит.
  // Так проверяется ветка обработки ошибок и лестница повторов сервиса.
  const failedIds: string[] = []
  const toSend = rows.filter((row) => {
    if (runner.errorRate > 0 && Math.random() * 100 < runner.errorRate) {
      failedIds.push(row.id)
      return false
    }
    return true
  })

  // Состояние ставим ДО отправки: локальный получатель отвечает за миллисекунду,
  // и запись «dispatched» после запроса затирала бы уже пришедший результат —
  // серия отчитывалась бы нулём успешных при полностью доставленных событиях.
  if (toSend.length > 0) {
    await prisma.webhookDelivery.updateMany({
      where: { id: { in: toSend.map((r) => r.id) } },
      data: { state: 'dispatched' },
    })
  }

  const notSent = toSend.filter((row) => !sendPrepared(row, runner.webhook)).map((r) => r.id)
  if (notSent.length > 0) {
    // Условие по state не даёт откатить доставку, на которую уже пришёл ответ.
    await prisma.webhookDelivery.updateMany({
      where: { id: { in: notSent }, state: 'dispatched' },
      data: { state: 'queued' },
    })
  }

  for (const id of failedIds) {
    await recordDeliveryResult(id, {
      statusCode: null,
      body: '',
      durationMs: 0,
      errorKind: 'simulated',
      errorMessage: 'Сбой отправки, заданный долей ошибок в серии',
    })
  }

  runner.sent += batch
  if (Date.now() - runner.lastFlushAt >= PROGRESS_FLUSH_MS) await flush(runner)
  if (runner.sent >= runner.count) {
    runner.settlingSince = Date.now()
    await settle(runner)
  }
}

/**
 * Ждём, пока по серии не останется доставок без ответа.
 *
 * Крайний срок — таймаут сервиса плюс запас: дольше ждать нечего, зависшие доставки
 * всё равно переведёт в no_response уборщик планировщика.
 */
async function settle(runner: Runner): Promise<void> {
  const profile = SERVICE_PROFILES[runner.webhook.serviceCode as ServiceCode]
  // Ждать полный таймаут сервиса имеет смысл, когда серия дошла до конца сама.
  // После явной остановки это лишнее: подвисшие доставки всё равно переведёт
  // в no_response уборщик планировщика, а «Стоп» должен срабатывать сразу.
  const patience = runner.stopping ? 0 : profile.webhook.timeoutMs
  const deadline = runner.settlingSince! + patience + SETTLE_GRACE_MS

  const pending = await prisma.webhookDelivery.count({
    where: { burstId: runner.id, state: { in: ['queued', 'dispatched'] } },
  })
  if (pending === 0 || Date.now() > deadline) {
    await finish(runner, pending)
  }
}

async function flush(runner: Runner): Promise<void> {
  runner.lastFlushAt = Date.now()
  await prisma.eventBurst.updateMany({ where: { id: runner.id }, data: { sent: runner.sent } })
  if (runner.scenarioId) {
    await prisma.scenario.updateMany({
      where: { id: runner.scenarioId },
      data: { progress: runner.sent },
    })
  }
}

async function finish(runner: Runner, stillPending = 0): Promise<void> {
  runners.delete(runner.id)

  const elapsedMs = Date.now() - runner.startedAt
  const rate = actualRate(runner)
  const tally = await prisma.webhookDelivery.groupBy({
    by: ['state'],
    where: { burstId: runner.id },
    _count: { _all: true },
  })
  const by = (state: string) => tally.find((t) => t.state === state)?._count._all ?? 0
  const succeeded = by('succeeded')
  const failed = by('failed') + by('no_response') + by('dropped')

  const parts = [`${runner.sent} из ${runner.count} событий`, `${rate} соб/с фактически`]
  if (stillPending > 0) parts.push(`${stillPending} без ответа в срок`)
  if (runner.throttledTicks > 0) {
    parts.push(`приложение не успевало ${(runner.throttledTicks * TICK_MS) / 1000} с`)
  }
  const note = runner.note ? `${runner.note} · ${parts.join(' · ')}` : parts.join(' · ')

  await prisma.eventBurst.updateMany({
    where: { id: runner.id },
    data: {
      state: runner.stopping ? 'stopped' : 'done',
      sent: runner.sent,
      succeeded,
      failed,
      finishedAt: new Date(),
      note,
    },
  })

  if (runner.scenarioId) {
    await prisma.scenario.updateMany({
      where: { id: runner.scenarioId },
      data: { status: 'ready', progress: runner.sent, lastRunNote: note },
    })
  }
  logLine(`серия ${runner.id}: ${note} (${elapsedMs} мс)`)
}

/**
 * Стартовая уборка: расписание серий не переживает перезапуск процесса,
 * поэтому «идущие» серии из прошлой жизни честно помечаются прерванными.
 */
export async function reapInterruptedBursts(log: (msg: string) => void): Promise<number> {
  logLine = log
  const { count } = await prisma.eventBurst.updateMany({
    where: { state: 'running' },
    data: { state: 'interrupted', finishedAt: new Date(), note: 'Прервана перезапуском сервера' },
  })
  if (count > 0) {
    await prisma.scenario.updateMany({ where: { status: 'running' }, data: { status: 'ready' } })
  }
  return count
}

/** Профиль сервиса для подсказки в интерфейсе: сколько повторов и какой таймаут. */
export function serviceDeliveryHint(service: ServiceCode) {
  const p = SERVICE_PROFILES[service].webhook
  return { retries: p.retryDelaysMs.length, timeoutMs: p.timeoutMs, maxBatchSize: p.maxBatchSize }
}
