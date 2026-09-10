import { defineConfig } from '@playwright/test';
import type { VSCodeWorkerOptions, VSCodeTestOptions } from 'vscode-test-playwright';
import { defineBddConfig, cucumberReporter } from 'playwright-bdd';
import path from 'path';
import os from 'os';
import { configuredPlaywrightUpdateMode } from '../snapshotPolicy';

const root = path.resolve(__dirname, '../..');
const vscodeVersion = process.env.VSCODE_VERSION || '1.91.0';
const generatedDir = path.join(os.tmpdir(), `svsch-bdd-generated-${path.basename(root)}`);
const reportDir = path.join(os.tmpdir(), `svsch-bdd-report-${path.basename(root)}`);

const outputDir = defineBddConfig({
  features: path.join(root, 'test/features/**/*.feature'),
  featuresRoot: path.join(root, 'test'),
  steps: [path.join(root, 'test/steps/fixtures.ts'), path.join(root, 'test/steps/*.steps.ts')],
  outputDir: generatedDir,
  tags: 'not @skip',
  disableWarnings: { importTestFrom: true },
});

const reporters: any[] = [
  ['list'],
  ['./step-attachment-reporter.ts'],
  ['json', { outputFile: path.join(root, 'test-results/bdd/playwright-report.json') }],
  ['html', { open: 'never', outputFolder: reportDir }],
  // Emit a cucumber-JSON report so `npm run docs:generate` can build the
  // living BDD documentation (multiple-cucumber-html-reporter consumes this).
  // Own subdir so the reporter doesn't pick up snapshot-diff JSON in bdd/.
  cucumberReporter('json', {
    outputFile: path.join(root, 'test-results/bdd/cucumber/cucumber-report.json'),
  }),
];

if (process.env.SVSCH_TEST_STATUS_FILE) {
  reporters.push([path.resolve(root, 'scripts/playwright-progress-reporter.js')]);
}

export default defineConfig<VSCodeTestOptions, VSCodeWorkerOptions>({
  updateSnapshots: configuredPlaywrightUpdateMode(),
  globalSetup: path.resolve(__dirname, 'globalSetup.ts'),
  globalTeardown: path.resolve(__dirname, '../globalTeardown.ts'),
  testDir: outputDir,
  // Required for `--shard` to split individual scenarios across shards. Without
  // it, Playwright treats each spec file as an atomic unit when sharding, and
  // playwright-bdd compiles each .feature file into a single spec file — with
  // only 5 feature files, shards beyond the 5th would sit empty. workers stays
  // 1, so this doesn't change execution concurrency within a shard.
  fullyParallel: true,
  // The resize/persist round-trip (CSS custom property -> React Flow's
  // ResizeObserver-driven `measured` size) occasionally takes longer than a
  // scenario's poll timeout to converge on CI runners; one retry absorbs
  // that without masking a real regression (a deterministically broken
  // scenario still fails both attempts).
  retries: process.env.CI ? 2 : 0,
  // Keep test artifacts on overlayfs (/tmp) to avoid v9fs ENOSPC issues when
  // vscode-test-playwright copies VS Code logs at teardown.
  outputDir: path.join(os.tmpdir(), `bdd-playwright-results-${path.basename(root)}`),
  workers: 1,
  timeout: 120_000,
  reporter: reporters,
  use: {
    extensionDevelopmentPath: root,
    // Use a minimal workspace with no .sv files at startup; scenarios write
    // their own files before opening the diagram through the extension.
    baseDir: path.join(root, 'test/bdd-workspace'),
    deviceScaleFactor: 1,
    vscodeVersion,
    vscodeTrace: 'retain-on-failure',
    // Keep every CI video for the review gallery. The earlier ENOSPC failures
    // were caused by an orphaned VS Code utility process flooding its inherited
    // runner log pipe, not by the videos (a complete run is about 40 MiB at
    // this size). Local runs keep only failures to avoid leaving routine debris.
    // Provided by our vscode-test-playwright patch — upstream has no video
    // support (recordVideo is passed to the Electron launch).
    //
    // Downscaled well below the 1400x1000 viewport: every scenario records
    // (even passing ones — we don't know a test failed until it's over, so
    // the in-progress recording is deleted afterwards rather than skipped),
    // and a hung close (see closeElectronApp's 5s force-kill path, and the
    // 15s context.close() budget above it in the patch) lets a still-running
    // renderer keep emitting video frames for that whole window before being
    // killed. A smaller frame bounds how much a single stuck scenario can
    // write in that window; still plenty to see what a failure looked like.
    vscodeVideo: {
      // SVSCH_LOCAL_NO_VIDEO opts out of recording entirely: in some headless
      // containers (no GPU, software GL) the Electron screencast prevents the
      // workbench window from ever loading, so no scenario can run with video.
      mode: process.env.CI ? 'on' : process.env.SVSCH_LOCAL_NO_VIDEO ? 'off' : 'retain-on-failure',
      size: { width: 640, height: 460 },
    },
    viewport: { width: 1400, height: 1000 },
  },
});
