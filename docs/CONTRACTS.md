# TORQUE — Module Contracts (single source of truth)

Product: **Torque** — an advisory cockpit for trading MSTR as a leveraged-BTC play.
Long-biased trend riding with disciplined, tight, R-based stops. It never places
orders. It never fabricates a number: a dead source shows "—" + a stale badge.

Every module below is implemented EXACTLY to these signatures. Pure libs live in
`src/lib/`, are dependency-free (import only each other where stated), and are
unit-tested in `tests/` using the deterministic generators in `tests/fixtures.js`
(already written — read it; never use `Math.random()` in tests).

**Conventions**
- Candle: `{ t, o, h, l, c, v }` — `t` = unix **seconds**, arrays oldest→newest.
- Money rounded to cents in outputs; percents as numbers (`1.5` = 1.5%).
- Guard, don't throw: bad/missing inputs → `null` fields + a `warning`/`error`
  string code. Functions must never throw on empty arrays or nulls.
- R is ALWAYS measured against INITIAL risk per share (`entry − initialStop`).

---

## src/lib/ta.js  (imports: nothing)

- `sma(values, period)` → array, same length, `null` until `period-1` seeded.
- `ema(values, period)` → array; seeded with SMA at index `period-1`, `null` before.
- `rsi(closes, period = 14)` → array (Wilder), `null` until seeded.
- `atr(candles, period = 14)` → array (Wilder). TR at 0 = `h-l`; after: `max(h-l, |h-pc|, |l-pc|)`.
- `roc(values, n)` → array, `((v[i]/v[i-n]) - 1) * 100`, `null` for `i < n`.
- `slopePct(values, n)` → number|null: `((last/valueNBack) - 1) * 100 / n` (% per bar).
- `highestHigh(candles, n, endIdx = len-1)` → number|null (max `h` over the `n` bars ending at `endIdx`).
- `lowestLow(candles, n, endIdx = len-1)` → number|null.
- `swings(candles, strength = 2)` → `{ highs: [{i, price}], lows: [{i, price}] }`;
  pivot high at `i` iff `h[i]` strictly `>` the `h` of `strength` bars on BOTH sides;
  only confirmed pivots (`i <= len-1-strength`). Ties reject.

## src/lib/risk.js  (imports: nothing)

- `sizePosition({ equity, riskPct, entry, stop, maxPositionPct = 30 })` →
  `{ ok, shares, riskUsd, perShareRisk, positionUsd, positionPct, capped, error }`
  - `perShareRisk = entry - stop`; must be > 0 else `{ok:false, error:'stop_not_below_entry', shares:0}`.
  - `equity <= 0 || riskPct <= 0 || entry <= 0` or non-finite/≤0 `maxPositionPct`
    → `{ok:false, error:'bad_input', shares:0}` (a NaN cap must not silently uncap).
  - `shares = floor((equity * riskPct/100) / perShareRisk)`; whole shares only.
  - If `shares*entry > equity*maxPositionPct/100`: cap `shares = floor(equity*maxPositionPct/100/entry)`,
    set `capped:true`, and `riskUsd` becomes the EFFECTIVE `shares*perShareRisk`.
  - `shares === 0` after floor → `ok:false, error:'risk_too_small_for_one_share'`.
- `initialStop({ mode, entry, atr, atrMult = 2.5, swingLow, padAtr = 0.25, pct = 8 })` →
  `{ stop, basis, detail, warning }` — `mode: 'atr' | 'structure' | 'percent'`
  - atr: `entry - atrMult*atr` (needs atr>0 else `{stop:null, warning:'no_atr'}`).
  - structure: `swingLow - padAtr*atr` (needs swingLow & atr else warning `'no_structure'`).
  - percent: `entry * (1 - pct/100)`.
  - Computed stop `>= entry` → `{ stop:null, warning:'stop_not_below_entry' }`. Round to cents.
  - `basis` = mode; `detail` = human string with the numbers used.
- `anchoredChandelier(candles, { entryIdx, atrPeriod = 22, mult = 3, initialStop })` →
  array aligned to `candles.slice(entryIdx)`: each element
  `stop[i] = max(stop[i-1], hhSinceEntry(i) - mult*atr[globalIdx], initialStop)`.
  MONOTONICALLY NON-DECREASING — this is the point. While ATR unseeded, carry `initialStop`.
