'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import {
  CodeBlock, ErrorState, Panel, PanelHeader, SkeletonRows, StatusChip, Toggle,
} from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { Topbar } from '@/components/Topbar'
import { useProjectCrumb } from '@/components/AppShell'

/**
 * Экран «Настройки».
 *
 * Пока здесь одно, зато настоящее: доступ к песочнице по MCP. Раздел не нарисован
 * в макете — его и не было, когда макет рисовали: MCP появился у продукта позже.
 *
 * Почему это выключатель, а не всегда доступная возможность. Агент, которому дали
 * ключ, вызывает моки и читает журнал запросов, а в журнале лежат тела запросов,
 * написанные человеком. Такое включают осознанно, а не обнаруживают включённым.
 * Открытая часть — каталог методов — работает и без включения: в ней нет ничего
 * личного, и агенту она нужна как раз до того, как у него появится ключ.
 */

interface McpSettings {
  enabled: boolean
  url: string
  protocolVersion: string
  clientConfig: string
  agentInstructions: string
  tools: Array<{ name: string; title: string; description: string }>
}

export default function Page() {
  const crumb = useProjectCrumb('Настройки')

  const [search, setSearch] = useState('')
  const [data, setData] = useState<McpSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.get<McpSettings>('/api/settings/mcp'))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить настройки')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function toggle(next: boolean) {
    if (!data) return
    setSaving(true)
    // Показываем новое состояние сразу: выключатель, думающий полсекунды,
    // читается как несработавший, и по нему щёлкают второй раз.
    setData({ ...data, enabled: next })
    try {
      await api.patch('/api/settings/mcp', { enabled: next })
    } catch (e) {
      setData({ ...data, enabled: !next })
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Topbar breadcrumb={crumb} title="Настройки" search={search} onSearchChange={setSearch} />
      <main className="flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto p-[24px]">
        {error && !data ? <ErrorState message={error} onRetry={() => void load()} /> : null}
        {!data && !error ? <SkeletonRows rows={4} /> : null}

        {data ? (
          <>
            <Panel>
              <PanelHeader
                title="Доступ для ИИ-агента (MCP)"
                icon={<Bot size={15} className="text-text-secondary" aria-hidden />}
                right={
                  <span className="flex items-center gap-[10px]">
                    <StatusChip tone={data.enabled ? 'success' : 'neutral'}>
                      {data.enabled ? 'Включён' : 'Выключен'}
                    </StatusChip>
                    <Toggle
                      checked={data.enabled}
                      onChange={(v) => void toggle(v)}
                      label="Доступ по MCP"
                      className={saving ? 'opacity-60' : undefined}
                    />
                  </span>
                }
              />
              <div className="flex flex-col gap-[14px] p-[16px]">
                <p className="text-[13px] leading-[1.6] text-text-secondary">
                  Агент подключается к APIStend по Model Context Protocol и получает то же,
                  что кабинет даёт человеку: каталог методов четырёх сервисов, карточку метода
                  с примером ответа, вызов мока и журнал запросов песочницы.
                </p>
                <p className="text-[12px] leading-[1.6] text-text-tertiary">
                  Выключено по умолчанию не из осторожности: агент с ключом читает журнал
                  запросов, а там лежат тела запросов, которые писали вы. Каталог методов
                  открыт и без включения — в нём нет ничего личного.
                </p>

                <div className="flex flex-col gap-[6px]">
                  <span className="text-[12px] font-medium text-text-secondary">Адрес сервера</span>
                  <CodeBlock code={data.url} language="text" size="sm" />
                </div>
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Конфигурация клиента"
                subtitle="Claude Code, Cursor, VS Code — файл настроек MCP"
              />
              <div className="flex flex-col gap-[10px] p-[16px]">
                <CodeBlock code={data.clientConfig} language="json" size="sm" />
                <p className="text-[12px] leading-[1.6] text-text-tertiary">
                  Подставьте вместо <code className="font-mono">stend_sk_ВАШ_КЛЮЧ</code> ключ
                  с экрана{' '}
                  <a href="/keys" className="text-accent hover:underline">Ключи и токены</a>.
                  Полностью ключ показывается один раз — при создании, — поэтому подставить его
                  может только тот, у кого он есть.
                </p>
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Инструкция для агента"
                subtitle="Скопируйте в системный текст агента или в AGENTS.md проекта"
              />
              <div className="flex flex-col gap-[10px] p-[16px]">
                {/* Текст приходит с сервера и собран из живого списка инструментов:
                    инструкция, разошедшаяся с сервером, хуже отсутствующей —
                    агент вызовет то, чего нет, и решит, что сломан сервер. */}
                <CodeBlock code={data.agentInstructions} language="text" size="sm" maxLines={18} />
                <p className="text-[12px] leading-[1.6] text-text-tertiary">
                  Инструкция собрана из настоящего списка инструментов сервера, а не написана
                  отдельно: она не разойдётся с тем, что агент действительно может вызвать.
                </p>
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="Инструменты" count={data.tools.length} />
              <ul className="flex flex-col divide-y divide-border">
                {data.tools.map((t) => (
                  <li key={t.name} className="flex flex-col gap-[2px] px-[16px] py-[11px]">
                    <span className="font-mono text-[12px] font-medium text-text-primary">{t.name}</span>
                    <span className="text-[12px] leading-[1.5] text-text-secondary">
                      {t.description.split('\n')[0]}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        ) : null}
      </main>
    </>
  )
}
