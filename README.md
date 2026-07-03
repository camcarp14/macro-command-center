# Macro Command Center

A single-screen, live macro terminal tracking one specific thesis — AI-capex bubble via circular hyperscaler financing against a hawkish Fed — alongside a leveraged WBTC position on Aave V3 (Arbitrum). Every number on screen is a live fetch with a visible timestamp, or it is explicitly labeled stale/down. Nothing is interpolated, and the composite score is a fully exposed formula, not a black box.

Stack: Vite + React (hooks, single-file `App.jsx`) · Netlify Functions v2 as the proxy/secrets layer for every external call · Netlify Blobs for snapshot history, the thesis timeline, source health, and the token ledger (zero extra infra; see "Swapping storage to Supabase" below) · Vitest + Playwright.

## Deploy (about five minutes)

```bash
# 1. Push this repo to your GitHub
git remote add origin git@github.com:camcarp14/macro-command-center.git
git push -u origin main

# 2. Create the Netlify site (or use the Netlify UI "Import from Git")
npx netlify-cli init            # link repo → build cmd + publish dir are read from netlify.toml

# 3. Set environment variables (UI: Site settings → Environment variables, or:)
npx netlify-cli env:set FRED_API_KEY "..."
npx netlify-cli env:set AAVE_WALLET_ADDRESS "0x..."
npx netlify-cli env:set ANTHROPIC_API_KEY "..."
npx netlify-cli env:set EDGAR_USER_AGENT "MacroCommandCenter you@yourdomain.com"
npx netlify-cli env:set DASHBOARD_TOKEN "a-long-random-string"   # strongly recommended — see Security

# 4. Deploy
git push   # or: npx netlify-cli deploy --prod
```

Local dev: `npm install`, then `npm run dev` (this runs `netlify dev`, which serves the functions, emulates Blobs, and loads `.env` — copy `.env.example` to `.env` first). Plain `vite dev` (`npm run dev:ui`) serves the UI only; every source will correctly show DOWN because `/api/*` doesn't exist there.

## Environment variables

| Var | Required | What it does |
|---|---|---|
| `FRED_API_KEY` | yes | Rates/credit/dollar/balance-sheet series. Free at fred.stlouisfed.org → API key. |
| `AAVE_WALLET_ADDRESS` | yes | The wallet with the WBTC position. Read-only public chain data; the address stays server-side and never ships in frontend code. |
| `ANTHROPIC_API_KEY` | for narrative | Powers the "morning take". Without it, everything else works and the button reports the missing key. |
| `EDGAR_USER_AGENT` | yes | SEC requires a descriptive UA with contact info; requests without it get blocked. |
| `DASHBOARD_TOKEN` | recommended | Shared secret; when set, every `/api/*` call requires header `x-dashboard-token`. |
| `COINGECKO_API_KEY` | no | Demo key raises rate limits; works keyless. |
| `ARBITRUM_RPC_URL` | no | Defaults to the public `https://arb1.arbitrum.io/rpc`; swap in Alchemy/Infura if it rate-limits. |
| `NARRATIVE_MODEL` | no | Defaults to `claude-sonnet-4-6`. If you change it, add pricing to `src/lib/cost.js` or calls show as "unpriced" (never $0). |

## Adding / changing the Aave wallet

Set `AAVE_WALLET_ADDRESS` and redeploy (or just re-set the env var — functions read it per-invocation). The read is `Pool.getUserAccountData` on the Aave V3 Pool proxy at `0x794a61358D6845594F94dc1DB02A252b5b4814aD` (Arbitrum One), which returns collateral/debt in USD (8 dp), the liquidation threshold, and the health factor. **Stress-test assumption, also printed in the UI:** collateral is 100% BTC-correlated and debt is stable-denominated, so HF scales linearly with a BTC shock (`HF × (1+shock)`) and liquidation sits at a `1/HF − 1` drawdown. If you ever borrow BTC-correlated assets, that math understates risk — the caveat exists so future-you doesn't trust a number past its assumptions.

## Adjusting the composite score

All weighting lives in one place: **`src/lib/score.js` → `INPUTS`**. Each input has `[min, max]` normalization bounds, a `direction` (−1 inverts, e.g. deeper 2s10s inversion pushes the score *up*), and a `weight`. Weights must sum to 1.0 — the module throws at load if they don't, and `tests/score.test.js` will fail, so a bad edit can't ship quietly. The Trading Floor renders the full breakdown (value → normalized → weight → contribution) from this same module; there is no second copy of the math to drift.

