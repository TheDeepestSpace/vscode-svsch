import { test, expect } from 'vscode-test-playwright';
import type { FrameLocator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { PARTIAL_INTERACTION_CASES } from './partial_diagram_interactions.cases';
import { SNAPSHOT_THRESHOLDS } from '../snapshotPolicy';

// ---------------------------------------------------------------------------
// "Does this diagram_interaction.feature behavior still hold inside a
// partial diagram?" (issue #408 review thread, option 3). Rather than
// duplicating each applicable scenario into partial_diagram.feature with a
// "[partial diagram]" suffix, one system-test case lives here per
// `@partial-parity`-tagged scenario — the same reasoning that already kept
// "Add to Partial" node-kind coverage (see partial_diagram_nodes.spec.ts) out
// of the BDD suite: each case needs its own from-scratch elaboration plus a
// full VS Code launch, and the BDD suite already runs once per supported
// VS Code version.
//
// partial_diagram_interactions.coverage.test.ts (plain vitest, no VS Code)
// is what keeps PARTIAL_INTERACTION_CASES honest against the feature file —
// see that file and partial_diagram_interactions.cases.ts for the full
// design. This file is deliberately just the runner: every case is declared
// via `test.fixme`, most with a body that documents the interaction still
// left to port rather than a working implementation.
//
// Two cases are fully implemented rather than `test.fixme` stubs — neither
// needs the drag-gesture math the rest of this file avoids porting (see
// below): "The Auto Layout control only appears once multiple blocks are
// selected" needs no more than a plain marquee select (click, lasso-select,
// assert, lasso-select, assert), reusing the exact click/select helpers this
// suite's sibling node-kind test already exercises; "Auto Layout All
// re-places every block..." needs only "Add to Partial" (leaving a block's
// ports out of the pane already produces a cut end structurally, no manual
// cut gesture required) and a toolbar click. Both run for real and, like
// partial_diagram_nodes.spec.ts, take a `toHaveScreenshot` at each important
// regression-testing checkpoint, so a visual regression fails the diff, not
// just the DOM assertions around it.
//
// "Expanding an instance in place..." was the original pick for this slot
// (issue #408 review thread) but turned out to be a bad one once actually run
// here for the first time: `expandableInstance` in src/webview/main.tsx
// unconditionally resolves to `undefined` whenever `partialDiagram` is true —
// per that file's own comment, "Inside a partial pane... the only selection
// actions that mean anything to its host are Auto Layout — everything else
// (cuts, resizes, expand, adding to a partial from a partial) is
// main-diagram-only." Expand/Collapse is by-design unavailable in a partial
// pane, so that scenario cannot pass as written; it stays a `test.fixme`
// stub below alongside the rest, with a note pointing at the actual reason
// instead of the original "needs porting" guess.
//
// The other 16 cases involve real drag gestures (move/resize/reroute/
// multi-select-then-drag) that test/steps/diagram.steps.ts already
// implements against the BddWorld fixture — porting those to
// vscode-test-playwright's lower-level workbox/evaluateInVSCode API is real,
// scenario-by-scenario work each needing its own live-environment debugging
// pass (see the comment on the node-kind test's own `test.fixme` for how many
// rounds that took), which a single non-interactive session can't responsibly
// fake. They stay as documented `test.fixme` stubs, still registered here —
// and so still enforced by the coverage test — so implementing one never
// silently leaves the rest unnoticed.
// ---------------------------------------------------------------------------

type EvaluateInVSCode = <R, Arg = void>(fn: (vscode: any, arg: Arg) => R, arg?: Arg) => Promise<R>;

const SYSTEM_LAYOUTS_DIR = path.resolve(__dirname, '../.svsch/layouts');

async function clearSystemLayout(): Promise<void> {
  await fs.promises.rm(SYSTEM_LAYOUTS_DIR, { recursive: true, force: true }).catch(() => {});
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

// Mirrors findFrameIndex in partial_diagram_nodes.spec.ts.
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

function webviewAt(workbox: Page, frameIndex: number): FrameLocator {
  return workbox.frameLocator('iframe.webview').nth(frameIndex).frameLocator('iframe#active-frame');
}

// Mirrors findSystemNodeId in partial_diagram_nodes.spec.ts.
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

// Mirrors cutLabelNodeIdAttachedTo in test/steps/diagram.steps.ts (BddWorld
// version), adapted to this suite's lower-level webview API: walks the given
// block's cut-stub edges to find the netLabel node rendered at their other
// end. Partial panes never expand instances (see the EXPAND_COLLAPSE_TITLE
// comment below), so unlike the BddWorld helper this doesn't need the
// `expand:<id>::...` boundary-port namespacing.
async function findCutLabelIdAttachedTo(
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

// Mirrors waitForViewportToSettle in partial_diagram_nodes.spec.ts: waits for
// React Flow's viewport transform to hold steady before a screenshot, so a
// still-animating pan/zoom from the preceding action doesn't get captured
// mid-flight.
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

// Screenshots a stable, fully-rendered state of the partial pane at an
// important regression-testing checkpoint (mirrors the toHaveScreenshot call
// in partial_diagram_nodes.spec.ts's loop).
async function screenshotPartialStep(
  workbox: Page,
  partialWebview: FrameLocator,
  name: string,
): Promise<void> {
  await waitForViewportToSettle(partialWebview);
  await dismissSystemNotifications(workbox);
  await workbox.waitForTimeout(300);
  await expect(workbox).toHaveScreenshot(name, {
    maxDiffPixels: SNAPSHOT_THRESHOLDS.playwright.system.partialDiagramAutoLayoutVisibility,
  });
}

// Mirrors clickSystemNode in partial_diagram_nodes.spec.ts.
async function clickSystemNode(webview: FrameLocator, nodeId: string): Promise<void> {
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

// Draws a lasso around the union of every node's bounding box (mirrors
// marqueeSelectNodes in test/steps/diagram.steps.ts, adapted from the
// BddWorld fixture to the lower-level workbox/webview API this suite uses).
async function marqueeSelectNodes(
  workbox: Page,
  webview: FrameLocator,
  nodeIds: string[],
): Promise<void> {
  const boxes = await Promise.all(
    nodeIds.map((id) => webview.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()),
  );
  if (boxes.some((box) => !box)) {
    throw new Error(`Could not get bounding boxes for nodes: ${nodeIds.join(', ')}`);
  }
  const nonNullBoxes = boxes as NonNullable<(typeof boxes)[number]>[];
  const left = Math.min(...nonNullBoxes.map((box) => box.x));
  const top = Math.min(...nonNullBoxes.map((box) => box.y));
  const right = Math.max(...nonNullBoxes.map((box) => box.x + box.width));
  const bottom = Math.max(...nonNullBoxes.map((box) => box.y + box.height));
  const startX = left - 24;
  const startY = top - 24;
  const endX = right + 24;
  const endY = bottom + 24;

  await workbox.mouse.move(startX, startY);
  await workbox.mouse.down();
  await workbox.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 });
  await workbox.mouse.move(endX, endY, { steps: 8 });
  await workbox.mouse.up();

  await expect
    .poll(
      async () =>
        webview.locator('html').evaluate((_element, ids) => {
          const rf = (window as any).reactFlowInstance;
          const selected = new Set(
            (rf?.getNodes?.() ?? []).filter((n: any) => n.selected).map((n: any) => n.id),
          );
          return ids.every((id: string) => selected.has(id));
        }, nodeIds),
      { timeout: 5_000 },
    )
    .toBe(true);
}

// Writes `files` to a fresh temp dir, points svsch.projectFolder at it
// (Workspace scope — see the equivalent comment in partial_diagram_nodes.spec.ts
// for why Global silently no-ops here), and opens the main diagram.
async function openMainDiagram(
  workbox: Page,
  evaluateInVSCode: EvaluateInVSCode,
  files: Record<string, string>,
): Promise<{ tmpDir: string; mainWebview: FrameLocator }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-partial-interaction-'));
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpDir, filename), content);
  }

  await evaluateInVSCode(
    (vscode, folder) =>
      vscode.workspace
        .getConfiguration('svsch')
        .update('projectFolder', folder, vscode.ConfigurationTarget.Workspace),
    tmpDir,
  );
  await evaluateInVSCode((vscode) => vscode.commands.executeCommand('svsch.openDiagram'));
  await workbox.waitForSelector('.tab[aria-label*="SVSCH Diagram"], .tab[title*="SVSCH Diagram"]', {
    timeout: 30_000,
  });

  const mainFrameIndex = await findFrameIndex(workbox, 'main');
  const mainWebview = webviewAt(workbox, mainFrameIndex);
  await mainWebview.locator('.react-flow__node').first().waitFor({ timeout: 30_000 });

  return { tmpDir, mainWebview };
}

