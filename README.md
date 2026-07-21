# ⚡ Torque — MSTR Leverage Cockpit

An advisory cockpit for trading **MSTR as a leveraged-bitcoin play**: ride the
uptrend, keep tight R-based stops, and always know exactly what to do next.
It computes — you place the orders at your broker. It never fabricates a
number: a dead source shows "—" and a dead badge, never a stale price
dressed up as live.

> Not investment advice. A rules engine is a discipline tool, not a promise.

## What it does

**One glance → one directive.** The cockpit's hero card says exactly one of:
`ENTER · ADD · HOLD · TRIM · EXIT · STOP OUT · STAND ASIDE · NO DATA` — with
the reasons (actual numbers) and guardrails underneath. The priority ladder is
deterministic and safety-first: a stop breach outranks a fresh entry trigger,
and dead data outranks everything.

**Risk engine (the heart).**
- Position sizing to the dollar: risk % of equity ÷ per-share risk → whole
  shares, capped by max position %.
- Three initial-stop modes: ATR-multiple (default — MSTR's volatility decides
  the width), below-swing-low, or fixed %.
- **Anchored chandelier trail**: highest high since entry − mult × ATR,
  ratcheted so it only ever rises. Breakeven lock once price pays you 1R.
- Everything is measured in R (initial risk). Live open-R on the position
  card; realized R in the journal.

**Signal engine.**
- Transparent regime score (five checks, 20 points each — the card shows its
  work).
- Two-stage pullback trigger (dip to the EMA20 zone in an uptrend, then
  reclaim the prior high) + 20-bar breakout.
- BTC confirmation gate: MSTR longs are a BTC-beta trade; no entry advice
  while BTC's own regime isn't an uptrend.
- Hard/soft exit flags: stop breach, EMA50 regime break (exit) · EMA20 lost,
  momentum roll (trim).

**Leverage truth (torque monitor).**
- 30-day rolling beta of MSTR on BTC (day-aligned, log returns).
- mNAV (market cap ÷ BTC stack value), premium %, and the **implied BTC
  price** you're paying by holding MSTR.
- One grade: `efficient / fair / rich` — beta per unit of premium.

**Rule replay.** Runs the exact entry/stop/trail ruleset over the loaded
history: fills at next-bar open, 0.1% fees each way, no lookahead. Trades are
drawn on the chart; the summary reports win rate, avg R, total R, max
drawdown in R. A rule audit, not a backtest you can sell.

**Journal.** Log closed trades; each books as an R multiple against its
initial stop. Cumulative-R curve is the scoreboard.

**Sentinel.** A scheduled function runs every 30 minutes even with the app
closed: `STOP HIT`, `STOP NEAR` (≤3%), and flat-entry signals go to Telegram
(if configured), deduped over 6 h.

## Stack

Vite + React 18 · lightweight-charts · Netlify Functions v2 + Netlify Blobs
(state) · keyless market data with fallback chains:

| Feed | Chain | Freshness |
|---|---|---|
| MSTR quote | Yahoo (delayed ~15 min) → Stooq (EOD) | labeled on the tape |
| MSTR candles | Yahoo 2y daily → Stooq | 26 h window |
| BTC spot | Binance → Coinbase → CoinGecko | live (3 min window) |
| BTC candles | Binance → Coinbase (CoinGecko: 30m tier only) | daily |

Drop a Polygon/Finnhub key into `netlify/shared/sources.mjs` later for true
real-time equity quotes — the adapter seam is ready.

## Deploy (Netlify)

1. Fork/clone → `New site from Git` → build command `npm run build`, publish
   `dist` (netlify.toml already says this).
2. Environment variables (Site settings → Environment):
   - `DASHBOARD_TOKEN` — **set this.** Without it anyone with the URL reads
     your equity and position. The UI asks for it once per browser session.
   - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — optional, for sentinel
     alerts (@BotFather / @userinfobot).
3. Deploy. The scheduled sentinel (`watch-snapshot`, every 30 min) is
   configured in `netlify.toml`.

### First-deploy live-wire checklist

1. Open `/api/status` (with the token header, or via Settings → Data
   sources → **Ping all sources**): every upstream should read `ok`.
2. Cockpit tape shows MSTR + BTC with **live** chips.
3. Settings → verify **BTC holdings** and **shares outstanding** against the
   latest 8-K (sec.gov → MSTR). They ship as seeded estimates and the torque
   card carries an amber warning until you save real numbers — mNAV is only
   as honest as these inputs.
4. Enter your open position (if any) in Settings so the trail starts
   tracking.

## Local dev

```bash
npm install
npm run dev        # netlify dev: UI + functions (needs network for live data)
npm run dev:ui     # vite only (UI against mocked/absent APIs)
```

## Verification

```bash
npm test           # 147 unit tests: risk math, signals, torque, advice ladder,
                   # replay no-lookahead, validators, upstream parsers
npm run smoke      # planted-problem engine audit (11 checks, exits non-zero)
npm run e2e        # 30 hermetic Playwright specs, desktop + 390×844
npm run gate       # all of the above + esbuild function bundle sweep + build
```

Guarantees the suite actually proves:
- The chandelier trail **never descends** (asserted per-step on a whipsaw
  fixture), and the governing stop carries a **persisted high-water mark**
  (server-side) so it can't drop across position blends or settings edits.
- Sizing: 100k equity / 1% risk / 100→90 stop buys exactly 100 shares.
- Replay has **no lookahead**: signals at close *i*, fills at *i+1* open —
  proven on a gap fixture whose opens are decoupled from prior closes.
- `STOP_OUT` outranks a live entry trigger; a dead quote, BTC, or candle
  feed can never produce `ENTER`/`ADD` — a blocked trigger says why.
- A dead source degrades to "—" + dead chip (e2e-asserted at both viewports).

## Repo map

```
src/lib/        pure engine: ta · risk · signals · torque · advice · replay · freshness
src/components/ cockpit UI (React)
netlify/
  functions/    quote · btc · candles · settings · position · journal · status · watch-snapshot
  shared/       util (auth/cache/telegram) · sources (parsers+chains) · validate
tests/          vitest suites + deterministic fixtures
e2e/            hermetic Playwright specs (API fully mocked)
scripts/        smoke.mjs · verify-gate.sh
docs/CONTRACTS.md  the module contracts everything is built against
```
