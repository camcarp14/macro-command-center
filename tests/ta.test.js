import { describe, it, expect } from 'vitest'
import { sma, ema, rsi, atr, roc, slopePct, highestHigh, lowestLow, swings } from '../src/lib/ta.js'
import { BASE_T } from './fixtures.js'

const DAY = 86400
const mk = (o, h, l, c, i = 0) => ({ t: BASE_T + i * DAY, o, h, l, c, v: 1e6 })

describe('sma', () => {
  it('hand-computed', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5])
  })
  it('empty and short input', () => {
    expect(sma([], 3)).toEqual([])
    expect(sma([1, 2], 3)).toEqual([null, null])
  })
})

describe('ema', () => {
  it('seeds with SMA then compounds (hand-computed, period 2)', () => {
    const e = ema([1, 2, 3, 4, 5], 2)
    expect(e[0]).toBeNull()
    expect(e[1]).toBeCloseTo(1.5, 10)
    expect(e[2]).toBeCloseTo(2.5, 10)
    expect(e[3]).toBeCloseTo(3.5, 10)
    expect(e[4]).toBeCloseTo(4.5, 10)
  })
  it('shorter than period → all null', () => {
    expect(ema([1, 2], 5)).toEqual([null, null])
  })
})

describe('rsi', () => {
  it('all-up closes → 100', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    const r = rsi(closes, 14)
    expect(r[13]).toBeNull()
    expect(r[14]).toBe(100)
    expect(r[19]).toBe(100)
  })
  it('all-down closes → near 0', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i)
    const r = rsi(closes, 14)
    expect(r[19]).toBeLessThan(1)
  })
  it('too short → all null', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null])
  })
})

describe('atr', () => {
  it('constant true range stays constant (hand-computed)', () => {
    const candles = Array.from({ length: 6 }, (_, i) => mk(10, 11, 9, 10, i))
    const a = atr(candles, 3)
    expect(a[0]).toBeNull()
    expect(a[1]).toBeNull()
    expect(a[2]).toBeCloseTo(2, 10)
    expect(a[5]).toBeCloseTo(2, 10)
  })
  it('gap widens TR via previous close', () => {
    // bar 1 gaps: h=25 l=24 with prev close 10 → TR = |25-10| = 15
    const candles = [mk(10, 11, 9, 10, 0), mk(24, 25, 24, 25, 1)]
    const a = atr(candles, 2)
    expect(a[1]).toBeCloseTo((2 + 15) / 2, 10)
  })
  it('short input → nulls', () => {
    expect(atr([mk(1, 2, 0.5, 1)], 14)).toEqual([null])
  })
})

describe('roc & slopePct', () => {
  it('roc hand-computed', () => {
    expect(roc([100, 110], 1)).toEqual([null, 10.000000000000009])
  })
  it('slopePct hand-computed', () => {
    expect(slopePct([100, 105, 110], 2)).toBeCloseTo(5, 10)
  })
  it('slopePct null-safe', () => {
    expect(slopePct([100], 5)).toBeNull()
    expect(slopePct([null, null, 100], 2)).toBeNull()
  })
})

describe('highestHigh / lowestLow', () => {
  const candles = [mk(1, 5, 1, 2, 0), mk(2, 9, 2, 3, 1), mk(3, 7, 0.5, 4, 2)]
  it('window math', () => {
    expect(highestHigh(candles, 2)).toBe(9)
    expect(highestHigh(candles, 3)).toBe(9)
    expect(lowestLow(candles, 2)).toBe(0.5)
    expect(lowestLow(candles, 1, 1)).toBe(2)
  })
  it('out-of-range → null', () => {
    expect(highestHigh(candles, 4)).toBeNull()
    expect(lowestLow(candles, 1, 9)).toBeNull()
    expect(highestHigh(candles, 0)).toBeNull()
  })
})

describe('swings', () => {
  it('finds confirmed pivots, rejects ties, ignores unconfirmable tail', () => {
    // Hand-built highs: 5,6,9,6,5,4,8 — pivot high 9 at i=2 (strength 2).
    // Lows mirror: 5,4,3,4,5,2,6 — low 3 at i=2 not a pivot (l[5]=2 is lower
    // but outside window: window is i±2, so l[2]=3 vs 5,4,4,5 → IS a pivot);
    // l[5]=2 can't confirm (needs i+2 = 7 which doesn't exist... len 7, i≤4).
    const candles = [
      mk(5, 5, 5, 5, 0), mk(5, 6, 4, 5, 1), mk(5, 9, 3, 5, 2),
      mk(5, 6, 4, 5, 3), mk(5, 5, 5, 5, 4), mk(5, 4, 2, 3, 5), mk(5, 8, 6, 7, 6),
    ]
    const s = swings(candles, 2)
    expect(s.highs).toEqual([{ i: 2, price: 9 }])
    expect(s.lows).toEqual([{ i: 2, price: 3 }])
  })
  it('ties reject (strict inequality)', () => {
    const candles = [mk(5, 7, 4, 5, 0), mk(5, 7, 3, 5, 1), mk(5, 7, 4, 5, 2), mk(5, 6, 4, 5, 3), mk(5, 6, 4, 5, 4)]
    expect(swings(candles, 2).highs).toEqual([])
  })
  it('empty input', () => {
    expect(swings([], 2)).toEqual({ highs: [], lows: [] })
  })
})