// Lasso-selects every id on the main diagram, then clicks "Add to Partial" —
// `addToPartialNodes` (src/webview/main.tsx) clones every selected real block
// at once, one or many — and returns a FrameLocator for the partial pane once
// it's populated.
async function addNodesToPartial(
  workbox: Page,
  evaluateInVSCode: EvaluateInVSCode,
  mainWebview: FrameLocator,
  nodeIds: string[],
): Promise<FrameLocator> {
  await marqueeSelectNodes(workbox, mainWebview, nodeIds);

  const addToPartialButton = mainWebview.locator('.svsch-selection-toolbar button', {
    hasText: 'Add to Partial',
  });
  await expect(addToPartialButton).toBeVisible();
  await addToPartialButton.click({ force: true });

  const partialTabs = workbox.locator(
    '.tab[aria-label*="SVSCH Partial Diagram"], .tab[title*="SVSCH Partial Diagram"]',
  );
  await partialTabs.first().waitFor({ timeout: 30_000 });
  // PartialDiagramPanel opens ViewColumn.Beside with preserveFocus (see
  // src/partialDiagramPanel.ts), so the main diagram tab — not the new
  // partial one — is still the active editor at this point. Click the
  // partial tab first so it's the one moveEditorToFirstGroup actually acts
  // on; skipping this merges nothing (the already-first-group main tab is a
  // no-op move) and every screenshot below would capture the half-width
  // split view instead of the intended full-width partial pane (mirrors the
  // same fix in partial_diagram_nodes.spec.ts's loop).
  await partialTabs.first().click();
  await evaluateInVSCode((vscode) =>
    vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup'),
  );
  await workbox.waitForTimeout(300);

  const partialFrameIndex = await findFrameIndex(workbox, 'partial');
  // A fixed 300ms wait above isn't a reliable proxy for "the editor-group
  // relayout has finished": if the outer iframe is still animating from its
  // half-width split-view size toward the full-width merged-group size when
  // main.tsx's one-shot-per-module fitView effect fires (see the comment on
  // waitForViewportToSettle), fitView computes its padding against a
  // too-narrow container and never gets a second chance to correct — the
  // pane then stays visibly more zoomed-in than a fit against the true final
  // width would produce, for the rest of the test. Wait for the iframe's own
  // width to hold steady before trusting the pane is really full-width.
  await waitForOuterFrameWidthToSettle(workbox, partialFrameIndex);
  const partialWebview = webviewAt(workbox, partialFrameIndex);
  await partialWebview.locator('.react-flow__node').first().waitFor({ timeout: 30_000 });
  await waitForViewportToSettle(partialWebview);
  return partialWebview;
}

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

