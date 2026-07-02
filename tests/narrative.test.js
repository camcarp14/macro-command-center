import { describe, it, expect } from 'vitest'
import { buildFactSheet, validateNarrative, displayText, buildPrompt } from '../src/lib/narrative.js'
import { costUsd, aggregateUsage } from '../src/lib/cost.js'

const METRICS = {
  score: 58.3, btc: 96412.77, btc_24h: -2.31, ust10y: 4.42, curve_2s10s: -0.38,
  hy_oas: 3.61, funding_ann: 12.4, fear_greed: 61, aave_hf: 1.82,
  ust10y_delta: 0.06, btc_delta: -2280,
}
const FACTS = buildFactSheet(METRICS)

describe('fact sheet', () => {
  it('includes only finite values, with deltas when present', () => {
    expect(FACTS.btc.value).toBe(96413) // rounded per spec
    expect(FACTS.ust10y.delta).toBe(0.06)
    expect(FACTS.dollar).toBeUndefined() // not provided => not invented
  })
  it('prompt hard-embeds the fact JSON', () => {
    const { user, system } = buildPrompt(FACTS)
    expect(user).toContain('"ust10y"')
    expect(system).toContain('ONLY reference numbers')
  })
})

describe('narrative validation — the story may never diverge from the data', () => {
  it('accepts a faithful narrative', () => {
    const text = `Pressure sits at 58.3 with the 10Y up at 4.42% and HY OAS at 3.61%. BTC took a -2.31% hit to $96,413 while funding runs 12.4% annualized — froth persists into weakness. Health factor 1.82: fine, not comfortable.\n<facts_used>{"score":58.3,"ust10y":4.42,"hy_oas":3.61,"btc":96413,"btc_24h":-2.31,"funding_ann":12.4,"aave_hf":1.82}</facts_used>`
    const r = validateNarrative(text, FACTS)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('rejects a fabricated number not on screen', () => {
    const text = `BTC at $96,413 but watch the $88,500 support level.\n<facts_used>{"btc":96413}</facts_used>`
    const r = validateNarrative(text, FACTS)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('$88,500')
  })

  it('rejects a citation that contradicts the on-screen value', () => {
    const text = `The 10Y sits at 4.62%.\n<facts_used>{"ust10y":4.62}</facts_used>`
    const r = validateNarrative(text, FACTS)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('on-screen value is 4.42')
  })

  it('rejects direction words that contradict the delta', () => {
    const text = `The 10Y fell to 4.42% overnight.\n<facts_used>{"ust10y":4.42}</facts_used>`
    const r = validateNarrative(text, FACTS) // ust10y delta is +0.06
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/implies "10Y Treasury yield" fell/)
  })

  it('rejects a narrative with no facts_used footer', () => {
    expect(validateNarrative('Everything is fine.', FACTS).ok).toBe(false)
  })

  it('tolerates benign small integers ("24h", "10Y", scenario labels")', () => {
    const text = `Over 24h and across the 10, 20, 30, 40 stress rungs, HF holds: 1.82.\n<facts_used>{"aave_hf":1.82}</facts_used>`
    expect(validateNarrative(text, FACTS).ok).toBe(true)
  })

  it('displayText strips the machine footer', () => {
    expect(displayText('Take.\n<facts_used>{"a":1}</facts_used>')).toBe('Take.')
  })
})

describe('token cost math', () => {
  it('prices known models exactly', () => {
    // sonnet-4-6: $3/MTok in, $15/MTok out
    expect(costUsd('claude-sonnet-4-6', 1200, 400)).toBeCloseTo(0.0036 + 0.006, 9)
  })
  it('unknown model => null, never silently $0', () => {
    expect(costUsd('claude-mystery-9', 1e6, 1e6)).toBeNull()
  })
  it('aggregates today/week/month and counts unpriced calls', () => {
    const now = Date.now()
    const entries = [
      { ts: now - 1000, costUsd: 0.02 },
      { ts: now - 8 * 24 * 3600 * 1000, costUsd: 0.5 },
      { ts: now - 1000, costUsd: null },
    ]
    const t = aggregateUsage(entries, now)
    expect(t.today).toBeCloseTo(0.02, 9)
    expect(t.month).toBeCloseTo(0.52, 9)
    expect(t.unpriced).toBe(1)
  })
})
