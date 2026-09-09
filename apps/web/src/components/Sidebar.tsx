'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, LibraryBig, Boxes, Terminal, ScrollText, Webhook, GitBranch,
  Database, AppWindow, KeyRound, Users, Settings, PlugZap, ChevronDown, ChevronUp,
  Check, LogOut, Search, Rocket, Zap, ArrowRight, LifeBuoy, BookOpen,
  ChevronsLeft, ChevronsRight, User, type LucideIcon,
} from 'lucide-react'
import { DropdownPanel, KbdChip, NavBadge, NavItem, NavSection, cn, formatInt, plural } from '@apistend/ui'
import { api } from '@/lib/api'
import type { Me } from '@/lib/types'
import { NotificationsBell } from './NotificationsBell'

/**
 * Сайдбар. Макет «Screen Template v2» в APIStend.pen (переработан).
 *
 * Что изменилось против первой версии: наверху вместо логотипа — аккаунт
 * с переключателем, под ним строка поиска и колокольчик, затем «Первые шаги»,
 * и только потом разделы. Логотип уехал в подвал, туда же — справка и сворачивание.
 *
 * Числа в пунктах и в блоке использования приходят из /api/auth/me и посчитаны
 * по базе. В вёрстке чисел нет — это правило приёмки, а не вкусовщина: раньше
 * сюда были зашиты 128 940 из демо-данных, и их видел каждый, кто регистрировался.
 */

interface NavEntry {
  href: Route
  label: string
  icon: LucideIcon
  /** Ключ счётчика в me.counts. Пункт без счётчика бейджа не показывает. */
  badge?: 'catalogMethods' | 'mocks'
}

/**
 * Первая группа идёт без заголовка — так в макете.
 *
 * «Сервисы» и «Локальные приложения» в макете v2 из меню пропали, но экраны
 * никуда не делись. Оставляем их: страница, на которую нельзя попасть, —
 * это ровно тот дефект, который в прошлый раз чинили по всему кабинету.
 */
const MAIN: readonly NavEntry[] = [
  { href: '/overview', label: 'Обзор', icon: LayoutDashboard },
  { href: '/catalog', label: 'Каталог API', icon: LibraryBig, badge: 'catalogMethods' },
  { href: '/services', label: 'Сервисы', icon: Boxes },
  { href: '/console', label: 'Консоль запросов', icon: Terminal },
  { href: '/logs', label: 'Логи запросов', icon: ScrollText },
]

const GROUPS: ReadonlyArray<{ title: string; items: readonly NavEntry[] }> = [
  {
    title: 'Разработка',
    items: [
      { href: '/mocks', label: 'Свои моки', icon: Database, badge: 'mocks' },
      { href: '/webhooks', label: 'Вебхуки', icon: Webhook },
      { href: '/scenarios', label: 'Сценарии', icon: GitBranch },
      { href: '/apps', label: 'Локальные приложения', icon: AppWindow },
    ],
  },
  {
    title: 'Проект',
    items: [
      { href: '/keys', label: 'Ключи и токены', icon: KeyRound },
      { href: '/team', label: 'Команда', icon: Users },
      { href: '/settings', label: 'Настройки', icon: Settings },
    ],
  },
]

const COLLAPSE_KEY = 'apistend.sidebar.collapsed'
const GITHUB_ISSUES = 'https://github.com/darkClaw921/apistend/issues'

