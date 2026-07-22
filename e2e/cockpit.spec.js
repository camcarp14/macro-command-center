import { test, expect } from '@playwright/test'
import { installApi, payloads, SETTINGS } from './mocks.js'
import { atr } from '../src/lib/ta.js'
import { initialStop, sizePosition, rMultiple } from '../src/lib/risk.js'
import { fmtPx } from '../src/lib/format.js'

test.describe('cockpit — healthy market, live pullback trigger', () => {
  test('directive says Enter long with a computed size; tape and chips are honest', async ({ page }) => {
    const data = payloads()
    await installApi(page, { data })
    await page.goto('/')

    await expect(page.getByTestId('directive-action')).toHaveText('Enter long')

    // the size shown must equal what the engine computes from the same inputs
    const atrArr = atr(data.mstr, 14)
    const plan = initialStop({ mode: 'atr', entry: data.price, atr: atrArr[atrArr.length - 1], atrMult: SETTINGS.atrMult })
    const sz = sizePosition({ equity: SETTINGS.equity, riskPct: SETTINGS.riskPct, entry: data.price, stop: plan.stop, maxPositionPct: SETTINGS.maxPositionPct })
    await expect(page.getByTestId('directive')).toContainText(`Buy ${sz.shares} MSTR`)
    await expect(page.getByTestId('plan-shares')).toHaveText(`${sz.shares} sh`)

    // tape shows both prices; freshness reads live
    await expect(page.locator('.tape')).toContainText('MSTR')
    await expect(page.locator('.tape')).toContainText('BTC')
    await expect(page.locator('.tape .chip.live').first()).toBeVisible()

    // seeded balance-sheet honesty warning is present
    await expect(page.getByTestId('torque-card')).toContainText('SEEDED')

    // run preparation layer: radar reads ARMED in this scenario (uptrend +
    // aligned BTC + live trigger), battle plan carries a computable ticket
    await expect(page.getByTestId('run-radar')).toContainText('ARMED')
    await expect(page.getByTestId('run-radar')).toContainText('Belief sets the watchlist')
    await expect(page.getByTestId('battle-plan')).toContainText('If this happens')
    await expect(page.getByTestId('battle-plan')).toContainText('THE CAMPAIGN LADDER')
    await expect(page.getByTestId('battle-plan')).toContainText('WHAT RETIRES THE PLAN')
    // mNAV history strip renders with the honesty caption
    await expect(page.getByTestId('mnav-strip')).toContainText('shape, not gospel')
  })

  test('mobile: no horizontal overflow on ANY tab, nav reachable with ≥44px targets', async ({ page }, testInfo) => {
    await installApi(page, {
      journal: [{ id: 't0', entryDate: '2026-06-01', exitDate: '2026-06-20', entry: 380, exit: 425, shares: 30, initialStop: 355, kind: 'pullback', note: '' }],
    })
    await page.goto('/')
    await expect(page.getByTestId('directive')).toBeVisible()

    // every tab — the journal's wide table once blew the layout to 691px
    for (const tabName of ['Cockpit', 'Chart', 'Journal', 'Settings']) {
      await page.locator('.nav button', { hasText: tabName }).click()
      const m = await page.evaluate(() => ({
        overflow: document.scrollingElement.scrollWidth - window.innerWidth,
        vw: window.innerWidth,
      }))
      expect(m.overflow, `${tabName} must not overflow horizontally`).toBeLessThanOrEqual(1)
      if (testInfo.project.name === 'mobile') {
        expect(m.vw, `${tabName}: layout viewport must stay 390 (no zoom-out escape)`).toBeLessThanOrEqual(391)
      }
    }

    if (testInfo.project.name === 'mobile') {
      const nav = page.locator('.nav button', { hasText: 'Journal' })
      const box = await nav.boundingBox()
      expect(box.height).toBeGreaterThanOrEqual(44)
      await nav.tap()
      await expect(page.getByTestId('journal')).toBeVisible()
      // the smallest interactive elements also meet the 44px bar now
      // (scope to the visible panel — hidden mounted tabs have no boxes)
      const del = await page.getByTestId('journal').locator('.btn.sm').first().boundingBox()
      expect(del.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('open position: live R, effective stop (incl. high-water), trail on chart tab', async ({ page }) => {
    const data = payloads()
    const entryIdx = 40
    const entryDate = new Date(data.mstr[entryIdx].t * 1000).toISOString().slice(0, 10)
    // stopHighWater sits above what the trail would compute (but below price):
    // the persisted ratchet must govern the displayed stop
    const stopHighWater = Math.round(data.price * 0.985 * 100) / 100
    const position = {
      shares: 24, avgEntry: data.mstr[entryIdx].c, entryDate,
      initialStop: Math.round(data.mstr[entryIdx].c * 0.9 * 100) / 100, stopOverride: null, note: '',
      stopHighWater,
    }
    await installApi(page, { data, position })
    await page.goto('/')

    const expectedR = rMultiple({ entry: position.avgEntry, initialStop: position.initialStop, price: data.price })
    const shown = await page.getByTestId('open-r').textContent()
    expect(parseFloat(shown.replace('+', ''))).toBeCloseTo(expectedR, 1)

    await expect(page.getByTestId('position-card')).toContainText('Stop now')
    // the persisted high-water mark governs when it exceeds the live trail
    await expect(page.getByTestId('position-card')).toContainText(fmtPx(stopHighWater))

    await page.locator('.nav button', { hasText: 'Chart' }).click()
    await expect(page.getByTestId('price-chart')).toBeVisible()
    await expect(page.locator('.overlay-legend')).toContainText('stop')
  })

  test('journal: logging a trade posts, refreshes, and scores in R', async ({ page }, testInfo) => {
    await installApi(page, {
      journal: [{ id: 't0', entryDate: '2026-06-01', exitDate: '2026-06-20', entry: 380, exit: 425, shares: 30, initialStop: 355, kind: 'pullback', note: '' }],
    })
    await page.goto('/')
    await page.locator('.nav button', { hasText: 'Journal' }).click()

    // existing trade shows +1.8R = (425-380)/(380-355)
    await expect(page.getByTestId('trades-table')).toContainText('+1.8R')

    // Dates are set via the native value setter + input event (what typing
    // produces for React) instead of fill(): focusing a date input in mobile
    // Chrome emulation arms an invisible native picker overlay that swallows
    // every later tap on the form. Everything else uses real interactions.
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      for (const [id, v] of [['jt-ed', '2026-07-01'], ['jt-xd', '2026-07-10']]) {
        const el = document.getElementById(id)
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await page.fill('#jt-e', '400')
    await page.fill('#jt-x', '440')
    await page.fill('#jt-s', '25')
    await page.fill('#jt-st', '380')
    await expect(page.locator('#jt-st ~ .hint')).toContainText('+2R')
    // Submit via Enter in the note field — implicit form submission, i.e.
    // the phone keyboard's "Go" key. (Pointer-click submits are covered on
    // mobile by the settings spec; this form trips a Playwright hit-test
    // quirk in emulation that no real gesture reproduces.)
    if (testInfo.project.name === 'mobile') {
      await page.locator('#jt-n').press('Enter')
    } else {
      await page.getByRole('button', { name: 'Log trade' }).click()
    }

    await expect(page.locator('.toast')).toContainText('Trade logged')
    await expect(page.getByTestId('trades-table')).toContainText('2026-07-01')
    await expect(page.getByTestId('total-r')).toContainText('R')

    // server-side rejection surfaces: exit before entry is a rule the HTML
    // attributes can't express, so the REAL validator in the mock must catch
    // it and the UI must show the rejection, not a fake success
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      for (const [id, v] of [['jt-ed', '2026-07-10'], ['jt-xd', '2026-07-01']]) {
        const el = document.getElementById(id)
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await page.fill('#jt-e', '400')
    await page.fill('#jt-x', '440')
    await page.fill('#jt-s', '25')
    await page.fill('#jt-st', '380')
    await page.locator('#jt-st').blur()
    if (testInfo.project.name === 'mobile') {
      await page.locator('#jt-n').press('Enter')
    } else {
      await page.getByRole('button', { name: 'Log trade' }).click()
    }
    await expect(page.locator('.toast.err')).toContainText('Not saved')
  })

  test('replay: toggling the rule audit shows honest summary stats', async ({ page }) => {
    await installApi(page)
    await page.goto('/')
    await page.locator('.nav button', { hasText: 'Chart' }).click()
    await page.getByTestId('replay-toggle').click()
    await expect(page.getByTestId('replay-summary')).toBeVisible()
    await expect(page.getByTestId('replay-summary')).toContainText(/trades over|never triggered/)
  })

  test('settings: risk form round-trips through REAL validation', async ({ page }) => {
    await installApi(page)
    await page.goto('/')
    await page.locator('.nav button', { hasText: 'Settings' }).click()
    await expect(page.getByTestId('risk-form')).toBeVisible()
    await page.fill('#rf-risk', '0.75')
    await page.getByRole('button', { name: 'Save risk settings' }).click()
    await expect(page.locator('.toast')).toContainText('saved')
  })

  test('settings: verifying balance-sheet inputs flips the seeded warning off', async ({ page }) => {
    await installApi(page)
    await page.goto('/')
    await expect(page.getByTestId('torque-card')).toContainText('SEEDED')
    await page.locator('.nav button', { hasText: 'Settings' }).click()
    await expect(page.getByTestId('balance-form')).toBeVisible()
    await page.getByRole('button', { name: 'Save as verified' }).click()
    await expect(page.locator('.toast')).toContainText('verified')
    await page.locator('.nav button', { hasText: 'Cockpit' }).click()
    await expect(page.getByTestId('torque-card')).not.toContainText('SEEDED')
  })
})

test.describe('auth gate', () => {
  test('401 shows the token gate; unlocking proceeds', async ({ page }) => {
    await installApi(page)
    // Registered AFTER installApi so it matches FIRST (playwright routes are
    // newest-first); falls back to the mocks once the token header appears.
    await page.route('**/api/**', async (route) => {
      if (!route.request().headers()['x-dashboard-token']) {
        return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' })
      }
      return route.fallback()
    })
    await page.goto('/')

    await expect(page.locator('.gate')).toBeVisible()
    await page.fill('#tok', 'sesame')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByTestId('directive')).toBeVisible()
  })
})
