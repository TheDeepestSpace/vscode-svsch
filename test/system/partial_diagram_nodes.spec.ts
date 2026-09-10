import { test, expect } from 'vscode-test-playwright';
import type { FrameLocator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// "Add to Partial" coverage for every node kind the syntax book documents
// (issue #408 review thread). Rather than hand-authoring a second set of tiny
// fixtures, this reuses test/syntax-book/cases/*.yaml — the same cases the
// syntax book itself is generated and verified from (see
// test/syntax-book/syntax-book.spec.ts) — so this suite tracks the syntax
// book automatically as node kinds are added there.
//
// Deliberately ONE test with an internal loop rather than one test per node
// kind: the system suite already runs every test once per supported VS Code
// version (see vscode-versions.json / scripts/run-system-tests.js), and each
// case here needs its own from-scratch Surelog elaboration, so N separate
// tests would multiply full-VSCode-launch overhead by N — the exact kind of
// system-suite runtime growth flagged in review for this PR.
// ---------------------------------------------------------------------------

type EvaluateInVSCode = <R, Arg = void>(fn: (vscode: any, arg: Arg) => R, arg?: Arg) => Promise<R>;

const SYNTAX_BOOK_SECTION_FILES = [
  'ports.yaml',
  'modules_hierarchy.yaml',
  'registers.yaml',
  'muxes.yaml',
  'combinational_logic.yaml',
  'wiring.yaml',
  'buses.yaml',
  'structs.yaml',
  'interfaces.yaml',
  'generate.yaml',
  'other.yaml',
];
const SYNTAX_BOOK_CASES_DIR = path.resolve(__dirname, '../syntax-book/cases');

interface SyntaxBookNodeCase {
  id: string;
  files: Record<string, string>;
  module: string;
  target: { kind: string; nodeKind: string; nodeLabel: string };
}

// One representative case per distinct node kind the syntax book documents —
// the first case of that kind, in syntax-book section order. `netLabel` and
// `region` targets are excluded: "Add to Partial" only ever operates on real
// selectable blocks (see `selectedBlocks` in src/webview/main.tsx), which a
// cut-net label or a generate region is not. `interface` is excluded too:
// every syntax-book case for that kind (see ports.yaml, interfaces.yaml) uses
// `action: doubleClick` and expects a `selectedText` source-reveal — clicking
// an interface node jumps to/highlights its declaration in the .sv file
// instead of selecting it, so it can never reach the toolbar this test's loop
// needs and reliably opens the source file as the active tab instead.
const UNSELECTABLE_NODE_KINDS = new Set(['interface']);

function loadOneCasePerNodeKind(): SyntaxBookNodeCase[] {
  const byKind = new Map<string, SyntaxBookNodeCase>();
  for (const file of SYNTAX_BOOK_SECTION_FILES) {
    const filePath = path.join(SYNTAX_BOOK_CASES_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const section = yaml.load(fs.readFileSync(filePath, 'utf8')) as { cases: SyntaxBookNodeCase[] };
    for (const caseData of section.cases) {
      const target = caseData.target;
      if (
        target?.kind === 'node' &&
        target.nodeKind &&
        !UNSELECTABLE_NODE_KINDS.has(target.nodeKind) &&
        !byKind.has(target.nodeKind)
      ) {
        byKind.set(target.nodeKind, caseData);
      }
    }
  }
  return [...byKind.values()];
}

const NODE_CASES = loadOneCasePerNodeKind();
const SYSTEM_LAYOUTS_DIR = path.resolve(__dirname, '../.svsch/layouts');

test.describe('Add to Partial — every supported node kind', () => {
  // Root cause of the "stalls on submodule-instance" symptom tracked in
  // issue #408: every case here reuses module name "top" (see NODE_CASES'
  // comment), so main.tsx's fitView-once-per-module-name guard
  // (fittedModuleNameRef) only fits the viewport for the very first case —
  // later cases' nodes render at whatever raw position their (unrelated)
  // project happens to produce, which can land outside the viewport the
  // first case settled on. `submodule-instance` was the first case whose
  // instance node happened to render off-screen, so its click never landed.
  // Fixed by explicitly recentering on the target node before clicking (see
  // centerViewOnNode below) instead of relying on the app's own fitView.
  test(`clones one node of each of the ${NODE_CASES.length} supported kinds into the partial diagram`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    // Every case needs its own Surelog elaboration plus a full UI round trip;
    // give the loop generous headroom over the suite's 240s default.
    test.setTimeout(Math.max(240_000, NODE_CASES.length * 45_000));

    await clearSystemLayout();
    await workbox.waitForSelector('.monaco-workbench', { timeout: 30_000 });
    await dismissSystemNotifications(workbox);
    await installSystemWebviewBridge(evaluateInVSCode);

    const originalProjectFolder =
      (await evaluateInVSCode((vscode) =>
        vscode.workspace.getConfiguration('svsch').get('projectFolder'),
      )) ?? './fixtures';

    const tmpDirs: string[] = [];
    let diagramOpened = false;

    try {
      for (const caseData of NODE_CASES) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `svsch-partial-node-${caseData.id}-`));
        tmpDirs.push(tmpDir);
        for (const [filename, content] of Object.entries(caseData.files)) {
          fs.writeFileSync(path.join(tmpDir, filename), content);
        }

        const graphCountBefore = await currentGraphCount(evaluateInVSCode);

        // Workspace, not Global: test/.vscode/settings.json already pins
        // svsch.projectFolder at the workspace scope, which always shadows a
        // Global-scope value — writing Global here silently no-ops and every
        // iteration keeps elaborating the original ./fixtures project. This
        // does briefly rewrite the checked-out (not committed) settings.json
        // on disk for the duration of this Electron launch; the `finally`
        // block below restores it before the process exits.
        await evaluateInVSCode(
          (vscode, folder) =>
            vscode.workspace
              .getConfiguration('svsch')
              .update('projectFolder', folder, vscode.ConfigurationTarget.Workspace),
          tmpDir,
        );

        if (!diagramOpened) {
          await evaluateInVSCode((vscode) => vscode.commands.executeCommand('svsch.openDiagram'));
          await workbox.waitForSelector(
            '.tab[aria-label*="SVSCH Diagram"], .tab[title*="SVSCH Diagram"]',
            { timeout: 30_000 },
          );
          diagramOpened = true;
        } else {
          // Config-change re-elaboration is the same path svsch.setProjectFolder
          // itself drives (see src/extension.ts) — more direct than relying on
          // the debounced onDidChangeConfiguration watcher's own timing.
          await evaluateInVSCode((vscode) =>
            vscode.commands.executeCommand('svsch.rebuildDiagram'),
          );
        }

        await expect
          .poll(() => currentGraphCount(evaluateInVSCode), { timeout: 30_000 })
          .toBeGreaterThan(graphCountBefore);
        // The config write above (now Workspace-scope so it actually takes
        // effect, see the comment on that update() call) also fires
        // vscodeElaborationHost's own onDidChangeConfiguration listener, which
        // schedules a second, debounced rebuild ~250ms later independent of
        // the explicit svsch.rebuildDiagram command above. Wait for the graph
        // count to stop changing before searching for a node, or that second
        // rebuild can swap the main webview's DOM out from under
        // findSystemNodeId/clickSystemNode right as they're mid-interaction.
        await waitForGraphCountStable(evaluateInVSCode);

        const mainFrameIndex = await findFrameIndex(workbox, 'main');
        const mainWebview = workbox
          .frameLocator('iframe.webview')
          .nth(mainFrameIndex)
          .frameLocator('iframe#active-frame');
        await mainWebview.locator('.react-flow__node').first().waitFor({ timeout: 30_000 });
        await waitForViewportToSettle(mainWebview);

        const targetLabel = caseData.target.nodeLabel;
        const targetKind = caseData.target.nodeKind;
        await expect
          .poll(
            async () => (await findSystemNodeId(mainWebview, targetLabel, targetKind)) !== null,
            { timeout: 15_000 },
          )
          .toBe(true);
        const nodeId = await findSystemNodeId(mainWebview, targetLabel, targetKind);
        if (!nodeId) {
          throw new Error(
            `[${caseData.id}] Could not find ${targetKind} node "${targetLabel}" in the main diagram`,
          );
        }

        const partialBlocksBefore = await countPartialPaneBlocks(workbox);

        // Every case reuses module name "top" (see the comment on NODE_CASES
        // above), so main.tsx's fitView-once-per-module-name guard
        // (fittedModuleNameRef, see src/webview/main.tsx) only fires for the
        // very first case here — later cases' nodes render at whatever raw
        // ELK/backend position their project happens to produce, which can
        // land well outside the viewport the first case's fitView settled
        // on (observed for the two-file "submodule-instance" case: its
        // instance node rendered off the right edge of the canvas, so the
        // click below landed on empty space and .selected never flipped).
        // Recenter on the target node before clicking, same as
        // centerViewOnNode in test/steps/diagram.steps.ts.
        await centerViewOnNode(mainWebview, nodeId);

        await clickSystemNode(mainWebview, nodeId);
        const addToPartialButton = mainWebview.locator('.svsch-selection-toolbar button', {
          hasText: 'Add to Partial',
        });
        await expect(addToPartialButton).toBeVisible();
        // force: true for the same reason as clickSystemNode above — the
        // floating selection toolbar can sit over the canvas's own
        // pointer-catching pane (or a hovering module-parameter tooltip) at
        // these un-auto-laid-out positions. The countPartialPaneBlocks poll
        // right below still verifies the click actually did something.
        await addToPartialButton.click({ force: true });

        await expect
          .poll(() => countPartialPaneBlocks(workbox), { timeout: 30_000 })
          .toBeGreaterThan(partialBlocksBefore ?? 0);

        const partialTabs = workbox.locator(
          '.tab[aria-label*="SVSCH Partial Diagram"], .tab[title*="SVSCH Partial Diagram"]',
        );
        // The pane opens beside the main diagram (ViewColumn.Beside, see
        // src/partialDiagramPanel.ts), splitting the window in two. Move it
        // into the main diagram's own tab group so the screenshot below
        // captures the partial diagram at full window width while it's being
        // assembled, rather than a half-width split view.
        await partialTabs.first().click();
        await evaluateInVSCode((vscode) =>
          vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup'),
        );
        // Let the now-single-group relayout settle before the next capture.
        await workbox.waitForTimeout(300);

        const partialFrameIndex = await findFrameIndex(workbox, 'partial');
        // A fixed 300ms wait isn't a reliable proxy for "the editor-group
        // relayout has finished": if the outer iframe is still animating
        // from its half-width split-view size toward the full-width
        // merged-group size when main.tsx's one-shot-per-module fitView
        // effect fires, fitView computes its padding against a too-narrow
        // container and never gets a second chance to correct (see the
        // comment on waitForViewportToSettle). Wait for the iframe's own
        // width to hold steady before trusting the pane is really
        // full-width.
        await waitForOuterFrameWidthToSettle(workbox, partialFrameIndex);
        const partialWebview = workbox
          .frameLocator('iframe.webview')
          .nth(partialFrameIndex)
          .frameLocator('iframe#active-frame');

        // Mirrors the main-webview lookup above with an expect.poll rather
        // than a one-shot check: the partial pane's own elaboration (see the
        // "SVSCH: Elaborating project..." notification racing this in a
        // captured failure) can still be in flight right after the pane
        // opens, so a single findSystemNodeId call here was observed to flake.
        await expect
          .poll(
            async () => (await findSystemNodeId(partialWebview, targetLabel, targetKind)) !== null,
            { timeout: 15_000 },
          )
          .toBe(true);
        const partialNodeId = await findSystemNodeId(partialWebview, targetLabel, targetKind);
        expect(
          partialNodeId,
          `[${caseData.id}] Expected the ${targetKind} node to render in the partial diagram pane`,
        ).not.toBeNull();

        await waitForViewportToSettle(partialWebview);
        await dismissSystemNotifications(workbox);
        await workbox.waitForTimeout(300);
        await expect(workbox).toHaveScreenshot(`partial-diagram-node-${targetKind}.png`);

        // Undo the merge from above: split the partial editor back into its
        // own group now that the screenshot is taken. Leaving it merged into
        // the main diagram's group backgrounds the main webview (it's no
        // longer the active tab in that group), and without
        // retainContextWhenHidden it gets torn down — the next loop
        // iteration's findSystemNodeId(mainWebview, ...) then times out
        // waiting on a main diagram that has to fully re-render from scratch.
        await evaluateInVSCode((vscode) =>
          vscode.commands.executeCommand('workbench.action.splitEditorRight'),
        );
        await workbox.waitForTimeout(300);

        // Every case reuses module name "top" (that's what the syntax book's
        // fixtures are all called) but with entirely different content each
        // time. PartialDiagramPanel only restarts its state when the source
        // *module name* changes (v1 scope, see addNodes in
        // src/partialDiagramPanel.ts), so close the pane after each case
        // instead of relying on that name-based reset — the next "Add to
        // Partial" click then always builds a genuinely fresh pane.
        await partialTabs.first().click();
        await workbox.waitForTimeout(300);
        await evaluateInVSCode((vscode) =>
          vscode.commands.executeCommand('workbench.action.closeActiveEditor'),
        );
        await expect(partialTabs).toHaveCount(0);
      }
    } finally {
      await evaluateInVSCode(
        (vscode, folder) =>
          vscode.workspace
            .getConfiguration('svsch')
            .update('projectFolder', folder, vscode.ConfigurationTarget.Workspace),
        originalProjectFolder,
      );
      for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      await clearSystemLayout();
    }
  });
});

