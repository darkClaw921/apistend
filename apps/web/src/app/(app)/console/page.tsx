'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Copy, FileDown, Play, Plus, Trash2 } from 'lucide-react'
import {
  ButtonPrimary, ButtonSecondary, CodeBlock, CounterChip, IconButton, MethodBadge,
  Overline, Panel, PanelHeader, SkeletonRows, StatusChip, StatusCodeChip, Tabs,
  formatBytes, formatMs, formatTime, meta,
} from '@apistend/ui'
import { isServiceCode } from '@apistend/shared'
import { api, ApiError } from '@/lib/api'
import { CreateMockDialog } from '@/components/CreateMockDialog'
import type { ConsoleResult, LogDetail, MethodDetail, ServiceSummary } from '@/lib/types'
import { Topbar } from '@/components/Topbar'
import { useShell } from '@/components/AppShell'
import { SOURCE_LABEL } from '@/lib/readiness'

/**
 * Экран «Консоль запросов». design-handoff/screens/03-request-console.md.
 *
 * Запрос уходит НЕ из браузера, а через серверный прокси /api/console/execute.
 * Причина продуктовая: боевой Ozon с 16.05.2025 запрещает запросы из браузера,
 * а WB не отдаёт CORS вовсе. Если бы мок повторял это буквально, собственная консоль
 * перестала бы работать. Прокси попутно даёт IP клиента и боевой URL для панели логов.
 *
 * Ctrl/Cmd + Enter отправляет запрос.
 */

interface ParamRow {
  id: string
  enabled: boolean
  key: string
  value: string
}

const SCENARIOS = [
  { value: 'success', label: 'Успех', hint: '200 · штатный ответ' },
  { value: 'invalid_token', label: 'Ошибка авторизации', hint: '401 invalid_token' },
  { value: 'rate_limit', label: 'Превышение лимита', hint: '429 rate_limit' },
  { value: 'timeout', label: 'Таймаут', hint: '504 · 30 000 ms' },
] as const

let rowSeq = 0
const newRow = (key = '', value = ''): ParamRow => ({ id: `row-${rowSeq++}`, enabled: key.length > 0, key, value })

/**
 * Путь по умолчанию для каждого сервиса.
 *
 * У сервисов принципиально разные схемы адресации: у Bitrix24 имя метода лежит
 * в пути, у Ozon почти всё POST-эндпоинты, у WB — REST. Один общий путь по умолчанию
 * означал бы 404 при первом же переключении сервиса.
 */
const DEFAULT_PATH: Record<string, { path: string; method: string }> = {
  bitrix24: { path: '/rest/crm.deal.list', method: 'GET' },
  ozon: { path: '/v3/posting/fbs/list', method: 'POST' },
  wildberries: { path: '/api/v3/warehouses', method: 'GET' },
}

