import { describe, it, expect } from 'vitest'
import { armChecklist, triggerTickets, thesisBreaks } from '../src/lib/runplan.js'
import { breakout, pullbackSetup } from '../src/lib/signals.js'
import { atr, ema } from '../src/lib/ta.js'
import { initialStop, sizePosition } from '../src/lib/risk.js'
import { trendUp, trendDown, candlesFromCloses, patchCandles } from './fixtures.js'

const SETTINGS = { equity: 100000, riskPct: 1, maxPositionPct: 30, atrMult: 2.5 }

/** the proven pullback-trigger construction from the signals suite */
function triggerScenario() {
  const closes = []
  let px = 100
  for (let i = 0; i < 59; i++) { closes.push(px); px *= 1.01 }
  closes.push(closes[58] * 0.99)
  closes.push(closes[59] * 1.03)
  let candles = candlesFromCloses(closes)
  const e20 = ema(closes, 20)
  return patchCandles(candles, { 59: { l: Math.round(e20[59] * 100) / 100 } })
}

describe('armChecklist', () => {
  it('strong uptrend + aligned BTC + live trigger → ready and armed', () => {
    const a = armChecklist(triggerScenario(), trendUp(120))
    expect(a.ready).toBe(true)
    expect(a.armed).toBe(true)
    expect(a.mstr.filter((c) => c.pass).length).toBeGreaterThanOrEqual(4)
  })
  it('downtrend: fails with honest positive distances to the flip levels', () => {
    const a = armChecklist(trendDown(120), trendDown(120))
    expect(a.ready).toBe(false)
    expect(a.armed).toBe(false)
    const e50 = a.mstr.find((c) => c.id === 'close_ema50')
    expect(e50.pass).toBe(false)
    expect(e50.distancePct).toBeGreaterThan(0) // the level sits ABOVE price
    expect(e50.level).toBeGreaterThan(0)
    expect(a.btc.pass).toBe(false)
  })
  it('breakout path carries the exact level and distance when not active', () => {
    const a = armChecklist(trendDown(120), trendUp(120))
    expect(a.paths.breakout.active).toBe(false)
    expect(a.paths.breakout.level).toBeGreaterThan(0)
    expect(a.paths.breakout.distancePct).toBeGreaterThan(0)
  })
  it('insufficient data says so instead of guessing', () => {
    const a = armChecklist(trendUp(30), trendUp(120))
    expect(a.insufficient).toBe(true)
    expect(a.armed).toBe(false)
  })
})

describe('triggerTickets', () => {
  it('breakout ticket sizes with the PRODUCTION risk engine at the trigger level', () => {
    const candles = trendDown(120) // breakout not active → ticket exists
    const tickets = triggerTickets({ mstrCandles: candles, settings: SETTINGS })
    const bo = tickets.find((t) => t.name === 'Breakout day')
    expect(bo).toBeDefined()
    const level = breakout(candles).level
    expect(bo.entry).toBeCloseTo(level, 2)
    const a = atr(candles, 14)[candles.length - 1]
    const st = initialStop({ mode: 'atr', entry: level, atr: a, atrMult: 2.5 })
    expect(bo.stop).toBe(st.stop)
    const sz = sizePosition({ equity: 100000, riskPct: 1, entry: level, stop: st.stop, maxPositionPct: 30 })
    expect(bo.shares).toBe(sz.shares)
    expect(bo.riskUsd).toBe(sz.riskUsd)
  })
  it('pullback ticket appears in an uptrend with a live setup, priced at the reclaim level', () => {
    const candles = triggerScenario()
    const tickets = triggerTickets({ mstrCandles: candles, settings: SETTINGS })
    const pb = tickets.find((t) => t.name === 'Pullback reclaim')
    expect(pb).toBeDefined()
    expect(pb.entry).toBeCloseTo(pullbackSetup(candles).refHigh, 2)
    expect(pb.shares).toBeGreaterThan(0)
  })
  it('no settings / short data → empty, never throws', () => {
    expect(triggerTickets({ mstrCandles: trendUp(120), settings: null })).toEqual([])
    expect(triggerTickets({ mstrCandles: trendUp(20), settings: SETTINGS })).toEqual([])
  })
})

describe('thesisBreaks', () => {
  it('names the swing low, the downtrend line, and the BTC 50-day with levels', () => {
    const breaks = thesisBreaks(trendUp(120), trendUp(120))
    const ids = breaks.map((b) => b.id)
    expect(ids).toContain('swing_low')
    expect(ids).toContain('downtrend')
    expect(ids).toContain('btc_break')
    expect(breaks.find((b) => b.id === 'swing_low').level).toBeGreaterThan(0)
  })
  it('short data → empty', () => {
    expect(thesisBreaks(trendUp(20), trendUp(120))).toEqual([])
  })
})
