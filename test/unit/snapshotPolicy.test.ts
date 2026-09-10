import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { compareGraphState, compareSvgSnapshot, type GraphState } from '../graphRegression';
import { comparePngBuffers } from '../pngSnapshotComparison';
import {
  assertSafeSnapshotUpdateMode,
  baselineThresholdFor,
  SNAPSHOT_THRESHOLDS,
} from '../snapshotPolicy';

describe('snapshot update policy', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-snapshot-policy-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps each baseline mechanism and per-test override to its effective threshold', () => {
    expect(
      baselineThresholdFor(
        'test/visual/__screenshots__/mux.visual.spec.ts-snapshots/' +
          'mux-long-names-webview-chromium-linux.png',
      )?.maxDiffPixels,
    ).toBe(2);
    expect(
      baselineThresholdFor(
        'test/visual/__screenshots__/nested_case.visual.spec.ts-snapshots/' +
          'nested-case-literal-collision-canvas-chromium-linux.png',
      )?.maxDiffPixels,
    ).toBe(120);
    expect(
      baselineThresholdFor(
        'test/visual/__screenshots__/generate_regions.visual.spec.ts-snapshots/' +
          'generate-region-resize-left-chromium-linux.png',
      )?.maxDiffPixels,
    ).toBe(20);
    expect(
      baselineThresholdFor(
        'test/visual/__screenshots__/generate_regions.visual.spec.ts-snapshots/' +
          'generate-region-selected-canvas-chromium-linux.png',
      )?.maxDiffPixels,
    ).toBe(20);
    expect(baselineThresholdFor('test/features/snapshots/example.png')?.maxDiffPixels).toBe(35);
    expect(
      baselineThresholdFor('test/features/snapshots/example--cli-png.png')?.maxDiffPixels,
    ).toBe(20);
    expect(
      baselineThresholdFor(
        'test/system/__screenshots__/1.91.0/diagram.spec.ts-snapshots/full-window-linux.png',
      )?.maxDiffPixels,
    ).toBe(20);
    expect(
      baselineThresholdFor(
        'test/system/__screenshots__/1.91.0/diagram.spec.ts-snapshots/' +
          'cut-out-block-move-carries-its-selected-stubs-linux.png',
      )?.maxDiffPixels,
    ).toBe(500);
    expect(
      baselineThresholdFor(
        'test/system/__screenshots__/1.91.0/partial_diagram_interactions.spec.ts-snapshots/' +
          'partial-diagram-interaction-auto-layout-visibility-01-single-selected-linux.png',
      )?.maxDiffPixels,
    ).toBe(6000);
  });

  it('rejects Playwright all mode', () => {
    expect(() => assertSafeSnapshotUpdateMode({ updateSnapshots: 'all' } as any)).toThrow(
      /changed/,
    );
    expect(() => assertSafeSnapshotUpdateMode({ updateSnapshots: 'changed' } as any)).not.toThrow();
  });

  it('treats a diff equal to the pixel budget as passing', () => {
    const expected = pngBuffer(1, 1, [0, 0, 0, 255]);
    const actual = pngBuffer(1, 1, [255, 255, 255, 255]);
    const comparison = comparePngBuffers(
      expected,
      actual,
      1,
      SNAPSHOT_THRESHOLDS.pixelmatch.threshold,
    );
    expect(comparison.numDiffPixels).toBe(1);
    expect(comparison.matches).toBe(true);
    expect(
      comparePngBuffers(expected, actual, 0, SNAPSHOT_THRESHOLDS.pixelmatch.threshold).matches,
    ).toBe(false);
  });

  it('does not rewrite an equivalent graph baseline in update mode', () => {
    const snapshotPath = path.join(tempDir, 'graph.json');
    const original = '{"nodes":[],"edges":[]}\n';
    fs.writeFileSync(snapshotPath, original);

    compareGraphState(emptyGraph(), 'graph', tempDir, tempDir, true);

    expect(fs.readFileSync(snapshotPath, 'utf8')).toBe(original);
  });

  it('updates a graph baseline when exact comparison fails', () => {
    const snapshotPath = path.join(tempDir, 'graph.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(emptyGraph(), null, 2));
    const changed: GraphState = {
      nodes: [{ id: 'a', position: { x: 0, y: 0 }, width: 10, height: 10 }],
      edges: [],
    };

    compareGraphState(changed, 'graph', tempDir, tempDir, true);

    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).toEqual(changed);
  });

  it('does not touch an equal SVG baseline in update mode', () => {
    const snapshotPath = path.join(tempDir, 'graph.svg');
    const oldTime = new Date('2000-01-01T00:00:00Z');
    fs.writeFileSync(snapshotPath, '<svg/>');
    fs.utimesSync(snapshotPath, oldTime, oldTime);

    compareSvgSnapshot('<svg/>', 'graph', tempDir, tempDir, true);

    expect(fs.statSync(snapshotPath).mtimeMs).toBe(oldTime.getTime());
  });
});

function emptyGraph(): GraphState {
  return { nodes: [], edges: [] };
}

function pngBuffer(
  width: number,
  height: number,
  firstPixel: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([0, 0, 0, 255], offset);
  }
  png.data.set(firstPixel, 0);
  return PNG.sync.write(png);
}
