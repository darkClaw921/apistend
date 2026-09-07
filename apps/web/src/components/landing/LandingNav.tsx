import Link from 'next/link'
import { PlugZap } from 'lucide-react'

/** Nav лендинга — тёмная, высота 77. design-handoff/screens/08-landing.md, п. 1. */
export function LandingNav() {
  return (
    <nav className="flex h-[77px] items-center gap-[24px] bg-nav-bg px-[20px] md:px-[80px]">
      <Link href="/" className="flex shrink-0 items-center gap-[10px]">
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-accent">
          <PlugZap size={17} className="text-white" aria-hidden />
        </span>
        <span className="text-[17px] font-bold text-white">APIStend</span>
      </Link>

      <ul className="hidden flex-1 items-center gap-[24px] lg:flex">
        {['Возможности', 'Сервисы', 'Вебхуки', 'Документация', 'Цены'].map((item) => (
          <li key={item}>
            <span className="cursor-default text-[14px] text-nav-text transition-colors hover:text-white">{item}</span>
          </li>
        ))}
      </ul>

      <div className="ml-auto flex items-center gap-[16px]">
        <Link href="/login" className="text-[14px] text-nav-text transition-colors hover:text-white">Войти</Link>
        <Link
          href="/register"
          className="rounded-[6px] bg-accent px-[16px] py-[10px] text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover"
        >
          Начать бесплатно
        </Link>
      </div>
    </nav>
  )
}
