import { defineConfig } from '@playwright/test';
import type { VSCodeWorkerOptions, VSCodeTestOptions } from 'vscode-test-playwright';
import path from 'path';
import { configuredPlaywrightUpdateMode, SNAPSHOT_THRESHOLDS } from '../snapshotPolicy';

const root = path.resolve(__dirname, '../..');
const vscodeVersion = process.env.VSCODE_VERSION || '1.91.0';

const reporters: any[] = [
  ['list'],
  ['json', { outputFile: path.join(root, 'test-results/system/playwright-report.json') }],
  ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report/system') }],
];

if (process.env.SVSCH_TEST_STATUS_FILE) {
  reporters.push([path.resolve(root, 'scripts/playwright-progress-reporter.js')]);
}

export default defineConfig<VSCodeTestOptions, VSCodeWorkerOptions>({
  updateSnapshots: configuredPlaywrightUpdateMode(),
  globalSetup: path.resolve(__dirname, 'globalSetup.ts'),
  globalTeardown: path.resolve(__dirname, '../globalTeardown.ts'),
  testDir: __dirname,
  // Playwright's default testMatch also picks up `*.test.ts` files, which
  // collides with vitest-only files living alongside the specs here (e.g.
  // partial_diagram_interactions.coverage.test.ts) — restrict to `*.spec.ts`
  // so those stay vitest-only.
  testMatch: '**/*.spec.ts',
  // Playwright's default (<rootDir>/test-results, flat per-test) doesn't
  // match the CI upload glob (test-results/system/**) that the video
  // gallery job reads from — keep everything (videos, traces) nested here.
  outputDir: path.join(root, 'test-results/system/playwright-output'),
  snapshotDir: path.join(__dirname, '__screenshots__', vscodeVersion),
  workers: 1,
  timeout: 240_000,
  reporter: reporters,
  expect: {
    toHaveScreenshot: {
      // Repeated full-window renders differed by at most 119 pixels. Keep a
      // small buffer for Electron anti-aliasing without masking UI changes.
      maxDiffPixels: SNAPSHOT_THRESHOLDS.playwright.system.default,
    },
  },
  use: {
    extensionDevelopmentPath: root,
    // VSCode workspace: ./test/ already has .vscode/settings.json configuring
    // svsch.projectFolder = fixtures and suppressing noisy popups.
    baseDir: path.join(root, 'test'),
    deviceScaleFactor: 1,
    // Pin to Electron 30 era. VSCode 1.121 uses Electron 35+ which
    // drops --remote-debugging-port=0 support that Playwright 1.59 requires.
    vscodeVersion,
    vscodeTrace: 'retain-on-failure',
    // Same downscaled-recording rationale as test/bdd/playwright.config.ts —
    // see the comment there. System's suite is much smaller (5 tests x 3
    // versions), so keeping every CI video is cheap here too.
    vscodeVideo: {
      mode: process.env.CI ? 'on' : 'retain-on-failure',
      size: { width: 640, height: 460 },
    },
  },
});
