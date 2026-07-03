// End-to-end checks for the two shipped guarantees:
//   1. A failed source degrades to a VISIBLE stale/down state — never a
//      silently wrong number.
//   2. A narrative that contradicts on-screen values is blocked from display.
//
// Hermetic by design: every /api/* call is intercepted, so these run against
// `npm run preview` with no keys, no network, and no live-market flakiness.
// (The live endpoints get their own smoke check on the Data Sources tab
// post-deploy — see README "First-deploy checklist".)
import { test, expect } from '@playwright/test'

const NOW = Date.now()
const fredObs = (v) => Array.from({ length: 20 }, (_, i) => ({ d: `2026-06-${String(30 - i).padStart(2, '0')}`, v: v - i * 0.01 }))

const HEALTHY = {
  fred: {
    series: {
      DGS10: fredObs(4.42), DGS2: fredObs(4.8), DFF: fredObs(4.33),
      DTWEXBGS: fredObs(121), BAMLH0A0HYM2: fredObs(3.61),
      WALCL: Array.from({ length: 20 }, (_, i) => ({ d: `w${i}`, v: 6600000 + i * 9000 })),
    },
    meta: { source: 'fred', fetchedAt: NOW, latencyMs: 120 },
  },
  market: { btc: 96412, btc24hPct: -2.31, meta: { source: 'market', fetchedAt: NOW, latencyMs: 80 } },
  funding: { venue: 'deribit', funding8h: 0.0001, fundingAnnualizedPct: 10.95, meta: { source: 'funding', fetchedAt: NOW, latencyMs: 90 } },
  feargreed: { value: 61, classification: 'Greed', meta: { source: 'feargreed', fetchedAt: NOW, latencyMs: 70 } },
  aave: { collateralUsd: 50000, debtUsd: 20000, liquidationThresholdPct: 78, healthFactor: 1.82, noDebt: false, pool: '0x794a6135', meta: { source: 'aave', fetchedAt: NOW, latencyMs: 300 } },
  status: { sources: {}, snapshotCron: '*/30 * * * *', nextSnapshotAt: NOW + 60000, meta: { fetchedAt: NOW } },
  history: { snapshots: [], count: 0, meta: { source: 'history', fetchedAt: NOW } },
  btchistory: {
    stats: { last: 96412, ma50: 99000, ma200: 91000, distFromMA200Pct: 5.9, high365: 126000, drawdownFromHighPct: -23.5, realizedVol30Pct: 42.1, days: 365 },
    series: [], meta: { source: 'btchistory', fetchedAt: NOW, cache: 'hit' },
  },
  candles: {
    tf: '5m', venue: 'kraken',
    candles: Array.from({ length: 150 }, (_, i) => { const c = 90000 + i * 60; return { t: 1780000000 + i * 300, o: c - 30, h: c + 60, l: c - 90, c, v: 5 } }),
    meta: { source: 'candles', fetchedAt: NOW, latencyMs: 90 },
  },
  paper: { open: [], closed: [], stats: { trades: 0 }, feePctPerSide: 0.1, meta: { fetchedAt: NOW } },
  triggers: { triggers: [{ ts: NOW - 86400000, key: 'contrarian_btc', name: 'Contrarian accumulation conditions — BTC', btc: 92000, score: 31 }], count: 1, meta: { fetchedAt: NOW } },
}

async function mockApi(page, overrides = {}) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const name = url.pathname.replace(/^\/api\//, '').split('?')[0]
    const o = overrides[name]
    if (o?.status) return route.fulfill({ status: o.status, contentType: 'application/json', body: JSON.stringify(o.body || { error: 'boom' }) })
    const rawBody = typeof o?.body === 'function' ? o.body(route) : o?.body
    const body = rawBody ?? HEALTHY[name]
    if (!body) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

test('healthy tape: score renders with the full transparent formula, all inputs included', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await expect(page.locator('.scoreval')).not.toHaveText('—')
  await expect(page.getByText('8/8 inputs')).toBeVisible()
  const rows = page.locator('table.ledger tbody tr')
  await expect(rows).toHaveCount(8)
  await expect(page.locator('table.ledger')).toContainText('HY credit spread')
  await expect(page.locator('.formula-note')).toContainText('score = Σ')
  // freshness badges present on the metric grid
  expect(await page.locator('.badge.live').count()).toBeGreaterThan(3)
})

test('a failed source degrades visibly: excluded from formula, weights renormalized, DOWN badge shown', async ({ page }) => {
  await mockApi(page, { funding: { status: 502, body: { error: 'All funding venues failed', meta: { failed: true } } } })
  await page.goto('/')
  await expect(page.getByText('7/8 inputs · weights renormalized')).toBeVisible()
  const fundingRow = page.locator('table.ledger tbody tr', { hasText: 'BTC perp funding' })
  await expect(fundingRow).toContainText('source down')
  await expect(fundingRow).toContainText('excluded')
  const fundingCard = page.locator('.cards .panel', { hasText: 'BTC perp funding' })
  await expect(fundingCard.locator('.badge.down')).toBeVisible()
  await expect(fundingCard.locator('.bigval')).toContainText('—') // never a fabricated number
})

