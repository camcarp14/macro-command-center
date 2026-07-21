import { describe, it, expect } from 'vitest'
import { replayRules } from '../src/lib/replay.js'
import { ema } from '../src/lib/ta.js'
import { breakout } from '../src/lib/signals.js'
import { trendUp, trendDown, candlesFromCloses } from './fixtures.js'

/** trendUp with 1% overnight gaps patched in: open[i] decoupled from
 *  close[i-1] so a lookahead fill (at the signal close) cannot masquerade
 *  as an honest next-open fill. */
function gappedTrendUp(n = 160) {
  return trendUp(n).map((c, i, arr) => {
    if (i === 0) return c
    const o = Math.round(arr[i - 1].c * 1.01 * 100) / 100
    return { ...c, o, h: Math.max(c.h, o), l: Math.min(c.l, o) }
  })
}

describe('replayRules on a sustained uptrend', () => {
  const candles = trendUp(160)
  const { trades, summary, warnings } = replayRules(candles)

  it('produces at least one trade with finite stats', () => {
    expect(trades.length).toBeGreaterThanOrEqual(1)
    expect(summary.trades).toBe(trades.length)
    expect(Number.isFinite(summary.cumR)).toBe(true)
  })

  it('every fill happens at the NEXT bar open, fee-adjusted (no lookahead)', () => {
    const byDate = new Map(candles.map((c) => [new Date(c.t * 1000).toISOString().slice(0, 10), c]))
    for (const t of trades) {
      const entryCandle = byDate.get(t.entryDate)
      expect(entryCandle).toBeDefined()
      expect(t.entryPx).toBeCloseTo(entryCandle.o * 1.001, 2)
      if (!t.openAtEnd) {
        const exitCandle = byDate.get(t.exitDate)
        expect(t.exitPx).toBeCloseTo(exitCandle.o * 0.999, 2)
      }
    }
  })

  it('R is internally consistent with the recorded fills and initial stop', () => {
    for (const t of trades) {
      const expected = (t.exitPx - t.entryPx) / (t.entryPx - t.initialStop)
      expect(t.r).toBeCloseTo(expected, 2)
      expect(t.initialStop).toBeLessThan(t.entryPx)
      expect(t.bars).toBeGreaterThanOrEqual(0)
    }
  })

  it('cumR equals the sum of trade Rs; drawdown non-negative', () => {
    const sum = trades.reduce((a, t) => a + (t.r ?? 0), 0)
    expect(summary.cumR).toBeCloseTo(sum, 1)
    expect(summary.maxDrawdownR).toBeGreaterThanOrEqual(0)
  })

  it('a trade still open at the end is flagged and warned about', () => {
    const open = trades.filter((t) => t.openAtEnd)
    if (open.length > 0) {
      expect(warnings.join(' ')).toContain('still open')
      expect(open.length).toBe(1)
      expect(trades[trades.length - 1].openAtEnd).toBe(true)
    }
  })
})

describe('replayRules honesty rails', () => {
  it('fills survive a gap fixture: entries land on the DECOUPLED next open, never the signal close', () => {
    const candles = gappedTrendUp(160)
    const { trades } = replayRules(candles)
    expect(trades.length).toBeGreaterThanOrEqual(1)
    const byDate = new Map(candles.map((c) => [new Date(c.t * 1000).toISOString().slice(0, 10), c]))
    for (const t of trades) {
      const entryCandle = byDate.get(t.entryDate)
      const idx = candles.indexOf(entryCandle)
      const signalClose = candles[idx - 1].c
      expect(t.entryPx).toBeCloseTo(entryCandle.o * 1.001, 2)
      // and the honest fill is measurably NOT the (1% lower) signal close
      expect(Math.abs(t.entryPx - signalClose * 1.001)).toBeGreaterThan(entryCandle.o * 0.005)
    }
  })

  it('a breakout pop still below EMA50 opens NOTHING — no doomed 1-bar churn trades', () => {
    // steep decline, then a pop that clears the 20-bar high but not EMA50
    const closes = []
    for (let i = 0; i < 70; i++) closes.push(100 * Math.pow(0.99, i))
    closes.push(closes[69] * 1.25)
    for (let i = 0; i < 10; i++) closes.push(closes[closes.length - 1] * 0.98)
    const candles = candlesFromCloses(closes)
    // preconditions: the pop IS a raw breakout signal, and IS below EMA50
    const seen = candles.slice(0, 71)
    expect(breakout(seen).active).toBe(true)
    const e50 = ema(seen.map((c) => c.c), 50)
    expect(seen[70].c).toBeLessThan(e50[70])
    const { trades } = replayRules(candles)
    expect(trades.length).toBe(0)
  })

  it('downtrend fixture generates no long trades', () => {
    const { trades, summary, warnings } = replayRules(trendDown(160))
    expect(trades.length).toBe(0)
    expect(summary.trades).toBe(0)
    expect(summary.winRatePct).toBeNull()
    expect(warnings.join(' ')).toContain('no trades')
  })

  it('insufficient data warns instead of guessing', () => {
    const { trades, warnings } = replayRules(trendUp(40))
    expect(trades).toEqual([])
    expect(warnings[0]).toContain('insufficient')
  })

  it('flat tape → no trades, empty summary shape intact, zero-trade warning present', () => {
    const closes = Array.from({ length: 100 }, () => 100)
    const { summary, warnings } = replayRules(candlesFromCloses(closes))
    expect(summary).toMatchObject({ trades: 0, cumR: 0, maxDrawdownR: 0 })
    expect(warnings.join(' ')).toContain('no trades')
  })

  it('engineered breakout-then-collapse round-trip: entry, exit, negative R, all consistent', () => {
    // A steadily declining base (regime never uptrend → pullback rule can't
    // claim anything), a violent breakout pop clearing the 20-bar high, two
    // follow bars, then a collapse breaking EMA50 → exactly one round-trip:
    // breakout entry at pop+1 open, exit on the break, negative R.
    const closes = []
    for (let i = 0; i < 70; i++) closes.push(100 * Math.pow(0.997, i))
    const popClose = closes[69] * 1.17
    closes.push(popClose) // breakout signal bar
    closes.push(popClose * 1.01, popClose * 1.02)
    for (let i = 0; i < 6; i++) closes.push(closes[closes.length - 1] * 0.9)
    const candles = candlesFromCloses(closes)
    const { trades } = replayRules(candles)
    expect(trades.length).toBe(1)
    const t = trades[0]
    expect(t.kind).toBe('breakout')
    // entry the day AFTER the signal: next bar's open = signal close, fee up
    expect(t.entryPx).toBeCloseTo(popClose * 1.001, 2)
    expect(t.r).toBeLessThan(0) // collapse exits below entry
    expect(t.exitPx).toBeLessThan(t.entryPx)
  })
})
