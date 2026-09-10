import { When, Then, BddWorld } from './fixtures';
import type { FrameLocator } from '@playwright/test';
import { expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Partial Diagram (issue #403) steps — the second "SVSCH Partial Diagram"
// webview pane. Panel addressing goes through BddWorld's activeOuterFrameIndex
// (see fixtures.ts): after "I switch to the partial diagram panel" every
// existing step helper (node lookups, position notes, screenshots) targets
// the partial pane instead of the main diagram.
// ---------------------------------------------------------------------------

const PARTIAL_TAB_SELECTOR =
  '.tab[aria-label*="SVSCH Partial Diagram"], .tab[title*="SVSCH Partial Diagram"]';

// Mirror of the module-local helpers in diagram.steps.ts (deliberately not
// exported there).
function exactText(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

function cutNetLabelNodes(webviewPage: FrameLocator, label: string) {
  return webviewPage.locator('[data-node-kind="netLabel"]').filter({
    has: webviewPage.locator('.hdl-net-label-text-value').filter({ hasText: exactText(label) }),
  });
}

// The currently-active panel's real (non-label) block count — unlike
// partialPaneBlockCount below, this assumes the world is already switched to
// the pane of interest (see "I switch to the partial diagram panel") rather
// than scanning every outer iframe for the partial shell.
async function activePaneBlockCount(world: BddWorld): Promise<number> {
  return world.webviewPage.locator('.react-flow__node:not([data-node-kind="netLabel"])').count();
}

// The number of real (non-label) blocks currently rendered in the partial
// pane, or null while no partial pane webview exists yet. Scans the outer
// webview iframes the same way findPanelFrameIndex does, without disturbing
// the world's active-panel selection.
async function partialPaneBlockCount(world: BddWorld): Promise<number | null> {
  const frames = await world.workbox.locator('iframe.webview').count();
  for (let index = 0; index < frames; index++) {
    const frame = world.workbox
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

// Clicks the selection toolbar's "Add to Partial" button. Unlike the generic
// "I click the {string} button" step this doesn't wait for a layout-file
// write — opening/adding to the partial pane never persists anything.
When('I add the selected block to the partial diagram', async function (this: BddWorld) {
  const blocksBefore = (await partialPaneBlockCount(this)) ?? 0;
  const button = this.webviewPage.locator('.svsch-selection-toolbar button', {
    hasText: 'Add to Partial',
  });
  await expect(button).toBeVisible();
  await button.click();
  // The screenshot below captures the whole workbench, and the click returns
  // while VS Code is still creating (or re-laying-out) the partial webview —
  // an immediate capture lands on a blank transient. Wait until the added
  // block actually rendered in the partial pane.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const blocks = await partialPaneBlockCount(this);
    if (blocks !== null && blocks > blocksBefore) break;
    if (Date.now() > deadline) {
      throw new Error(
        `Partial pane block count did not increase past ${blocksBefore} after Add to Partial`,
      );
    }
    await this.workbox.waitForTimeout(250);
  }
  // Let the editor-split relayout settle so the main pane isn't captured
  // mid-resize.
  await this.workbox.waitForTimeout(300);
  await this.takeScreenshot('After clicking Add to Partial');
});

Then('the SVSCH partial diagram panel opens', async function (this: BddWorld) {
  await this.workbox.waitForSelector(PARTIAL_TAB_SELECTOR, { timeout: 30_000 });
  // The pane exists — also wait until its webview document actually rendered
  // the partial shell, so a following switch step can't race panel startup.
  await this.findPanelFrameIndex('partial');
});

Then('there should be exactly one partial diagram panel', async function (this: BddWorld) {
  await expect(this.workbox.locator(PARTIAL_TAB_SELECTOR)).toHaveCount(1);
});

Then('the SVSCH partial diagram panel is closed', async function (this: BddWorld) {
  await expect(this.workbox.locator(PARTIAL_TAB_SELECTOR)).toHaveCount(0);
});

When('I switch to the partial diagram panel', async function (this: BddWorld) {
  // The pane opens beside the main diagram (ViewColumn.Beside, see
  // src/partialDiagramPanel.ts), splitting the window in two. Move it into
  // the main diagram's own tab group first so every screenshot from here on
  // captures the partial diagram at full window width instead of a
  // half-width split view. This has to happen before switchToPanel: that
  // call fixes the outer iframe index by current DOM order, and the move
  // changes that order.
  const partialTab = this.workbox.locator(PARTIAL_TAB_SELECTOR).first();
  await expect(partialTab).toBeVisible();
  await partialTab.click();
  await this.evaluateInVSCode((vscode) =>
    (vscode as any).commands.executeCommand('workbench.action.moveEditorToFirstGroup'),
  );
  // Let the now-single-group relayout settle before switching panels.
  await this.workbox.waitForTimeout(300);
  await this.switchToPanel('partial');
  // Wait for content: the partial always holds at least the block it was
  // opened with.
  await this.webviewPage.locator('.react-flow__node').first().waitFor({ timeout: 30_000 });
  await this.takeScreenshot('Viewing the partial diagram');
});

When('I switch to the main diagram panel', async function (this: BddWorld) {
  await this.switchToPanel('main');
});

When('I close the partial diagram panel', async function (this: BddWorld) {
  const tab = this.workbox.locator(PARTIAL_TAB_SELECTOR).first();
  await expect(tab).toBeVisible();
  await tab.click();
  await this.workbox.waitForTimeout(300);
  await this.evaluateInVSCode((_vscode) =>
    (_vscode as any).commands.executeCommand('workbench.action.closeActiveEditor'),
  );
  await expect(this.workbox.locator(PARTIAL_TAB_SELECTOR)).toHaveCount(0);
  await this.switchToPanel('main');
});

When(
  'I click the extend arrow on the cut net {string}',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode).toBeVisible();
    await labelNode.hover({ force: true });
    const extend = labelNode.locator('.hdl-net-label-extend');
    await expect(extend).toBeVisible();
    await extend.click();
    // Clear the hover so the following screenshot isn't captured mid-reveal.
    await this.webviewPage.locator('body').hover({ position: { x: 10, y: 10 }, force: true });
    await this.takeScreenshot(`After extending the cut net ${label}`);
  },
);

Then(
  'the extend arrow should be visible on the cut net {string}',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode).toBeVisible();
    await labelNode.hover({ force: true });
    await expect(labelNode.locator('.hdl-net-label-extend')).toBeVisible();
  },
);

