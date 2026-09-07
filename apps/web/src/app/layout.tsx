import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import '../styles/globals.css'

/**
 * Шрифты из дизайн-пакета: Inter — интерфейс, JetBrains Mono — машинные значения
 * (пути, JSON, ключи, коды ответов, время, идентификаторы).
 * Подключаются через next/font: файлы отдаются со своего домена, без обращения к Google.
 */
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
})

const mono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '600', '700'],
  variable: '--font-jetbrains',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'APIStend — демо-API для интеграций',
  description:
    'Демо-копии боевых API Bitrix24, Ozon Seller и Wildberries: те же схемы ответов, ' +
    'те же коды ошибок и доставка вебхуков прямо на localhost.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
