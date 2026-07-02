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