async function clearSystemLayout(): Promise<void> {
  await fs.promises.rm(SYSTEM_LAYOUTS_DIR, { recursive: true, force: true }).catch(() => {});
}

async function currentGraphCount(evaluateInVSCode: EvaluateInVSCode): Promise<number> {
  return evaluateInVSCode((vscode) => {
    void vscode;
    return (global as any).__svschGraphCount ?? 0;
  });
}

// Waits until __svschGraphCount holds still for a full window rather than
// just "has changed once" — see the call site for why a second, debounced
// rebuild can otherwise still be in flight.
async function waitForGraphCountStable(evaluateInVSCode: EvaluateInVSCode): Promise<void> {
  const quietWindowMs = 500;
  const deadline = Date.now() + 30_000;
  let lastCount = await currentGraphCount(evaluateInVSCode);
  let lastChangedAt = Date.now();
  while (Date.now() - lastChangedAt < quietWindowMs) {
    if (Date.now() > deadline) {
      throw new Error('Graph count never settled within 30s');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const count = await currentGraphCount(evaluateInVSCode);
    if (count !== lastCount) {
      lastCount = count;
      lastChangedAt = Date.now();
    }
  }
}

async function dismissSystemNotifications(workbox: Page): Promise<void> {
  for (const button of await workbox
    .locator('.notification-toast button', { hasText: /Never|Don't show/i })
    .all()) {
    await button.click().catch(() => {});
  }
  const closeAll = workbox.locator('.notifications-toasts .codicon-notifications-clear-all');
  if (await closeAll.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeAll.click().catch(() => {});
  }
}

// Mirrors installSystemWebviewBridge in diagram.spec.ts: patches
// createWebviewPanel before svsch.openDiagram ever fires so every graph
// message posted to the main panel's webview is counted, independent of
// whichever module/project it currently reflects.
async function installSystemWebviewBridge(evaluateInVSCode: EvaluateInVSCode): Promise<void> {
  await evaluateInVSCode((vscode) => {
    if ((global as any).__svschSystemBridgeInstalled) return;
    (global as any).__svschSystemBridgeInstalled = true;

    const origCreatePanel = vscode.window.createWebviewPanel;
    (vscode.window as any).createWebviewPanel = function (
      viewType: string,
      title: string,
      ...args: any[]
    ) {
      const panel = (origCreatePanel as any).call(vscode.window, viewType, title, ...args);
      if (viewType !== 'svsch.diagram') {
        return panel;
      }

      const origPostMessage = panel.webview.postMessage.bind(panel.webview);
      panel.webview.postMessage = (msg: any) => {
        if (msg?.type === 'graph') {
          (global as any).__svschGraphCount = ((global as any).__svschGraphCount ?? 0) + 1;
        }
        return origPostMessage(msg);
      };

      return panel;
    };
  });
}

// Mirrors BddWorld.findPanelFrameIndex (test/steps/fixtures.ts), with one
// addition: this spec's electronApp fixture is worker-scoped and every other
// test/system/*.spec.ts test shares that same window (see
// test/system/playwright.config.ts's workers: 1), and none of those tests
// close their diagram panel afterward. By the time this test's loop reaches
// later iterations, several *background* main-diagram webviews from earlier
// tests/cases can still be sitting in the DOM alongside the current one, so
// matching on content alone risks returning a stale frame. Skip frames whose
// outer iframe isn't currently visible (VS Code hides inactive editor
// webviews rather than removing them).
async function findFrameIndex(workbox: Page, panel: 'main' | 'partial'): Promise<number> {
  const selector =
    panel === 'partial' ? '.shell[data-svsch-partial="true"]' : '.shell:not([data-svsch-partial])';
  const deadline = Date.now() + 30_000;
  for (;;) {
    const count = await workbox.locator('iframe.webview').count();
    for (let index = 0; index < count; index++) {
      const outerFrame = workbox.locator('iframe.webview').nth(index);
      const visible = await outerFrame.isVisible().catch(() => false);
      if (!visible) continue;
      const matches = await workbox
        .frameLocator('iframe.webview')
        .nth(index)
        .frameLocator('iframe#active-frame')
        .locator(selector)
        .count()
        .catch(() => 0);
      if (matches > 0) {
        return index;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`No ${panel} diagram webview found within 30s`);
    }
    await workbox.waitForTimeout(250);
  }
}

// Mirrors waitForOuterFrameWidthToSettle in partial_diagram_interactions.spec.ts.
async function waitForOuterFrameWidthToSettle(workbox: Page, frameIndex: number): Promise<void> {
  const outerFrame = workbox.locator('iframe.webview').nth(frameIndex);
  let lastWidth = -1;
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    await workbox.waitForTimeout(50);
    const box = await outerFrame.boundingBox();
    const width = box?.width ?? -1;
    stable = width === lastWidth && width > 0 ? stable + 1 : 0;
    lastWidth = width;
    if (stable >= 5) return;
  }
  throw new Error('Partial pane iframe width did not settle within 5 seconds');
}

// The number of real (non-label) blocks currently rendered in the partial
// pane, or null while no partial pane webview exists yet — mirrors
// partialPaneBlockCount in test/steps/partial.steps.ts.
async function countPartialPaneBlocks(workbox: Page): Promise<number | null> {
  const frames = await workbox.locator('iframe.webview').count();
  for (let index = 0; index < frames; index++) {
    const frame = workbox
      .frameLocator('iframe.webview')
      .nth(index)
      .frameLocator('iframe#active-frame');
    const isPartial = await frame
      .locator('.shell[data-svsch-partial="true"]')
      .count()
      .catch(() => 0);
    if (isPartial > 0) {
      return frame
        .locator('.react-flow__node:not([data-node-kind="netLabel"])')
        .count()
        .catch(() => 0);
    }
  }
  return null;
}

// Mirrors centerViewOnNode in test/steps/diagram.steps.ts: pans/zooms the
// React Flow viewport so the given node is centered on screen before a real
// (non-forced-through-actionability) click needs to land on it.
async function centerViewOnNode(webview: FrameLocator, nodeId: string): Promise<void> {
  await webview.locator('html').evaluate((_element, id) => {
    const rf = (window as any).reactFlowInstance;
    const node = rf?.getNodes().find((n: any) => n.id === id);
    if (!rf || !node) return;
    const width = node.measured?.width ?? node.width ?? 0;
    const height = node.measured?.height ?? node.height ?? 0;
    rf.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom: 1,
      duration: 0,
    });
  }, nodeId);
  await waitForViewportToSettle(webview);
}

