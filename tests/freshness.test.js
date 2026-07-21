import { describe, it, expect } from 'vitest'
import { freshness, ageLabel, nyseSessionState, SOURCE_MAX_AGE_SEC } from '../src/lib/freshness.js'

const NOW = Date.UTC(2026, 6, 21, 15, 0, 0) // Tue 2026-07-21 15:00 UTC

describe('freshness states at exact boundaries', () => {
  it('quote: live under 1200s, stale to 3600s, dead beyond', () => {
    expect(freshness(NOW - 1199_000, 'quote', NOW).state).toBe('live')
    expect(freshness(NOW - 1200_000, 'quote', NOW).state).toBe('stale')
    expect(freshness(NOW - 3599_000, 'quote', NOW).state).toBe('stale')
    expect(freshness(NOW - 3600_000, 'quote', NOW).state).toBe('dead')
  })
  it('btc: 180s window', () => {
    expect(freshness(NOW - 179_000, 'btc', NOW).state).toBe('live')
    expect(freshness(NOW - 200_000, 'btc', NOW).state).toBe('stale')
  })
  it('never fetched → dead with em-dash label', () => {
    expect(freshness(null, 'quote', NOW)).toEqual({ state: 'dead', ageSec: null, label: '—' })
  })
  it('unknown key falls back to 600s', () => {
    expect(freshness(NOW - 599_000, 'mystery', NOW).state).toBe('live')
    expect(freshness(NOW - 601_000, 'mystery', NOW).state).toBe('stale')
  })
  it('daily candles tolerate 26h', () => {
    expect(SOURCE_MAX_AGE_SEC.candles_1d).toBe(93600)
    expect(freshness(NOW - 90000_000, 'candles_1d', NOW).state).toBe('live')
  })
})

describe('ageLabel', () => {
  it('formats per magnitude', () => {
    expect(ageLabel(12)).toBe('12s ago')
    expect(ageLabel(180)).toBe('3m ago')
    expect(ageLabel(7200)).toBe('2h ago')
    expect(ageLabel(259200)).toBe('3d ago')
  })
})

describe('nyseSessionState (approx, DST-aware via America/New_York)', () => {
  it('EDT (July): 13:30–20:00 UTC session boundaries', () => {
    expect(nyseSessionState(Date.UTC(2026, 6, 22, 13, 29))).toBe('closed') // Wed 9:29 ET
    expect(nyseSessionState(Date.UTC(2026, 6, 22, 13, 30))).toBe('open')   // 9:30 ET
    expect(nyseSessionState(Date.UTC(2026, 6, 22, 19, 59))).toBe('open')   // 15:59 ET
    expect(nyseSessionState(Date.UTC(2026, 6, 22, 20, 0))).toBe('closed')  // 16:00 ET
  })
  it('EST (January): the session shifts to 14:30–21:00 UTC — the last trading hour is OPEN', () => {
    expect(nyseSessionState(Date.UTC(2025, 0, 6, 13, 30))).toBe('closed') // Mon 8:30 ET premarket
    expect(nyseSessionState(Date.UTC(2025, 0, 6, 14, 30))).toBe('open')   // 9:30 ET
    expect(nyseSessionState(Date.UTC(2025, 0, 6, 20, 30))).toBe('open')   // 15:30 ET — the hour the old UTC-hardcode mislabeled
    expect(nyseSessionState(Date.UTC(2025, 0, 6, 21, 0))).toBe('closed')  // 16:00 ET
  })
  it('weekend closed', () => {
    expect(nyseSessionState(Date.UTC(2025, 0, 11, 15, 0))).toBe('closed') // Sat
  })
})
