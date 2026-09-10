import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditSpecFile, findOrphanedSnapshots } from '../playwrightSnapshotOrphans';

function writeSpec(dir: string, name: string, content: string): string {
  const specFile = path.join(dir, name);
  fs.writeFileSync(specFile, content);
  return specFile;
}

describe('playwrightSnapshotOrphans', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-playwright-orphans-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves toHaveScreenshot(...) literal, sanitizing underscores like Playwright does', () => {
    const specFile = writeSpec(
      tempDir,
      'foo.visual.spec.ts',
      `test('renders', async ({ page }) => {
        await expect(page).toHaveScreenshot('foo_bar.png');
      });`,
    );
    const audit = auditSpecFile(specFile, { projectName: 'chromium' });
    expect(audit.unresolved).toEqual([]);
    expect([...audit.expected]).toEqual(['foo-bar-chromium-linux.png']);
  });

  it('resolves expectGraphAndScreenshot into a png/json/svg triple, svg keeping raw name', () => {
    const specFile = writeSpec(
      tempDir,
      'foo.visual.spec.ts',
      `test('renders', async ({ page }) => {
        await expectGraphAndScreenshot(page, 'foo_bar.png');
      });`,
    );
    const audit = auditSpecFile(specFile, { projectName: 'chromium' });
    expect(audit.unresolved).toEqual([]);
    expect([...audit.expected].sort()).toEqual(
      ['foo-bar-chromium-linux.json', 'foo-bar-chromium-linux.png', 'foo_bar.svg'].sort(),
    );
  });

  it('resolves a template literal driven by a for-of loop over an inline array literal', () => {
    const specFile = writeSpec(
      tempDir,
      'foo.visual.spec.ts',
      `for (const side of ['left', 'right'] as const) {
        test(\`resizes \${side}\`, async ({ page }) => {
          await expectGraphAndScreenshot(page, \`region-resize-\${side}.png\`);
        });
      }`,
    );
    const audit = auditSpecFile(specFile, { projectName: 'chromium' });
    expect(audit.unresolved).toEqual([]);
    expect([...audit.expected].sort()).toEqual(
      [
        'region-resize-left-chromium-linux.json',
        'region-resize-left-chromium-linux.png',
        'region-resize-left.svg',
        'region-resize-right-chromium-linux.json',
        'region-resize-right-chromium-linux.png',
        'region-resize-right.svg',
      ].sort(),
    );
  });

  it('resolves a template literal driven by a for-of loop over an imported array', () => {
    writeSpec(tempDir, 'helper.ts', `export const MODULES = ['adder', 'mux2'];`);
    const specFile = writeSpec(
      tempDir,
      'foo.visual.spec.ts',
      `import { MODULES } from './helper';
      for (const moduleName of MODULES) {
        test(\`renders \${moduleName}\`, async ({ page }) => {
          await expectGraphAndScreenshot(page, \`example-\${moduleName}.png\`);
        });
      }`,
    );
    const audit = auditSpecFile(specFile, { projectName: 'chromium' });
    expect(audit.unresolved).toEqual([]);
    expect([...audit.expected].sort()).toEqual(
      [
        'example-adder-chromium-linux.json',
        'example-adder-chromium-linux.png',
        'example-adder.svg',
        'example-mux2-chromium-linux.json',
        'example-mux2-chromium-linux.png',
        'example-mux2.svg',
      ].sort(),
    );
  });

  it('resolves a property-access template through a helper param (system resize case)', () => {
    const specFile = writeSpec(
      tempDir,
      'foo.spec.ts',
      `const CASES = [
        { kind: 'side', handle: 'left' },
        { kind: 'side', handle: 'right' },
      ] as const;

      async function assertResize(workbox, resizeCase) {
        await expect(workbox).toHaveScreenshot(\`resized-\${resizeCase.handle}.png\`);
      }

      for (const resizeCase of CASES) {
        test(\`resizes \${resizeCase.handle}\`, async ({ workbox }) => {
          await assertResize(workbox, resizeCase);
        });
      }`,
    );
    const audit = auditSpecFile(specFile, { projectName: '' });
    expect(audit.unresolved).toEqual([]);
    expect([...audit.expected].sort()).toEqual(
      ['resized-left-linux.png', 'resized-right-linux.png'].sort(),
    );
  });

  it('resolves a helper param passed straight through to toHaveScreenshot(name)', () => {
    const specFile = writeSpec(
      tempDir,
      'foo.spec.ts',
      `async function screenshotStep(workbox, name) {
        await expect(workbox).toHaveScreenshot(name);
      }

      test('step one', async ({ workbox }) => {
        await screenshotStep(workbox, 'step-one.png');
      });
      test('step two', async ({ workbox }) => {
        await screenshotStep(workbox, 'step-two.png');
      });`,
    );
    const audit = auditSpecFile(specFile, { projectName: '' });
    expect(audit.unresolved).toEqual([]);
    expect([...audit.expected].sort()).toEqual(['step-one-linux.png', 'step-two-linux.png'].sort());
  });

  it('does not flag siblings as orphaned when a call in the same file is unresolved', () => {
    const specDir = tempDir;
    writeSpec(
      specDir,
      'foo.spec.ts',
      `test('kept', async ({ workbox }) => {
        await expect(workbox).toHaveScreenshot('kept.png');
      });
      test('dynamic', async ({ workbox, kind }) => {
        await expect(workbox).toHaveScreenshot(\`dynamic-\${kind}.png\`);
      });`,
    );
    const screenshotsDir = path.join(specDir, '__screenshots__');
    const snapshotDir = path.join(screenshotsDir, 'foo.spec.ts-snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'kept-linux.png'), '');
    fs.writeFileSync(path.join(snapshotDir, 'dynamic-whatever-linux.png'), '');

    const report = findOrphanedSnapshots(specDir, screenshotsDir, /\.spec\.ts$/, {
      projectName: '',
    });
    expect(report.orphans).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
  });

  it('reports a no-arg toHaveScreenshot() call as unresolved instead of guessing', () => {
    const specFile = writeSpec(
      tempDir,
      'foo.visual.spec.ts',
      `test('renders', async ({ page }) => {
        await expect(page).toHaveScreenshot();
      });`,
    );
    const audit = auditSpecFile(specFile, { projectName: 'chromium' });
    expect(audit.expected.size).toBe(0);
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0].reason).toContain('no name argument');
  });

  it('flags a baseline with no matching call as an orphan, but not known-live files', () => {
    const specDir = tempDir;
    writeSpec(
      specDir,
      'foo.visual.spec.ts',
      `test('renders', async ({ page }) => {
        await expect(page).toHaveScreenshot('kept.png');
      });`,
    );
    const screenshotsDir = path.join(specDir, '__screenshots__');
    const snapshotDir = path.join(screenshotsDir, 'foo.visual.spec.ts-snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'kept-chromium-linux.png'), '');
    fs.writeFileSync(path.join(snapshotDir, 'stale-chromium-linux.png'), '');

    const report = findOrphanedSnapshots(specDir, screenshotsDir, /\.visual\.spec\.ts$/, {
      projectName: 'chromium',
    });
    expect(report.orphans).toEqual([path.join(snapshotDir, 'stale-chromium-linux.png')]);
  });
});
