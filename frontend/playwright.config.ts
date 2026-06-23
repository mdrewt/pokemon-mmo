// Playwright config for the M5 two-window integration test.
//
// LOCAL gate (not CI): the suite needs a running SpacetimeDB local server with the module
// published — CI has no `spacetime` CLI. `global-setup` republishes the module for a clean,
// deterministic world; `webServer` runs the Vite DEV server (so the `window.__game` introspection
// hook, gated on import.meta.env.DEV, is present). Serial / single worker because both windows
// share one authoritative world.

import { defineConfig, devices } from '@playwright/test';

const PORT = 5174; // distinct from the usual dev server (5173) so a running dev session doesn't clash

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Both windows drive their own Pixi `app.ticker` (rAF) game loop. Without these, Chromium
        // throttles rAF in the non-foreground context, so the backgrounded window can't process
        // input → enqueue moves. Keep every renderer running at full speed.
        launchOptions: {
          args: [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
