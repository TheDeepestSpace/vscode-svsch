import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import type { DesignGraph, DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';

const fixtureRoot = path.resolve(__dirname, 'fixtures');

export type VisualLayoutMode = 'auto' | 'manual' | 'bus' | 'struct' | 'register' | 'comb';

export async function openFixture(page: Page, fixtureName: string, layoutMode: VisualLayoutMode = 'auto', moduleName?: string): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);

  await openView(page, view);
  const readySelector = layoutMode === 'bus'
    ? '[data-node-kind="bus"]'
    : layoutMode === 'struct'
      ? '[data-node-kind="struct"]'
    : layoutMode === 'register'
      ? '[data-node-kind="register"]'
      : layoutMode === 'comb'
        ? '[data-node-kind="comb"]'
        : '[data-node-kind="mux"]';
  await page.waitForSelector(readySelector);
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
  return view;
}

export async function openView(page: Page, view: DiagramViewModel): Promise<void> {
  await page.goto('/');
  await installStableTheme(page);
  // Wait a bit for React to initialize and add the event listener
  await page.waitForTimeout(500);
  await postView(page, view);
}

export async function postView(page: Page, view: DiagramViewModel): Promise<void> {
  await page.evaluate((fixtureView) => {
    window.postMessage({
      type: 'graph',
      view: fixtureView,
      modules: [fixtureView.moduleName]
    }, '*');
  }, view);
}

export async function paddedLocatorClip(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const padding = 24;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`Unable to find screenshot target: ${selector}`);
  }
  return paddedClipFromBox(page, box, padding);
}

export async function paddedGraphClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const padding = 48;
  const box = await page.locator('.react-flow__nodes').boundingBox();
  if (!box) {
    throw new Error('Unable to find rendered graph nodes');
  }
  return paddedClipFromBox(page, box, padding);
}

export function paddedClipFromBox(
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

export async function waitForViewportTransformToSettle(page: Page): Promise<void> {
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

export async function buildFixtureView(fixtureName: string, layoutMode: VisualLayoutMode, requestedModuleName?: string): Promise<DiagramViewModel> {
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

    const moduleName = requestedModuleName ?? graph.rootModules[0];
    const layout = layoutMode === 'manual'
      ? createVisualLayout(graph, moduleName)
      : layoutMode === 'bus'
        ? createBusVisualLayout(graph, moduleName)
        : layoutMode === 'struct'
          ? createStructVisualLayout(graph, moduleName)
          : layoutMode === 'register'
            ? createRegisterVisualLayout(graph, moduleName)
            : layoutMode === 'comb'
              ? createCombVisualLayout(graph, moduleName)
              : { version: 1, modules: {} } as SavedLayout;

    return buildViewModel(graph, moduleName, layout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function createRegisterVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const registerNode = designModule.nodes.find((node) => node.kind === 'register');
  const inputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const regX = grid * 10;
  const regY = grid * 4;

  for (const port of inputPorts) {
    nodes[port.id] = { x: regX - grid * 8, y: regY + grid * inputPorts.indexOf(port) * 2 };
  }

  if (registerNode) {
    nodes[registerNode.id] = { x: regX, y: regY };
  }

  for (const port of outputPorts) {
    nodes[port.id] = { x: regX + grid * 10, y: regY };
  }

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes }
    }
  };
}

function createBusVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const bus = designModule.nodes.find((node) => node.kind === 'bus');
  const inputPort = designModule.nodes.find((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const busX = grid * 10;
  const busY = grid * 4;

  if (inputPort) {
    nodes[inputPort.id] = { x: busX - grid * 8, y: busY };
  }

  if (bus) {
    nodes[bus.id] = { x: busX, y: busY };
  }

  outputPorts.forEach((node, index) => {
    nodes[node.id] = { x: busX + grid * 10, y: busY + grid * index * 2 };
  });

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes }
    }
  };
}

function createStructVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const struct = designModule.nodes.find((node) => node.kind === 'struct');
  const inputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const registers = designModule.nodes.filter((node) => node.kind === 'register');
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const structX = grid * 12;
  const structY = grid * 4;

  inputPorts.forEach((node, index) => {
    nodes[node.id] = { x: structX - grid * 10, y: structY + grid * index * 2 };
  });

  registers.forEach((node, index) => {
    nodes[node.id] = { x: structX - grid * 8, y: structY + grid * index * 3 };
  });

  if (struct) {
    nodes[struct.id] = { x: structX, y: structY };
  }

  outputPorts.forEach((node, index) => {
    nodes[node.id] = { x: structX + grid * 11, y: structY + grid * index * 2 };
  });

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes }
    }
  };
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

function createCombVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const comb = designModule.nodes.find((node) => node.kind === 'comb');
  const inputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const combX = grid * 10;
  const combY = grid * 4;

  if (comb) {
    nodes[comb.id] = { x: combX, y: combY };
  }

  inputPorts.forEach((node, index) => {
    // Use grid multiples for proper alignment, matching register layout pattern.
    nodes[node.id] = { x: combX - grid * 8, y: combY + grid * index * 2 };
  });

  outputPorts.forEach((node, index) => {
    nodes[node.id] = { x: combX + grid * 10, y: combY + grid * index * 2 };
  });

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes }
    }
  };
}

export async function installStableTheme(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      :root {
        --vscode-editor-background: #000000;
        --vscode-editor-foreground: #d6d6d6;
        --vscode-font-family: Arial, sans-serif;
        --vscode-editorWidget-background: #000000;
        --vscode-panel-border: #303030;
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

      /* Disable transitions and animations for stable screenshots */
      *, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
      }
    `
  });
}
