import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
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

    await expect(page).toHaveScreenshot('mux-long-names-webview.png', {
      fullPage: true,
      maxDiffPixels: 1
    });
  });
});

test.describe('register visual rendering', () => {
  test('renders a register with recovered clock and reset ports', async ({ page }) => {
    await openFixture(page, 'register_async_reset.sv', 'register');

    await expect(page).toHaveScreenshot('register-async-reset-node.png', { clip: await paddedLocatorClip(page, '[data-node-kind="register"]') });
  });

  test('renders a register with active-low reset bar', async ({ page }) => {
    await openFixture(page, 'register_active_low_reset.sv', 'register');

    await expect(page).toHaveScreenshot('register-active-low-reset-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-kind="register"]'),
      maxDiffPixels: 50
    });
  });

  test('renders a register without reset', async ({ page }) => {
    await openFixture(page, 'register_no_reset.sv', 'register');

    await expect(page).toHaveScreenshot('register-no-reset-node.png', { clip: await paddedLocatorClip(page, '[data-node-kind="register"]') });
  });
});

test.describe('bus visual rendering', () => {
  test('renders a bus with one breakout', async ({ page }) => {
    const view = await openFixture(page, 'bus_one_tap.sv', 'bus');

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }

    await expect(page).toHaveScreenshot('bus-one-tap-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders a bus with two breakouts', async ({ page }) => {
    const view = await openFixture(page, 'bus_two_taps.sv', 'bus');

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }

    await expect(page).toHaveScreenshot('bus-two-taps-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders a bus with three overlapping breakouts', async ({ page }) => {
    const view = await openFixture(page, 'bus_three_taps.sv', 'bus');

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }

    await expect(page).toHaveScreenshot('bus-three-taps-canvas.png', {
      clip: await paddedGraphClip(page),
      maxDiffPixels: 169
    });
  });
});

test.describe('comb visual rendering', () => {
  test('renders connected combinational ports with flat orthogonal connectors', async ({ page }) => {
    const view = await openFixture(page, 'comb_connected.sv', 'comb');

    await expect(page).toHaveScreenshot('comb-connected-canvas.png', { clip: await paddedGraphClip(page) });

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }
  });
});

test.describe('module switching', () => {
  test('removes stale edge paths when switching to a smaller diagram', async ({ page }) => {
    const busView = await buildFixtureView('bus_slices.sv', 'bus');
    const assignView = await buildFixtureView('comb_assigns.sv', 'auto', 'assign_wire');

    await page.goto('/');
    await installStableTheme(page);

    await postView(page, busView);
    await page.waitForSelector('[data-node-kind="bus"]');
    await waitForViewportTransformToSettle(page);
    await expect(page.locator('.svsch-edge')).toHaveCount(busView.edges.length);

    await postView(page, assignView);
    await page.waitForFunction(() => document.querySelectorAll('[data-node-kind="bus"]').length === 0);
    await waitForViewportTransformToSettle(page);
    await expect(page.locator('.svsch-edge')).toHaveCount(assignView.edges.length);
  });
});

test.describe('node sizing visual rendering', () => {
  test('renders a single-output comb at compact minimum height', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await openView(page, createNodeSizingGalleryView(false));
    const height = await page.locator('[data-node-id="comb"]').evaluate((element) => getComputedStyle(element).height);
    const style = await page.locator('[data-node-id="comb"]').evaluate((element) => element.getAttribute('style'));
    const kind = await page.locator('[data-node-id="comb"]').evaluate((element) => element.getAttribute('data-node-kind'));

    expect(kind).toBe('comb');
    expect(style).toContain('--svsch-node-height: 72px');
    expect(height).toBe('72px');
  });

  test('renders every current node kind at its default width', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await openView(page, createNodeSizingGalleryView(false));
    await page.waitForSelector('[data-node-id="unknown"]');
    await waitForViewportTransformToSettle(page);

    await expect(page).toHaveScreenshot('node-sizing-defaults-canvas.png', { clip: await paddedGraphClip(page) });
  });

  test('renders every current node kind widened for long labels', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await openView(page, createNodeSizingGalleryView(true));
    await page.waitForSelector('[data-node-id="unknown"]');
    await waitForViewportTransformToSettle(page);

    await expect(page).toHaveScreenshot('node-sizing-extended-canvas.png', { clip: await paddedGraphClip(page) });
  });
});

