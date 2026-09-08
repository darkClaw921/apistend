import { CatalogShell } from '@/components/CatalogShell'

/**
 * Каталог живёт вне группы (app) намеренно: её layout требует сессию и уводит
 * гостя на форму входа, а каталог открыт всем — лендинг ведёт сюда кнопкой
 * «Каталог методов». Адрес страницы при этом не меняется: скобочные группы
 * в маршрут не входят.
 */
export default function CatalogLayout({ children }: { children: React.ReactNode }) {
  return <CatalogShell>{children}</CatalogShell>
}