test('narrative contradicting on-screen data is blocked from display', async ({ page }) => {
  await mockApi(page, {
    narrative: {
      body: {
        // server "returns" a lying narrative AND a lying ok:true — client must still catch it
        text: 'The 10Y fell to 4.62% and BTC found support at $88,500.\n<facts_used>{"ust10y":4.62}</facts_used>',
        validation: { ok: true, errors: [] },
        model: 'claude-sonnet-4-6',
        usage: { inputTokens: 500, outputTokens: 120, costUsd: 0.0033 },
        meta: { source: 'narrative', fetchedAt: NOW },
      },
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Generate from current on-screen data/ }).click()
  await expect(page.getByText('Narrative failed validation — not shown')).toBeVisible()
  await expect(page.locator('.take-fail')).toContainText('on-screen value is 4.42')
  await expect(page.locator('.take')).toHaveCount(0) // the prose never rendered
})

test('faithful narrative renders with its validation provenance', async ({ page }) => {
  const text = 'Pressure holds with the 10Y at 4.42% and BTC at $96,412; funding runs 10.95% annualized. HF 1.82.\n<facts_used>{"ust10y":4.42,"btc":96412,"funding_ann":10.95,"aave_hf":1.82}</facts_used>'
  await mockApi(page, {
    narrative: { body: { text, validation: { ok: true, errors: [] }, model: 'claude-sonnet-4-6', usage: { inputTokens: 500, outputTokens: 120, costUsd: 0.0033 }, meta: { fetchedAt: NOW } } },
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Generate from current on-screen data/ }).click()
  await expect(page.locator('.take')).toContainText('Pressure holds')
  await expect(page.locator('.take')).toContainText('validated against on-screen facts')
})

test('positions tab: stress rungs and the liquidation line', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Positions' }).click()
  await expect(page.locator('.stress')).toContainText('-40%')
  await expect(page.locator('.stress')).toContainText('LIQUIDATION LINE')
  await expect(page.getByText(/Assumes collateral is 100% BTC-correlated/)).toBeVisible()
})

test('Simple mode hides the raw formula math, Advanced restores it, choice persists on reload', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  // Simple is the default: plain headline visible, technical columns hidden.
  await expect(page.locator('.headline')).toBeVisible()
  await expect(page.getByText('Range → norm')).toBeHidden()
  await page.getByRole('button', { name: 'Advanced' }).click()
  await expect(page.getByText('Range → norm')).toBeVisible()
  await expect(page.locator('.headline')).toBeHidden()
  await page.reload()
  await expect(page.getByText('Range → norm')).toBeVisible() // choice persisted via localStorage
})

test('Market Read panel gives a plain-English, non-prescriptive description of conditions', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  const panel = page.locator('.panel', { hasText: 'Market read · plain English' })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Not a recommendation to buy, sell, or hold', { ignoreCase: true })
  await expect(panel.getByText('Your position cushion')).toBeVisible()
})

test('Setups tab: checklist logic renders live values, fail-closed unknowns, and trigger history math', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Setups' }).click()
  const contrarian = page.locator('.setupcard', { hasText: 'Contrarian accumulation' })
  // F&G 61 in fixture → sentiment condition unmet; drawdown -23.5 → met
  await expect(contrarian).toContainText('of 4 conditions met')
  await expect(contrarian).toContainText('-23.5% from high')
  // Trigger history computes since-trigger performance from live BTC (92000 → 96412 = +4.8%)
  await expect(page.locator('.stress')).toContainText('+4.8%')
  await expect(page.getByText(/not recommendations to buy, sell, or hold/i)).toBeVisible()
})

test('Trading Floor shows the setups strip pointing at the closest setup', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByText(/closest: .* \(\d of \d conditions\)/)).toBeVisible()
})

test('Trader tab: chart renders, regime reads the tape, projection carries its honesty label', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Trader' }).click()
  await expect(page.locator('.regimebanner .regstate')).toHaveText('TRENDING UP') // clean synthetic uptrend
  await expect(page.locator('.candlechart canvas').first()).toBeVisible() // lightweight-charts mounted
  await expect(page.getByText(/not a forecast/i).first()).toBeVisible()
  await expect(page.getByText('Automation · locked by design')).toBeVisible()
})

test('Paper ledger: opening a trade posts to the server and renders the open position', async ({ page }) => {
  const openTrade = { id: 'pt1', ts: Date.now(), side: 'long', sizeUsd: 1000, entry: 96400, venue: 'kraken', note: 'vwap reclaim' }
  let opened = false
  await mockApi(page, {
    paper: {
      body: (route) => {
        if (route.request().method() === 'POST') { opened = true; return { ok: true, trade: openTrade, open: [openTrade], closed: [] } }
        return opened
          ? { open: [openTrade], closed: [], stats: { trades: 0 }, feePctPerSide: 0.1, meta: { fetchedAt: Date.now() } }
          : { open: [], closed: [], stats: { trades: 0 }, feePctPerSide: 0.1, meta: { fetchedAt: Date.now() } }
      },
    },
  })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Trader' }).click()
  await page.getByRole('button', { name: 'Open paper long' }).click()
  await expect(page.locator('table.stress')).toContainText('vwap reclaim')
  await expect(page.locator('table.stress')).toContainText('$96,400')
})

test('token gate appears when the API demands auth', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }))
  await page.goto('/')
  await expect(page.getByText('Dashboard token required')).toBeVisible()
})
