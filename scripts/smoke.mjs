// Smoke test with PLANTED PROBLEMS — runs the real engine end-to-end on
// synthetic fixtures where the correct answer is known. Every assertion
// prints ok:/FAIL; any FAIL exits 1. Run at every checkpoint (npm run smoke).
import { sizePosition, anchoredChandelier, rMultiple } from '../src/lib/risk.js'
import { composeDirective } from '../src/lib/advice.js'
import { replayRules } from '../src/lib/replay.js'
import { validateSettings } from '../netlify/shared/validate.mjs'
import { parseYahooChart } from '../netlify/shared/sources.mjs'
import { whipsaw, trendUp, YAHOO_CHART_WITH_NULLS } from '../tests/fixtures.js'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`ok: ${name}`)
  else { failed++; console.error(`FAIL: ${name} ${detail}`) }
}

// 1 — sizing known answer
const s = sizePosition({ equity: 100000, riskPct: 1, entry: 100, stop: 90 })
check('sizing: 100k/1%/100→90 buys exactly 100 shares risking $1000',
  s.shares === 100 && s.riskUsd === 1000, JSON.stringify(s))

// 2 — planted problem: a whipsaw tape tempting the trail to descend
const wCandles = whipsaw(140)
const trail = anchoredChandelier(wCandles, { entryIdx: 40, initialStop: wCandles[40].c * 0.8 })
check('chandelier: never descends across 100 whipsaw bars',
  trail.every((v, i) => i === 0 || v >= trail[i - 1]))

// 3 — planted problem: stop breach WHILE a fresh entry trigger fires
const breachInput = {
  price: 341, freshQuote: { state: 'live' }, freshBtc: { state: 'live' },
  regime: { state: 'uptrend', score: 100, facts: [] },
  btcAlign: { aligned: true, state: 'uptrend', score: 90, facts: [] },
  pullback: { stage: 'trigger', facts: ['trigger!'] },
  breakout: { active: true, level: 340, facts: [] },
  exitFlags: [{ id: 'stop_breach', severity: 'hard', fact: 'close 341 under stop 342' }],
  position: { shares: 24, avgEntry: 380, initialStop: 342 },
  effectiveStop: 342, r: -1.02,
  sizing: { ok: true, shares: 24 }, addSizing: { ok: true, shares: 12 },
  torque: { read: { grade: 'fair', text: '' } }, marketSession: 'open',
}
check('advice: STOP_OUT outranks a live entry trigger', composeDirective(breachInput).action === 'STOP_OUT')

// 4 — planted problem: everything bullish but the quote feed is DEAD
const deadInput = { ...breachInput, exitFlags: [], position: null, freshQuote: { state: 'dead' } }
check('advice: dead data can never produce ENTER', composeDirective(deadInput).action === 'NO_DATA')

// 5 — replay: no lookahead, R arithmetic self-consistent on a real fixture
const candles = trendUp(160)
const { trades } = replayRules(candles)
const byDate = new Map(candles.map((c) => [new Date(c.t * 1000).toISOString().slice(0, 10), c]))
check('replay: produced trades on a strong uptrend', trades.length >= 1, `got ${trades.length}`)
check('replay: every entry fills at next-bar open, fee-adjusted',
  trades.every((t) => Math.abs(t.entryPx - byDate.get(t.entryDate).o * 1.001) < 0.02))
check('replay: recorded R matches (exit−entry)/(entry−stop)',
  trades.every((t) => Math.abs(t.r - (t.exitPx - t.entryPx) / (t.entryPx - t.initialStop)) < 0.02))

// 6 — planted problem: an insane risk setting and a typo'd key
check('validation: riskPct 6% rejected', validateSettings({ riskPct: 6 }).ok === false)
check('validation: typo\'d key rejected loudly', validateSettings({ riskPtc: 1 }).ok === false)

// 7 — planted problem: upstream sends a null candle row
check('parser: yahoo null rows dropped, not fabricated',
  parseYahooChart(YAHOO_CHART_WITH_NULLS).candles.length === 3)

// 8 — R math sanity across signs
check('rMultiple: +2R and −1.5R known answers',
  rMultiple({ entry: 100, initialStop: 90, price: 120 }) === 2 &&
  rMultiple({ entry: 100, initialStop: 90, price: 85 }) === -1.5)

if (failed > 0) { console.error(`\nSMOKE: ${failed} FAILURE(S)`); process.exit(1) }
console.log('\nSMOKE: ALL CLEAN')
