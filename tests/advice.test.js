import { describe, it, expect } from 'vitest'
import { composeDirective } from '../src/lib/advice.js'

// A fully-armed bullish input; individual tests break specific rungs.
const bullish = () => ({
  price: 412.35,
  freshQuote: { state: 'live' },
  freshBtc: { state: 'live' },
  freshCandles: { state: 'live' },
  regime: { state: 'uptrend', score: 100, facts: ['close above EMA20 400'] },
  btcAlign: { aligned: true, state: 'uptrend', score: 80, facts: [] },
  pullback: { stage: 'trigger', facts: ['trigger: close 412.35 reclaimed prior high 408.8'], refHigh: 408.8 },
  breakout: { active: false, facts: [] },
  exitFlags: [],
  position: null,
  effectiveStop: null,
  r: null,
  sizing: { ok: true, shares: 24, riskUsd: 990, positionUsd: 9896, positionPct: 9.9, capped: false },
  addSizing: null,
  torque: { read: { grade: 'fair', text: '1% BTC ≈ 1.8% MSTR; 1.7× NAV' } },
  marketSession: 'open',
})

const withPosition = (over = {}) => ({
  ...bullish(),
  position: { shares: 24, avgEntry: 380, initialStop: 342 },
  effectiveStop: 380,
  r: 0.85,
  pullback: { stage: 'none', facts: [] },
  sizing: null,
  addSizing: { ok: true, shares: 12, riskUsd: 495 },
  ...over,
})

describe('the priority ladder — first match wins', () => {
  it('1: NO_DATA beats everything, even a live trigger', () => {
    const d = composeDirective({ ...bullish(), price: null })
    expect(d.action).toBe('NO_DATA')
    const d2 = composeDirective({ ...bullish(), freshQuote: { state: 'dead' } })
    expect(d2.action).toBe('NO_DATA')
  })
  it('NO_DATA with an open position is urgent and says check your broker', () => {
    const d = composeDirective({ ...withPosition(), freshQuote: { state: 'dead' } })
    expect(d.action).toBe('NO_DATA')
    expect(d.severity).toBe('urgent')
    expect(d.reasons.join(' ')).toContain('broker')
  })
  it('2: STOP_OUT beats ADD even with a live pullback trigger', () => {
    const d = composeDirective(withPosition({
      pullback: { stage: 'trigger', facts: ['trigger'] },
      exitFlags: [{ id: 'stop_breach', severity: 'hard', fact: 'close 341 at/under the stop 342' }],
    }))
    expect(d.action).toBe('STOP_OUT')
    expect(d.severity).toBe('urgent')
    expect(d.headline).toContain('24')
  })
  it('3: hard flag without breach → EXIT', () => {
    const d = composeDirective(withPosition({
      exitFlags: [{ id: 'regime_break', severity: 'hard', fact: 'close lost EMA50' }],
    }))
    expect(d.action).toBe('EXIT')
  })
  it('4: soft flags only → TRIM', () => {
    const d = composeDirective(withPosition({
      exitFlags: [{ id: 'ema20_lost', severity: 'soft', fact: 'two closes under EMA20' }],
    }))
    expect(d.action).toBe('TRIM')
    expect(d.severity).toBe('act')
  })
  it('5: ADD needs trigger + uptrend + BTC + stop at/above breakeven + sizing', () => {
    const d = composeDirective(withPosition({
      pullback: { stage: 'trigger', facts: ['trigger: reclaimed'] },
    }))
    expect(d.action).toBe('ADD')
    expect(d.headline).toContain('12')
  })
  it('5 blocked: stop below breakeven → HOLD instead of ADD', () => {
    const d = composeDirective(withPosition({
      pullback: { stage: 'trigger', facts: ['trigger'] },
      effectiveStop: 360, // below avgEntry 380
    }))
    expect(d.action).toBe('HOLD')
  })
  it('6: plain position → HOLD with R and stop in the reasons', () => {
    const d = composeDirective(withPosition())
    expect(d.action).toBe('HOLD')
    const text = d.reasons.join(' ')
    expect(text).toContain('R')
    expect(text).toContain('380')
  })
  it('7: flat + trigger + alignment → ENTER with the size', () => {
    const d = composeDirective(bullish())
    expect(d.action).toBe('ENTER')
    expect(d.headline).toContain('24')
    expect(d.reasons.join(' ')).toContain('9.9')
  })
  it('7 via breakout when no pullback', () => {
    const d = composeDirective({
      ...bullish(),
      pullback: { stage: 'none', facts: [] },
      breakout: { active: true, level: 410, facts: ['close 412.35 cleared 20-bar high 410'] },
    })
    expect(d.action).toBe('ENTER')
    expect(d.headline).toContain('breakout')
  })
  it('8: uptrend without BTC confirmation → STAND_ASIDE with the beta-trade lecture', () => {
    const d = composeDirective({ ...bullish(), btcAlign: { aligned: false, state: 'chop', score: 40, facts: [] } })
    expect(d.action).toBe('STAND_ASIDE')
    expect(d.headline).toContain('BTC')
  })
  it('9: chop and flat → STAND_ASIDE, cash is a position', () => {
    const d = composeDirective({
      ...bullish(),
      regime: { state: 'chop', score: 40, facts: ['mixed'] },
      pullback: { stage: 'none', facts: [] },
    })
    expect(d.action).toBe('STAND_ASIDE')
  })
})

