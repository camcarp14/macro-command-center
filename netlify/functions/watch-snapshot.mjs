// Scheduled sentinel (every 30 min, netlify.toml). Watches the stop even
// when the app is closed: STOP HIT / STOP NEAR alerts on an open position,
// ENTRY SIGNAL when flat. Telegram-optional, deduped, and never throws —
// a broken sentinel must not look like a broken market.
import { json, store, sendTelegram } from '../shared/util.mjs'
import { mstrQuote, btcSpot, mstrCandles } from '../shared/sources.mjs'
import { anchoredChandelier, effectiveStop } from '../../src/lib/risk.js'
import { pullbackSetup, breakout } from '../../src/lib/signals.js'

const DEDUPE_MS = 6 * 3600 * 1000
const SPARK_CAP = 400

export default async () => {
  try {
    const s = store()
    const [quote, btc] = await Promise.allSettled([mstrQuote(), btcSpot()])
    const mstrPx = quote.status === 'fulfilled' ? quote.value.price : null
    const btcPx = btc.status === 'fulfilled' ? btc.value.price : null

    // spark history for the "since you left" strip
    try {
      const hist = (await s.get('spark_history', { type: 'json' })) || []
      hist.push({ t: Date.now(), mstr: mstrPx, btc: btcPx })
      await s.setJSON('spark_history', hist.slice(-SPARK_CAP))
    } catch { /* history is a nicety, never a failure */ }

    if (mstrPx == null) return json({ ok: false, reason: 'no MSTR price; skipping alert pass' })

    const settings = { chandelierPeriod: 22, chandelierMult: 3, beAtR: 1, ...((await s.get('settings', { type: 'json' })) || {}) }
    const position = await s.get('position', { type: 'json' })
    const alerts = []

    if (position) {
      const { candles } = await mstrCandles('1d')
      const entryIdx = candles.findIndex((c) => new Date(c.t * 1000).toISOString().slice(0, 10) >= position.entryDate)
      let stop = position.stopOverride ?? position.initialStop
      if (entryIdx >= 0) {
        const trail = anchoredChandelier(candles, {
          entryIdx,
          atrPeriod: settings.chandelierPeriod,
          mult: settings.chandelierMult,
          initialStop: position.initialStop,
        })
        let hcse = -Infinity
        for (let k = entryIdx; k < candles.length; k++) hcse = Math.max(hcse, candles[k].c)
        stop = effectiveStop({
          initialStop: position.initialStop,
          trailStop: trail.length ? trail[trail.length - 1] : null,
          entry: position.avgEntry,
          beAtR: settings.beAtR,
          highestCloseSinceEntry: hcse,
        }) ?? stop
        if (Number.isFinite(position.stopOverride)) stop = Math.max(stop, position.stopOverride)
      }
      if (Number.isFinite(stop)) {
        if (mstrPx <= stop) {
          alerts.push({ key: `stop_hit_${stop.toFixed(2)}`, text: `🔴 TORQUE: STOP HIT — MSTR ${mstrPx} at/under stop ${stop.toFixed(2)}. Sell ${position.shares} shares per plan.` })
        } else if ((mstrPx - stop) / mstrPx <= 0.03) {
          alerts.push({ key: `stop_near_${stop.toFixed(2)}`, text: `🟠 TORQUE: STOP NEAR — MSTR ${mstrPx}, stop ${stop.toFixed(2)} (${(((mstrPx - stop) / mstrPx) * 100).toFixed(1)}% away).` })
        }
      }
    } else {
      const { candles } = await mstrCandles('1d')
      const pb = pullbackSetup(candles)
      const bo = breakout(candles)
      if (pb.stage === 'trigger') alerts.push({ key: 'entry_pullback', text: `🟢 TORQUE: ENTRY SIGNAL — pullback trigger on MSTR at ${mstrPx}. Open the cockpit before acting.` })
      else if (bo.active) alerts.push({ key: 'entry_breakout', text: `🟢 TORQUE: ENTRY SIGNAL — breakout over ${bo.level} on MSTR at ${mstrPx}. Open the cockpit before acting.` })
    }

    let sent = 0
    if (alerts.length) {
      const log = (await s.get('alerts_sent', { type: 'json' })) || {}
      const now = Date.now()
      for (const a of alerts) {
        if (log[a.key] && now - log[a.key] < DEDUPE_MS) continue
        const res = await sendTelegram(a.text)
        if (res.sent) { log[a.key] = now; sent++ }
      }
      await s.setJSON('alerts_sent', log)
    }
    return json({ ok: true, mstrPx, btcPx, alertsConsidered: alerts.length, alertsSent: sent })
  } catch (e) {
    console.error('watch-snapshot failed:', e)
    return json({ ok: false, error: String(e?.message || e) })
  }
}
