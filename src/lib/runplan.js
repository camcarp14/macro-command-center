// Run preparation — the "be ready before it happens" layer. Everything here
// is derived from the SAME rules that gate real entries, so the bullish
// bias lives only in what we watch (MSTR, long-only), never in what fires.
// Distances are honest: "+14.8% away" means the confirmation costs 14.8%,
// and that is the price of not buying falling knives.
import { ema, slopePct, swings, atr } from './ta.js'
import { regime, pullbackSetup, breakout, btcAlignment } from './signals.js'
import { initialStop, sizePosition } from './risk.js'

const MIN_BARS = 60

/**
 * The arm checklist: each regime gate as pass/fail with the price level
 * that flips it (where a price level exists) and % distance from the last
 * close. ready = both regimes aligned; armed = ready AND a trigger is live.
 */
export function armChecklist(mstrCandles, btcCandles) {
  if (!Array.isArray(mstrCandles) || mstrCandles.length < MIN_BARS) {
    return { insufficient: true, mstr: [], btc: null, paths: null, ready: false, armed: false }
  }
  const closes = mstrCandles.map((c) => c.c)
  const close = closes[closes.length - 1]
  const e20 = ema(closes, 20)
  const e50 = ema(closes, 50)
  const e20v = e20[e20.length - 1]
  const e50v = e50[e50.length - 1]
  const distTo = (level) => (level == null || !(close > 0)) ? null : r1(((level / close) - 1) * 100)

  const mstr = []
  mstr.push(check('close_ema20', `close above EMA20 (${r2(e20v)})`, close > e20v, e20v, distTo(e20v)))
  mstr.push(check('close_ema50', `close above EMA50 (${r2(e50v)})`, close > e50v, e50v, distTo(e50v)))
  mstr.push(check('ema_stack', 'EMA20 above EMA50', e20v > e50v, null, null,
    e20v > e50v ? null : `needs sustained closes above ~${r2(e50v)} — one pop won't cross the averages`))
  const slope = slopePct(e50, 10)
  mstr.push(check('ema50_rising', 'EMA50 rising', slope != null && slope > 0, null, null,
    slope != null && slope > 0 ? null : 'the 50-day has to curl up — time spent above it, not a single day'))
  const lows = swings(mstrCandles, 2).lows
  const lastTwo = lows.slice(-2)
  const higherLows = lastTwo.length === 2 && lastTwo[1].price > lastTwo[0].price
  mstr.push(check('higher_lows', 'higher swing lows', higherLows, null, null,
    higherLows ? null : lastTwo.length === 2
      ? `last lows ${r2(lastTwo[0].price)} → ${r2(lastTwo[1].price)}: needs a dip that HOLDS above ${r2(lastTwo[1].price)}`
      : 'needs a confirmed higher low (a dip that holds, with 2 bars either side)'))

  const reg = regime(mstrCandles)
  const align = btcAlignment(btcCandles)
  let btc = { pass: align.aligned, state: align.state, score: align.score, level: null, distancePct: null, note: null }
  if (Array.isArray(btcCandles) && btcCandles.length >= MIN_BARS) {
    const bCloses = btcCandles.map((c) => c.c)
    const bClose = bCloses[bCloses.length - 1]
    const bE50 = ema(bCloses, 50)[bCloses.length - 1]
    // a price distance only when price is genuinely BELOW the 50-day; when
    // it's above but the regime still isn't up, the blockers are trend
    // shape, and pretending a level exists would be a lie with a plus sign
    const below = bE50 != null && bClose > 0 && bClose < bE50
    btc = {
      ...btc,
      level: bE50 == null ? null : r2(bE50),
      distancePct: !align.aligned && below ? r1(((bE50 / bClose) - 1) * 100) : null,
      note: !align.aligned && bE50 != null && !below
        ? 'price already above the 50-day — the blockers are trend shape (slope, higher lows), not a level'
        : null,
    }
  }

  const pb = pullbackSetup(mstrCandles)
  const bo = breakout(mstrCandles)
  const paths = {
    breakout: { active: bo.active, level: bo.level, distancePct: bo.active ? null : distTo(bo.levelRaw ?? bo.level) },
    pullback: { stage: pb.stage, refHigh: pb.refHigh },
  }

  const ready = reg.state === 'uptrend' && align.aligned
  const armed = ready && (pb.stage === 'trigger' || bo.active)
  return { insufficient: false, mstr, btc, paths, regime: reg, btcAlign: align, ready, armed }
}

