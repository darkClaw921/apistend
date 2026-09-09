'use client'

import { useEffect, useState } from 'react'
import { cn } from '@apistend/ui'
import type { DocHeading } from '@/lib/docs/source'

/**
 * Оглавление текущей страницы. Собирается из h2/h3 при сборке — здесь только
 * подсветка текущего раздела при прокрутке.
 *
 * Слежение через IntersectionObserver, а не через scroll + getBoundingClientRect:
 * последнее считает положение всех заголовков на каждый кадр прокрутки.
 * Полоса наблюдения сдвинута вниз от шапки (64 px) и обрезана снизу, чтобы
 * «текущим» считался заголовок у верхнего края экрана, а не любой видимый.
 */
export function DocsToc({ headings, hideLabel = false }: { headings: DocHeading[]; hideLabel?: boolean }) {
  const [active, setActive] = useState<string | null>(headings[0]?.id ?? null)

  useEffect(() => {
    if (headings.length === 0) return
    const nodes = headings
      .map((h) => document.getElementById(h.id))
      .filter((n): n is HTMLElement => n !== null)
    if (nodes.length === 0) return

    /**
     * В полосу наблюдения не всегда попадает хоть один заголовок: у длинного
     * раздела и в самом низу страницы её пересекать нечему, и подсветка
     * оставалась бы на заголовке, мимо которого прокрутка прошла давно.
     * В этом случае берём последний заголовок выше верхнего края.
     */
    function fallback() {
      let current: string | null = nodes[0]?.id ?? null
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= 120) current = node.id
        else break
      }
      setActive(current)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
        else fallback()
      },
      { rootMargin: '-72px 0px -70% 0px', threshold: 0 },
    )
    fallback()
    nodes.forEach((n) => observer.observe(n))
    return () => observer.disconnect()
  }, [headings])

  if (headings.length === 0) return null

  return (
    <nav aria-label="Содержание страницы" className="flex flex-col gap-[8px]">
      {/* На узком экране заголовок уже есть в самой сворачивающейся строке. */}
      {hideLabel ? null : (
        <p className="text-[10px] font-semibold tracking-[0.6px] text-text-tertiary uppercase">На этой странице</p>
      )}
      <ul className="flex flex-col gap-[1px] border-l border-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                '-ml-px block border-l py-[4px] text-[12px] leading-[1.45] transition-colors',
                h.level === 3 ? 'pl-[22px]' : 'pl-[12px]',
                active === h.id
                  ? 'border-accent font-medium text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
