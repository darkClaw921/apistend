import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      breadcrumb="Проект «Интеграция 1С» / Команда"
      title="Команда"
      wave="в макете не нарисован"
      description="Доступ команды к песочнице: приглашения, роли, отдельные ключи на каждого разработчика."
      ready={['Каталог API', 'Консоль запросов', 'Ключи и токены']}
    />
  )
}
