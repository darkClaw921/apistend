'use client'

import { useState } from 'react'
import { CodeBlock, Dialog, SegmentControl, ServiceSquare } from '@apistend/ui'
import type { ServiceCode } from '@apistend/shared'

/**
 * «Как подключить» — что именно поменять в коде интеграции.
 *
 * Обещание продукта в одном экране: меняется базовый адрес и ничего больше,
 * авторизация остаётся родной для сервиса. Поэтому примеры показывают не
 * какой-то общий заголовок APIStend, а тот способ, которым сервис
 * авторизует запросы в бою.
 */

interface BaseUrl {
  code: ServiceCode
  title: string
  letter: string
  shortCode: string
  brandToken: string
  mockUrl: string
  replaces: string
}

/** Пример вызова: путь и способ передать ключ — как в боевом сервисе. */
function example(code: ServiceCode, mockUrl: string, key: string): string {
  const base = mockUrl.replace(/\/$/, '')
  if (code === 'ozon') {
    return [
      `curl -X POST '${base}/v3/posting/fbs/list' \\`,
      `  -H 'Client-Id: 123456' \\`,
      `  -H 'Api-Key: ${key}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"limit": 10}'`,
    ].join('\n')
  }
  if (code === 'wildberries') {
    return [
      `curl '${base}/api/v3/orders/new' \\`,
      `  -H 'Authorization: ${key}'`,
    ].join('\n')
  }
  return [
    `curl '${base}/rest/crm.deal.list?auth=${key}'`,
    ``,
    `# либо заголовком, если библиотека так умеет:`,
    `curl '${base}/rest/crm.deal.list' -H 'X-Mock-Key: ${key}'`,
  ].join('\n')
}

const AUTH_NOTE: Record<ServiceCode, string> = {
  bitrix24: 'Ключ идёт параметром auth= или в пути входящего вебхука — как у боевого портала.',
  ozon: 'Заголовки Client-Id и Api-Key. Client-Id песочница принимает любой.',
  wildberries: 'Заголовок Authorization с токеном, без префикса Bearer.',
  apify: 'Заголовок Authorization: Bearer или параметр token= в адресе — оба как в бою.',
}

export function HowToConnectDialog({
  baseUrls, sampleKey, onClose,
}: {
  baseUrls: BaseUrl[]
  /** Маска ключа со страницы: полный ключ виден только при создании. */
  sampleKey: string
  onClose: () => void
}) {
  const [service, setService] = useState<ServiceCode>(baseUrls[0]?.code ?? 'bitrix24')
  const current = baseUrls.find((b) => b.code === service)

  return (
    <Dialog title="Как подключить" onClose={onClose} width={620}>
      <div className="flex flex-col gap-[16px] p-[16px]">
        <SegmentControl
          segments={baseUrls.map((b) => ({ value: b.code, label: b.title }))}
          value={service}
          onChange={(v) => setService(v as ServiceCode)}
        />

        {current ? (
          <>
            <div className="flex items-start gap-[12px] rounded-[8px] border border-border bg-bg p-[14px]">
              <ServiceSquare service={current.code} size={38} />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-text-primary">Замените базовый адрес</p>
                <p className="mt-[6px] font-mono text-[12px] text-text-tertiary line-through">{current.replaces}</p>
                <p className="font-mono text-[12px] text-accent">{current.mockUrl}</p>
              </div>
            </div>

            <div className="flex flex-col gap-[6px]">
              <p className="text-[12px] font-medium text-text-secondary">Авторизация не меняется</p>
              <p className="text-[12px] leading-[1.5] text-text-tertiary">{AUTH_NOTE[current.code]}</p>
            </div>

            <div className="flex flex-col gap-[6px]">
              <p className="text-[12px] font-medium text-text-secondary">Проверка одной командой</p>
              <CodeBlock code={example(current.code, current.mockUrl, sampleKey)} language="shell" />
              <p className="text-[11px] leading-[1.5] text-text-tertiary">
                Вместо {sampleKey} подставьте полный ключ песочницы: он показывается один раз,
                сразу после создания.
              </p>
            </div>

            <p className="text-[12px] leading-[1.55] text-text-secondary">
              Дальше всё как обычно: те же пути, те же тела запросов, те же коды ошибок.
              Сценарий ответа переключается заголовком <span className="font-mono">X-Mock-Scenario</span>,
              задержка — <span className="font-mono">X-Mock-Delay</span>.
            </p>
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
