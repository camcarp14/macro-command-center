import { describe, it, expect } from 'vitest'
import { alignByDay, dailyLogReturns, rollingBeta, relativeStrength, mNav, torqueRead } from '../src/lib/torque.js'
import { BASE_T } from './fixtures.js'

const DAY = 86400
const mkSeries = (closes, skipWeekends = false) => {
  const out = []
  let day = 0
  for (const c of closes) {
    if (skipWeekends) {
      while ([0, 6].includes(new Date((BASE_T + day * DAY) * 1000).getUTCDay())) day++
    }
    out.push({ t: BASE_T + day * DAY, o: c, h: c, l: c, c, v: 1 })
    day++
  }
  return out
}

describe('alignByDay', () => {
  it('keeps only intersecting UTC dates (BTC trades 7 days, MSTR 5)', () => {
    const btc = mkSeries(Array.from({ length: 14 }, (_, i) => 100 + i)) // every day
    const mstr = mkSeries(Array.from({ length: 10 }, (_, i) => 200 + i), true) // weekdays
    const { a, b, days } = alignByDay(mstr, btc)
    expect(a.length).toBe(10)
    expect(b.length).toBe(10)
    expect(new Set(days.map((d) => new Date(d).getUTCDay()))).not.toContain(0)
    expect(new Set(days.map((d) => new Date(d).getUTCDay()))).not.toContain(6)
  })
  it('empty inputs → empty', () => {
    expect(alignByDay([], []).a).toEqual([])
  })
})

describe('dailyLogReturns', () => {
  it('hand-computed', () => {
    const r = dailyLogReturns([100, 110])
    expect(r[0]).toBeCloseTo(Math.log(1.1), 12)
  })
  it('non-positive prices → null entries', () => {
    expect(dailyLogReturns([100, 0, 100])).toEqual([null, null])
  })
})

describe('rollingBeta', () => {
  it('mstr returns exactly 2× btc returns → beta 2', () => {
    // deterministic non-constant return pattern
    const rets = Array.from({ length: 45 }, (_, k) => 0.01 * ((k % 3) - 1) + 0.002)
    let b = 100; const btc = [b]
    for (const r of rets) { b *= Math.exp(r); btc.push(b) }
    let m = 300; const mstr = [m]
    for (const r of rets) { m *= Math.exp(2 * r); mstr.push(m) }
    const { latest, series } = rollingBeta(mstr, btc, 30)
    expect(latest).toBeCloseTo(2, 6)
    expect(series.filter((x) => x != null).length).toBeGreaterThan(0)
  })
  it('flat BTC (zero variance) → null', () => {
    const btc = Array.from({ length: 45 }, () => 100)
    const mstr = Array.from({ length: 45 }, (_, i) => 100 + i)
    expect(rollingBeta(mstr, btc, 30).latest).toBeNull()
  })
  it('too little data → null latest, empty series', () => {
    expect(rollingBeta([1, 2, 3], [1, 2, 3], 30)).toEqual({ latest: null, series: [] })
  })
})

describe('relativeStrength', () => {
  it('hand-computed spread', () => {
    const mstr = Array.from({ length: 21 }, (_, i) => 100 * (1 + 0.2 * i / 20))
    const btc = Array.from({ length: 21 }, (_, i) => 100 * (1 + 0.1 * i / 20))
    const rs = relativeStrength(mstr, btc, 20)
    expect(rs.mstrRocPct).toBeCloseTo(20, 8)
    expect(rs.btcRocPct).toBeCloseTo(10, 8)
    expect(rs.spreadPct).toBeCloseTo(10, 8)
  })
  it('short series → nulls', () => {
    expect(relativeStrength([1, 2], [1, 2], 20)).toEqual({ mstrRocPct: null, btcRocPct: null, spreadPct: null })
  })
})

describe('mNav', () => {
  it('known answer: 2× NAV, implied BTC price doubles', () => {
    const m = mNav({ price: 400, sharesOutstanding: 300e6, btcHoldings: 600000, btcPrice: 100000 })
    expect(m.marketCap).toBe(120e9)
    expect(m.btcNavUsd).toBe(60e9)
    expect(m.mNav).toBe(2)
    expect(m.premiumPct).toBe(100)
    expect(m.impliedBtcPrice).toBe(200000)
    expect(m.btcPerShare).toBeCloseTo(0.002, 12)
  })
  it('any missing input → all nulls', () => {
    expect(mNav({ price: 400, sharesOutstanding: null, btcHoldings: 600000, btcPrice: 100000 }).mNav).toBeNull()
    expect(mNav({ price: 0, sharesOutstanding: 1, btcHoldings: 1, btcPrice: 1 }).mNav).toBeNull()
  })
})

describe('torqueRead', () => {
  it('grade boundaries: 1.2 efficient · 1.0/0.9 fair · 0.89 rich', () => {
    expect(torqueRead({ beta: 2.4, mNav: 2 }).grade).toBe('efficient')
    expect(torqueRead({ beta: 2, mNav: 2 }).grade).toBe('fair')
    expect(torqueRead({ beta: 1.8, mNav: 2 }).grade).toBe('fair')
    expect(torqueRead({ beta: 1.78, mNav: 2 }).grade).toBe('rich')
  })
  it('nulls → unknown', () => {
    expect(torqueRead({ beta: null, mNav: 2 }).grade).toBe('unknown')
    expect(torqueRead({ beta: 2, mNav: 0 }).grade).toBe('unknown')
  })
  it('text carries the numbers', () => {
    expect(torqueRead({ beta: 1.9, mNav: 1.62 }).text).toContain('1.9')
  })
})
