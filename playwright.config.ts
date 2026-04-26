import { defineConfig, devices } from '@playwright/test';

const reporters = process.env.CI
  ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
  : [['list']];

export default defineConfig({
  testDir: './test/visual',
  outputDir: './test-results/visual',
  snapshotDir: './test/visual/__screenshots__',
  fullyParallel: false,
  reporter: reporters,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    screenshot: {
      scale: 'css'
    },
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 1000 }
  },
  webServer: {
    command: 'npm run visual:serve',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
