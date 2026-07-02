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
}

async function mockApi(page, overrides = {}) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const name = url.pathname.replace(/^\/api\//, '').split('?')[0]
    const o = overrides[name]
    if (o?.status) return route.fulfill({ status: o.status, contentType: 'application/json', body: JSON.stringify(o.body || { error: 'boom' }) })
    const body = o?.body ?? HEALTHY[name]
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

test('token gate appears when the API demands auth', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }))
  await page.goto('/')
  await expect(page.getByText('Dashboard token required')).toBeVisible()
})
