import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildViewModel,
  firstOpenAutoCutEdges,
  mergeFirstOpenNetCuts,
  mergeNetCut,
} from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import { diagramNodeDimensions } from '../../src/diagram/nodeSizing';
import type { DesignGraph, DiagramViewModel, PositionedNode } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';
import { captureGraphState, compareGraphState, compareSvgSnapshot } from '../graphRegression';
import { renderSvg } from '../../src/cli/svgRenderer';
import { recordNamedBenchmarkSample } from '../benchmarkUtils';

const reactFlowCss = fs.readFileSync(require.resolve('@xyflow/react/dist/style.css'), 'utf8');
const extensionCss = fs.readFileSync(
  path.resolve(__dirname, '../../src/webview/diagram.css'),
  'utf8',
);

const currentPageViews = new WeakMap<Page, DiagramViewModel>();

export function trackView(page: Page, view: DiagramViewModel): void {
  currentPageViews.set(page, view);
}

export const fixtureRoot = path.resolve(__dirname, '..', 'fixtures');

// Timing: "post message -> DOM attached" duration, analogous to the system
// suite's rebuild->firstGraph interval. Set when postView() posts the graph.
// openFixture() resolves it precisely once its readySelector attaches; any
// other caller (openView() used directly) falls back to resolving it in
// expectGraphAndScreenshot(), so every test that renders something records a
// rendering sample, not just fixture-based ones — the fallback's span can
// include whatever interactions a test does between opening the view and
// screenshotting it, so it's a looser number than openFixture()'s, but still
// a real "diagram is visible" measurement rather than a missing one.
const postViewStartedAt = new WeakMap<Page, number>();
const pendingDiagramDurationMs = new WeakMap<Page, number>();
const visualArtifactsDir = path.resolve(__dirname, '../../test-results/visual/artifacts');
const visualRenderingSamplesFile = path.join(visualArtifactsDir, 'diagram-render-samples.log');
const visualElaborationSamplesFile = path.join(
  visualArtifactsDir,
  'diagram-elaboration-samples.log',
);

// Groups samples under "<spec file> › <test title>", matching how they read in
// the benchmark PR comment. Returns undefined outside of a running test.
function currentVisualBenchmarkName(): string | undefined {
  try {
    const info = test.info();
    return `${path.basename(info.file)} › ${info.title}`;
  } catch {
    return undefined;
  }
}

// Exported so spec files that keep their own local render helpers (instead of
// this module's postView()/openFixture()) can still record a sample with the
// same naming/log-file convention — see mux.visual.spec.ts and
// bus_composition.visual.spec.ts, which predate this instrumentation and
// otherwise silently produce zero benchmark data.
//
// `name` defaults to the currently running test's title, but callers that
// measure work shared across many tests (e.g. the memoized cpu example-design
// elaboration below) should pass a fixed name explicitly — otherwise the
// sample gets attributed to whichever test happens to trigger the shared
// work first, which varies with Playwright's worker scheduling.
export function recordVisualBenchmark(
  metric: 'elaboration' | 'rendering',
  durationMs: number,
  name = currentVisualBenchmarkName(),
): void {
  if (!name) return;
  const samplesFile =
    metric === 'elaboration' ? visualElaborationSamplesFile : visualRenderingSamplesFile;
  recordNamedBenchmarkSample(samplesFile, name, 'ms', durationMs);
}

// Trimmed-mean-of-21 sampling (trim k=4 per side, ~62% kept): a plain median
// only looks at the single middle rank, so a GC pause or scheduler blip that
// lands near the middle of the sorted samples still contaminates the result.
// Averaging the middle 13 of 21 samples resists that while still rejecting
// outliers at the edges. BDD already dominates CI runtime (~20min), so the
// extra samples' wall-clock cost is cheap here.
const BENCHMARK_SAMPLE_COUNT = 21;
const BENCHMARK_TRIM_COUNT = 4;

function trimmedMean(values: number[], k: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(k, sorted.length - k);
  return trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
}

