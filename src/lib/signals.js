// Entry/exit signal engine over DAILY candles. Every read returns facts[]
// — plain English with the actual numbers — so the cockpit can show its
// work. Under 60 candles everything degrades to insufficient_data rather
// than guessing.
import { ema, sma, slopePct, swings } from './ta.js'

const MIN_BARS = 60

/**
 * Trend regime: five binary checks, +20 each.
 *   close>EMA20, close>EMA50, EMA20>EMA50, EMA50 slope(10)>0, ascending swing lows.
 * ≥70 uptrend · ≤30 downtrend · else chop.
 */
export function regime(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_BARS) {
    return { state: 'insufficient_data', score: null, facts: [`need ${MIN_BARS}+ daily candles, have ${candles?.length ?? 0}`] }
  }
  const closes = candles.map((c) => c.c)
  const e20 = ema(closes, 20)
  const e50 = ema(closes, 50)
  const last = closes.length - 1
  const close = closes[last]
  const facts = []
  let score = 0

  if (close > e20[last]) { score += 20; facts.push(`close ${r2(close)} above EMA20 ${r2(e20[last])}`) }
  else facts.push(`close ${r2(close)} below EMA20 ${r2(e20[last])}`)

  if (close > e50[last]) { score += 20; facts.push(`close above EMA50 ${r2(e50[last])}`) }
  else facts.push(`close below EMA50 ${r2(e50[last])}`)

  if (e20[last] > e50[last]) { score += 20; facts.push('EMA20 above EMA50 (bull alignment)') }
  else facts.push('EMA20 below EMA50')

  const slope = slopePct(e50, 10)
  if (slope != null && slope > 0) { score += 20; facts.push(`EMA50 rising ${r2(slope * 10)}% over 10 bars`) }
  else facts.push(`EMA50 slope flat/negative (${slope == null ? 'n/a' : r2(slope * 10) + '% / 10 bars'})`)

  const { lows } = swings(candles, 2)
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2)
    if (b.price > a.price) { score += 20; facts.push(`higher swing lows: ${r2(a.price)} → ${r2(b.price)}`) }
    else facts.push(`swing lows not ascending: ${r2(a.price)} → ${r2(b.price)}`)
  } else {
    facts.push('fewer than two confirmed swing lows')
  }

  const state = score >= 70 ? 'uptrend' : score <= 30 ? 'downtrend' : 'chop'
  return { state, score, facts }
}

/**
 * Pullback-in-uptrend, two stages. setup: within the 3 bars BEFORE the
 * current bar a low came within 1.5% of EMA20 (or under it) while that
 * bar's close held above EMA50. trigger: setup held AND the latest close
 * reclaimed the previous bar's high — the classic "add on the way up"
 * entry. The dip window deliberately excludes the current bar: a single
 * wide-range flush-and-rip bar is news, not a pullback.
 */
export function pullbackSetup(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_BARS) {
    return { stage: 'none', facts: ['insufficient data for pullback read'], refHigh: null }
  }
  const reg = regime(candles)
  if (reg.state !== 'uptrend') {
    return { stage: 'none', facts: [`no pullback setup — regime is ${reg.state}`], refHigh: null }
  }
  const closes = candles.map((c) => c.c)
  const e20 = ema(closes, 20)
  const e50 = ema(closes, 50)
  const last = candles.length - 1
  let touched = null
  for (let i = last - 3; i < last; i++) {
    if (i < 0 || e20[i] == null || e50[i] == null) continue
    if (candles[i].l <= e20[i] * 1.015 && candles[i].c >= e50[i]) { touched = i; break }
  }
  if (touched == null) {
    return { stage: 'none', facts: ['uptrend intact but no pullback into the EMA20 zone in the last 3 bars'], refHigh: null }
  }
  const refHigh = candles[last - 1].h
  const facts = [
    `pulled into EMA20 zone: low ${r2(candles[touched].l)} vs EMA20 ${r2(e20[touched])} (held EMA50 ${r2(e50[touched])})`,
  ]
  if (candles[last].c > refHigh) {
    facts.push(`trigger: close ${r2(candles[last].c)} reclaimed prior high ${r2(refHigh)}`)
    return { stage: 'trigger', facts, refHigh }
  }
  facts.push(`waiting: close ${r2(candles[last].c)} has not reclaimed prior high ${r2(refHigh)}`)
  return { stage: 'setup', facts, refHigh }
}

/** Breakout: latest close above the highest high of the PRIOR lookback bars. */
export function breakout(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < Math.max(MIN_BARS, lookback + 1)) {
    return { active: false, level: null, facts: ['insufficient data for breakout read'] }
  }
  const last = candles.length - 1
  let level = -Infinity
  for (let i = last - lookback; i < last; i++) level = Math.max(level, candles[i].h)
  const close = candles[last].c
  const facts = []
  const active = close > level // compare unrounded; round only for display
  facts.push(active
    ? `close ${r2(close)} cleared ${lookback}-bar high ${r2(level)}`
    : `close ${r2(close)} below ${lookback}-bar high ${r2(level)}`)
  const vols = candles.map((c) => c.v)
  if (vols.every((v) => Number.isFinite(v))) {
    const v20 = sma(vols, 20)
    if (v20[last] != null && candles[last].v > 1.3 * v20[last]) {
      facts.push(`volume expansion: ${Math.round(candles[last].v / 1000)}k vs 20-bar avg ${Math.round(v20[last] / 1000)}k`)
    }
  }
  // levelRaw: the exact value the signal compares against — planning tools
  // must price tickets off it, not the display-rounded level
  return { active, level: r2(level), levelRaw: level, facts }
}

/**
 * Exit flags for an open position, hardest first. Empty array = nothing
 * wrong. severity 'hard' → exit now; 'soft' → trim/tighten.
 */
export function exitFlags({ candles, position, effectiveStop }) {
  if (!position || !Array.isArray(candles) || candles.length < MIN_BARS) return []
  const closes = candles.map((c) => c.c)
  const e20 = ema(closes, 20)
  const e50 = ema(closes, 50)
  const last = closes.length - 1
  const close = closes[last]
  const flags = []

  if (Number.isFinite(effectiveStop) && close <= effectiveStop) {
    flags.push({ id: 'stop_breach', severity: 'hard', fact: `close ${r2(close)} at/under the stop ${r2(effectiveStop)}` })
  }
  if (e50[last] != null && close < e50[last]) {
    flags.push({ id: 'regime_break', severity: 'hard', fact: `close ${r2(close)} lost EMA50 ${r2(e50[last])} — trend structure broken` })
  }
  if (last >= 1 && e20[last] != null && e20[last - 1] != null && close < e20[last] && closes[last - 1] < e20[last - 1]) {
    flags.push({ id: 'ema20_lost', severity: 'soft', fact: `two consecutive closes under EMA20 ${r2(e20[last])}` })
  }
  const slope = slopePct(e20, 5)
  if (slope != null && slope < 0) {
    flags.push({ id: 'momentum_roll', severity: 'soft', fact: `EMA20 slope negative (${r2(slope * 5)}% / 5 bars)` })
  }
  return flags
}

/** BTC confirmation — MSTR longs are a BTC-beta trade; demand alignment. */
export function btcAlignment(btcDailyCandles) {
  const reg = regime(btcDailyCandles)
  return {
    aligned: reg.state === 'uptrend',
    state: reg.state,
    score: reg.score,
    facts: reg.facts,
  }
}

function r2(x) { return Math.round(x * 100) / 100 }
