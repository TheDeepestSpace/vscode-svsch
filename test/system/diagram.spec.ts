import { test, expect } from 'vscode-test-playwright';
import type { FrameLocator, Locator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import {
  SYSTEM_LAYOUTS_DIR,
  type EvaluateInVSCode,
  clearSystemLayout,
  openSystemDiagram,
  openSystemModule,
  dismissSystemNotifications,
  waitForViewportToSettle,
} from './helpers';

const logDir = path.resolve(__dirname, '../../test-results/system/artifacts');
const webviewLogs: string[] = [];

test.beforeEach(async ({ workbox }) => {
  fs.mkdirSync(logDir, { recursive: true });
  workbox.on('console', (msg) => {
    const line = `[WEBVIEW CONSOLE] [${msg.type()}] ${msg.text()}`;
    webviewLogs.push(line);
    if (msg.type() === 'error') console.error(line);
  });
});

test('opens svsch diagram and captures screenshot + output logs', async ({
  workbox,
  evaluateInVSCode,
}) => {
  // A previous suite invocation can leave a saved layout behind (the extension's
  // debounced save may re-create a module's layout file after a test's cleanup) — start clean.
  await clearSystemLayout();
  try {
    // --- 1. Wait for the VSCode workbench to be interactive.
    await workbox.waitForSelector('.monaco-workbench', { timeout: 30_000 });
    await workbox.waitForTimeout(2_000);

    // --- 2. Dismiss any notification toasts that appeared during startup
    //     (e.g. the "git repository found" prompt) so they don't pollute
    //     the screenshot. Settings suppress most, but some fire before
    //     settings are read.
    for (const button of await workbox
      .locator('.notification-toast button', { hasText: /Never|Don't show/i })
      .all()) {
      await button.click().catch(() => {});
    }
    const closeAll = workbox.locator('.notifications-toasts .codicon-notifications-clear-all');
    if (await closeAll.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await closeAll.click();
    }

    // --- 3. Install pre-activation interceptors before any svsch.* command fires.
    //     Extension activates lazily on svsch.* commands, so these patches
    //     land before logger.init() and DiagramPanel construction are called.
    await evaluateInVSCode((vscode) => {
      // (a) Capture SVSCH output channel log lines and console calls.
      const captureLine = (line: string) => {
        if (!(global as any).__svschLogs) (global as any).__svschLogs = [];
        (global as any).__svschLogs.push(line);
      };

      const origCreateChannel = vscode.window.createOutputChannel;
      (vscode.window as any).createOutputChannel = function (name: string, ...args: any[]) {
        const ch = (origCreateChannel as any).call(vscode.window, name, ...args);
        if (name === 'SVSCH') {
          const origAppend = ch.appendLine.bind(ch);
          ch.appendLine = (line: string) => {
            captureLine(line);
            return origAppend(line);
          };
        }
        return ch;
      };

      const origLog = console.log;
      console.log = (...args: any[]) => {
        captureLine(`[CONSOLE.LOG] ${args.join(' ')}`);
        return origLog.apply(console, args);
      };
      const origError = console.error;
      console.error = (...args: any[]) => {
        captureLine(`[CONSOLE.ERROR] ${args.join(' ')}`);
        return origError.apply(console, args);
      };
      const origWarn = console.warn;
      console.warn = (...args: any[]) => {
        captureLine(`[CONSOLE.WARN] ${args.join(' ')}`);
        return origWarn.apply(console, args);
      };

      // (b) Intercept the SVSCH webview panel so tests can:
      //     • record timestamps for each phase of the build pipeline
      //     • read the modules list sent from the extension to the webview
      //     • simulate the webview posting an openModule message back to the extension
      //     The webview lives in a cross-origin iframe so Playwright cannot touch it
      //     directly; this extension-host patch is the only bridge available.
      const origCreatePanel = vscode.window.createWebviewPanel;
      (vscode.window as any).createWebviewPanel = function (
        viewType: string,
        title: string,
        ...args: any[]
      ) {
        const panel = (origCreatePanel as any).call(vscode.window, viewType, title, ...args);
        if (viewType === 'svsch.diagram') {
          const origPostMessage = panel.webview.postMessage.bind(panel.webview);
          panel.webview.postMessage = (msg: any) => {
            if (msg?.type === 'graph') {
              (global as any).__svschModules = msg.modules;
              (global as any).__svschCurrentModule = msg.view?.moduleName;
              (global as any).__svschGraphCount = ((global as any).__svschGraphCount ?? 0) + 1;

              const nodes = msg.view?.nodes?.length ?? 0;
              const edges = msg.view?.edges?.length ?? 0;
              captureLine(
                `[WEBVIEW] Received graph for ${msg.view?.moduleName}: ${nodes} nodes, ` +
                  `${edges} edges`,
              );
            }
            return origPostMessage(msg);
          };

          // Capture the extension's onDidReceiveMessage listener so we can invoke it
          // directly, simulating a message posted from the webview.
          const origOnDidReceiveMessage = panel.webview.onDidReceiveMessage;
          const msgListeners: Array<(msg: any) => void> = [];
          (panel.webview as any).onDidReceiveMessage = function (
            listener: any,
            thisArgs?: any,
            disposables?: any,
          ) {
            msgListeners.push(thisArgs ? listener.bind(thisArgs) : listener);
            return (origOnDidReceiveMessage as any).call(
              panel.webview,
              listener,
              thisArgs,
              disposables,
            );
          };
          (global as any).__svschFireWebviewMessage = (msg: any) => {
            for (const l of msgListeners) l(msg);
          };
        }
        return panel;
      };
    });

    // --- 4. Clear the UHDM cache so Surelog always runs and the progress
    //     notification is guaranteed to appear during this test.
    await evaluateInVSCode((vscode) => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (ws) {
        const cacheUri = vscode.Uri.joinPath(ws, '.svsch', 'uhdm_cache');
        return vscode.workspace.fs.delete(cacheUri, { recursive: true, useTrash: false }).then(
          () => {},
          () => {}, // ignore "not found" errors
        );
      }
    });

    // --- 5. Fire openDiagram WITHOUT awaiting its returned Promise.
    //     executeCommand resolves only when the full rebuild finishes (~18 s),
    //     so returning it would block until Surelog completes and we'd never
    //     catch the progress notification mid-flight.
    await evaluateInVSCode((vscode) => {
      void vscode.commands.executeCommand('svsch.openDiagram');
    });

    // --- 6. Confirm the SVSCH panel tab opened.
    //     This ensures the webview is created and visible before we snapshot
    //     the progress notification.
    await workbox.waitForSelector('.tab[aria-label*="SVSCH"], .tab[title*="SVSCH"]', {
      timeout: 30_000,
    });

    // --- 7. Programmatically verify the progress notification appears.
    //     This replaces the unstable visual screenshot check.
    const progress = workbox.locator('.notification-toast', { hasText: 'SVSCH' });
    await progress.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(progress).toContainText(/Extracting|Elaborating/);

    const webviewIframe = workbox
      .frameLocator('iframe.webview')
      .frameLocator('iframe#active-frame');

    // --- 8. Poll until the first graph arrives. Older supported VS Code
    //     builds can take longer to cold-start the extension and Surelog.
    let loaded = false;
    for (let i = 0; i < 180; i++) {
      loaded = await evaluateInVSCode((vscode) => {
        void vscode;
        return ((global as any).__svschGraphCount ?? 0) > 0;
      });
      if (loaded) break;
      await workbox.waitForTimeout(500);
    }

    // The extension-host postMessage interceptor can miss the first graph on
    // some VS Code builds even though the webview has rendered. Treat the
    // visible diagram shell as the authoritative fallback.
    if (!loaded) {
      loaded = await webviewIframe
        .locator('.shell select[aria-label="Module"]')
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
    }
    expect(loaded, 'Expected graph to be received by webview').toBe(true);

    // Let the React render settle before snapshotting.
    await webviewIframe.locator('.react-flow__node').first().waitFor();
    await waitForViewportToSettle(webviewIframe);
    await workbox.waitForTimeout(1_000);

    // Verify the webview iframe exists
    try {
      await expect(webviewIframe.locator('.shell')).toBeVisible({ timeout: 20_000 });
    } catch (e) {
      const html = await workbox
        .mainFrame()
        .locator('body')
        .innerHTML()
        .catch(() => 'could not capture body');
      console.log('--- WORKBOX BODY HTML ---');
      console.log(html);
      console.log('--- END WORKBOX BODY HTML ---');

      const webviewHtml = await workbox
        .frameLocator('iframe.webview')
        .locator('body')
        .innerHTML()
        .catch(() => 'could not capture webview body');
      console.log('--- WEBVIEW BODY HTML ---');
      console.log(webviewHtml);
      console.log('--- END WEBVIEW BODY HTML ---');
      throw e;
    }

    // Dismiss any notifications that appeared during parsing.
    for (const button of await workbox
      .locator('.notification-toast button', { hasText: /Never|Don't show/i })
      .all()) {
      await button.click().catch(() => {});
    }

    // --- 9. Snapshot the full VSCode window for the first module.
    //     Note: VSCode webview panels render in cross-origin iframes
    //     (vscode-webview:// vs vscode-file://) which Playwright cannot
    //     access from the main page context. The full-window snapshot is
    //     the primary visual regression artifact for system tests.
    await expect(workbox).toHaveScreenshot('full-window.png');

    // --- 10. Switch to a different module via the dropdown.
    //     We prioritize a complex module to ensure meaningful screenshots.
    const switchedViaHost = await evaluateInVSCode((vscode) => {
      void vscode;
      const modules: string[] = (global as any).__svschModules ?? [];
      const complexModule = modules.find((m) => m === 'aggregate_assignment_showcase');
      const next =
        complexModule || modules.find((m: string) => m !== (global as any).__svschCurrentModule);

      if (
        !next ||
        next === (global as any).__svschCurrentModule ||
        !(global as any).__svschFireWebviewMessage
      )
        return false;

      (global as any).__svschGraphCountBeforeSwitch = (global as any).__svschGraphCount ?? 0;
      (global as any).__svschFireWebviewMessage({ type: 'openModule', moduleName: next });
      return true;
    });

    if (switchedViaHost) {
      // Poll until the extension has sent the new graph (max 15 s).
      for (let i = 0; i < 30; i++) {
        const received: boolean = await evaluateInVSCode((vscode) => {
          void vscode;
          const before: number = (global as any).__svschGraphCountBeforeSwitch ?? 0;
          const now: number = (global as any).__svschGraphCount ?? 0;
          return now > before;
        });
        if (received) break;
        await workbox.waitForTimeout(500);
      }
    } else {
      const moduleSelect = webviewIframe.locator('select[aria-label="Module"]');
      const next = await moduleSelect.locator('option').evaluateAll((options) => {
        const values = options.map((option) => (option as HTMLOptionElement).value);
        const selected = options.find((option) => (option as HTMLOptionElement).selected) as
          HTMLOptionElement | undefined;
        return (
          values.find((value) => value === 'aggregate_assignment_showcase') ??
          values.find((value) => value !== selected?.value) ??
          ''
        );
      });
      if (next) {
        await moduleSelect.selectOption(next);
      }
    }

    // Let the React render settle before snapshotting.
    await webviewIframe.locator('.react-flow__node').first().waitFor();
    await waitForViewportToSettle(webviewIframe);
    await workbox.waitForTimeout(1_000);

    await expect(workbox).toHaveScreenshot('full-window-second-module.png');
  } finally {
    // --- 11. Collect captured log lines (even on failure).
    const logs: string[] = await evaluateInVSCode((vscode) => {
      void vscode;
      return (global as any).__svschLogs ?? [];
    }).catch(() => []);

    const combinedLogs = [...logs, ...webviewLogs];
    fs.writeFileSync(path.join(logDir, 'svsch-output.log'), combinedLogs.join('\n'), 'utf8');

    if (logs.length) {
      console.log('--- SVSCH OUTPUT LOGS ---');
      console.log(logs.join('\n'));
      console.log('--- END SVSCH OUTPUT LOGS ---');
    }

    if (webviewLogs.length) {
      console.log('--- WEBVIEW CONSOLE LOGS ---');
      console.log(webviewLogs.join('\n'));
      console.log('--- END WEBVIEW CONSOLE LOGS ---');
    }
  }
});

test('preserves moved node positions after editing a connection route', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await clearSystemLayout();

  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    await openSystemModule(workbox, webview, evaluateInVSCode, 'assign_wire');

    const sourceId = await findSystemNodeId(webview, 'a', 'port');
    const targetId = await findSystemNodeId(webview, 'y', 'port');
    if (!sourceId || !targetId) {
      throw new Error(`Could not find assign_wire ports: a=${sourceId}, y=${targetId}`);
    }
    const edgeId = await findSystemEdgeId(webview, sourceId, targetId);
    if (!edgeId) {
      throw new Error(`Could not find connection between ${sourceId} and ${targetId}`);
    }

    await dragSystemNodeByGridCells(workbox, webview, sourceId, 0, -2);
    const movedPosition = await systemNodePosition(webview, sourceId);
    await waitForSystemNodePersisted(sourceId, movedPosition);

    await dragSystemConnectionSegmentByGridCells(workbox, webview, edgeId, -1);

    await expect
      .poll(
        async () => {
          const current = await systemNodePosition(webview, sourceId);
          return closeTo(current.x, movedPosition.x) && closeTo(current.y, movedPosition.y);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await clearSystemLayout();
  }
});

test('flags a module port dragged into a generate block', async ({ workbox, evaluateInVSCode }) => {
  await clearSystemLayout();

  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    await openSystemModule(workbox, webview, evaluateInVSCode, 'generate_arm_intrusion');

    const arm = webview.locator('.generate-region:not(.generate-block)').first();
    const block = webview.locator('.generate-region.generate-block').first();
    await arm.waitFor({ state: 'visible', timeout: 30_000 });

    const portId = await findSystemNodeId(webview, 'a', 'port');
    if (!portId) {
      throw new Error('Could not find module port "a"');
    }
    const portNode = webview.locator(`.react-flow__node[data-id="${portId}"]`);

    // The module port sits at the edge of the diagram, well outside the generate
    // block, so it is not flagged before the drag. (A port could never be flagged
    // at all before the fix — the validation skipped every port.)
    await expect(portNode).not.toHaveClass(/svsch-node-invalid/);

    // Drag the port on top of the generate arm.
    await dragSystemNodeOntoRegion(workbox, webview, portId, arm);

    // The intruding port now shows the shared error outline, and both the arm and
    // its enclosing generate block are flagged as containing an unrelated block.
    await expect(portNode).toHaveClass(/svsch-node-invalid/, { timeout: 15_000 });
    await expect(arm).toHaveClass(/generate-region-invalid/, { timeout: 15_000 });
    await expect(block).toHaveClass(/generate-region-invalid/, { timeout: 15_000 });
  } finally {
    await clearSystemLayout();
  }
});

test('hides the block-selection toolbar when only a cut net label is selected', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await clearSystemLayout();

  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    await openSystemModule(workbox, webview, evaluateInVSCode, 'generate_arm_intrusion');

    const blockId = await findSystemNodeId(webview, 'u_free', 'instance');
    if (!blockId) {
      throw new Error('Could not find block "u_free"');
    }
    await clickSystemNode(workbox, webview, blockId);

    const cutOutButton = webview.locator('.svsch-selection-toolbar button', { hasText: 'Cut out' });
    await expect(cutOutButton).toBeVisible();
    await cutOutButton.click();

    let labelId: string | null = null;
    await expect
      .poll(
        async () => {
          labelId = await findSystemCutLabelIdAttachedTo(webview, blockId);
          return labelId !== null;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // The cut instance and its newly-created cut-net-end stub should already
    // be selected, so the user can immediately drag the group without
    // re-selecting anything (issue #361).
    await expect(webview.locator(`.react-flow__node[data-id="${blockId}"]`)).toHaveClass(
      /selected/,
    );
    await expect(webview.locator(`.react-flow__node[data-id="${labelId}"]`)).toHaveClass(
      /selected/,
    );

    await clickSystemNode(workbox, webview, labelId!);

    await expect(
      webview.locator('.svsch-selection-toolbar button', { hasText: 'Auto Layout' }),
    ).toHaveCount(0);
    await expect(
      webview.locator('.svsch-selection-toolbar button', { hasText: 'Cut out' }),
    ).toHaveCount(0);
  } finally {
    await clearSystemLayout();
  }
});

test("reselects only the cut-out block's own net-end stubs, and moves them along with it", async ({
  workbox,
  evaluateInVSCode,
}) => {
  await clearSystemLayout();

  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    await openSystemModule(workbox, webview, evaluateInVSCode, 'generate_arm_intrusion');

    const blockId = await findSystemNodeId(webview, 'u_free', 'instance');
    if (!blockId) {
      throw new Error('Could not find block "u_free"');
    }
    await clickSystemNode(workbox, webview, blockId);

    const cutOutButton = webview.locator('.svsch-selection-toolbar button', { hasText: 'Cut out' });
    await expect(cutOutButton).toBeVisible();
    await cutOutButton.click();

    // u_free sits on two nets crossing the cut boundary — the incoming "a" net
    // and the outgoing "z" net — so cutting it produces four stub labels: one
    // on u_free's own side of each net, and one on the far side (the module's
    // "a"/"z" boundary ports, which aren't part of this selection).
    let stubs: { attached: string[]; other: string[] } = { attached: [], other: [] };
    await expect
      .poll(
        async () => {
          stubs = await findSystemCutStubsForBlock(webview, blockId);
          return stubs.attached.length === 2 && stubs.other.length === 2;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const { attached, other } = stubs;

    // The block and the stubs landing on it should already be selected
    // (issue #361); the stubs on the far side, attached to the untouched
    // boundary ports, should not have been swept into the group.
    await expect(webview.locator(`.react-flow__node[data-id="${blockId}"]`)).toHaveClass(
      /selected/,
    );
    for (const id of attached) {
      await expect(webview.locator(`.react-flow__node[data-id="${id}"]`)).toHaveClass(/selected/);
    }
    for (const id of other) {
      await expect(webview.locator(`.react-flow__node[data-id="${id}"]`)).not.toHaveClass(
        /selected/,
      );
    }

    const positionsBefore = await Promise.all(
      attached.map((id) => systemNodePosition(webview, id)),
    );

    await dragSystemNodeByGridCells(workbox, webview, blockId, 4, 4);

    // Dragging any node in a multi-selection moves the whole selection
    // together, so each reselected stub should have shifted by exactly the
    // same delta as the block it's still attached to.
    for (let i = 0; i < attached.length; i++) {
      const before = positionsBefore[i];
      const after = await systemNodePosition(webview, attached[i]);
      expect(closeTo(after.x, before.x + 4 * SYSTEM_GRID_SIZE)).toBe(true);
      expect(closeTo(after.y, before.y + 4 * SYSTEM_GRID_SIZE)).toBe(true);
    }

    await dismissSystemNotifications(workbox);
    // Zoom to fit so the selection highlight on the moved block and its
    // stubs is actually legible in the screenshot, rather than a few pixels
    // in a wide, mostly-empty canvas.
    await webview
      .locator('html')
      .evaluate(() => (window as any).reactFlowInstance?.fitView({ padding: 0.2, duration: 0 }));
    await workbox.waitForTimeout(300);
    await webview.locator('.canvas').hover({ position: { x: 8, y: 8 }, force: true });
    await expect(workbox).toHaveScreenshot('cut-out-block-move-carries-its-selected-stubs.png');
  } finally {
    await clearSystemLayout();
  }
});

const SYSTEM_NODE_RESIZE_CASES = [
  { kind: 'side', handle: 'right', cellsX: 3, cellsY: 0 },
  { kind: 'side', handle: 'bottom', cellsX: 0, cellsY: 3 },
  { kind: 'side', handle: 'left', cellsX: -3, cellsY: 0 },
  { kind: 'side', handle: 'top', cellsX: 0, cellsY: -3 },
  { kind: 'corner', handle: 'bottom-right', cellsX: 3, cellsY: 3 },
  { kind: 'corner', handle: 'top-right', cellsX: 3, cellsY: -3 },
  { kind: 'corner', handle: 'bottom-left', cellsX: -3, cellsY: 3 },
  { kind: 'corner', handle: 'top-left', cellsX: -3, cellsY: -3 },
] as const;

for (const resizeCase of SYSTEM_NODE_RESIZE_CASES) {
  test(`resizes a register from the ${resizeCase.handle} ${resizeCase.kind} and preserves it after reload`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    await clearSystemLayout();

    try {
      await resizeSystemRegisterAndAssertPersistence(workbox, evaluateInVSCode, resizeCase);
    } finally {
      await clearSystemLayout();
    }
  });
}

test('renders a resized node at its grown size when exporting the diagram as SVG', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await clearSystemLayout();
  const exportedSvgPath = path.resolve(__dirname, '../register_async_reset.svg');
  await fs.promises.rm(exportedSvgPath, { force: true });

  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    await openSystemModule(workbox, webview, evaluateInVSCode, 'register_async_reset');

    const nodeId = await findSystemNodeId(webview, 'q', 'register');
    if (!nodeId) {
      throw new Error('Could not find register "q"');
    }

    const canonicalSize = await systemNodeSize(webview, nodeId);
    await dragSystemNodeResizeHandle(workbox, webview, nodeId, 'bottom-right', 3, 3);
    const resizedSize = await systemNodeSize(webview, nodeId);
    await assertSystemRegisterResetPortAnchored(webview, nodeId, resizedSize);
    await waitForSystemNodeSizePersisted(
      'register_async_reset',
      nodeId,
      resizedSize.width / SYSTEM_GRID_SIZE,
      resizedSize.height / SYSTEM_GRID_SIZE,
    );

    await setSystemSaveDialogTarget(evaluateInVSCode, exportedSvgPath);
    await webview.locator('button:has-text("Export SVG")').click();

    // The save dialog is intercepted above so this test can focus on the real
    // export handler, renderer, and file write without automating a native OS
    // dialog that Playwright cannot inspect.
    await expect.poll(() => fs.existsSync(exportedSvgPath), { timeout: 10_000 }).toBe(true);
    const { width, height } = await readExportedNodeSvgSize(exportedSvgPath, nodeId);

    // Locks in the svgRenderer.ts fix: exported markup must reflect the grown
    // (resolved) size, not the pure canonical auto-fit size.
    expect(width).toBeGreaterThan(canonicalSize.width);
    expect(height).toBeGreaterThan(canonicalSize.height);
    expect(closeTo(width, resizedSize.width)).toBe(true);
    expect(closeTo(height, resizedSize.height)).toBe(true);
  } finally {
    await restoreSystemSaveDialog(evaluateInVSCode).catch(() => {});
    await fs.promises.rm(exportedSvgPath, { force: true });
    await clearSystemLayout();
  }
});

// "Expand instance in place" (issue #232) only offers its own Expand control
// on an instance's own module view — a freshly-spliced nested instance shows
// none (issue #233's "cannot be expanded directly" rule). Recursive nesting
// is achieved instead by inheritance: splicing a child module in also
// replays whichever of the child's own instances are already marked
// expanded in the child's own saved layout. So building a 10-level-deep
// expansion means walking nest_level1..nest_level9 (fixture in
// expand_nesting_chain.sv) bottom-up, expanding each one's own "u_inner"
// once, before finally expanding nest_top's "u_inner" — which then inherits
// the whole chain down to the innermost AND gate in one shot.
test('expands ten nested levels down to an AND gate and captures the final view', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await clearSystemLayout();

  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    for (let level = 1; level <= 9; level++) {
      const moduleName = `nest_level${level}`;
      await openSystemModule(workbox, webview, evaluateInVSCode, moduleName);

      const instanceId = await findSystemNodeId(webview, 'u_inner', 'instance');
      if (!instanceId) {
        throw new Error(`Could not find instance "u_inner" in module ${moduleName}`);
      }
      await clickSystemNode(workbox, webview, instanceId);
      await clickSystemToolbarButton(workbox, webview, 'Expand');
    }

    await openSystemModule(workbox, webview, evaluateInVSCode, 'nest_top');
    const topInstanceId = await findSystemNodeId(webview, 'u_inner', 'instance');
    if (!topInstanceId) {
      throw new Error('Could not find instance "u_inner" in module nest_top');
    }
    await clickSystemNode(workbox, webview, topInstanceId);
    await clickSystemToolbarButton(workbox, webview, 'Expand');

    // The AND gate only exists at the very bottom of the chain, so its
    // presence confirms every intermediate level was inherited correctly.
    await expect
      .poll(
        async () =>
          webview.locator('html').evaluate(() => {
            const rf = (window as any).reactFlowInstance;
            return rf?.getNodes?.().some((node: any) => node.data?.node?.kind === 'gate') ?? false;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);

    await waitForViewportToSettle(webview);
    await webview
      .locator('html')
      .evaluate(() => (window as any).reactFlowInstance?.fitView({ padding: 0.1, duration: 0 }));
    await workbox.waitForTimeout(500);
    await dismissSystemNotifications(workbox);

    await expect(workbox).toHaveScreenshot('expand-ten-levels-nested.png');
  } finally {
    await clearSystemLayout();
  }
});

const SYSTEM_GRID_SIZE = 24;

async function setSystemSaveDialogTarget(
  evaluateInVSCode: EvaluateInVSCode,
  outputPath: string,
): Promise<void> {
  await evaluateInVSCode((vscode, targetPath) => {
    if (!(global as any).__svschOriginalShowSaveDialog) {
      (global as any).__svschOriginalShowSaveDialog = vscode.window.showSaveDialog;
    }
    vscode.window.showSaveDialog = async () => vscode.Uri.file(targetPath);
  }, outputPath);
}

async function restoreSystemSaveDialog(evaluateInVSCode: EvaluateInVSCode): Promise<void> {
  await evaluateInVSCode((vscode) => {
    const original = (global as any).__svschOriginalShowSaveDialog;
    if (!original) return;
    vscode.window.showSaveDialog = original;
    delete (global as any).__svschOriginalShowSaveDialog;
  });
}

// Mirrors the BDD "I close and reopen the diagram" step: actually tears down
// the SVSCH tab (which disposes the DiagramPanel — see extension.ts's
// getPanel() — dropping all in-memory graph/layout state), then reopens it,
// so a resized node coming back correctly can only be explained by the size
// override having round-tripped through disk, not leftover React state.
async function closeAndReopenSystemDiagram(
  workbox: Page,
  evaluateInVSCode: EvaluateInVSCode,
): Promise<void> {
  const tab = workbox.locator('.tab[aria-label*="SVSCH"], .tab[title*="SVSCH"]').first();
  if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await tab.click();
    await evaluateInVSCode((vscode) =>
      vscode.commands.executeCommand('workbench.action.closeActiveEditor'),
    );
    await tab.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  }
  await workbox.waitForTimeout(300);
  await openSystemDiagram(workbox, evaluateInVSCode);
}

