'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mail, Lock, FolderGit2, Check, Copy } from 'lucide-react'
import { api, ApiError, API_URL } from '@/lib/api'
import { AuthScreen, AuthHeading, AuthSwitch, CliHint, AUTH_COLORS as C } from '@/components/auth/AuthScreen'
import { AuthField, AuthSubmit, AuthError } from '@/components/auth/AuthField'
import { Terminal, Metrics, Comments, type Span } from '@/components/auth/Showcase'

/**
 * Регистрация. Макет: «Экран — Регистрация» в APIStend.pen.
 *
 * Поле «project» из макета настоящее: имя проекта уходит на сервер и стоит
 * в хлебных крошках кабинета. Кнопки OAuth и галочка «принимаю условия»
 * не перенесены: входа через GitHub у продукта нет, а документа с условиями,
 * на который можно сослаться, — тем более.
 */

const LINES: Array<Span[] | null> = [
  [{ t: '$ ', c: 'muted' }, { t: 'npx apistend login --api-key stend_sk_…', c: 'key' }],
  [{ t: '✓ ', c: 'ok' }, { t: 'песочница sandbox-01 создана' }],
  [{ t: '✓ ', c: 'ok' }, { t: 'ключ stend_sbx_7f3a••••••4c21' }],
  null,
  [{ t: '$ ', c: 'muted' }, { t: 'apistend whoami --json', c: 'key' }],
  null,
  [{ t: '{' }],
  [{ t: '  "account"', c: 'key' }, { t: ': ' }, { t: '"Интеграция 1С"', c: 'str' }, { t: ',' }],
  [{ t: '  "sandbox"', c: 'key' }, { t: ': ' }, { t: '"sandbox-01"', c: 'str' }, { t: ',' }],
  [{ t: '  "services"', c: 'key' }, { t: ': ' }, { t: '["bitrix24", "ozon", "wildberries"]', c: 'str' }, { t: ',' }],
  [{ t: '  "methods"', c: 'key' }, { t: ': ' }, { t: '2421', c: 'num' }, { t: ', ' }, { t: '"limits"', c: 'key' }, { t: ': ' }, { t: 'null', c: 'num' }],
  [{ t: '}' }],
  null,
  [{ t: '$ ', c: 'muted' }, { t: 'apistend listen --forward localhost:3000', c: 'key' }],
  [{ t: '← события идут на вашу машину · туннель поднят', c: 'ok' }],
  [{ t: '$ ', c: 'muted' }, { t: '▍' }],
]

const COMMENTS = [
  '// что дальше',
  '// 1 — подменить базовый адрес в .env',
  '// 2 — дёрнуть первый метод из консоли',
  '// 3 — включить вебхуки на localhost:3000',
] as const

/** Базовый адрес шлюза — тот же, что у API: моки живут на нём. */
const gatewayBase = API_URL

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [project, setProject] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await api.post<{ apiKey: string }>('/api/auth/register', {
        email,
        password,
        project: project.trim() || undefined,
      })
      // Полный ключ показывается ровно один раз — здесь.
      setApiKey(res.apiKey)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать аккаунт')
      setPending(false)
    }
  }

  async function copyKey() {
    if (!apiKey) return
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер обмена недоступен — ключ виден и его можно выделить */ }
  }

  const showcase = (
    <>
      <Terminal path="~/projects/erp-integration" lines={LINES} />
      <Metrics />
      <Comments lines={COMMENTS} />
    </>
  )

  if (apiKey) {
    return (
      <AuthScreen showcase={showcase}>
        <div className="flex flex-col gap-[16px]">
          <AuthHeading
            kicker="// песочница готова"
            title="Ключ выдан"
            subtitle="Полностью он показывается только сейчас — дальше в интерфейсе видна одна маска."
          />

          <button
            type="button"
            onClick={() => void copyKey()}
            className="mt-[12px] flex items-center gap-[10px] rounded-[6px] px-[14px] py-[13px] text-left"
            style={{ background: C.chip, border: `1px solid ${C.lineStrong}` }}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]" style={{ color: C.white }}>
              {apiKey}
            </span>
            {copied
              ? <Check size={15} className="shrink-0" color={C.ok} aria-hidden />
              : <Copy size={15} className="shrink-0" color={C.dim} aria-hidden />}
          </button>

          <button
            type="button"
            onClick={() => router.replace('/overview')}
            className="mt-[4px] flex w-full items-center justify-center rounded-[6px] px-[20px] py-[14px] text-[14px] font-semibold"
            style={{ background: C.accent, color: C.white }}
          >
            Открыть песочницу
          </button>

          {/* Выдан ключ песочницы (stend_sbx_) — он идёт в заголовке запроса
              к моку. Для CLI нужен серверный ключ stend_sk_, и предлагать
              здесь `apistend login` с этим ключом было бы враньём. */}
          <CliHint
            command={`curl -H "X-Mock-Key: ${apiKey.slice(0, 14)}…" ${gatewayBase}/b24/rest/crm.deal.list`}
            hint="ключ песочницы подставляется в заголовок запроса к моку"
          />
        </div>
      </AuthScreen>
    )
  }

  return (
    <AuthScreen showcase={showcase}>
      <form onSubmit={submit} className="flex flex-col gap-[16px]">
        <AuthHeading
          kicker="// новая песочница · 30 секунд"
          title="Создать песочницу"
          subtitle="Без карты и без лимитов. Ключ и базовые адреса моков выдаются сразу после регистрации."
        />

        <div className="mt-[12px] flex flex-col gap-[16px]">
          <AuthField
            label="email" icon={Mail} type="email" value={email} onChange={setEmail}
            autoComplete="email" placeholder="igor@acme.ru" required autoFocus
          />
          <AuthField
            label="password" hint="минимум 8 символов" icon={Lock} type="password"
            value={password} onChange={setPassword}
            autoComplete="new-password" placeholder="••••••••" required minLength={8}
          />
          <AuthField
            label="project" hint="можно изменить позже" icon={FolderGit2}
            value={project} onChange={setProject}
            placeholder="Первый проект" maxLength={80}
          />
        </div>

        {error ? <AuthError>{error}</AuthError> : null}

        <div className="mt-[4px] flex flex-col gap-[18px]">
          <AuthSubmit pending={pending}>{pending ? 'Создаём…' : 'Создать песочницу'}</AuthSubmit>
          <AuthSwitch question="Уже есть аккаунт?" href="/login" label="Войти →" />
        </div>

        <div className="mt-[8px]">
          <CliHint
            command="apistend listen --forward localhost:3000"
            hint="после регистрации события пойдут прямо на вашу машину"
          />
        </div>
      </form>
    </AuthScreen>
  )
}
