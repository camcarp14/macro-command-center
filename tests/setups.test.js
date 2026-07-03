import { describe, it, expect } from 'vitest'
import { movingAverage, drawdownFromHighPct, realizedVolPct, computeBtcStats, distFromMAPct } from '../src/lib/btcstats.js'
import { evaluateSetups, setupsSummary, SETUPS } from '../src/lib/setups.js'

const series = (vals) => vals.map((v, i) => [i * 86400000, v])

describe('btcstats', () => {
  it('computes a simple moving average', () => {
    expect(movingAverage(series([1, 2, 3, 4, 5]), 5)).toBe(3)
    expect(movingAverage(series([10, 20]), 3)).toBeNull() // not enough history → null, never a guess
  })
  it('drawdown from window high is negative below the high, 0 at the high', () => {
    expect(drawdownFromHighPct(series([100, 200, 150]), 365)).toBe(-25)
    expect(drawdownFromHighPct(series([100, 200]), 365)).toBe(0)
  })
  it('distance from MA in percent', () => {
    // MA(2) of last two = 150, last = 200 → +33.3%
    expect(distFromMAPct(series([100, 100, 200]), 2)).toBe(33.3)
  })
  it('realized vol is 0 for a flat series and positive for a moving one', () => {
    expect(realizedVolPct(series(Array(40).fill(100)), 30)).toBe(0)
    expect(realizedVolPct(series(Array.from({ length: 40 }, (_, i) => 100 + (i % 2) * 10)), 30)).toBeGreaterThan(0)
  })
  it('computeBtcStats returns nulls, not fabrications, on short history', () => {
    const s = computeBtcStats(series([1, 2, 3]))
    expect(s.ma200).toBeNull()
    expect(s.last).toBe(3)
    expect(s.days).toBe(3)
  })
})

describe('setups engine', () => {
  const CONTRARIAN_ACTIVE = {
    m: { fear_greed: 20, funding_ann: -3, hy_oas: 2.8, hy_oas_4w_chg: 0.1, curve_2s10s: 0.3, policy_gap: 1.1 },
    btc: { drawdownFromHighPct: -22, distFromMA200Pct: -10 },
  }

  it('activates only when every condition is met', () => {
    const out = evaluateSetups(CONTRARIAN_ACTIVE)
    const c = out.find((s) => s.key === 'contrarian_btc')
    expect(c.active).toBe(true)
    expect(c.met).toBe(4)
    const froth = out.find((s) => s.key === 'froth_btc')
    expect(froth.active).toBe(false)
  })

  it('fails closed: missing data can never count toward activation', () => {
    const ctx = { m: { fear_greed: 20, funding_ann: -3, hy_oas: 2.8 }, btc: null } // drawdown unknown
    const c = evaluateSetups(ctx).find((s) => s.key === 'contrarian_btc')
    expect(c.met).toBe(3)
    expect(c.unknown).toBe(1)
    expect(c.active).toBe(false)
    expect(c.conditions.find((x) => x.valueText === 'no data')).toBeTruthy()
  })

  it('credit-break trigger requires level AND momentum AND curve', () => {
    const base = { m: { hy_oas: 4.4, hy_oas_4w_chg: 0.8, curve_2s10s: 0.7 }, btc: null }
    expect(evaluateSetups(base).find((s) => s.key === 'credit_break').active).toBe(true)
    const noMomentum = { m: { ...base.m, hy_oas_4w_chg: 0.1 }, btc: null }
    expect(evaluateSetups(noMomentum).find((s) => s.key === 'credit_break').active).toBe(false)
  })

  it('summary names active setups, otherwise reports the closest one', () => {
    expect(setupsSummary(evaluateSetups(CONTRARIAN_ACTIVE))).toMatch(/ACTIVE: Contrarian accumulation/)
    const quiet = { m: { fear_greed: 50, funding_ann: 8, hy_oas: 2.8, hy_oas_4w_chg: 0, curve_2s10s: 0.3, policy_gap: 1.1 }, btc: { drawdownFromHighPct: -5, distFromMA200Pct: 5 } }
    expect(setupsSummary(evaluateSetups(quiet))).toMatch(/No setups active · closest:/)
  })

  it('every setup carries an honest framing note and a stance label', () => {
    for (const s of SETUPS) {
      expect(s.note.length).toBeGreaterThan(40)
      expect(s.stance).toBeTruthy()
    }
  })
})
