import { test, expect } from '@playwright/test'
import { installApi } from './mocks.js'

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

  test('BTC spot dead → guardrail admits it while MSTR keeps working', async ({ page }) => {
    await installApi(page, {
      overrides: { btc: { status: 502, body: { error: 'all sources failed', meta: { failed: true } } } },
    })
    await page.goto('/')
    await expect(page.getByTestId('directive')).toContainText('BTC data is dead')
    await expect(page.locator('.tape .tk').nth(1)).toContainText('—')
  })
})
