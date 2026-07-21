// First-deploy diagnostic: live-pings every upstream and reports the Blobs
// health map. If a number on the cockpit looks wrong, this endpoint says
// which upstream to blame — facts before theories.
import { json, checkAuth, unauthorized, store, fetchWithTimeout } from '../shared/util.mjs'

const PROBES = [
  ['yahoo', 'https://query1.finance.yahoo.com/v8/finance/chart/MSTR?interval=1d&range=1d'],
  ['stooq', 'https://stooq.com/q/d/l/?s=mstr.us&i=d'],
  ['binance', 'https://api.binance.com/api/v3/ping'],
  ['coinbase', 'https://api.coinbase.com/v2/prices/BTC-USD/spot'],
  ['coingecko', 'https://api.coingecko.com/api/v3/ping'],
]

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()

  const pings = {}
  await Promise.all(PROBES.map(async ([name, url]) => {
    const started = Date.now()
    try {
      const res = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, 2500)
      pings[name] = { ok: res.ok, httpStatus: res.status, latencyMs: Date.now() - started }
    } catch (e) {
      pings[name] = { ok: false, error: String(e?.message || e), latencyMs: Date.now() - started }
    }
  }))

  let sourceStatus = null
  let blobs = { ok: true }
  try {
    sourceStatus = (await store().get('source_status', { type: 'json' })) || {}
  } catch (e) {
    blobs = { ok: false, error: String(e?.message || e) }
  }

  return json({ pings, sourceStatus, blobs, meta: { fetchedAt: Date.now() } })
}
