import { test, expect } from '@playwright/test'
import { installApi, payloads } from './mocks.js'

test.describe('honest degradation — a dead source must look dead', () => {
  test('quote 502 → NO_DATA directive, em-dash price, dead chip, retry offered', async ({ page }) => {
    await installApi(page, {
      overrides: { quote: { status: 502, body: { error: 'yahoo: all sources failed', meta: { failed: true } } } },
    })
    await page.goto('/')

    await expect(page.getByTestId('directive-action')).toHaveText('No data')
    await expect(page.getByTestId('directive')).toContainText('data is dead, not the market')
    await expect(page.locator('.tape .tk').first()).toContainText('—')
    await expect(page.locator('.error-row')).toBeVisible()
    await expect(page.locator('.error-row .btn')).toHaveText('Retry')
  })

  test('candle history 502 → regime says insufficient data, no fake trend read', async ({ page }) => {
    await installApi(page, {
      overrides: { candlesMstr: { status: 502, body: { error: 'all sources failed', meta: { failed: true } } } },
    })
    await page.goto('/')
    await expect(page.getByTestId('cockpit')).toContainText('insufficient data')
    // and the directive can only stand aside — never invent an entry
    await expect(page.getByTestId('directive-action')).not.toHaveText('Enter long')
  })

  test('BTC spot dead → the live trigger is BLOCKED, not just footnoted', async ({ page }) => {
    await installApi(page, {
      overrides: { btc: { status: 502, body: { error: 'all sources failed', meta: { failed: true } } } },
    })
    await page.goto('/')
    await expect(page.getByTestId('directive')).toContainText('BTC data is dead')
    await expect(page.locator('.tape .tk').nth(1)).toContainText('—')
    // the scenario has a live pullback trigger — a dead BTC feed must veto it
    await expect(page.getByTestId('directive-action')).toHaveText('Stand aside')
    await expect(page.getByTestId('directive')).toContainText('feed is dead')
  })

  test('mid-session staleness ladder: stale keeps the price with an amber chip; dead erases it', async ({ page }) => {
    // stale: quote fetched 30 min ago (past the 20-min live window)
    const stale = payloads()
    stale.quote.meta.fetchedAt = Date.now() - 30 * 60 * 1000
    await installApi(page, { data: stale })
    await page.goto('/')
    await expect(page.locator('.tape .tk').first().locator('.chip.stale')).toBeVisible()
    await expect(page.locator('.tape .tk').first()).not.toContainText('—')
    await expect(page.getByTestId('directive')).toContainText('stale')
  })

  test('dead-by-age: a 2-hour-old quote renders as no price at all', async ({ page }) => {
    const dead = payloads()
    dead.quote.meta.fetchedAt = Date.now() - 2 * 3600 * 1000
    await installApi(page, { data: dead })
    await page.goto('/')
    await expect(page.getByTestId('directive-action')).toHaveText('No data')
    await expect(page.locator('.tape .tk').first()).toContainText('—')
    // and the entry planner refuses to size a trade from a dead price
    await expect(page.getByTestId('entry-planner')).toContainText('No live price to plan against')
  })

  test('EOD fallback quote wears an EOD chip, never a green live face', async ({ page }) => {
    const eod = payloads()
    eod.quote.kind = 'eod'
    eod.quote.delayedMin = null
    eod.quote.sourceDetail = 'stooq (yahoo failed: HTTP 429)'
    await installApi(page, { data: eod })
    await page.goto('/')
    await expect(page.locator('.tape .tk').first().locator('.chip.stale', { hasText: 'EOD' })).toBeVisible()
  })
})
