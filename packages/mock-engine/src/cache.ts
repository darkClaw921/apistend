/**
 * Ограниченный LRU-кеш.
 *
 * Нужен там, где значение дорого построить, а ключей потенциально много:
 * ответы движка и разбор ключей API. Без верхней границы такой кеш под нагрузкой
 * превращается в утечку памяти, а полная очистка по переполнению даёт «стадо»
 * одновременных промахов — поэтому вытесняем по одному, а не пачкой.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>()
  readonly maxSize: number
  private hits = 0
  private misses = 0

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) {
      this.misses++
      return undefined
    }
    // Обновляем позицию: Map хранит порядок вставки, самый старый ключ — первый.
    this.map.delete(key)
    this.map.set(key, value)
    this.hits++
    return value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }

  stats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    }
  }
}
