'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ButtonPrimary, Panel } from '@apistend/ui'
import { api, ApiError } from '@/lib/api'
import { Field, FormError } from '@/components/Field'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      await api.post('/api/auth/login', { email, password })
      router.replace('/catalog')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти')
      setPending(false)
    }
  }

  return (
    <Panel>
      <form onSubmit={submit} className="flex flex-col gap-[16px] p-[24px]">
        <div className="flex flex-col gap-[4px]">
          <h2 className="text-[17px] font-bold tracking-[-0.2px] text-text-primary">Вход</h2>
          <p className="text-[13px] text-text-secondary">Введите почту и пароль от аккаунта APIStend.</p>
        </div>

        <Field label="Почта" type="email" value={email} onChange={setEmail} autoComplete="email" required autoFocus />
        <Field label="Пароль" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />

        {error ? <FormError>{error}</FormError> : null}

        <ButtonPrimary type="submit" disabled={pending} className="w-full">
          {pending ? 'Входим…' : 'Войти'}
        </ButtonPrimary>

        <p className="text-center text-[12px] text-text-tertiary">
          Нет аккаунта?{' '}
          <Link href="/register" className="font-medium text-accent hover:underline">Создать</Link>
        </p>
      </form>
    </Panel>
  )
}
