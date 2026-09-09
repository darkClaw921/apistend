import type { Metadata } from 'next'
import { DocsChrome } from '@/components/docs/DocsChrome'
import { getNavTree, getSearchIndex } from '@/lib/docs/source'

/**
 * Каркас документации.
 *
 * Раздел лежит вне группы (app): документация публичная, вход не требуется,
 * и каркас кабинета с загрузкой профиля и редиректом на /login ей не нужен.
 *
 * Дерево разделов и индекс поиска считаются здесь один раз на сборку и уходят
 * в клиентский каркас пропсами — страницы остаются статическими.
 */

export const metadata: Metadata = {
  title: {
    default: 'Документация APIStend',
    template: '%s — документация APIStend',
  },
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsChrome tree={getNavTree()} index={getSearchIndex()}>
      {children}
    </DocsChrome>
  )
}
