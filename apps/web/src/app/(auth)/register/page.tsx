'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ButtonPrimary, CodeBlock, Panel } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { Field, FormError } from '@/components/Field'

export default function RegisterPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await api.post<{ apiKey: string }>('/api/auth/register', { name, email, password })
      // Полный ключ показывается ровно один раз — здесь.
      setApiKey(res.apiKey)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать аккаунт')
      setPending(false)
    }
  }

  if (apiKey) {
    return (
      <Panel>
        <div className="flex flex-col gap-[16px] p-[24px]">
          <div className="flex flex-col gap-[4px]">
            <h2 className="text-[17px] font-bold tracking-[-0.2px] text-text-primary">Песочница готова</h2>
            <p className="text-[13px] leading-[1.5] text-text-secondary">
              Сохраните ключ доступа: полностью он показывается только сейчас.
              Дальше в интерфейсе будет видна только маска.
            </p>
          </div>
          <CodeBlock code={apiKey} language="text" />
          <ButtonPrimary onClick={() => router.replace('/catalog')} className="w-full">
            Перейти в каталог
          </ButtonPrimary>
        </div>
      </Panel>
    )
  }

  return (
    <Panel>
      <form onSubmit={submit} className="flex flex-col gap-[16px] p-[24px]">
        <div className="flex flex-col gap-[4px]">
          <h2 className="text-[17px] font-bold tracking-[-0.2px] text-text-primary">Создать песочницу</h2>
          <p className="text-[13px] text-text-secondary">Без карты и без лимитов на запросы.</p>
        </div>

        <Field label="Имя" value={name} onChange={setName} autoComplete="name" required autoFocus />
        <Field label="Почта" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <Field
          label="Пароль" type="password" value={password} onChange={setPassword}
          autoComplete="new-password" required hint="Не короче 8 символов"
        />

        {error ? <FormError>{error}</FormError> : null}

        <ButtonPrimary type="submit" disabled={pending} className="w-full">
          {pending ? 'Создаём…' : 'Создать песочницу'}
        </ButtonPrimary>

        <p className="text-center text-[12px] text-text-tertiary">
          Уже есть аккаунт?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">Войти</Link>
        </p>
      </form>
    </Panel>
  )
}
