import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      title="Сервисы"
      wave="в макете не нарисован"
      description="Карточки трёх демо-сервисов с состоянием моков и историей обновлений. Пока сводка по сервисам доступна на «Каталоге API»."
      ready={[
        { label: 'Каталог API', href: '/catalog' },
        { label: 'Консоль запросов', href: '/console' },
        { label: 'Ключи и токены', href: '/keys' },
      ]}
    />
  )
}
