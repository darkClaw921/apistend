import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocsArticle } from '@/components/docs/DocsArticle'
import { getDoc } from '@/lib/docs/source'

/**
 * Корень документации — content/docs/index.md.
 *
 * Отдельным файлом, а не необязательным catch-all: так у первой страницы один
 * адрес (/docs), а не два, и её не приходится дублировать в generateStaticParams.
 */

export function generateMetadata(): Metadata {
  const page = getDoc('')
  return page ? { title: page.title, description: page.description } : {}
}

export default function DocsIndexPage() {
  const page = getDoc('')
  if (!page) notFound()
  return <DocsArticle page={page} />
}
