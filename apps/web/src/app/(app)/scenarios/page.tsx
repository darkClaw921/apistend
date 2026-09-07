import { ComingSoon } from '@/components/ComingSoon'

export default function Page() {
  return (
    <ComingSoon
      breadcrumb="Проект «Интеграция 1С» / Сценарии"
      title="Сценарии"
      wave="волна 4"
      description="Цепочки событий: число шагов, задержки, доля ошибок и запуск симуляции."
      ready={['Каталог API', 'Консоль запросов', 'Ключи и токены']}
    />
  )
}
