import { describe, it, expect } from 'vitest'
import { regime, pullbackSetup, breakout, exitFlags, btcAlignment } from '../src/lib/signals.js'
import { ema } from '../src/lib/ta.js'
import { trendUp, trendDown, candlesFromCloses, patchCandles } from './fixtures.js'

/** Engineered pullback scenario: 58 rising bars, one shallow down bar whose
 *  low we patch onto EMA20, then a pop closing above the prior bar's high. */
function pullbackScenario({ pop = true } = {}) {
  const closes = []
  let px = 100
  for (let i = 0; i < 59; i++) { closes.push(px); px *= 1.01 }
  closes.push(closes[58] * 0.99) // shallow down bar (index 59)
  closes.push(pop ? closes[59] * 1.03 : closes[59] * 1.001) // pop or drift (index 60)
  let candles = candlesFromCloses(closes)
  const e20 = ema(closes, 20)
  // put the dip bar's low right on EMA20 so the setup condition is factual
  candles = patchCandles(candles, { 59: { l: Math.round(e20[59] * 100) / 100 } })
  return candles
}

describe('regime', () => {
  it('sustained uptrend fixture reads uptrend with high score', () => {
    const r = regime(trendUp(120))
    expect(r.state).toBe('uptrend')
    expect(r.score).toBeGreaterThanOrEqual(70)
    expect(r.facts.length).toBeGreaterThanOrEqual(5)
  })
  it('sustained downtrend reads downtrend', () => {
    const r = regime(trendDown(120))
    expect(r.state).toBe('downtrend')
    expect(r.score).toBeLessThanOrEqual(30)
  })
  it('under 60 candles → insufficient_data, facts say how many', () => {
    const r = regime(trendUp(59))
    expect(r.state).toBe('insufficient_data')
    expect(r.facts[0]).toContain('59')
  })
  it('facts carry actual numbers', () => {
    const r = regime(trendUp(120))
    expect(r.facts.join(' ')).toMatch(/\d/)
  })
})

describe('pullbackSetup', () => {
  it('engineered dip-and-reclaim fires the trigger', () => {
    const p = pullbackSetup(pullbackScenario({ pop: true }))
    expect(p.stage).toBe('trigger')
    expect(p.refHigh).not.toBeNull()
    expect(p.facts.join(' ')).toContain('reclaimed')
  })
  it('dip without reclaim stays at setup', () => {
    const p = pullbackSetup(pullbackScenario({ pop: false }))
    expect(p.stage).toBe('setup')
  })
  it('no pullback in a bare uptrend → none', () => {
    const closes = []
    let px = 100
    for (let i = 0; i < 80; i++) { closes.push(px); px *= 1.012 }
    expect(pullbackSetup(candlesFromCloses(closes)).stage).toBe('none')
  })
  it('downtrend → none with regime fact', () => {
    const p = pullbackSetup(trendDown(120))
    expect(p.stage).toBe('none')
    expect(p.facts[0]).toContain('downtrend')
  })
  it('insufficient data → none', () => {
    expect(pullbackSetup(trendUp(30)).stage).toBe('none')
  })
})

describe('breakout', () => {
  it('new-high close over the prior 20-bar high is active', () => {
    const closes = []
    for (let i = 0; i < 70; i++) closes.push(100 + (i % 5)) // range-bound
    closes.push(112) // clears every prior high (max ~104 * 1.008)
    const b = breakout(candlesFromCloses(closes))
    expect(b.active).toBe(true)
    expect(b.level).toBeLessThan(112)
  })
  it('inside bar is not a breakout', () => {
    const closes = []
    for (let i = 0; i < 71; i++) closes.push(100 + (i % 5))
    expect(breakout(candlesFromCloses(closes)).active).toBe(false)
  })
  it('insufficient data guards', () => {
    expect(breakout(trendUp(40)).active).toBe(false)
  })
})

describe('exitFlags', () => {
  const position = { avgEntry: 100, initialStop: 90 }
  it('stop_breach fires when close is at/under the effective stop', () => {
    const candles = trendUp(120)
    const last = candles[candles.length - 1].c
    const flags = exitFlags({ candles, position, effectiveStop: last + 1 })
    expect(flags.some((f) => f.id === 'stop_breach' && f.severity === 'hard')).toBe(true)
  })
  it('collapse through EMA50 fires regime_break and ema20_lost', () => {
    const closes = []
    let px = 100
    for (let i = 0; i < 90; i++) { closes.push(px); px *= 1.01 }
    for (let i = 0; i < 5; i++) { closes.push(px); px *= 0.92 }
    const flags = exitFlags({ candles: candlesFromCloses(closes), position, effectiveStop: 1 })
    const ids = flags.map((f) => f.id)
    expect(ids).toContain('regime_break')
    expect(ids).toContain('ema20_lost')
    expect(flags.find((f) => f.id === 'regime_break').severity).toBe('hard')
    expect(flags.find((f) => f.id === 'ema20_lost').severity).toBe('soft')
  })
  it('healthy trend, stop far below → no flags', () => {
    const flags = exitFlags({ candles: trendUp(120), position, effectiveStop: 1 })
    expect(flags.filter((f) => f.severity === 'hard')).toEqual([])
  })
  it('no position → empty; short data → empty', () => {
    expect(exitFlags({ candles: trendUp(120), position: null, effectiveStop: 50 })).toEqual([])
    expect(exitFlags({ candles: trendUp(20), position, effectiveStop: 50 })).toEqual([])
  })
})

describe('btcAlignment', () => {
  it('uptrend aligns, downtrend does not', () => {
    expect(btcAlignment(trendUp(120)).aligned).toBe(true)
    expect(btcAlignment(trendDown(120)).aligned).toBe(false)
  })
  it('insufficient data does not align', () => {
    const a = btcAlignment(trendUp(10))
    expect(a.aligned).toBe(false)
    expect(a.state).toBe('insufficient_data')
  })
})
