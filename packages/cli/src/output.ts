import pc from 'picocolors'

/**
 * Вывод в терминал.
 *
 * Формат заимствован у `stripe listen` — он выстрадан: слева метка времени,
 * затем направление, затем суть. Каждое событие занимает две строки: что пришло
 * с сервера и что ответило приложение. Так видно и факт доставки, и её результат.
 */

export const stamp = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const write = (line: string) => process.stdout.write(`${line}\n`)

export const out = {
  banner(version: string, account: string, sandbox: string): void {
    write('')
    write(`  ${pc.bold('APIStend CLI')} ${pc.dim(version)}`)
    write(`  ${pc.dim('Аккаунт:')} ${account} ${pc.dim('·')} ${pc.dim('песочница')} ${sandbox}`)
    write('')
  },

  ready(sessionId: string, forwardUrl: string, secret: string, queued: number): void {
    write(`${pc.green('>')} Готов! Сессия ${pc.bold(sessionId)} ${pc.dim('·')} пересылка на ${pc.cyan(forwardUrl)}`)
    write(`${pc.green('>')} Секрет подписи: ${pc.dim(secret)} ${pc.dim('(для проверки X-APIStend-Signature)')}`)
    write(`${pc.green('>')} События: все ${pc.dim('·')} транспорт: websocket ${pc.dim('·')} Ctrl+C для выхода`)
    if (queued > 0) {
      write(`${pc.green('>')} В очереди ${queued} ${plural(queued, 'событие', 'события', 'событий')} за время простоя, отправляю`)
    }
    write('')
  },

  delivery(event: string, id: string): void {
    write(`${pc.dim(stamp())}   ${pc.dim('-->')} ${pc.bold(event)} ${pc.dim(`[${id}]`)}`)
  },

  response(status: number, method: string, url: string, ms: number, id: string): void {
    const code = status >= 500 ? pc.red(`[${status}]`) : status >= 300 ? pc.yellow(`[${status}]`) : pc.green(`[${status}]`)
    write(`${pc.dim(stamp())}  ${pc.dim('<--')}  ${code} ${method} ${url}  ${pc.dim(`${ms} мс`)} ${pc.dim(`[${id}]`)}`)
  },

  burstStarted(
    event: string, count: number, rate: number, target: string, seconds: number, capped: string[],
  ): void {
    write(`${pc.green('>')} Серия ${pc.bold(event)}: ${count} ${plural(count, 'событие', 'события', 'событий')} по ${pc.bold(String(rate))} соб/с ${pc.dim(`≈ ${seconds} с`)}`)
    write(`${pc.green('>')} Получатель: ${pc.cyan(target)}`)
    for (const line of capped) write(`${pc.yellow('!')} ${line}`)
    write('')
  },

  /** Строка прогресса. Перерисовывается на месте, чтобы не залить терминал. */
  burstProgress(sent: number, count: number, actualRate: number, wanted: number, lagging: boolean): void {
    const pct = Math.round((sent / count) * 100)
    const rate = lagging ? pc.yellow(`${actualRate} соб/с`) : pc.green(`${actualRate} соб/с`)
    const line = `  ${String(pct).padStart(3)} %  ${sent}/${count}  ${rate} ${pc.dim(`из ${wanted}`)}${lagging ? pc.dim('  приложение не успевает') : ''}`
    if (process.stdout.isTTY) process.stdout.write(`\r\u001b[2K${line}`)
    else write(line)
  },

  burstDone(sent: number, count: number, succeeded: number, failed: number, note: string | null): void {
    if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K')
    const mark = failed > 0 ? pc.yellow('!') : pc.green('>')
    write(`${mark} Серия завершена: отправлено ${sent} из ${count} ${pc.dim('·')} успешно ${pc.green(String(succeeded))} ${pc.dim('·')} ошибок ${failed > 0 ? pc.red(String(failed)) : '0'}`)
    if (note) write(`  ${pc.dim(note)}`)
  },

  deliveryError(url: string, message: string, retryInMs: number | null, id: string): void {
    const retry = retryInMs === null ? '' : ` ${pc.dim('·')} повтор через ${Math.round(retryInMs / 1000)} с`
    write(`${pc.dim(stamp())}  ${pc.red('!!!')}  ${url} — ${message}${retry} ${pc.dim(`[${id}]`)}`)
  },

  reconnecting(attempt: number): void {
    write(`${pc.dim(stamp())}  ${pc.yellow('...')} связь с APIStend потеряна, переподключение (попытка ${attempt})`)
  },

  reconnected(sessionId: string, queued: number): void {
    write(`${pc.dim(stamp())}  ${pc.green('>>>')} переподключено ${pc.dim('·')} сессия ${sessionId} ${pc.dim('·')} из очереди доставлено: ${queued}`)
  },

  summary(sessionId: string, events: number, failed: number, medianMs: number): void {
    write('')
    write(`${pc.green('>')} Сессия ${sessionId} закрыта ${pc.dim('·')} ${events} ${plural(events, 'событие', 'события', 'событий')} ${pc.dim('·')} ${failed} ${plural(failed, 'ошибка', 'ошибки', 'ошибок')} доставки ${pc.dim('·')} медиана ${medianMs} мс`)
  },

  error(message: string, hint?: string): void {
    process.stderr.write(`${pc.red('✗')} ${message}\n`)
    if (hint) process.stderr.write(`  ${pc.dim(hint)}\n`)
  },

  info(message: string): void {
    write(`${pc.green('>')} ${message}`)
  },

  json(value: unknown): void {
    write(JSON.stringify(value, null, 2))
  },
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
