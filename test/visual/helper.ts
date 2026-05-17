import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import { diagramNodeDimensions } from '../../src/diagram/nodeSizing';
import type { DesignGraph, DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';

const fixtureRoot = path.resolve(__dirname, 'fixtures');

export type VisualLayoutMode = 'auto' | 'manual' | 'bus' | 'struct' | 'interface' | 'register' | 'comb' | 'alu';

export async function openFixture(page: Page, fixtureName: string, layoutMode: VisualLayoutMode = 'auto', moduleName?: string): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);

  await openView(page, view);
  const readySelector = layoutMode === 'bus'
    ? '[data-node-kind="bus"]'
    : layoutMode === 'struct'
      ? '[data-node-kind="struct"]'
      : layoutMode === 'interface'
        ? '[data-node-kind="interface"], .react-flow__node'
        : layoutMode === 'register'
          ? '[data-node-kind="register"]'
          : layoutMode === 'comb'
            ? '[data-node-kind="comb"]'
            : layoutMode === 'alu'
              ? '[data-node-kind="alu"]'
              : '.react-flow__node';
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
          : layoutMode === 'interface'
            ? createInterfaceVisualLayout(graph, moduleName)
            : layoutMode === 'register'
              ? createRegisterVisualLayout(graph, moduleName)
              : layoutMode === 'comb'
                ? createCombVisualLayout(graph, moduleName)
                : layoutMode === 'alu'
                  ? createAluVisualLayout(graph, moduleName)
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

function createInterfaceVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const interfaces = designModule.nodes.filter((node) => node.kind === 'interface');
  const inputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const instances = designModule.nodes.filter((node) => node.kind === 'instance');
  const combs = designModule.nodes.filter((node) => node.kind === 'comb');
  const nodes: Record<string, { x: number; y: number; fixed?: boolean }> = {};
  const grid = 24;
  const ifaceX = grid * 12;
  const ifaceY = grid * 5;
  const fixed = (x: number, y: number) => ({ x, y, fixed: true });
  const interfacePortNodes = interfaces.filter((node) => node.metadata?.role === 'port');
  const interfaceModportNodes = interfaces.filter((node) => node.metadata?.role === 'modport');

  if (moduleName.startsWith('interface ') && interfaces.length > 1) {
    return { version: 1, modules: {} };
  }

  if (interfacePortNodes.length > 0 && interfaceModportNodes.length > 0) {
    interfacePortNodes.forEach((node, index) => {
      const modport = interfaceModportNodes[index] ?? interfaceModportNodes[0];
      const modportHeight = modport ? diagramNodeDimensions(modport).height : grid * 4;
      const portHeight = diagramNodeDimensions(node).height;
      nodes[node.id] = fixed(ifaceX - grid * 8, ifaceY + grid * index * 10 + modportHeight / 2 - portHeight / 2);
    });
    interfaceModportNodes.forEach((node, index) => {
      nodes[node.id] = fixed(ifaceX, ifaceY + grid * index * 10);
    });

    combs.forEach((node, index) => {
      nodes[node.id] = fixed(ifaceX + grid * 12, ifaceY + grid * (index * 4 + 1));
    });

    outputPorts.forEach((node, index) => {
      nodes[node.id] = fixed(ifaceX + grid * 24, ifaceY + grid * (index * 4 + 1.5));
    });

    inputPorts.forEach((node, index) => {
      nodes[node.id] = fixed(ifaceX - grid * 15, ifaceY + grid * index * 2);
    });

    return {
      version: 1,
      modules: {
        [moduleName]: { nodes }
      }
    };
  }

  interfaces.forEach((node, index) => {
    nodes[node.id] = fixed(ifaceX, ifaceY + grid * index * 11);
  });

  inputPorts.forEach((node, index) => {
    const interfaceClockEdge = designModule.edges.find((edge) => (
      edge.source === node.id
      && interfaces.some((iface) => iface.id === edge.target)
      && !String(edge.targetPort ?? '').includes('master')
      && !String(edge.targetPort ?? '').includes('slave')
    ));
    const targetInterface = interfaces.find((iface) => iface.id === interfaceClockEdge?.target);
    if (targetInterface) {
      const ifacePosition = nodes[targetInterface.id] ?? { x: ifaceX, y: ifaceY };
      const ifaceSize = diagramNodeDimensions(targetInterface);
      const portSize = diagramNodeDimensions(node);
      nodes[node.id] = fixed(
        ifacePosition.x + ifaceSize.width / 2 - portSize.width - grid,
        ifacePosition.y - grid * 2.5
      );
      return;
    }

    nodes[node.id] = fixed(ifaceX - grid * 10, ifaceY + grid * index * 2);
  });

  let leftInstanceRow = 0;
  let rightInstanceRow = 0;
  instances.forEach((node, index) => {
    const interfacePort = node.ports.find((port) => port.width === 'interface' || port.typeName?.endsWith('_if') || port.typeName?.endsWith('if'));
    const goesLeft = interfacePort?.preferredSide === 'left' || interfacePort?.direction === 'output';
    if (goesLeft) {
      nodes[node.id] = fixed(ifaceX - grid * 12, ifaceY + grid * leftInstanceRow * 6);
      leftInstanceRow += 1;
    } else if (interfacePort) {
      nodes[node.id] = fixed(ifaceX + grid * 13, ifaceY + grid * rightInstanceRow * 6);
      rightInstanceRow += 1;
    } else {
      nodes[node.id] = fixed(ifaceX + grid * 11, ifaceY + grid * index * 5);
    }
  });

  combs.forEach((node, index) => {
    nodes[node.id] = fixed(ifaceX + grid * 10, ifaceY + grid * (interfaces.length * 6 + index * 3));
  });

  outputPorts.forEach((node, index) => {
    nodes[node.id] = fixed(ifaceX + grid * 27, ifaceY + grid * (1.5 + index * 2));
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

function createAluVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const alus = designModule.nodes.filter((node) => node.kind === 'alu');
  const inputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'input');
  const outputPorts = designModule.nodes.filter((node) => node.kind === 'port' && node.ports[0]?.direction === 'output');
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const aluX = grid * 10;
  const aluY = grid * 4;

  alus.forEach((node, index) => {
    nodes[node.id] = { x: aluX + grid * index * 7, y: aluY + grid * index };
  });

  inputPorts.forEach((node, index) => {
    nodes[node.id] = { x: aluX - grid * 8, y: aluY + grid * index * 2 };
  });

  outputPorts.forEach((node, index) => {
    nodes[node.id] = { x: aluX + grid * (alus.length > 1 ? 17 : 10), y: aluY + grid * index * 2 };
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