const casesByTitle = new Map(PARTIAL_INTERACTION_CASES.map((c) => [c.title, c]));

function notImplementedCase(title: string) {
  test.fixme(title, async () => {
    const notes = casesByTitle.get(title)?.notes ?? '';
    throw new Error(
      `Not yet implemented: port the partial-diagram-context version of the ` +
        `"${title}" scenario from test/features/diagram_interaction.feature. ${notes}`,
    );
  });
}

test.describe('Partial diagram interaction parity', () => {
  test.beforeEach(async () => {
    await clearSystemLayout();
  });

  // -- The one fully worked example -----------------------------------------
  const AUTO_LAYOUT_VISIBILITY_TITLE =
    'The Auto Layout control only appears once multiple blocks are selected';
  test(AUTO_LAYOUT_VISIBILITY_TITLE, async ({ workbox, evaluateInVSCode }) => {
    await workbox.waitForSelector('.monaco-workbench', { timeout: 30_000 });
    await dismissSystemNotifications(workbox);

    const { mainWebview } = await openMainDiagram(workbox, evaluateInVSCode, {
      'top.sv': `
          module leaf(input logic a, output logic y);
            assign y = a;
          endmodule

          module top(input logic a, input logic b, output logic x, output logic y);
            leaf u1(.a(a), .y(x));
            leaf u2(.a(b), .y(y));
          endmodule
        `,
    });

    const u1MainId = await findSystemNodeId(mainWebview, 'u1', 'instance');
    const u2MainId = await findSystemNodeId(mainWebview, 'u2', 'instance');
    if (!u1MainId || !u2MainId) {
      throw new Error('Instances "u1"/"u2" did not render in the main diagram');
    }

    const partialWebview = await addNodesToPartial(workbox, evaluateInVSCode, mainWebview, [
      u1MainId,
      u2MainId,
    ]);

    const u1Id = await findSystemNodeId(partialWebview, 'u1', 'instance');
    const u2Id = await findSystemNodeId(partialWebview, 'u2', 'instance');
    if (!u1Id || !u2Id) {
      throw new Error('Instances "u1"/"u2" did not render in the partial pane');
    }

    const autoLayoutButton = partialWebview.locator('.svsch-selection-toolbar button', {
      hasText: 'Auto Layout',
    });

    // A single selected block offers no partial-pane selection actions at
    // all (see the comment on expandableInstance/showCutOut/etc. in
    // src/webview/main.tsx) — the toolbar itself doesn't render, so the
    // button locator resolves to zero elements rather than a hidden one.
    await clickSystemNode(partialWebview, u1Id);
    await expect(autoLayoutButton).toHaveCount(0);
    await screenshotPartialStep(
      workbox,
      partialWebview,
      'partial-diagram-interaction-auto-layout-visibility-01-single-selected.png',
    );

    await marqueeSelectNodes(workbox, partialWebview, [u1Id, u2Id]);
    await expect(autoLayoutButton).toBeVisible();
    await screenshotPartialStep(
      workbox,
      partialWebview,
      'partial-diagram-interaction-auto-layout-visibility-02-multi-selected.png',
    );
  });

  // -- A second worked example: Auto Layout All vs. a surviving cut end -----
  // "Rebuilding a whole FSM..." in partial_diagram.feature already runs Auto
  // Layout All inside a partial pane, but only after "I extend every cut net
  // in the partial diagram" — by the time it clicks the button, zero cut ends
  // remain, so it never actually exercises one surviving the relayout. This
  // case adds two blocks without their driving/driven ports (so both ends of
  // their nets render as cut ends — no drag gesture needed to set that up,
  // unlike most of the still-unported cases below), runs Auto Layout All on
  // the whole pane, and confirms a cut label doesn't land on top of the other
  // block afterward — the exact shape of the bug this case was written for
  // (issue #408 follow-up).
  const AUTO_LAYOUT_ALL_TITLE =
    'Auto Layout All re-places every block using current positions as hints';
  test(AUTO_LAYOUT_ALL_TITLE, async ({ workbox, evaluateInVSCode }) => {
    await workbox.waitForSelector('.monaco-workbench', { timeout: 30_000 });
    await dismissSystemNotifications(workbox);

    const { mainWebview } = await openMainDiagram(workbox, evaluateInVSCode, {
      'top.sv': `
          module leaf(input logic a, output logic y);
            assign y = a;
          endmodule

          module top(input logic a, input logic b, output logic x, output logic y);
            leaf u1(.a(a), .y(x));
            leaf u2(.a(b), .y(y));
          endmodule
        `,
    });

    const u1MainId = await findSystemNodeId(mainWebview, 'u1', 'instance');
    const u2MainId = await findSystemNodeId(mainWebview, 'u2', 'instance');
    if (!u1MainId || !u2MainId) {
      throw new Error('Instances "u1"/"u2" did not render in the main diagram');
    }

    // Neither leaf's driving/driven port node comes along — every wire
    // touching u1/u2 renders as a cut end on this pane, same as the "declared
    // nets are automatically cut" mechanic on the main diagram, but structural
    // here rather than heuristic.
    const partialWebview = await addNodesToPartial(workbox, evaluateInVSCode, mainWebview, [
      u1MainId,
      u2MainId,
    ]);

    const u1Id = await findSystemNodeId(partialWebview, 'u1', 'instance');
    const u2Id = await findSystemNodeId(partialWebview, 'u2', 'instance');
    if (!u1Id || !u2Id) {
      throw new Error('Instances "u1"/"u2" did not render in the partial pane');
    }

    await screenshotPartialStep(
      workbox,
      partialWebview,
      'partial-diagram-interaction-auto-layout-all-cut-ends-01-before.png',
    );

    await partialWebview.locator('body').hover({ position: { x: 10, y: 10 }, force: true });
    const autoLayoutAllButton = partialWebview.locator('.toolbar button', {
      hasText: 'Auto Layout All',
    });
    await expect(autoLayoutAllButton).toBeVisible();
    await autoLayoutAllButton.click();
    await partialWebview.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });

    await screenshotPartialStep(
      workbox,
      partialWebview,
      'partial-diagram-interaction-auto-layout-all-cut-ends-02-after.png',
    );

    // The regression this case guards: buildPartialViewModel used to
    // synthesize cut-end labels only after the tied-wire routing pass had
    // already finished, so a released block landing wherever ELK repacked it
    // could park right on top of a cut label with no obstacle-avoidance
    // aware of it. Check both blocks' cut ends against the other block.
    const u1LabelId = await findCutLabelIdAttachedTo(partialWebview, u1Id);
    const u2LabelId = await findCutLabelIdAttachedTo(partialWebview, u2Id);
    if (!u1LabelId || !u2LabelId) {
      throw new Error('Expected a cut net label attached to both "u1" and "u2"');
    }

    const u1LabelBox = await partialWebview
      .locator(`.react-flow__node[data-id="${u1LabelId}"]`)
      .boundingBox();
    const u2LabelBox = await partialWebview
      .locator(`.react-flow__node[data-id="${u2LabelId}"]`)
      .boundingBox();
    const u1Box = await partialWebview
      .locator(`.react-flow__node[data-id="${u1Id}"]`)
      .boundingBox();
    const u2Box = await partialWebview
      .locator(`.react-flow__node[data-id="${u2Id}"]`)
      .boundingBox();
    if (!u1LabelBox || !u2LabelBox || !u1Box || !u2Box) {
      throw new Error('Missing a bounding box for "u1", "u2", or one of their cut labels');
    }

    const overlaps = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    expect(
      overlaps(u1LabelBox, u2Box),
      'the cut label attached to "u1" should not overlap "u2"',
    ).toBe(false);
    expect(
      overlaps(u2LabelBox, u1Box),
      'the cut label attached to "u2" should not overlap "u1"',
    ).toBe(false);
  });

  // -- Everything else: registered, still to be ported -----------------------
  const EXPAND_COLLAPSE_TITLE =
    'Expanding an instance in place inlines its child module, and Collapse restores it';
  test.fixme(EXPAND_COLLAPSE_TITLE, async () => {
    throw new Error(
      'Not implementable as written: expandableInstance in src/webview/main.tsx ' +
        'unconditionally resolves to undefined whenever partialDiagram is true — by that ' +
        'file\'s own comment, "the only selection actions that mean anything to [a partial ' +
        "pane's] host are Auto Layout — everything else (cuts, resizes, expand, adding to " +
        'a partial from a partial) is main-diagram-only." Expand/Collapse needs either a ' +
        'product decision to support it in partial panes, or removal from @partial-parity ' +
        'in test/features/diagram_interaction.feature (like the generate-region scenarios).',
    );
  });
  for (const { title } of PARTIAL_INTERACTION_CASES) {
    if (
      title === AUTO_LAYOUT_VISIBILITY_TITLE ||
      title === AUTO_LAYOUT_ALL_TITLE ||
      title === EXPAND_COLLAPSE_TITLE
    )
      continue;
    notImplementedCase(title);
  }
});