// Resolves and records whatever rendering timer is pending for `page` — the
// precise one from openFixture() if set, else the postView() fallback. Called
// automatically from expectGraphAndScreenshot(); exported so tests that
// screenshot via a different path (e.g. a debug overlay test that skips the
// graph/SVG regression checks) can still record a rendering sample.
export function recordPendingRenderDuration(page: Page): void {
  let pendingDurationMs = pendingDiagramDurationMs.get(page);
  if (pendingDurationMs === undefined) {
    const postedAt = postViewStartedAt.get(page);
    if (postedAt !== undefined) {
      pendingDurationMs = Date.now() - postedAt;
    }
  }
  if (pendingDurationMs !== undefined) {
    pendingDiagramDurationMs.delete(page);
    postViewStartedAt.delete(page);
    recordVisualBenchmark('rendering', pendingDurationMs);
  }
}

export async function expectGraphAndScreenshot(page: Page, name: string, options?: any) {
  const resultsDir = path.resolve(__dirname, '../../test-results/visual/graph-diffs');

  recordPendingRenderDuration(page);

  // Use Playwright's built-in snapshot path logic to find the exact side-by-side location
  const jsonName = name.endsWith('.png') ? name.replace('.png', '.json') : `${name}.json`;
  const snapshotPath = test.info().snapshotPath(jsonName);
  const snapshotsDir = path.dirname(snapshotPath);
  const baseName = path.basename(snapshotPath, '.json');
  // Note: a bare `--update-snapshots` sets the mode to 'changed'.
  const updateMode = test.info().config.updateSnapshots;
  const updateSnapshots =
    !!process.env.UPDATE_SNAPSHOTS || updateMode === 'all' || updateMode === 'changed';

  // 1. Graph Regression (JSON)
  const graphState = await captureGraphState(page);
  compareGraphState(graphState, baseName, snapshotsDir, resultsDir, updateSnapshots);

  // 2. SVG Regression — generated from the DiagramViewModel, platform-independent.
  //    Stored without the browser/platform suffix so one file covers all platforms.
  const view = currentPageViews.get(page);
  if (view) {
    const svgBaseName = name.endsWith('.png') ? name.slice(0, -4) : name;
    const svg = renderSvg(view, { theme: 'dark', reactFlowCss, extensionCss });
    compareSvgSnapshot(svg, svgBaseName, snapshotsDir, resultsDir, updateSnapshots);
  }

  // 3. Image Regression (PNG)
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(name, options);
}

export type VisualLayoutMode =
  | 'auto'
  | 'manual'
  | 'bus'
  | 'struct'
  | 'interface'
  | 'register'
  | 'comb'
  | 'alu'
  | 'inverter'
  | 'generate'
  | 'cutNet';

export async function openFixture(
  page: Page,
  fixtureName: string,
  layoutMode: VisualLayoutMode = 'auto',
  moduleName?: string,
): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);

  const readySelector =
    layoutMode === 'bus'
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
                : layoutMode === 'inverter'
                  ? '[data-node-kind="inverter"]'
                  : layoutMode === 'generate'
                    ? '.generate-region'
                    : '.react-flow__node';

  // Re-open the view BENCHMARK_SAMPLE_COUNT times to get that many rendering
  // (postView -> DOM attached) samples, but only the final open's DOM sticks
  // around — the screenshot assertion downstream in expectGraphAndScreenshot()
  // stays a single call, so this doesn't multiply screenshot cost.
  const renderDurationsMs: number[] = [];
  for (let sample = 0; sample < BENCHMARK_SAMPLE_COUNT; sample += 1) {
    await openView(page, view);
    await page.waitForSelector(readySelector, { state: 'attached' });
    const postedAt = postViewStartedAt.get(page);
    if (postedAt !== undefined) {
      renderDurationsMs.push(Date.now() - postedAt);
    }
  }
  if (renderDurationsMs.length !== BENCHMARK_SAMPLE_COUNT) {
    throw new Error(
      `Expected ${BENCHMARK_SAMPLE_COUNT} rendering samples, got ${renderDurationsMs.length}`,
    );
  }
  pendingDiagramDurationMs.set(page, trimmedMean(renderDurationsMs, BENCHMARK_TRIM_COUNT));
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
  return view;
}

