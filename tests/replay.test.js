import { describe, it, expect } from 'vitest'
import { replayRules } from '../src/lib/replay.js'
import { trendUp, trendDown, candlesFromCloses } from './fixtures.js'

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
  it('downtrend produces no long trades (regime filter holds)', () => {
    const { trades, summary } = replayRules(trendDown(160))
    expect(trades.length).toBe(0)
    expect(summary.trades).toBe(0)
    expect(summary.winRatePct).toBeNull()
  })

  it('insufficient data warns instead of guessing', () => {
    const { trades, warnings } = replayRules(trendUp(40))
    expect(trades).toEqual([])
    expect(warnings[0]).toContain('insufficient')
  })

  it('flat tape → no trades, empty summary shape intact', () => {
    const closes = Array.from({ length: 100 }, () => 100)
    const { summary } = replayRules(candlesFromCloses(closes))
    expect(summary).toMatchObject({ trades: 0, cumR: 0, maxDrawdownR: 0 })
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
