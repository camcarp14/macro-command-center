import { describe, it, expect } from 'vitest'
import { computeScore, normalize, INPUTS } from '../src/lib/score.js'

const MIDPOINTS = {
  hy_oas: 4.25, ust10y: 4.5, policy_gap: 1.5, curve_2s10s: -0.5,
  dollar: 121, qt_13w: -1.0, funding_ann: 10, fear_greed: 50,
}

describe('composite score', () => {
  it('weights are declared and sum to 1.0', () => {
    expect(INPUTS.reduce((s, i) => s + i.weight, 0)).toBeCloseTo(1.0, 9)
  })

  it('all inputs at range midpoints => exactly 50', () => {
    const r = computeScore(MIDPOINTS)
    expect(r.score).toBe(50)
    expect(r.inputsUsed).toBe(8)
    expect(r.renormalized).toBe(false)
    for (const b of r.breakdown) expect(b.normalized).toBe(50)
  })

  it('known hand-computed case', () => {
    // hy 6.0 -> 100*.20=20 ; 10y 5.5 -> 100*.15=15 ; gap 3.0 -> 100*.15=15
    // curve -1.5 -> inverted dir: 100*.10=10 ; dollar 130 -> 10
    // qt -3 -> 10 ; funding 30 -> 10 ; fg 90 -> 10  => 100
    const r = computeScore({ hy_oas: 6, ust10y: 5.5, policy_gap: 3, curve_2s10s: -1.5, dollar: 130, qt_13w: -3, funding_ann: 30, fear_greed: 90 })
    expect(r.score).toBe(100)
  })

  it('mixed case computes exact weighted sum', () => {
    // hy 3.2 -> (0.7/3.5)*100 = 20 -> contrib 4
    // 10y 4.0 -> 25 -> 3.75 ; gap 0.75 -> 25 -> 3.75
    // curve 0.0 -> raw 75, inverted 25 -> 2.5 ; dollar 116.5 -> 25 -> 2.5
    // qt 0.0 -> raw 75, inverted 25 -> 2.5 ; funding 0 -> 25 -> 2.5 ; fg 30 -> 25 -> 2.5
    const r = computeScore({ hy_oas: 3.2, ust10y: 4.0, policy_gap: 0.75, curve_2s10s: 0.0, dollar: 116.5, qt_13w: 0.0, funding_ann: 0, fear_greed: 30 })
    expect(r.score).toBe(24) // 4+3.75+3.75+2.5*5 = 24.0
  })

  it('clamps outside the range', () => {
    expect(normalize(999, { min: 0, max: 10, direction: 1 })).toBe(100)
    expect(normalize(-999, { min: 0, max: 10, direction: 1 })).toBe(0)
  })

  it('missing inputs are excluded, weights renormalized, and reported', () => {
    const { funding_ann, fear_greed, ...partial } = MIDPOINTS
    const r = computeScore(partial)
    expect(r.inputsUsed).toBe(6)
    expect(r.renormalized).toBe(true)
    // all present at midpoint still => 50 after renormalization
    expect(r.score).toBe(50)
    const excluded = r.breakdown.filter((b) => !b.included)
    expect(excluded.map((b) => b.key).sort()).toEqual(['fear_greed', 'funding_ann'])
    for (const b of excluded) {
      expect(b.contribution).toBeNull()
      expect(b.effectiveWeight).toBe(0)
    }
    const effSum = r.breakdown.reduce((s, b) => s + b.effectiveWeight, 0)
    expect(effSum).toBeCloseTo(1.0, 3)
  })

  it('no inputs => null score, never a fabricated number', () => {
    const r = computeScore({})
    expect(r.score).toBeNull()
  })
})
