'use client'

import { useState } from 'react'
import { Check, Copy, LaptopMinimal } from 'lucide-react'
import { ButtonSecondary, ShellLine, StatusChip, formatInt, formatMs } from '@apistend/ui'
import type { LocalAgent } from '@/lib/types'

/**
 * Полоса «Доставка на локальное приложение».
 * design-handoff/screens/05-webhooks.md, п. 2.
 *
 * Это витрина ключевой особенности продукта: события уходят прямо на машину
 * разработчика, публичный адрес не нужен. Команда показана целиком и копируется
 * одним кликом — она и есть точка входа в фичу.
 */
export function LocalDeliveryBar({ agent, loading }: { agent: LocalAgent | null; loading: boolean }) {
  const [copied, setCopied] = useState(false)
  const command = 'apistend listen --forward localhost:3000/webhooks'

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер недоступен */ }
  }

  const connected = agent?.connected === true

  return (
    <section className="flex shrink-0 items-center gap-[20px] rounded-[10px] border border-border bg-surface p-[16px] max-xl:flex-col max-xl:items-stretch max-xl:gap-[12px]">
      <div className="flex items-start gap-[12px] xl:w-[430px] xl:shrink-0">
        <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[10px] bg-accent-soft">
          <LaptopMinimal size={20} className="text-accent" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="mb-[4px] flex flex-wrap items-center gap-[8px]">
            <h2 className="text-[14px] font-semibold text-text-primary">Доставка на локальное приложение</h2>
            {loading ? (
              <StatusChip tone="neutral" dot={false}>проверяем…</StatusChip>
            ) : connected ? (
              <StatusChip tone="success">Подключено</StatusChip>
            ) : (
              <StatusChip tone="neutral">Не подключено</StatusChip>
            )}
          </div>
          <p className="text-[12px] leading-[1.45] text-text-secondary">
            События уходят прямо на ваш компьютер — публичный адрес не нужен.
          </p>
        </div>
      </div>

      <div className="relative min-w-0 flex-1 rounded-[6px] bg-code-bg px-[12px] py-[10px]">
        <ShellLine command="apistend listen" args="--forward localhost:3000/webhooks" />
        <div className="mt-[4px] flex items-center gap-[6px] font-mono text-[11px] text-code-muted">
          <span
            className={`h-[6px] w-[6px] shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-code-muted'}`}
            aria-hidden
          />
          {connected
            ? `агент ${agent!.agentVersion ?? 'apistend-cli'} · сессия ${agent!.sessionId} · задержка ${agent!.latencyMs === null ? '—' : formatMs(agent!.latencyMs)}`
            : 'запустите команду в терминале проекта'}
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label="Копировать команду"
          className="absolute top-[10px] right-[10px] text-code-muted transition-colors hover:text-code-text"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div className="flex flex-col items-end gap-[6px] xl:w-[190px] xl:shrink-0">
        {connected ? (
          <>
            <span className="text-[13px] font-semibold text-text-primary">
              {formatInt(agent!.eventsLastHour)} событий за час
            </span>
            <span className="text-[11px] text-text-tertiary">
              {formatInt(agent!.failedDeliveries)} ошибок доставки
            </span>
          </>
        ) : (
          <span className="text-right text-[11px] leading-[1.4] text-text-tertiary">
            Локальная доставка не подключена. Запустите <span className="font-mono">apistend listen</span> в терминале проекта.
          </span>
        )}
      </div>
    </section>
  )
}
