import { expect, test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import type { DiagramViewModel } from '../../src/ir/types';
import { SavedLayout } from '../../src/storage/layoutStore';

const fixtureRoot = path.resolve(__dirname, 'fixtures');

test.describe('register RV port visual rendering', () => {
  test('renders an RV port for registers with non-zero reset values', async ({ page }) => {
    // This will fail initially because extractors don't support RV yet
    const view = await buildFixtureView('register_preset.sv', 'register');
    
    await page.goto('/');
    // Theme installation and other helpers would normally be here, 
    // but we'll use the ones from the main test file if we were in it.
    // For now, let's just try to open the view.
    
    await page.evaluate((fixtureView) => {
        window.postMessage({
          type: 'graph',
          view: fixtureView,
          modules: [fixtureView.moduleName]
        }, '*');
    }, view);

    await page.waitForSelector('[data-node-kind="register"]');
    
    // We expect an RV port to be visible
    const rvPort = page.locator('.register-port >> text=RV');
    await expect(rvPort).toBeVisible();

    // Check if there is an edge connected to RV
    const registerNode = view.nodes.find(n => n.kind === 'register');
    const rvEdge = view.edges.find(e => e.target === registerNode?.id && e.targetPort === 'rv');
    expect(rvEdge).toBeDefined();

    // Record screenshot
    await expect(page).toHaveScreenshot('register-rv-node.png', { 
        clip: await paddedLocatorClip(page, '[data-node-kind="register"]') 
    });
  });
});

async function paddedLocatorClip(page: any, selector: string) {
  const padding = 24;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`Unable to find screenshot target: ${selector}`);
  }
  const viewport = page.viewportSize() ?? { width: 900, height: 640 };
  const x = Math.max(0, Math.floor(box.x - padding));
  const y = Math.max(0, Math.floor(box.y - padding));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + padding));

  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

// Helper to build the view, similar to main visual spec
async function buildFixtureView(fixtureName: string, layoutMode: string): Promise<DiagramViewModel> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const text = fs.readFileSync(fixturePath, 'utf8');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-visual-'));
  try {
    const tmpFile = path.join(tmpDir, path.basename(fixtureName));
    fs.writeFileSync(tmpFile, text);

    const surelogPath = process.env.SVSCH_SURELOG_PATH ?? path.resolve(__dirname, '../../dist/surelog/bin/surelog');
    const backendPath = path.resolve(__dirname, '../../dist/svsch_backend');

    const graph = await buildDesignGraph({
      workspaceRoot: tmpDir,
      projectFolder: '.',
      backend: 'uhdm',
      veriblePath: 'verible-verilog-syntax',
      surelogPath,
      backendPath,
      includeExternalDiagnostics: false
    });

    const moduleName = graph.rootModules[0];
    const layout = { version: 1, modules: {} } as SavedLayout;

    return buildViewModel(graph, moduleName, layout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