// The cpu example design's full module list, top included — shared by every
// spec that needs to iterate "every module of the example design" so there's
// a single source of truth (and so no spec file has to import another
// *.visual.spec.ts file just to reuse this array: Playwright registers a
// spec's top-level test()/test.describe() calls against whichever file
// caused them to run, so importing one spec from another attributes its
// tests to the importer and breaks baseline snapshot lookup).
export const EXAMPLE_DESIGN_MODULES = [
  'adder',
  'alu',
  'control_unit',
  'cpu_top',
  'data_mem',
  'imm_gen',
  'instr_mem',
  'mux2',
  'pc_reg',
  'register_file',
];

const exampleDesignRoot = path.resolve(__dirname, 'fixtures/example_designs/cpu');
let exampleDesignGraphPromise: Promise<DesignGraph> | undefined;

// Fixed rather than derived from the running test's title: this elaboration
// is memoized once per worker and shared across ~10 tests (all of
// example_design.visual.spec.ts plus expand_instance.visual.spec.ts's
// "every instance expanded" suite), so whichever test happens to trigger it
// first varies with Playwright's worker/test scheduling. Attributing the
// sample to that test made the benchmark chart flip between test names (and
// spuriously show "new"/no-baseline) run to run — see #344.
const exampleDesignElaborationBenchmarkName =
  'example_design.visual.spec.ts › cpu example design elaboration (shared)';

function exampleDesignGraph(): Promise<DesignGraph> {
  exampleDesignGraphPromise ??= (async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-example-design-'));
    try {
      for (const file of fs.readdirSync(exampleDesignRoot)) {
        if (!file.endsWith('.sv')) continue;
        fs.copyFileSync(path.join(exampleDesignRoot, file), path.join(tmpDir, file));
      }

      return await buildGraphFromWorkspace(tmpDir, exampleDesignElaborationBenchmarkName);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
  return exampleDesignGraphPromise;
}

export async function buildExampleDesignView(moduleName: string): Promise<DiagramViewModel> {
  const { view } = await buildExampleDesignViewWithGraph(moduleName);
  return view;
}

/**
 * Like buildExampleDesignView, but also hands back the elaborated graph and
 * the first-open layout it was built from — for specs that need to play the
 * extension host's own role (e.g. answering requestExpandInstance with a
 * child module's IR, or re-running relayoutSelection's merge+build flow).
 */
export async function buildExampleDesignViewWithGraph(moduleName: string): Promise<{
  graph: DesignGraph;
  layout: SavedLayout;
  view: DiagramViewModel;
}> {
  const graph = await exampleDesignGraph();
  const designModule = graph.modules[moduleName];
  const emptyLayout: SavedLayout = { version: 1, modules: {} };
  const layout = designModule
    ? mergeFirstOpenNetCuts(
        emptyLayout,
        moduleName,
        firstOpenAutoCutEdges(designModule, true),
        designModule,
      )
    : emptyLayout;
  return { graph, layout, view: await buildViewModel(graph, moduleName, layout) };
}

export async function openExampleDesignModule(
  page: Page,
  moduleName: string,
): Promise<DiagramViewModel> {
  const view = await buildExampleDesignView(moduleName);

  await openView(page, view);
  await page.waitForSelector('.react-flow__node', { state: 'attached' });
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
  return view;
}

export async function openView(page: Page, view: DiagramViewModel): Promise<void> {
  currentPageViews.set(page, view);
  await page.goto('/');
  await installStableTheme(page);
  // Wait a bit for React to initialize and add the event listener
  await page.waitForTimeout(500);
  await postView(page, view);
}

export async function postView(page: Page, view: DiagramViewModel): Promise<void> {
  currentPageViews.set(page, view);
  // Finalize any timer left over from a prior openFixture/postView on this
  // page before starting a new one, so its duration isn't silently
  // overwritten (or attributed to this view) once recordPendingRenderDuration
  // next runs.
  recordPendingRenderDuration(page);
  postViewStartedAt.set(page, Date.now());
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
}

export async function paddedLocatorClip(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.evaluate(() => document.fonts.ready);
  const padding = 24;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`Unable to find screenshot target: ${selector}`);
  }
  return paddedClipFromBox(page, box, padding);
}

