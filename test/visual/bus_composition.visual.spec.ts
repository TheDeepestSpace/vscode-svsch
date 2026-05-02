import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import type { DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';

const fixtureRoot = path.resolve(__dirname, 'fixtures');

test.describe('Bus Composition Visual Rendering', () => {
  test('renders a bus composition node for multiple slice assignments', async ({ page }) => {
    await openFixture(page, 'bus_composition.sv', 'auto');

    // Verify 3 register nodes
    await expect(page.locator('.hdl-node-register')).toHaveCount(3);
    await expect(page.locator('.hdl-node-register >> text=r[0]')).toBeVisible();
    await expect(page.locator('.hdl-node-register >> text=r[1]')).toBeVisible();
    await expect(page.locator('.hdl-node-register >> text=r[3:2]')).toBeVisible();

    // Verify specifically for bus composition node
    const busCompNode = page.locator('.hdl-bus-composition');
    await expect(busCompNode).toBeVisible();

    // Verify it has 3 input taps
    await expect(busCompNode.locator('.bus-tap')).toHaveCount(3);
    
    // Verify output port node for 'r' is present
    await expect(page.locator('[data-node-kind="port"] >> text=r')).toBeVisible();

    // Verify edges are drawn (via raw state)
    const edgeCount = await page.evaluate(() => (window as any).reactFlowInstance.getEdges().length);
    // 4 inputs to registers, 3 registers to bus comp, 1 bus comp to output = 8 edges
    expect(edgeCount).toBeGreaterThanOrEqual(8);

    await expect(page).toHaveScreenshot('bus-composition-canvas.png', { clip: await paddedGraphClip(page) });
  });
});

async function openFixture(page: Page, fixtureName: string, layoutMode: 'auto' = 'auto', moduleName?: string): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);

  await page.goto('/');
  // Wait a bit for React to initialize and add the event listener
  await page.waitForTimeout(500);
  
  await page.evaluate((fixtureView) => {
    window.postMessage({
      type: 'graph',
      view: fixtureView,
      modules: [fixtureView.moduleName]
    }, '*');
  }, view);

  await page.waitForSelector('.react-flow__node');
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
  return view;
}

async function buildFixtureView(fixtureName: string, layoutMode: string, requestedModuleName?: string): Promise<DiagramViewModel> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const text = fs.readFileSync(fixturePath, 'utf8');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-visual-'));
  try {
    const tmpFile = path.join(tmpDir, path.basename(fixtureName));
    fs.writeFileSync(tmpFile, text);

    const surelogPath = process.env.SVSCH_SURELOG_PATH ?? path.resolve(__dirname, '../../dist/surelog/bin/surelog');
    const backendPath = path.resolve(__dirname, '../../dist/svsch_backend');

    const graph = await buildDesignGraph({
      workspaceRoot: tmpDir,projectFolder: '.',
      backend: 'uhdm',
      veriblePath: 'verible-verilog-syntax',
      surelogPath,
      backendPath,
      includeExternalDiagnostics: false
    });

    const moduleName = requestedModuleName ?? graph.rootModules[0];
    const layout = { version: 1, modules: {} } as SavedLayout;

    return buildViewModel(graph, moduleName, layout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function waitForViewportTransformToSettle(page: Page): Promise<void> {
  const viewport = page.locator('.react-flow__viewport');
  let previous = '';
  let stableReads = 0;

  for (let i = 0; i < 40; i += 1) {
    const current = await viewport.evaluate((el) => getComputedStyle(el).transform ?? '');
    if (current !== 'none' && current === previous) {
      stableReads += 1;
      if (stableReads >= 3) {
        return;
      }
    } else {
      stableReads = 0;
      previous = current;
    }
    await page.waitForTimeout(50);
  }
}

async function paddedGraphClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const padding = 48;
  const box = await page.locator('.react-flow__nodes').boundingBox();
  if (!box) {
    throw new Error('Unable to find rendered graph nodes');
  }
  const viewport = page.viewportSize() ?? { width: 900, height: 640 };
  const x = Math.max(0, Math.floor(box.x - padding));
  const y = Math.max(0, Math.floor(box.y - padding));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + padding));

  return { x, y, width: right - x, height: bottom - y };
}