async function waitForViewportToSettle(webview: FrameLocator): Promise<void> {
  await webview.locator('body').evaluate(async () => {
    // main.tsx's fitView effect only fires once per module name
    // (fittedModuleNameRef) as soon as the node count first matches the
    // extension host's view — which can be before ELK has actually
    // positioned the newly added node(s). The outer viewport's own
    // transform is then stable for good (fitView never runs again for this
    // module), but individual nodes can still jump to their real ELK
    // position afterward, changing what's on screen without the pane's
    // camera transform ever moving — a settle check on the viewport alone
    // misses that and can screenshot mid-reflow (observed in CI as the same
    // two nodes rendered at a different scale/position between runs). Track
    // every node's own transform alongside the viewport's.
    const getSignature = () => {
      const viewportTransform =
        (document.querySelector('.react-flow__viewport') as HTMLElement)?.style.transform ?? '';
      const nodeTransforms = Array.from(document.querySelectorAll('.react-flow__node'))
        .map((el) => `${el.getAttribute('data-id')}:${(el as HTMLElement).style.transform}`)
        .sort()
        .join('|');
      return `${viewportTransform}::${nodeTransforms}`;
    };
    let last = getSignature();
    let stable = 0;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const current = getSignature();
      stable = current === last && current !== '::' ? stable + 1 : 0;
      last = current;
      if (stable >= 5) break;
    }
    if (stable < 5) {
      throw new Error('React Flow viewport did not settle within 5 seconds');
    }
  });
  await webview.locator('body').evaluate(() => document.fonts.ready);
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

async function clickSystemNode(webview: FrameLocator, nodeId: string): Promise<void> {
  // Click the locator directly rather than computing a boundingBox() and
  // dispatching a raw workbox.mouse.click(): the manual-coordinates version
  // bypasses Playwright's actionability checks (visible, stable, not
  // obscured), so a box captured a moment earlier — e.g. while the previous
  // case's editor-group merge/split from above is still settling — can go
  // stale and land the click on whatever now occupies those coordinates
  // instead of retrying against the node's current position.
  //
  // force: true because several syntax-book fixtures render their nodes at
  // their raw, un-auto-laid-out positions (this loop never runs "Auto Layout
  // All"), which lets an adjacent node's real, visible hitbox genuinely and
  // persistently overlap this one — not a transient animation Playwright's
  // default retrying would resolve on its own. The .selected poll right
  // below still verifies the click actually landed on the intended node.
  const node = webview.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await node.waitFor({ state: 'visible' });
  await node.click({ force: true });

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