- `effectiveStop({ initialStop, trailStop, entry, beAtR = 1, highestCloseSinceEntry })` →
  number|null: `max(initialStop, trailStop ?? -Inf, breakeven)` where breakeven = `entry`
  once `highestCloseSinceEntry >= entry + beAtR*(entry - initialStop)` — compared
  with a float-noise epsilon (1e-9) so a ULP can't miss the exact +1R boundary
  while sub-cent-short closes still correctly fail to arm.
- `rMultiple({ entry, initialStop, price })` → number|null. `(price-entry)/(entry-initialStop)`;
  null if `entry-initialStop <= 0` or any input null.
- `blendLots(lots)` → `{ shares, avgEntry }` from `[{shares, entry}]`; empty → `{shares:0, avgEntry:null}`.

## src/lib/signals.js  (imports: ta.js)

All take DAILY candles; `< 60` candles → `{ state: 'insufficient_data', facts: [...] }`
(or `{stage:'none'}` / `{active:false}` with an `insufficient_data` fact).
Every result carries `facts: string[]` — plain English WITH the numbers used.

- `regime(candles)` → `{ state: 'uptrend'|'downtrend'|'chop'|'insufficient_data', score, facts }`
  Five checks, +20 each: close>EMA20; close>EMA50; EMA20>EMA50; `slopePct(ema50series,10) > 0`;
  last two confirmed swing lows ascending. score ≥ 70 → uptrend, ≤ 30 → downtrend, else chop.
- `pullbackSetup(candles)` → `{ stage: 'none'|'setup'|'trigger', facts, refHigh }`
  Requires regime uptrend, else stage 'none' with fact.
  setup: within the 3 bars BEFORE the current bar (never the current bar itself —
  a one-bar flush-and-rip is news, not a pullback) a bar's LOW came within 1.5% of
  EMA20 (or below it) while that bar's CLOSE stayed above EMA50. trigger: setup held
  AND latest close > previous bar's high. `refHigh` = that previous bar's high.
- `breakout(candles, lookback = 20)` → `{ active, level, facts }`
  Latest close > max high of the PRIOR `lookback` bars (excluding latest bar).
  Comparison is against the UNROUNDED level; `level` is rounded for display only.
  Add fact when `v > 1.3 * sma(v,20)` ("volume expansion"); volume nulls → skip that fact.
- `exitFlags({ candles, position, effectiveStop })` → array of
  `{ id, severity: 'hard'|'soft', fact }`, possibly empty. position = `{avgEntry, initialStop}`.
  - `stop_breach` (hard): latest close ≤ effectiveStop.
  - `regime_break` (hard): latest close < EMA50.
  - `ema20_lost` (soft): two consecutive closes < EMA20.
  - `momentum_roll` (soft): `slopePct(ema20series, 5) < 0`.
- `btcAlignment(btcDailyCandles)` → `{ aligned, state, score, facts }` — `regime()` on BTC;
  `aligned = state === 'uptrend'`.

## src/lib/torque.js  (imports: nothing)

- `alignByDay(candlesA, candlesB)` → `{ a: number[], b: number[], days: string[] }` —
  closes matched on UTC date (`YYYY-MM-DD` of `t`); only days present in BOTH.
- `dailyLogReturns(closes)` → array length-1 shorter.
- `rollingBeta(mstrCloses, btcCloses, window = 30)` → `{ latest, series }` —
  beta = cov/var over trailing window of log returns; `< window+1` aligned points → `{latest:null, series:[]}`.
  `var === 0` → null entry. UNEQUAL input lengths are REFUSED
  (`{latest:null, series:[], warning:'unaligned_series'}`) — head-pairing different
  days would fabricate a plausible-looking beta. Callers align via `alignByDay`.
- `relativeStrength(mstrCloses, btcCloses, n = 20)` → `{ mstrRocPct, btcRocPct, spreadPct }` (nulls if short).
- `mNav({ price, sharesOutstanding, btcHoldings, btcPrice })` →
  `{ marketCap, btcNavUsd, mNav, premiumPct, btcPerShare, impliedBtcPrice }` — any input
  missing/≤0 → all nulls. `impliedBtcPrice = marketCap / btcHoldings`.