function ConsoleScreen() {
  const shell = useShell()
  const router = useRouter()
  const searchParams = useSearchParams()
  const presetMethodId = searchParams.get('method')
  // «Повторить в консоли» из карточки запроса. Кнопка вела сюда с самого начала,
  // но console читала только method, и запрос не подставлялся вовсе —
  // пользователь попадал на пустую консоль с настройками по умолчанию.
  const replayId = searchParams.get('replay')

  const [services, setServices] = useState<ServiceSummary[]>([])
  const [service, setService] = useState<string>('bitrix24')
  const [httpMethod, setHttpMethod] = useState('GET')
  const [path, setPath] = useState(DEFAULT_PATH.bitrix24!.path)
  const [params, setParams] = useState<ParamRow[]>([newRow()])
  const [bodyText, setBodyText] = useState('')
  const [scenario, setScenario] = useState<string>('success')
  const [leftTab, setLeftTab] = useState('params')
  const [rightTab, setRightTab] = useState('response')
  const [globalSearch, setGlobalSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const [result, setResult] = useState<ConsoleResult | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Array<ConsoleResult & { at: Date; method: ConsoleResult['method']; httpMethod: string; path: string }>>([])

  useEffect(() => {
    api.get<{ services: ServiceSummary[] }>('/api/services')
      .then((r) => setServices(r.services))
      .catch(() => setServices([]))
  }, [])

  /** Смена сервиса переставляет путь на осмысленный для него: иначе гарантированный 404. */
  function selectService(code: string) {
    setService(code)
    const preset = DEFAULT_PATH[code]
    if (preset) {
      setPath(preset.path)
      setHttpMethod(preset.method)
      setResult(null)
      setError(null)
    }
  }

  // Переход «Открыть в консоли» подставляет метод из каталога.
  useEffect(() => {
    if (!presetMethodId) return
    api.get<MethodDetail>(`/api/catalog/${encodeURIComponent(presetMethodId)}`)
      .then((m) => {
        setService(m.serviceCode)
        setHttpMethod(m.httpMethod)
        setPath(m.path.replace(/\{[^}]+\}/g, '12345'))
        const query = m.params.filter((p) => p.in === 'query').slice(0, 6)
        setParams([...query.map((p) => newRow(p.name, '')), newRow()])
        if (m.params.some((p) => p.in === 'body')) setLeftTab('body')
      })
      .catch(() => { /* метод мог исчезнуть между волнами каталога */ })
  }, [presetMethodId])

  // Повтор запроса из журнала: сервис, метод, путь, query и тело — как было.
  useEffect(() => {
    if (!replayId) return
    api.get<LogDetail>(`/api/logs/${encodeURIComponent(replayId)}`)
      .then((row) => {
        if (isServiceCode(row.serviceCode)) setService(row.serviceCode)
        setHttpMethod(row.httpMethod)
        // Запрос к своим мокам обслуживает /custom/*, и там путь абсолютный;
        // у трёх сервисов в журнале лежит путь без префикса монтирования.
        setPath(row.endpoint)
        if (row.scenario) setScenario(row.scenario)

        const body = row.requestBody
        if (body) {
          setBodyText(body)
          setLeftTab('body')
        }
        setResult(null)
        setError(null)
      })
      .catch(() => setError('Запрос не найден в журнале — возможно, его удалило хранение 30 дней'))
  }, [replayId])

  const send = useCallback(async () => {
    setPending(true)
    setError(null)
    const query = Object.fromEntries(
      params.filter((p) => p.enabled && p.key.trim().length > 0).map((p) => [p.key.trim(), p.value]),
    )
    let parsedBody: unknown
    if (bodyText.trim().length > 0) {
      try {
        parsedBody = JSON.parse(bodyText)
      } catch {
        setError('Тело запроса — невалидный JSON')
        setPending(false)
        return
      }
    }

    try {
      const res = await api.post<ConsoleResult>('/api/console/execute', {
        serviceCode: service,
        httpMethod,
        path,
        query,
        headers: {},
        body: parsedBody,
        scenario,
        sandboxId: shell.sandboxId,
      })
      setResult(res)
      setRightTab('response')
      setHistory((h) => [{ ...res, at: new Date(), httpMethod, path }, ...h].slice(0, 12))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось выполнить запрос')
    } finally {
      setPending(false)
    }
  }, [params, bodyText, service, httpMethod, path, scenario, shell.sandboxId])

  // Ctrl/Cmd + Enter — из спецификации поведения экрана.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void send()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send])

  const activeService = services.find((s) => s.code === service)
  const baseUrl = activeService?.mockBaseUrl.replace(/\/$/, '') ?? ''
  const responseJson = useMemo(
    () => (result ? JSON.stringify(result.body, null, 2) : ''),
    [result],
  )

  function updateRow(id: string, patch: Partial<ParamRow>) {
    setParams((rows) => {
      const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
      // Пустая строка внизу всегда одна — как в макете.
      if (next[next.length - 1]!.key.trim().length > 0) next.push(newRow())
      return next
    })
  }

  return (
    <>
      <Topbar
        breadcrumb={meta('Каталог API', activeService?.title, result?.method?.title) || 'Консоль запросов'}
        title="Консоль запросов"
        search={globalSearch}
        onSearchChange={setGlobalSearch}
        action={
          <ButtonPrimary onClick={() => void send()} disabled={pending} icon={<Play size={13} aria-hidden />}>
            {pending ? 'Отправляем…' : 'Отправить'}
            <span className="ml-[4px] font-mono text-[11px] opacity-70">⌘↵</span>
          </ButtonPrimary>
        }
      />

      <main className="flex min-h-0 flex-1 flex-col gap-[20px] p-[24px]">
        {/* Строка запроса */}
        <div className="flex shrink-0 items-center gap-[10px] rounded-[10px] border border-border bg-surface p-[12px]">
          <select
            value={service}
            onChange={(e) => selectService(e.target.value)}
            aria-label="Сервис"
            className="rounded-[6px] border border-border-strong bg-surface px-[10px] py-[8px] text-[12px] font-semibold text-text-primary outline-none"
          >
            {services.map((s) => (
              <option key={s.code} value={s.code} disabled={s.methodsCount === 0}>
                {s.title}{s.methodsCount === 0 ? ' — скоро' : ''}
              </option>
            ))}
          </select>

          <select
            value={httpMethod}
            onChange={(e) => setHttpMethod(e.target.value)}
            aria-label="HTTP-метод"
            className="rounded-[6px] border border-border-strong bg-surface px-[10px] py-[8px] font-mono text-[12px] font-bold text-text-primary outline-none"
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          <div className="flex min-w-0 flex-1 items-center gap-0 rounded-[6px] border border-border-strong bg-surface px-[12px] py-[8px] focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(59,84,245,0.12)]">
            {/* Префикс базового адреса приглушён, путь метода — основной цвет. */}
            <span className="shrink-0 font-mono text-[13px] text-text-tertiary">{baseUrl}</span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              aria-label="Путь метода"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] font-medium text-text-primary outline-none"
            />
          </div>

          {/* Макет оставляет развилку «сохранить как свой мок/запрос» открытой.
              Выбран мок: под него есть и модель, и экран, и движок ответов,
              а «сохранённых запросов» в продукте не существует вовсе. */}
          <ButtonSecondary onClick={() => setSaving(true)} disabled={!result}>
            Сохранить
          </ButtonSecondary>
        </div>

        {/* Левая колонка фиксирована в 440 px по макету и не сжимается: ниже 1280
            правой оставалось сто пикселей, и ответ читать было негде.
            Колонки встают друг под другом, страница начинает прокручиваться. */}
        <div className="flex min-h-0 flex-1 gap-[20px] max-xl:flex-col max-xl:overflow-y-auto max-xl:scrollbar-thin">
          {/* Колонка запроса */}
          <div className="flex min-w-0 flex-col gap-[20px] max-xl:shrink-0 xl:w-[440px] xl:shrink-0">
            <Panel className="min-h-0 flex-1">
              <Tabs
                items={[
                  { value: 'params', label: 'Параметры', count: params.filter((p) => p.enabled && p.key).length },
                  { value: 'headers', label: 'Заголовки' },
                  { value: 'body', label: 'Тело' },
                  { value: 'auth', label: 'Авторизация' },
                ]}
                value={leftTab}
                onChange={setLeftTab}
              />
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-[16px]">
                {leftTab === 'params' ? (
                  <>
                    <div className="mb-[8px] flex items-center justify-between">
                      <Overline>Query-параметры</Overline>
                      <button
                        type="button"
                        onClick={() => setParams((r) => [...r, newRow()])}
                        className="inline-flex items-center gap-[4px] text-[12px] font-medium text-accent"
                      >
                        <Plus size={12} aria-hidden /> Добавить
                      </button>
                    </div>
                    <ul className="flex flex-col gap-[6px]">
                      {params.map((row) => (
                        <li key={row.id} className="flex items-center gap-[8px]">
                          <input
                            type="checkbox"
                            checked={row.enabled}
                            onChange={(e) => updateRow(row.id, { enabled: e.target.checked })}
                            aria-label={`Включить параметр ${row.key || 'новый'}`}
                            className="h-[15px] w-[15px] shrink-0 accent-accent"
                          />
                          <input
                            value={row.key}
                            onChange={(e) => updateRow(row.id, { key: e.target.value, enabled: true })}
                            placeholder="ключ"
                            className="min-w-0 flex-1 rounded-[6px] border border-border bg-surface px-[8px] py-[6px] font-mono text-[12px] outline-none focus:border-accent"
                          />
                          <input
                            value={row.value}
                            onChange={(e) => updateRow(row.id, { value: e.target.value })}
                            placeholder="значение"
                            className="min-w-0 flex-1 rounded-[6px] border border-border bg-surface px-[8px] py-[6px] font-mono text-[12px] text-accent outline-none focus:border-accent"
                          />
                          <button
                            type="button"
                            aria-label="Удалить параметр"
                            onClick={() => setParams((rows) => (rows.length > 1 ? rows.filter((r) => r.id !== row.id) : rows))}
                            className="shrink-0 text-text-tertiary hover:text-danger"
                          >
                            <Trash2 size={13} aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : leftTab === 'body' ? (
                  <>
                    <Overline>Тело запроса · JSON</Overline>
                    <textarea
                      value={bodyText}
                      onChange={(e) => setBodyText(e.target.value)}
                      spellCheck={false}
                      placeholder={'{\n  "limit": 50\n}'}
                      className="mt-[8px] h-[280px] w-full resize-none rounded-[6px] bg-code-bg p-[12px] font-mono text-[12px] leading-[1.35] text-code-text outline-none"
                    />
                  </>
                ) : leftTab === 'auth' ? (
                  <div className="flex flex-col gap-[10px]">
                    <Overline>Авторизация</Overline>
                    <p className="text-[13px] leading-[1.5] text-text-secondary">
                      Ключ песочницы подставляется автоматически — консоль ходит от вашего аккаунта.
                    </p>
                    <p className="text-[12px] leading-[1.5] text-text-tertiary">
                      В своём коде передавайте ключ так же, как боевому сервису:{' '}
                      <span className="text-text-secondary">{activeService?.nativeAuth}</span>
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-[10px]">
                    <Overline>Заголовки</Overline>
                    <p className="text-[13px] leading-[1.5] text-text-secondary">
                      Сценарий и задержка задаются заголовками{' '}
                      <span className="font-mono text-[12px]">X-Mock-Scenario</span> и{' '}
                      <span className="font-mono text-[12px]">X-Mock-Delay</span>.
                      Ниже в карточке сценария — то же самое кликом.
                    </p>
                  </div>
                )}
              </div>
            </Panel>

            {/* Карточка сценария ответа */}
            <Panel className="shrink-0">
              <div className="flex items-center justify-between px-[16px] pt-[14px]">
                <Overline>Сценарий ответа</Overline>
                <span className="text-[11px] text-text-tertiary">Применится к следующему вызову</span>
              </div>
              <div className="grid grid-cols-2 gap-[8px] p-[16px]">
                {SCENARIOS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setScenario(s.value)}
                    className={`flex flex-col items-start gap-[2px] rounded-[6px] border px-[10px] py-[8px] text-left transition-colors ${
                      scenario === s.value ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-2'
                    }`}
                  >
                    <span className="flex items-center gap-[6px] text-[12px] font-medium text-text-primary">
                      <span className={`h-[10px] w-[10px] rounded-full border-[3px] ${scenario === s.value ? 'border-accent bg-surface' : 'border-border-strong bg-surface'}`} aria-hidden />
                      {s.label}
                    </span>
                    <span className="pl-[16px] font-mono text-[11px] text-text-tertiary">{s.hint}</span>
                  </button>
                ))}
              </div>
            </Panel>
          </div>

          {/* Колонка ответа */}
          <div className="flex min-w-0 flex-1 flex-col gap-[20px] max-xl:min-h-[520px]">
            <Panel className="min-h-0 flex-1">
              <PanelHeader
                title={
                  result ? (
                    <span className="flex items-center gap-[10px]">
                      <StatusCodeChip code={result.status} />
                      <span className="font-mono text-[12px] text-text-secondary tabular">{formatMs(result.durationMs)}</span>
                      <span className="font-mono text-[12px] text-text-secondary tabular">{formatBytes(result.sizeBytes)}</span>
                    </span>
                  ) : (
                    'Ответ'
                  )
                }
                right={
                  result ? (
                    <>
                      <span className="text-[11px] text-text-tertiary">{SOURCE_LABEL[result.responseSource]}</span>
                      <IconButton aria-label="Копировать ответ" onClick={() => void navigator.clipboard.writeText(responseJson)}>
                        <Copy size={16} aria-hidden />
                      </IconButton>
                      <IconButton aria-label="Скачать ответ">
                        <FileDown size={16} aria-hidden />
                      </IconButton>
                    </>
                  ) : null
                }
              />
              <Tabs
                items={[
                  { value: 'response', label: 'Ответ' },
                  { value: 'headers', label: 'Заголовки', count: result ? Object.keys(result.headers).length : undefined },
                  { value: 'curl', label: 'cURL' },
                ]}
                value={rightTab}
                onChange={setRightTab}
              />
              <div className="min-h-0 flex-1 overflow-hidden p-[16px]">
                {pending ? (
                  <SkeletonRows rows={8} />
                ) : error ? (
                  <div className="flex h-full flex-col items-center justify-center gap-[10px] text-center">
                    <p className="text-[14px] font-semibold text-text-primary">Не удалось выполнить запрос</p>
                    <p className="text-[13px] text-text-secondary">{error}</p>
                    <ButtonSecondary onClick={() => void send()}>Повторить</ButtonSecondary>
                  </div>
                ) : !result ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-[13px] text-text-tertiary">
                      Нажмите «Отправить» или Ctrl/Cmd + Enter
                    </p>
                  </div>
                ) : rightTab === 'response' ? (
                  <CodeBlock code={responseJson} showLineNumbers className="h-full overflow-auto" />
                ) : rightTab === 'headers' ? (
                  <CodeBlock
                    language="text"
                    code={Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    className="h-full overflow-auto"
                  />
                ) : (
                  <CodeBlock language="text" code={result.curl} className="h-full overflow-auto" />
                )}
              </div>
            </Panel>

            {/* История вызовов */}
            <Panel className="h-[190px] shrink-0">
              <div className="flex items-center justify-between px-[16px] pt-[14px] pb-[8px]">
                <Overline>История вызовов</Overline>
                {history.length > 0 ? <CounterChip>{history.length}</CounterChip> : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {history.length === 0 ? (
                  <p className="px-[16px] py-[12px] text-[12px] text-text-tertiary">
                    Запросов за период не было. Отправьте тестовый запрос.
                  </p>
                ) : (
                  <ul>
                    {history.map((h, i) => (
                      <li key={`${h.requestId}-${i}`}>
                        <button
                          type="button"
                          onClick={() => { setHttpMethod(h.httpMethod); setPath(h.path); setResult(h) }}
                          className="flex w-full items-center gap-[10px] border-b border-border px-[16px] py-[7px] text-left transition-colors last:border-b-0 hover:bg-surface-2"
                        >
                          <span className="shrink-0 font-mono text-[11px] text-text-tertiary tabular">{formatTime(h.at)}</span>
                          <MethodBadge method={h.httpMethod} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary">{h.path}</span>
                          <StatusCodeChip code={h.status} />
                          <span className="shrink-0 font-mono text-[11px] text-text-tertiary tabular">{formatMs(h.durationMs)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          </div>
        </div>
      </main>

      {saving && result ? (
        <CreateMockDialog
          preset={{
            httpMethod,
            path: `/custom${path}`,
            title: `${httpMethod} ${path}`,
            responseStatusCode: result.status,
            responseBody: JSON.stringify(result.body, null, 2),
          }}
          onClose={() => setSaving(false)}
          onCreated={() => { setSaving(false); router.push('/mocks') }}
        />
      ) : null}
    </>
  )
}

export default function ConsolePage() {
  return (
    <Suspense fallback={<div className="p-[24px] text-[13px] text-text-tertiary">Загрузка…</div>}>
      <ConsoleScreen />
    </Suspense>
  )
}
