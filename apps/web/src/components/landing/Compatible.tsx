import { Boxes, Briefcase, Package, Send, ShoppingCart, Workflow, type LucideIcon } from 'lucide-react'

/**
 * Строка совместимости под полосой статуса. Макет: «Section Compatible».
 *
 * Здесь нет ни одного измеряемого числа: это утверждение о том, с чем работает
 * шлюз, и оно верно — Bitrix24, Ozon Seller и Wildberries лежат в каталоге,
 * 1С ходит в мок обычным HTTP, а Postman и GitHub Actions — просто клиенты
 * к тому же адресу. Поэтому секция перенесена как есть.
 */

const ITEMS: ReadonlyArray<{ label: string; Icon: LucideIcon }> = [
  { label: '1С', Icon: Boxes },
  { label: 'Bitrix24', Icon: Briefcase },
  { label: 'Ozon Seller', Icon: ShoppingCart },
  { label: 'Wildberries', Icon: Package },
  { label: 'Postman', Icon: Send },
  /* В макете иконка `github`, но в lucide 1.x брендовых иконок больше нет.
     Workflow — ближайшая по смыслу: GitHub Actions это и есть workflow. */
  { label: 'GitHub Actions', Icon: Workflow },
]

export function Compatible() {
  return (
    <section className="bg-night px-[20px] pt-[40px] pb-[44px] md:px-[80px]">
      <div className="mx-auto flex max-w-[1280px] flex-col items-center gap-[22px]">
        <p className="max-w-[600px] text-center text-[13px] font-medium tracking-[0.2px] text-night-dim">
          Работает с тем, что уже есть в вашем проекте
        </p>

        {/* На узком шесть чипов переносятся построчно — в макете они в одну строку. */}
        <div className="flex flex-wrap justify-center gap-[12px]">
          {ITEMS.map(({ label, Icon }) => (
            <span
              key={label}
              /* В экспорте радиус 8 px, но в проекте шкала 6/10/14/20 — берём ближайший. */
              className="flex items-center gap-[9px] rounded-[10px] border border-night-line bg-night-2 px-[16px] py-[10px] text-[13px] font-medium text-night-text"
            >
              <Icon size={15} className="shrink-0 text-night-dim" aria-hidden />
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
