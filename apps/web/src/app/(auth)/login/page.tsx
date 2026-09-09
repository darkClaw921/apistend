'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign, Lock } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { AuthScreen, AuthHeading, AuthSwitch, CliHint } from '@/components/auth/AuthScreen'
import { AuthField, AuthSubmit, AuthError } from '@/components/auth/AuthField'
import { Terminal, Metrics, Comments, type Span } from '@/components/auth/Showcase'

/**
 * Вход. Макет: «Экран — Вход» в APIStend.pen.
 *
 * Из макета не перенесены три кнопки OAuth, «Забыли пароль?» и «Запомнить
 * на 30 дней»: ни входа через GitHub/GitLab/Яндекс, ни восстановления пароля,
 * ни настраиваемого срока сессии в продукте нет. Нарисовать их значило бы
 * поставить на экран три кнопки, которые ничего не делают.
 */

const LINES: Array<Span[] | null> = [
  [{ t: '$ ', c: 'muted' }, { t: 'npx apistend login --api-key stend_sk_9f2a…', c: 'key' }],
  [{ t: '✓ ', c: 'ok' }, { t: 'ключ сохранён в ~/.apistend/config.json' }],
  [{ t: '✓ ', c: 'ok' }, { t: 'песочница sandbox-01 · проект «Интеграция 1С»' }],
  null,
  [{ t: '$ ', c: 'muted' }, { t: 'curl ', c: 'key' }, { t: 'https://apistend.ru/oz/v3/posting/fbs/list \\', c: 'str' }],
  [{ t: '     -H ', c: 'key' }, { t: '"Api-Key: stend_sbx_7f3a…"', c: 'str' }],
  null,
  [{ t: '{' }],
  [{ t: '  "result"', c: 'key' }, { t: ': {' }],
  [{ t: '    "postings"', c: 'key' }, { t: ': [' }],
  [{ t: '      { ' }, { t: '"posting_number"', c: 'key' }, { t: ': ' }, { t: '"0132112277-0101-1"', c: 'str' }, { t: ',' }],
  [{ t: '        ' }, { t: '"status"', c: 'key' }, { t: ': ' }, { t: '"awaiting_packaging"', c: 'str' }, { t: ' }' }],
  [{ t: '    ],' }],
  [{ t: '    "count"', c: 'key' }, { t: ': ' }, { t: '24', c: 'num' }],
  [{ t: '  }' }],
  [{ t: '}' }],
  null,
  [{ t: '← 200 OK · 4 мс · sandbox-01', c: 'ok' }],
  [{ t: '$ ', c: 'muted' }, { t: '▍' }],
]

const COMMENTS = [
  '// зачем это нужно',
  '// — не ждать доступ к боевому кабинету клиента',
  '// — ловить 429, 401 и 503 до релиза, а не после',
  '// — вебхуки прилетают прямо на localhost:3000',
] as const

export default function LoginPage() {
  const router = useRouter()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      await api.post('/api/auth/login', { login, password })
      router.replace('/overview')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти')
      setPending(false)
    }
  }

  return (
    <AuthScreen
      showcase={
        <>
          <Terminal path="~/projects/erp-integration" lines={LINES} />
          <Metrics />
          <Comments lines={COMMENTS} />
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-[16px]">
        <AuthHeading
          kicker="// вход в песочницу"
          title="С возвращением"
          subtitle="Демо-API Bitrix24, Ozon, Wildberries и Apify ждут ваши запросы."
        />

        <div className="mt-[12px] flex flex-col gap-[16px]">
          <AuthField
            label="login" icon={AtSign} value={login} onChange={setLogin}
            autoComplete="username" placeholder="igor" required autoFocus
          />
          <AuthField
            label="password" icon={Lock} type="password" value={password} onChange={setPassword}
            autoComplete="current-password" placeholder="••••••••" required
          />
        </div>

        {error ? <AuthError>{error}</AuthError> : null}

        <div className="mt-[4px] flex flex-col gap-[18px]">
          <AuthSubmit pending={pending}>{pending ? 'Входим…' : 'Войти'}</AuthSubmit>
          <AuthSwitch question="Ещё нет песочницы?" href="/register" label="Создать за минуту →" />
        </div>

        <div className="mt-[8px]">
          <CliHint
            command="apistend login --api-key stend_sk_…"
            hint="вход из терминала — серверным ключом с экрана «Ключи»"
          />
        </div>
      </form>
    </AuthScreen>
  )
}