type VisualLayoutMode = 'auto' | 'manual' | 'bus' | 'register' | 'comb';

async function openFixture(page: Page, fixtureName: string, layoutMode: VisualLayoutMode = 'auto', moduleName?: string): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);

  await openView(page, view);
  const readySelector = layoutMode === 'bus'
    ? '[data-node-kind="bus"]'
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

async function openView(page: Page, view: DiagramViewModel): Promise<void> {
  await page.goto('/');
  await installStableTheme(page);
  await postView(page, view);
}

async function postView(page: Page, view: DiagramViewModel): Promise<void> {
  await page.evaluate((fixtureView) => {
    window.postMessage({
      type: 'graph',
      view: fixtureView,
      modules: [fixtureView.moduleName]
    }, '*');
  }, view);
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

async function buildFixtureView(fixtureName: string, layoutMode: VisualLayoutMode, requestedModuleName?: string): Promise<DiagramViewModel> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const text = fs.readFileSync(fixturePath, 'utf8');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-visual-'));
  try {
    const tmpFile = path.join(tmpDir, path.basename(fixtureName));
    fs.writeFileSync(tmpFile, text);

    const surelogPath = '/home/dev/.local/lib/python3.10/site-packages/surelog/bin/surelog';
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

function createNodeSizingGalleryView(extended: boolean): DiagramViewModel {
  const long = 'wide_label_growth';
  const label = (shortLabel: string) => extended ? `${shortLabel}_${long}` : shortLabel;
  const width = extended ? '[255:0]' : undefined;
  const grid = 24;
  const secondColumnX = grid * (extended ? 24 : 12);
  const nodes: DiagramViewModel['nodes'] = [
    {
      id: 'port:in',
      kind: 'port',
      label: label('a'),
      ports: [{ id: 'p', name: label('a'), direction: 'input', width }],
      position: { x: 0, y: 0 }
    },
    {
      id: 'port:out',
      kind: 'port',
      label: label('y'),
      ports: [{ id: 'p', name: label('y'), direction: 'output', width }],
      position: { x: secondColumnX, y: 0 }
    },
    {
      id: 'mux',
      kind: 'mux',
      label: 'case sel',
      ports: [
        { id: 'sel', name: 'sel', direction: 'input' },
        { id: 'i0', name: 'i0', label: extended ? long : "1'b0", direction: 'input', width },
        { id: 'i1', name: 'i1', label: extended ? `default_${long}` : 'default', direction: 'input' },
        { id: 'y', name: extended ? long : 'y', direction: 'output' }
      ],
      position: { x: 0, y: grid * 4 }
    },
    {
      id: 'register',
      kind: 'register',
      label: label('q'),
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'clk', name: 'clk', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' }
      ],
      metadata: width ? { width } : undefined,
      position: { x: secondColumnX, y: grid * 4 }
    },
    {
      id: 'comb',
      kind: 'comb',
      label: label('comb'),
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('decoded'), direction: 'output', width }
      ],
      position: { x: 0, y: grid * 9 }
    },
    {
      id: 'bus',
      kind: 'bus',
      label: label('instr'),
      ports: [
        { id: 'in', name: 'instr', direction: 'input', width: '[31:0]' },
        { id: 'tap', name: extended ? long : '[14:12]', label: extended ? long : '[14:12]', direction: 'output' }
      ],
      position: { x: secondColumnX, y: grid * 9 }
    },
    {
      id: 'instance',
      kind: 'instance',
      label: label('u_child'),
      instanceOf: label('child_sink'),
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('y'), direction: 'output', width }
      ],
      position: { x: 0, y: grid * 15 }
    },
    {
      id: 'module',
      kind: 'module',
      label: label('submodule'),
      moduleName: 'submodule',
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('y'), direction: 'output', width }
      ],
      position: { x: extended ? 0 : secondColumnX, y: grid * (extended ? 19 : 15) }
    },
    {
      id: 'unknown',
      kind: 'unknown',
      label: label('unsupported'),
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('y'), direction: 'output', width }
      ],
      position: { x: 0, y: grid * (extended ? 23 : 20) }
    }
  ];

  return {
    moduleName: extended ? 'node_sizing_extended' : 'node_sizing_defaults',
    nodes,
    edges: [],
    diagnostics: []
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