If a source is down, its input is **excluded and the remaining weights are renormalized** — and the UI says exactly that ("7/8 inputs · weights renormalized"), with the missing row shown as excluded. A degraded score is labeled degraded, never passed off as complete.

## Trader tab (intraday)

Candlestick charts (TradingView's open-source lightweight-charts) on **1m / 3m / 5m / 15m** BTC, refreshing every 30s without resetting your zoom. Data: **Kraken public OHLC primary** (720 candles of depth), Coinbase Exchange fallback, venue always named; 3m is aggregated server-side from 1m since neither venue serves it natively. Overlays: EMA 9/21/50, UTC-anchored session VWAP, volume; readout shows RSI14 and ATR14. All indicator math lives in `src/lib/ta.js` with unit tests against known values.

**Regime banner** — transparent rules, not vibes: TRENDING UP requires price above session VWAP, EMAs stacked 9>21>50, and EMA separation > 0.15× ATR; TRENDING DOWN is the mirror; everything else is CHOP, labeled as the state where short-timeframe entries historically bleed fees. **Volatility pockets** shows average bar range by hour over the loaded sample (your local time) — measured past, not promised future.

**Projection panel** — the honest version of bear/base/bull: a volatility-implied cone from 30d realized vol (zero-drift base, ±1σ and 95% bands scaling with √t), drawn over the last 90 days of actual closes. It is labeled a distribution, not a forecast, because that is what it is; the daily σ used is printed under the chart.

**Paper trading ledger** — entries and exits are stamped *server-side* from the live market price and every round trip is charged 0.1%/side simulated fees, so the record can't flatter you. Stats: win rate, expectancy per trade, net P&L, total fees, max drawdown. **Automation is locked by design** and the panel says exactly what unlocks the next conversation: 50+ closed paper trades, positive expectancy net of fees, and a written max-daily-loss rule — after which the build target is deterministic rules with hard size caps and human confirmation per order. A discretionary AI holding wallet keys is intentionally not on the roadmap.

## Simple / Advanced toggle

The header has a Simple/Advanced switch (persisted in your browser). **Simple** leads with a one-sentence plain-English headline for the score and hides the raw formula math (ranges, normalization, weights). **Advanced** shows everything — nothing is removed, Simple just reorders what's in front. Metric card labels also got plain-language clarifiers everywhere (e.g. "Corporate credit risk (HY OAS)" instead of just "HY OAS") regardless of mode.

## Market Read panel

Below the score, a "Market read · plain English" panel translates the same live metrics (funding rate, sentiment, credit spreads, curve shape, Fed stance, your position cushion) into plain descriptive states — CROWDED LONG, EXTREME FEAR, MARKET STRESSED, etc. Every threshold lives in `src/lib/signals.js`, in plain numbers, same transparency discipline as the score formula. **This is deliberately descriptive, not prescriptive** — it states what current conditions look like, never a buy/sell call. The panel's own footer repeats this disclaimer; treat it as informational context for your own judgment, not investment advice.

## Setups, alerts, and the trigger log

The **Setups tab** holds named, fully transparent condition checklists over the live data (thresholds in `src/lib/setups.js`): contrarian accumulation conditions, froth/de-risk conditions, the credit-regime-break bear-thesis trigger, and a policy-pivot risk window. A setup is ACTIVE only when *every* condition holds; missing data never counts as met (fail closed). Each card shows the live value behind every ✓/✕ and carries an honest historical framing note — these are conditions reads, never buy/sell instructions.

**BTC historical context** comes from a new `/api/btchistory` endpoint (CoinGecko 365d dailies, 6h Blob cache): 200d MA distance, drawdown from the 365d high, 30d realized vol.

**Alerts (optional):** set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` and the 30-min snapshot job pings you when a setup activates/deactivates and when your Aave health factor drops into a worse band (WARN < 1.5, DANGER < 1.25, CRITICAL < 1.1). Alerts are deduplicated by state transition — you're pinged on the change, not every 30 minutes.

**The trigger log** records BTC's price at every activation. The Setups tab shows what BTC did after each trigger. This is deliberate: it's the track record a setup must accumulate *before* it deserves capital or automation. On the roadmap-to-agentic question, the honest sequence is: codified setups → automatic paper record (this build) → review the evidence after enough triggers → only then rule-based execution with hard size caps and human confirmation. A discretionary LLM holding wallet keys is not on this roadmap on purpose.

## The narrative guarantee (the thing that matters most)

The morning take can never contradict the screen, by construction:

1. The client builds a fact sheet from the exact values currently rendered.
2. The server sends **only** those facts to the Anthropic API, instructing the model to cite them verbatim and append a `<facts_used>` JSON footer.
3. `validateNarrative()` (`src/lib/narrative.js`) runs **on the server and again on the client**: the footer must parse and match the facts within tolerance; any substantive $ / % / decimal figure in the prose must match some on-screen fact; direction words (rose/fell/widened…) must match the sign of that fact's delta. Any violation → the prose is not rendered; the UI shows the specific failures instead. The e2e suite includes a test where the server *lies* about validation passing — the client-side check still blocks it.

Every call — valid or not — lands in the token ledger with model, in/out tokens, and cost from the dated pricing map in `src/lib/cost.js`. A monthly budget (settable in the Token Usage tab, default $10) is enforced *before* the API call; at ≥80% the meter warns, at 100% narrative calls return 429.

## Data sources — decisions made and why

- **Funding rate: Deribit primary, Binance fallback.** Binance's `fapi` returns HTTP 451 from US IPs, and Netlify functions run on US infrastructure by default, so Deribit's public ticker (`funding_8h`) is the reliable venue here. The payload and the metric card always name which venue produced the number. If you self-host outside the US, the Binance fallback activates automatically on a Deribit failure.
- **Snapshot history: Netlify Blobs.** The free APIs only return "now"; a scheduled function (`*/30 * * * *`) fetches everything, computes the score, and appends a snapshot — that's what the sparklines for BTC/funding/F&G/score/HF are built from (FRED sparklines come straight from FRED's own history). Expect sparklines to say "building history" for the first hour after deploy; that's honesty, not a bug.
- **EDGAR: weekly Blobs cache, CIKs resolved at runtime** from SEC's `company_tickers.json` (never hardcoded). Capex uses `PaymentsToAcquirePropertyPlantAndEquipment` restricted to clean quarterly frames (avoids the 10-Q year-to-date cumulation trap); lease exposure is on-balance-sheet `OperatingLeaseLiability + FinanceLeaseLiability`. **Honest limitation:** "lease commitments not yet commenced" — the off-balance-sheet piece of the thesis — is disclosed in filing *text*, not XBRL, for most filers. The UI says so and points to the manual timeline rather than inventing a number.
- **Failure policy everywhere:** a source failure returns a structured 502, gets recorded to the status map, renders as a DOWN badge and an em-dash — and the Data Sources tab shows the exact error, latency, last success, and a retry button.

## Tests

```bash
npm test        # 33 unit tests: score math vs known inputs, renormalization,
                # stress math, staleness state machine, narrative validator
                # (contradiction/fabrication/direction cases), cost math
npm run e2e     # Playwright (installs browsers once: npx playwright install)
                # Hermetic — intercepts /api/*, runs against the preview build:
                # stale degradation, formula transparency, narrative blocking,
                # stress panel, auth gate
```

## First-deploy checklist (live-wire verification)

The unit and e2e suites prove the logic; these five clicks prove the live wires, since endpoint behavior can only truly be verified against the real internet:

1. Open **Data Sources** — all rows should go green within a minute. Any red row shows you the upstream error verbatim.
2. Confirm the funding card says **deribit** (expected from Netlify's US region).
3. **Positions** shows your HF matching what app.aave.com shows.
4. Trigger one snapshot early instead of waiting 30 min: `npx netlify-cli functions:invoke snapshot`. Sparklines start filling.
5. Generate one **morning take**; confirm it renders with the "validated against on-screen facts" stamp and appears in the Token Usage log.

## Security

Set `DASHBOARD_TOKEN`. Without it the API endpoints are public, which means anyone with the URL can read your position size and health factor. With it, the UI asks once per session. The Aave wallet address, all API keys, and the Anthropic key exist only in Netlify env vars — the frontend bundle contains none of them (`grep -r "sk-ant\|FRED_API" dist/` returns nothing).

## Swapping storage to Supabase (optional)

All persistence goes through four Blobs keys (`snapshots`, `source_status`, `thesis_notes`, `token_usage`, plus `settings`/`edgar_cache`) accessed only via `store()` in `netlify/shared/util.mjs`. To move to Supabase, replace that one accessor with a Supabase client exposing the same `get(key)/setJSON(key, value)` shape — no other file changes.

## Repo layout

```
src/lib/            pure, unit-tested logic (score, derive, narrative, cost)
src/App.jsx         the whole UI (single-file by design)
netlify/shared/     auth, timed fetch, status recording, source fetchers
netlify/functions/  one endpoint per source + snapshot (scheduled), narrative,
                    usage, notes, status, history, edgar
tests/              vitest unit suite
e2e/                Playwright specs (hermetic, route-intercepted)
```
