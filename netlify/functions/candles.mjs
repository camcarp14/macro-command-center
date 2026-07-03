// Intraday BTC candles: ?tf=1m|3m|5m|15m. Kraken primary (720 candles),
// Coinbase fallback (300); 3m aggregated from 1m. Live feed — no cache.
import { checkAuth, unauthorized, json, recordStatus } from '../shared/util.mjs'
import { fetchCandles } from '../shared/sources.mjs'
import { aggregateCandles } from '../../src/lib/ta.js'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const started = Date.now()
  const tf = new URL(req.url).searchParams.get('tf') || '5m'
  try {
    const { venue, candles } = await fetchCandles(tf)
    const out = tf === '3m' ? aggregateCandles(candles, 3) : candles
    recordStatus('candles', { ok: true, latencyMs: Date.now() - started, detail: `${tf} × ${out.length} via ${venue}` })
    return json({ tf, venue, candles: out, meta: { source: 'candles', fetchedAt: Date.now(), latencyMs: Date.now() - started } })
  } catch (e) {
    const msg = String(e?.message || e)
    recordStatus('candles', { ok: false, latencyMs: Date.now() - started, error: msg })
    return json({ error: msg, meta: { source: 'candles', failed: true } }, 502)
  }
}