// Repeatedly clicks whatever cut net label happens to be first, until none
// remain — i.e. every wire the source module has gets manually extended back
// in, one node at a time. Deliberately doesn't address labels by name: cut
// nets sourced from a mux or literal (as opposed to a port/instance/register/
// latch) get an anonymous "NET_n" fallback label (see defaultNetCutLabel in
// mergeLayout.ts) whose exact text and numbering shift as the partial grows,
// so asserting against it here would be asserting an implementation detail
// rather than the feature. A successful extend either pulls in every node the
// net touches that isn't already included (a fanout net comes in whole, not
// branch by branch — see resolveExtendTarget in partialDiagram.ts) or, when
// every end is already included, just ties the net and drops its cut labels —
// so the poll below waits for either the block count to grow or the set of
// cut labels to change.
When('I extend every cut net in the partial diagram', async function (this: BddWorld) {
  const netLabels = this.webviewPage.locator('[data-node-kind="netLabel"]');
  const labelIdsSnapshot = () =>
    this.webviewPage.locator('html').evaluate(() =>
      Array.from(document.querySelectorAll('[data-node-kind="netLabel"]'))
        .map((el) => el.closest('.react-flow__node')?.getAttribute('data-id') ?? '')
        .sort()
        .join('|'),
    );
  const maxExtends = 40;
  for (let i = 0; i < maxExtends; i++) {
    if ((await netLabels.count()) === 0) break;
    const blocksBefore = await activePaneBlockCount(this);
    const labelsBefore = await labelIdsSnapshot();
    const label = netLabels.first();
    const extend = label.locator('.hdl-net-label-extend');
    await expect(extend).toBeAttached();
    // A dispatched click rather than a hover + pointer click: mid-rebuild the
    // growing diagram can push a label outside the viewport, or park another
    // node or label over its hover pill (which hangs outside the label's own
    // box, past its right edge — collision resolution only keeps label
    // *boxes* clear of each other). A real user pans or drags a node aside;
    // this bulk step is about extends landing, not pointer reachability,
    // which "I click the extend arrow on the cut net" still covers with a
    // real hover and click.
    await extend.dispatchEvent('click');
    await expect
      .poll(
        async () =>
          (await activePaneBlockCount(this)) > blocksBefore ||
          (await labelIdsSnapshot()) !== labelsBefore,
        { timeout: 10_000 },
      )
      .toBe(true);
    // Clear the hover so each build-up screenshot isn't captured mid-reveal.
    await this.webviewPage.locator('body').hover({ position: { x: 10, y: 10 }, force: true });
    await this.takeScreenshot(`After extending cut net ${i + 1}`);
  }
  await expect(netLabels).toHaveCount(0, { timeout: 10_000 });
  await this.takeScreenshot('After extending every cut net in the partial diagram');
});

