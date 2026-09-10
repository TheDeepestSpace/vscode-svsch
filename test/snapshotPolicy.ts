import type { FullConfig } from '@playwright/test';
import * as os from 'node:os';
import * as path from 'node:path';

export const SNAPSHOT_THRESHOLDS = {
  playwright: {
    visual: {
      default: 20,
      muxLongNames: 2,
      // nested-case-literal-collision-canvas renders two sibling literal
      // nodes with adjacent, near-identical labels ("4'hA"/"4'hB"); CI has
      // shown small (~81px) sub-pixel antialiasing diffs there (issue #339)
      // that don't reproduce locally and aren't a real rendering regression.
      nestedCaseLiteralCollision: 120,
    },
    system: {
      default: 20,
      // inverter-not-expression's full-window capture has shown a 117px
      // sub-pixel antialiasing diff on VS Code 1.90.0 (the oldest pinned
      // build, PR #376) that doesn't reproduce on newer builds and isn't a
      // real rendering regression.
      inverterNotExpression: 120,
      // mux-ternary-assign and interface-declaration have shown a similar
      // sub-pixel text/cursor rendering flake in the editor pane on VS Code
      // 1.90.0 (PR #376) — same nature as inverterNotExpression above, just
      // smaller diffs.
      muxTernaryAssign: 20,
      interfaceDeclaration: 250,
    },
  },
  pixelmatch: {
    bdd: 35,
    cli: 20,
    threshold: 0.05,
  },
} as const;

// toHaveScreenshot() doesn't set a threshold, so it runs with Playwright's own
// default. The gate below re-derives numDiffPixels via pixelmatch directly, so
// it must match that default to reject at the same sensitivity as the live test.
const PLAYWRIGHT_DEFAULT_PIXELMATCH_THRESHOLD = 0.2;

export type SnapshotSuite = 'visual' | 'bdd' | 'system';

export interface BaselineThreshold {
  suite: SnapshotSuite;
  maxDiffPixels: number;
  pixelmatchThreshold: number;
}

function isPlaywrightSnapshotNamed(filePath: string, snapshotName: string): boolean {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  return fileName === `${snapshotName}.png` || fileName.startsWith(`${snapshotName}-`);
}

// Per-screenshot maxDiffPixels overrides for BDD pixelmatch baselines, keyed
// by snapshot name (basename without .png). Scoped to individual screenshots
// only — never exempt a whole scenario or skip comparison outright (issue
// #302: a whole-scenario skip let a stale minimap baseline ship undetected).
const bddPixelmatchOverrides: Record<string, number> = {};

export function bddPixelmatchMaxDiffPixels(snapshotName: string): number {
  return bddPixelmatchOverrides[snapshotName] ?? SNAPSHOT_THRESHOLDS.pixelmatch.bdd;
}

export function baselineThresholdFor(filePath: string): BaselineThreshold | undefined {
  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalizedPath.endsWith('.png')) return undefined;

  if (normalizedPath.startsWith('test/visual/__screenshots__/')) {
    let maxDiffPixels: number = SNAPSHOT_THRESHOLDS.playwright.visual.default;
    if (
      normalizedPath.includes('/mux.visual.spec.ts-snapshots/') &&
      isPlaywrightSnapshotNamed(normalizedPath, 'mux-long-names-webview')
    ) {
      maxDiffPixels = SNAPSHOT_THRESHOLDS.playwright.visual.muxLongNames;
    } else if (
      normalizedPath.includes('/nested_case.visual.spec.ts-snapshots/') &&
      isPlaywrightSnapshotNamed(normalizedPath, 'nested-case-literal-collision-canvas')
    ) {
      maxDiffPixels = SNAPSHOT_THRESHOLDS.playwright.visual.nestedCaseLiteralCollision;
    }
    return {
      suite: 'visual',
      maxDiffPixels,
      pixelmatchThreshold: PLAYWRIGHT_DEFAULT_PIXELMATCH_THRESHOLD,
    };
  }

  if (normalizedPath.startsWith('test/features/snapshots/')) {
    const snapshotName = normalizedPath
      .slice(normalizedPath.lastIndexOf('/') + 1)
      .replace(/\.png$/, '');
    return {
      suite: 'bdd',
      maxDiffPixels: normalizedPath.endsWith('--cli-png.png')
        ? SNAPSHOT_THRESHOLDS.pixelmatch.cli
        : bddPixelmatchMaxDiffPixels(snapshotName),
      pixelmatchThreshold: SNAPSHOT_THRESHOLDS.pixelmatch.threshold,
    };
  }

  if (normalizedPath.startsWith('test/system/__screenshots__/')) {
    let maxDiffPixels: number = SNAPSHOT_THRESHOLDS.playwright.system.default;
    if (
      normalizedPath.includes('/sourceSelectionHighlight.spec.ts-snapshots/') &&
      isPlaywrightSnapshotNamed(normalizedPath, 'inverter-not-expression')
    ) {
      maxDiffPixels = SNAPSHOT_THRESHOLDS.playwright.system.inverterNotExpression;
    }
    return {
      suite: 'system',
      maxDiffPixels,
      pixelmatchThreshold: PLAYWRIGHT_DEFAULT_PIXELMATCH_THRESHOLD,
    };
  }

  return undefined;
}

// Mirrors playwright.config.ts's outputDir: BDD's TMPDIR is set to a larger
// volume in CI to dodge v9fs ENOSPC on the checked-out workspace (see #275).
// Snapshot-mismatch diff images are debug-only output written directly by
// step code (not through Playwright's outputDir), so without this they'd
// still land on the small workspace volume; nesting them under the
// already-redirected results dir means the existing CI copy step picks them
// up for free.
export function bddVisualDiffsDir(): string {
  return path.join(
    os.tmpdir(),
    `bdd-playwright-results-${path.basename(process.cwd())}`,
    'visual-diffs',
  );
}

// UPDATE_SNAPSHOTS is the update switch used by the custom comparators. Keep
// Playwright in equivalent compare-first mode when that switch is used.
export function configuredPlaywrightUpdateMode(): 'changed' | 'missing' {
  return process.env.UPDATE_SNAPSHOTS ? 'changed' : 'missing';
}

export function assertSafeSnapshotUpdateMode(config: FullConfig): void {
  if (config.updateSnapshots === 'all') {
    throw new Error(
      'Snapshot update mode "all" rewrites passing baselines. ' +
        'Use --update-snapshots=changed instead.',
    );
  }
}
