import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocsArticle } from '@/components/docs/DocsArticle'
import { getAllDocs, getDoc } from '@/lib/docs/source'

/**
 * Страница документации. Пути перечисляются по файлам content/docs — весь раздел
 * собирается статически.
 */

// Адреса вне списка файлов — это 404, а не попытка отрендерить их на запросе.
export const dynamicParams = false

export function generateStaticParams(): Array<{ slug: string[] }> {
  return getAllDocs()
    .filter((d) => d.segments.length > 0)
    .map((d) => ({ slug: d.segments }))
}

export async function generateMetadata(props: PageProps<'/docs/[...slug]'>): Promise<Metadata> {
  const { slug } = await props.params
  const page = getDoc(slug.join('/'))
  return page ? { title: page.title, description: page.description } : {}
}

export default async function DocsPage(props: PageProps<'/docs/[...slug]'>) {
  const { slug } = await props.params
  const page = getDoc(slug.join('/'))
  if (!page) notFound()
  return <DocsArticle page={page} />
}