Then('I should not see any cut net labels in the partial diagram', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('[data-node-kind="netLabel"]')).toHaveCount(0);
});

// The partial pane's toolbar mirrors the main diagram's (see DiagramToolbar
// in main.tsx — only the module select and Export SVG are gated off for
// partial), so "Auto Layout All" is available and releases every real block
// for one ELK pass exactly like it does on the main diagram. Unlike the main
// diagram's generic "I click {string} in the diagram toolbar" step, this
// can't poll the saved-layout file for a diff: the partial pane's layout
// lives only in the extension host's memory and is never written to disk
// (see PartialDiagramPanel) — the round trip is given time to settle instead.
// Waits for the "Remove" action (button click or hotkey) to actually drop a
// block from the active pane. Same rationale as "I add the selected block to
// the partial diagram": the partial never persists to a layout file, so there
// is nothing on disk to poll — only the rendered block count.
async function waitForPartialBlockCountBelow(world: BddWorld, before: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const blocks = await activePaneBlockCount(world);
    if (blocks < before) return;
    if (Date.now() > deadline) {
      throw new Error(`Partial pane block count did not drop below ${before} after Remove`);
    }
    await world.workbox.waitForTimeout(200);
  }
}

// Clicks the selection toolbar's "Remove" button (issue #408). Deliberately
// not the generic "I click the {string} button" step: that one polls the
// extension's saved layout file for a diff, which never fires for a partial
// pane edit (nothing here is ever persisted) — poll the rendered block count
// instead, same as "I add the selected block to the partial diagram".
When('I click the Remove button', async function (this: BddWorld) {
  const before = await activePaneBlockCount(this);
  const button = this.webviewPage.locator('.svsch-selection-toolbar button', { hasText: 'Remove' });
  await expect(button).toBeVisible();
  await button.click();
  await waitForPartialBlockCountBelow(this, before);
  await this.takeScreenshot('After clicking Remove');
});

// Keyboard equivalent of "Remove" — Backspace on Windows, Delete on macOS
// (see the Backspace/Delete handling in main.tsx's global keydown handler).
// Both key values are wired to the same action, so either fires it
// regardless of which physical key the current platform labels "delete".
async function pressRemoveHotkey(world: BddWorld, key: 'Backspace' | 'Delete'): Promise<void> {
  const before = await activePaneBlockCount(world);
  await world.webviewPage.locator('body').evaluate((_body, shortcutKey) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: shortcutKey, bubbles: true, cancelable: true }),
    );
  }, key);
  await waitForPartialBlockCountBelow(world, before);
  await world.takeScreenshot(`After pressing ${key} to remove the selected block`);
}

When('I press Backspace to remove the selected block', async function (this: BddWorld) {
  await pressRemoveHotkey(this, 'Backspace');
});

When('I press Delete to remove the selected block', async function (this: BddWorld) {
  await pressRemoveHotkey(this, 'Delete');
});

When('I click "Auto Layout All" in the partial diagram toolbar', async function (this: BddWorld) {
  await this.webviewPage.locator('body').hover({ position: { x: 10, y: 10 }, force: true });
  const button = this.webviewPage.locator('.toolbar button', { hasText: 'Auto Layout All' });
  await expect(button).toBeVisible();
  await button.click();
  await this.workbox.waitForTimeout(1000);
  await this.webviewPage.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });
  await this.takeScreenshot('After clicking Auto Layout All in the partial diagram');
});
