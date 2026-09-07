import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      breadcrumb="Проект «Интеграция 1С» / Настройки"
      title="Настройки"
      wave="в макете не нарисован"
      description="Настройки проекта и аккаунта. Поведение песочницы пока настраивается на экране «Ключи и токены»."
      ready={['Каталог API', 'Консоль запросов', 'Ключи и токены']}
    />
  )
}
