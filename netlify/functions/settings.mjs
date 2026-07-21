// Risk parameters + MSTR balance-sheet inputs. Seeded holdings/share counts
// are flagged until the user verifies them against the latest 8-K — the UI
// shows an amber chip until then.
import { json, checkAuth, unauthorized, store } from '../shared/util.mjs'
import { validateSettings } from '../shared/validate.mjs'

export const DEFAULTS = {
  equity: 100000,
  riskPct: 1,
  maxPositionPct: 30,
  stopMode: 'atr',
  atrMult: 2.5,
  stopPct: 8,
  chandelierPeriod: 22,
  chandelierMult: 3,
  beAtR: 1,
  addRiskFraction: 0.5,
  btcHoldings: 650000,
  btcHoldingsAsOf: '2025-12-31',
  btcHoldingsSeeded: true,
  sharesOutstanding: 290000000,
  sharesOutstandingAsOf: '2025-12-31',
  sharesSeeded: true,
}

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()

  if (req.method === 'GET') {
    const saved = (await s.get('settings', { type: 'json' })) || {}
    return json({ settings: { ...DEFAULTS, ...saved } })
  }

  if (req.method === 'PUT') {
    const body = await req.json().catch(() => null)
    const v = validateSettings(body)
    if (!v.ok) return json({ error: 'validation failed', errors: v.errors }, 400)
    const saved = (await s.get('settings', { type: 'json' })) || {}
    const next = { ...saved, ...v.value }
    const today = new Date().toISOString().slice(0, 10)
    if ('btcHoldings' in v.value) { next.btcHoldingsSeeded = false; next.btcHoldingsAsOf = today }
    if ('sharesOutstanding' in v.value) { next.sharesSeeded = false; next.sharesOutstandingAsOf = today }
    await s.setJSON('settings', next)
    return json({ settings: { ...DEFAULTS, ...next } })
  }

  return json({ error: 'method not allowed' }, 405)
}