export async function paddedGraphClip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.evaluate(() => document.fonts.ready);
  const padding = 48;
  const box = await page.locator('.react-flow__nodes').boundingBox();
  if (!box) {
    throw new Error('Unable to find rendered graph nodes');
  }
  return paddedClipFromBox(page, box, padding);
}

// Union-based clip: queries every rendered node's getBoundingClientRect so nodes
// above canvas y=0 (which fall above the .react-flow__nodes container bbox) are
// included correctly.
export async function paddedAllNodesClip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.evaluate(() => document.fonts.ready);
  const padding = 48;
  const box = await page.evaluate(() => {
    const rects = Array.from(document.querySelectorAll('.react-flow__node'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;
    const minX = Math.min(...rects.map((r) => r.left));
    const minY = Math.min(...rects.map((r) => r.top));
    const maxX = Math.max(...rects.map((r) => r.right));
    const maxY = Math.max(...rects.map((r) => r.bottom));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  });
  if (!box) {
    throw new Error('Unable to find rendered graph nodes');
  }
  return paddedClipFromBox(page, box, padding);
}

export async function paddedGraphAndRegionsClip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.evaluate(() => document.fonts.ready);
  const padding = 48;
  const box = await page.evaluate(() => {
    const rects = Array.from(document.querySelectorAll('.react-flow__node, .generate-region'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;
    const minX = Math.min(...rects.map((r) => r.left));
    const minY = Math.min(...rects.map((r) => r.top));
    const maxX = Math.max(...rects.map((r) => r.right));
    const maxY = Math.max(...rects.map((r) => r.bottom));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  });
  if (!box) {
    throw new Error('Unable to find rendered graph nodes or generate regions');
  }
  return paddedClipFromBox(page, box, padding);
}

export async function canvasClip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.evaluate(() => document.fonts.ready);
  const box = await page.locator('.canvas').boundingBox();
  if (!box) {
    throw new Error('Unable to find rendered canvas');
  }
  const viewport = page.viewportSize() ?? { width: 900, height: 640 };
  return {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.min(viewport.width, Math.ceil(box.x + box.width)) - Math.max(0, Math.floor(box.x)),
    height:
      Math.min(viewport.height, Math.ceil(box.y + box.height)) - Math.max(0, Math.floor(box.y)),
  };
}

export function paddedClipFromBox(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  padding: number,
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
    height: bottom - y,
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

export async function fitGraphView(page: Page, padding = 0.12): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).reactFlowInstance), undefined, {
    timeout: 5000,
  });
  const fitViewButton = page.locator('button.react-flow__controls-fitview');
  if (await fitViewButton.isVisible()) {
    await fitViewButton.click();
  } else {
    await page.evaluate((fitPadding) => {
      (window as any).reactFlowInstance.fitView({ padding: fitPadding });
    }, padding);
  }
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
}

async function buildGraphFromWorkspace(
  workspaceRoot: string,
  benchmarkName?: string,
): Promise<DesignGraph> {
  const surelogPath =
    process.env.SVSCH_SURELOG_PATH ?? path.resolve(__dirname, '../../dist/surelog/bin/surelog');
  const backendPath = path.resolve(__dirname, '../../dist/svsch_backend');

  const elaborationStartedAt = Date.now();
  const graph = await buildDesignGraph({
    workspaceRoot,
    projectFolder: '.',
    backend: (process.env.SVSCH_BACKEND as any) || 'uhdm',
    veriblePath: 'verible-verilog-syntax',
    surelogPath,
    backendPath,
    includeExternalDiagnostics: false,
  });
  recordVisualBenchmark('elaboration', Date.now() - elaborationStartedAt, benchmarkName);
  return graph;
}

