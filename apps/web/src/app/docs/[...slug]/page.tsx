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

/**
 * Тип пропсов объявлен здесь, а не взят из глобального PageProps.
 *
 * PageProps генерирует сама Next во время сборки, поэтому проверка типов
 * без предварительного билда его не находит: локально всё сходилось,
 * а в CI, где typecheck идёт до сборки, падало.
 */
interface DocsPageProps {
  params: Promise<{ slug: string[] }>
}

export async function generateMetadata(props: DocsPageProps): Promise<Metadata> {
  const { slug } = await props.params
  const page = getDoc(slug.join('/'))
  return page ? { title: page.title, description: page.description } : {}
}

export default async function DocsPage(props: DocsPageProps) {
  const { slug } = await props.params
  const page = getDoc(slug.join('/'))
  if (!page) notFound()
  return <DocsArticle page={page} />
}