- `torqueRead({ beta, mNav })` → `{ grade: 'efficient'|'fair'|'rich'|'unknown', ratio, text }`
  Grades on the UNROUNDED quotient beta/mNav (> 1.1 efficient; 0.9–1.1 fair; < 0.9 rich;
  null inputs → unknown); `ratio` is rounded for display only.
  `text` explains with numbers ("1% BTC move ≈ 1.9% MSTR; you pay 1.62× NAV").

## src/lib/freshness.js  (imports: nothing)

- `SOURCE_MAX_AGE_SEC = { quote: 1200, btc: 180, candles_1d: 93600, candles_30m: 1800 }`
- `freshness(fetchedAtMs, key, nowMs)` → `{ state: 'live'|'stale'|'dead', ageSec, label }`
  live < maxAge; stale < 3×maxAge; dead beyond (or `fetchedAtMs == null` → dead, label '—').
  label: "12s ago" / "3m ago" / "2h ago" / "3d ago".
- `nyseSessionState(nowMs)` → `'open'|'closed'` — Mon–Fri 09:30–16:00 America/New_York
  via Intl (DST-correct year-round); NO holiday calendar (UI labels it "approx" and
  prefers the quote feed's own `marketState` when the quote is live).

## src/lib/advice.js  (imports: nothing — takes precomputed inputs)

- `composeDirective(input)` — input:
  ```
  { price, freshQuote:{state}, freshBtc:{state}, freshCandles:{state}, freshBtcCandles:{state},
    regime, btcAlign, pullback, breakout, exitFlags,
    position: { shares, avgEntry, initialStop } | null,
    effectiveStop, r, sizing, addSizing, torque: { read } | null,
    marketSession: 'open'|'closed' }
  ```
  → `{ action, headline, reasons: string[], guardrails: string[], severity: 'info'|'act'|'urgent' }`
  Priority ladder — FIRST MATCH WINS:
  1. `price == null || freshQuote.state === 'dead'` → `NO_DATA` (severity urgent if position open else info)
  2. position && exitFlags has `stop_breach` → `STOP_OUT` (urgent)
  3. position && any other hard flag → `EXIT` (urgent)
  4. position && any soft flag → `TRIM` (act)
  5. position && pullback.stage==='trigger' && regime uptrend && btcAlign.aligned
     && effectiveStop >= avgEntry && freshBtc/freshCandles/freshBtcCandles NOT dead && addSizing.ok
     → `ADD` (act; uses `addSizing`). When the spec conditions hold but freshness or
     addSizing blocks, fall to HOLD with an explicit "add trigger active but blocked: …" reason.
  6. position → `HOLD` (info; reasons include R, stop distance %, trail level)
  7. !position && regime uptrend && btcAlign.aligned && (pullback trigger || breakout active):
     - freshBtc, freshCandles, or freshBtcCandles dead → `STAND_ASIDE` naming the
       dead feed(s) — never pretend the trigger doesn't exist
     - sizing missing/not ok → `STAND_ASIDE` naming the sizing blocker
     - else → `ENTER` (act; uses `sizing`)
  8. !position && regime uptrend && !btcAlign.aligned → `STAND_ASIDE`
     ("MSTR trend up but BTC not confirming — this is a BTC-beta trade")
  9. else → `STAND_ASIDE`
  Guardrails appended regardless of action: stale-data warning when any fresh state
  ≠ 'live'; torque grade 'rich' warning; `marketSession === 'closed'` note.
  Reasons cite actual numbers. NEVER emit ENTER/ADD when freshQuote, freshBtc,
  freshCandles, or freshBtcCandles is 'dead' (BTC candles feed the alignment gate). Rung 9's "no trigger yet" copy is reserved for genuinely
  trigger-less states.

## src/lib/replay.js  (imports: ta.js, risk.js, signals.js)

- `replayRules(candles, opts = {})` with defaults
  `{ equity: 100000, riskPct: 1, atrMult: 2.5, chandelierPeriod: 22, chandelierMult: 3, beAtR: 1, feePct: 0.1, lookback: 20 }`
  → `{ trades: [...], summary, warnings }`
  Mechanics — NO LOOKAHEAD, signals at close `i` use data `≤ i`, fills at `i+1` OPEN:
  - Warmup: start scanning at i = 59.
  - Flat: if (`pullbackSetup` trigger OR `breakout` active) at close i AND close i is
    NOT below EMA50 (never open a trade whose hard-exit condition is already true —
    matches the advice ladder's regime gating) → enter next open, fee-adjusted
    (`fill = open*(1+feePct/100)`), initial stop = ATR mode at signal bar.
  - In position: `anchoredChandelier` + `effectiveStop` (incl. breakeven rule).
    Exit signal when close ≤ effectiveStop or `regime_break` → exit at next open
    (`fill = open*(1-feePct/100)`).
  - Last bar with open position → close it at last close, flag `openAtEnd:true`.
  - Trade: `{ entryDate, exitDate, entryPx, exitPx, shares, initialStop, r, bars, kind: 'pullback'|'breakout', openAtEnd? }`
    (dates as `YYYY-MM-DD` UTC of `t`).
  - summary: `{ trades, wins, losses, winRatePct, avgR, cumR, maxDrawdownR, avgBars }`
    (maxDrawdownR = worst peak-to-trough of the running cumR series). Zero trades →
    zeros/nulls AND a 'no trades generated' warning is always appended.

---

## Server: netlify/functions/*  (Netlify Functions v2: `export default async (req, context)`)

Shared plumbing in `netlify/shared/util.mjs` (already written — read it).
Blobs are opened with STRONG consistency (read-modify-write endpoints lose
sequential writes under the default eventual reads), and `checkAuth` compares
the token constant-time over SHA-256 digests:
`sourceHandler(name, fn)` wraps auth + timing + status recording + error → 502.
`checkAuth`, `json`, `fetchWithTimeout`, `store`, `sendTelegram`.
ALL endpoints require `x-dashboard-token` when `DASHBOARD_TOKEN` env is set —
use `sourceHandler` for data proxies; call `checkAuth` manually in CRUD functions.

### netlify/shared/sources.mjs — upstream adapters w/ fallback chains
Each returns the normalized shape or throws. Parsers are PURE and exported
separately for fixture tests (`parseYahooChart`, `parseStooqDaily`, `parseBinanceKlines`,
`parseCoinbaseCandles`, `parseCoinbaseSpot`, `parseCoingeckoOhlc` take the raw upstream JSON/CSV).
- `mstrQuote()` → `{ symbol:'MSTR', price, prevClose, changePct, dayHigh, dayLow,
  marketState, delayedMin: 15, kind: 'delayed'|'eod', sourceDetail }`
  Chain: Yahoo `query1.finance.yahoo.com/v8/finance/chart/MSTR?interval=1m&range=1d`
  (meta.regularMarketPrice, chartPreviousClose; UA header required) → Stooq EOD CSV
  (`stooq.com/q/d/l/?s=mstr.us&i=d`, last row; kind:'eod', delayedMin:null).
- `mstrCandles(tf)` → tf `'1d'` (range 2y) | `'30m'` (range 60d) via Yahoo chart;
  drop null-close rows; map to candle shape (t already unix sec).
- `btcSpot()` → `{ price, changePct24h, sourceDetail }` —
  Binance `api/v3/ticker/24hr?symbol=BTCUSDT` → Coinbase `api.coinbase.com/v2/prices/BTC-USD/spot`
  (no 24h change → null) → CoinGecko simple/price w/ 24h change.
- `btcCandles(tf)` → `'1d'` (Binance klines limit 730) | `'30m'` (limit 500)
  → Coinbase `api.exchange.coinbase.com/products/BTC-USD/candles`; CoinGecko OHLC
  (v:null, days=1) is a 30m-ONLY fallback — its daily-range auto-granularity serves
  4-DAY candles, which must never be labeled '1d'. Every fetch attempt gets a ~3s
  budget so the whole chain fits inside Netlify's 10s function limit.

### Functions (each file wraps with sourceHandler where noted)
- `quote.mjs` — sourceHandler('quote') → `mstrQuote()`.
- `btc.mjs` — sourceHandler('btc') → `btcSpot()`.
- `candles.mjs` — sourceHandler('candles') — query `?symbol=MSTR|BTC&tf=1d|30m`
  (validate; default MSTR/1d) → `{ symbol, tf, candles, sourceDetail }`.
- `settings.mjs` — GET/PUT, Blobs key `settings`, deep-merged over DEFAULTS:
  ```
  { equity: 100000, riskPct: 1, maxPositionPct: 30, stopMode: 'atr', atrMult: 2.5,
    stopPct: 8, chandelierPeriod: 22, chandelierMult: 3, beAtR: 1, addRiskFraction: 0.5,
    btcHoldings: 650000, btcHoldingsAsOf: '2025-12-31', btcHoldingsSeeded: true,
    sharesOutstanding: 290000000, sharesOutstandingAsOf: '2025-12-31', sharesSeeded: true }
  ```
  PUT validates via `netlify/shared/validate.mjs` (below); a PUT that includes
  btcHoldings/sharesOutstanding sets the matching `*Seeded:false` and stamps `*AsOf` (today, UTC).
- `position.mjs` — GET → `{ position: {...}|null }`; PUT validates
  `{ shares:int>0, avgEntry>0, entryDate:'YYYY-MM-DD', initialStop: 0<x<avgEntry, stopOverride?: ≥initialStop|null, note?: string≤500 }`
  (+ server stamps `updatedAt`); DELETE clears. Blobs key `position`.
  The server maintains `stopHighWater`: on every PUT it ratchets to
  `max(previous, initialStop, stopOverride)`; watch-snapshot ratchets it to the
  computed effective stop each run; it survives edits, joins the client's
  effective-stop max (this is what makes "the stop only ever rises" an
  END-TO-END guarantee across blends and settings changes), and resets when
  the position is DELETEd or when `entryDate` changes on PUT (a different
  entry date is a different trade — trade A's ratchet must not stop-out
  trade B at birth).
- `journal.mjs` — GET → `{ trades: [] }` (newest first); POST validates trade
  `{ entryDate, exitDate ≥ entryDate, entry>0, exit>0, shares:int>0, initialStop>0, kind?: 'pullback'|'breakout'|'manual', note?≤500 }`,
  assigns `id` (crypto.randomUUID), prepends; DELETE `?id=`. Blobs key `journal`.
- `status.mjs` — auth'd; returns blobs `source_status` map + `{ blobs: {ok} }` +
  live-pings Yahoo/Binance/Coinbase/Stooq/CoinGecko (2.5s timeout each, in parallel)
  → per-upstream `{ ok, latencyMs | error }`. This is the first-deploy diagnostic.
- `watch-snapshot.mjs` — SCHEDULED (config in netlify.toml, every 30 min).
  Always runs its pass (the scheduler cannot carry our token and body fields are
  forgeable, so no request data is trusted); responses to callers WITHOUT the
  dashboard token never include price/stop proximity fields. Fetch quote+btc via sources;
  load settings+position+daily candles; if position open: compute the effective stop
  (chandelier anchored at entryDate; initialStop/stopOverride/stopHighWater floor it
  even when candles fail — an override can never LOWER the stop), ratchet
  `stopHighWater`, and alert via Telegram: `STOP HIT` (price ≤ stop), `STOP NEAR`
  (within 3%), or — when flat — `ENTRY SIGNAL`. Dedupe: Blobs `alerts_sent`
  `{ [conditionId]: {sentAt, stopAtSend} }` — keyed by CONDITION (stop_hit/stop_near/
  entry_*), resent after 6h; stop alerts additionally resend early on a ≥0.5%
  material stop move (movement-resend never applies when either stop is unknown —
  entry signals get the plain 6h window); entries pruned after 7 days. Manual HTTP
  calls run the same pass but position-proximity response fields require the
  dashboard token (nothing from the request body is ever trusted for auth). The
  sentinel's high-water write re-reads the position and merges ONLY stopHighWater,
  skipping if the entry date changed. Never throws — log + exit.

### netlify/shared/validate.mjs — pure validators (unit-testable)
- `validateSettings(patch)` → `{ ok, value?, errors? }` — numbers finite & > 0;
  riskPct ≤ 5; maxPositionPct ≤ 100; stopMode ∈ {atr,structure,percent}; stopPct 1–50;
  atrMult 0.5–10; unknown keys rejected.
- `validatePosition(body)`, `validateTrade(body)` — per shapes above.

---

## Testing bar (each agent runs its own suite before finishing)
- `npx vitest run tests/<yours>.test.js` green.
- Use `tests/fixtures.js` generators; NO `Math.random()`; NO network.
- Planted edge cases REQUIRED: empty arrays, all-null fields, zero equity, stop ≥ entry,
  ATR null, < 60 candles, `var(btc) = 0`, chandelier monotonicity on a whipsaw fixture.
- Parser tests use the captured-shape fixtures in `tests/fixtures.js` (`YAHOO_CHART_SAMPLE`, etc.).
