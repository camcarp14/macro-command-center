import { describe, it, expect } from 'vitest'
import { buildMarketRead, SIGNAL_DEFS } from '../src/lib/signals.js'

describe('buildMarketRead', () => {
  it('returns a descriptive state for every metric present', () => {
    const reads = buildMarketRead({
      funding_ann: 25, fear_greed: 20, hy_oas: 5, curve_2s10s: -0.4, policy_gap: 2, aave_hf: 1.1,
    })
    expect(reads).toHaveLength(6)
    expect(reads.find((r) => r.key === 'leverage').state).toBe('CROWDED LONG')
    expect(reads.find((r) => r.key === 'sentiment').state).toBe('EXTREME FEAR')
    expect(reads.find((r) => r.key === 'credit').state).toBe('MARKET STRESSED')
    expect(reads.find((r) => r.key === 'curve').state).toBe('INVERTED')
    expect(reads.find((r) => r.key === 'fed').state).toBe('RESTRICTIVE')
    expect(reads.find((r) => r.key === 'position').state).toBe('AT RISK')
  })

  it('omits a signal when its underlying metric is missing (never fabricates)', () => {
    const reads = buildMarketRead({ funding_ann: 10 })
    expect(reads).toHaveLength(1)
    expect(reads[0].key).toBe('leverage')
  })

  it('reads balanced/neutral states for mid-range values', () => {
    const reads = buildMarketRead({ funding_ann: 5, fear_greed: 50, hy_oas: 3, curve_2s10s: 0, policy_gap: 0.1, aave_hf: 2 })
    expect(reads.find((r) => r.key === 'leverage').state).toBe('BALANCED')
    expect(reads.find((r) => r.key === 'credit').state).toBe('MARKET CALM')
    expect(reads.find((r) => r.key === 'fed').state).toBe('NEAR NEUTRAL')
    expect(reads.find((r) => r.key === 'position').state).toBe('SAFE')
  })

  it('every definition has a plain-English sentence, no jargon-only output', () => {
    const reads = buildMarketRead({ funding_ann: 0, fear_greed: 50, hy_oas: 3, curve_2s10s: 0.2, policy_gap: 0, aave_hf: 2 })
    for (const r of reads) {
      expect(r.plain.length).toBeGreaterThan(20)
      expect(r.tone).toMatch(/live|stale|down|sync/)
    }
    expect(SIGNAL_DEFS).toHaveLength(6)
  })
})