async function resizeSystemRegisterAndAssertPersistence(
  workbox: Page,
  evaluateInVSCode: EvaluateInVSCode,
  resizeCase: (typeof SYSTEM_NODE_RESIZE_CASES)[number],
): Promise<void> {
  await openSystemDiagram(workbox, evaluateInVSCode);

  let webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
  await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });
  await openSystemModule(workbox, webview, evaluateInVSCode, 'register_async_reset');

  const nodeId = await findSystemNodeId(webview, 'q', 'register');
  if (!nodeId) {
    throw new Error('Could not find register "q"');
  }

  const originalSize = await systemNodeSize(webview, nodeId);
  const originalPosition = await systemNodePosition(webview, nodeId);
  await dragSystemNodeResizeHandle(
    workbox,
    webview,
    nodeId,
    resizeCase.handle,
    resizeCase.cellsX,
    resizeCase.cellsY,
  );
  const resizedSize = await systemNodeSize(webview, nodeId);
  const resizedPosition = await systemNodePosition(webview, nodeId);
  await assertSystemRegisterResetPortAnchored(webview, nodeId, resizedSize);

  if (resizeCase.cellsX !== 0) {
    expect(resizedSize.width - originalSize.width).toBeGreaterThanOrEqual(SYSTEM_GRID_SIZE * 2);
  } else {
    expect(closeTo(resizedSize.width, originalSize.width)).toBe(true);
  }
  if (resizeCase.cellsY !== 0) {
    expect(resizedSize.height - originalSize.height).toBeGreaterThanOrEqual(SYSTEM_GRID_SIZE * 2);
  } else {
    expect(closeTo(resizedSize.height, originalSize.height)).toBe(true);
  }

  if (resizeCase.handle.includes('left')) {
    expect(resizedPosition.x).toBeLessThan(originalPosition.x);
  } else {
    expect(closeTo(resizedPosition.x, originalPosition.x)).toBe(true);
  }
  if (resizeCase.handle.includes('top')) {
    expect(resizedPosition.y).toBeLessThan(originalPosition.y);
  } else {
    expect(closeTo(resizedPosition.y, originalPosition.y)).toBe(true);
  }

  await waitForSystemNodeResizePersisted(
    'register_async_reset',
    nodeId,
    resizedSize,
    resizedPosition,
  );

  await closeAndReopenSystemDiagram(workbox, evaluateInVSCode);
  webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
  await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });
  await openSystemModule(workbox, webview, evaluateInVSCode, 'register_async_reset');

  const reopenedNodeId = await findSystemNodeId(webview, 'q', 'register');
  if (!reopenedNodeId) {
    throw new Error(
      `Could not find register "q" after reopening the ${resizeCase.handle} resize case`,
    );
  }
  // closeAndReopenSystemDiagram tears the panel all the way down and rebuilds
  // it from disk (webview reload, module re-elaboration, ELK re-layout), so
  // this is the heaviest round-trip in the suite. 10s cut it too close under
  // CI's shared-runner load and produced a one-off timeout (see PR #272 CI
  // run 32809807973) despite the persisted state already being correct.
  await expect
    .poll(
      async () => {
        const reopenedSize = await systemNodeSize(webview, reopenedNodeId);
        const reopenedPosition = await systemNodePosition(webview, reopenedNodeId);
        return (
          closeTo(reopenedSize.width, resizedSize.width) &&
          closeTo(reopenedSize.height, resizedSize.height) &&
          closeTo(reopenedPosition.x, resizedPosition.x) &&
          closeTo(reopenedPosition.y, resizedPosition.y)
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await assertSystemRegisterResetPortAnchored(webview, reopenedNodeId, resizedSize);

  // Lock the final, disk-restored rendering for every resize handle. Keeping
  // the screenshot after the reopen makes the visual assertion cover both the
  // direction-specific geometry and its persisted representation.
  await dismissSystemNotifications(workbox);
  await webview.locator('.canvas').hover({ position: { x: 8, y: 8 }, force: true });
  await expect(workbox).toHaveScreenshot(`register-resized-${resizeCase.handle}-after-reload.png`);
}

async function assertSystemRegisterResetPortAnchored(
  webview: FrameLocator,
  nodeId: string,
  nodeSize: { width: number; height: number },
): Promise<void> {
  const node = webview.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const resetHandle = node.locator('.react-flow__handle-bottom');
  const resetLabel = node.locator('.svsch-register-reset-label');

  await expect(resetHandle).toHaveCount(1);
  await expect(resetLabel).toHaveCount(1);
  const geometry = await node.evaluate((element) => {
    const handle = element.querySelector<HTMLElement>('.react-flow__handle-bottom');
    const label = element.querySelector<SVGTextElement>('.svsch-register-reset-label');
    if (!handle || !label) return null;
    return {
      handleLeft: Number.parseFloat(handle.style.left),
      handleBottom: Number.parseFloat(handle.style.bottom),
      labelX: Number.parseFloat(label.getAttribute('x') ?? ''),
      labelY: Number.parseFloat(label.getAttribute('y') ?? ''),
    };
  });

  expect(geometry).not.toBeNull();
  expect(closeTo(geometry!.handleLeft, nodeSize.width / 2)).toBe(true);
  expect(closeTo(geometry!.handleBottom, 0)).toBe(true);
  expect(closeTo(geometry!.labelX, nodeSize.width / 2)).toBe(true);
  expect(closeTo(geometry!.labelY, nodeSize.height - SYSTEM_GRID_SIZE / 2)).toBe(true);
}

async function findSystemNodeId(
  webview: FrameLocator,
  label: string,
  kind?: string,
): Promise<string | null> {
  return webview.locator('html').evaluate(
    (_element, { wantedLabel, wantedKind }) => {
      const rf = (window as any).reactFlowInstance;
      const node = rf
        ?.getNodes?.()
        .find(
          (candidate: any) =>
            candidate.data?.node?.label === wantedLabel &&
            (!wantedKind || candidate.data?.node?.kind === wantedKind),
        );
      if (node) return node.id;

      const domNodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const domNode = domNodes.find((element) => {
        if (wantedKind && !element.querySelector(`[data-node-kind="${wantedKind}"]`)) return false;
        const labels = Array.from(
          element.querySelectorAll(
            '.port-skin-label,.node-title,.node-kind,.svsch-node-title,.svsch-node-kind,' +
              '.svsch-port-label',
          ),
        )
          .map((child) => child.textContent?.trim())
          .filter(Boolean);
        return labels.includes(wantedLabel);
      });
      return domNode?.getAttribute('data-id') ?? null;
    },
    { wantedLabel: label, wantedKind: kind },
  );
}

async function findSystemEdgeId(
  webview: FrameLocator,
  sourceId: string,
  targetId: string,
): Promise<string | null> {
  return webview.locator('html').evaluate(
    (_element, { source, target }) => {
      const rf = (window as any).reactFlowInstance;
      const edge = rf
        ?.getEdges?.()
        .find((candidate: any) => candidate.source === source && candidate.target === target);
      return edge?.id ?? null;
    },
    { source: sourceId, target: targetId },
  );
}

async function clickSystemNode(
  workbox: Page,
  webview: FrameLocator,
  nodeId: string,
): Promise<void> {
  const box = await webview.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  if (!box) {
    throw new Error(`Could not get node box for ${nodeId}`);
  }
  await workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect
    .poll(
      async () =>
        webview.locator('html').evaluate((_element, id) => {
          const rf = (window as any).reactFlowInstance;
          return rf?.getNode?.(id)?.selected ?? false;
        }, nodeId),
      { timeout: 5_000 },
    )
    .toBe(true);
}

// Mirrors the BDD "I click the {string} button" step: clicking a selection
// toolbar action (e.g. Expand) round-trips through the extension host, so
// wait on the on-disk layout actually changing rather than a fixed delay.
// An expanded frame can also push the toolbar past the viewport edge (it
// mirrors the child's full standalone width) — fit the view first when that
// happens, same as the BDD step does.
async function clickSystemToolbarButton(
  workbox: Page,
  webview: FrameLocator,
  label: string,
): Promise<void> {
  const before = JSON.stringify(await readSystemLayout());
  const button = webview.locator('.svsch-selection-toolbar button', { hasText: label });
  await expect(button).toBeVisible();

  const box = await button.boundingBox();
  const viewport = workbox.viewportSize();
  const offScreen =
    !box ||
    box.x < 0 ||
    box.y < 0 ||
    (viewport !== null &&
      (box.x + box.width > viewport.width || box.y + box.height > viewport.height));
  if (offScreen) {
    await webview
      .locator('html')
      .evaluate(() => (window as any).reactFlowInstance?.fitView({ padding: 0.1, duration: 0 }));
    await workbox.waitForTimeout(300);
  }

  await button.click();
  await expect
    .poll(async () => JSON.stringify(await readSystemLayout()) !== before, { timeout: 15_000 })
    .toBe(true);
}

async function findSystemCutLabelIdAttachedTo(
  webview: FrameLocator,
  blockId: string,
): Promise<string | null> {
  return webview.locator('html').evaluate((_element, id) => {
    const rf = (window as any).reactFlowInstance;
    const nodesById = new Map(rf.getNodes().map((n: any) => [n.id, n]));
    const stub = rf
      .getEdges()
      .find(
        (e: any) =>
          (e.source === id || e.target === id) && e.data?.edge?.metadata?.cutStub !== undefined,
      );
    if (!stub) return null;
    const otherEndId = stub.source === id ? stub.target : stub.source;
    const otherNode = nodesById.get(otherEndId) as any;
    return otherNode?.data?.node?.kind === 'netLabel' ? otherEndId : null;
  }, blockId);
}

// For every net a cut-out block sits on, the cut produces a stub at *both*
// ends: one landing on the block itself, one landing on whatever the net's
// other side was (another block, or a module boundary port). Only the
// former belongs in the block's reselected group — this partitions a
// block's cut-net-end stub ids into the two buckets so a test can assert
// on each side independently (issue #362 follow-up).
async function findSystemCutStubsForBlock(
  webview: FrameLocator,
  blockId: string,
): Promise<{ attached: string[]; other: string[] }> {
  return webview.locator('html').evaluate((_element, id) => {
    const rf = (window as any).reactFlowInstance;
    const nodesById = new Map(rf.getNodes().map((n: any) => [n.id, n]));
    const cutStubEdges = rf
      .getEdges()
      .filter((e: any) => e.data?.edge?.metadata?.cutStub !== undefined);
    const netKeys = new Set(
      cutStubEdges
        .filter((e: any) => e.source === id || e.target === id)
        .map((e: any) => e.data.edge.metadata.cutStub.netKey),
    );
    const attached = new Set<string>();
    const other = new Set<string>();
    for (const e of cutStubEdges) {
      const netKey = e.data.edge.metadata.cutStub.netKey;
      if (!netKeys.has(netKey)) continue;
      const touchesBlock = e.source === id || e.target === id;
      const sourceNode = nodesById.get(e.source) as any;
      const targetNode = nodesById.get(e.target) as any;
      const stubEndId =
        sourceNode?.data?.node?.kind === 'netLabel'
          ? e.source
          : targetNode?.data?.node?.kind === 'netLabel'
            ? e.target
            : null;
      if (stubEndId === null) continue;
      (touchesBlock ? attached : other).add(stubEndId);
    }
    return { attached: Array.from(attached), other: Array.from(other) };
  }, blockId);
}

async function systemNodePosition(
  webview: FrameLocator,
  nodeId: string,
): Promise<{ x: number; y: number }> {
  return webview.locator('html').evaluate((_element, id) => {
    const rf = (window as any).reactFlowInstance;
    const node = rf?.getNode?.(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }
    return { x: Math.round(node.position.x), y: Math.round(node.position.y) };
  }, nodeId);
}

async function systemZoom(webview: FrameLocator): Promise<number> {
  return webview
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport?.().zoom ?? 1);
}

// A resizable node's actual rendered box comes from the --svsch-node-width/
// height custom properties set inline on its .hdl-node button (see HdlNode.tsx),
// which is unzoomed content-space px — no zoom correction needed, unlike a
// boundingBox() read.
async function systemNodeSize(
  webview: FrameLocator,
  nodeId: string,
): Promise<{ width: number; height: number }> {
  return webview.locator(`.react-flow__node[data-id="${nodeId}"] .hdl-node`).evaluate((element) => {
    const style = getComputedStyle(element as HTMLElement);
    return {
      width: Math.round(parseFloat(style.width)),
      height: Math.round(parseFloat(style.height)),
    };
  });
}

// The webview sits to the right of VS Code's activity/explorer sidebar, whose
// width varies across VS Code versions. A node panned near the left edge of
// the canvas can end up rendered underneath that sidebar, so raw-coordinate
// mouse drags miss it entirely. Pan the canvas right until every box involved
// clears a safe margin before computing drag coordinates.
const SYSTEM_DRAG_SAFE_MARGIN_PX = 420;

async function panSystemFlowClear(
  webview: FrameLocator,
  boxes: Array<{ x: number } | null>,
): Promise<boolean> {
  const xs = boxes.filter((box): box is { x: number } => box !== null).map((box) => box.x);
  const minX = Math.min(...xs);
  if (!Number.isFinite(minX) || minX >= SYSTEM_DRAG_SAFE_MARGIN_PX) {
    return false;
  }
  const delta = SYSTEM_DRAG_SAFE_MARGIN_PX - minX;
  await webview.locator('html').evaluate((_element, dx) => {
    const rf = (window as any).reactFlowInstance;
    const viewport = rf?.getViewport?.();
    if (!rf || !viewport) return;
    rf.setViewport({ ...viewport, x: viewport.x + dx });
  }, delta);
  return true;
}

async function dragSystemNodeByGridCells(
  workbox: Page,
  webview: FrameLocator,
  nodeId: string,
  cellsX: number,
  cellsY: number,
): Promise<void> {
  const node = webview.locator(`.react-flow__node[data-id="${nodeId}"]`);
  let box = await node.boundingBox();
  if (!box) {
    throw new Error(`Could not get node box for ${nodeId}`);
  }
  if (await panSystemFlowClear(webview, [box])) {
    await workbox.waitForTimeout(100);
    box = await node.boundingBox();
    if (!box) {
      throw new Error(`Could not get node box for ${nodeId}`);
    }
  }
  const before = await systemNodePosition(webview, nodeId);
  const zoom = await systemZoom(webview);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await workbox.mouse.move(startX, startY);
  await workbox.mouse.down();
  await workbox.mouse.move(
    startX + cellsX * SYSTEM_GRID_SIZE * zoom,
    startY + cellsY * SYSTEM_GRID_SIZE * zoom,
    { steps: 12 },
  );
  await workbox.mouse.up();

  await expect
    .poll(
      async () => {
        const current = await systemNodePosition(webview, nodeId);
        return !closeTo(current.x, before.x) || !closeTo(current.y, before.y);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

// Drags one of the 8 block-resize hit-zones (see HdlNode.tsx's
// svsch-node-resize-{handle} divs) by a grid-cell delta, same zoom-aware
// pattern as dragSystemNodeByGridCells but targeting the tiny handle strip
// instead of the node body. cellsX/cellsY carry the sign convention
// resizeNodeBounds (main.tsx) expects — e.g. a negative cellsX grows width
// via the left handle by moving the pointer left, not by "shrinking".
async function dragSystemNodeResizeHandle(
  workbox: Page,
  webview: FrameLocator,
  nodeId: string,
  handle: string,
  cellsX: number,
  cellsY: number,
): Promise<void> {
  const handleLocator = webview.locator(
    `.react-flow__node[data-id="${nodeId}"] .svsch-node-resize-${handle}`,
  );
  let box = await handleLocator.boundingBox();
  if (!box) {
    throw new Error(`Could not get resize handle box for ${nodeId} ${handle}`);
  }
  if (await panSystemFlowClear(webview, [box])) {
    await workbox.waitForTimeout(100);
    box = await handleLocator.boundingBox();
    if (!box) {
      throw new Error(`Could not get resize handle box for ${nodeId} ${handle}`);
    }
  }
  const before = await systemNodeSize(webview, nodeId);
  const zoom = await systemZoom(webview);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const endX = startX + cellsX * SYSTEM_GRID_SIZE * zoom;
  const endY = startY + cellsY * SYSTEM_GRID_SIZE * zoom;

  await workbox.mouse.move(startX, startY);
  await workbox.mouse.down();
  // A small first move primes react-flow's pointer-capture before the
  // full-distance move, same as dragSystemNodeByGridCells's multi-step drags.
  await workbox.mouse.move(startX + Math.sign(cellsX) * 2, startY + Math.sign(cellsY) * 2, {
    steps: 3,
  });
  await workbox.mouse.move(endX, endY, { steps: 12 });
  await workbox.mouse.up();

  await expect
    .poll(
      async () => {
        const current = await systemNodeSize(webview, nodeId);
        return !closeTo(current.width, before.width) || !closeTo(current.height, before.height);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function dragSystemNodeOntoRegion(
  workbox: Page,
  webview: FrameLocator,
  nodeId: string,
  region: Locator,
): Promise<void> {
  const node = webview.locator(`.react-flow__node[data-id="${nodeId}"]`);
  let nodeBox = await node.boundingBox();
  let regionBox = await region.boundingBox();
  if (!nodeBox || !regionBox) {
    throw new Error(`Could not get boxes for node ${nodeId} / target region`);
  }
  if (await panSystemFlowClear(webview, [nodeBox, regionBox])) {
    await workbox.waitForTimeout(100);
    nodeBox = await node.boundingBox();
    regionBox = await region.boundingBox();
    if (!nodeBox || !regionBox) {
      throw new Error(`Could not get boxes for node ${nodeId} / target region`);
    }
  }
  const before = await systemNodePosition(webview, nodeId);
  const startX = nodeBox.x + nodeBox.width / 2;
  const startY = nodeBox.y + nodeBox.height / 2;
  const endX = regionBox.x + regionBox.width / 2;
  const endY = regionBox.y + regionBox.height / 2;

  await workbox.mouse.move(startX, startY);
  await workbox.mouse.down();
  await workbox.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 10 });
  await workbox.mouse.move(endX, endY, { steps: 10 });
  await workbox.mouse.up();

  await expect
    .poll(
      async () => {
        const current = await systemNodePosition(webview, nodeId);
        return !closeTo(current.x, before.x) || !closeTo(current.y, before.y);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function dragSystemConnectionSegmentByGridCells(
  workbox: Page,
  webview: FrameLocator,
  edgeId: string,
  cellsY: number,
): Promise<void> {
  const edge = webview.locator(`.react-flow__edge[data-id="${edgeId}"]`);
  await edge.locator('path.svsch-edge-bridge').hover({ force: true });
  await workbox.waitForTimeout(200);

  const handles = edge.locator('path.svsch-edge-segment-horizontal');
  const count = await handles.count();
  if (count === 0) {
    throw new Error(`No horizontal segment handles for ${edgeId}`);
  }

  let handle = handles.first();
  let bestWidth = -1;
  for (let i = 0; i < count; i += 1) {
    const candidate = handles.nth(i);
    const box = await candidate.boundingBox();
    if (box && box.width > bestWidth) {
      bestWidth = box.width;
      handle = candidate;
    }
  }

  const box = await handle.boundingBox();
  if (!box) {
    throw new Error(`Could not get segment handle box for ${edgeId}`);
  }

  const layoutBefore = JSON.stringify(await readSystemLayout());
  const zoom = await systemZoom(webview);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const endY = startY + cellsY * SYSTEM_GRID_SIZE * zoom;

  await workbox.mouse.move(startX, startY);
  await workbox.mouse.down();
  await workbox.mouse.move(startX, startY + Math.sign(cellsY) * 3, { steps: 3 });
  await workbox.mouse.move(startX, endY, { steps: 16 });
  await workbox.mouse.up();

  await expect
    .poll(async () => JSON.stringify(await readSystemLayout()) !== layoutBefore, {
      timeout: 10_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const layout = await readSystemLayout();
        return !!layout.modules?.assign_wire?.edges?.[edgeId]?.routePoints;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

// The extension persists each module's layout as its own file under
// .svsch/layouts/<encoded-module-name>.json (see LayoutStore) instead of one
// monolithic layout.json, so this reassembles the { version, modules } shape
// these tests assert against from whichever per-module files exist.
async function readSystemLayout(): Promise<any> {
  const modules: Record<string, any> = {};
  let entries: string[];
  try {
    entries = await fs.promises.readdir(SYSTEM_LAYOUTS_DIR);
  } catch {
    return { version: 1, modules };
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const moduleName = decodeURIComponent(entry.slice(0, -'.json'.length));
    try {
      modules[moduleName] = JSON.parse(
        await fs.promises.readFile(path.join(SYSTEM_LAYOUTS_DIR, entry), 'utf8'),
      );
    } catch {
      // Ignore a file that's mid-write; the poll loops calling this retry.
    }
  }
  return { version: 1, modules };
}

async function waitForSystemNodePersisted(
  nodeId: string,
  position: { x: number; y: number },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const layout = await readSystemLayout();
        const node = layout.modules?.assign_wire?.nodes?.[nodeId];
        return !!node && closeTo(node.x, position.x) && closeTo(node.y, position.y);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function waitForSystemNodeSizePersisted(
  moduleName: string,
  nodeId: string,
  gridWidth: number,
  gridHeight: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const layout = await readSystemLayout();
        const node = layout.modules?.[moduleName]?.nodes?.[nodeId];
        return !!node && closeTo(node.width, gridWidth) && closeTo(node.height, gridHeight);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function waitForSystemNodeResizePersisted(
  moduleName: string,
  nodeId: string,
  size: { width: number; height: number },
  position: { x: number; y: number },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const layout = await readSystemLayout();
        const node = layout.modules?.[moduleName]?.nodes?.[nodeId];
        return (
          !!node &&
          closeTo(node.width, size.width / SYSTEM_GRID_SIZE) &&
          closeTo(node.height, size.height / SYSTEM_GRID_SIZE) &&
          closeTo(node.x, position.x) &&
          closeTo(node.y, position.y)
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

// Reads a resized node's own <svg width=".." height="..> size back out of an
// exported diagram SVG (see svgRenderer.ts's renderNode(): the wrapping
// <g data-node-id="..."> is immediately followed by that nested <svg>). Scans
// a bounded window after the data-node-id match rather than parsing the whole
// document — svgo's sortAttrs minify pass can reorder width/height within a
// tag but never moves them into a different one, so this stays robust to
// minification.
async function readExportedNodeSvgSize(
  svgPath: string,
  nodeId: string,
): Promise<{ width: number; height: number }> {
  const svg = await fs.promises.readFile(svgPath, 'utf8');
  const markerIndex = svg.indexOf(`data-node-id="${nodeId}"`);
  if (markerIndex === -1) {
    throw new Error(`Exported SVG has no node ${nodeId}`);
  }
  const snippet = svg.slice(markerIndex, markerIndex + 400);
  const width = snippet.match(/width="([\d.]+)"/)?.[1];
  const height = snippet.match(/height="([\d.]+)"/)?.[1];
  if (!width || !height) {
    throw new Error(`Could not find node ${nodeId}'s <svg> size in exported markup: ${snippet}`);
  }
  return { width: parseFloat(width), height: parseFloat(height) };
}

function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}
