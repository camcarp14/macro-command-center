// Scheduled every 30 minutes (see SNAPSHOT_CRON). The free APIs only return
// "now", so this function is what builds the sparkline past for BTC, funding,
// Fear & Greed, health factor, and the composite score itself.
//
// Partial failure policy: a snapshot is still written with whatever sources
// succeeded; missing metrics are null and `errors` records what failed. The
// history is honest about its own gaps.
import { store, recordStatus, sendTelegram, telegramConfigured } from '../shared/util.mjs'
import { fetchFred, fetchMarket, fetchFunding, fetchFearGreed, fetchAave, getBtcHistoryCached } from '../shared/sources.mjs'
import { SNAPSHOT_CRON } from '../shared/schedule.mjs'
import { computeScore } from '../../src/lib/score.js'
import { latestValue, curveSpread, pctChangeNBack } from '../../src/lib/derive.js'
import { computeBtcStats } from '../../src/lib/btcstats.js'
import { evaluateSetups } from '../../src/lib/setups.js'

export const config = { schedule: SNAPSHOT_CRON }

const MAX_SNAPSHOTS = 2500 // ~52 days at 30-min cadence
const HF_BANDS = [
  { max: 1.1, name: 'CRITICAL' },
  { max: 1.25, name: 'DANGER' },
  { max: 1.5, name: 'WARN' },
  { max: Infinity, name: 'OK' },
]
const hfBand = (hf) => (Number.isFinite(hf) ? HF_BANDS.find((b) => hf < b.max || b.max === Infinity).name : 'UNKNOWN')

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
    // 4-week HY OAS momentum: latest minus the observation ~20 business days back.
    const oas = (S.BAMLH0A0HYM2 || []).filter((o) => Number.isFinite(o.v))
    m.hy_oas_4w_chg = oas.length > 20 ? Math.round((oas[0].v - oas[20].v) * 100) / 100 : null
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

  // ---- Setups: evaluate, alert on transitions, log activations ----
  const alertNotes = []
  try {
    let btcStats = null
    try {
      const h = await getBtcHistoryCached(s, { maxAgeMs: 12 * 3600 * 1000 })
      btcStats = computeBtcStats(h.prices)
    } catch (e) { errors.btchistory = String(e?.message || e) }

    const evaluated = evaluateSetups({ m, btc: btcStats })
    const prev = (await s.get('setup_state', { type: 'json' })) || {}
    const nextState = { ...prev }

    for (const su of evaluated) {
      const was = prev[su.key]?.active === true
      nextState[su.key] = { active: su.active, met: su.met, total: su.total, ts: Date.now() }
      if (su.active && !was) {
        // Activation: log it with the price, so the setup builds a track record.
        const log = (await s.get('trigger_log', { type: 'json' })) || []
        log.push({ ts: Date.now(), key: su.key, name: su.name, stance: su.stance, btc: m.btc ?? null, score: scored.score ?? null })
        await s.setJSON('trigger_log', log.slice(-500))
        const lines = su.conditions.map((c) => `• ${c.label}: ${c.valueText}`).join('\n')
        const r = await sendTelegram(`🎯 Setup ACTIVE: ${su.name}\n${lines}\nBTC $${m.btc ?? '—'} · score ${scored.score ?? '—'}\nDescriptive conditions read — not advice.`)
        alertNotes.push(`activated:${su.key}${r.sent ? '' : ` (telegram: ${r.reason})`}`)
      } else if (!su.active && was) {
        const r = await sendTelegram(`◽ Setup no longer active: ${su.name} (${su.met}/${su.total} conditions now met).`)
        alertNotes.push(`deactivated:${su.key}${r.sent ? '' : ` (telegram: ${r.reason})`}`)
      }
    }

    // ---- Position guard: alert when the health-factor band worsens ----
    const band = hfBand(m.aave_hf)
    const prevBand = prev.__hf_band?.name
    nextState.__hf_band = { name: band, ts: Date.now() }
    const order = ['OK', 'WARN', 'DANGER', 'CRITICAL']
    if (band !== 'UNKNOWN' && prevBand && order.indexOf(band) > order.indexOf(prevBand)) {
      const r = await sendTelegram(`⚠️ Aave health factor entered ${band}: HF ${m.aave_hf?.toFixed(3)} (BTC $${m.btc ?? '—'}). Check the Positions tab for stress levels.`)
      alertNotes.push(`hf:${prevBand}→${band}${r.sent ? '' : ` (telegram: ${r.reason})`}`)
    }

    await s.setJSON('setup_state', nextState)
  } catch (e) { errors.setups = String(e?.message || e) }

  await recordStatus('snapshot', {
    ok: Object.keys(errors).length === 0,
    latencyMs: Date.now() - started,
    error: Object.keys(errors).length ? JSON.stringify(errors) : null,
    detail: `wrote snapshot #${snaps.length}, score=${scored.score}${alertNotes.length ? ', ' + alertNotes.join(', ') : ''}${telegramConfigured() ? '' : ' (telegram not configured)'}`,
  })

  return new Response(JSON.stringify({ ok: true, snap, alerts: alertNotes }), { headers: { 'content-type': 'application/json' } })
}
