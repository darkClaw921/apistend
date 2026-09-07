import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      breadcrumb="Проект «Интеграция 1С» / Сервисы"
      title="Сервисы"
      wave="в макете не нарисован"
      description="Карточки трёх демо-сервисов с состоянием моков и историей обновлений. Пока сводка по сервисам доступна на «Каталоге API»."
      ready={['Каталог API', 'Консоль запросов', 'Ключи и токены']}
    />
  )
}