export function Sidebar({
  me, open = false, onClose, onSearch,
}: {
  me: Me
  /**
   * Открыт ли сайдбар на узком экране. Макет каркаса требует прямо:
   * «до 1024 px сайдбар — в бургер-меню» (00-app-shell.md). До этого он занимал
   * свои 248 px всегда, и на телефоне от контента оставалась треть ширины.
   */
  open?: boolean
  onClose?: () => void
  /** Открыть палитру поиска. Живёт в каркасе: её же зовёт шапка по ⌘K. */
  onSearch: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  /**
   * Какая панель раскрыта. Одна переменная на обе: аккаунт и уведомления стоят
   * в сайдбаре в двадцати пикселях друг от друга, и с раздельными состояниями
   * они открывались вдвоём и накладывались.
   */
  const [menu, setMenu] = useState<'account' | 'alerts' | null>(null)
  const accountOpen = menu === 'account'
  const [leaving, setLeaving] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  // Свёрнутый режим только на широком экране: до 1024 сайдбар — шторка,
  // и прятать в ней подписи было бы просто потерей меню.
  const [wide, setWide] = useState(false)

  // Состояние сворачивания переживает переходы между экранами и перезагрузку:
  // разворачивать панель заново на каждом экране — это не «по умолчанию»,
  // а потеря выбора пользователя.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      /* приватный режим — просто остаёмся развёрнутыми */
    }
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setWide(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        /* не сохранилось — на этой сессии всё равно работает */
      }
      return next
    })
  }

  // Переход по разделу на узком экране закрывает шторку: иначе она остаётся
  // поверх только что открытого экрана.
  const closeOnNavigate = () => onClose?.()

  /**
   * Выход. Сессия отзывается на сервере — cookie удалить мало: токен без
   * записи в базе жил бы ещё две недели.
   */
  async function signOut() {
    setLeaving(true)
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* сервер недоступен — уводим на вход всё равно: остаться здесь хуже */
    }
    setMenu(null)
    router.replace('/login')
    router.refresh()
  }

  const sandbox = me.sandboxes[0]
  const steps = me.onboarding
  const doneSteps = steps.filter((s) => s.done).length
  const nextStep = steps.find((s) => !s.done)

  // На узком экране сайдбар — шторка; свёрнутый режим там смысла не имеет
  // и только отнял бы подписи у пунктов.
  const rail = collapsed && wide

  function renderItem(item: NavEntry) {
    const Icon = item.icon
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
    const count = item.badge ? me.counts[item.badge] : 0
    return (
      <li key={item.href}>
        <NavItem
          icon={<Icon size={16} className="shrink-0" aria-hidden />}
          label={item.label}
          active={active}
          compact={rail}
          badge={item.badge && count > 0 ? <NavBadge>{formatInt(count)}</NavBadge> : undefined}
          render={({ className, children }) => (
            <Link
              href={item.href}
              onClick={closeOnNavigate}
              className={className}
              aria-current={active ? 'page' : undefined}
              title={rail ? item.label : undefined}
            >
              {children}
            </Link>
          )}
        />
      </li>
    )
  }

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-40 bg-night/60 lg:hidden" onClick={onClose} aria-hidden />
      ) : null}

      <aside
        className={cn(
          'flex h-full shrink-0 flex-col justify-between border-r border-night-3 bg-nav-bg transition-[width]',
          rail ? 'w-[64px]' : 'w-[248px]',
          'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:transition-transform',
          open ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
        )}
      >
        {/* Скроллится только список разделов, а не вся колонка.
            overflow-y-auto по спецификации превращает и overflow-x в auto, поэтому
            любая абсолютная панель внутри скроллера обрезается по ширине сайдбара:
            меню уведомлений (340 px) показывало из себя 42 px, а кнопка «Выйти»
            в свёрнутом состоянии уезжала за край полосы целиком. Аккаунт, поиск,
            колокольчик и «Первые шаги» вынесены из-под скролла — их панели теперь
            свободно раскрываются вправо поверх содержимого. */}
        <div className={cn('flex min-h-0 flex-1 flex-col px-[10px] pt-[10px]', rail && 'px-[8px]')}>
          {/* Аккаунт. В первой версии переключатель песочницы стоял вверху,
              а выход прятался в многоточии внизу. Макет свёл их в один
              элемент — и это заодно чинит то, что выход было не найти. */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenu(accountOpen ? null : 'account')}
              aria-expanded={accountOpen}
              aria-label="Аккаунт и песочница"
              className={cn(
                'flex w-full items-center rounded-[6px] bg-code-surface text-left transition-colors hover:bg-nav-bg-2',
                rail ? 'justify-center p-[6px]' : 'gap-[10px] p-[8px]',
              )}
            >
              <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-nav-avatar text-[10px] font-semibold text-nav-text">
                {me.user.initials || <User size={14} aria-hidden />}
              </span>
              {rail ? null : (
                <>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-semibold text-nav-text-active">{me.user.name}</span>
                    <span className="truncate text-[11px] text-nav-text">{sandbox?.project ?? me.user.planLabel}</span>
                  </span>
                  <ChevronDown size={14} className="ml-auto shrink-0 text-nav-text" aria-hidden />
                </>
              )}
            </button>

            {accountOpen ? (
              <DropdownPanel onClose={() => setMenu(null)} align="left" label="Аккаунт" className="w-[228px]">
                <p className="border-b border-border px-[14px] py-[10px] text-[12px] break-all text-text-secondary">
                  {me.user.email}
                </p>
                <ul className="flex flex-col border-b border-border py-[6px]">
                  {me.sandboxes.map((s) => (
                    <li key={s.id} className="flex items-center gap-[8px] px-[14px] py-[8px]">
                      <Check size={13} className="shrink-0 text-accent" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-[12px] text-text-primary">{s.name}</span>
                        <span className="truncate text-[11px] text-text-tertiary">{s.project}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {/* Вторая песочница пока не заводится — так и говорим, вместо
                    пункта «Создать», который ничего не создаёт. */}
                <p className="border-b border-border px-[14px] py-[10px] text-[11px] leading-[1.45] text-text-tertiary">
                  Вторая песочница пока не заводится. Объём данных, задержку и долю ошибок
                  настраивают на экране{' '}
                  <Link href="/keys" onClick={() => setMenu(null)} className="font-semibold text-accent">
                    «Ключи и токены»
                  </Link>
                  .
                </p>
                <button
                  type="button"
                  disabled={leaving}
                  onClick={() => void signOut()}
                  className="flex w-full items-center gap-[8px] px-[14px] py-[10px] text-left text-[13px] text-text-primary hover:bg-bg disabled:text-text-tertiary"
                >
                  <LogOut size={14} className="shrink-0" aria-hidden />
                  {leaving ? 'Выходим…' : 'Выйти'}
                </button>
              </DropdownPanel>
            ) : null}
          </div>

          {/* Поиск и уведомления. Обе кнопки зовут то же, что шапка: панель
              на весь кабинет одна, иначе ⌘K открывал бы два диалога сразу. */}
          <div className={cn('mt-[8px] flex shrink-0 items-center gap-[8px]', rail && 'flex-col')}>
            <button
              type="button"
              onClick={() => { closeOnNavigate(); onSearch() }}
              className={cn(
                'flex items-center rounded-[6px] border border-night-line bg-night-2 text-code-muted transition-colors hover:border-nav-border hover:text-nav-text',
                rail ? 'h-[32px] w-[32px] justify-center' : 'min-w-0 flex-1 gap-[8px] px-[10px] py-[7px]',
              )}
              aria-label="Поиск по каталогу"
            >
              <Search size={14} className="shrink-0" aria-hidden />
              {rail ? null : (
                <>
                  <span className="min-w-0 flex-1 truncate text-left text-[13px]">Поиск…</span>
                  <KbdChip>⌘K</KbdChip>
                </>
              )}
            </button>
            {/* Точка означает «уведомления есть»: прочитанность мы не храним. */}
            <NotificationsBell
              dot={me.counts.alerts > 0}
              className={rail ? 'w-full' : 'w-[32px]'}
              open={menu === 'alerts'}
              onOpenChange={(next) => setMenu(next ? 'alerts' : null)}
            />
          </div>

          {/* «Первые шаги». Каждый шаг проверен по данным на сервере, поэтому
              блок исчезает, когда всё пройдено, а не висит вечным «1/4». */}
          {nextStep && !rail ? (
            <Link
              href={nextStep.href as Route}
              onClick={closeOnNavigate}
              className="mt-[12px] flex shrink-0 flex-col gap-[8px] rounded-[6px] px-[10px] py-[9px] transition-colors hover:bg-nav-bg-2"
            >
              <span className="flex items-center gap-[8px]">
                <Rocket size={15} className="shrink-0 text-nav-text" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-night-text">
                  {nextStep.label}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-nav-text">
                  {doneSteps}/{steps.length}
                </span>
              </span>
              <span className="h-[4px] w-full overflow-hidden rounded-[2px] bg-night-3">
                <span
                  className="block h-full rounded-[2px] bg-accent"
                  style={{ width: `${(doneSteps / steps.length) * 100}%` }}
                />
              </span>
            </Link>
          ) : null}

          <div className="my-[10px] h-px shrink-0 bg-night-3" />

          <nav className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pb-[8px]">
            <ul className="flex flex-col gap-[2px]">{MAIN.map(renderItem)}</ul>

            {GROUPS.map((group) => {
              const isFolded = folded[group.title] === true
              return (
                <div key={group.title}>
                  {rail ? (
                    <div className="my-[8px] h-px bg-night-3" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setFolded((f) => ({ ...f, [group.title]: !isFolded }))}
                      aria-expanded={!isFolded}
                      className="flex w-full items-center gap-[8px] text-left"
                    >
                      <NavSection>{group.title}</NavSection>
                      <span className="ml-auto pr-[10px] text-code-muted">
                        {isFolded ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
                      </span>
                    </button>
                  )}
                  {isFolded && !rail ? null : (
                    <ul className="flex flex-col gap-[2px]">{group.items.map(renderItem)}</ul>
                  )}
                </div>
              )
            })}
          </nav>
        </div>

        <div className={cn('flex shrink-0 flex-col px-[10px] pb-[12px]', rail && 'px-[8px]')}>
          {/* Использование. Прогресс-бара здесь нет и не должно быть:
              лимитов на запросы у продукта нет — отдельный пункт чек-листа. */}
          {rail ? null : (
            <dl className="flex flex-col gap-[7px] px-[2px] py-[12px]">
              {[
                ['Запросов сегодня', formatInt(me.counts.requestsToday)],
                ['Свои моки', `${formatInt(me.counts.mocks)} · без лимита`],
                [
                  'Ключи',
                  `${formatInt(me.counts.keys)} ${plural(me.counts.keys, 'активный', 'активных', 'активных')}`,
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-[8px]">
                  <dt className="truncate text-[12px] text-night-dim">{label}</dt>
                  <dd className="shrink-0 font-mono text-[11px] font-medium text-night-text tabular">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* Тариф Pro бесплатен на время беты — это написано и на лендинге,
              кнопка ведёт ровно туда, где условия расписаны. */}
          <a
            href="/#pricing"
            className={cn(
              'flex items-center rounded-[6px] bg-accent text-white transition-colors hover:bg-accent-hover',
              rail ? 'h-[32px] justify-center' : 'gap-[8px] px-[12px] py-[10px]',
            )}
            title={rail ? 'Pro бесплатно в бете' : undefined}
          >
            <Zap size={14} className="shrink-0" aria-hidden />
            {rail ? null : (
              <>
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">Pro бесплатно в бете</span>
                <ArrowRight size={14} className="shrink-0" aria-hidden />
              </>
            )}
          </a>

          <div className="my-[12px] h-px bg-night-3" />

          <div className={cn('flex items-center gap-[8px] px-[2px]', rail && 'flex-col')}>
            <Link href="/" className="flex min-w-0 items-center gap-[7px]" title="APIStend">
              <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] bg-accent">
                <PlugZap size={12} className="text-white" aria-hidden />
              </span>
              {rail ? null : (
                <span className="truncate text-[12px] font-semibold text-night-text">APIStend</span>
              )}
            </Link>
            <span className={cn('ml-auto flex shrink-0 items-center gap-[4px]', rail && 'ml-0')}>
              {/* Документация. Стоит первой в этом ряду: за ответом сюда идут
                  чаще, чем в трекер, а раскладку ряд держит ту же — иконка
                  26×26, как у справки и сворачивания, поэтому и в узкой полосе
                  ничего не разъезжается. */}
              <Link
                href="/docs"
                aria-label="Документация"
                title="Документация"
                className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] bg-night-2 text-nav-text transition-colors hover:text-nav-text-active"
              >
                <BookOpen size={13} aria-hidden />
              </Link>
              <a
                href={GITHUB_ISSUES}
                target="_blank"
                rel="noreferrer"
                aria-label="Задать вопрос в трекере"
                title="Задать вопрос в трекере"
                className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] bg-night-2 text-nav-text transition-colors hover:text-nav-text-active"
              >
                <LifeBuoy size={13} aria-hidden />
              </a>
              {/* Свернуть панель до иконок. На узком экране сайдбар и так шторка,
                  поэтому кнопка там не показывается. */}
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={rail ? 'Развернуть меню' : 'Свернуть меню'}
                title={rail ? 'Развернуть меню' : 'Свернуть меню'}
                className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] bg-night-2 text-nav-text transition-colors hover:text-nav-text-active max-lg:hidden"
              >
                {rail ? <ChevronsRight size={13} aria-hidden /> : <ChevronsLeft size={13} aria-hidden />}
              </button>
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
