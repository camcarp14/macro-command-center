import { describe, it, expect } from 'vitest'
import { buildAttention, hfBandName } from '../src/lib/attention.js'

const setup = (over = {}) => ({ key: 'x', name: 'Test setup', total: 3, met: 3, unknown: 0, active: true, conditions: [], ...over })

describe('attention stack', () => {
  it('position danger outranks an active setup, which outranks a near-miss', () => {
    const items = buildAttention({
      metrics: { aave_hf: 1.2, aave_liq_dd: -16 },
      setups: [
        setup({ active: false, met: 2, conditions: [{ label: 'A', met: true }, { label: 'B', met: true }, { label: 'C', met: false, valueText: 'HY OAS 2.7%' }] }),
        setup({ name: 'Active one' }),
      ],
      score: 62, bandName: 'elevated',
    })
    expect(items[0].title).toContain('Position health: DANGER')
    expect(items[1].title).toContain('Setup ACTIVE: Active one')
    expect(items[2].title).toContain('One condition from active')
    expect(items[2].body).toContain('HY OAS 2.7%')
  })

  it('a setup with unknown legs can never be reported as one-away', () => {
    const items = buildAttention({ setups: [setup({ active: false, met: 2, unknown: 1 })] })
    expect(items.some((i) => i.title.includes('One condition'))).toBe(false)
  })

  it('quiet market yields the honest nothing-needs-you state', () => {
    const items = buildAttention({ metrics: { aave_hf: 2.1 }, setups: [setup({ active: false, met: 0 })], score: 26, bandName: 'benign' })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Nothing needs your attention')
    expect(items[0].body).toContain('quiet tape is a valid answer')
  })

  it('trending 15m tape and non-benign macro both surface at P3; caps at 5 items', () => {
    const many = Array.from({ length: 6 }, (_, i) => setup({ name: `S${i}` }))
    const items = buildAttention({ setups: many, regime: { state: 'TRENDING UP', tone: 'live', plain: 'up' }, score: 71, bandName: 'stress' })
    expect(items.length).toBe(5)
    expect(items.every((i, idx) => idx === 0 || items[idx - 1].priority <= i.priority)).toBe(true)
  })

  it('hf bands match the documented thresholds', () => {
    expect(hfBandName(1.05)).toBe('CRITICAL')
    expect(hfBandName(1.2)).toBe('DANGER')
    expect(hfBandName(1.4)).toBe('WATCH')
    expect(hfBandName(1.8)).toBe('OK')
    expect(hfBandName(NaN)).toBeNull()
  })
})
