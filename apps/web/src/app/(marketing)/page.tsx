import { EVENTS } from '@apistend/shared'
import { API_URL } from '@/lib/api'
import type { CatalogListItem, CatalogResponse, ServiceSummary } from '@/lib/types'
import { LandingNav } from '@/components/landing/LandingNav'
import { Hero } from '@/components/landing/Hero'
import { StatusStrip } from '@/components/landing/StatusStrip'
import { Compatible } from '@/components/landing/Compatible'
import { Services } from '@/components/landing/Services'
import { Features } from '@/components/landing/Features'
import { WebhooksLocal } from '@/components/landing/WebhooksLocal'
import { Steps } from '@/components/landing/Steps'
import { EnvDiff } from '@/components/landing/EnvDiff'
import { StackTabs } from '@/components/landing/StackTabs'
import { Triptych } from '@/components/landing/Triptych'
import { CatalogPreview } from '@/components/landing/CatalogPreview'
import { Integrations } from '@/components/landing/Integrations'
import { PricingCards } from '@/components/landing/PricingCards'
import { Trust } from '@/components/landing/Trust'
import { FinalCta } from '@/components/landing/FinalCta'
import { LandingFooter } from '@/components/landing/LandingFooter'

/**
 * Публичный лендинг. Макет «Лендинг — APIStend» в APIStend.pen.
 *
 * Страница только собирает секции и раздаёт им данные — вёрстка каждой лежит
 * в своём файле в components/landing. Секций семнадцать, и одним файлом это
 * переставало читаться.
 *
 * Все числа — из живого каталога, а не из вёрстки: каталог наполняется волнами,
 * и витрина обязана показывать то, что есть на самом деле, вместе с датой снимка.
 */

// Числа берём при каждом запросе: каталог меняется между волнами ингеста.
export const dynamic = 'force-dynamic'

interface ServicesResponse {
  services: ServiceSummary[]
  totalMethods: number
}

async function loadServices(): Promise<ServicesResponse | null> {
  try {
    const res = await fetch(`${API_URL}/api/services`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as ServicesResponse
  } catch {
    // Лендинг обязан открываться, даже если API недоступен: покажем «—» вместо чисел.
    return null
  }
}

/**
 * Витрина методов для hero и таблицы каталога.
 *
 * Шесть методов из макета — но не строками из вёрстки, а настоящими записями
 * каталога: витрина обязана вести на метод, который в этой волне действительно
 * есть. Список опознаваемый (сделки, отправления, остатки), потому что первые
 * по алфавиту методы сервиса — это bizproc.activity.add и подобное, по которому
 * посетитель не узнаёт свой сценарий.
 *
 * Если каталог перестроили и метода по идентификатору больше нет, берём начало
 * каталога сервиса: пустая витрина хуже неидеальной.
 */
const FEATURED_IDS = [
  'bitrix24:POST:/rest/crm.deal.list',
  'ozon:POST:/v3/posting/fbs/list',
  'wildberries:POST:/api/v3/stocks/{warehouseId}',
  'bitrix24:POST:/rest/crm.lead.add',
  'ozon:POST:/v3/product/import',
  'wildberries:POST:/content/v2/cards/upload',
] as const

async function loadById(id: string): Promise<CatalogListItem | null> {
  try {
    const res = await fetch(`${API_URL}/api/catalog/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as CatalogListItem
  } catch {
    return null
  }
}

async function loadFirstOfEach(services: ServiceSummary[]): Promise<CatalogListItem[]> {
  const pages = await Promise.all(
    services.map(async (s) => {
      try {
        const res = await fetch(`${API_URL}/api/catalog?service=${s.code}&limit=2`, { cache: 'no-store' })
        if (!res.ok) return []
        return ((await res.json()) as CatalogResponse).methods
      } catch {
        return []
      }
    }),
  )
  return pages.flat()
}

async function loadFeatured(services: ServiceSummary[]): Promise<CatalogListItem[]> {
  const picked = (await Promise.all(FEATURED_IDS.map(loadById))).filter((m): m is CatalogListItem => m !== null)
  if (picked.length === FEATURED_IDS.length) return picked
  const fallback = await loadFirstOfEach(services)
  // Дополняем добором, не подменяя найденное: дубликаты по id отсеиваем.
  const seen = new Set(picked.map((m) => m.id))
  return [...picked, ...fallback.filter((m) => !seen.has(m.id))].slice(0, FEATURED_IDS.length)
}

export default async function LandingPage() {
  const data = await loadServices()
  const services = data?.services ?? []
  const totalMethods = data?.totalMethods ?? null
  const featured = services.length > 0 ? await loadFeatured(services) : []
  const eventTypes = EVENTS.length

  return (
    <div className="min-h-screen bg-night">
      <LandingNav />
      <Hero totalMethods={totalMethods} featured={featured} />
      <StatusStrip services={services} totalMethods={totalMethods} eventTypes={eventTypes} />
      <Compatible />
      <Services services={services} />
      <Features />
      <WebhooksLocal eventTypes={eventTypes} />
      <Steps services={services} />
      <EnvDiff services={services} />
      <StackTabs services={services} />
      <Triptych totalMethods={totalMethods} />
      <CatalogPreview totalMethods={totalMethods} eventTypes={eventTypes} featured={featured} />
      <Integrations />
      <PricingCards />
      <Trust />
      <FinalCta />
      <LandingFooter />
    </div>
  )
}
