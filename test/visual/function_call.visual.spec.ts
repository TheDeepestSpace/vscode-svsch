import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { buildExpandSpliceLayout } from '../../src/layout/expandLayout';
import { applyExpandedInstances } from '../../src/layout/expandSpliceView';
import { buildDesignGraph } from '../../src/parser/backend';
import type { DesignGraph, DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';
import {
  fixtureRoot,
  expectGraphAndScreenshot,
  fitGraphView,
  openFixture,
  openView,
  trackView,
  waitForViewportTransformToSettle,
} from './helper';

// "Support expandable function/task call diagrams" (issue #335, revised in
// PR #336 review): a function/task call site renders as its own FUNCTION/
// TASK block (InstanceNodeSvg's kindLabel), and selecting it then clicking
// the toolbar "Expand" button splices its own body in place — the same
// select-then-click-Expand round trip an instance uses (double-click is a
// no-op for these kinds; see InstanceNode.tsx). There's no live extension
// host in this browser-only harness, so the host's expandFunctionCallData/
// expandTaskCallData reply is simulated from the same DesignGraph the
// fixture's own view was built from, mirroring diagramPanel.ts's
// requestExpandFunctionCall/requestExpandTaskCall handlers.
async function installMessageCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__svschMessages = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (message: unknown) => {
        (window as any).__svschMessages.push(message);
      },
    });
  });
}

async function capturedMessages(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__svschMessages ?? []);
}

