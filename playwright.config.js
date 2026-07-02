import { defineConfig } from '@playwright/test'

// Hermetic: specs intercept every /api/* call, so this runs against the
// static preview build — no keys, no live markets, no netlify CLI needed.
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
