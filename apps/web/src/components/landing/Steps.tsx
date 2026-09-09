import type { ServiceSummary } from '@/lib/types'

/**
 * Секция «Как это работает»: три шага в ряд. Макет — 07_Section_Steps.
 *
 * Единственное живое место здесь — второй шаг. В макете адрес подменённого шлюза
 * написан строкой («api.apistend.ru/ozon», код https://api.apistend.ru/ozon/v3/...),
 * но такая адресация в проекте отвергнута: поддомены с чужими марками мы не заводим,
 * адресация путевая. Поэтому оба адреса берутся из профиля сервиса —
 * replacesUrl (что заменяем) и mockBaseUrl (на что), — и ни один не написан руками.
 */

type Step = {
  readonly n: string
  readonly title: string
  readonly desc: string
  /** Базовый адрес песочницы под описанием. Есть только у шага с подменой адреса. */
  readonly code?: string
}

export function Steps({ services }: { services: ServiceSummary[] }) {
  // Ozon — сервис из макета. Если каталог не ответил, services придёт пустым.
  const ozon = services.find((s) => s.code === 'ozon')

  const steps: readonly Step[] = [
    {
      n: '01',
      title: 'Создайте песочницу',
      // «Отдельная песочница на каждый проект и стенд» из макета выброшено: песочница
      // заводится ровно одна и только при регистрации (единственный sandbox.create —
      // apps/api/src/routes/auth.ts), создать вторую в кабинете нечем, и меню аккаунта
      // об этом честно пишет. Вместо обещания — то, что регистрация правда делает:
      // тем же запросом создаётся песочница и первый ключ на все сервисы стенда.
      desc: 'Регистрация по почте, без карты. Песочница и первый ключ создаются вместе с аккаунтом.',
    },
    {
      n: '02',
      title: 'Подмените базовый адрес',
      // Без данных сервиса шаг остаётся, но теряет конкретику: писать адрес
      // строкой нельзя, а придумывать «примерный» — тем более.
      desc: ozon
        ? `Вместо ${ozon.replacesUrl} укажите адрес песочницы и тестовый ключ — остальной код не меняется.`
        : 'В коде интеграции меняется одна строка — базовый адрес. Остальное остаётся как есть.',
      // Ведущий слэш из mockBaseUrl убираем: под кодом это читается как база, а не как путь.
      ...(ozon ? { code: ozon.mockBaseUrl.replace(/\/$/, '') } : {}),
    },
    {
      n: '03',
      title: 'Проверьте сценарии',
      desc: 'Ошибки, лимиты, вебхуки на localhost и повторы. Когда всё зелёное — возвращайте боевой адрес.',
    },
  ]

  return (
    <section id="how" className="bg-night px-[20px] py-[88px] md:px-[80px]">
      <div className="mx-auto max-w-[1280px]">
        <p className="text-[12px] font-semibold tracking-[1.2px] text-night-accent uppercase">
          Как это работает
        </p>
        {/* В макете «через пять минут после регистрации». Срок не замеряли —
            и это не единственная беда: рядом лендинг обещал 30 секунд и пять секунд,
            три разных числа про одно и то же. Заголовок обещает не время, а объём
            работы, и он проверяется прямо здесь: шагов ниже действительно три. */}
        <h2 className="mt-[14px] max-w-[820px] text-[30px] leading-[1.15] font-bold tracking-[-1px] text-white md:text-[38px] md:leading-[44px]">
          От регистрации до первого успешного запроса — три шага
        </h2>

        <ol className="mt-[40px] grid gap-[28px] md:grid-cols-3 md:gap-[20px]">
          {steps.map((step) => (
            <li key={step.n}>
              {/* Квадрат номера: в макете радиус 12, берём 10 — общий радиус панелей проекта. */}
              <span className="flex h-[44px] w-[44px] items-center justify-center rounded-[10px] bg-night-accent-bg font-mono text-[15px] font-bold text-night-accent">
                {step.n}
              </span>
              <h3 className="mt-[14px] text-[19px] leading-[25px] font-semibold tracking-[-0.3px] text-white">
                {step.title}
              </h3>
              <p className="mt-[14px] text-[14px] leading-[22px] text-nav-text">{step.desc}</p>
              {step.code ? (
                <p className="mt-[14px] overflow-x-auto scrollbar-thin rounded-[6px] bg-code-bg px-[12px] py-[10px] font-mono text-[11.5px] whitespace-nowrap text-code-string">
                  {step.code}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
