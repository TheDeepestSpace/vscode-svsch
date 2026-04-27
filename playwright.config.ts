import { defineConfig, devices } from '@playwright/test';

const chromiumStabilizationArgs = [
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning'
];

const reporters = process.env.CI
  ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
  : [['list']];
const visualPort = Number(process.env.SVSCH_VISUAL_PORT ?? 5174);
const visualBaseUrl = `http://127.0.0.1:${visualPort}`;

export default defineConfig({
  testDir: './test/visual',
  outputDir: './test-results/visual',
  snapshotDir: './test/visual/__screenshots__',
  fullyParallel: false,
  reporter: reporters,
  use: {
    baseURL: visualBaseUrl,
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    screenshot: {
      scale: 'css'
    },
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 1000 }
  },
  webServer: {
    command: `npm run visual:serve -- --port ${visualPort}`,
    url: visualBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: chromiumStabilizationArgs
        }
      }
    }
  ]
});
