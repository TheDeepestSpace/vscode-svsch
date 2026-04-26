import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { extractDesignFromText } from '../../src/parser/textExtractor';
import type { DesignGraph, DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';

const fixtureRoot = path.resolve(__dirname, 'fixtures');

test.describe('mux visual rendering', () => {
  test('renders a mux node interpreted from SystemVerilog', async ({ page }) => {
    await openFixture(page, 'mux_only.sv', 'manual');

    await expect(page).toHaveScreenshot('mux-node.png', { clip: await paddedLocatorClip(page, '[data-node-kind="mux"]') });
  });

  test('renders a connected mux canvas interpreted from SystemVerilog', async ({ page }) => {
    await openFixture(page, 'mux_wired.sv');

    await expect(page).toHaveScreenshot('mux-wired-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders muxes with different input counts', async ({ page }) => {
    await openFixture(page, 'mux_three_inputs.sv');

    await expect(page).toHaveScreenshot('mux-three-inputs-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders long mux signal names in the full webview', async ({ page }) => {
    await openFixture(page, 'mux_long_names.sv');

    await expect(page).toHaveScreenshot('mux-long-names-webview.png', { fullPage: true });
  });
});

type VisualLayoutMode = 'auto' | 'manual';

async function openFixture(page: Page, fixtureName: string, layoutMode: VisualLayoutMode = 'auto'): Promise<void> {
  const view = await buildFixtureView(fixtureName, layoutMode);

  await page.goto('/');
  await installStableTheme(page);
  await page.evaluate((fixtureView) => {
    window.postMessage({
      type: 'graph',
      view: fixtureView,
      modules: [fixtureView.moduleName]
    }, '*');
  }, view);
  await page.waitForSelector('[data-node-kind="mux"]');
  await stabilizeReactFlowViewport(page);
  await page.waitForTimeout(250);
}

async function paddedLocatorClip(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const padding = 24;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`Unable to find screenshot target: ${selector}`);
  }
  return paddedClipFromBox(page, box, padding);
}

async function paddedGraphClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const padding = 48;
  const box = await page.locator('.react-flow__nodes').boundingBox();
  if (!box) {
    throw new Error('Unable to find rendered graph nodes');
  }
  return paddedClipFromBox(page, box, padding);
}

function paddedClipFromBox(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  padding: number
): { x: number; y: number; width: number; height: number } {
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

async function stabilizeReactFlowViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const padding = 48;
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    const nodes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => {
      const match = node.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      const x = match ? Number(match[1]) : 0;
      const y = match ? Number(match[2]) : 0;
      return {
        x,
        y,
        width: node.offsetWidth,
        height: node.offsetHeight
      };
    });

    if (viewport && nodes.length > 0) {
      const minX = Math.min(...nodes.map((node) => node.x));
      const minY = Math.min(...nodes.map((node) => node.y));
      viewport.style.transform = `translate(${padding - minX}px, ${padding - minY}px) scale(1)`;
    }
  });
}

async function buildFixtureView(fixtureName: string, layoutMode: VisualLayoutMode): Promise<DiagramViewModel> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const text = fs.readFileSync(fixturePath, 'utf8');
  const graph = extractDesignFromText([{ file: fixtureName, text }]);
  const moduleName = graph.rootModules[0];
  const layout = layoutMode === 'manual' ? createVisualLayout(graph, moduleName) : { version: 1, modules: {} };

  return buildViewModel(graph, moduleName, layout);
}

function createVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const mux = designModule.nodes.find((node) => node.kind === 'mux');
  const muxSelector = mux?.ports.find((port) => port.direction === 'input')?.name;
  const inputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const muxX = grid * 15;
  const muxY = grid * 8;

  for (const node of inputPorts) {
    if (node.label === muxSelector) {
      nodes[node.id] = { x: muxX - grid * 6, y: muxY - grid * 5 };
    }
  }

  let inputRow = 0;
  for (const node of inputPorts) {
    if (node.label === muxSelector) {
      continue;
    }
    nodes[node.id] = { x: muxX - grid * 8, y: muxY + grid * (inputRow + 2) };
    inputRow += 2;
  }

  if (mux) {
    nodes[mux.id] = { x: muxX, y: muxY };
  }

  for (const node of outputPorts) {
    nodes[node.id] = { x: muxX + grid * 9, y: muxY + grid * 2 };
  }

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes }
    }
  };
}

async function installStableTheme(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      :root {
        --vscode-editor-background: #000000;
        --vscode-editor-foreground: #d6d6d6;
        --vscode-font-family: Arial, sans-serif;
        --vscode-editorWidget-background: #000000;
        --vscode-panel-border: #303030;
        --vscode-dropdown-background: #11161c;
        --vscode-dropdown-border: #30363d;
        --vscode-dropdown-foreground: #d6d6d6;
        --vscode-button-background: #161b22;
        --vscode-button-foreground: #d6d6d6;
        --vscode-descriptionForeground: #9da3ad;
        --vscode-focusBorder: #1495e7;
        --vscode-charts-blue: #3794ff;
        --vscode-charts-green: #89d185;
        --vscode-charts-purple: #c586f6;
        --vscode-charts-red: #f14c4c;
        --vscode-charts-yellow: #d7ba00;
        --vscode-charts-orange: #d18616;
        --vscode-inputValidation-warningBackground: #211f00;
        --vscode-inputValidation-warningBorder: #d7ba00;
      }

      *, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
      }
    `
  });
}
