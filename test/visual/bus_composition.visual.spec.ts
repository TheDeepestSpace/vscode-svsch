import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expectGraphAndScreenshot, fixtureRoot, trackView, recordVisualBenchmark } from './helper';
import {
  buildViewModel,
  firstOpenAutoCutEdges,
  mergeFirstOpenNetCuts,
} from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import type { DesignGraph, DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';

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
    await expect(busCompNode.locator('.svsch-bus-tap')).toHaveCount(3);

    // Verify output port node for 'r' is present
    await expect(page.locator('[data-node-kind="port"] >> text=r')).toBeVisible();

    // Verify edges are drawn (via raw state)
    const edgeCount = await page.evaluate(
      () => (window as any).reactFlowInstance.getEdges().length,
    );
    // 4 inputs to registers, 3 registers to bus comp, 1 bus comp to output = 8 edges
    expect(edgeCount).toBeGreaterThanOrEqual(8);

    await expectGraphAndScreenshot(page, 'bus-composition-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders an always_comb array assignment pattern as stacked array composition', async ({
    page,
  }) => {
    const view = await openFixture(page, 'array_stack_composition_literal.sv', 'auto');
    const arrayComp = view.nodes.find(
      (node) => node.kind === 'bus' && node.metadata?.aggregateKind === 'array',
    );

    expect(arrayComp).toBeDefined();
    expect(
      arrayComp?.ports
        .filter((port) => port.direction === 'input')
        .map((port) => [port.label, port.connectedSignal, port.width]),
    ).toEqual([
      ['[3]', "8'hAB", '[7:0]'],
      ['[2]', "8'hCD", '[7:0]'],
      ['[1]', "8'hEF", '[7:0]'],
      ['[0]', "8'h00", '[7:0]'],
    ]);
    expect(
      view.edges.find(
        (edge) =>
          edge.source === arrayComp?.id &&
          edge.target === 'port:array_stack_composition_literal:arr',
      )?.isStacked,
    ).toBe(true);
    expect(view.edges.some((edge) => edge.target === arrayComp?.id && edge.isStacked)).toBe(false);

    const busCompNode = page.locator('.hdl-bus-array-composition');
    await expect(busCompNode).toBeVisible();
    await expect(busCompNode.locator('.svsch-bus-tap')).toHaveCount(4);
    await expect(busCompNode.locator('.svsch-bus-tap', { hasText: '[3]' })).toBeVisible();
    await expect(busCompNode.locator('.svsch-bus-tap', { hasText: '[3][]' })).toHaveCount(0);

    await expectGraphAndScreenshot(page, 'array-stack-composition-literal-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test(
    'renders an always_comb array assignment pattern as stacked array composition ' +
      '(single-bit)',
    async ({ page }) => {
      const view = await openFixture(page, 'array_stack_composition_literal_1bit.sv', 'auto');
      const arrayComp = view.nodes.find(
        (node) => node.kind === 'bus' && node.metadata?.aggregateKind === 'array',
      );

      expect(arrayComp).toBeDefined();
      expect(
        arrayComp?.ports
          .filter((port) => port.direction === 'input')
          .map((port) => [port.label, port.connectedSignal, port.width]),
      ).toEqual([
        ['[3]', "1'b1", '[0:0]'],
        ['[2]', "1'b0", '[0:0]'],
        ['[1]', "1'b1", '[0:0]'],
        ['[0]', "1'b0", '[0:0]'],
      ]);
      expect(
        view.edges.find(
          (edge) =>
            edge.source === arrayComp?.id &&
            edge.target === 'port:array_stack_composition_literal_1bit:arr',
        )?.isStacked,
      ).toBe(true);
      expect(view.edges.some((edge) => edge.target === arrayComp?.id && edge.isStacked)).toBe(
        false,
      );

      const busCompNode = page.locator('.hdl-bus-array-composition');
      await expect(busCompNode).toBeVisible();
      await expect(busCompNode.locator('.svsch-bus-tap')).toHaveCount(4);

      // Single-bit elements: neither the taps nor the stub feeding the output port
      // should pick up the thick-wire styling reserved for multi-bit connections.
      await expect(busCompNode.locator('.svsch-bus-tap-line-thick')).toHaveCount(0);
      await expect(
        page.locator(
          '.react-flow__edge[data-id*="array_stack_composition_literal_1bit:arr"] ' +
            '.svsch-edge-thick',
        ),
      ).toHaveCount(0);
      await expect(
        page.locator(
          '[data-node-id="port:array_stack_composition_literal_1bit:arr"] ' +
            '.svsch-array-stack-lead-thick',
        ),
      ).toHaveCount(0);

      await expectGraphAndScreenshot(page, 'array-stack-composition-literal-1bit-canvas.png', {
        clip: await paddedGraphClip(page),
      });
    },
  );

  test('renders per-element array assignments as stacked array composition', async ({ page }) => {
    const view = await openFixture(page, 'array_stack_composition_elements.sv', 'auto');
    const arrayComp = view.nodes.find(
      (node) => node.kind === 'bus' && node.metadata?.aggregateKind === 'array',
    );
    const alu = view.nodes.find(
      (node) => node.kind === 'alu' && node.metadata?.expression === "seed + 8'h01",
    );

    expect(arrayComp).toBeDefined();
    expect(alu).toBeDefined();
    expect(
      arrayComp?.ports
        .filter((port) => port.direction === 'input')
        .map((port) => [port.label, port.width]),
    ).toEqual([
      ['[3]', '[7:0]'],
      ['[2]', '[7:0]'],
      ['[1]', '[7:0]'],
      ['[0]', '[7:0]'],
    ]);
    expect(arrayComp?.ports.find((port) => port.label === '[2]')?.connectedSignal).toBe('seed');
    expect(arrayComp?.ports.find((port) => port.label === '[1]')?.connectedSignal).toBe(
      alu?.ports.find((port) => port.direction === 'output')?.connectedSignal,
    );
    expect(
      view.edges.find(
        (edge) =>
          edge.source === arrayComp?.id &&
          edge.target === 'port:array_stack_composition_elements:arr',
      )?.isStacked,
    ).toBe(true);
    expect(
      view.edges.some(
        (edge) =>
          edge.target === arrayComp?.id &&
          edge.source === 'port:array_stack_composition_elements:seed' &&
          edge.isStacked,
      ),
    ).toBe(false);

    const busCompNode = page.locator('.hdl-bus-array-composition');
    await expect(busCompNode).toBeVisible();
    await expect(busCompNode.locator('.svsch-bus-tap')).toHaveCount(4);

    await expectGraphAndScreenshot(page, 'array-stack-composition-elements-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders per-element array assignments as stacked array composition (single-bit)', async ({
    page,
  }) => {
    const view = await openFixture(page, 'array_stack_composition_elements_1bit.sv', 'auto');
    const arrayComp = view.nodes.find(
      (node) => node.kind === 'bus' && node.metadata?.aggregateKind === 'array',
    );
    const inverter = view.nodes.find((node) => node.kind === 'inverter');

    expect(arrayComp).toBeDefined();
    expect(inverter).toBeDefined();
    expect(
      arrayComp?.ports
        .filter((port) => port.direction === 'input')
        .map((port) => [port.label, port.width]),
    ).toEqual([
      ['[3]', '[0:0]'],
      ['[2]', '[0:0]'],
      ['[1]', '[0:0]'],
      ['[0]', '[0:0]'],
    ]);
    expect(arrayComp?.ports.find((port) => port.label === '[2]')?.connectedSignal).toBe('seed');
    expect(arrayComp?.ports.find((port) => port.label === '[1]')?.connectedSignal).toBe(
      inverter?.ports.find((port) => port.direction === 'output')?.connectedSignal,
    );
    expect(
      view.edges.find(
        (edge) =>
          edge.source === arrayComp?.id &&
          edge.target === 'port:array_stack_composition_elements_1bit:arr',
      )?.isStacked,
    ).toBe(true);
    expect(
      view.edges.some(
        (edge) =>
          edge.target === arrayComp?.id &&
          edge.source === 'port:array_stack_composition_elements_1bit:seed' &&
          edge.isStacked,
      ),
    ).toBe(false);

    const busCompNode = page.locator('.hdl-bus-array-composition');
    await expect(busCompNode).toBeVisible();
    await expect(busCompNode.locator('.svsch-bus-tap')).toHaveCount(4);

    await expect(busCompNode.locator('.svsch-bus-tap-line-thick')).toHaveCount(0);
    await expect(
      page.locator(
        '.react-flow__edge[data-id*="array_stack_composition_elements_1bit:arr"] .svsch-edge-thick',
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(
        '[data-node-id="port:array_stack_composition_elements_1bit:arr"] ' +
          '.svsch-array-stack-lead-thick',
      ),
    ).toHaveCount(0);

    await expectGraphAndScreenshot(page, 'array-stack-composition-elements-1bit-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders array element accesses as stacked array breakouts', async ({ page }) => {
    // Force cpp backend for array breakouts since uhdm currently misses the aggregateKind tag
    const originalBackend = process.env.SVSCH_BACKEND;
    process.env.SVSCH_BACKEND = 'cpp';
    try {
      const view = await openFixture(page, 'array_stack_breakout.sv', 'auto');
      const arrayBreakout = view.nodes.find(
        (node) => node.kind === 'bus' && node.metadata?.aggregateKind === 'array',
      );

      expect(arrayBreakout).toBeDefined();
      expect(
        arrayBreakout?.ports
          .filter((port) => port.direction === 'output')
          .map((port) => port.label),
      ).toEqual(['[3]', '[2]', '[1]', '[0]']);

      const busBreakoutNode = page.locator('.hdl-bus-array-breakout');
      await expect(busBreakoutNode).toBeVisible();
      await expect(busBreakoutNode.locator('.svsch-bus-tap')).toHaveCount(4);
      await expect(busBreakoutNode.locator('.svsch-bus-tap-label')).toHaveText([
        '[3]',
        '[2]',
        '[1]',
        '[0]',
      ]);

      await expectGraphAndScreenshot(page, 'array-stack-breakout-canvas.png', {
        clip: await paddedGraphClip(page),
      });
    } finally {
      if (originalBackend === undefined) {
        delete process.env.SVSCH_BACKEND;
      } else {
        process.env.SVSCH_BACKEND = originalBackend;
      }
    }
  });

  test('renders array element accesses as stacked array breakouts (single-bit)', async ({
    page,
  }) => {
    // Force cpp backend for array breakouts since uhdm currently misses the aggregateKind tag
    const originalBackend = process.env.SVSCH_BACKEND;
    process.env.SVSCH_BACKEND = 'cpp';
    try {
      const view = await openFixture(page, 'array_stack_breakout_1bit.sv', 'auto');
      const arrayBreakout = view.nodes.find(
        (node) => node.kind === 'bus' && node.metadata?.aggregateKind === 'array',
      );

      expect(arrayBreakout).toBeDefined();
      // The aggregate "arr" input resolves as a genuine scalar (undefined width,
      // same as omitting a width suffix) now that the backend no longer reports
      // a spurious "[0:0]" for procedurally-resolved single-bit signals; the
      // per-element outputs still carry their own explicit [0:0] bit-select range.
      expect(arrayBreakout?.ports.map((port) => port.width)).toEqual([
        undefined,
        '[0:0]',
        '[0:0]',
        '[0:0]',
        '[0:0]',
      ]);

      const busBreakoutNode = page.locator('.hdl-bus-array-breakout');
      await expect(busBreakoutNode).toBeVisible();
      await expect(busBreakoutNode.locator('.svsch-bus-tap')).toHaveCount(4);

      await expect(busBreakoutNode.locator('.svsch-bus-tap-line-thick')).toHaveCount(0);
      await expect(
        page.locator(
          '.react-flow__edge[data-id*="array_stack_breakout_1bit:arr"] .svsch-edge-thick',
        ),
      ).toHaveCount(0);
      await expect(
        page.locator(
          '[data-node-id="port:array_stack_breakout_1bit:arr"] .svsch-array-stack-lead-thick',
        ),
      ).toHaveCount(0);

      await expectGraphAndScreenshot(page, 'array-stack-breakout-1bit-canvas.png', {
        clip: await paddedGraphClip(page),
      });
    } finally {
      if (originalBackend === undefined) {
        delete process.env.SVSCH_BACKEND;
      } else {
        process.env.SVSCH_BACKEND = originalBackend;
      }
    }
  });
});

async function openFixture(
  page: Page,
  fixtureName: string,
  layoutMode: 'auto' = 'auto',
  moduleName?: string,
): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);
  trackView(page, view);

  await page.goto('/');
  // Wait a bit for React to initialize and add the event listener
  await page.waitForTimeout(500);

  const renderStartedAt = Date.now();
  await page.evaluate((fixtureView) => {
    window.postMessage(
      {
        type: 'graph',
        view: fixtureView,
        modules: [fixtureView.moduleName],
      },
      '*',
    );
  }, view);

  await page.waitForSelector('.react-flow__node', { state: 'attached' });
  recordVisualBenchmark('rendering', Date.now() - renderStartedAt);
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
  return view;
}

// Mirrors diagramPanel.ts's first-open handling and helper.ts's
// withFirstOpenAutoCutEdges(), so this file's fixture layout cuts the same
// clock/reset/declared-net edges a real first open would.
function withFirstOpenAutoCutEdges(
  layout: SavedLayout,
  graph: DesignGraph,
  moduleName: string,
): SavedLayout {
  const designModule = graph.modules[moduleName];
  if (!designModule) return layout;
  return mergeFirstOpenNetCuts(
    layout,
    moduleName,
    firstOpenAutoCutEdges(designModule, true),
    designModule,
  );
}

async function buildFixtureView(
  fixtureName: string,
  layoutMode: string,
  requestedModuleName?: string,
): Promise<DiagramViewModel> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const text = fs.readFileSync(fixturePath, 'utf8');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-visual-'));
  try {
    const tmpFile = path.join(tmpDir, path.basename(fixtureName));
    fs.writeFileSync(tmpFile, text);

    const surelogPath =
      process.env.SVSCH_SURELOG_PATH ?? path.resolve(__dirname, '../../dist/surelog/bin/surelog');
    const backendPath = path.resolve(__dirname, '../../dist/svsch_backend');

    const elaborationStartedAt = Date.now();
    const graph = await buildDesignGraph({
      workspaceRoot: tmpDir,
      projectFolder: '.',
      backend: 'uhdm',
      veriblePath: 'verible-verilog-syntax',
      surelogPath,
      backendPath,
      includeExternalDiagnostics: false,
    });
    recordVisualBenchmark('elaboration', Date.now() - elaborationStartedAt);

    const moduleName = requestedModuleName ?? graph.rootModules[0];
    const layout = { version: 1, modules: {} } as SavedLayout;

    return buildViewModel(graph, moduleName, withFirstOpenAutoCutEdges(layout, graph, moduleName));
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

async function paddedGraphClip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
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
