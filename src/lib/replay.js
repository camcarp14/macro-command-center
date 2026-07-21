// Rule replay — runs the exact entry/stop/trail ruleset over history so the
// trigger track record is inspectable. Honest by construction: signals at
// close i see data ≤ i only, fills happen at the NEXT bar's open, fees are
// charged both ways. This is a rule audit, not a backtest you can sell.
import { atr } from './ta.js'
import { sizePosition, initialStop, anchoredChandelier, effectiveStop, rMultiple } from './risk.js'
import { pullbackSetup, breakout, regime } from './signals.js'

const WARMUP = 59

export function replayRules(candles, opts = {}) {
  const {
    equity = 100000,
    riskPct = 1,
    atrMult = 2.5,
    chandelierPeriod = 22,
    chandelierMult = 3,
    beAtR = 1,
    feePct = 0.1,
    lookback = 20,
  } = opts

  const warnings = []
  if (!Array.isArray(candles) || candles.length < WARMUP + 2) {
    return { trades: [], summary: emptySummary(), warnings: ['insufficient candles for replay'] }
  }

  const trades = []
  let pos = null // { entryIdx, entryPx, shares, initialStop, kind }

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const seen = candles.slice(0, i + 1)

    if (!pos) {
      const pb = pullbackSetup(seen)
      const bo = breakout(seen, lookback)
      const kind = pb.stage === 'trigger' ? 'pullback' : bo.active ? 'breakout' : null
      // Never open a trade whose hard-exit condition (close < EMA50) is
      // already true at the signal close — that's a doomed 1-bar round trip,
      // and the advice ladder would never issue it either.
      if (kind && !isBelowEma50(seen)) {
        const entryPx = round2(candles[i + 1].o * (1 + feePct / 100))
        const atrArr = atr(seen, 14)
        const a = atrArr[atrArr.length - 1]
        const st = initialStop({ mode: 'atr', entry: entryPx, atr: a, atrMult })
        if (st.stop == null) { warnings.push(`skipped ${kind} at bar ${i}: ${st.warning}`); continue }
        const size = sizePosition({ equity, riskPct, entry: entryPx, stop: st.stop })
        if (!size.ok) { warnings.push(`skipped ${kind} at bar ${i}: ${size.error}`); continue }
        pos = { entryIdx: i + 1, entryPx, shares: size.shares, initialStop: st.stop, kind }
      }
      continue
    }

    // In position: evaluate exits at close i (only once the entry bar exists).
    if (i < pos.entryIdx) continue
    const trail = anchoredChandelier(seen, {
      entryIdx: pos.entryIdx, atrPeriod: chandelierPeriod, mult: chandelierMult, initialStop: pos.initialStop,
    })
    const trailNow = trail.length ? trail[trail.length - 1] : pos.initialStop
    let hcse = -Infinity
    for (let k = pos.entryIdx; k <= i; k++) hcse = Math.max(hcse, candles[k].c)
    const eff = effectiveStop({
      initialStop: pos.initialStop, trailStop: trailNow, entry: pos.entryPx, beAtR, highestCloseSinceEntry: hcse,
    })
    const close = candles[i].c
    const reg = regime(seen)
    const stopped = Number.isFinite(eff) && close <= eff
    const regimeBreak = reg.state !== 'insufficient_data' && isBelowEma50(seen)
    if (stopped || regimeBreak) {
      const exitPx = round2(candles[i + 1].o * (1 - feePct / 100))
      trades.push(makeTrade(pos, candles, i + 1, exitPx))
      pos = null
    }
  }

  if (pos) {
    const lastIdx = candles.length - 1
    const exitPx = round2(candles[lastIdx].c * (1 - feePct / 100))
    trades.push({ ...makeTrade(pos, candles, lastIdx, exitPx), openAtEnd: true })
    warnings.push('final trade still open at end of data — closed at last close for accounting')
  }
  if (trades.length === 0) {
    warnings.push(`no trades generated over ${candles.length} bars — the ruleset never triggered on this tape`)
  }

  return { trades, summary: summarize(trades), warnings }
}

function isBelowEma50(candles) {
  // Local EMA50 check (regime() already computed it, but its facts are prose;
  // recompute the one number the exit rule actually needs).
  const closes = candles.map((c) => c.c)
  if (closes.length < 50) return false
  let seed = 0
  for (let i = 0; i < 50; i++) seed += closes[i]
  let e = seed / 50
  const k = 2 / 51
  for (let i = 50; i < closes.length; i++) e = closes[i] * k + e * (1 - k)
  return closes[closes.length - 1] < e
}

function makeTrade(pos, candles, exitIdx, exitPx) {
  const r = rMultiple({ entry: pos.entryPx, initialStop: pos.initialStop, price: exitPx })
  return {
    entryDate: dayOf(candles[pos.entryIdx].t),
    exitDate: dayOf(candles[exitIdx].t),
    entryPx: pos.entryPx,
    exitPx,
    shares: pos.shares,
    initialStop: pos.initialStop,
    r: r == null ? null : round2(r),
    bars: exitIdx - pos.entryIdx,
    kind: pos.kind,
  }
}

function summarize(trades) {
  if (trades.length === 0) return emptySummary()
  const rs = trades.map((t) => t.r).filter((r) => r != null)
  const wins = rs.filter((r) => r > 0).length
  const losses = rs.filter((r) => r <= 0).length
  let cum = 0
  let peak = 0
  let maxDd = 0
  for (const r of rs) {
    cum += r
    peak = Math.max(peak, cum)
    maxDd = Math.max(maxDd, peak - cum)
  }
  return {
    trades: trades.length,
    wins,
    losses,
    winRatePct: rs.length ? round2((wins / rs.length) * 100) : null,
    avgR: rs.length ? round2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    cumR: round2(cum),
    maxDrawdownR: round2(maxDd),
    avgBars: round2(trades.reduce((a, t) => a + t.bars, 0) / trades.length),
  }
}

function emptySummary() {
  return { trades: 0, wins: 0, losses: 0, winRatePct: null, avgR: null, cumR: 0, maxDrawdownR: 0, avgBars: null }
}

function dayOf(t) { return new Date(t * 1000).toISOString().slice(0, 10) }
function round2(x) { return Math.round(x * 100) / 100 }
