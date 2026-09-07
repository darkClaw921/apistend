import Link from 'next/link'
import { Check, Zap } from 'lucide-react'

/**
 * Секция «Цены». design-handoff/screens/08-landing.md, п. 8.
 * Тексты дословно из design-handoff/04-content-ru.md.
 */
export function PricingCards() {
  return (
    <section className="bg-nav-bg px-[20px] py-[88px] text-center md:px-[80px]">
      <div className="mx-auto max-w-[1280px]">
        <h2 className="text-[40px] leading-[1.1] font-bold tracking-[-2px] text-white md:text-[56px]">
          Простые цены.
        </h2>
        <p className="mx-auto mt-[16px] max-w-[640px] text-[17px] leading-[1.6] text-nav-text">
          Начните бесплатно. Платными позже станут только командные возможности:
          SSO, закрытый контур и SLA.
        </p>
        <span className="mt-[20px] inline-flex items-center gap-[8px] rounded-[20px] border border-[#2C3A63] bg-[#1B2440] px-[14px] py-[7px] text-[13px] text-[#A6B4FF]">
          <Zap size={14} aria-hidden />
          Бета: всем аккаунтам тариф Pro бесплатно — карта не нужна
        </span>

        <div className="mx-auto mt-[36px] flex max-w-[984px] flex-col gap-[24px] md:flex-row">
          {/* FREE */}
          <article className="flex flex-1 flex-col rounded-[14px] border border-[#26303C] bg-[#111821] p-[28px] text-left">
            <p className="text-[11px] font-semibold tracking-[0.8px] text-[#6C7A8A] uppercase">Free</p>
            <p className="mt-[16px] text-[44px] leading-[1.1] font-bold tracking-[-1.6px] text-white">
              0 ₽ <span className="text-[15px] font-normal text-nav-text">/ в месяц</span>
            </p>
            <p className="mt-[10px] text-[14px] leading-[1.55] text-nav-text">
              Всё, что нужно одному разработчику, чтобы начать.
            </p>
            <ul className="mt-[20px] flex flex-col gap-[10px]">
              {[
                'Все демо-API Bitrix24, Ozon, Wildberries',
                'Без лимита на количество запросов',
                'Одна песочница в один стенд',
                'Вебхуки на localhost',
                'Логи запросов за 24 часа',
                'Каталог методов и консоль запросов',
              ].map((f) => (
                <li key={f} className="flex items-start gap-[10px] text-[14px] leading-[1.5] text-nav-text">
                  <Check size={14} className="mt-[3px] shrink-0 text-[#6C7A8A]" aria-hidden /> {f}
                </li>
              ))}
            </ul>
            <span className="mt-auto block rounded-[6px] bg-[#161F2B] px-[16px] py-[13px] pt-[13px] text-center text-[14px] font-semibold text-[#8B96A5]">
              Текущий тариф
            </span>
          </article>

          {/* PRO */}
          <article className="relative flex flex-1 flex-col rounded-[14px] border-2 border-accent bg-[#0F1626] p-[28px] text-left">
            <span className="absolute top-[20px] right-[20px] rounded-[20px] bg-accent px-[10px] py-[4px] text-[11px] font-semibold text-white">
              Популярный
            </span>
            <p className="text-[11px] font-semibold tracking-[0.8px] text-[#A6B4FF] uppercase">Pro</p>
            <p className="mt-[16px] flex flex-wrap items-baseline gap-[10px]">
              <span className="text-[44px] leading-[1.1] font-bold tracking-[-1.6px] text-white">Бесплатно</span>
              <span className="text-[15px] text-nav-text">на время беты</span>
            </p>
            {/* Зачёркивание через text-decoration, а не отдельной линией: в макете это
                ограничение редактора, а не решение дизайна. */}
            <p className="mt-[6px] text-[15px] text-[#5C6A7A] line-through">990 ₽/мес</p>
            <ul className="mt-[20px] flex flex-col gap-[10px]">
              {[
                'Всё из тарифа Free',
                'Неограниченные песочницы и ключи',
                'Сценарии симуляции и повторы событий',
                'Запись и повтор ответов боевого API',
                'Логи запросов за 30 дней',
                'Доступ команды и права по ключам',
                'Установка в контур',
                'SLA 99,9 % и выделенный менеджер',
              ].map((f) => (
                <li key={f} className="flex items-start gap-[10px] text-[14px] leading-[1.5] text-white">
                  <Check size={14} className="mt-[3px] shrink-0 text-[#3DD68C]" aria-hidden /> {f}
                </li>
              ))}
            </ul>
            <Link
              href="/register"
              className="mt-auto block rounded-[6px] bg-accent px-[16px] py-[13px] pt-[13px] text-center text-[14px] font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Бесплатно на время беты
            </Link>
          </article>
        </div>

        <p className="mx-auto mt-[24px] max-w-[640px] text-[13px] leading-[1.6] text-[#6C7A8A]">
          Базовый доступ останется бесплатным навсегда. О переходе на платные тарифы
          предупредим минимум за 30 дней.
        </p>
      </div>
    </section>
  )
}
