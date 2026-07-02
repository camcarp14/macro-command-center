// Scheduled every 30 minutes (see SNAPSHOT_CRON). The free APIs only return
// "now", so this function is what builds the sparkline past for BTC, funding,
// Fear & Greed, health factor, and the composite score itself.
//
// Partial failure policy: a snapshot is still written with whatever sources
// succeeded; missing metrics are null and `errors` records what failed. The
// history is honest about its own gaps.
import { store, recordStatus } from '../shared/util.mjs'
import { fetchFred, fetchMarket, fetchFunding, fetchFearGreed, fetchAave } from '../shared/sources.mjs'
import { SNAPSHOT_CRON } from '../shared/schedule.mjs'
import { computeScore } from '../../src/lib/score.js'
import { latestValue, curveSpread, pctChangeNBack } from '../../src/lib/derive.js'

export const config = { schedule: SNAPSHOT_CRON }

const MAX_SNAPSHOTS = 2500 // ~52 days at 30-min cadence

export default async () => {
  const started = Date.now()
  const errors = {}
  const grab = async (name, fn) => {
    try { return await fn() } catch (e) { errors[name] = String(e?.message || e); return null }
  }

  const [fred, market, funding, fg, aave] = await Promise.all([
    grab('fred', () => fetchFred()),
    grab('market', () => fetchMarket()),
    grab('funding', () => fetchFunding()),
    grab('feargreed', () => fetchFearGreed()),
    grab('aave', () => fetchAave()),
  ])

  const m = {}
  if (fred) {
    const S = fred.series
    m.ust10y = latestValue(S.DGS10)?.value ?? null
    m.ust2y = latestValue(S.DGS2)?.value ?? null
    m.dff = latestValue(S.DFF)?.value ?? null
    m.dollar = latestValue(S.DTWEXBGS)?.value ?? null
    m.hy_oas = latestValue(S.BAMLH0A0HYM2)?.value ?? null
    m.walcl = latestValue(S.WALCL)?.value ?? null
    m.curve_2s10s = curveSpread(S.DGS10, S.DGS2)?.value ?? null
    m.qt_13w = pctChangeNBack(S.WALCL, 13)?.value ?? null
    m.policy_gap = Number.isFinite(m.dff) ? Math.round((m.dff - 2.5) * 1000) / 1000 : null
  }
  if (market) { m.btc = market.btc; m.btc_24h = market.btc24hPct }
  if (funding) { m.funding_8h = funding.funding8h; m.funding_ann = funding.fundingAnnualizedPct; m.funding_venue = funding.venue }
  if (fg) m.fear_greed = fg.value
  if (aave) m.aave_hf = aave.healthFactor

  const scored = computeScore(m)
  const snap = { ts: Date.now(), metrics: { ...m, score: scored.score }, inputsUsed: scored.inputsUsed, inputsTotal: scored.inputsTotal, errors: Object.keys(errors).length ? errors : undefined }

  const s = store()
  const snaps = (await s.get('snapshots', { type: 'json' })) || []
  snaps.push(snap)
  await s.setJSON('snapshots', snaps.slice(-MAX_SNAPSHOTS))
  await recordStatus('snapshot', {
    ok: Object.keys(errors).length === 0,
    latencyMs: Date.now() - started,
    error: Object.keys(errors).length ? JSON.stringify(errors) : null,
    detail: `wrote snapshot #${snaps.length}, score=${scored.score}`,
  })

  return new Response(JSON.stringify({ ok: true, snap }), { headers: { 'content-type': 'application/json' } })
}
