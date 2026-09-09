import Link from 'next/link'
import type { Route } from 'next'
import { ArrowLeft, ArrowRight, PencilLine } from 'lucide-react'
import { docHref, editUrl, getNeighbours, type DocPage } from '@/lib/docs/source'
import { DocMarkdown } from './Markdown'
import { DocsToc } from './DocsToc'

/**
 * Страница документации: колонка текста и оглавление справа.
 *
 * Ширина текста ограничена 720 px — это около 70 знаков при 14 px, дальше строка
 * читается заметно хуже. Всё, что шире (таблицы, код), скроллится внутри себя,
 * а не растягивает страницу: горизонтальной прокрутки у документа нет ни на 320,
 * ни на 1440.
 */
export function DocsArticle({ page }: { page: DocPage }) {
  const { prev, next } = getNeighbours(page.slug)

  return (
    <main className="min-w-0 flex-1 px-[16px] py-[28px] sm:px-[28px] lg:px-[44px]">
      <div className="mx-auto flex max-w-[1024px] gap-[44px]">
        <article className="min-w-0 max-w-[720px] flex-1">
          {page.group ? (
            <p className="mb-[8px] text-[11px] font-semibold tracking-[0.6px] text-text-tertiary uppercase">
              {page.group}
            </p>
          ) : null}
          <h1 className="text-[28px] leading-[1.2] font-bold tracking-[-0.4px] text-text-primary">{page.title}</h1>
          {page.description ? (
            <p className="mt-[10px] text-[15px] leading-[1.6] text-text-secondary">{page.description}</p>
          ) : null}

          <div className="mt-[8px]">
            <DocMarkdown nodes={page.nodes} headings={page.headings} />
          </div>

          {/* Оглавление на узком экране — под текстом: справа для него места нет,
              а выбрасывать его совсем значит оставить длинную страницу без карты. */}
          <div className="mt-[36px] border-t border-border pt-[20px] xl:hidden">
            <DocsToc headings={page.headings} />
          </div>

          <footer className="mt-[36px] flex flex-col gap-[16px] border-t border-border pt-[20px]">
            <a
              href={editUrl(page.repoPath)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-[7px] self-start text-[13px] text-text-secondary transition-colors hover:text-accent"
            >
              <PencilLine size={14} aria-hidden />
              Поправить эту страницу на GitHub
            </a>

            <nav aria-label="Соседние разделы" className="grid gap-[10px] sm:grid-cols-2">
              {prev ? (
                <Link
                  href={docHref(prev.slug) as Route}
                  className="group flex flex-col gap-[3px] rounded-[10px] border border-border bg-surface px-[14px] py-[11px] transition-colors hover:border-border-strong hover:bg-surface-2"
                >
                  <span className="flex items-center gap-[6px] text-[11px] text-text-tertiary">
                    <ArrowLeft size={12} aria-hidden /> Предыдущая
                  </span>
                  <span className="text-[14px] font-medium text-text-primary">{prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link
                  href={docHref(next.slug) as Route}
                  className="group flex flex-col items-end gap-[3px] rounded-[10px] border border-border bg-surface px-[14px] py-[11px] text-right transition-colors hover:border-border-strong hover:bg-surface-2 sm:col-start-2"
                >
                  <span className="flex items-center gap-[6px] text-[11px] text-text-tertiary">
                    Следующая <ArrowRight size={12} aria-hidden />
                  </span>
                  <span className="text-[14px] font-medium text-text-primary">{next.title}</span>
                </Link>
              ) : null}
            </nav>
          </footer>
        </article>

        <aside className="sticky top-[88px] hidden max-h-[calc(100vh-112px)] w-[204px] shrink-0 overflow-y-auto scrollbar-thin py-[4px] xl:block">
          <DocsToc headings={page.headings} />
        </aside>
      </div>
    </main>
  )
}
