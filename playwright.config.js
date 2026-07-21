import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

// Hermetic: specs intercept every /api/* call, so this runs against the
// static preview build — no keys, no live markets, no netlify CLI needed.
// Two projects: desktop + a 390×844 phone. Mobile bars (no horizontal
// scroll, reachable nav) are asserted in the specs themselves.

// Some CI containers pre-install Chromium outside the pinned playwright
// version's expected cache path; when present, use it directly.
const chromiumPath = process.env.PW_CHROMIUM_PATH
  || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null)

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 90_000,
  },
})
