import { describe, it, expect } from 'vitest'
import {
  stressHealthFactor, liquidationDrawdown, liquidationPrice,
  curveSpread, pctChangeNBack, latestValue, freshness, diffLine,
} from '../src/lib/derive.js'

describe('aave stress math (WBTC collateral, stable debt)', () => {
  it('HF scales linearly with the BTC shock', () => {
    expect(stressHealthFactor(1.8, -0.30)).toBeCloseTo(1.26, 10)
    expect(stressHealthFactor(1.8, -0.40)).toBeCloseTo(1.08, 10)
    expect(stressHealthFactor(2.0, -0.50)).toBeCloseTo(1.0, 10)
  })
  it('liquidation drawdown solves HF(x)=1', () => {
    const hf = 1.8
    const dd = liquidationDrawdown(hf)
    expect(dd).toBeCloseTo(1 / 1.8 - 1, 10) // ≈ -44.44%
    expect(stressHealthFactor(hf, dd)).toBeCloseTo(1.0, 10)
  })
  it('liquidation price = price / HF', () => {
    expect(liquidationPrice(100000, 2.0)).toBe(50000)
  })
  it('never fabricates on bad input', () => {
    expect(stressHealthFactor(null, -0.1)).toBeNull()
    expect(liquidationDrawdown(0)).toBeNull()
  })
})

describe('FRED derivations', () => {
  const obs10 = [ { d: '2026-07-01', v: 4.42 }, { d: '2026-06-30', v: 4.40 } ]
  const obs2 =  [ { d: '2026-07-01', v: 4.80 }, { d: '2026-06-30', v: 4.79 } ]
  it('2s10s aligns on a common date', () => {
    expect(curveSpread(obs10, obs2)).toEqual({ date: '2026-07-01', value: -0.38 })
  })
  it('2s10s skips dates missing in one series (FRED "." holes)', () => {
    const holey2 = [ { d: '2026-07-01', v: null }, { d: '2026-06-30', v: 4.79 } ]
    expect(curveSpread(obs10, holey2)).toEqual({ date: '2026-06-30', value: -0.39 })
  })
  it('13-week % change and latestValue', () => {
    const obs = Array.from({ length: 20 }, (_, i) => ({ d: `w${i}`, v: 100 - i })) // desc: 100,99,...
    expect(pctChangeNBack(obs, 13).value).toBeCloseTo(((100 - 87) / 87) * 100, 3)
    expect(latestValue([{ d: 'a', v: null }, { d: 'b', v: 7 }])).toEqual({ date: 'b', value: 7 })
  })
})

describe('freshness state machine — failures degrade visibly, never silently', () => {
  const now = 1_000_000_000
  const max = 300 // 5 min
  it('young fetch => live', () => {
    expect(freshness(now - 60_000, max, now)).toBe('live')
  })
  it('older than maxAge => stale (amber)', () => {
    expect(freshness(now - 400_000, max, now)).toBe('stale')
  })
  it('older than 3x maxAge => down (red)', () => {
    expect(freshness(now - 1_000_000, max, now)).toBe('down')
  })
  it('no data at all => down, regardless of timestamps', () => {
    expect(freshness(now, max, now, false)).toBe('down')
  })
  it('fresh-looking data with a failed refresh => stale, not live', () => {
    expect(freshness(now - 1_000, max, now, true, true)).toBe('stale')
  })
})

describe('diff line', () => {
  it('reports the biggest meaningful moves', () => {
    const prev = { score: 50, btc: 100000, ust10y: 4.4 }
    const curr = { score: 58, btc: 96000, ust10y: 4.41 }
    const line = diffLine(prev, curr)
    expect(line).toContain('Pressure score ▲ 8')
    expect(line).toContain('BTC ▼ $4,000')
    expect(line).not.toContain('10Y') // 1bp is below the meaningful-move bar
  })
  it('quiet tape => says so instead of inventing drama', () => {
    expect(diffLine({ score: 50 }, { score: 50.5 })).toBe('Little changed since you last looked.')
  })
})
