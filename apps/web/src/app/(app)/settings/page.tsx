import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      title="Настройки"
      wave="в макете не нарисован"
      description="Настройки проекта и аккаунта. Поведение песочницы — задержка, доля ошибок, объём данных — пока настраивается на экране «Ключи и токены»."
      ready={[
        { label: 'Ключи и токены', href: '/keys' },
        { label: 'Каталог API', href: '/catalog' },
        { label: 'Консоль запросов', href: '/console' },
      ]}
    />
  )
}