// Mirrors diagramPanel.ts's first-open handling (see postViewNow()) and
// buildExampleDesignViewWithGraph() above, so hand-built fixture layouts cut
// the same clock/reset/declared-net edges a real first open would — instead
// of leaving clocks attached and feedback nets uncut, which is how production
// and test fixtures ended up disagreeing in the first place.
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

export async function buildFixtureView(
  fixtureName: string,
  layoutMode: VisualLayoutMode,
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

    // This is the Surelog/UHDM (C++) parse + elaborate step — the part of
    // diagram generation that doesn't run in JS at all, timed separately from
    // the ELK layout and React render below. buildDesignGraph() repeats
    // filesystem discovery and UHDM extraction on every call, so sampling it
    // BENCHMARK_SAMPLE_COUNT times adds real backend work and CI time — unlike
    // the rendering samples below, which just re-open the already-elaborated
    // view.
    const buildOptions = {
      workspaceRoot: tmpDir,
      projectFolder: '.',
      backend: (process.env.SVSCH_BACKEND as any) || 'uhdm',
      veriblePath: 'verible-verilog-syntax',
      surelogPath,
      backendPath,
      includeExternalDiagnostics: false,
    };
    const elaborationDurationsMs: number[] = [];
    let lastGraph: DesignGraph | undefined;
    const maxElaborationAttempts = BENCHMARK_SAMPLE_COUNT * 2;
    for (
      let attempt = 0;
      attempt < maxElaborationAttempts && elaborationDurationsMs.length < BENCHMARK_SAMPLE_COUNT;
      attempt += 1
    ) {
      const elaborationStartedAt = Date.now();
      const sampledGraph = await buildDesignGraph(buildOptions);
      if (sampledGraph.rootModules.length === 0) {
        continue;
      }
      elaborationDurationsMs.push(Date.now() - elaborationStartedAt);
      lastGraph = sampledGraph;
    }
    if (!lastGraph || elaborationDurationsMs.length !== BENCHMARK_SAMPLE_COUNT) {
      throw new Error(
        `Expected ${BENCHMARK_SAMPLE_COUNT} elaboration samples for ${fixtureName}, got ${elaborationDurationsMs.length} after ${maxElaborationAttempts} attempts`,
      );
    }
    recordVisualBenchmark('elaboration', trimmedMean(elaborationDurationsMs, BENCHMARK_TRIM_COUNT));
    const graph = lastGraph;

    const moduleName = requestedModuleName ?? graph.rootModules[0];
    const layout =
      layoutMode === 'manual'
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
                    : layoutMode === 'inverter'
                      ? createInverterVisualLayout(graph, moduleName)
                      : layoutMode === 'generate'
                        ? createGenerateVisualLayout(graph, moduleName)
                        : layoutMode === 'cutNet'
                          ? createCutNetVisualLayout(graph, moduleName)
                          : ({ version: 1, modules: {} } as SavedLayout);

    return buildViewModel(graph, moduleName, withFirstOpenAutoCutEdges(layout, graph, moduleName));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Cuts the module's first edge and leaves its dangling `netLabel` ends
// unpinned (no saved position for them), so they land at the geometry-derived
// fallback position ELK's port geometry drives — exactly what the elk-geometry
// grid overlay is meant to visualize for every node kind, netLabel included.
function createCutNetVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const edge = designModule.edges[0];
  if (!edge) {
    throw new Error(
      `No edge found in module "${moduleName}" to cut for the cut-net visual fixture`,
    );
  }
  const sourceNode = designModule.nodes.find((node) => node.id === edge.source);
  const targetNode = designModule.nodes.find((node) => node.id === edge.target);
  if (!sourceNode || !targetNode) {
    throw new Error(
      `Could not resolve edge endpoints for the cut-net visual fixture in "${moduleName}"`,
    );
  }

  const grid = 24;
  const positionedNodes: PositionedNode[] = [
    { ...sourceNode, position: { x: grid * 4, y: grid * 4 } },
    { ...targetNode, position: { x: grid * 24, y: grid * 4 } },
  ];

  return mergeNetCut({ version: 1, modules: {} }, moduleName, edge, designModule, positionedNodes);
}

function createRegisterVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const registerNode = designModule.nodes.find((node) => node.kind === 'register');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      [moduleName]: { nodes },
    },
  };
}

function createBusVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const bus = designModule.nodes.find((node) => node.kind === 'bus');
  const inputPort = designModule.nodes.find(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      [moduleName]: { nodes },
    },
  };
}

function createStructVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const struct = designModule.nodes.find((node) => node.kind === 'struct');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      [moduleName]: { nodes },
    },
  };
}

function createInterfaceVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const interfaces = designModule.nodes.filter((node) => node.kind === 'interface');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      nodes[node.id] = fixed(
        ifaceX - grid * 8,
        ifaceY + grid * index * 10 + modportHeight / 2 - portHeight / 2,
      );
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
        [moduleName]: { nodes },
      },
    };
  }

  interfaces.forEach((node, index) => {
    nodes[node.id] = fixed(ifaceX, ifaceY + grid * index * 11);
  });

  inputPorts.forEach((node, index) => {
    const interfaceClockEdge = designModule.edges.find(
      (edge) =>
        edge.source === node.id &&
        interfaces.some((iface) => iface.id === edge.target) &&
        !String(edge.targetPort ?? '').includes('master') &&
        !String(edge.targetPort ?? '').includes('slave'),
    );
    const targetInterface = interfaces.find((iface) => iface.id === interfaceClockEdge?.target);
    if (targetInterface) {
      const ifacePosition = nodes[targetInterface.id] ?? { x: ifaceX, y: ifaceY };
      const ifaceSize = diagramNodeDimensions(targetInterface);
      const portSize = diagramNodeDimensions(node);
      nodes[node.id] = fixed(
        ifacePosition.x + ifaceSize.width / 2 - portSize.width - grid,
        ifacePosition.y - grid * 2.5,
      );
      return;
    }

    nodes[node.id] = fixed(ifaceX - grid * 10, ifaceY + grid * index * 2);
  });

  let leftInstanceRow = 0;
  let rightInstanceRow = 0;
  instances.forEach((node, index) => {
    const interfacePort = node.ports.find(
      (port) =>
        port.width === 'interface' ||
        port.typeName?.endsWith('_if') ||
        port.typeName?.endsWith('if'),
    );
    const goesLeft =
      interfacePort?.preferredSide === 'left' || interfacePort?.direction === 'output';
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
      [moduleName]: { nodes },
    },
  };
}

function createVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const mux = designModule.nodes.find((node) => node.kind === 'mux');
  const muxSelector = mux?.ports.find((port) => port.direction === 'input')?.name;
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      [moduleName]: { nodes },
    },
  };
}

function createCombVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const comb = designModule.nodes.find((node) => node.kind === 'comb');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      [moduleName]: { nodes },
    },
  };
}

function createAluVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const alus = designModule.nodes.filter((node) => node.kind === 'alu');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
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
      [moduleName]: { nodes },
    },
  };
}

function createInverterVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const inverters = designModule.nodes.filter((node) => node.kind === 'inverter');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const invX = grid * 10;
  const invY = grid * 4;

  inverters.forEach((node, index) => {
    nodes[node.id] = { x: invX, y: invY + grid * index * 4 };
  });

  inputPorts.forEach((node, index) => {
    nodes[node.id] = { x: invX - grid * 8, y: invY + grid * index * 4 + grid / 2 };
  });

  outputPorts.forEach((node, index) => {
    nodes[node.id] = { x: invX + grid * 10, y: invY + grid * index * 4 + grid / 2 };
  });

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes },
    },
  };
}

function createGenerateVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
  const regionNodeIds = new Set(
    (designModule.generateRegions ?? []).flatMap((region) => region.nodeIds ?? []),
  );
  const bodyNodes = designModule.nodes.filter(
    (node) => node.kind !== 'port' && !regionNodeIds.has(node.id),
  );
  const nodes: Record<string, { x: number; y: number; fixed?: boolean }> = {};
  const regions: NonNullable<SavedLayout['modules'][string]['regions']> = {};
  const grid = 24;
  const fixed = (x: number, y: number) => ({ x, y, fixed: true });
  const centerY = grid * 5;

  inputPorts.forEach((node, index) => {
    nodes[node.id] = fixed(grid * 2, centerY + grid * index * 10);
  });

  bodyNodes.forEach((node, index) => {
    nodes[node.id] = fixed(grid * 25, centerY + grid * index * 4);
  });

  outputPorts.forEach((node, index) => {
    nodes[node.id] = fixed(grid * 38, centerY + grid * 11.5 + grid * index * 2);
  });

  const roots =
    designModule.generateRegions
      ?.filter((region) => !region.parentRegionId)
      .sort((a, b) => (a.armIndex ?? 0) - (b.armIndex ?? 0) || a.id.localeCompare(b.id)) ?? [];
  const childGroups = new Map<string, typeof roots>();
  for (const region of designModule.generateRegions ?? []) {
    if (!region.parentRegionId) continue;
    const group = childGroups.get(region.parentRegionId) ?? [];
    group.push(region);
    childGroups.set(region.parentRegionId, group);
  }
  for (const group of childGroups.values()) {
    group.sort((a, b) => (a.armIndex ?? 0) - (b.armIndex ?? 0) || a.id.localeCompare(b.id));
  }

  roots.forEach((region, index) => {
    const baseY = grid * 2 + index * grid * 10;
    const children = childGroups.get(region.id) ?? [];
    // Space children a full arm apart so they keep clear of one another once each arm
    // auto-grows to fit its block plus the 2-grid content padding.
    const height = children.length > 0 ? grid * 4 + children.length * grid * 10 : grid * 8;
    regions[region.id] = { x: grid * 8, y: baseY, width: grid * 16, height, fixed: true };

    children.forEach((child, childIndex) => {
      regions[child.id] = {
        x: grid * 9,
        y: baseY + grid * 2 + childIndex * grid * 10,
        width: grid * 14,
        height: grid * 8,
        fixed: true,
      };
    });
  });

  for (const region of designModule.generateRegions ?? []) {
    const bounds = regions[region.id];
    if (!bounds) continue;
    (region.nodeIds ?? []).forEach((nodeId, index) => {
      if (!designModule.nodes.some((node) => node.id === nodeId)) return;
      nodes[nodeId] = fixed(bounds.x + grid * 3, bounds.y + grid * 2.5 + index * grid * 4);
    });
  }

  return {
    version: 1,
    modules: {
      [moduleName]: { nodes, regions },
    },
  };
}

export async function installStableTheme(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      :root {
        --vscode-editor-background: #000000;
        --vscode-editor-foreground: #d6d6d6;
        --vscode-font-family: Arial, sans-serif;
        --vscode-editor-font-family: 'DejaVu Sans Mono', monospace;
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
        -webkit-font-smoothing: antialiased !important;
        -moz-osx-font-smoothing: grayscale !important;
      }

      text {
        text-rendering: geometricPrecision !important;
      }
    `,
  });
  // Force Chrome to load and cache the font file for every weight used by SVG
  // text elements before any diagram renders. SVG dominantBaseline="middle"
  // positioning uses cap-height metrics; if the font file hasn't been read from
  // disk yet, Chrome briefly falls back to "monospace" metrics for the first
  // paint and then repaints once the file loads — causing a random 1 px shift
  // in whichever nodes happen to render during that window. Forcing layout with
  // getBoundingClientRect() on an invisible element with the target font
  // completes the disk load synchronously so the first SVG paint is always
  // using the correct metrics.
  await page.evaluate(async () => {
    const el = document.createElement('span');
    el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    document.body.appendChild(el);
    for (const spec of [
      'normal 10px "DejaVu Sans Mono",monospace',
      '600 14px "DejaVu Sans Mono",monospace',
      '700 11px "DejaVu Sans Mono",monospace',
    ]) {
      el.style.font = spec;
      el.textContent = 'Xg';
      el.getBoundingClientRect();
    }
    el.remove();
    await document.fonts.ready;
  });
}