async function buildFixtureGraph(fixtureName: string): Promise<DesignGraph> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const text = fs.readFileSync(fixturePath, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-function-call-visual-'));
  try {
    fs.writeFileSync(path.join(tmpDir, fixtureName), text);
    const surelogPath =
      process.env.SVSCH_SURELOG_PATH ?? path.resolve(__dirname, '../../dist/surelog/bin/surelog');
    const backendPath = path.resolve(__dirname, '../../dist/svsch_backend');
    return await buildDesignGraph({
      workspaceRoot: tmpDir,
      projectFolder: '.',
      backend: (process.env.SVSCH_BACKEND as any) || 'uhdm',
      veriblePath: 'verible-verilog-syntax',
      surelogPath,
      backendPath,
      includeExternalDiagnostics: false,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Mirrors diagramPanel.ts's requestExpandFunctionCall/requestExpandTaskCall
// response: the callable body from graph.functions/graph.tasks plus the
// host-computed splice layout.
async function expandCallPayloadFor(
  graph: DesignGraph,
  layout: SavedLayout,
  request: any,
): Promise<{ messageType: string; payload: Record<string, unknown> }> {
  const parentModule = graph.modules[request.moduleName];
  const callNode = parentModule?.nodes.find((node: any) => node.id === request.callId);
  if (!callNode || (callNode.kind !== 'funcCall' && callNode.kind !== 'taskCall')) {
    throw new Error(`No function/task call ${request.callId} in ${request.moduleName}`);
  }
  const isFunc = callNode.kind === 'funcCall';
  const callableId = isFunc ? callNode.functionId : callNode.taskId;
  if (!callableId) throw new Error(`Call node ${request.callId} has no callable id`);
  const callable = (isFunc ? graph.functions : graph.tasks)?.[callableId];
  if (!callable) throw new Error(`No callable body for ${callableId}`);
  const spliceLayout = await buildExpandSpliceLayout({
    graph,
    layout,
    childModuleName: callableId,
    instanceId: request.callId,
    instancePorts: callNode.ports,
    instanceSize: request.callSize,
    instanceParamRows: 0,
    childModule: callable,
  });
  return {
    messageType: isFunc ? 'expandFunctionCallData' : 'expandTaskCallData',
    payload: isFunc
      ? { callId: request.callId, functionId: callableId, module: callable, spliceLayout }
      : { callId: request.callId, taskId: callableId, module: callable, spliceLayout },
  };
}

// Selects the given funcCall/taskCall node then clicks the toolbar "Expand"
// button — same round trip an instance uses (double-click is a no-op for
// these kinds; see InstanceNode.tsx's onDoubleClick).
async function expandCallOnPage(
  page: Page,
  graph: DesignGraph,
  layout: SavedLayout,
  callLocator: ReturnType<Page['locator']>,
  requestMessageType: 'requestExpandFunctionCall' | 'requestExpandTaskCall',
): Promise<void> {
  const box = await callLocator.boundingBox();
  if (!box) throw new Error('Could not locate the call node to expand');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const expandButton = page.locator('.svsch-selection-toolbar button', { hasText: 'Expand' });
  await expect(expandButton).toBeVisible();
  await expandButton.click();
  await expect
    .poll(async () =>
      (await capturedMessages(page)).some((message: any) => message.type === requestMessageType),
    )
    .toBe(true);
  const request = (await capturedMessages(page)).find(
    (message: any) => message.type === requestMessageType,
  );
  const { messageType, payload } = await expandCallPayloadFor(graph, layout, request);
  await page.evaluate(
    ({ moduleName, messageType, payload }) => {
      window.postMessage({ type: messageType, moduleName, payload }, '*');
    },
    { moduleName: request.moduleName, messageType, payload },
  );
  await page.waitForSelector('[data-node-kind="boundaryPort"]', { state: 'attached' });
}

// Flags `callIds` expanded in a throwaway copy of `layout`, then re-derives
// their splice fresh — the same content the webview itself spliced in — so
// the SVG half of expectGraphAndScreenshot's regression check (renderSvg on
// the tracked view) reflects the expanded state the PNG screenshot shows.
async function trackCallSplicedView(
  page: Page,
  graph: DesignGraph,
  layout: SavedLayout,
  view: DiagramViewModel,
  callIds: string[],
  expansionKind: 'funcCall' | 'taskCall',
): Promise<void> {
  const moduleLayout = layout.modules[view.moduleName] ?? { nodes: {} };
  const expandedIds = Object.fromEntries(callIds.map((id) => [id, true]));
  const expandedLayout: SavedLayout = {
    ...layout,
    modules: {
      ...layout.modules,
      [view.moduleName]:
        expansionKind === 'funcCall'
          ? {
              ...moduleLayout,
              expandedFunctionCalls: {
                ...(moduleLayout.expandedFunctionCalls ?? {}),
                ...expandedIds,
              },
            }
          : {
              ...moduleLayout,
              expandedTaskCalls: { ...(moduleLayout.expandedTaskCalls ?? {}), ...expandedIds },
            },
    },
  };
  const splicedView = await applyExpandedInstances({ graph, layout: expandedLayout, view });
  trackView(page, splicedView);
}

test.describe('function call diagrams visual', () => {
  test('a function call renders as a FUNCTION block, and expanding it splices in its body', async ({
    page,
  }) => {
    await installMessageCapture(page);

    const graph = await buildFixtureGraph('function_call.sv');
    const emptyLayout: SavedLayout = { version: 1, modules: {} };
    const view = await buildViewModel(graph, 'function_call', emptyLayout);

    await openView(page, view);
    await page.waitForSelector('[data-node-kind="funcCall"]', { state: 'attached' });
    await waitForViewportTransformToSettle(page);

    const call = page.locator('[data-node-kind="funcCall"]');
    await expect(call).toHaveCount(1);
    const callId = await call.getAttribute('data-node-id');
    if (!callId) throw new Error('Could not locate the "foo" function call node');
    await expect(call).toContainText('FUNCTION');
    await expect(call).toContainText('foo');

    await fitGraphView(page, 0.2);
    await expectGraphAndScreenshot(page, 'function-call-collapsed.png');

    await expandCallOnPage(page, graph, emptyLayout, call, 'requestExpandFunctionCall');

    await expect(page.locator('[data-node-kind="boundaryPort"]')).toHaveCount(3);
    const callWrapper = page.locator(`.react-flow__node[data-id="${callId}"]`);
    await expect(callWrapper).toHaveClass(/hdl-node-expand-ghost/);
    // The function's own body (an ALU add node, per test/unit/backend.test.ts)
    // is spliced in inside the call's frame.
    await expect(page.locator('[data-node-kind="alu"]')).toHaveCount(1);

    await fitGraphView(page, 0.2);
    await trackCallSplicedView(page, graph, emptyLayout, view, [callId], 'funcCall');
    await expectGraphAndScreenshot(page, 'function-call-expanded.png');

    // Collapse restores the original small FUNCTION block. A function call's
    // frame is only as tall as its 2-3 boundary ports, so its header strip is
    // much shorter than a typical expanded instance's — click the header
    // row's horizontal center, clear of the input boundary ports hugging the
    // left edge and the output one hugging the right, rather than a
    // corner-offset click that risks landing on one of them.
    const ghostBox = await callWrapper.boundingBox();
    if (!ghostBox) throw new Error('Could not locate the expanded "foo" function call node');
    await page.mouse.click(ghostBox.x + ghostBox.width / 2, ghostBox.y + 15);
    const collapseButton = page.locator('.svsch-selection-toolbar button', { hasText: 'Collapse' });
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();

    await expect(page.locator('[data-node-kind="boundaryPort"]')).toHaveCount(0);
    await expect(call).toHaveCount(1);
    await expect(callWrapper).not.toHaveClass(/hdl-node-expand-ghost/);
  });

  test('a task call renders as a TASK block', async ({ page }) => {
    await openFixture(page, 'task_call.sv', 'auto', 'task_call');

    const call = page.locator('[data-node-kind="taskCall"]');
    await expect(call).toHaveCount(1);
    await expect(call).toContainText('TASK');
    await expect(call).toContainText('add_values');

    await fitGraphView(page, 0.2);
    await expectGraphAndScreenshot(page, 'task-call.png');
  });

  // Task counterpart to "a function call renders as a FUNCTION block, and
  // expanding it splices in its body" above (issue #340, folded into #335's
  // Expand-button revision). No new screenshot baseline here — same splice
  // machinery, already covered pixel-for-pixel by the function-call case —
  // this just confirms the taskCall wiring (select+Expand, boundary ports,
  // Collapse) round-trips too.
  test('expanding a task call in place splices in its body, and Collapse restores it', async ({
    page,
  }) => {
    await installMessageCapture(page);

    const graph = await buildFixtureGraph('task_call.sv');
    const emptyLayout: SavedLayout = { version: 1, modules: {} };
    const view = await buildViewModel(graph, 'task_call', emptyLayout);

    await openView(page, view);
    await page.waitForSelector('[data-node-kind="taskCall"]', { state: 'attached' });
    await waitForViewportTransformToSettle(page);

    const call = page.locator('[data-node-kind="taskCall"]');
    await expect(call).toHaveCount(1);
    const callId = await call.getAttribute('data-node-id');
    if (!callId) throw new Error('Could not locate the "add_values" task call node');

    await fitGraphView(page, 0.2);
    await expandCallOnPage(page, graph, emptyLayout, call, 'requestExpandTaskCall');

    await expect(page.locator('[data-node-kind="boundaryPort"]')).toHaveCount(3);
    const callWrapper = page.locator(`.react-flow__node[data-id="${callId}"]`);
    await expect(callWrapper).toHaveClass(/hdl-node-expand-ghost/);
    await expect(page.locator('[data-node-kind="alu"]')).toHaveCount(1);

    const ghostBox = await callWrapper.boundingBox();
    if (!ghostBox) throw new Error('Could not locate the expanded "add_values" task call node');
    await page.mouse.click(ghostBox.x + ghostBox.width / 2, ghostBox.y + 15);
    const collapseButton = page.locator('.svsch-selection-toolbar button', { hasText: 'Collapse' });
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();

    await expect(page.locator('[data-node-kind="boundaryPort"]')).toHaveCount(0);
    await expect(call).toHaveCount(1);
    await expect(callWrapper).not.toHaveClass(/hdl-node-expand-ghost/);
  });
});
