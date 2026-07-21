import { describe, it, expect } from 'vitest'
import { validateSettings, validatePosition, validateTrade } from '../netlify/shared/validate.mjs'

describe('validateSettings', () => {
  it('accepts a sane partial patch', () => {
    const v = validateSettings({ equity: 250000, riskPct: 0.75, stopMode: 'structure' })
    expect(v.ok).toBe(true)
    expect(v.value).toEqual({ equity: 250000, riskPct: 0.75, stopMode: 'structure' })
  })
  it('rejects unknown keys loudly (typos must not silently no-op)', () => {
    const v = validateSettings({ riskPtc: 1 })
    expect(v.ok).toBe(false)
    expect(v.errors[0]).toContain('riskPtc')
  })
  it('enforces bounds: riskPct ≤ 5, equity > 0, atrMult range', () => {
    expect(validateSettings({ riskPct: 6 }).ok).toBe(false)
    expect(validateSettings({ equity: 0 }).ok).toBe(false)
    expect(validateSettings({ atrMult: 0.1 }).ok).toBe(false)
    expect(validateSettings({ atrMult: 2.5 }).ok).toBe(true)
  })
  it('enum + integer rules', () => {
    expect(validateSettings({ stopMode: 'vibes' }).ok).toBe(false)
    expect(validateSettings({ chandelierPeriod: 22.5 }).ok).toBe(false)
    expect(validateSettings({ chandelierPeriod: 22 }).ok).toBe(true)
  })
  it('non-object input', () => {
    expect(validateSettings(null).ok).toBe(false)
    expect(validateSettings([1]).ok).toBe(false)
  })
})

describe('validatePosition', () => {
  const good = { shares: 24, avgEntry: 412.5, entryDate: '2026-07-01', initialStop: 375 }
  it('accepts a sane position', () => {
    const v = validatePosition(good)
    expect(v.ok).toBe(true)
    expect(v.value.stopOverride).toBeNull()
  })
  it('stop must sit below entry', () => {
    expect(validatePosition({ ...good, initialStop: 412.5 }).ok).toBe(false)
    expect(validatePosition({ ...good, initialStop: 500 }).ok).toBe(false)
  })
  it('shares integer, date shape, note cap', () => {
    expect(validatePosition({ ...good, shares: 10.5 }).ok).toBe(false)
    expect(validatePosition({ ...good, entryDate: '07/01/2026' }).ok).toBe(false)
    expect(validatePosition({ ...good, note: 'x'.repeat(501) }).ok).toBe(false)
  })
})

describe('validateTrade', () => {
  const good = { entryDate: '2026-06-01', exitDate: '2026-06-20', entry: 380, exit: 425, shares: 30, initialStop: 355 }
  it('accepts a sane trade, defaults kind to manual', () => {
    const v = validateTrade(good)
    expect(v.ok).toBe(true)
    expect(v.value.kind).toBe('manual')
  })
  it('exit before entry rejected', () => {
    expect(validateTrade({ ...good, exitDate: '2026-05-30' }).ok).toBe(false)
  })
  it('same-day round trip allowed', () => {
    expect(validateTrade({ ...good, exitDate: '2026-06-01' }).ok).toBe(true)
  })
  it('kind whitelist', () => {
    expect(validateTrade({ ...good, kind: 'yolo' }).ok).toBe(false)
    expect(validateTrade({ ...good, kind: 'pullback' }).ok).toBe(true)
  })
})
