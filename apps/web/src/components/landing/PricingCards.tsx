import Link from 'next/link'
import { Check, Zap } from 'lucide-react'

/**
 * Секция «Цены». Макет — 13_Section_Pricing.
 *
 * Секция целиком тёмная (`bg-night`), карточки — `bg-night-2` на границе
 * `border-nav-border`, у Pro вместо границы акцентная рамка в 2 px.
 * Пропсов нет: секция ничего не считает и ничего не запрашивает, весь текст
 * статичен — компонент серверный.
 *
 * Про Pro: SSO, роли, закрытый контур и SLA — обещание будущего платного
 * тарифа, а не заявление о сегодняшнем дне. Рамка задана надзаголовком секции
 * («платными позже станут только командные возможности») и бейджем беты,
 * формулировки согласованы.
 */

/** Списки пунктов — данными, а не копипастой разметки. Текст дословно из макета. */
const FREE_FEATURES = [
  'Все демо-API: Bitrix24, Ozon, Wildberries',
  'Без лимита на количество запросов',
  'Одна песочница и один ключ',
  'Вебхуки на localhost через CLI',
  'Логи запросов за 24 часа',
  'Каталог методов и консоль запросов',
] as const

const PRO_FEATURES = [
  'Всё из тарифа Free',
  'Неограниченные песочницы и ключи',
  'Сценарии симуляции и повторы событий',
  'Запись и повтор ответов боевого API',
  'Логи запросов за 30 дней',
  'SSO и роли в команде',
  'Установка в закрытый контур',
  'SLA 99,9 % и выделенный менеджер',
] as const

export function PricingCards() {
  return (
    <section
      id="pricing"
      className="bg-night px-[20px] py-[64px] md:px-[80px] md:pt-[96px] md:pb-[104px]"
    >
      <div className="mx-auto flex max-w-[1280px] flex-col items-center">
        <h2 className="max-w-[900px] text-center text-[40px] leading-[46px] font-bold tracking-[-1.6px] text-white md:text-[56px] md:leading-[62px] md:tracking-[-2px]">
          Простые цены.
        </h2>
        <p className="mt-[16px] max-w-[640px] text-center text-[16px] leading-[26px] text-nav-text md:text-[17px] md:leading-[27px]">
          Начните бесплатно. Платными позже станут только командные возможности: SSO, закрытый
          контур и SLA.
        </p>

        {/* Плашка беты: рамки такого синего (#2C3A63) в наборе токенов нет —
            берём акцент с прозрачностью, фон и текст по токенам. Радиус 20 px
            вместо 24 px из макета: проект держит радиусы на шкале 6/10/14/20. */}
        <p className="mt-[26px] flex items-center gap-[9px] rounded-[20px] border border-accent/40 bg-night-accent-bg px-[18px] py-[10px] text-[13px] leading-[18px] font-medium text-night-accent-2 md:text-[14px]">
          <Zap size={15} className="shrink-0" aria-hidden />
          Бета: всем аккаунтам тариф Pro бесплатно — карта не нужна
        </p>

        {/* 480 + 24 + 480 из макета. Ниже md карточки идут одна под другой. */}
        <div className="mt-[48px] grid w-full max-w-[984px] gap-[24px] md:grid-cols-2">
          <article className="flex flex-col rounded-[14px] border border-nav-border bg-night-2 p-[24px] md:p-[32px]">
            <p className="text-[12px] font-bold tracking-[1.4px] text-night-dim">FREE</p>

            <p className="mt-[14px] flex flex-wrap items-end gap-[8px]">
              <span className="text-[38px] leading-[42px] font-bold tracking-[-1.6px] text-white md:text-[44px] md:leading-[48px]">
                0 ₽
              </span>
              <span className="pb-[5px] text-[14px] text-night-dim">в месяц</span>
            </p>

            <p className="mt-[16px] text-[14px] leading-[22px] text-nav-text">
              Всё, что нужно одному разработчику, чтобы начать интеграцию сегодня.
            </p>

            {/* flex-1 у списка вместо фиксированных 548 px высоты карточки:
                на узком экране список выше, а кнопка всё равно должна быть внизу. */}
            <ul className="mt-[26px] flex flex-1 flex-col gap-[14px]">
              {FREE_FEATURES.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-[12px] text-[14px] leading-[20px] text-night-text"
                >
                  <Check size={16} className="mt-[2px] shrink-0 text-night-dim" aria-hidden />
                  {f}
                </li>
              ))}
            </ul>

            {/* Не ссылка и не кнопка: тариф уже действует у всех, вести отсюда некуда. */}
            <p className="mt-[28px] rounded-[6px] border border-nav-border bg-code-surface px-[20px] py-[14px] text-center text-[14px] font-semibold text-nav-text">
              Текущий тариф
            </p>
          </article>

          <article className="flex flex-col rounded-[14px] border-2 border-accent bg-night-2 p-[24px] md:p-[32px]">
            <div className="flex items-center justify-between gap-[12px]">
              <p className="text-[12px] font-bold tracking-[1.4px] text-night-accent">PRO</p>
              <span className="shrink-0 rounded-[20px] bg-accent px-[12px] py-[4px] text-[11px] font-semibold text-white">
                Популярный
              </span>
            </div>

            <p className="mt-[14px] flex flex-wrap items-end gap-[10px]">
              <span className="text-[38px] leading-[42px] font-bold tracking-[-1.6px] text-white md:text-[44px] md:leading-[48px]">
                Бесплатно
              </span>
              <span className="pb-[5px] text-[14px] text-nav-text">на время беты</span>
              {/* Зачёркивание через line-through, а не отдельной линией поверх текста:
                  в макете это ограничение редактора, а не решение дизайна. */}
              <span className="pb-[5px] text-[14px] text-code-muted line-through">990 ₽/мес</span>
            </p>

            <p className="mt-[16px] text-[14px] leading-[22px] text-nav-text">
              Всё для команды: неограниченные песочницы, сценарии, запись боевых ответов и командный
              доступ.
            </p>

            <ul className="mt-[26px] flex flex-1 flex-col gap-[14px]">
              {PRO_FEATURES.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-[12px] text-[14px] leading-[20px] text-white"
                >
                  <Check size={16} className="mt-[2px] shrink-0 text-night-ok" aria-hidden />
                  {f}
                </li>
              ))}
            </ul>

            <Link
              href="/register"
              className="mt-[28px] block rounded-[6px] bg-accent px-[20px] py-[14px] text-center text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Бесплатно на время беты
            </Link>
          </article>
        </div>

        <p className="mt-[28px] max-w-[720px] text-center text-[13px] leading-[20px] text-night-dim">
          Базовый доступ останется бесплатным навсегда. О переходе на платные тарифы предупредим
          минимум за 30 дней.
        </p>
      </div>
    </section>
  )
}