describe('honesty constraints', () => {
  it('stale (not dead) data still advises but carries a guardrail', () => {
    const d = composeDirective({ ...bullish(), freshQuote: { state: 'stale' } })
    expect(d.action).toBe('ENTER')
    expect(d.guardrails.join(' ')).toContain('stale')
  })
  it('dead BTC feed blocks ENTER even with a perfect trigger — and says why', () => {
    const d = composeDirective({ ...bullish(), freshBtc: { state: 'dead' } })
    expect(d.action).toBe('STAND_ASIDE')
    expect(d.headline).toContain('dead')
    expect(d.headline).toContain('trigger')
  })
  it('dead candle history blocks ENTER — regime reads on old tape buy nothing', () => {
    const d = composeDirective({ ...bullish(), freshCandles: { state: 'dead' } })
    expect(d.action).toBe('STAND_ASIDE')
    expect(d.headline).toContain('dead')
  })
  it('dead BTC feed blocks ADD — HOLD carries the blocked-add reason', () => {
    const d = composeDirective(withPosition({
      pullback: { stage: 'trigger', facts: ['trigger'] },
      freshBtc: { state: 'dead' },
    }))
    expect(d.action).toBe('HOLD')
    expect(d.reasons.join(' ')).toContain('blocked')
  })
  it('live trigger with failed sizing tells the truth about the blocker', () => {
    const d = composeDirective({ ...bullish(), sizing: { ok: false, error: 'risk_too_small_for_one_share' } })
    expect(d.action).toBe('STAND_ASIDE')
    expect(d.headline).toContain("can't be sized")
    expect(d.reasons.join(' ')).toContain('one whole share')
    expect(d.headline).not.toContain('no trigger')
  })
  it('blocked ADD (sizing) surfaces in HOLD instead of silence', () => {
    const d = composeDirective(withPosition({
      pullback: { stage: 'trigger', facts: ['trigger'] },
      addSizing: { ok: false, error: 'risk_too_small_for_one_share' },
    }))
    expect(d.action).toBe('HOLD')
    expect(d.reasons.join(' ')).toContain('add trigger active but blocked')
  })
  it('rich torque appends a guardrail on any action', () => {
    const d = composeDirective({ ...bullish(), torque: { read: { grade: 'rich', text: 'paying up' } } })
    expect(d.guardrails.join(' ')).toContain('RICH')
  })
  it('market closed note appended', () => {
    const d = composeDirective({ ...bullish(), marketSession: 'closed' })
    expect(d.guardrails.join(' ')).toContain('closed')
  })
  it('empty input degrades to NO_DATA, never throws', () => {
    expect(composeDirective({}).action).toBe('NO_DATA')
    expect(composeDirective().action).toBe('NO_DATA')
  })
})
