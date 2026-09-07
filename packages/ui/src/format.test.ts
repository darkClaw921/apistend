import { describe, it, expect } from 'vitest'
import {
  NBSP, formatInt, formatDecimal, formatPercent, formatMs, formatBytes, formatDelta,
  formatRelative, formatDayTime, formatCalls, formatMethods, maskKey, meta,
} from './format.ts'

// Значения взяты прямо с PNG макета — это и есть критерий приёмки.
describe('числа по правилам 04-content-ru.md', () => {
  it('разряды разделяются неразрывным пробелом', () => {
    expect(formatInt(128940)).toBe(`128${NBSP}940`)
    expect(formatInt(1284)).toBe(`1${NBSP}284`)
    expect(formatInt(48213)).toBe(`48${NBSP}213`)
    expect(formatInt(7)).toBe('7')
    expect(formatInt(0)).toBe('0')
    expect(formatInt(-1240)).toBe(`-1${NBSP}240`)
  })

  it('десятичный разделитель — запятая', () => {
    expect(formatDecimal(1.8)).toBe('1,8')
    expect(formatPercent(1.8)).toBe(`1,8${NBSP}%`)
    expect(formatPercent(3.1)).toBe(`3,1${NBSP}%`)
    expect(formatPercent(98.2)).toBe(`98,2${NBSP}%`)
  })

  it('единицы отделяются неразрывным пробелом', () => {
    expect(formatMs(84)).toBe(`84${NBSP}мс`)
    expect(formatMs(1240)).toBe(`1${NBSP}240${NBSP}мс`)
    expect(formatMs(5000)).toBe(`5${NBSP}000${NBSP}мс`)
  })

  it('размеры как в колонке «Размер» логов', () => {
    expect(formatBytes(1229)).toBe(`1,2${NBSP}КБ`)
    expect(formatBytes(62669)).toBe(`61,2${NBSP}КБ`)
    expect(formatBytes(300)).toBe(`300${NBSP}Б`)
  })

  it('дельта KPI печатается со знаком, минус типографский', () => {
    expect(formatDelta(12, '%')).toBe(`+12${NBSP}%`)
    expect(formatDelta(-6, 'мс')).toBe(`−6${NBSP}мс`)
    expect(formatDelta(0.4, 'п.п.', 1)).toBe(`+0,4${NBSP}п.п.`)
  })
})

describe('время', () => {
  const now = new Date('2026-09-07T12:41:07.284Z')

  it('относительное время склоняется', () => {
    expect(formatRelative(new Date(now.getTime() - 2 * 60_000), now)).toBe('2 мин назад')
    expect(formatRelative(new Date(now.getTime() - 5 * 3600_000), now)).toBe('5 ч назад')
    expect(formatRelative(new Date(now.getTime() - 47 * 60_000), now)).toBe('47 мин назад')
    expect(formatRelative(new Date(now.getTime() - 26 * 3600_000), now)).toBe('вчера')
  })

  it('колонка «Последний запрос» показывает сегодня/вчера', () => {
    expect(formatDayTime(new Date(now.getTime() - 30 * 60_000), now)).toMatch(/^сегодня, \d{2}:\d{2}$/)
    expect(formatDayTime(new Date(now.getTime() - 26 * 3600_000), now)).toMatch(/^вчера, \d{2}:\d{2}$/)
  })
})

describe('склонения и маски', () => {
  it('вызовы', () => {
    expect(formatCalls(1284)).toBe(`1${NBSP}284 вызова`)
    expect(formatCalls(1)).toBe('1 вызов')
    expect(formatCalls(87)).toBe('87 вызовов')
    expect(formatCalls(640)).toBe('640 вызовов')
    expect(formatCalls(2108)).toBe(`2${NBSP}108 вызовов`)
  })

  it('методы', () => {
    expect(formatMethods(42)).toBe('42 метода')
    expect(formatMethods(105)).toBe('105 методов')
    expect(formatMethods(1)).toBe('1 метод')
    expect(formatMethods(294)).toBe('294 метода')
  })

  it('маска ключа как в таблице', () => {
    expect(maskKey('stend_sbx_7f3a', '4c21')).toBe('stend_sbx_7f3a••••••4c21')
  })

  it('мета-строка собирается через « · » и пропускает пустое', () => {
    expect(meta('4 правила', '1 284 вызова', '2 мин назад')).toBe('4 правила · 1 284 вызова · 2 мин назад')
    expect(meta('Bitrix24', null, 'v1.2', undefined, false)).toBe('Bitrix24 · v1.2')
  })
})
