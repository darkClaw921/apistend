/**
 * Детерминированная генерация значений.
 *
 * Сид faker'а для этого не годится: он не гарантирует стабильность между версиями
 * библиотеки, а faker.date.* и faker.string.uuid зависят от «сегодня». Нам нужно, чтобы
 * один и тот же запрос всегда давал один и тот же ответ — иначе снимок экрана «плывёт»,
 * а контрактные тесты клиента становятся флейки.
 *
 * Поэтому значение — чистая функция от пути к полю:
 *   value = f(hash(salt, entityType, ordinal, fieldPath))
 */

/** xmur3: строка -> 32-битный сид. */
function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32: сид -> поток чисел [0,1). */
export function rngFrom(key: string): () => number {
  let a = seedFrom(key)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Deterministic {
  // Поле объявлено явно, а не параметром конструктора: параметр-свойство —
  // синтаксис, который Node не умеет при исполнении .ts без сборки.
  readonly salt: string

  constructor(salt: string) {
    this.salt = salt
  }

  private rng(key: string): () => number {
    return rngFrom(`${this.salt}|${key}`)
  }

  int(key: string, min: number, max: number): number {
    if (max <= min) return min
    return min + Math.floor(this.rng(key)() * (max - min + 1))
  }

  float(key: string, min: number, max: number, digits = 2): number {
    const v = min + this.rng(key)() * (max - min)
    return Number(v.toFixed(digits))
  }

  bool(key: string, trueChance = 0.5): boolean {
    return this.rng(key)() < trueChance
  }

  pick<T>(key: string, items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick: пустой список')
    return items[Math.floor(this.rng(key)() * items.length)]!
  }

  /** Строка из шестнадцатеричных символов фиксированной длины. */
  hex(key: string, length: number): string {
    const r = this.rng(key)
    let out = ''
    while (out.length < length) out += Math.floor(r() * 16).toString(16)
    return out.slice(0, length)
  }

  /** UUID v4, детерминированный: одинаковый ключ — одинаковый uuid. */
  uuid(key: string): string {
    const h = this.hex(key, 32)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
  }

  /**
   * Дата, детерминированно смещённая от опорной точки.
   * Опорная точка передаётся снаружи, а не берётся из Date.now(): иначе ответ
   * перестанет быть воспроизводимым.
   */
  date(key: string, base: Date, minDaysAgo: number, maxDaysAgo: number): Date {
    const days = this.int(key, minDaysAgo, maxDaysAgo)
    const seconds = this.int(`${key}#s`, 0, 86_399)
    const d = new Date(base.getTime() - days * 86_400_000)
    d.setUTCHours(0, 0, 0, 0)
    return new Date(d.getTime() + seconds * 1000)
  }
}