/**
 * Pre-computed order tickets AT the trigger levels (not at today's price):
 * when the day comes, the ticket already exists. Sizing/stops use the exact
 * production risk engine WITH the user's configured stop mode — a ticket
 * that disagrees with the entry planner on the same screen is worse than
 * no ticket. `forAdd` sizes at riskPct × addRiskFraction, matching the
 * production ADD rung. Entries remain gated by the directive — a ticket is
 * preparation, not permission.
 */
export function triggerTickets({ mstrCandles, settings, forAdd = false }) {
  if (!settings || !Array.isArray(mstrCandles) || mstrCandles.length < MIN_BARS) return []
  const atrNow = atr(mstrCandles, 14)[mstrCandles.length - 1]
  const closes = mstrCandles.map((c) => c.c)
  const lows = swings(mstrCandles, 2).lows
  const lastSwingLow = lows.length ? lows[lows.length - 1].price : null
  const reg = regime(mstrCandles)
  const bo = breakout(mstrCandles)
  const pb = pullbackSetup(mstrCandles)
  const riskPct = forAdd ? settings.riskPct * (settings.addRiskFraction ?? 0.5) : settings.riskPct

  const ticket = (name, trigger, entry, live = false) => {
    if (!Number.isFinite(entry) || entry <= 0) return null
    const st = initialStop({
      mode: settings.stopMode, entry, atr: atrNow, atrMult: settings.atrMult,
      swingLow: lastSwingLow, pct: settings.stopPct,
    })
    if (st.stop == null) return { name, trigger, entry: r2(entry), stop: null, live, note: st.warning }
    const sz = sizePosition({ equity: settings.equity, riskPct, entry, stop: st.stop, maxPositionPct: settings.maxPositionPct })
    return {
      name, trigger, entry: r2(entry), stop: st.stop, live,
      shares: sz.ok ? sz.shares : 0, riskUsd: sz.ok ? sz.riskUsd : null,
      positionUsd: sz.ok ? sz.positionUsd : null, positionPct: sz.ok ? sz.positionPct : null,
      capped: sz.ok ? sz.capped : false, note: sz.ok ? null : sz.error,
    }
  }

  const tickets = []
  if (!bo.active && bo.levelRaw != null) {
    tickets.push(ticket('Breakout day', `MSTR closes above ${r2(bo.level)}`, bo.levelRaw))
  }
  if (reg.state === 'uptrend' && pb.stage !== 'none' && pb.refHigh != null) {
    tickets.push(ticket('Pullback reclaim',
      pb.stage === 'trigger' ? `close above ${r2(pb.refHigh)} — LIVE NOW` : `close back above ${r2(pb.refHigh)}`,
      pb.refHigh, pb.stage === 'trigger'))
  } else if (reg.state === 'uptrend') {
    const e20v = ema(closes, 20)[closes.length - 1]
    if (e20v != null) tickets.push(ticket('Next pullback (est. at EMA20)', `dip to ~${r2(e20v)}, then reclaim the prior high`, e20v))
  }
  return tickets.filter(Boolean)
}

/**
 * What would prove the run thesis WRONG — pre-committed, in price terms.
 * The anti-self-fulfilling half of the plan: belief sets the watchlist,
 * these levels retire it.
 */
export function thesisBreaks(mstrCandles, btcCandles) {
  if (!Array.isArray(mstrCandles) || mstrCandles.length < MIN_BARS) return []
  const out = []
  const lows = swings(mstrCandles, 2).lows
  if (lows.length) {
    const lastLow = lows[lows.length - 1].price
    out.push({ id: 'swing_low', label: `MSTR closes below the last confirmed swing low ${r2(lastLow)}`, level: r2(lastLow) })
  }
  const reg = regime(mstrCandles)
  if (reg.state !== 'insufficient_data') {
    out.push({ id: 'downtrend', label: `MSTR regime reads downtrend (score ≤ 30, now ${reg.score}) — the plan goes back in the drawer`, level: null })
  }
  if (Array.isArray(btcCandles) && btcCandles.length >= MIN_BARS) {
    const bCloses = btcCandles.map((c) => c.c)
    const bE50 = ema(bCloses, 50)[bCloses.length - 1]
    if (bE50 != null) out.push({ id: 'btc_break', label: `BTC loses its 50-day (~${Math.round(bE50).toLocaleString('en-US')}) — the underlying stops carrying the trade`, level: r2(bE50) })
  }
  return out
}

function check(id, label, pass, level, distancePct, note = null) {
  return { id, label, pass, level: level == null ? null : r2(level), distancePct: pass ? null : distancePct, note }
}
function r2(x) { return Math.round(x * 100) / 100 }
function r1(x) { return Math.round(x * 10) / 10 }
