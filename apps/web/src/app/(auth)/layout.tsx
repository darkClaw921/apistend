import Link from 'next/link'
import { PlugZap } from 'lucide-react'

/** Экраны входа и регистрации в макете не нарисованы — собраны из готовых компонентов. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-[24px] py-[40px]">
      <Link href="/" className="mb-[24px] flex items-center gap-[10px]">
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-accent">
          <PlugZap size={17} className="text-white" aria-hidden />
        </span>
        <span className="flex flex-col">
          <span className="text-[15px] leading-tight font-bold text-text-primary">APIStend</span>
          <span className="text-[10px] text-text-tertiary">демо-API для интеграций</span>
        </span>
      </Link>
      <main className="w-full max-w-[420px]">{children}</main>
    </div>
  )
}
