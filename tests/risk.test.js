import { describe, it, expect } from 'vitest'
import { sizePosition, initialStop, anchoredChandelier, effectiveStop, rMultiple, blendLots } from '../src/lib/risk.js'
import { whipsaw, genCandles } from './fixtures.js'

describe('sizePosition', () => {
  it('known answer: 100k equity, 1% risk, 100→90 stop = exactly 100 shares', () => {
    const s = sizePosition({ equity: 100000, riskPct: 1, entry: 100, stop: 90 })
    expect(s).toMatchObject({ ok: true, shares: 100, riskUsd: 1000, perShareRisk: 10, positionUsd: 10000, positionPct: 10, capped: false })
  })
  it('cap bites: tight stop wants $100k position, cap holds it to 30% and recomputes risk', () => {
    const s = sizePosition({ equity: 100000, riskPct: 2, entry: 100, stop: 98, maxPositionPct: 30 })
    expect(s.capped).toBe(true)
    expect(s.shares).toBe(300)
    expect(s.riskUsd).toBe(600) // effective, not the requested 2000
    expect(s.positionPct).toBe(30)
  })
  it('stop at/above entry rejected', () => {
    expect(sizePosition({ equity: 100000, riskPct: 1, entry: 100, stop: 100 }).error).toBe('stop_not_below_entry')
    expect(sizePosition({ equity: 100000, riskPct: 1, entry: 100, stop: 105 }).error).toBe('stop_not_below_entry')
  })
  it('zero/negative/non-finite inputs rejected', () => {
    expect(sizePosition({ equity: 0, riskPct: 1, entry: 100, stop: 90 }).error).toBe('bad_input')
    expect(sizePosition({ equity: 100000, riskPct: -1, entry: 100, stop: 90 }).error).toBe('bad_input')
    expect(sizePosition({ equity: 100000, riskPct: 1, entry: NaN, stop: 90 }).error).toBe('bad_input')
  })
  it('risk too small for one whole share', () => {
    const s = sizePosition({ equity: 1000, riskPct: 0.1, entry: 100, stop: 90 })
    expect(s.ok).toBe(false)
    expect(s.error).toBe('risk_too_small_for_one_share')
  })
})

describe('initialStop', () => {
  it('atr mode: entry 100, ATR 4, 2.5× → 90', () => {
    expect(initialStop({ mode: 'atr', entry: 100, atr: 4 }).stop).toBe(90)
  })
  it('structure mode: swing 95 minus 0.25×ATR(4) → 94', () => {
    expect(initialStop({ mode: 'structure', entry: 100, atr: 4, swingLow: 95 }).stop).toBe(94)
  })
  it('percent mode: 8% below 100 → 92', () => {
    expect(initialStop({ mode: 'percent', entry: 100, pct: 8 }).stop).toBe(92)
  })
  it('no ATR → warning, null stop', () => {
    expect(initialStop({ mode: 'atr', entry: 100, atr: null })).toMatchObject({ stop: null, warning: 'no_atr' })
    expect(initialStop({ mode: 'structure', entry: 100, swingLow: 95, atr: 0 }).warning).toBe('no_structure')
  })
  it('structure stop landing above entry is refused', () => {
    const s = initialStop({ mode: 'structure', entry: 100, atr: 0.1, swingLow: 105 })
    expect(s.stop).toBeNull()
    expect(s.warning).toBe('stop_not_below_entry')
  })
  it('unknown mode / bad pct', () => {
    expect(initialStop({ mode: 'vibes', entry: 100 }).warning).toBe('bad_input')
    expect(initialStop({ mode: 'percent', entry: 100, pct: 0 }).warning).toBe('bad_input')
  })
})

describe('anchoredChandelier', () => {
  it('NEVER descends — every step, on a violent whipsaw fixture', () => {
    const candles = whipsaw(140)
    const trail = anchoredChandelier(candles, { entryIdx: 40, initialStop: candles[40].c * 0.8 })
    expect(trail.length).toBe(100)
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i]).toBeGreaterThanOrEqual(trail[i - 1])
    }
  })
  it('carries initial stop while ATR is unseeded', () => {
    const candles = genCandles({ n: 30, seed: 3 })
    const trail = anchoredChandelier(candles, { entryIdx: 0, atrPeriod: 22, initialStop: 42 })
    for (let i = 0; i < 21; i++) expect(trail[i]).toBe(42)
  })
  it('never returns a value below the initial stop', () => {
    const candles = genCandles({ n: 120, seed: 11, driftPct: -0.5, volPct: 3 })
    const is = candles[60].c * 0.9
    const trail = anchoredChandelier(candles, { entryIdx: 60, initialStop: is })
    for (const s of trail) expect(s).toBeGreaterThanOrEqual(is)
  })
  it('guards bad entryIdx', () => {
    expect(anchoredChandelier([], { entryIdx: 0, initialStop: 1 })).toEqual([])
    expect(anchoredChandelier(genCandles({ n: 10 }), { entryIdx: 99, initialStop: 1 })).toEqual([])
  })
})

describe('effectiveStop', () => {
  it('breakeven ratchets in exactly at entry + beAtR×risk', () => {
    const base = { initialStop: 90, trailStop: null, entry: 100, beAtR: 1 }
    expect(effectiveStop({ ...base, highestCloseSinceEntry: 109.99 })).toBe(90)
    expect(effectiveStop({ ...base, highestCloseSinceEntry: 110 })).toBe(100)
  })
  it('trail wins when highest', () => {
    expect(effectiveStop({ initialStop: 90, trailStop: 105, entry: 100, beAtR: 1, highestCloseSinceEntry: 120 })).toBe(105)
  })
  it('all-null → null', () => {
    expect(effectiveStop({ initialStop: null, trailStop: null, entry: null, highestCloseSinceEntry: null })).toBeNull()
  })
})

describe('rMultiple', () => {
  it('known answers, both signs', () => {
    expect(rMultiple({ entry: 100, initialStop: 90, price: 120 })).toBe(2)
    expect(rMultiple({ entry: 100, initialStop: 90, price: 85 })).toBe(-1.5)
  })
  it('degenerate risk → null', () => {
    expect(rMultiple({ entry: 100, initialStop: 100, price: 120 })).toBeNull()
    expect(rMultiple({ entry: 100, initialStop: 110, price: 120 })).toBeNull()
    expect(rMultiple({ entry: 100, initialStop: 90, price: null })).toBeNull()
  })
})

describe('blendLots', () => {
  it('weighted average', () => {
    expect(blendLots([{ shares: 100, entry: 100 }, { shares: 50, entry: 110 }])).toEqual({ shares: 150, avgEntry: 103.33 })
  })
  it('ignores junk lots; empty → nulls', () => {
    expect(blendLots([])).toEqual({ shares: 0, avgEntry: null })
    expect(blendLots([{ shares: 0, entry: 100 }, { shares: null, entry: 5 }])).toEqual({ shares: 0, avgEntry: null })
  })
})
