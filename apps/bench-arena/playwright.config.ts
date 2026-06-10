import { defineConfig, devices } from '@playwright/test'

/**
 * Drives the arena against a production `build` + `preview` (stable code,
 * representative of what a consumer ships), one worker for CPU isolation. The
 * preview server consumes the real Attaform `dist`, so run `pnpm prepack` at the
 * repo root first (the webServer build will fail loudly otherwise). `gc()` is
 * exposed so the driver can collect between cells and keep one library's
 * garbage from skewing the next.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:4174',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--js-flags=--expose-gc'] },
      },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
})
