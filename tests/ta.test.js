import { describe, it, expect } from 'vitest'
import { ema, rsi, atr, vwapDaily, aggregateCandles, regimeRead, hourlyActivity } from '../src/lib/ta.js'
import { projectionCone } from '../src/lib/projection.js'

const mkCandles = (closes, { t0 = 1700000000, step = 300, spread = 1, vol = 10 } = {}) =>
  closes.map((c, i) => ({ t: t0 + i * step, o: c, h: c + spread, l: c - spread, c, v: vol }))

describe('ta core math', () => {
  it('EMA seeds with SMA then converges toward the latest values', () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3)
    expect(out[2]).toBe(2) // SMA(1,2,3)
    expect(out[5]).toBeGreaterThan(4.5) // pulled toward 6
    expect(out[0]).toBeNull()
  })
  it('RSI is 100 on a straight rise and ~0 on a straight fall', () => {
    const up = rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14)
    expect(up[19]).toBe(100)
    const dn = rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14)
    expect(dn[19]).toBeLessThan(1)
  })
  it('ATR equals the constant bar range on uniform candles', () => {
    const out = atr(mkCandles(Array(20).fill(100), { spread: 2 }), 14)
    expect(out[19]).toBeCloseTo(4, 5) // high−low = 4 every bar
  })
  it('VWAP resets at UTC day boundaries', () => {
    const dayA = mkCandles([100, 100], { t0: 86400 * 100, step: 300 })
    const dayB = mkCandles([200, 200], { t0: 86400 * 101, step: 300 })
    const out = vwapDaily([...dayA, ...dayB])
    expect(out[1]).toBeCloseTo(100, 0)
    expect(out[2]).toBeCloseTo(200, 0) // fresh anchor, not blended with day A
  })
  it('aggregation preserves OHLCV semantics (1m → 3m)', () => {
    const c = [
      { t: 0, o: 10, h: 12, l: 9, c: 11, v: 1 },
      { t: 60, o: 11, h: 15, l: 10, c: 14, v: 2 },
      { t: 120, o: 14, h: 14, l: 8, c: 9, v: 3 },
    ]
    const [agg] = aggregateCandles(c, 3)
    expect(agg).toEqual({ t: 0, o: 10, h: 15, l: 8, c: 9, v: 6 })
  })
})

describe('regime read', () => {
  it('labels a clean rise as TRENDING UP and a clean fall as TRENDING DOWN', () => {
    const up = regimeRead(mkCandles(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5)))
    expect(up.state).toBe('TRENDING UP')
    const dn = regimeRead(mkCandles(Array.from({ length: 120 }, (_, i) => 160 - i * 0.5)))
    expect(dn.state).toBe('TRENDING DOWN')
  })
  it('labels an oscillating tape as CHOP and admits insufficient data honestly', () => {
    const chop = regimeRead(mkCandles(Array.from({ length: 120 }, (_, i) => 100 + (i % 2 ? 0.3 : -0.3))))
    expect(chop.state).toBe('CHOP')
    expect(regimeRead(mkCandles([1, 2, 3])).state).toBe('INSUFFICIENT DATA')
  })
})

describe('hourly activity', () => {
  it('ranks the hour with the widest ranges highest', () => {
    const quiet = Array.from({ length: 60 }, (_, i) => ({ t: i * 60, o: 100, h: 100.1, l: 99.9, c: 100, v: 1 })) // hour 0
    const busy = Array.from({ length: 60 }, (_, i) => ({ t: 3600 + i * 60, o: 100, h: 102, l: 98, c: 100, v: 1 })) // hour 1
    const rows = hourlyActivity([...quiet, ...busy])
    const h1 = rows.find((r) => r.hourUtc === 1)
    expect(h1.rel).toBe(1)
    expect(rows.find((r) => r.hourUtc === 0).avgRangePct).toBeLessThan(h1.avgRangePct)
  })
})

describe('projection cone', () => {
  it('is symmetric in log space, widens with √t, base stays flat', () => {
    const p = projectionCone({ lastPrice: 100000, realizedVolPct: 40, horizonDays: 30, startTs: 0 })
    expect(p.days[0].bull1s).toBe(100000)
    expect(p.days[30].base).toBe(100000) // zero-drift base: no fake direction
    const d7 = p.days[7], d28 = p.days[28]
    // √t scaling: 28d band ≈ 2× the 7d band in log terms
    const w7 = Math.log(d7.bull1s / d7.bear1s), w28 = Math.log(d28.bull1s / d28.bear1s)
    expect(w28 / w7).toBeCloseTo(2, 1)
    // log-symmetry: bull × bear = base²
    expect(d7.bull1s * d7.bear1s).toBeCloseTo(100000 ** 2, -6)
    expect(p.days[30].up95).toBeGreaterThan(p.days[30].bull1s)
  })
  it('refuses to project without real inputs and always carries its caveat', () => {
    expect(projectionCone({ lastPrice: NaN, realizedVolPct: 40, horizonDays: 7 })).toBeNull()
    const p = projectionCone({ lastPrice: 100, realizedVolPct: 40, horizonDays: 7 })
    expect(p.caveat).toMatch(/not a forecast/i)
  })
})
