// 365 days of BTC daily closes + derived stats (200d MA distance, drawdown
// from high, realized vol). Cached in Blobs for 6h; ?refresh=1 forces it.
// Stale cache after a failed refresh is served loudly labeled, never silently.
import { checkAuth, unauthorized, json, store, recordStatus } from '../shared/util.mjs'
import { getBtcHistoryCached } from '../shared/sources.mjs'
import { computeBtcStats } from '../../src/lib/btcstats.js'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const started = Date.now()
  const refresh = new URL(req.url).searchParams.get('refresh') === '1'
  try {
    const h = await getBtcHistoryCached(store(), { refresh })
    const stats = computeBtcStats(h.prices)
    // Thin to one point/day for the wire; stats were computed on the full set.
    const series = h.prices.map(([t, p]) => [t, Math.round(p)])
    recordStatus('btchistory', { ok: h.cache !== 'stale-after-error', latencyMs: Date.now() - started, error: h.staleError || null, detail: `cache ${h.cache}, ${series.length} pts` })
    return json({ stats, series, meta: { source: 'btchistory', fetchedAt: h.fetchedAt, cache: h.cache, staleError: h.staleError, latencyMs: Date.now() - started } })
  } catch (e) {
    const msg = String(e?.message || e)
    recordStatus('btchistory', { ok: false, latencyMs: Date.now() - started, error: msg })
    return json({ error: msg, meta: { source: 'btchistory', failed: true } }, 502)
  }
}
