import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Конфигурация CLI.
 *
 * Простой JSON-файл с правами 0600. Связку ключей (Keychain через spawn security)
 * сознательно не используем: слишком много краевых случаев — заблокированная связка,
 * GUI-запрос на self-hosted раннере, отсутствие security на Linux.
 */

export interface CliConfig {
  apiKey?: string
  apiBase?: string
  deviceId?: string
  sandbox?: string
}

export function configPath(): string {
  const base = process.env.APISTEND_CONFIG_HOME ?? join(homedir(), '.config', 'apistend')
  return join(base, 'config.json')
}

export function readConfig(): CliConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CliConfig
  } catch {
    return {}
  }
}

export function writeConfig(config: CliConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // На Windows прав в этом виде нет — не повод падать.
  }
}

/** Порядок источников: флаг → переменная окружения → конфиг. */
export function resolveApiKey(flag?: string): string | undefined {
  return flag ?? process.env.APISTEND_API_KEY ?? readConfig().apiKey
}

export function resolveApiBase(flag?: string): string {
  return (flag ?? process.env.APISTEND_API_BASE ?? readConfig().apiBase ?? 'https://api.apistend.ru')
    .replace(/\/+$/, '')
}
