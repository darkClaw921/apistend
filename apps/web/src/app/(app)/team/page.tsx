import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      title="Команда"
      wave="в макете не нарисован"
      description="Доступ команды к песочнице: приглашения, роли, отдельные ключи на каждого разработчика. Пока ключи выдаются на экране «Ключи и токены»."
      ready={[
        { label: 'Ключи и токены', href: '/keys' },
        { label: 'Каталог API', href: '/catalog' },
        { label: 'Консоль запросов', href: '/console' },
      ]}
    />
  )
}
