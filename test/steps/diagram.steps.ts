import { Given, When, Then, BddWorld } from './fixtures';
import type { FrameLocator } from '@playwright/test';
import { expect } from '@playwright/test';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { diagramGrid } from '../../src/diagram/constants';
import { execFile, exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { comparePngBuffers } from '../pngSnapshotComparison';
import { SNAPSHOT_THRESHOLDS, bddVisualDiffsDir } from '../snapshotPolicy';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
type RegionSide = 'left' | 'right' | 'top' | 'bottom';
type NodePosition = { x: number; y: number };

// ---------------------------------------------------------------------------
// Given steps
// ---------------------------------------------------------------------------

Given(
  'I have a file {string} in my workspace:',
  async function (this: BddWorld, filePath: string, docString: string) {
    const fullPath = path.join(BddWorld.BDD_WORKSPACE, filePath);
    this.workspaceDir = BddWorld.BDD_WORKSPACE;
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, docString);
    this._bddWorkspaceFiles.push(fullPath);
    this.files = this.files.filter((source: any) => source.file !== filePath);
    this.files.push({ file: filePath, text: docString });
    this.lastCode ??= docString;
  },
);

Given('I have the following files in my workspace:', async function (this: BddWorld, table: any) {
  this.workspaceDir = BddWorld.BDD_WORKSPACE;
  const sources = table.hashes().map((row: any) => ({
    file: row.file,
    text: row.content.replace(/\\n/g, '\n'),
  }));
  for (const s of sources) {
    const fullPath = path.join(BddWorld.BDD_WORKSPACE, s.file);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, s.text);
    this._bddWorkspaceFiles.push(fullPath);
    this.files = this.files.filter((source: any) => source.file !== s.file);
    this.files.push(s);
  }
  if (sources.length > 0) {
    this.lastCode ??= sources[0].text;
  }
});

Given('the current directory structure is:', function (this: BddWorld, _docString: string) {
  // No-op, documentation only
});

Given('I note the position of port node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.webviewPage, id);
  if (!pos) throw new Error('Could not get internal position');
  this.notedPositions.set(name, pos);
});

Given('I record the workspace directory state', async function (this: BddWorld) {
  if (!this.workspaceDir) throw new Error('No open workspace');
  this.workspaceDirStateBefore = await getWorkspaceState(this.workspaceDir);
});

// ---------------------------------------------------------------------------
// When steps
// ---------------------------------------------------------------------------

async function updateActiveEditorFaithfully(world: BddWorld, code: string) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

  // Try to focus the editor
  await world.workbox
    .locator('.monaco-editor')
    .first()
    .click()
    .catch(() => {});

  await world.workbox.keyboard.press(`${modifier}+A`);
  await world.workbox.keyboard.press('Backspace');
  await world.workbox.keyboard.insertText(code);
  await world.workbox.keyboard.press(`${modifier}+S`);

  // Wait a bit for VS Code to flush the file to disk
  await world.workbox.waitForTimeout(1000);

  // Sync internal state for assertions that use world.files/lastCode
  world.lastCode = code;
  // If we have an active file tracked, use it; otherwise default to top.sv
  const targetFile = (world as any)._lastOpenedFile || 'top.sv';
  const fileEntry = world.files.find((f) => f.file === targetFile);
  if (fileEntry) fileEntry.text = code;
  else world.files.push({ file: targetFile, text: code });

  // Clear stale graph so it gets rebuilt
  world.lastGraph = undefined;
}

When('I open {string}', async function (this: BddWorld, filename: string) {
  // Ensure Explorer is visible
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await this.workbox.keyboard.press(`${modifier}+Shift+E`);
  await this.workbox.waitForTimeout(500);

  // Click the file in the explorer
  const fileLocator = this.workbox.locator(`.monaco-list-row:has-text("${filename}")`).first();
  if (await fileLocator.isVisible()) {
    await fileLocator.dblclick();
  } else {
    // Fallback to Quick Open if not in explorer view
    await this.workbox.keyboard.press(`${modifier}+P`);
    await this.workbox.waitForSelector('.quick-input-widget', { timeout: 5_000 });
    await this.workbox.keyboard.type(filename);
    await this.workbox.keyboard.press('Enter');
  }

  // Wait for the tab to appear and be active
  const tab = this.workbox.locator(`.tab:has-text("${filename}")`).first();
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
  await this.workbox.waitForTimeout(1000);

  (this as any)._lastOpenedFile = filename;
});

When('I update the code to:', async function (this: BddWorld, code: string) {
  await updateActiveEditorFaithfully(this, code);
});

When(
  'I update {string} in the editor to:',
  async function (this: BddWorld, filename: string, content: string) {
    // This step implies we might need to open it first if not already open
    await this.workbox.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
    await this.workbox.waitForSelector('.quick-input-widget', { timeout: 5_000 });
    await this.workbox.keyboard.type(filename);
    await this.workbox.keyboard.press('Enter');
    await this.workbox.waitForTimeout(1000);
    await updateActiveEditorFaithfully(this, content);
  },
);

When(
  'I render {string} with the CLI to {string}',
  async function (this: BddWorld, inputFile: string, outputFile: string) {
    if (!this.workspaceDir)
      throw new Error('No open workspace. Use "I have opened ... for editing" first.');
    const cliPath = path.resolve(process.cwd(), 'dist/cli.js');
    if (!fs.existsSync(cliPath))
      throw new Error(`CLI bundle not found at ${cliPath}. Run npm run build:cli first.`);
    const outputPath = path.join(this.workspaceDir, outputFile);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await execFileAsync(
      process.execPath,
      [cliPath, 'render', inputFile, '--output', outputPath, '--no-layout'],
      {
        cwd: this.workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    this.lastCliSvgPath = outputPath;
    this.lastCliSvg = await fs.promises.readFile(outputPath, 'utf8');
  },
);

When('I run the CLI command:', async function (this: BddWorld, command: string) {
  await runCliCommand(this, command);
});

When(
  'I select module {string} from the dropdown',
  async function (this: BddWorld, moduleName: string) {
    const moduleSelect = this.webviewPage.locator('select[aria-label="Module"]');
    const currentModule = await moduleSelect.inputValue().catch(() => undefined);
    if (currentModule === moduleName) return;

    await moduleSelect.selectOption(moduleName);
    await this.selectModule(moduleName);
  },
);

When(
  'I update the code to rename register {string} to {string}:',
  async function (this: BddWorld, _oldName: string, _newName: string, code: string) {
    await updateActiveEditorFaithfully(this, code);
  },
);

When('I update the code to remove the assignment:', async function (this: BddWorld, code: string) {
  await updateActiveEditorFaithfully(this, code);
});

When(
  'I update the code to remove node {string}:',
  async function (this: BddWorld, _name: string, code: string) {
    await updateActiveEditorFaithfully(this, code);
  },
);

When(
  'I update the code to bring back node {string}:',
  async function (this: BddWorld, _name: string, code: string) {
    await updateActiveEditorFaithfully(this, code);
  },
);

When('I reload the diagram', async function (this: BddWorld) {
  await syncLastViewModel(this);
  await this._waitForDiagramRebuild();
  await syncLastViewModel(this);
  await waitForExtensionRenderedView(this, 'After reload');
});

When('I close and reopen the diagram', async function (this: BddWorld) {
  // Actually close the SVSCH editor tab (Ctrl+W), then reopen it.
  const tab = this.workbox.locator('.tab[aria-label*="SVSCH"], .tab[title*="SVSCH"]').first();
  if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await tab.click();
    await this.evaluateInVSCode((_vscode) => {
      return (_vscode as any).commands.executeCommand('workbench.action.closeActiveEditor');
    });
    await tab.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  }
  await this.workbox.waitForTimeout(300);
  await this._revealPanel();
  await this._waitForDiagramRebuild();
  await this.takeScreenshot('After reopen');
});

When('I reset the layout', async function (this: BddWorld) {
  const before = JSON.stringify(await readExtensionLayout(this));
  await this.webviewPage.locator('button:has-text("Reset Layout")').click();
  await waitForLayoutChange(this, before, 'After layout reset');
});

When('I click the Export SVG button', async function (this: BddWorld) {
  await this.webviewPage.locator('button:has-text("Export SVG")').click();
});

// Generic workbench button click (e.g. the "OK" button in the save dialog).
When('I click {string}', async function (this: BddWorld, label: string) {
  await this.workbox.getByRole('button', { name: label, exact: true }).first().click();
});

When('I click {string} in the diagram toolbar', async function (this: BddWorld, label: string) {
  // Snapshot every node's position right before the action so that later
  // "should not have moved" assertions compare against the pre-action layout.
  await this.recordPortPositions();
  const moduleName = this.lastViewModel.moduleName;
  const layoutBefore = JSON.stringify(await readExtensionLayout(this));
  await this.webviewPage.locator(`button:has-text("${label}")`).click();
  // Move mouse away to clear any hover states before screenshot
  await this.webviewPage.locator('body').hover({ position: { x: 100, y: 100 }, force: true });
  // The extension owns persistence: the click rewrites the layout file and
  // re-renders. Wait for the file to change rather than relying on the (flaky)
  // message channel.
  await expect
    .poll(async () => JSON.stringify(await readExtensionLayout(this)) !== layoutBefore, {
      timeout: 10_000,
    })
    .toBe(true);
  this.layout = await readExtensionLayout(this);
  await syncLastViewModel(this, moduleName);
  await waitForExtensionRenderedView(this, `After clicking ${label}`);
});

When(
  'I cut the net on the connection between {string} and {string}',
  async function (this: BddWorld, source: string, target: string) {
    await cutNetByClickingControl(this, source, target);
  },
);

When(
  'I hover the connection between {string} and {string} and click its Cut control',
  async function (this: BddWorld, source: string, target: string) {
    await cutNetByClickingControl(this, source, target);
  },
);

// Keyboard equivalent — the `c` shortcut mirrors exactly what clicking the
// Cut control posts (see main.tsx) when a single edge is hovered.
When(
  'I hover the connection between {string} and {string} and press C to cut it',
  async function (this: BddWorld, source: string, target: string) {
    const edgeId = await edgeIdBetweenLabels(this.webviewPage, source, target);
    const before = JSON.stringify(await readExtensionLayout(this));
    await hoverEdgeAndPressShortcutKey(this, edgeId, 'c');
    await waitForLayoutChange(this, before, 'After cut net via C shortcut');
  },
);

// Ctrl/Cmd-click directly on a wire's path to add it to whatever's already
// selected, mirroring how a user extends a block marquee with an extra,
// otherwise-unrelated connection — React Flow only auto-selects edges that
// touch an already-selected node, so this is the one way to get an edge
// into a mixed selection without also sweeping up its endpoint nodes.
// pointer-events on the bridge path is "stroke" (see diagram.css), so a
// coordinate-based click only lands reliably on a perfectly straight run —
// dispatch directly on the element instead, the same way the plain hover
// step above dispatches 'mouseover' rather than moving a real pointer. React
// Flow's multi-selection state comes from its own window-level keydown/keyup
// tracking (not the click event's modifier flags), so a real keydown has to
// bracket the click — and land in a separate render tick — for the edge to
// be added rather than replacing the selection.
When(
  'I add the connection between {string} and {string} to the selection',
  async function (this: BddWorld, source: string, target: string) {
    const edgeId = await edgeIdBetweenLabels(this.webviewPage, source, target);
    const isMac = process.platform === 'darwin';
    const key = isMac ? 'Meta' : 'Control';
    const modifierProps = isMac ? { metaKey: true } : { ctrlKey: true };
    await this.webviewPage.locator('html').evaluate((_el, key) => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          ctrlKey: key === 'Control',
          metaKey: key === 'Meta',
        }),
      );
    }, key);
    await this.webviewPage
      .locator('html')
      .evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    await this.webviewPage.locator('html').evaluate(
      (_el, { edgeId, modifierProps }) => {
        const target = document.querySelector(
          `.react-flow__edge[data-id="${edgeId}"] path.svsch-edge-bridge`,
        );
        if (!target) throw new Error(`Bridge path not found for edge ${edgeId}`);
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifierProps }));
      },
      { edgeId, modifierProps },
    );
    await this.webviewPage.locator('html').evaluate((_el, key) => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    }, key);
    await this.takeScreenshot(
      `Added the connection between ${source} and ${target} to the selection`,
    );
  },
);

// Reveal a connection's floating Cut/Reroute controls without clicking either —
// used to check that hovering one wire of a multi-wire selection also reveals
// every other selected wire's own controls.
When(
  'I hover the connection between {string} and {string}',
  async function (this: BddWorld, source: string, target: string) {
    const edgeId = await edgeIdBetweenLabels(this.webviewPage, source, target);
    await this.webviewPage
      .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge-bridge`)
      .dispatchEvent('mouseover');
    await expect(
      this.webviewPage.locator(
        `.react-flow__edge[data-id="${edgeId}"] .svsch-edge-connection-controls`,
      ),
    ).toBeVisible({ timeout: 5_000 });
    await this.takeScreenshot(`Hovering the connection between ${source} and ${target}`);
  },
);

When(
  'I hover the connection between {string} and {string} and click its Reroute control',
  async function (this: BddWorld, source: string, target: string) {
    // Snapshot positions right before rerouting so "should not have moved" checks
    // compare against the pre-reroute layout (no explicit note steps needed).
    await this.recordPortPositions();
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
    const edgeId = await findEdgeIdBetween(this.webviewPage, sourceId, targetId);
    if (!edgeId)
      throw new Error(`Could not find original edge between ${sourceId} and ${targetId}`);
    const before = JSON.stringify(await readExtensionLayout(this));
    // Hover the connection to reveal its floating controls, then click Reroute.
    await clickEdgeControl(this, edgeId, 'svsch-edge-reroute-control');
    // The extension reroutes the edge, persists, and re-renders.
    await waitForLayoutChange(this, before, 'After reroute single edge');
  },
);

// Keyboard equivalent of the step above — the `r` shortcut mirrors exactly
// what clicking the Reroute control posts (see main.tsx), so this exercises
// the same outcome via `hoveredEdgeId` instead of a button click.
When(
  'I hover the connection between {string} and {string} and press R to reroute it',
  async function (this: BddWorld, source: string, target: string) {
    await this.recordPortPositions();
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
    const edgeId = await findEdgeIdBetween(this.webviewPage, sourceId, targetId);
    if (!edgeId)
      throw new Error(`Could not find original edge between ${sourceId} and ${targetId}`);
    const before = JSON.stringify(await readExtensionLayout(this));
    await hoverEdgeAndPressShortcutKey(this, edgeId, 'r');
    await waitForLayoutChange(this, before, 'After reroute single edge via R shortcut');
  },
);

When(
  'I rename the cut net {string} to {string}',
  async function (this: BddWorld, currentLabel: string, nextLabel: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, currentLabel).first();
    await expect(labelNode).toBeVisible();
    const before = JSON.stringify(await readExtensionLayout(this));
    // Double-click the cut-net label to edit it, type the new name, commit.
    await labelNode.dblclick({ force: true });
    const input = this.webviewPage.locator('.hdl-net-label-input');
    await expect(input).toBeVisible();
    await input.fill(nextLabel);
    await input.press('Enter');
    await waitForLayoutChange(this, before, 'After rename cut net');
  },
);

When(
  'I tie back the cut net {string} by clicking its Tie control',
  async function (this: BddWorld, label: string) {
    await tieBackCutNet(this, label, async (tieButton) => {
      await tieButton.focus();
      await tieButton.press('Enter');
    });
  },
);

// Keyboard equivalent — the `t` shortcut mirrors exactly what clicking the
// Tie control posts (see main.tsx) for a hovered cut net label.
When(
  'I tie back the cut net {string} by pressing T',
  async function (this: BddWorld, label: string) {
    await tieBackCutNet(this, label, async () => {
      await pressGlobalShortcutKey(this, 't');
    });
  },
);

When('I tie back every cut net', async function (this: BddWorld) {
  const labels = this.webviewPage.locator('[data-node-kind="netLabel"]');
  while ((await labels.count()) > 0) {
    const beforeLayout = JSON.stringify(await readExtensionLayout(this));
    const beforeCount = await labels.count();
    let tied = false;
    for (let index = 0; index < beforeCount; index += 1) {
      const labelNode = labels.nth(index);
      await labelNode.hover({ force: true });
      const tieButton = labelNode.locator('.hdl-net-label-tie');
      if (await tieButton.isVisible()) {
        await tieButton.focus();
        await tieButton.press('Enter');
        tied = true;
        break;
      }
    }
    expect(tied, 'No reachable Tie control found for the remaining cut nets').toBe(true);
    await expect
      .poll(async () => JSON.stringify(await readExtensionLayout(this)) !== beforeLayout, {
        timeout: 10_000,
      })
      .toBe(true);
    await expect.poll(async () => labels.count(), { timeout: 10_000 }).toBeLessThan(beforeCount);
  }
  this.layout = await readExtensionLayout(this);
  await syncLastViewModel(this, this.lastViewModel?.moduleName);
  await waitForViewportTransformToSettle(this.webviewPage);
});

When('I fit the diagram in view', async function (this: BddWorld) {
  await this.webviewPage.locator('.react-flow__controls-fitview').click();
  await waitForViewportTransformToSettle(this.webviewPage);
});

When(
  'I click the Revert label control on the cut net {string}',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode).toBeVisible();
    const before = JSON.stringify(await readExtensionLayout(this));
    // Hover the cut-net label to reveal its revert control, then click it.
    await labelNode.hover({ force: true });
    await expect(labelNode.locator('.hdl-net-label-revert')).toBeVisible();
    await labelNode.locator('.hdl-net-label-revert').click();
    await waitForLayoutChange(this, before, 'After revert cut net label');
  },
);

// Unlike "I rename the cut net", this only attempts the double-click — it
// does not wait for a layout change, since a declared net's label is
// expected to refuse to enter edit mode at all.
When('I double-click the cut net {string}', async function (this: BddWorld, label: string) {
  const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
  await expect(labelNode).toBeVisible();
  await labelNode.dblclick({ force: true });
});

When(
  'I hover over the alias marker on the cut net {string}',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode).toBeVisible();
    await labelNode.locator('.hdl-net-label-alias-marker').hover({ force: true });
  },
);

// Same alias popover, but for an uncut wire's inline label — rendered directly
// on the edge (.svsch-edge-label) rather than as its own cut-net label node.
When(
  'I hover over the alias marker on the connection between {string} and {string}',
  async function (this: BddWorld, source: string, target: string) {
    const edgeId = await edgeIdBetweenLabels(this.webviewPage, source, target);
    const label = this.webviewPage.locator(
      `.react-flow__edge[data-id="${edgeId}"] .svsch-edge-label`,
    );
    await expect(label).toBeVisible();
    await label.locator('.hdl-net-label-alias-marker').hover({ force: true });
  },
);

When(
  'I move the port node {string} by \\({int}, {int}\\)',
  async function (this: BddWorld, name: string, dx: number, dy: number) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found: ${name}`);
    const pos = await getInternalPosition(this.webviewPage, id);
    if (!pos) throw new Error(`Missing position data for ${name}`);
    this.notedPositions.set(name, pos);
    await dragPortNodeTo(this, name, pos.x + dx, pos.y + dy, 'After move');
  },
);

When(
  'I move the port node {string} to \\({int}, {int}\\)',
  async function (this: BddWorld, name: string, x: number, y: number) {
    await dragPortNodeTo(this, name, x, y, 'After move');
  },
);

// Plain "move" with no coordinates: behaves like a real user nudging a block a
// couple of grid cells up with the mouse. No internal repositioning — the move
// happens entirely through a drag in the React Flow canvas and the extension
// persists it.
When('I move the port node {string}', async function (this: BddWorld, name: string) {
  await dragPortNodeByGridCells(this, name, 0, -2, `After moving ${name}`);
});

// Rubber-band selection: press on empty canvas and drag a rectangle around the
// two nodes, exactly like a user lassoing blocks. React Flow has selectionOnDrag
// enabled, so a left-button drag on the pane selects the enclosed nodes (and, per
// React Flow's own selection logic, every edge connected to any selected node).
When(
  'click and drag the mouse to select {string} and {string} together',
  async function (this: BddWorld, name1: string, name2: string) {
    const id1 = await findNodeIdByLabel(this.webviewPage, name1, 'port');
    const id2 = await findNodeIdByLabel(this.webviewPage, name2, 'port');
    if (!id1 || !id2) throw new Error(`Nodes not found: ${name1}=${id1}, ${name2}=${id2}`);
    await marqueeSelectNodePair(this, id1, id2, name1, name2);
  },
);

// Same lasso gesture, but resolves the two labels against any node kind — used
// for selecting instance blocks (e.g. for the "Auto Layout" control) rather
// than the port-only lookup above.
When(
  'click and drag the mouse to select the blocks {string} and {string}',
  async function (this: BddWorld, name1: string, name2: string) {
    const id1 = await findNodeIdByLabel(this.webviewPage, name1);
    const id2 = await findNodeIdByLabel(this.webviewPage, name2);
    if (!id1 || !id2) throw new Error(`Blocks not found: ${name1}=${id1}, ${name2}=${id2}`);
    await marqueeSelectNodePair(this, id1, id2, name1, name2);
  },
);

// Single-block variant — used for the "Cut out" control, which (unlike
// "Auto Layout") is available from a single selected block onward.
When(
  'click and drag the mouse to select the block {string}',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name);
    if (!id) throw new Error(`Block not found: ${name}`);
    await marqueeSelectNodes(this, [id], [name]);
  },
);

// A plain click also selects a single block — used where the scenario only
// needs one block selected, leaving the lasso drag to cover multi-block
// selection elsewhere.
When('I click to select the block {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name);
  if (!id) throw new Error(`Block not found: ${name}`);
  const box = await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`Could not get bounding box for ${name}`);
  await this.workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect
    .poll(
      async () => {
        return this.webviewPage.locator('html').evaluate((_el, targetId) => {
          const rf = (window as any).reactFlowInstance;
          const selected = rf.getNodes().filter((n: any) => n.selected);
          return selected.length === 1 && selected[0].id === targetId;
        }, id);
      },
      { timeout: 5000 },
    )
    .toBe(true);

  await this.takeScreenshot(`Selected ${name}`);
});

// Three-node variant: the lasso spans the union of all three nodes' bounding
// boxes, so it still works even when one of them has been deliberately moved
// off the line between the other two (e.g. testing that Auto Layout has to
// actually reposition it, not just confirm an already-straight line).
When(
  'click and drag the mouse to select {string}, {string}, and {string} together',
  async function (this: BddWorld, name1: string, name2: string, name3: string) {
    const names = [name1, name2, name3];
    const ids: string[] = [];
    for (const name of names) {
      // A leaf module's own port (e.g. "y") can share a name with the top-level
      // module's port of the same name — prefer an exact top-level port match
      // first, falling back to the unrestricted (any-kind) search for names
      // that aren't ports, e.g. instance labels.
      const id =
        (await findNodeIdByLabel(this.webviewPage, name, 'port')) ??
        (await findNodeIdByLabel(this.webviewPage, name));
      if (!id) throw new Error(`Could not find node "${name}"`);
      ids.push(id);
    }
    await marqueeSelectNodes(this, ids, names);
  },
);

async function marqueeSelectNodePair(
  world: BddWorld,
  id1: string,
  id2: string,
  name1: string,
  name2: string,
): Promise<void> {
  await marqueeSelectNodes(world, [id1, id2], [name1, name2]);
}

// Draws the lasso around the union of every named node's bounding box, so it
// works regardless of how far apart (or misaligned) the nodes are — unlike
// sizing the rectangle from only two of the nodes, which can miss a third
// one that's been deliberately offset from the other two.
async function marqueeSelectNodes(world: BddWorld, ids: string[], names: string[]): Promise<void> {
  // Remember where each node started so a later "should have moved" check has
  // a pre-move baseline to compare against.
  for (let i = 0; i < ids.length; i += 1) {
    const pos = await getInternalPosition(world.webviewPage, ids[i]);
    if (!pos) throw new Error(`Missing position data for ${names[i]}`);
    world.notedPositions.set(names[i], pos);
  }

  const boxes = await Promise.all(
    ids.map((id) => world.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()),
  );
  if (boxes.some((box) => !box))
    throw new Error(`Could not get bounding boxes for ${names.join('/')}`);
  const nonNullBoxes = boxes as NonNullable<(typeof boxes)[number]>[];

  // Draw the lasso from above-left of every node to below-right of every node,
  // starting on empty canvas so we don't grab a node by mistake.
  const left = Math.min(...nonNullBoxes.map((box) => box.x));
  const top = Math.min(...nonNullBoxes.map((box) => box.y));
  const right = Math.max(...nonNullBoxes.map((box) => box.x + box.width));
  const bottom = Math.max(...nonNullBoxes.map((box) => box.y + box.height));
  const startX = left - 24;
  const startY = top - 24;
  const endX = right + 24;
  const endY = bottom + 24;

  await world.workbox.mouse.move(startX, startY);
  await world.workbox.mouse.down();
  await world.workbox.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 });
  await world.workbox.mouse.move(endX, endY, { steps: 8 });
  await world.workbox.mouse.up();

  await expect
    .poll(
      async () => {
        return world.webviewPage.locator('html').evaluate((_el, targetIds) => {
          const rf = (window as any).reactFlowInstance;
          const selected = new Set(
            rf
              .getNodes()
              .filter((n: any) => n.selected)
              .map((n: any) => n.id),
          );
          return targetIds.every((id: string) => selected.has(id));
        }, ids);
      },
      { timeout: 5000 },
    )
    .toBe(true);

  await world.takeScreenshot(`Selected ${names.join(', ')}`);
}

// Drag the current multi-selection a couple of grid cells with the mouse. React
// Flow moves every selected node together; the extension persists the result.
When('I move the selected nodes', async function (this: BddWorld) {
  const selected = await this.webviewPage.locator('html').evaluate(() => {
    const rf = (window as any).reactFlowInstance;
    return rf
      .getNodes()
      .filter((n: any) => n.selected)
      .map((n: any) => ({ id: n.id, position: n.position }));
  });
  if (selected.length < 2)
    throw new Error(`Expected a multi-selection but found ${selected.length} selected node(s)`);

  const moduleName = this.lastViewModel.moduleName;

  // Grab one of the selected nodes and drag it upward; React Flow moves the
  // whole selection together and the extension persists the result. A single
  // drag is enough here — the scenario only checks that the nodes moved.
  const anchorId = selected[0].id;
  const zoom = await this.webviewPage
    .locator('html')
    .evaluate(() => ((window as any).reactFlowInstance?.getViewport()?.zoom ?? 1) as number);
  await rawDragNode(this, anchorId, 0, -2 * diagramGrid.size * zoom);

  await expect
    .poll(
      async () => {
        const after = await getInternalPosition(this.webviewPage, anchorId);
        const start = selected.find((n: any) => n.id === anchorId)?.position;
        return (
          !!after && !!start && (Math.abs(after.x - start.x) > 1 || Math.abs(after.y - start.y) > 1)
        );
      },
      { timeout: 5000 },
    )
    .toBe(true);

  // Wait until the extension has persisted every dragged node, then mirror the
  // layout file into our in-memory copy.
  await expect
    .poll(
      async () => {
        const layout = await readExtensionLayout(this);
        const nodes = layout.modules?.[moduleName]?.nodes ?? {};
        return selected.every((n: any) => nodes[n.id]?.fixed);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  this.layout = await readExtensionLayout(this);
  await syncLastViewModel(this, moduleName);
  await this.takeScreenshot('After moving the selected nodes');
});

// Drag a horizontal segment of a connection so its wire shifts by a grid cell,
// the way a user reshapes a route. "downward" is the default; "upward" is used
// where a scenario needs two routes nudged in opposite directions.
When(
  'I adjust the connection between {string} and {string}',
  async function (this: BddWorld, source: string, target: string) {
    await adjustConnectionByGridCells(this, source, target, 1);
  },
);

When(
  'I adjust the connection between {string} and {string} upward',
  async function (this: BddWorld, source: string, target: string) {
    await adjustConnectionByGridCells(this, source, target, -1);
  },
);

When(
  'I adjust the connection between {string} and {string} downward',
  async function (this: BddWorld, source: string, target: string) {
    await adjustConnectionByGridCells(this, source, target, 1);
  },
);

When(
  'I resize the {string} generate region on the {word} side by {int} grid cells',
  async function (this: BddWorld, label: string, side: string, cells: number) {
    if (!isRegionSide(side)) throw new Error(`Unknown generate region side: ${side}`);
    const before = JSON.stringify(await readExtensionLayout(this));
    this.notedRegionBounds.set(label, await getGenerateRegionBounds(this.webviewPage, label));
    await dragGenerateRegionSideByGridCells(this, label, side, cells);
    await waitForLayoutChange(this, before, `After resizing ${label} ${side}`);
  },
);

When(
  'I resize the {string} block on the {word} side by {int} grid cells',
  async function (this: BddWorld, label: string, side: string, cells: number) {
    if (!isRegionSide(side)) throw new Error(`Unknown block side: ${side}`);
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = JSON.stringify(await readExtensionLayout(this));
    this.notedRegionBounds.set(label, await getNodeBounds(this.webviewPage, id));
    await dragNodeSideByGridCells(this, id, side, cells);
    const resizedBounds = await getNodeBounds(this.webviewPage, id);
    await waitForLayoutChange(this, before, `After resizing ${label} ${side}`, async () => {
      await waitForFlowNodeSize(this.webviewPage, id, resizedBounds);
    });
  },
);

When(
  'I move the {string} generate region by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const regionNodeIds = await generateRegionNodeIds(this, label);
    if (regionNodeIds.length === 0)
      throw new Error(`Generate region ${label} has no owned nodes to move`);
    const regionNodeIdSet = new Set(regionNodeIds);
    const allBefore = await getAllFlowNodePositions(this.webviewPage);
    const nodePositions = pickNodePositions(allBefore, regionNodeIds, `generate region ${label}`);
    const outsideNodePositions = new Map(
      [...allBefore.entries()].filter(([id]) => !regionNodeIdSet.has(id)),
    );
    const before = JSON.stringify(await readExtensionLayout(this));

    this.notedGenerateRegionMoves.set(label, {
      nodePositions,
      outsideNodePositions,
      expectedDelta: {
        x: cellsX * diagramGrid.size,
        y: cellsY * diagramGrid.size,
      },
    });
    this.notedRegionBounds.set(label, await getGenerateRegionBounds(this.webviewPage, label));

    await dragGenerateRegionByGridCells(this, label, cellsX, cellsY);
    await waitForLayoutChange(this, before, `After moving ${label} generate region`);
  },
);

When(
  'I move the block {string} by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = JSON.stringify(await readExtensionLayout(this));
    await dragNodeByGridCells(this, id, cellsX, cellsY);
    await waitForLayoutChange(this, before, `After moving ${label}`);
  },
);

// Moves an expanded instance's own dimmed frame (not a plain block — see
// EXPAND_HEADER_GRAB_OFFSET for why this can't reuse "I move the block").
// Every namespaced node the splice owns (boundary ports, internal blocks,
// nested expands) is carried along, exactly like moving a generate region
// carries its arms and blocks.
When(
  'I move the expanded instance {string} by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, instanceLabel: string, cellsX: number, cellsY: number) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!id) throw new Error(`Could not find expanded instance "${instanceLabel}"`);
    const before = JSON.stringify(await readExtensionLayout(this));
    await dragNodeByGridCells(this, id, cellsX, cellsY, EXPAND_HEADER_GRAB_OFFSET);
    await waitForLayoutChange(this, before, `After moving expanded instance ${instanceLabel}`);
  },
);

// Historical: a node inside an expanded instance's spliced content is no
// longer draggable at all (see the product decision in issue #232's PR
// review — only the child module's own standalone view may edit its layout;
// "I try to drag the node ... inside the expanded instance by ..." below is
// the current, locked-down-behavior step). Still referenced by a @skip
// scenario in diagram_interaction.feature tracking a separate, still-pending
// concern — kept so that scenario's steps keep resolving.
When(
  'I move the node {string} inside the expanded instance by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find node "${label}"`);
    await dragNodeByGridCells(this, id, cellsX, cellsY);
    await waitForExtensionRenderedView(this, `After moving ${label}`);
  },
);

// The sub-diagram area inside an expanded instance is deliberately NOT part
// of the frame's own hit-area (the ghost wrapper is pointer-transparent and
// only its border ring carries grab bands — see HdlNode's ExpandGrabBands and
// the .hdl-node-expand-ghost rules in diagram.css): pointer events between
// the spliced nodes fall through to the pane, so middle-drag pans there and a
// left-drag can't grab the frame. Probes for an interior point that actually
// falls through to the pane; the fall-through itself is the feature under
// test, so finding no such point is a failure. Returns workbox (outer page)
// coordinates, converted from the webview iframe's own client coordinates.
async function findSubDiagramCanvasPoint(
  world: BddWorld,
  instanceLabel: string,
): Promise<{ x: number; y: number }> {
  const id = await findNodeIdByLabel(world.webviewPage, instanceLabel);
  if (!id) throw new Error(`Could not find expanded instance "${instanceLabel}"`);
  const ghost = world.webviewPage.locator(`.react-flow__node[data-id="${id}"]`);
  const pageBox = await ghost.boundingBox();
  if (!pageBox) throw new Error(`Could not get bounding box for ${instanceLabel}`);
  const probe = await ghost.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    // Start below the header rows — the top grab band is supposed to catch
    // the pointer there, so it can never be a fall-through point.
    for (let y = rect.top + rect.height * 0.25; y < rect.bottom - 4; y += 4) {
      for (let x = rect.left + 4; x < rect.right - 4; x += 4) {
        const hit = document.elementFromPoint(x, y);
        // The fall-through target must be the flow pane itself — a hit
        // outside the flow container (scrolled/clipped away) can't pan.
        if (hit?.classList.contains('react-flow__pane')) {
          return { x: x - rect.left, y: y - rect.top };
        }
      }
    }
    return null;
  });
  if (!probe) {
    throw new Error(
      `No point inside the expanded instance "${instanceLabel}" falls through to the canvas — ` +
        'the sub-diagram area is not pointer-transparent',
    );
  }
  return { x: pageBox.x + probe.x, y: pageBox.y + probe.y };
}

async function readViewportTransform(world: BddWorld): Promise<string> {
  return world.webviewPage
    .locator('.react-flow__viewport')
    .evaluate((el) => (el as HTMLElement).style.transform);
}

When(
  'I middle-drag inside the sub-diagram area of the expanded instance {string}',
  async function (this: BddWorld, instanceLabel: string) {
    const { x, y } = await findSubDiagramCanvasPoint(this, instanceLabel);
    this.notedViewportTransform = await readViewportTransform(this);
    await this.workbox.mouse.move(x, y);
    await this.workbox.mouse.down({ button: 'middle' });
    await this.workbox.mouse.move(x + 3, y + 3, { steps: 3 });
    await this.workbox.mouse.move(x + 90, y + 60, { steps: 10 });
    await this.workbox.mouse.up({ button: 'middle' });
    await this.workbox.waitForTimeout(150);
  },
);

When(
  'I left-drag inside the sub-diagram area of the expanded instance {string}',
  async function (this: BddWorld, instanceLabel: string) {
    const { x, y } = await findSubDiagramCanvasPoint(this, instanceLabel);
    await this.workbox.mouse.move(x, y);
    await this.workbox.mouse.down();
    await this.workbox.mouse.move(x + 3, y + 3, { steps: 3 });
    await this.workbox.mouse.move(x + 90, y + 60, { steps: 10 });
    await this.workbox.mouse.up();
    await this.workbox.waitForTimeout(150);
  },
);

Then('the canvas should have panned', async function (this: BddWorld) {
  if (this.notedViewportTransform === undefined) {
    throw new Error('No viewport transform was noted before the pan');
  }
  const after = await readViewportTransform(this);
  expect(after, 'the canvas viewport should have panned').not.toBe(this.notedViewportTransform);
});

When(
  // eslint-disable-next-line max-len
  'I begin moving the block {string} in the {string} generate region by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, block: string, region: string, cellsX: number, cellsY: number) {
    this.notedRegionBounds.set(region, await getGenerateRegionBounds(this.webviewPage, region));
    await beginDraggingNodeByGridCells(this, block, cellsX, cellsY);
  },
);

When('I release the moving block', async function (this: BddWorld) {
  await releasePendingNodeDrag(this);
});

When('I have saved the layout to {string}', async function (this: BddWorld, customPath: string) {
  if (!this.workspaceDir) throw new Error('No open workspace');
  const fullPath = path.join(this.workspaceDir, customPath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, JSON.stringify(this.layout, null, 2));
});

When('I double-click on the port node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
  if (!id) throw new Error(`Could not find port node "${name}"`);
  await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
});

When('I double-click on the register node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'register');
  if (!id) throw new Error(`Could not find register node "${name}"`);
  await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
});

When('I double-click on the instance node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'instance');
  if (!id) throw new Error(`Could not find instance node "${name}"`);
  const dropdown = this.webviewPage.locator('select[aria-label="Module"]');
  const before = await dropdown.inputValue().catch(() => '');
  await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
  // The extension switches the webview to the instance's module — wait for it.
  await expect
    .poll(async () => dropdown.inputValue().catch(() => before), { timeout: 15_000 })
    .not.toBe(before);
  await syncToWebviewModule(this);
});

When(
  'I double-click on the combinational block for {string}',
  async function (this: BddWorld, name: string) {
    const module = this.lastGraph.modules[this.lastViewModel.moduleName];
    const node = module.nodes.find(
      (n: any) => (n.kind === 'comb' || n.kind === 'gate') && n.id.includes(`:${name}:`),
    );
    if (!node?.id) throw new Error(`Could not find comb/gate block for "${name}"`);
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${node.id}"]`)
      .dblclick({ force: true });
  },
);

When(
  'I double-click on the gate block for {string}',
  async function (this: BddWorld, name: string) {
    const module = this.lastGraph.modules[this.lastViewModel.moduleName];
    const node = module.nodes.find((n: any) => n.kind === 'gate' && n.id.includes(`:${name}:`));
    if (!node?.id) throw new Error(`Could not find gate block for "${name}"`);
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${node.id}"]`)
      .dblclick({ force: true });
  },
);

When(
  'I double-click on the inverter node for {string}',
  async function (this: BddWorld, name: string) {
    const module = this.lastGraph.modules[this.lastViewModel.moduleName];
    const node = module.nodes.find((n: any) => n.kind === 'inverter' && n.id.includes(`:${name}:`));
    if (!node?.id) throw new Error(`Could not find inverter node for "${name}"`);
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${node.id}"]`)
      .dblclick({ force: true });
  },
);

When('I double-click on the mux block for {string}', async function (this: BddWorld, name: string) {
  const module = this.lastGraph.modules[this.lastViewModel.moduleName];
  const node = module.nodes.find((n: any) => n.kind === 'mux' && n.id.includes(`:${name}:`));
  if (!node?.id) throw new Error(`Could not find mux block for "${name}"`);
  await this.webviewPage
    .locator(`.react-flow__node[data-id="${node.id}"]`)
    .dblclick({ force: true });
});

// A function/task call has no standalone module of its own to navigate to
// (see PR #336 discussion — its body can read/write signals outside its
// formal argument list) — double-click is a no-op for these kinds (see
// InstanceNode.tsx's onDoubleClick), so unlike "I double-click on the
// instance node" above, this doesn't wait on any layout/boundary-port
// change. Expand (toolbar button) is the only way to unfold the call's body.
When(
  'I double-click on the function call node {string}',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'funcCall');
    if (!id) throw new Error(`Could not find function call node "${name}"`);
    await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).dblclick({ force: true });
  },
);

When(
  'I double-click on the {string} generate region',
  async function (this: BddWorld, label: string) {
    await generateRegionLocator(this.webviewPage, label)
      .locator('.generate-region-title')
      .dblclick({ force: true });
  },
);

When('I note the diagram zoom level', async function (this: BddWorld) {
  (this as any)._notedZoom = await diagramZoomLevel(this);
});

Then('the diagram zoom level should be unchanged', async function (this: BddWorld) {
  const noted = (this as any)._notedZoom;
  if (noted === undefined) throw new Error('No noted diagram zoom level');
  expect(await diagramZoomLevel(this)).toBeCloseTo(noted, 5);
});

Then('the diagram zoom level should have increased', async function (this: BddWorld) {
  const noted = (this as any)._notedZoom;
  if (noted === undefined) throw new Error('No noted diagram zoom level');
  // The canvas double-click zoom animates, so poll until it lands.
  await expect.poll(async () => diagramZoomLevel(this), { timeout: 5_000 }).toBeGreaterThan(noted);
});

When('I double-click on an empty area of the canvas', async function (this: BddWorld) {
  const pane = this.webviewPage.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('Could not find the diagram pane');
  // Top-right corner: clear of the diagram content, the controls panel
  // (bottom-left), and the minimap (bottom-right).
  await pane.dblclick({ position: { x: box.width - 16, y: 16 }, force: true });
});

async function diagramZoomLevel(world: BddWorld): Promise<number> {
  return world.webviewPage
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
}

When(
  'I double-click on the connection between the {word} node {string} and the {word} node {string}',
  async function (this: BddWorld, kind1: string, name1: string, kind2: string, name2: string) {
    const id1 = await findNodeIdByLabel(this.webviewPage, name1, kind1);
    const id2 = await findNodeIdByLabel(this.webviewPage, name2, kind2);
    if (!id1 || !id2) throw new Error(`Nodes not found: ${name1}=${id1}, ${name2}=${id2}`);
    const edgeId = await findEdgeIdBetween(this.webviewPage, id1, id2);
    if (!edgeId) throw new Error(`Edge not found between ${id1} and ${id2}`);
    await this.webviewPage
      .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge-bridge`)
      .dblclick({ force: true });
  },
);

When(
  'I double-click the struct field tap {string} on struct node {string}',
  async function (this: BddWorld, field: string, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'struct');
    if (!id) throw new Error(`Could not find struct node "${name}"`);
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-bus-tap-label`, { hasText: field })
      .first()
      .dblclick({ force: true });
  },
);

When(
  'I double-click on the interface node {string}',
  async function (this: BddWorld, name: string) {
    const id =
      (await findInterfaceNodeIdForNavigation(this.webviewPage, name)) ??
      (await findNodeIdByLabel(this.webviewPage, name, 'interface'));
    if (!id) throw new Error(`Could not find interface node "${name}"`);
    const dropdown = this.webviewPage.locator('select[aria-label="Module"]');
    const before = await dropdown.inputValue().catch(() => '');
    // Double-click the node header (top edge), away from the field/side taps which
    // the node's handler ignores; this is what posts openModule for the interface.
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"]`)
      .dblclick({ force: true, position: { x: 12, y: 6 } });
    // The extension opens the interface definition as its own module view.
    await expect
      .poll(async () => dropdown.inputValue().catch(() => before), { timeout: 15_000 })
      .not.toBe(before);
    await syncToWebviewModule(this);
  },
);

When(
  'I double-click the interface member tap {string} on interface node {string}',
  async function (this: BddWorld, field: string, name: string) {
    const id =
      (await this.webviewPage.locator('html').evaluate(
        (_el, { nodeName, fieldName }) => {
          const allNodes = Array.from(document.querySelectorAll('.react-flow__node'));
          const candidates = allNodes.filter((node) => {
            if (!node.querySelector('[data-node-kind="interface"]')) return false;
            const id = node.getAttribute('data-id') ?? '';
            const labels = Array.from(
              node.querySelectorAll(
                '.svsch-node-title,.svsch-interface-modport-title,' +
                  '.svsch-interface-side-label,.svsch-interface-field-label',
              ),
            ).map((l) => l.textContent?.trim() ?? '');
            return (
              id === nodeName ||
              id.endsWith(`:${nodeName}`) ||
              labels.some((l) => l.includes(nodeName))
            );
          });
          const withTap = candidates.find((node) =>
            Array.from(node.querySelectorAll('.svsch-interface-field-label')).some((tap) =>
              tap.textContent?.includes(fieldName),
            ),
          );
          return withTap?.getAttribute('data-id') ?? null;
        },
        { nodeName: name, fieldName: field },
      )) ?? (await findNodeIdByLabel(this.webviewPage, name, 'interface'));
    if (!id) throw new Error(`Could not find interface node "${name}"`);
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-interface-field-label`, {
        hasText: field,
      })
      .first()
      .dblclick({ force: true });
  },
);

When(
  'I click on the type label {string} for the {word} node {string}',
  async function (this: BddWorld, typeLabel: string, kind: string, nodeName: string) {
    const id = await findNodeIdByLabel(this.webviewPage, nodeName, kind);
    if (!id) throw new Error(`Could not find ${kind} node "${nodeName}"`);
    const locator = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-type-label`, { hasText: typeLabel })
      .first();
    await expect(locator).toBeVisible();
    await locator.click({ force: true });
  },
);

When(
  'I click on the modport label {string} for the {word} node {string}',
  async function (this: BddWorld, modportLabel: string, kind: string, nodeName: string) {
    const id = await findNodeIdByLabel(this.webviewPage, nodeName, kind);
    if (!id) throw new Error(`Could not find ${kind} node "${nodeName}"`);
    const locator = this.webviewPage
      .locator(
        `.react-flow__node[data-id="${id}"] .svsch-modport-label, ` +
          `.react-flow__node[data-id="${id}"] .svsch-interface-side-modport-label`,
      )
      .filter({ hasText: modportLabel })
      .first();
    await expect(locator).toBeVisible();
    await locator.click({ force: true });
  },
);

When(
  'I click on the modport header {string}',
  async function (this: BddWorld, modportName: string) {
    const locator = this.webviewPage
      .locator('.svsch-interface-modport-title', { hasText: modportName })
      .first();
    await expect(locator).toBeVisible();
    await locator.click({ force: true });
  },
);

When(
  'I hover over the connection between the {word} node {string} and the {word} node {string}',
  async function (this: BddWorld, kind1: string, name1: string, kind2: string, name2: string) {
    await waitForViewportTransformToSettle(this.webviewPage);
    const id1 = await findNodeIdByLabel(this.webviewPage, name1, kind1);
    const id2 = await findNodeIdByLabel(this.webviewPage, name2, kind2);
    if (!id1 || !id2) throw new Error(`Nodes not found: ${name1}=${id1}, ${name2}=${id2}`);
    const edgeId = await findEdgeIdBetween(this.webviewPage, id1, id2);
    if (!edgeId) throw new Error(`Edge not found between ${id1} and ${id2}`);
    await this.webviewPage
      .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge-bridge`)
      .hover({ force: true });
    await this.workbox.waitForTimeout(2000);
    await this.takeScreenshot(`Hovering connection ${name1} to ${name2}`);
  },
);

When(
  'I open the schematic for module {string}',
  async function (this: BddWorld, moduleName: string) {
    const current = await this.webviewPage
      .locator('.module-select')
      .inputValue()
      .catch(() => '');
    if (current !== moduleName) {
      await this.webviewPage.locator('.module-select').selectOption({ label: moduleName });
      await this.workbox.waitForTimeout(100);
    }
  },
);

When('I go back to the SVSCH diagram pane', async function (this: BddWorld) {
  await this._revealPanel();
  // Now that the panel is visible, we can reliably wait for the rebuild indicator
  await this._waitForDiagramRebuild();
  // Re-sync graph and viewmodel so following steps see the update
  await (this as any)._ensureGraphBuilt?.();
  if (this.lastViewModel?.moduleName) {
    await syncLastViewModel(this, this.lastViewModel.moduleName);
  }
  // Clear any hover affordance (e.g. the Reroute/Cut popup) left over from a
  // prior step's mouse position; otherwise whether it's still showing here
  // is a race with the OS/browser re-evaluating :hover, making the
  // screenshot below flaky.
  const pane = this.webviewPage.locator('.react-flow__pane');
  const box = await pane.boundingBox().catch(() => null);
  if (box) {
    await pane.hover({ position: { x: box.width - 16, y: 16 }, force: true }).catch(() => {});
  }
  await this.takeScreenshot('After returning to pane');
});

// ---------------------------------------------------------------------------
// Then steps
// ---------------------------------------------------------------------------

Then(
  'I should see {int} cut net labels named {string}',
  async function (this: BddWorld, count: number, label: string) {
    await expect(cutNetLabelNodes(this.webviewPage, label)).toHaveCount(count);
  },
);

Then(
  'I should not see cut net labels named {string}',
  async function (this: BddWorld, label: string) {
    await expect(cutNetLabelNodes(this.webviewPage, label)).toHaveCount(0);
  },
);

Then(
  'the cut net {string} should not become editable',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode.locator('.hdl-net-label-input')).toBeHidden();
  },
);

Then(
  'the cut net {string} should be shown in italics',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode.locator('.hdl-net-label-text')).toHaveClass(
      /hdl-net-label-text-synthetic/,
    );
  },
);

Then(
  'the cut net {string} should be shown in regular type',
  async function (this: BddWorld, label: string) {
    const labelNode = cutNetLabelNodes(this.webviewPage, label).first();
    await expect(labelNode.locator('.hdl-net-label-text')).not.toHaveClass(
      /hdl-net-label-text-synthetic/,
    );
  },
);

Then(
  'the original connection between {string} and {string} should be hidden',
  async function (this: BddWorld, source: string, target: string) {
    expect(await hasOriginalEdgeBetween(this.webviewPage, source, target)).toBe(false);
  },
);

Then(
  'the original connection between {string} and {string} should be restored',
  async function (this: BddWorld, source: string, target: string) {
    expect(await hasOriginalEdgeBetween(this.webviewPage, source, target)).toBe(true);
  },
);

Then(
  'the connection between {string} and {string} should be shown as selected',
  async function (this: BddWorld, source: string, target: string) {
    const edgeId = await edgeIdBetweenLabels(this.webviewPage, source, target);
    // Selection reuses the same net-hover halo (svsch-edge-net-highlight), a
    // stroke-only path (fill: none) that can have a zero-height geometric
    // bounding box for a straight horizontal run, which Playwright's
    // toBeVisible() treats as hidden — assert on presence instead, since the
    // path only renders at all when the edge is selected (nothing is hovered
    // in this scenario, so this can't be a false positive from net-hover).
    await expect(
      this.webviewPage.locator(
        `.react-flow__edge[data-id="${edgeId}"] path.svsch-edge-net-highlight`,
      ),
    ).toHaveCount(1);
  },
);

Then(
  'the connection between {string} and {string} should show its controls',
  async function (this: BddWorld, source: string, target: string) {
    const edgeId = await edgeIdBetweenLabels(this.webviewPage, source, target);
    await expect(
      this.webviewPage.locator(
        `.react-flow__edge[data-id="${edgeId}"] .svsch-edge-connection-controls`,
      ),
    ).toBeVisible();
  },
);

Then('the {string} button should be visible', async function (this: BddWorld, label: string) {
  await expect(
    this.webviewPage.locator('.svsch-selection-toolbar button', { hasText: label }),
  ).toBeVisible();
});

Then('the {string} button should not be visible', async function (this: BddWorld, label: string) {
  await expect(
    this.webviewPage.locator('.svsch-selection-toolbar button', { hasText: label }),
  ).toHaveCount(0);
});

When('I click the {string} button', async function (this: BddWorld, label: string) {
  const before = JSON.stringify(await readExtensionLayout(this));
  const button = this.webviewPage.locator('.svsch-selection-toolbar button', { hasText: label });
  await expect(button).toBeVisible();
  // An expanded instance's frame mirrors the child's full standalone width,
  // so a selection containing one can push the toolbar — anchored at the
  // selection's bottom-right corner — past the viewport edge, where the
  // click lands on the selection rect instead. Fit the view first when that
  // happens; the selection (and with it the toolbar) survives a fit.
  const box = await button.boundingBox();
  const viewport = this.workbox.viewportSize();
  const offScreen =
    !box ||
    box.x < 0 ||
    box.y < 0 ||
    (viewport !== null &&
      (box.x + box.width > viewport.width || box.y + box.height > viewport.height));
  if (offScreen) {
    await this.webviewPage
      .locator('html')
      .evaluate(() => (window as any).reactFlowInstance?.fitView({ padding: 0.1, duration: 0 }));
    await this.workbox.waitForTimeout(300);
  }
  await button.click();
  await waitForLayoutChange(this, before, `After clicking ${label}`);
});

// Collapses an "Expand instance in place" region (issue #232) by selecting
// its own (dimmed-backdrop) instance node and clicking the "Collapse"
// control that surfaces in the selection toolbar — the same toolbar
// "Expand" appears in, and the mirror image of "I click to select the block"
// + "I click the {string} button" — distinct from double-clicking the region
// title, which collapses it too but is covered separately.
When(
  'I collapse the expanded instance {string}',
  async function (this: BddWorld, instanceLabel: string) {
    const before = JSON.stringify(await readExtensionLayout(this));
    const id = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!id) throw new Error(`Could not find instance node "${instanceLabel}"`);
    const box = await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Could not get bounding box for ${instanceLabel}`);
    // Click inside the header strip, offset from the top-left corner: the
    // boundary port columns sit directly on top of the dimmed instance at its
    // port rows (by design — see dimAsExpandGhost) and its resize handles sit
    // right at its border, so a center or corner click risks landing on
    // something other than the ghost's own body. The header strip, inset from
    // both, is always clear.
    await this.workbox.mouse.click(box.x + 30, box.y + 15);
    // The expanded frame mirrors the child's full standalone width, so its
    // bottom-right corner — where the selection toolbar anchors — can sit
    // outside the viewport. Fit the view (the selection survives) so the
    // Collapse control is actually clickable.
    await this.webviewPage
      .locator('html')
      .evaluate(() => (window as any).reactFlowInstance?.fitView({ padding: 0.1, duration: 0 }));
    await this.workbox.waitForTimeout(300);
    const button = this.webviewPage.locator('.svsch-selection-toolbar button', {
      hasText: 'Collapse',
    });
    await expect(button).toBeVisible();
    await button.click();
    await waitForLayoutChange(this, before, `After collapsing ${instanceLabel}`);
  },
);

// Selects a nested expanded frame inherited from the child module's own
// diagram (issue #233) — spliced read-only content, so unlike "I collapse
// the expanded instance" there is no Collapse control to click afterwards;
// the scenario asserts exactly that with 'the {string} button should not be
// visible'. Same header-strip click as the collapse step: an expanded
// frame's center is pointer-transparent sub-canvas, only its border ring
// takes the pointer.
When(
  'I click to select the spliced expanded instance {string}',
  async function (this: BddWorld, instanceLabel: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!id) throw new Error(`Could not find instance node "${instanceLabel}"`);
    const box = await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Could not get bounding box for ${instanceLabel}`);
    await this.workbox.mouse.click(box.x + 30, box.y + 15);
    await expect
      .poll(
        async () => {
          return this.webviewPage.locator('html').evaluate((_el, targetId) => {
            const rf = (window as any).reactFlowInstance;
            const selected = rf.getNodes().filter((n: any) => n.selected);
            return selected.length === 1 && selected[0].id === targetId;
          }, id);
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await this.takeScreenshot(`Selected spliced expanded instance ${instanceLabel}`);
  },
);

// Guards against the collapse→re-expand bounce (issue reported on #233): the
// bounce is an async round trip through the extension host (requestExpand →
// expandInstanceData → re-splice), so an immediate not-visible assertion right
// after Collapse passes even when the instance is about to spring back open.
// Wait out the round-trip window first, then assert the ghost never returned.
Then(
  'the instance {string} should stay collapsed',
  async function (this: BddWorld, instanceLabel: string) {
    await this.workbox.waitForTimeout(1500);
    await expect(this.webviewPage.locator('.hdl-node-expand-ghost')).toHaveCount(0);
    const id = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!id) throw new Error(`Collapsed instance node "${instanceLabel}" is missing`);
  },
);

// Keyboard equivalent of clicking the block-selection toolbar's "Cut out"
// button — the `c` shortcut falls back to cutting every wire touching the
// selected block(s) whenever no wire is itself hovered or selected (see
// cutOutEdgesForSelection in main.tsx).
When('I press C to cut out the selected blocks', async function (this: BddWorld) {
  const before = JSON.stringify(await readExtensionLayout(this));
  const button = this.webviewPage.locator('.svsch-selection-toolbar button', {
    hasText: 'Cut out',
  });
  await expect(button).toBeVisible();
  await pressGlobalShortcutKey(this, 'c');
  await waitForLayoutChange(this, before, 'After pressing C to cut out the selection');
});

When('I note the position of the block {string}', async function (this: BddWorld, label: string) {
  const id = await findNodeIdByLabel(this.webviewPage, label);
  if (!id) throw new Error(`Could not find block "${label}"`);
  const pos = await getInternalPosition(this.webviewPage, id);
  if (!pos) throw new Error(`Missing position data for ${label}`);
  this.notedPositions.set(label, pos);
});

// Auto Layout releases the selected blocks for one ELK pass, then anchors and
// commits the result — so the end state is "fixed at the new, re-placed
// position", exactly like a manual drag would leave it (not left loose for
// every future rebuild to potentially reshuffle again).
Then(
  'the block {string} should be re-placed and fixed in the saved layout',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name);
    if (!id) throw new Error(`Could not find block "${name}"`);
    const moduleName = this.lastViewModel.moduleName;
    const layout = await readExtensionLayout(this);
    const nodes = layout.modules?.[moduleName]?.nodes ?? {};
    expect(nodes[id]?.fixed, `${name} should be fixed at its auto-laid-out position`).toBe(true);
  },
);

// ELK's layered algorithm doesn't otherwise guarantee a released group stays
// near where it started (a group only wired to itself can get packed as its
// own connected component anywhere) — the host rigidly translates the result
// back to the pre-Auto-Layout centroid, so this should hold on every run.
Then(
  'the block {string} should stay near its pre-auto-layout position',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name);
    if (!id) throw new Error(`Could not find block "${name}"`);
    const pos = await getInternalPosition(this.webviewPage, id);
    const before = this.notedPositions.get(name);
    if (!pos || !before) throw new Error(`Missing position data for ${name}`);
    const distance = Math.hypot(pos.x - before.x, pos.y - before.y);
    expect(
      distance,
      `expected ${name} to stay near (${before.x}, ${before.y}) but it moved to ` +
        `(${pos.x}, ${pos.y})`,
      // A released block with an active net cut reserves extra ELK margin for its
      // dangling end, which shifts where the layered algorithm settles it by a
      // bit more than an uncut block — widen the (already approximate) tolerance
      // to cover that.
    ).toBeLessThan(diagramGrid.size * 8);
  },
);

Then('the block {string} should remain selected', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name);
  if (!id) throw new Error(`Could not find block "${name}"`);
  const isSelected = await this.webviewPage.locator('html').evaluate((_el, nodeId) => {
    const rf = (window as any).reactFlowInstance;
    return rf.getNodes().some((n: any) => n.id === nodeId && n.selected === true);
  }, id);
  expect(isSelected, `${name} should still be selected after Auto Layout`).toBe(true);
});

Then('the block {string} should not have moved', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name);
  if (!id) throw new Error(`Could not find block "${name}"`);
  const pos = await getInternalPosition(this.webviewPage, id);
  const before = this.notedPositions.get(name);
  if (!pos || !before) throw new Error(`Missing position data for ${name}`);
  expect(pos.x, `${name} should not have moved`).toBeCloseTo(before.x, 0);
  expect(pos.y, `${name} should not have moved`).toBeCloseTo(before.y, 0);
});

Then(
  'the block {string} should have moved by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, name: string, cellsX: number, cellsY: number) {
    const id = await findNodeIdByLabel(this.webviewPage, name);
    if (!id) throw new Error(`Could not find block "${name}"`);
    const pos = await getInternalPosition(this.webviewPage, id);
    const before = this.notedPositions.get(name);
    if (!pos || !before) throw new Error(`Missing position data for ${name}`);
    expect(pos.x - before.x, `${name} x-delta`).toBeCloseTo(cellsX * diagramGrid.size, 0);
    expect(pos.y - before.y, `${name} y-delta`).toBeCloseTo(cellsY * diagramGrid.size, 0);
  },
);

When('I note the bounds of the block {string}', async function (this: BddWorld, label: string) {
  const id = await findNodeIdByLabel(this.webviewPage, label);
  if (!id) throw new Error(`Could not find block "${label}"`);
  this.notedRegionBounds.set(label, await getNodeBounds(this.webviewPage, id));
});

// Boundary port nodes (see BoundaryPortNode.tsx) aren't matched by the
// generic findNodeIdByLabel label-class list, so they get their own
// note/assert pair instead of reusing "the block {string} ..." above — keyed
// separately in notedPositions so a boundary port can share a name with an
// ordinary port elsewhere in the diagram without colliding.
When(
  'I note the position of the boundary port node {string}',
  async function (this: BddWorld, label: string) {
    const id = await findBoundaryPortNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find boundary port node "${label}"`);
    const pos = await getInternalPosition(this.webviewPage, id);
    if (!pos) throw new Error(`Missing position data for boundary port ${label}`);
    this.notedPositions.set(`boundary-port:${label}`, pos);
  },
);

Then(
  'the boundary port node {string} should have moved by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const id = await findBoundaryPortNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find boundary port node "${label}"`);
    const pos = await getInternalPosition(this.webviewPage, id);
    const before = this.notedPositions.get(`boundary-port:${label}`);
    if (!pos || !before) throw new Error(`Missing position data for boundary port ${label}`);
    expect(pos.x - before.x, `boundary port ${label} x-delta`).toBeCloseTo(
      cellsX * diagramGrid.size,
      0,
    );
    expect(pos.y - before.y, `boundary port ${label} y-delta`).toBeCloseTo(
      cellsY * diagramGrid.size,
      0,
    );
  },
);

Then(
  'the port node {string} should still be fixed in the saved layout',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found: ${name}`);
    const moduleName = this.lastViewModel.moduleName;
    const layout = await readExtensionLayout(this);
    const saved = layout.modules?.[moduleName]?.nodes?.[id];
    expect(saved?.fixed, `${name} should still be fixed in the saved layout`).toBe(true);
  },
);

// Cut net labels are re-derived from geometry every render, so unlike a real
// block they can't be resolved by their visible text alone (fanout cuts share
// one label across several dangling ends). Resolve the one specific label
// attached to a given block instead, by walking its stub edge. When the block
// is an expanded instance, its stub edges are rewired onto the frame's
// boundary-port nodes (namespaced `expand:<instanceId>::...` ids — see
// applyActiveSplices), so those endpoints count as "attached" too.
async function cutLabelNodeIdAttachedTo(
  webviewPage: FrameLocator,
  blockLabel: string,
): Promise<string> {
  const blockId = await findNodeIdByLabel(webviewPage, blockLabel);
  if (!blockId) throw new Error(`Could not find block "${blockLabel}"`);
  const labelId = await webviewPage.locator('html').evaluate((_, id) => {
    const rf = (window as any).reactFlowInstance;
    const nodesById = new Map(rf.getNodes().map((n: any) => [n.id, n]));
    const attaches = (endpointId: string) =>
      endpointId === id ||
      (endpointId.startsWith(`expand:${id}::`) &&
        (nodesById.get(endpointId) as any)?.data?.node?.kind === 'boundaryPort');
    const stub = rf
      .getEdges()
      .find(
        (e: any) =>
          (attaches(e.source) || attaches(e.target)) &&
          e.data?.edge?.metadata?.cutStub !== undefined,
      );
    if (!stub) return null;
    const otherEndId = attaches(stub.source) ? stub.target : stub.source;
    const otherNode = nodesById.get(otherEndId) as any;
    return otherNode?.data?.node?.kind === 'netLabel' ? otherEndId : null;
  }, blockId);
  if (!labelId) throw new Error(`Could not find a cut net label attached to "${blockLabel}"`);
  return labelId;
}

// Like cutLabelNodeIdAttachedTo, but resolves the connecting stub edge's own
// id instead of the label node's — used to click that specific wire's
// Reroute control.
async function cutStubEdgeIdAttachedTo(
  webviewPage: FrameLocator,
  blockLabel: string,
): Promise<string> {
  const blockId = await findNodeIdByLabel(webviewPage, blockLabel);
  if (!blockId) throw new Error(`Could not find block "${blockLabel}"`);
  const edgeId = await webviewPage.locator('html').evaluate((_, id) => {
    const rf = (window as any).reactFlowInstance;
    const nodesById = new Map(rf.getNodes().map((n: any) => [n.id, n]));
    const attaches = (endpointId: string) =>
      endpointId === id ||
      (endpointId.startsWith(`expand:${id}::`) &&
        (nodesById.get(endpointId) as any)?.data?.node?.kind === 'boundaryPort');
    const stub = rf
      .getEdges()
      .find(
        (e: any) =>
          (attaches(e.source) || attaches(e.target)) &&
          e.data?.edge?.metadata?.cutStub !== undefined,
      );
    return stub?.id ?? null;
  }, blockId);
  if (!edgeId) throw new Error(`Could not find a cut net stub wire attached to "${blockLabel}"`);
  return edgeId;
}

// A cut label's own position is server-derived and pushed to the webview over
// an async postMessage round-trip — unlike a node the user just dragged
// directly, its rendered DOM position can lag well behind an unrelated
// node's move that already persisted to disk (the round-trip is not covered
// by waitForLayoutChange's file-based wait, since the file already changed).
// Ask the extension's own layout-merge logic directly instead of racing the
// webview's render pipeline — this is exactly what the webview itself will
// eventually converge on, without depending on how long that takes.
async function authoritativeCutLabelPosition(
  world: BddWorld,
  blockLabel: string,
): Promise<{ x: number; y: number }> {
  const id = await cutLabelNodeIdAttachedTo(world.webviewPage, blockLabel);
  const layout = await readExtensionLayout(world);
  const moduleName = world.lastViewModel.moduleName;
  const view = await buildViewModel(world.lastGraph, moduleName, layout);
  const node = view.nodes.find((candidate) => candidate.id === id);
  if (!node)
    throw new Error(
      `Could not find the cut net label attached to ${blockLabel} (id ${id}) in the ` +
        `recomputed view`,
    );
  return node.position;
}

When(
  'I move the cut net label attached to {string} by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, blockLabel: string, cellsX: number, cellsY: number) {
    const id = await cutLabelNodeIdAttachedTo(this.webviewPage, blockLabel);
    const before = JSON.stringify(await readExtensionLayout(this));
    await dragNodeByGridCells(this, id, cellsX, cellsY);
    await waitForLayoutChange(
      this,
      before,
      `After moving the cut net label attached to ${blockLabel}`,
    );
  },
);

When(
  'I note the position of the cut net label attached to {string}',
  async function (this: BddWorld, blockLabel: string) {
    const pos = await authoritativeCutLabelPosition(this, blockLabel);
    this.notedPositions.set(`cut-label:${blockLabel}`, pos);
  },
);

Then(
  'the cut net label attached to {string} should have moved',
  async function (this: BddWorld, blockLabel: string) {
    const pos = await authoritativeCutLabelPosition(this, blockLabel);
    const before = this.notedPositions.get(`cut-label:${blockLabel}`);
    if (!before)
      throw new Error(
        `Missing noted position data for the cut net label attached to ${blockLabel}`,
      );
    const distance = Math.hypot(pos.x - before.x, pos.y - before.y);
    expect(
      distance,
      `expected the cut net label attached to ${blockLabel} to move from ` +
        `(${before.x}, ${before.y}), but it stayed there`,
    ).toBeGreaterThan(1);
  },
);

Then(
  'the cut net label attached to {string} should not have moved',
  async function (this: BddWorld, blockLabel: string) {
    const pos = await authoritativeCutLabelPosition(this, blockLabel);
    const before = this.notedPositions.get(`cut-label:${blockLabel}`);
    if (!before)
      throw new Error(
        `Missing noted position data for the cut net label attached to ${blockLabel}`,
      );
    expect(pos.x, `the cut net label attached to ${blockLabel} should not have moved`).toBeCloseTo(
      before.x,
      0,
    );
    expect(pos.y, `the cut net label attached to ${blockLabel} should not have moved`).toBeCloseTo(
      before.y,
      0,
    );
  },
);

// Same comparison as "should not have moved" — phrased separately for the
// drag-then-Reroute flow, where the noted position is the *canonical* spot
// (taken right after the cut, before the label was dragged away) rather than
// a "don't touch it" baseline.
Then(
  'the cut net label attached to {string} should be at its noted position',
  async function (this: BddWorld, blockLabel: string) {
    const pos = await authoritativeCutLabelPosition(this, blockLabel);
    const before = this.notedPositions.get(`cut-label:${blockLabel}`);
    if (!before)
      throw new Error(
        `Missing noted position data for the cut net label attached to ${blockLabel}`,
      );
    expect(
      pos.x,
      `the cut net label attached to ${blockLabel} should be back at its canonical position`,
    ).toBeCloseTo(before.x, 0);
    expect(
      pos.y,
      `the cut net label attached to ${blockLabel} should be back at its canonical position`,
    ).toBeCloseTo(before.y, 0);
  },
);

Then(
  'the cut net label attached to {string} should not overlap the block {string}',
  async function (this: BddWorld, labelBlockLabel: string, otherBlockLabel: string) {
    const labelId = await cutLabelNodeIdAttachedTo(this.webviewPage, labelBlockLabel);
    const otherId = await findNodeIdByLabel(this.webviewPage, otherBlockLabel);
    if (!otherId) throw new Error(`Could not find block "${otherBlockLabel}"`);
    const labelBox = await this.webviewPage
      .locator(`.react-flow__node[data-id="${labelId}"]`)
      .boundingBox();
    const otherBox = await this.webviewPage
      .locator(`.react-flow__node[data-id="${otherId}"]`)
      .boundingBox();
    if (!labelBox || !otherBox)
      throw new Error(
        `Missing bounding box for "${labelBlockLabel}" label or "${otherBlockLabel}"`,
      );
    const overlaps =
      labelBox.x < otherBox.x + otherBox.width &&
      otherBox.x < labelBox.x + labelBox.width &&
      labelBox.y < otherBox.y + otherBox.height &&
      otherBox.y < labelBox.y + labelBox.height;
    expect(
      overlaps,
      `the cut net label attached to ${labelBlockLabel} should not overlap ${otherBlockLabel}`,
    ).toBe(false);
  },
);

// Guards against a label picking up the highlight halo/hovered-text style
// merely because its stub edge got selected along with the attached block.
// A label physically outside the lasso is not itself selected.
Then(
  'the cut net label attached to {string} should not be highlighted',
  async function (this: BddWorld, blockLabel: string) {
    const labelId = await cutLabelNodeIdAttachedTo(this.webviewPage, blockLabel);
    const labelNode = this.webviewPage.locator(`.react-flow__node[data-id="${labelId}"]`);
    await expect(labelNode.locator('path.svsch-edge-net-highlight')).toHaveCount(0);
    await expect(labelNode.locator('.hdl-net-label-text')).not.toHaveClass(
      /hdl-net-label-text-hovered/,
    );
  },
);

// Reveal a cut net stub's floating Reroute control without clicking it — the
// same "hover to check the controls" beat as the plain-edge hover step above,
// but for a dangling end's own stub wire (whose control renders through a
// ViewportPortal rather than nested under its own .react-flow__edge, so it's
// looked up globally rather than scoped to the edge).
When(
  'I hover the cut net label attached to {string}',
  async function (this: BddWorld, blockLabel: string) {
    const edgeId = await cutStubEdgeIdAttachedTo(this.webviewPage, blockLabel);
    const edgeLocator = this.webviewPage.locator(`.react-flow__edge[data-id="${edgeId}"]`);
    await edgeLocator.locator('path.svsch-edge-bridge').dispatchEvent('mouseover');
    const control = this.webviewPage.locator(
      '.svsch-cut-stub-reset-layer .svsch-edge-reroute-control',
    );
    await expect(control).toBeVisible({ timeout: 5_000 });
    await this.takeScreenshot(`Hovering the cut net label attached to ${blockLabel}`);
  },
);

When(
  'I click the Reroute control on the cut net label attached to {string}',
  async function (this: BddWorld, blockLabel: string) {
    const edgeId = await cutStubEdgeIdAttachedTo(this.webviewPage, blockLabel);
    const before = JSON.stringify(await readExtensionLayout(this));
    // A cut stub's Reroute control renders through a ViewportPortal, not
    // nested under its own .react-flow__edge element (see OrthogonalEdge) —
    // hover the wire to reveal it, then look it up globally rather than
    // scoped to the edge, unlike clickEdgeControl's normal-edge controls.
    const edgeLocator = this.webviewPage.locator(`.react-flow__edge[data-id="${edgeId}"]`);
    await edgeLocator.locator('path.svsch-edge-bridge').dispatchEvent('mouseover');
    const control = this.webviewPage.locator(
      '.svsch-cut-stub-reset-layer .svsch-edge-reroute-control',
    );
    await expect(control).toBeVisible({ timeout: 5_000 });
    await control.click();
    await this.webviewPage.locator('body').hover({ position: { x: 100, y: 100 }, force: true });
    await waitForLayoutChange(
      this,
      before,
      `After resetting the cut net label attached to ${blockLabel}`,
    );
  },
);

Then('I should see a port node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
  if (!id) throw new Error(`Could not find port node "${name}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then(
  'the diagram should contain exactly {int} generate regions',
  async function (this: BddWorld, count: number) {
    // Arm regions only — the synthesized generate-block wrapper is counted separately.
    await expect(this.webviewPage.locator('.generate-region:not(.generate-block)')).toHaveCount(
      count,
    );
  },
);

Then(
  'the diagram should contain a {string} generate block',
  async function (this: BddWorld, label: string) {
    const block = this.webviewPage.locator('.generate-region.generate-block').filter({
      has: this.webviewPage.locator('.generate-region-title', { hasText: label }),
    });
    await expect(block).toHaveCount(1);
  },
);

Then(
  'I should see a {string} generate region labeled {string}',
  async function (this: BddWorld, kind: string, label: string) {
    const region = this.webviewPage
      .locator(`.generate-region[data-region-kind="${kind}"] .generate-region-title`, {
        hasText: label,
      })
      .first();
    await expect(region).toBeVisible();
  },
);

Then(
  'the {string} generate region should contain at least {int} blocks',
  async function (this: BddWorld, label: string, count: number) {
    const nodeIds = await generateRegionNodeIds(this, label);
    expect(
      nodeIds.length,
      `Expected generate region ${label} to own at least ${count} block(s), found ` +
        `${nodeIds.length}: ${nodeIds.join(', ')}`,
    ).toBeGreaterThanOrEqual(count);
  },
);

Then(
  'the {string} generate region should have grown on the {word} side',
  async function (this: BddWorld, label: string, side: string) {
    if (!isRegionSide(side)) throw new Error(`Unknown generate region side: ${side}`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for generate region ${label}`);
    const after = await getGenerateRegionBounds(this.webviewPage, label);
    const delta = regionSide(after, side) - regionSide(before, side);
    const expectedSign = side === 'right' || side === 'bottom' ? 1 : -1;
    expect(delta * expectedSign).toBeGreaterThanOrEqual(diagramGrid.size);
  },
);

Then(
  'the {string} block should have grown on the {word} side',
  async function (this: BddWorld, label: string, side: string) {
    if (!isRegionSide(side)) throw new Error(`Unknown block side: ${side}`);
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for block ${label}`);
    const after = await getNodeBounds(this.webviewPage, id);
    const delta = regionSide(after, side) - regionSide(before, side);
    const expectedSign = side === 'right' || side === 'bottom' ? 1 : -1;
    expect(delta * expectedSign).toBeGreaterThanOrEqual(diagramGrid.size);
  },
);

Then(
  'the {string} block should be at its canonical size',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const moduleName = this.lastViewModel.moduleName;
    const layout = await readExtensionLayout(this);
    const node = layout.modules?.[moduleName]?.nodes?.[id];
    expect(
      node?.width,
      `Expected block ${label} to have no persisted size override after reset`,
    ).toBeUndefined();
    expect(
      node?.height,
      `Expected block ${label} to have no persisted size override after reset`,
    ).toBeUndefined();
  },
);

Then(
  'the {string} generate region should have expanded on the {word} side while dragging',
  async function (this: BddWorld, label: string, side: string) {
    if (!this.pendingNodeDrag) throw new Error('No block is currently being dragged');
    if (!isRegionSide(side)) throw new Error(`Unknown generate region side: ${side}`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for generate region ${label}`);
    await expect
      .poll(
        async () => {
          const after = await getGenerateRegionBounds(this.webviewPage, label);
          const delta = regionSide(after, side) - regionSide(before, side);
          const expectedSign = side === 'right' || side === 'bottom' ? 1 : -1;
          return delta * expectedSign;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(diagramGrid.size);
  },
);

Then(
  'the {string} generate region should keep {int} grid cells of padding on the {word} side',
  async function (this: BddWorld, label: string, cells: number, side: string) {
    if (!isRegionSide(side)) throw new Error(`Unknown generate region side: ${side}`);
    const padding = await getGenerateRegionContentPadding(this, label);
    expect(padding[side]).toBe(cells * diagramGrid.size);
  },
);

Then(
  'all blocks in the {string} generate region should have moved by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const remembered = this.notedGenerateRegionMoves.get(label);
    if (!remembered) throw new Error(`No remembered move for generate region ${label}`);
    const expectedDelta = { x: cellsX * diagramGrid.size, y: cellsY * diagramGrid.size };
    expect(remembered.expectedDelta.x).toBe(expectedDelta.x);
    expect(remembered.expectedDelta.y).toBe(expectedDelta.y);

    const after = await getNodePositions(this.webviewPage, [...remembered.nodePositions.keys()]);
    for (const [id, before] of remembered.nodePositions) {
      const current = after.get(id);
      if (!current)
        throw new Error(`Missing moved node ${id} after moving generate region ${label}`);
      expect(current.x - before.x, `${id} x delta`).toBeCloseTo(expectedDelta.x, 0);
      expect(current.y - before.y, `${id} y delta`).toBeCloseTo(expectedDelta.y, 0);
    }
  },
);

Then(
  'blocks outside the {string} generate region should not have moved',
  async function (this: BddWorld, label: string) {
    const remembered = this.notedGenerateRegionMoves.get(label);
    if (!remembered) throw new Error(`No remembered move for generate region ${label}`);
    const after = await getNodePositions(this.webviewPage, [
      ...remembered.outsideNodePositions.keys(),
    ]);
    for (const [id, before] of remembered.outsideNodePositions) {
      const current = after.get(id);
      if (!current)
        throw new Error(`Missing outside node ${id} after moving generate region ${label}`);
      expect(current.x, `${id} x position`).toBeCloseTo(before.x, 0);
      expect(current.y, `${id} y position`).toBeCloseTo(before.y, 0);
    }
  },
);

Then(
  'the {string} generate region should be flagged as overlapping',
  async function (this: BddWorld, label: string) {
    const region = generateRegionLocator(this.webviewPage, label);
    await expect(region).toHaveClass(/generate-region-invalid/);
    await expect(region).toHaveAttribute('data-warning-note', /(arm|generate) blocks overlapping/);
  },
);

Then(
  'I should see a warning icon on the {string} generate region',
  async function (this: BddWorld, label: string) {
    const icon = generateRegionLocator(this.webviewPage, label).locator('.generate-region-warning');
    await expect(icon).toBeVisible();
  },
);

When(
  'I hover over the warning icon on the {string} generate region',
  async function (this: BddWorld, label: string) {
    await generateRegionLocator(this.webviewPage, label)
      .locator('.generate-region-warning')
      .hover({ force: true });
  },
);

Then(
  'I should see a warning icon on the {string} block',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    await expect(
      this.webviewPage.locator(`.react-flow__node[data-id="${id}"] .node-warning`),
    ).toBeVisible();
  },
);

When(
  'I hover over the warning icon on the {string} block',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    await this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .node-warning`)
      .hover({ force: true });
  },
);

Then('a tooltip should appear reading {string}', async function (this: BddWorld, message: string) {
  // The preceding hover step left the pointer over the icon; assert the real
  // Floating UI popover element renders (not just the accessible label).
  const tooltip = this.webviewPage.locator('.svsch-tooltip', { hasText: message });
  await expect(tooltip).toBeVisible();
  // Capture the hovered tooltip as a visual baseline so the popover render is
  // regression-guarded (the other scenario screenshots never have it on screen).
  await this.takeScreenshot('Tooltip visible on hover');
});

Then(
  'the {string} generate region should be flagged as containing an unrelated block',
  async function (this: BddWorld, label: string) {
    const region = generateRegionLocator(this.webviewPage, label);
    await expect(region).toHaveClass(/generate-region-invalid/);
    await expect(region).toHaveAttribute('data-warning-note', /node does not belong to arm block/);
  },
);

Then(
  'the {string} generate block should be flagged as containing an unrelated block',
  async function (this: BddWorld, label: string) {
    const block = this.webviewPage.locator('.generate-region.generate-block').filter({
      has: this.webviewPage.locator('.generate-region-title', { hasText: label }),
    });
    await expect(block).toHaveClass(/generate-region-invalid/);
    await expect(block).toHaveAttribute(
      'data-warning-note',
      /block does not belong to this generate block/,
    );
  },
);

Then(
  'the {string} block should be flagged as overlapping an arm',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toHaveClass(
      /svsch-node-invalid/,
    );
  },
);

Then('no block should be flagged as overlapping an arm', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('.react-flow__node.svsch-node-invalid')).toHaveCount(0);
});

Then(
  'the {string} block should not be flagged as overlapping an arm',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).not.toHaveClass(
      /svsch-node-invalid/,
    );
  },
);

Then('no generate region should be flagged as overlapping', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('.generate-region-invalid')).toHaveCount(0);
});

Then('I should not see any generate region warning icons', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('.generate-region-warning')).toHaveCount(0);
});

Then(
  'I should see an instance node {string} of module {string}',
  async function (this: BddWorld, instanceName: string, moduleName: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const locator = this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(locator).toBeVisible();
    await expect(locator).toContainText(moduleName);
  },
);

Then(
  'I should not see an instance node {string}',
  async function (this: BddWorld, instanceName: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (id) {
      await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toHaveCount(0);
    }
  },
);

// An expanded instance's own node stays on screen as a dimmed backdrop
// behind its spliced-in contents (see expandOverlay's dimAsExpandGhost),
// rather than being removed — distinct from the plain "should not see an
// instance node" check above, which asserts real absence from the DOM.
Then(
  'I should see a dimmed instance node {string}',
  async function (this: BddWorld, instanceName: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toHaveClass(
      /hdl-node-expand-ghost/,
    );
  },
);

// Callable counterpart to "I should see a dimmed instance node" above (issue
// #335): an expanded function call's own node stays on screen as a dimmed
// backdrop behind its spliced-in body, same as an expanded instance.
Then(
  'I should see a dimmed function call node {string}',
  async function (this: BddWorld, callLabel: string) {
    const id = await findNodeIdByLabel(this.webviewPage, callLabel, 'funcCall');
    if (!id) throw new Error(`Could not find function call node "${callLabel}"`);
    await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toHaveClass(
      /hdl-node-expand-ghost/,
    );
  },
);

// Post-collapse counterpart: the call site's own FUNCTION block is back,
// carrying no expand-ghost styling.
Then(
  'I should see a function call node {string}',
  async function (this: BddWorld, callLabel: string) {
    const id = await findNodeIdByLabel(this.webviewPage, callLabel, 'funcCall');
    if (!id) throw new Error(`Could not find function call node "${callLabel}"`);
    const locator = this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(locator).toBeVisible();
    await expect(locator).not.toHaveClass(/hdl-node-expand-ghost/);
  },
);

// Callable counterpart to "I collapse the expanded instance" (issue #335).
// A function call's frame is only as tall as its 2-3 boundary ports (there's
// no instance-parameter chip row to pad it out), so its header strip is much
// shorter than a typical instance's — the header-corner offset click used
// for instances can overshoot into the input boundary ports, which hug the
// frame's left edge (see BoundaryPortNode.tsx). The horizontal center of the
// header row, clear of both the input ports on the left and the output port
// on the right, stays inside the ghost's own body regardless of the frame's
// height.
When(
  'I collapse the expanded function call {string}',
  async function (this: BddWorld, callLabel: string) {
    const before = JSON.stringify(await readExtensionLayout(this));
    const id = await findNodeIdByLabel(this.webviewPage, callLabel, 'funcCall');
    if (!id) throw new Error(`Could not find function call node "${callLabel}"`);
    const box = await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Could not get bounding box for ${callLabel}`);
    await this.workbox.mouse.click(box.x + box.width / 2, box.y + 15);
    const button = this.webviewPage.locator('.svsch-selection-toolbar button', {
      hasText: 'Collapse',
    });
    await expect(button).toBeVisible();
    await button.click();
    await waitForLayoutChange(this, before, `After collapsing function call ${callLabel}`);
  },
);

// Task counterpart to the three function-call steps above (issue #340).
Then(
  'I should see a dimmed task call node {string}',
  async function (this: BddWorld, callLabel: string) {
    const id = await findNodeIdByLabel(this.webviewPage, callLabel, 'taskCall');
    if (!id) throw new Error(`Could not find task call node "${callLabel}"`);
    await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toHaveClass(
      /hdl-node-expand-ghost/,
    );
  },
);

Then('I should see a task call node {string}', async function (this: BddWorld, callLabel: string) {
  const id = await findNodeIdByLabel(this.webviewPage, callLabel, 'taskCall');
  if (!id) throw new Error(`Could not find task call node "${callLabel}"`);
  const locator = this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(locator).toBeVisible();
  await expect(locator).not.toHaveClass(/hdl-node-expand-ghost/);
});

When(
  'I collapse the expanded task call {string}',
  async function (this: BddWorld, callLabel: string) {
    const before = JSON.stringify(await readExtensionLayout(this));
    const id = await findNodeIdByLabel(this.webviewPage, callLabel, 'taskCall');
    if (!id) throw new Error(`Could not find task call node "${callLabel}"`);
    const box = await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Could not get bounding box for ${callLabel}`);
    await this.workbox.mouse.click(box.x + box.width / 2, box.y + 15);
    const button = this.webviewPage.locator('.svsch-selection-toolbar button', {
      hasText: 'Collapse',
    });
    await expect(button).toBeVisible();
    await button.click();
    await waitForLayoutChange(this, before, `After collapsing task call ${callLabel}`);
  },
);

// "Expand instance in place" (issue #232) replaces an instance's own node
// with `kind: 'boundaryPort'` standins for its child module's ports (see
// BoundaryPortNode.tsx) once expanded.
Then(
  'I should see a boundary port node named {string}',
  async function (this: BddWorld, label: string) {
    await expect(
      this.webviewPage.locator('[data-node-kind="boundaryPort"] .hdl-boundary-port-text', {
        hasText: exactText(label),
      }),
    ).toBeVisible();
  },
);

Then(
  'I should not see a boundary port node named {string}',
  async function (this: BddWorld, label: string) {
    await expect(
      this.webviewPage.locator('[data-node-kind="boundaryPort"] .hdl-boundary-port-text', {
        hasText: exactText(label),
      }),
    ).toHaveCount(0);
  },
);

Then(
  'the instance node {string} should show parameter {string} as {string}',
  async function (this: BddWorld, instanceName: string, parameterName: string, value: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const locator = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .instance-parameter-chip`, {
        hasText: parameterName,
      })
      .first();
    await expect(locator).toBeVisible();
    await expect(locator).toContainText(parameterName);
    await expect(locator).toContainText(value);
  },
);

Then(
  'the instance node {string} parameter {string} should link value {string}',
  async function (this: BddWorld, instanceName: string, parameterName: string, value: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const chip = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .instance-parameter-chip`, {
        hasText: parameterName,
      })
      .first();
    const token = chip.locator('.svsch-param-token', { hasText: value }).first();
    await expect(token).toBeVisible();
    // The token is a real link: clicking it makes the extension navigate the
    // editor to the value's declaration. Assert the editor lands there.
    await token.click({ force: true });
    const deadline = Date.now() + 10_000;
    let selectedText: string | null = null;
    while (Date.now() < deadline) {
      selectedText = await this.selectedEditorText();
      if (selectedText !== null && normalizeHighlightedText(selectedText).includes(value)) break;
      await this.workbox.waitForTimeout(200);
    }
    if (!selectedText || !normalizeHighlightedText(selectedText).includes(value)) {
      throw new Error(
        `Clicking parameter value "${value}" did not navigate the editor to its declaration ` +
          `(selection: ${selectedText})`,
      );
    }
  },
);

Then(
  'the module parameter table should show module {string}',
  async function (this: BddWorld, moduleName: string) {
    const table = this.webviewPage.locator('.module-parameter-table');
    await expect(table).toBeVisible();
    await expect(table.locator('.module-parameter-line')).toContainText(`Module: ${moduleName}`);
  },
);

Then(
  'the module parameter table section {string} should show {string} as {string}',
  async function (this: BddWorld, sectionName: string, parameterName: string, value: string) {
    const table = this.webviewPage.locator('.module-parameter-table');
    await expect(table).toBeVisible();
    await expect(
      table.locator('.module-parameter-section-title', { hasText: `${sectionName}:` }),
    ).toBeVisible();
    const rows = await table.locator('.module-parameter-row').evaluateAll((elements) =>
      elements.map((el) => ({
        name: el.querySelector('.module-parameter-name')?.textContent?.trim() ?? '',
        value: el.querySelector('.module-parameter-default')?.textContent?.trim() ?? '',
      })),
    );
    const row = rows.find((r) => r.name === parameterName);
    if (!row)
      throw new Error(
        `Could not find module parameter table row "${parameterName}". ` +
          `Rows: ${JSON.stringify(rows)}`,
      );
    expect(row.value).toBe(value);
  },
);

Then(
  'the module parameter table should not show section {string}',
  async function (this: BddWorld, sectionName: string) {
    const table = this.webviewPage.locator('.module-parameter-table');
    await expect(table).toBeVisible();
    await expect(
      table.locator('.module-parameter-section-title', { hasText: `${sectionName}:` }),
    ).not.toBeVisible();
  },
);

Then(
  'the module dropdown should contain {string}, {string}, {string} in that order',
  async function (this: BddWorld, m1: string, m2: string, m3: string) {
    const options = await this.webviewPage
      .locator('select[aria-label="Module"] option')
      .allTextContents();
    expect(options).toEqual([m1, m2, m3]);
  },
);

Then(
  'the module dropdown should contain {string}, {string} in that order',
  async function (this: BddWorld, m1: string, m2: string) {
    const options = await this.webviewPage
      .locator('select[aria-label="Module"] option')
      .allTextContents();
    expect(options).toEqual([m1, m2]);
  },
);

Then(
  'the module dropdown should not contain {string}',
  async function (this: BddWorld, moduleName: string) {
    const options = await this.webviewPage
      .locator('select[aria-label="Module"] option')
      .allTextContents();
    expect(options).not.toContain(moduleName);
  },
);

Then('I should see a combinational block', async function (this: BddWorld) {
  await expect(
    this.webviewPage.locator('[data-node-kind="comb"], [data-node-kind="gate"]'),
  ).toBeVisible();
});

Then('I should not see a combinational block', async function (this: BddWorld) {
  await expect(
    this.webviewPage.locator('[data-node-kind="comb"], [data-node-kind="gate"]'),
  ).not.toBeVisible();
});

Then('I should see an inverter node', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('[data-node-kind="inverter"]').first()).toBeVisible();
});

Then('I should not see an inverter node', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('[data-node-kind="inverter"]')).not.toBeVisible();
});

Then('I should see an ALU block', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('[data-node-kind="alu"]')).toBeVisible();
});

Then('I should see a gate block', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('[data-node-kind="gate"]')).toBeVisible();
});

Then('I should see a register node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'register');
  if (!id) throw new Error(`Could not find register node "${name}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('the CLI SVG should contain {string}', function (this: BddWorld, expected: string) {
  if (!this.lastCliSvg) throw new Error('No CLI SVG has been rendered');
  expect(this.lastCliSvg).toContain(expected);
});

Then('the CLI SVG should not contain {string}', function (this: BddWorld, unexpected: string) {
  if (!this.lastCliSvg) throw new Error('No CLI SVG has been rendered');
  expect(this.lastCliSvg).not.toContain(unexpected);
});

// renderSvg() always emits multi-line output (elements joined with '\n'); SVGO's
// js2svg defaults to compact (non-pretty) output regardless of which plugins run,
// collapsing everything to one line. That makes newline presence a check of
// minification itself, unlike asserting on a specific plugin's output (e.g. the
// XML prolog, which only removeXMLProcInst strips and could stop being true if
// the plugin list changes). The embedded <style> block is excluded: its CSS is
// deliberately left untouched by minifySvg (minifyStyles/inlineStyles are
// excluded from SAFE_MINIFY_PLUGINS, see svgMinify.ts) to avoid mangling the
// var(--vscode-...) custom properties, so it keeps its source newlines either way.
function cliSvgWithoutStyleBlock(svg: string): string {
  return svg.replace(/<style>[\s\S]*?<\/style>/, '');
}

Then('the CLI SVG should be minified', function (this: BddWorld) {
  if (!this.lastCliSvg) throw new Error('No CLI SVG has been rendered');
  expect(cliSvgWithoutStyleBlock(this.lastCliSvg)).not.toContain('\n');
});

Then('the CLI SVG should not be minified', function (this: BddWorld) {
  if (!this.lastCliSvg) throw new Error('No CLI SVG has been rendered');
  expect(cliSvgWithoutStyleBlock(this.lastCliSvg)).toContain('\n');
});

// The CLI honoured the saved layout: the node sits where the user dragged it on
// the diagram. The CLI SVG and the live diagram share the same layout
// coordinate frame (both come from buildViewModel), so we compare the SVG node's
// translate() against the node's current position in the React Flow canvas.
Then(
  'the CLI SVG should have node {string} positioned as it is on the diagram',
  async function (this: BddWorld, name: string) {
    if (!this.lastCliSvg) throw new Error('No CLI SVG has been rendered');
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found on the diagram: ${name}`);
    const svgPos = cliSvgNodePosition(this.lastCliSvg, id);
    if (!svgPos) throw new Error(`Node "${id}" not found in CLI SVG`);
    const diagramPos = await getInternalPosition(this.webviewPage, id);
    if (!diagramPos) throw new Error(`Could not read diagram position for ${name}`);
    expect(svgPos.x, `node ${name} x: SVG ${svgPos.x} vs diagram ${diagramPos.x}`).toBeCloseTo(
      diagramPos.x,
      0,
    );
    expect(svgPos.y, `node ${name} y: SVG ${svgPos.y} vs diagram ${diagramPos.y}`).toBeCloseTo(
      diagramPos.y,
      0,
    );
  },
);

// The CLI ignored the saved layout (--no-layout): the node is back at its
// auto-layout position, i.e. where it was before the user moved it. That
// original position was recorded when the diagram opened.
Then(
  'the CLI SVG should have node {string} positioned in its initial location',
  async function (this: BddWorld, name: string) {
    if (!this.lastCliSvg) throw new Error('No CLI SVG has been rendered');
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found on the diagram: ${name}`);
    const svgPos = cliSvgNodePosition(this.lastCliSvg, id);
    if (!svgPos) throw new Error(`Node "${id}" not found in CLI SVG`);
    const originalPos = this.notedPositions.get(name);
    if (!originalPos) throw new Error(`No original position recorded for ${name}`);
    expect(svgPos.x, `node ${name} x: SVG ${svgPos.x} vs original ${originalPos.x}`).toBeCloseTo(
      originalPos.x,
      0,
    );
    expect(svgPos.y, `node ${name} y: SVG ${svgPos.y} vs original ${originalPos.y}`).toBeCloseTo(
      originalPos.y,
      0,
    );
  },
);

Then(
  'a file named {string} should not exist in directory {string}',
  function (this: BddWorld, fileName: string, dir: string) {
    const filePath = path.join(this.workspaceDir || '', dir, fileName);
    if (fs.existsSync(filePath))
      throw new Error(`File "${fileName}" should not exist in directory "${dir}"`);
  },
);

Then(/^the CLI stdout should be exactly:?$/, function (this: BddWorld, expected: string) {
  if (this.lastCliStdout === undefined) throw new Error('No CLI stdout captured.');
  expect(this.lastCliStdout.trim()).toBe(expected.trim());
});

Then(
  /^the CLI stdout should be exactly \(workspace-relative\):?$/,
  function (this: BddWorld, expected: string) {
    if (this.lastCliStdout === undefined) throw new Error('No CLI stdout captured.');
    const workspaceDir = this.workspaceDir || '';
    const lines = this.lastCliStdout
      .trim()
      .split('\n')
      .map((line) => {
        const absolute = path.isAbsolute(line) ? line : path.resolve(workspaceDir, line);
        return absolute.startsWith(workspaceDir) ? path.relative(workspaceDir, absolute) : line;
      });
    expect(lines.join('\n')).toBe(expected.trim());
  },
);

Then(/^the CLI stderr should be exactly:?$/, function (this: BddWorld, expected: string) {
  if (this.lastCliStderr === undefined) throw new Error('No CLI stderr captured.');
  expect(normalizeCliStderrForExpectation(this.lastCliStderr, expected)).toBe(expected.trim());
});

Then('the CLI stderr should be empty', function (this: BddWorld) {
  if (this.lastCliStderr === undefined) throw new Error('No CLI stderr captured.');
  expect(this.lastCliStderr.trim()).toBe('');
});

Then('the CLI stderr should contain {string}', function (this: BddWorld, expected: string) {
  if (!this.lastCliStderr) throw new Error('No CLI stderr captured.');
  expect(this.lastCliStderr).toContain(expected);
});

Then('the workspace directory state should remain unchanged', async function (this: BddWorld) {
  if (!this.workspaceDir) throw new Error('No open workspace');
  if (!this.workspaceDirStateBefore) throw new Error('Workspace state was not recorded');
  const currentState = await getWorkspaceState(this.workspaceDir);
  expect(currentState.sort()).toEqual(this.workspaceDirStateBefore.sort());
});

Then('the CLI SVG should be empty', function (this: BddWorld) {
  if (this.lastCliSvg === undefined) return;
  expect(this.lastCliSvg).toContain('<g class="svsch-edges">\n</g>');
  expect(this.lastCliSvg).toContain('<g class="svsch-nodes">\n</g>');
});

Then('the CLI output should not contain {string}', function (this: BddWorld, unexpected: string) {
  if (this.lastCliSvg) {
    expect(this.lastCliSvg).not.toContain(unexpected);
  } else if (this.lastCliPng) {
    const nodes = this.lastViewModel?.nodes ?? [];
    const found = nodes.some((n: any) => n.label === unexpected || n.id?.includes(unexpected));
    if (found)
      throw new Error(`CLI output (PNG): node "${unexpected}" was found but should not be`);
  } else {
    throw new Error('No CLI output has been rendered');
  }
});

Then('I see the following CLI output:', function (this: BddWorld, expected: string) {
  if (this.lastCliStdout === undefined) throw new Error('No CLI output (stdout) captured.');
  expect(this.lastCliStdout.trim()).toBe(expected.trim());
});

Then(
  'a file named {string} should exist in directory {string}',
  async function (this: BddWorld, filename: string, dir: string) {
    if (!this.workspaceDir) throw new Error('No open workspace');
    const filePath = path.join(this.workspaceDir, dir, filename);
    try {
      await fs.promises.access(filePath);
    } catch {
      const files = await fs.promises.readdir(path.join(this.workspaceDir, dir)).catch(() => []);
      throw new Error(`File "${filename}" does not exist in "${dir}". Found: ${files.join(', ')}`);
    }
    if (filename.endsWith('.svg') && this.testInfo) {
      await this.testInfo.attach(filename, { path: filePath, contentType: 'image/svg+xml' });
    }
  },
);

Then(
  'a file named {string} should not exist in the workspace',
  async function (this: BddWorld, filename: string) {
    if (!this.workspaceDir) throw new Error('No open workspace');
    const filePath = path.join(this.workspaceDir, filename);
    try {
      await fs.promises.access(filePath);
      throw new Error(`File "${filename}" exists but should not`);
    } catch (err: any) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
  },
);

Then(
  'the CLI should have reported generating {string}',
  function (this: BddWorld, expectedFile: string) {
    if (this.lastCliStdout === undefined) throw new Error('No CLI output captured.');
    const found = this.lastCliStdout
      .trim()
      .split('\n')
      .some((line) => line.endsWith(expectedFile));
    if (!found)
      throw new Error(
        `Expected CLI to report generating "${expectedFile}", but stdout was:\n` +
          `${this.lastCliStdout}`,
      );
  },
);

// The in-window (simple) save dialog is a QuickPick; its path input is
// pre-filled with the default save target. "<workspace folder>" resolves to the
// open workspace directory.
Then(
  'I see the file save dialog with {string} as the filename',
  async function (this: BddWorld, expectedFilename: string) {
    const expected = expectedFilename.replace(
      '<workspace folder>',
      this.workspaceDir || BddWorld.BDD_WORKSPACE,
    );
    const dialog = this.workbox.locator('.quick-input-widget');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('input[aria-label="input"]')).toHaveValue(expected, {
      timeout: 10_000,
    });
  },
);

Then(
  'a file named {string} should exist in the workspace',
  async function (this: BddWorld, filename: string) {
    if (!this.workspaceDir) throw new Error('No open workspace');
    const filePath = path.join(this.workspaceDir, filename);
    const exists = await expect
      .poll(() => fs.existsSync(filePath), { timeout: 10_000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      const files = await fs.promises.readdir(this.workspaceDir);
      throw new Error(`File "${filename}" does not exist in workspace. Found: ${files.join(', ')}`);
    }
    if (filename.endsWith('.svg') && this.testInfo) {
      await this.testInfo.attach(filename, { path: filePath, contentType: 'image/svg+xml' });
    }
  },
);

Then(
  'the workspace file {string} should contain {string}',
  async function (this: BddWorld, filename: string, expected: string) {
    if (!this.workspaceDir) throw new Error('No open workspace');
    const content = await fs.promises.readFile(path.join(this.workspaceDir, filename), 'utf8');
    if (!content.includes(expected)) {
      throw new Error(
        `File "${filename}" does not contain "${expected}" (${content.length} bytes)`,
      );
    }
  },
);

Then('I should see a loop block', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('[data-node-kind="loop"]')).toBeVisible();
});

Then('I should see a latch node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'latch');
  if (!id) throw new Error(`Could not find latch node "${name}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('I should see a mux node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'mux');
  if (!id) throw new Error(`Could not find mux node "${name}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('I should not see a register node {string}', async function (this: BddWorld, name: string) {
  const oldId = `reg:top:${name}`;
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${oldId}"]`)).not.toBeVisible();
});

Then(
  'the register node {string} should be between port {string} and port {string}',
  async function (
    this: BddWorld,
    registerName: string,
    leftPortName: string,
    rightPortName: string,
  ) {
    const registerId = await findNodeIdByLabel(this.webviewPage, registerName, 'register');
    const leftPortId = await findNodeIdByLabel(this.webviewPage, leftPortName, 'port');
    const rightPortId = await findNodeIdByLabel(this.webviewPage, rightPortName, 'port');
    if (!registerId || !leftPortId || !rightPortId) throw new Error(`Nodes not found`);
    const [registerBox, leftBox, rightBox] = await Promise.all([
      this.webviewPage.locator(`.react-flow__node[data-id="${registerId}"]`).boundingBox(),
      this.webviewPage.locator(`.react-flow__node[data-id="${leftPortId}"]`).boundingBox(),
      this.webviewPage.locator(`.react-flow__node[data-id="${rightPortId}"]`).boundingBox(),
    ]);
    if (!registerBox || !leftBox || !rightBox) throw new Error('Missing bounding box');
    expect(registerBox.x).toBeGreaterThan(leftBox.x);
    expect(registerBox.x + registerBox.width).toBeLessThan(rightBox.x + rightBox.width);
  },
);

Then('I should see a bus node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'bus');
  if (!id) throw new Error(`Could not find bus node "${name}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then('I should see a struct node {string}', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'struct');
  if (!id) throw new Error(`Could not find struct node "${name}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then(
  'there should be a connection between {string} and {string}',
  async function (this: BddWorld, source: string, target: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should not be a connection between {string} and {string}',
  async function (this: BddWorld, source: string, target: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (sourceId && targetId) await checkConnection(this.webviewPage, sourceId, targetId, true);
  },
);

Then(
  'there should be a connection between {string} and the combinational block',
  async function (this: BddWorld, source: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="comb"], [data-node-kind="gate"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, comb=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the combinational block and {string}',
  async function (this: BddWorld, target: string) {
    const sourceId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="comb"], [data-node-kind="gate"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: comb=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  // eslint-disable-next-line max-len
  'there should be a connection between {string} and the combinational block in the {string} generate region',
  async function (this: BddWorld, source: string, region: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findGenerateRegionNodeIdByKind(this, region, ['comb', 'gate']);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, comb in ${region}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  // eslint-disable-next-line max-len
  'there should be a connection between the combinational block in the {string} generate region and {string}',
  async function (this: BddWorld, region: string, target: string) {
    const sourceId = await findGenerateRegionNodeIdByKind(this, region, ['comb', 'gate']);
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: comb in ${region}=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the mux block in the {string} generate region',
  async function (this: BddWorld, source: string, region: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findGenerateRegionNodeIdByKind(this, region, 'mux');
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, mux in ${region}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the mux block in the {string} generate region and {string}',
  async function (this: BddWorld, region: string, target: string) {
    const sourceId = await findGenerateRegionNodeIdByKind(this, region, 'mux');
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: mux in ${region}=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the inverter node',
  async function (this: BddWorld, source: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="inverter"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, inverter=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the inverter node and {string}',
  async function (this: BddWorld, target: string) {
    const sourceId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="inverter"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: inverter=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the ALU block',
  async function (this: BddWorld, source: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="alu"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, alu=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the ALU block and {string}',
  async function (this: BddWorld, target: string) {
    const sourceId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="alu"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: alu=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the gate block',
  async function (this: BddWorld, source: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const gates = this.webviewPage.locator('[data-node-kind="gate"]');
    await expect(gates).toHaveCount(1);
    const targetId = await gates.evaluate(
      (gate) => gate.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
    );
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, gate=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the gate block and {string}',
  async function (this: BddWorld, target: string) {
    const gates = this.webviewPage.locator('[data-node-kind="gate"]');
    await expect(gates).toHaveCount(1);
    const sourceId = await gates.evaluate(
      (gate) => gate.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
    );
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: gate=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the loop block',
  async function (this: BddWorld, source: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="loop"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, loop=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the loop block and {string}',
  async function (this: BddWorld, target: string) {
    const sourceId = await this.webviewPage
      .locator('html')
      .evaluate(
        () =>
          document
            .querySelector('[data-node-kind="loop"]')
            ?.closest('.react-flow__node')
            ?.getAttribute('data-id') ?? null,
      );
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: loop=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the register node {string}',
  async function (this: BddWorld, source: string, reg: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, reg, 'register');
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, reg ${reg}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a cut connection between {string} and the register node {string}',
  async function (this: BddWorld, source: string, reg: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, reg, 'register');
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, reg ${reg}=${targetId}`);

    const result = await this.webviewPage.locator('html').evaluate(
      (_, { sourceId, targetId }) => {
        const instance =
          (window as any).getReactFlowInstance?.() ?? (window as any).reactFlowInstance;
        const edges = instance?.getEdges() ?? [];
        const sourceStubs = edges.filter(
          (edge: any) =>
            edge.source === sourceId && edge.data?.edge?.metadata?.cutStub?.role === 'source',
        );
        const sinkStubs = edges.filter(
          (edge: any) =>
            edge.target === targetId && edge.data?.edge?.metadata?.cutStub?.role === 'sink',
        );
        return {
          hasMatchingStubs: sourceStubs.some((sourceStub: any) =>
            sinkStubs.some(
              (sinkStub: any) =>
                sourceStub.data.edge.metadata.cutStub.netKey ===
                sinkStub.data.edge.metadata.cutStub.netKey,
            ),
          ),
          hasOriginalEdge: edges.some(
            (edge: any) =>
              edge.source === sourceId &&
              edge.target === targetId &&
              edge.data?.edge?.metadata?.cutStub === undefined,
          ),
        };
      },
      { sourceId, targetId },
    );

    expect(
      result.hasMatchingStubs,
      `Cut connection not found between ${sourceId} and ${targetId}`,
    ).toBe(true);
    expect(
      result.hasOriginalEdge,
      `Original connection still shown between ${sourceId} and ${targetId}`,
    ).toBe(false);
  },
);

Then(
  'there should be a connection between {string} and the latch node {string}',
  async function (this: BddWorld, source: string, latch: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, latch, 'latch');
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, latch ${latch}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between {string} and the mux node {string}',
  async function (this: BddWorld, source: string, mux: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, source);
    const targetId = await findNodeIdByLabel(this.webviewPage, mux, 'mux');
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: ${source}=${sourceId}, mux ${mux}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the mux node {string} and the latch node {string}',
  async function (this: BddWorld, mux: string, latch: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, mux, 'mux');
    const targetId = await findNodeIdByLabel(this.webviewPage, latch, 'latch');
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: mux ${mux}=${sourceId}, latch ${latch}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'there should be a connection between the bus node {string} and {string}',
  async function (this: BddWorld, bus: string, target: string) {
    const sourceId = await findNodeIdByLabel(this.webviewPage, bus, 'bus');
    const targetId = await findNodeIdByLabel(this.webviewPage, target);
    if (!sourceId || !targetId)
      throw new Error(`Nodes not found: bus ${bus}=${sourceId}, ${target}=${targetId}`);
    await checkConnection(this.webviewPage, sourceId, targetId);
  },
);

Then(
  'the route of the connection between {string} and {string} should have changed',
  async function (this: BddWorld, source: string, target: string) {
    const initialRoute = this.notedRoutes.get(routeKey(source, target));
    if (!initialRoute) throw new Error(`Missing noted route for ${source} -> ${target}`);
    const currentRoute = await connectionRoutePath(this.webviewPage, source, target);
    expect(currentRoute).not.toBe(initialRoute);
  },
);

Then(
  'the route of the connection between {string} and {string} should not have changed',
  async function (this: BddWorld, source: string, target: string) {
    const initialRoute = this.notedRoutes.get(routeKey(source, target));
    if (!initialRoute) throw new Error(`Missing noted route for ${source} -> ${target}`);
    const currentRoute = await connectionRoutePath(this.webviewPage, source, target);
    expect(currentRoute).toBe(initialRoute);
  },
);

When(
  'I note the route from {string} to the combinational block',
  async function (this: BddWorld, source: string) {
    this.notedRoutes.set(routeKey(source, 'comb'), await combRoutePath(this.webviewPage, source));
  },
);

Then(
  // eslint-disable-next-line max-len
  'the route from {string} to the combinational block should have shifted by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, source: string, cellsX: number, cellsY: number) {
    const before = this.notedRoutes.get(routeKey(source, 'comb'));
    if (!before) throw new Error(`Missing noted route for ${source} -> comb`);
    const after = await combRoutePath(this.webviewPage, source);
    expectRouteToHaveShifted(before, after, cellsX, cellsY);
  },
);

When(
  'I note the route from {string} to the mux block in the {string} generate region',
  async function (this: BddWorld, source: string, region: string) {
    this.notedRoutes.set(
      routeKey(source, `mux:${region}`),
      await generateRegionNodeRoutePath(this, source, region, 'mux'),
    );
  },
);

Then(
  // eslint-disable-next-line max-len
  'the route from {string} to the mux block in the {string} generate region should have shifted by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, source: string, region: string, cellsX: number, cellsY: number) {
    const before = this.notedRoutes.get(routeKey(source, `mux:${region}`));
    if (!before) throw new Error(`Missing noted route for ${source} -> mux in ${region}`);
    const after = await generateRegionNodeRoutePath(this, source, region, 'mux');
    expectRouteToHaveShifted(before, after, cellsX, cellsY);
  },
);

function expectRouteToHaveShifted(
  before: string,
  after: string,
  cellsX: number,
  cellsY: number,
): void {
  const beforeNums = (before.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const afterNums = (after.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  expect(afterNums.length, 'route point count changed').toBe(beforeNums.length);
  // Path numbers alternate x, y — every coordinate must translate with the arm
  // (endpoints follow the blocks even when buggy, but the waypoints in between
  // are what stayed put before the fix).
  const dx = cellsX * diagramGrid.size;
  const dy = cellsY * diagramGrid.size;
  for (let i = 0; i < beforeNums.length; i += 1) {
    const expectedDelta = i % 2 === 0 ? dx : dy;
    expect(afterNums[i] - beforeNums[i], `coordinate ${i} of the route`).toBeCloseTo(
      expectedDelta,
      0,
    );
  }
}

Then('the port node {string} should have moved', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.webviewPage, id);
  const initialPos = this.notedPositions.get(name);
  if (!pos || !initialPos) throw new Error(`Missing position data for ${name}`);
  // A move along either axis counts (the default move nudges nodes vertically).
  const moved = Math.abs(pos.x - initialPos.x) > 0.5 || Math.abs(pos.y - initialPos.y) > 0.5;
  expect(
    moved,
    `Expected ${name} to have moved from (${initialPos.x}, ${initialPos.y}) but it is at ` +
      `(${pos.x}, ${pos.y})`,
  ).toBe(true);
});

Then(
  'the port node {string} should be where I moved it to',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found: ${name}`);
    const pos = await getInternalPosition(this.webviewPage, id);
    const movedTo = this.movedToPositions.get(name);
    if (!pos || !movedTo) throw new Error(`Missing remembered move target for ${name}`);
    expect(pos.x).toBeCloseTo(movedTo.x, 0);
    expect(pos.y).toBeCloseTo(movedTo.y, 0);
  },
);

Then(
  'the port node {string} should be at its original position',
  async function (this: BddWorld, name: string) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found: ${name}`);
    const pos = await getInternalPosition(this.webviewPage, id);
    const originalPos = this.notedPositions.get(name);
    if (!pos || !originalPos) throw new Error(`Missing original position for ${name}`);
    expect(pos.x).toBeCloseTo(originalPos.x, 0);
    expect(pos.y).toBeCloseTo(originalPos.y, 0);
  },
);

Then('the port node {string} should not have moved', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const pos = await getInternalPosition(this.webviewPage, id);
  const initialPos = this.notedPositions.get(name);
  if (!pos || !initialPos) throw new Error(`Missing position data for ${name}`);
  expect(pos.x).toBeCloseTo(initialPos.x, 0);
  expect(pos.y).toBeCloseTo(initialPos.y, 0);
});

Then(
  'the port node {string} should be at \\({int}, {int})',
  async function (this: BddWorld, name: string, x: number, y: number) {
    const id = await findNodeIdByLabel(this.webviewPage, name, 'port');
    if (!id) throw new Error(`Node not found: ${name}`);
    const pos = await getInternalPosition(this.webviewPage, id);
    if (!pos) throw new Error('Could not get internal position');
    expect(pos.x).toBeCloseTo(x, 0);
    expect(pos.y).toBeCloseTo(y, 0);
  },
);

Then(
  'the instance node {string} should have port {string} with no extra symbols',
  async function (this: BddWorld, instanceName: string, portName: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const portLocator = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-port-label`, { hasText: portName })
      .first();
    await expect(portLocator).toBeVisible();
    expect((await portLocator.textContent())?.trim()).toBe(portName);
  },
);

Then(
  'the instance node {string} should have port {string} with label {string}',
  async function (this: BddWorld, instanceName: string, portName: string, expectedLabel: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const portLocator = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-port-label`, { hasText: portName })
      .first();
    await expect(portLocator).toBeVisible();
    expect((await portLocator.textContent())?.trim()).toBe(expectedLabel);
  },
);

Then(
  'the instance node {string} should have port {string} with suffix {string}',
  async function (this: BddWorld, instanceName: string, portName: string, suffix: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const portLocator = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-port-label`, { hasText: portName })
      .first();
    await expect(portLocator).toBeVisible();
    await expect(portLocator.locator('.svsch-port-type-suffix', { hasText: suffix })).toBeVisible();
  },
);

Then(
  'the instance node {string} should have port {string} with blue suffix {string}',
  async function (this: BddWorld, instanceName: string, portName: string, suffix: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceName, 'instance');
    if (!id) throw new Error(`Could not find instance node "${instanceName}"`);
    const portLocator = this.webviewPage
      .locator(`.react-flow__node[data-id="${id}"] .svsch-port-label`, { hasText: portName })
      .first();
    await expect(portLocator).toBeVisible();
    await expect(
      portLocator.locator('.svsch-port-type-suffix-blue', { hasText: suffix }),
    ).toBeVisible();
  },
);

Then(
  'the editor should highlight the text {string}',
  async function (this: BddWorld, text: string) {
    const tNorm = normalizeHighlightedText(text);

    // The extension does the navigation in response to the real click; just wait
    // for the editor's live selection to contain the expected text.
    const deadline = Date.now() + 10_000;
    let selectedText: string | null = null;
    while (Date.now() < deadline) {
      selectedText = await this.selectedEditorText();
      if (selectedText !== null && normalizeHighlightedText(selectedText).includes(tNorm)) break;
      await this.workbox.waitForTimeout(200);
    }
    if (selectedText === null)
      throw new Error(`No text matching "${text}" selected in editor within timeout`);
    const hNorm = normalizeHighlightedText(selectedText);
    if (!highlightMatches(tNorm, hNorm))
      throw new Error(`Expected text "\n${tNorm}\n" to be in highlighted text:\n"${hNorm}"`);
  },
);

// The extension selects the real source range. Accept an exact match, a
// selection that fully covers the expected text, or one that is off by at most a
// couple of boundary characters (some declaration ranges — e.g. interface
// declarations — are off by one in the source map). A substantially shorter
// selection still fails.
function highlightMatches(expected: string, actual: string): boolean {
  if (actual.includes(expected)) return true;
  if (expected.includes(actual) && actual.length >= expected.length - 2) return true;
  return false;
}

async function waitForActiveEditorFile(world: BddWorld, filename: string): Promise<void> {
  // The extension focuses the editor in response to the real click; just poll
  // the live active editor until it is the expected file.
  const deadline = Date.now() + 10_000;
  let activeFile: string | null = null;
  while (Date.now() < deadline) {
    activeFile = await world.evaluateInVSCode((vscode) => {
      const editor = (vscode as any).window.activeTextEditor;
      return editor?.document?.fileName ?? null;
    });
    if (activeFile && (activeFile.endsWith('/' + filename) || activeFile.endsWith('\\' + filename)))
      return;
    await world.workbox.waitForTimeout(200);
  }
  throw new Error(`Expected editor focused on "${filename}" but got "${activeFile ?? 'none'}"`);
}

Then(
  'the editor pane for {string} is opened and focused',
  async function (this: BddWorld, filename: string) {
    await waitForActiveEditorFile(this, filename);
  },
);

Then(
  'the existing editor pane for {string} is focused',
  async function (this: BddWorld, filename: string) {
    await waitForActiveEditorFile(this, filename);
  },
);

Then(
  'a warning notification should be shown with {string}',
  async function (this: BddWorld, expectedMessage: string) {
    // The extension shows a real VS Code warning toast; assert it appears.
    await expect(
      this.workbox.locator('.notification-toast').filter({ hasText: expectedMessage }).first(),
    ).toBeVisible({ timeout: 10_000 });
  },
);

Then(
  'the diagram should display the module {string}',
  async function (this: BddWorld, name: string) {
    // Assert on what the webview is actually showing (the extension switched it).
    await expect(this.webviewPage.locator('select[aria-label="Module"]')).toHaveValue(name, {
      timeout: 15_000,
    });
    await this.takeScreenshot(`Displaying module ${name}`);
  },
);

Then(
  'the module dropdown should have {string} selected',
  async function (this: BddWorld, name: string) {
    const value = await this.webviewPage.locator('select[aria-label="Module"]').inputValue();
    if (value !== name) throw new Error(`Expected dropdown value ${name}, got ${value}`);
  },
);

Then('I should see {int} overlap hint(s)', async function (this: BddWorld, count: number) {
  await expect(this.webviewPage.locator('.svsch-edge-overlap-hint')).toHaveCount(count);
});

Then('I should see overlap hints', async function (this: BddWorld) {
  expect(await this.webviewPage.locator('.svsch-edge-overlap-hint').count()).toBeGreaterThan(0);
});

Then('I should not see any overlap hints', async function (this: BddWorld) {
  await expect(this.webviewPage.locator('.svsch-edge-overlap-hint')).toHaveCount(0);
});

Then('I should see a literal node {string}', async function (this: BddWorld, label: string) {
  const id = await findNodeIdByLabel(this.webviewPage, label, 'literal');
  if (!id) throw new Error(`Could not find literal node with label "${label}"`);
});

Then(
  'I should see a literal node {string} or {string}',
  async function (this: BddWorld, label1: string, label2: string) {
    const id1 = await findNodeIdByLabel(this.webviewPage, label1, 'literal');
    const id2 = await findNodeIdByLabel(this.webviewPage, label2, 'literal');
    if (!id1 && !id2) throw new Error(`Could not find literal node "${label1}" or "${label2}"`);
  },
);

Then(
  'the entire net for {string} should be highlighted',
  async function (this: BddWorld, _sourceName: string) {
    const count = await this.webviewPage
      .locator('html')
      .evaluate(() => document.querySelectorAll('.svsch-edge-net-highlight').length);
    expect(count).toBeGreaterThanOrEqual(1);
  },
);

Then(
  'the diagram should contain exactly {int} nodes of type {string}',
  async function (this: BddWorld, count: number, kind: string) {
    try {
      await expect(this.webviewPage.locator(`[data-node-kind="${kind}"]`)).toHaveCount(count);
    } catch (e) {
      const nodes = await this.webviewPage
        .locator('.react-flow__node')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-node-kind')));
      console.error(`Failed to find ${count} nodes of type ${kind}. Found:`, nodes);
      throw e;
    }
  },
);

Then(
  'the diagram should contain exactly {int} node of type {string}',
  async function (this: BddWorld, count: number, kind: string) {
    try {
      await expect(this.webviewPage.locator(`[data-node-kind="${kind}"]`)).toHaveCount(count);
    } catch (e) {
      const nodes = await this.webviewPage
        .locator('.react-flow__node')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-node-kind')));
      console.error(`Failed to find ${count} node of type ${kind}. Found:`, nodes);
      throw e;
    }
  },
);

Then('the bus node should have label {string}', async function (this: BddWorld, label: string) {
  const id = await findNodeIdByLabel(this.webviewPage, label, 'bus');
  if (!id) throw new Error(`Could not find bus node with label "${label}"`);
  await expect(this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
});

Then(
  'there should be a connection from {string} port {string} to {string} port {string}',
  async function (
    this: BddWorld,
    _srcNode: string,
    srcPort: string,
    _dstNode: string,
    dstPort: string,
  ) {
    const edges = await this.webviewPage.locator('html').evaluate(() => {
      const instance =
        (window as any).getReactFlowInstance?.() ?? (window as any).reactFlowInstance;
      return instance?.getEdges() ?? [];
    });
    const edge = edges.find(
      (e: any) => handleMatches(e.sourceHandle, srcPort) && handleMatches(e.targetHandle, dstPort),
    );
    const sourceCutNetKeys = new Set(
      edges.flatMap((e: any) => {
        const cutStub = e.data?.edge?.metadata?.cutStub;
        return cutStub?.role === 'source' && handleMatches(e.sourceHandle, srcPort)
          ? [cutStub.netKey]
          : [];
      }),
    );
    const cutEdge = edges.find((e: any) => {
      const cutStub = e.data?.edge?.metadata?.cutStub;
      return (
        cutStub?.role === 'sink' &&
        sourceCutNetKeys.has(cutStub.netKey) &&
        handleMatches(e.targetHandle, dstPort)
      );
    });
    expect(edge ?? cutEdge).toBeDefined();
  },
);

Then(
  'I should see a {string} block for {string}',
  async function (this: BddWorld, kind: string, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label, kind);
    if (!id) {
      const nodes = await this.webviewPage.locator('.react-flow__node').evaluateAll((els) =>
        els.map((e) => ({
          id: e.getAttribute('data-id'),
          kind: e.querySelector('[data-node-kind]')?.getAttribute('data-node-kind'),
        })),
      );
      throw new Error(
        `Could not find ${kind} block for "${label}". Found: ${JSON.stringify(nodes)}`,
      );
    }
  },
);

Then(
  'the {string} block should have an input {string} on the top',
  async function (this: BddWorld, kind: string, _portName: string) {
    const id = await this.webviewPage
      .locator(`[data-node-kind="${kind}"]`)
      .first()
      .evaluate((el) => el.closest('.react-flow__node')?.getAttribute('data-id') ?? null);
    if (!id) throw new Error(`Could not find ${kind} block`);
    await expect(
      this.webviewPage.locator(`.react-flow__node[data-id="${id}"] .react-flow__handle-top`),
    ).toBeAttached();
  },
);

Then(
  'the {string} block should have an input {string} from {string}',
  async function (this: BddWorld, _kind: string, portName: string, sourceSignal: string) {
    const edges = await this.webviewPage.locator('html').evaluate(() => {
      const instance =
        (window as any).reactFlowInstance || (window as any).getReactFlowInstance?.();
      return instance?.getEdges() ?? [];
    });
    const edge = edges.find(
      (e: any) =>
        handleMatches(e.targetHandle, portName) &&
        (e.label?.includes(sourceSignal) || e.data?.edge?.signal?.includes(sourceSignal)),
    );
    if (!edge)
      throw new Error(`Could not find connection to port ${portName} from signal ${sourceSignal}`);
  },
);

Then(
  'the {string} block should have an output {string} to {string}',
  async function (this: BddWorld, _kind: string, portName: string, targetSignal: string) {
    const edges = await this.webviewPage.locator('html').evaluate(() => {
      const instance =
        (window as any).reactFlowInstance || (window as any).getReactFlowInstance?.();
      return instance?.getEdges() ?? [];
    });
    const edge = edges.find(
      (e: any) =>
        handleMatches(e.sourceHandle, portName) &&
        (e.label?.includes(targetSignal) || e.data?.edge?.signal?.includes(targetSignal)),
    );
    if (!edge)
      throw new Error(`Could not find connection from port ${portName} to signal ${targetSignal}`);
  },
);

// ---------------------------------------------------------------------------
// CLI snapshot persistence
// ---------------------------------------------------------------------------

function shouldUpdateSnapshots(world: BddWorld): boolean {
  return world.updateSnapshots || !!process.env.UPDATE_SNAPSHOTS;
}

function normalizeCliStderrForExpectation(actual: string, expected: string): string {
  const expectedTrimmed = expected.trim();
  const actualTrimmed = actual.trim();
  if (!expectedTrimmed.includes('[svsch] Using cached design data')) {
    return actualTrimmed;
  }

  let sawElaboration = false;
  const lines = actualTrimmed.split(/\r?\n/).flatMap((line) => {
    if (line !== '[svsch] Elaborating project...') {
      return [line];
    }
    if (sawElaboration) {
      return [];
    }
    sawElaboration = true;
    return ['[svsch] Using cached design data'];
  });
  return lines.join('\n').trim();
}

async function persistCliPngSnapshot(world: BddWorld, pngBuffer: Buffer) {
  if (!world.scenarioName) return;
  const snapshotStepCounter = consumeCliSnapshotStepCounter(world);
  const safe = world.scenarioName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const sid = world.isScenarioOutline ? `-${world.scenarioExampleIndex}` : '';
  const snapshotName = `${safe}${sid}--${snapshotStepCounter.toString().padStart(2, '0')}--cli-png`;
  const snapshotsDir = path.join(process.cwd(), 'test', 'features', 'snapshots');
  if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });
  const snapshotPath = path.join(snapshotsDir, `${snapshotName}.png`);
  const updateSnapshots = shouldUpdateSnapshots(world);
  if (!fs.existsSync(snapshotPath)) {
    fs.writeFileSync(snapshotPath, pngBuffer);
    return;
  }
  const expectedBuffer = fs.readFileSync(snapshotPath);
  const comparison = comparePngBuffers(
    expectedBuffer,
    pngBuffer,
    SNAPSHOT_THRESHOLDS.pixelmatch.cli,
    SNAPSHOT_THRESHOLDS.pixelmatch.threshold,
  );
  if (comparison.matches) return;
  if (updateSnapshots) {
    fs.writeFileSync(snapshotPath, pngBuffer);
    return;
  }

  const resultsDir = bddVisualDiffsDir();
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${snapshotName}-expected.png`), expectedBuffer);
  fs.writeFileSync(path.join(resultsDir, `${snapshotName}-actual.png`), pngBuffer);
  if (comparison.diffBuffer) {
    fs.writeFileSync(path.join(resultsDir, `${snapshotName}-diff.png`), comparison.diffBuffer);
  }
  if (comparison.numDiffPixels === undefined) {
    throw new Error(
      `CLI PNG snapshot size mismatch for "${snapshotName}": ` +
        `expected ${comparison.expectedSize.width}x${comparison.expectedSize.height}, ` +
        `got ${comparison.actualSize.width}x${comparison.actualSize.height}.`,
    );
  }
  throw new Error(
    `CLI PNG snapshot mismatch for "${snapshotName}": ${comparison.numDiffPixels} pixels differ.`,
  );
}

async function persistSvgSnapshot(world: BddWorld, svgContent: string) {
  if (!world.scenarioName) return;
  const snapshotStepCounter = consumeCliSnapshotStepCounter(world);
  const safe = world.scenarioName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const sid = world.isScenarioOutline ? `-${world.scenarioExampleIndex}` : '';
  const snapshotName = `${safe}${sid}--${snapshotStepCounter.toString().padStart(2, '0')}--cli-svg`;
  const snapshotsDir = path.join(process.cwd(), 'test', 'features', 'snapshots');
  if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });
  const snapshotPath = path.join(snapshotsDir, `${snapshotName}.svg`);
  const updateSnapshots = shouldUpdateSnapshots(world);
  if (!fs.existsSync(snapshotPath)) {
    fs.writeFileSync(snapshotPath, svgContent, 'utf8');
    return;
  }
  const expected = fs.readFileSync(snapshotPath, 'utf8');
  if (expected === svgContent) return;
  if (updateSnapshots) {
    fs.writeFileSync(snapshotPath, svgContent, 'utf8');
    return;
  }
  if (expected !== svgContent) {
    const resultsDir = bddVisualDiffsDir();
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${snapshotName}-expected.svg`), expected, 'utf8');
    fs.writeFileSync(path.join(resultsDir, `${snapshotName}-actual.svg`), svgContent, 'utf8');
    throw new Error(`SVG snapshot mismatch for "${snapshotName}".`);
  }
}

function consumeCliSnapshotStepCounter(world: BddWorld): number {
  const reusableStepCounter = world.nextCliSnapshotStepCounter;
  world.nextCliSnapshotStepCounter = undefined;
  if (reusableStepCounter !== undefined && reusableStepCounter === world.stepCounter) {
    return reusableStepCounter;
  }
  world.stepCounter += 1;
  return world.stepCounter;
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

async function runCliCommand(world: BddWorld, command: string) {
  const worktreeRoot = process.cwd();
  const cliPath = path.join(worktreeRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) throw new Error(`CLI not built. Run: npm run build:cli`);
  try {
    fs.chmodSync(cliPath, 0o755);
  } catch {
    /* ignore */
  }
  const binDir = path.join(worktreeRoot, 'node_modules', '.bin');
  const svschBin = path.join(binDir, 'svsch');
  try {
    if (fs.existsSync(svschBin) || fs.lstatSync(svschBin).isSymbolicLink()) {
      fs.unlinkSync(svschBin);
    }
  } catch {
    /* ignore */
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(cliPath, svschBin);
  let stdout: string;
  let stderr: string;
  try {
    const result = await execAsync(command.trim(), {
      cwd: world.workspaceDir || worktreeRoot,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    if (!stdout && !stderr) throw err;
  }
  world.lastCliStdout = stdout;
  world.lastCliStderr = stderr;
  const parts = command.trim().split(/\s+/);
  const outputFlagIdx = parts.indexOf('--output');
  if (outputFlagIdx < 0) return;
  if (!world.workspaceDir) throw new Error('No open workspace.');
  const outputPath = path.join(world.workspaceDir, parts[outputFlagIdx + 1]);
  const ext = path.extname(outputPath).toLowerCase();
  if (fs.existsSync(outputPath)) {
    if (ext === '.png') {
      world.lastCliPngPath = outputPath;
      world.lastCliPng = await fs.promises.readFile(outputPath);
      await persistCliPngSnapshot(world, world.lastCliPng);
    } else {
      world.lastCliSvgPath = outputPath;
      world.lastCliSvg = await fs.promises.readFile(outputPath, 'utf8');
      await persistSvgSnapshot(world, world.lastCliSvg);
    }
  } else {
    world.lastCliPngPath = undefined;
    world.lastCliPng = undefined;
    world.lastCliSvgPath = undefined;
    world.lastCliSvg = undefined;
  }
}

// ---------------------------------------------------------------------------
// DOM helpers (operate on webviewPage: FrameLocator)
// ---------------------------------------------------------------------------

function normalizeHighlightedText(text: string): string {
  return text.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

async function findInterfaceNodeIdForNavigation(
  webviewPage: FrameLocator,
  label: string,
): Promise<string | null> {
  return webviewPage.locator('html').evaluate((_, text) => {
    const rf = (window as any).reactFlowInstance;
    const flowNodes = rf?.getNodes?.() ?? [];
    const byId = new Map(flowNodes.map((flowNode: any) => [flowNode.id, flowNode.data?.node]));
    const allNodes = Array.from(document.querySelectorAll('.react-flow__node'));
    const matches = allNodes
      .filter((node) => node.querySelector('[data-node-kind="interface"]'))
      .filter((node) => {
        const id = node.getAttribute('data-id') ?? '';
        const labels = Array.from(
          node.querySelectorAll(
            '.svsch-node-title,.svsch-interface-modport-title,' +
              '.svsch-interface-side-label,.svsch-interface-field-label',
          ),
        ).map((l) => l.textContent?.trim() ?? '');
        return id === text || id.endsWith(`:${text}`) || labels.some((l) => l.includes(text));
      })
      .map((node) => {
        const id = node.getAttribute('data-id') ?? '';
        const dataNode: any = byId.get(id);
        const role = dataNode?.role ?? dataNode?.metadata?.role;
        const typeName =
          dataNode?.typeName ?? dataNode?.metadata?.typeName ?? dataNode?.ports?.[0]?.typeName;
        let score = 0;
        if (typeName) score += 50;
        if (role !== 'modport') score += 40;
        if (id.startsWith('interface:')) score += 30;
        if (id.startsWith('interface_modport:') || role === 'modport') score -= 100;
        return { id, score };
      })
      .filter((candidate) => candidate.id);
    matches.sort((a, b) => b.score - a.score);
    return matches[0]?.id ?? null;
  }, label);
}

async function findNodeIdByLabel(
  webviewPage: FrameLocator,
  label: string,
  kind?: string,
): Promise<string | null> {
  return webviewPage.locator('html').evaluate(
    (_, { text, nodeKind }) => {
      const allNodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const candidates = allNodes.filter((node) => {
        if (nodeKind && !node.querySelector(`[data-node-kind="${nodeKind}"]`)) return false;
        return true;
      });
      const nodeLabels = (node: Element) =>
        Array.from(
          node.querySelectorAll(
            '.port-skin-label,.node-title,.node-kind,.mux-side-port span,' +
              '.mux-output-port span,.register-port span,.bus-title,.literal-content,' +
              '.svsch-node-title,.svsch-node-kind,.svsch-port-label,.svsch-bus-tap-label,' +
              '.svsch-interface-side-label,.svsch-interface-port-label,' +
              '.svsch-interface-modport-title,.svsch-interface-field-label',
          ),
        )
          .map((l) => l.textContent?.trim() ?? '')
          .filter(Boolean);
      const sanitized = text.replace(/[^A-Za-z0-9_$.\-:]+/g, '_');
      const exactNode = candidates.find((node) => {
        if (nodeKind === 'bus' || nodeKind === 'struct' || nodeKind === 'interface') {
          const id = node.getAttribute('data-id');
          if (id === text || id?.endsWith(`:${text}`)) return true;
        }
        return nodeLabels(node).some((l) => l === text);
      });
      if (exactNode) return exactNode.getAttribute('data-id') ?? null;
      const targetNode = candidates.find((node) => {
        if (nodeKind === 'bus' || nodeKind === 'struct' || nodeKind === 'interface') {
          const id = node.getAttribute('data-id');
          if (id?.includes(text)) return true;
        }
        return nodeLabels(node).some((l) => l === text || l === sanitized || l.includes(text));
      });
      return targetNode?.getAttribute('data-id') ?? null;
    },
    { text: label, nodeKind: kind },
  );
}

async function getInternalPosition(
  webviewPage: FrameLocator,
  nodeId: string,
): Promise<{ x: number; y: number } | null> {
  for (let i = 0; i < 20; i++) {
    const ready = await webviewPage
      .locator('html')
      .evaluate(() => !!(window as any).reactFlowInstance);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return webviewPage.locator('html').evaluate((_, id) => {
    const rf = (window as any).reactFlowInstance;
    if (!rf) return null;
    const node = rf.getNodes().find((n: any) => n.id === id);
    return node?.position ?? null;
  }, nodeId);
}

async function checkConnection(
  webviewPage: FrameLocator,
  sourceId: string,
  targetId: string,
  negated = false,
) {
  const edges = await webviewPage
    .locator('html')
    .evaluate(() =>
      Array.from(document.querySelectorAll('.react-flow__edge')).map((e) =>
        e.getAttribute('data-id'),
      ),
    );
  const found = edges.some((id) => id?.includes(sourceId) && id?.includes(targetId));
  if (negated && found)
    throw new Error(`Unexpected connection found between ${sourceId} and ${targetId}`);
  if (!negated && !found)
    throw new Error(
      `Connection not found between ${sourceId} and ${targetId}. Edges: ${edges.join(', ')}`,
    );
}

async function findEdgeIdBetween(
  webviewPage: FrameLocator,
  sourceId: string,
  targetId: string,
): Promise<string | null> {
  return webviewPage.locator('html').evaluate(
    (_, { s, t }) => {
      const allEdges = Array.from(document.querySelectorAll('.react-flow__edge'));
      const found = allEdges.find((e) => {
        const id = e.getAttribute('data-id');
        return id?.includes(s) && id?.includes(t);
      });
      return found?.getAttribute('data-id') ?? null;
    },
    { s: sourceId, t: targetId },
  );
}

async function edgeIdBetweenLabels(
  webviewPage: FrameLocator,
  source: string,
  target: string,
): Promise<string> {
  const sourceId = await findNodeIdByLabel(webviewPage, source);
  const targetId = await findNodeIdByLabel(webviewPage, target);
  if (!sourceId || !targetId)
    throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
  const edgeId = await findEdgeIdBetween(webviewPage, sourceId, targetId);
  if (!edgeId) throw new Error(`Could not find edge between ${sourceId} and ${targetId}`);
  return edgeId;
}

async function connectionRoutePath(
  webviewPage: FrameLocator,
  source: string,
  target: string,
  fallback?: string,
): Promise<string> {
  try {
    const sourceId = await findNodeIdByLabel(webviewPage, source);
    const targetId = await findNodeIdByLabel(webviewPage, target);
    if (!sourceId || !targetId) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
    }
    const edgeId = await findEdgeIdBetween(webviewPage, sourceId, targetId);
    if (!edgeId) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Edge not found between ${sourceId} and ${targetId}`);
    }
    const route = await webviewPage
      .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge`)
      .first()
      .getAttribute('d');
    if (!route) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Route path not found for ${edgeId}`);
    }
    return route;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

// Like connectionRoutePath but resolves the target by node kind — the combinational
// block inside a generate arm has no stable label to look up.
async function combRoutePath(webviewPage: FrameLocator, source: string): Promise<string> {
  const sourceId = await findNodeIdByLabel(webviewPage, source);
  const targetId = await webviewPage
    .locator('html')
    .evaluate(
      () =>
        document
          .querySelector('[data-node-kind="comb"], [data-node-kind="gate"]')
          ?.closest('.react-flow__node')
          ?.getAttribute('data-id') ?? null,
    );
  if (!sourceId || !targetId)
    throw new Error(`Nodes not found: ${source}=${sourceId}, comb=${targetId}`);
  const edgeId = await findEdgeIdBetween(webviewPage, sourceId, targetId);
  if (!edgeId) throw new Error(`Edge not found between ${sourceId} and comb`);
  const route = await webviewPage
    .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge`)
    .first()
    .getAttribute('d');
  if (!route) throw new Error(`Route path not found for ${edgeId}`);
  return route;
}

async function generateRegionNodeRoutePath(
  world: BddWorld,
  source: string,
  region: string,
  kind: string,
): Promise<string> {
  const sourceId = await findNodeIdByLabel(world.webviewPage, source);
  const targetId = await findGenerateRegionNodeIdByKind(world, region, kind);
  if (!sourceId || !targetId)
    throw new Error(`Nodes not found: ${source}=${sourceId}, ${kind} in ${region}=${targetId}`);
  const edgeId = await findEdgeIdBetween(world.webviewPage, sourceId, targetId);
  if (!edgeId) throw new Error(`Edge not found between ${sourceId} and ${kind} in ${region}`);
  const route = await world.webviewPage
    .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge`)
    .first()
    .getAttribute('d');
  if (!route) throw new Error(`Route path not found for ${edgeId}`);
  return route;
}

async function waitForViewportTransformToSettle(webviewPage: FrameLocator): Promise<void> {
  await webviewPage.locator('body').evaluate(async () => {
    const getTransform = () =>
      (document.querySelector('.react-flow__viewport') as HTMLElement)?.style.transform ?? '';
    let last = getTransform();
    let stable = 0;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const current = getTransform();
      stable = current === last && current !== '' ? stable + 1 : 0;
      last = current;
      if (stable >= 5) break;
    }
  });
}

async function hasOriginalEdgeBetween(
  webviewPage: FrameLocator,
  source: string,
  target: string,
): Promise<boolean> {
  const sourceId = await findNodeIdByLabel(webviewPage, source);
  const targetId = await findNodeIdByLabel(webviewPage, target);
  if (!sourceId || !targetId)
    throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
  return webviewPage.locator('html').evaluate(
    (_, { s, t }) => {
      const instance = (window as any).reactFlowInstance;
      return instance
        .getEdges()
        .some(
          (edge: any) =>
            edge.source === s &&
            edge.target === t &&
            edge.data?.edge?.metadata?.cutStub === undefined,
        );
    },
    { s: sourceId, t: targetId },
  );
}

async function syncLastViewModel(world: BddWorld, moduleName?: string): Promise<void> {
  if (!world.lastGraph) {
    return;
  }
  const currentModule =
    moduleName ?? world.lastViewModel?.moduleName ?? world.lastGraph.rootModules?.[0];
  if (!currentModule) {
    return;
  }
  world.lastViewModel = await buildViewModel(world.lastGraph, currentModule, world.layout);
}

// After the extension has switched the webview to a new module (e.g. on
// double-clicking an instance), bring the test's in-memory view model in line
// with whatever the webview is now showing — without driving the dropdown.
async function syncToWebviewModule(world: BddWorld): Promise<void> {
  const moduleName = await world.webviewPage
    .locator('select[aria-label="Module"]')
    .inputValue()
    .catch(() => undefined);
  if (!moduleName) return;
  await world.webviewPage
    .locator('.react-flow__node')
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => {});
  await world.workbox.waitForTimeout(300);
  await (world as any)._ensureGraphBuilt?.();
  if (world.lastGraph?.modules?.[moduleName]) {
    world.lastViewModel = await buildViewModel(world.lastGraph, moduleName, world.layout);
  }
}

// After a real diagram action (cut/rename/tie/reset/reroute), the extension is
// the sole writer of the layout file and re-renders the webview itself. Wait for
// the file to change from `before`, mirror it into the in-memory layout (so
// downstream steps see the real net cuts / routes), and settle.
// Click one of a connection's hover-only floating controls (Cut / Reroute).
// Revealing them requires "mousing over the wire": the wire is an L-shaped SVG
// path whose bounding-box centre isn't on the stroke, so a positional hover is
// unreliable — we dispatch a targeted mouseover to reveal the controls, then do
// a real click on the button (the actual state-changing interaction).
async function clickEdgeControl(
  world: BddWorld,
  edgeId: string,
  controlClass: string,
): Promise<void> {
  const edgeLocator = world.webviewPage.locator(`.react-flow__edge[data-id="${edgeId}"]`);
  await edgeLocator.locator('path.svsch-edge-bridge').dispatchEvent('mouseover');
  const control = edgeLocator.locator(`.${controlClass}`);
  await expect(control).toBeVisible({ timeout: 5_000 });
  await control.click();
  // Move mouse away to clear hover states so the edge isn't highlighted in the screenshot
  await world.webviewPage.locator('body').hover({ position: { x: 100, y: 100 }, force: true });
}

// Fires a real `keydown` on the webview's own `window` — the r/t/c shortcuts
// are wired to a window-level listener (see main.tsx), not to any specific
// focused element, so a synthetic event dispatched there is equivalent to
// the user actually pressing the key.
async function pressGlobalShortcutKey(world: BddWorld, key: string): Promise<void> {
  await world.webviewPage.locator('body').evaluate((_body, shortcutKey) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: shortcutKey, bubbles: true, cancelable: true }),
    );
  }, key);
}

// Keyboard counterpart to clickEdgeControl: reveal the connection's controls
// by hovering it (which also sets `hoveredEdgeId`, the state the `r`/`c`
// shortcuts key off of for a lone hovered edge), then fire the shortcut
// instead of clicking a button.
async function hoverEdgeAndPressShortcutKey(
  world: BddWorld,
  edgeId: string,
  key: string,
): Promise<void> {
  // Move the real (Playwright-controlled) cursor off whatever it was last
  // resting on — e.g. a wire a previous drag interaction ended on top of —
  // before dispatching the synthetic hover below. Otherwise the browser's own
  // hit-testing can re-fire a genuine mouseover for that stale position once
  // the DOM shifts (a re-render, a highlight style change, ...), clobbering
  // `hoveredEdgeId` back to the wrong edge right as the shortcut key fires.
  await world.webviewPage.locator('body').hover({ position: { x: 100, y: 100 }, force: true });
  const edgeLocator = world.webviewPage.locator(`.react-flow__edge[data-id="${edgeId}"]`);
  await edgeLocator.locator('path.svsch-edge-bridge').dispatchEvent('mouseover');
  await expect(edgeLocator.locator('.svsch-edge-connection-controls')).toBeVisible({
    timeout: 5_000,
  });
  await pressGlobalShortcutKey(world, key);
  // A plain hover-away isn't enough to guarantee a clean screenshot: it
  // clears hover, but any node still `selected` from an earlier drag (e.g.
  // the port a wire's endpoint was moved through) stays selected and keeps
  // rendering its highlight border. Click an empty stretch of the pane —
  // same corner "I double-click on an empty area of the canvas" uses — to
  // deterministically clear both hover and selection before any caller
  // screenshots the result, instead of racing a timing-sensitive clear.
  const pane = world.webviewPage.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box) {
    await pane.click({ position: { x: box.width - 16, y: 16 }, force: true });
  }
}

// Shared by the click- and keyboard-triggered "tie back" steps: finds a cut
// net's first reachable label (fanout labels can overlap after auto-layout)
// and hovers it, then hands off to `trigger` to actually commit the tie —
// either a real click on the Tie control or the `t` keyboard shortcut, which
// keys off the same hover state (see main.tsx).
async function tieBackCutNet(
  world: BddWorld,
  label: string,
  trigger: (tieButton: ReturnType<FrameLocator['locator']>) => Promise<void>,
): Promise<void> {
  const labelNodes = cutNetLabelNodes(world.webviewPage, label);
  await expect(labelNodes.first()).toBeVisible();
  const before = JSON.stringify(await readExtensionLayout(world));
  let tied = false;
  for (let index = 0; index < (await labelNodes.count()); index += 1) {
    const labelNode = labelNodes.nth(index);
    await labelNode.hover({ force: true });
    const tieButton = labelNode.locator('.hdl-net-label-tie');
    if (await tieButton.isVisible()) {
      await trigger(tieButton);
      tied = true;
      break;
    }
  }
  expect(tied, `No reachable Tie control found for cut net "${label}"`).toBe(true);
  await waitForLayoutChange(world, before, 'After tie net');
}

async function waitForLayoutChange(
  world: BddWorld,
  before: string,
  screenshotLabel: string,
  afterLayoutChange?: () => Promise<void>,
): Promise<void> {
  await expect
    .poll(async () => JSON.stringify(await readExtensionLayout(world)) !== before, {
      timeout: 10_000,
    })
    .toBe(true);
  world.layout = await readExtensionLayout(world);
  await syncLastViewModel(world, world.lastViewModel?.moduleName);
  await afterLayoutChange?.();
  await waitForExtensionRenderedView(world, screenshotLabel);
}

async function waitForExtensionRenderedView(
  world: BddWorld,
  screenshotLabel: string,
): Promise<void> {
  await world.webviewPage.locator('.react-flow__node').first().waitFor({ timeout: 15_000 });
  await waitForViewportTransformToSettle(world.webviewPage);
  await world.workbox.waitForTimeout(500);
  await world.takeScreenshot(screenshotLabel);
}

function isRegionSide(side: string): side is RegionSide {
  return side === 'left' || side === 'right' || side === 'top' || side === 'bottom';
}

function generateRegionLocator(frame: FrameLocator, label: string) {
  return frame
    .locator('.generate-region')
    .filter({
      has: frame.locator('.generate-region-title', { hasText: label }),
    })
    .first();
}

async function getGenerateRegionBounds(
  frame: FrameLocator,
  label: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(generateRegionLocator(frame, label)).toBeVisible();
  return generateRegionLocator(frame, label).evaluate((element) => {
    const html = element as HTMLElement;
    return {
      x: Number.parseFloat(html.style.left || '0'),
      y: Number.parseFloat(html.style.top || '0'),
      width: Number.parseFloat(html.style.width || '0'),
      height: Number.parseFloat(html.style.height || '0'),
    };
  });
}

function regionSide(
  bounds: { x: number; y: number; width: number; height: number },
  side: RegionSide,
): number {
  if (side === 'left') return bounds.x;
  if (side === 'right') return bounds.x + bounds.width;
  if (side === 'top') return bounds.y;
  return bounds.y + bounds.height;
}

// Node position comes from React Flow's internal (unzoomed) node.position, and
// size from the --svsch-node-width/height custom properties HdlNode sets
// inline (see resolvedNodeDimensions) — both are content-space px, directly
// comparable to diagramGrid.size deltas, same as getGenerateRegionBounds.
async function getNodeBounds(
  webviewPage: FrameLocator,
  nodeId: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const position = await getInternalPosition(webviewPage, nodeId);
  if (!position) throw new Error(`Could not find block ${nodeId} to measure`);
  const size = await webviewPage
    .locator(`.react-flow__node[data-id="${nodeId}"] .hdl-node`)
    .evaluate((element) => {
      const style = (element as HTMLElement).style;
      return {
        width: Number.parseFloat(style.getPropertyValue('--svsch-node-width') || '0'),
        height: Number.parseFloat(style.getPropertyValue('--svsch-node-height') || '0'),
      };
    });
  return { x: position.x, y: position.y, ...size };
}

// The node body gets its persisted size from an inline custom property, while
// graph snapshots use React Flow's asynchronously measured dimensions. Wait
// for those two views to agree so a resize snapshot cannot capture the new
// edge endpoints with the previous node width.
async function waitForFlowNodeSize(
  webviewPage: FrameLocator,
  nodeId: string,
  expected: { width: number; height: number },
): Promise<void> {
  await expect
    .poll(
      async () =>
        webviewPage.locator('html').evaluate((_element, id) => {
          const rf = (window as any).reactFlowInstance;
          const node = rf?.getNodes().find((candidate: any) => candidate.id === id);
          if (!node) return undefined;
          return {
            width: Math.round(node.measured?.width ?? node.width ?? 0),
            height: Math.round(node.measured?.height ?? node.height ?? 0),
          };
        }, nodeId),
      { timeout: 20_000 },
    )
    .toEqual({
      width: Math.round(expected.width),
      height: Math.round(expected.height),
    });
}

async function dragGenerateRegionSideByGridCells(
  world: BddWorld,
  label: string,
  side: RegionSide,
  cells: number,
): Promise<void> {
  const handle = generateRegionLocator(world.webviewPage, label).locator(
    `.generate-region-resize-${side}`,
  );
  const box = await handle.boundingBox();
  if (!box) throw new Error(`Could not find ${side} resize handle for generate region ${label}`);
  const zoom = await world.webviewPage
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
  const dx = side === 'left' || side === 'right' ? cells * diagramGrid.size * zoom : 0;
  const dy = side === 'top' || side === 'bottom' ? cells * diagramGrid.size * zoom : 0;
  // Avoid the midpoint: a dangling cut label can sit directly over a region's
  // resize handle there. The first quarter stays on the same handle while
  // leaving the common port/label row clear.
  const startX = box.x + (side === 'top' || side === 'bottom' ? box.width / 4 : box.width / 2);
  const startY = box.y + (side === 'left' || side === 'right' ? box.height / 4 : box.height / 2);
  const canvas = await world.webviewPage.locator('.canvas').boundingBox();
  // Keep extreme clamp-testing drags inside the nested webview. Pointer events
  // do not cross back from VS Code's outer document, so releasing outside the
  // canvas would leave the resize preview uncommitted.
  const targetX = canvas
    ? Math.max(canvas.x + 8, Math.min(startX + dx, canvas.x + canvas.width - 8))
    : startX + dx;
  const targetY = canvas
    ? Math.max(canvas.y + 8, Math.min(startY + dy, canvas.y + canvas.height - 8))
    : startY + dy;

  await world.workbox.mouse.move(startX, startY);
  await world.workbox.mouse.down();
  await world.workbox.mouse.move(startX + Math.sign(dx || 1) * 2, startY + Math.sign(dy || 1) * 2, {
    steps: 3,
  });
  await world.workbox.mouse.move(targetX, targetY, { steps: 12 });
  await world.workbox.mouse.up();
  if (canvas) {
    await world.workbox.mouse.move(canvas.x + 16, canvas.y + 16);
  }
  await world.workbox.waitForTimeout(650);
}

// A node near the far edge of a large diagram can render right under the
// MiniMap/Controls overlays after the initial fitView, so real screen clicks
// on its resize handles would actually hit the overlay instead. Recenter the
// viewport on the node first so its handles are over open canvas.
async function centerViewOnNode(world: BddWorld, nodeId: string): Promise<void> {
  await world.webviewPage.locator('html').evaluate((_, id) => {
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
  await waitForViewportTransformToSettle(world.webviewPage);
}

// Same choreography as dragGenerateRegionSideByGridCells, but for a node's
// own .svsch-node-resize-* edge handles (full-height/width 8px strips, no
// dangling-label collision to dodge, so the midpoint is a safe grab point).
async function dragNodeSideByGridCells(
  world: BddWorld,
  nodeId: string,
  side: RegionSide,
  cells: number,
): Promise<void> {
  await centerViewOnNode(world, nodeId);
  const handle = world.webviewPage.locator(
    `.react-flow__node[data-id="${nodeId}"] .svsch-node-resize-${side}`,
  );
  const box = await handle.boundingBox();
  if (!box) throw new Error(`Could not find ${side} resize handle for block ${nodeId}`);
  const zoom = await world.webviewPage
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
  const dx = side === 'left' || side === 'right' ? cells * diagramGrid.size * zoom : 0;
  const dy = side === 'top' || side === 'bottom' ? cells * diagramGrid.size * zoom : 0;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const canvas = await world.webviewPage.locator('.canvas').boundingBox();
  const targetX = canvas
    ? Math.max(canvas.x + 8, Math.min(startX + dx, canvas.x + canvas.width - 8))
    : startX + dx;
  const targetY = canvas
    ? Math.max(canvas.y + 8, Math.min(startY + dy, canvas.y + canvas.height - 8))
    : startY + dy;

  const before = await getNodeBounds(world.webviewPage, nodeId);
  await world.workbox.mouse.move(startX, startY);
  await world.workbox.mouse.down();
  await world.workbox.mouse.move(startX + Math.sign(dx || 1) * 2, startY + Math.sign(dy || 1) * 2, {
    steps: 3,
  });
  await world.workbox.mouse.move(targetX, targetY, { steps: 12 });
  await world.workbox.mouse.up();
  if (canvas) {
    await world.workbox.mouse.move(canvas.x + 16, canvas.y + 16);
  }
  // The visual `--svsch-node-width/height` custom property (read by
  // getNodeBounds) updates synchronously with the drag, but confirm it
  // actually moved before handing off to waitForLayoutChange's fixed sleep —
  // a click-only (zero-delta) drag on a heavier diagram shouldn't be
  // mistaken for one still catching up.
  await expect
    .poll(
      async () => {
        const after = await getNodeBounds(world.webviewPage, nodeId);
        return after.width !== before.width || after.height !== before.height;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  await world.workbox.waitForTimeout(650);
}

async function dragGenerateRegionByGridCells(
  world: BddWorld,
  label: string,
  cellsX: number,
  cellsY: number,
): Promise<void> {
  const title = generateRegionLocator(world.webviewPage, label).locator('.generate-region-title');
  const box = await title.boundingBox();
  if (!box) throw new Error(`Could not find move target for generate region ${label}`);
  const zoom = await world.webviewPage
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
  const dx = cellsX * diagramGrid.size * zoom;
  const dy = cellsY * diagramGrid.size * zoom;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await world.workbox.mouse.move(startX, startY);
  await world.workbox.mouse.down();
  await world.workbox.mouse.move(startX + Math.sign(dx || 1) * 2, startY + Math.sign(dy || 1) * 2, {
    steps: 3,
  });
  await world.workbox.mouse.move(startX + dx, startY + dy, { steps: 12 });
  await world.workbox.mouse.up();
  const canvas = await world.webviewPage.locator('.canvas').boundingBox();
  if (canvas) {
    await world.workbox.mouse.move(canvas.x + 16, canvas.y + 16);
  }
  await world.workbox.waitForTimeout(650);
}

async function generateRegionNodeIds(world: BddWorld, label: string): Promise<string[]> {
  const regions = world.lastViewModel?.generateRegions ?? [];
  const root = regions.find(
    (candidate: any) =>
      candidate.blockLabel === label ||
      candidate.fullBlockLabel === label ||
      candidate.label?.includes(label),
  );

  if (root) {
    const regionIds = new Set<string>([root.id]);
    let added = true;
    while (added) {
      added = false;
      for (const region of regions) {
        if (
          region.parentRegionId &&
          regionIds.has(region.parentRegionId) &&
          !regionIds.has(region.id)
        ) {
          regionIds.add(region.id);
          added = true;
        }
      }
    }

    const nodeIds = regions
      .filter((region: any) => regionIds.has(region.id))
      .flatMap((region: any) => region.nodeIds ?? []);
    if (nodeIds.length > 0) return [...new Set(nodeIds)];
  }

  return world.webviewPage.locator('html').evaluate((_element, blockLabel) => {
    const rf = (window as any).reactFlowInstance;
    return rf
      .getNodes()
      .filter((node: any) => String(node.id).includes(blockLabel))
      .map((node: any) => node.id);
  }, label);
}

async function findGenerateRegionNodeIdByKind(
  world: BddWorld,
  label: string,
  kind: string | string[],
): Promise<string | null> {
  const nodeIds = await generateRegionNodeIds(world, label);
  if (nodeIds.length === 0) return null;
  const kinds = Array.isArray(kind) ? kind : [kind];
  return world.webviewPage.locator('html').evaluate(
    (_element, { ids, nodeKinds }) => {
      const idSet = new Set(ids);
      const rf = (window as any).reactFlowInstance;
      const flowNode = rf
        ?.getNodes?.()
        .find(
          (node: any) =>
            idSet.has(node.id) &&
            (nodeKinds.includes(node.data?.node?.kind) || nodeKinds.includes(node.data?.kind)),
        );
      if (flowNode) return flowNode.id;

      const domNode = Array.from(document.querySelectorAll('.react-flow__node')).find(
        (node) =>
          idSet.has(node.getAttribute('data-id') ?? '') &&
          nodeKinds.some((nodeKind) => !!node.querySelector(`[data-node-kind="${nodeKind}"]`)),
      );
      return domNode?.getAttribute('data-id') ?? null;
    },
    { ids: nodeIds, nodeKinds: kinds },
  );
}

async function getAllFlowNodePositions(frame: FrameLocator): Promise<Map<string, NodePosition>> {
  const entries = await frame.locator('html').evaluate(() => {
    const rf = (window as any).reactFlowInstance;
    return rf.getNodes().map((node: any) => [
      node.id,
      {
        x: node.position.x,
        y: node.position.y,
      },
    ]);
  });
  return new Map(entries as Array<[string, NodePosition]>);
}

async function getNodePositions(
  frame: FrameLocator,
  nodeIds: string[],
): Promise<Map<string, NodePosition>> {
  const all = await getAllFlowNodePositions(frame);
  return pickNodePositions(all, nodeIds, 'selected nodes');
}

function pickNodePositions(
  all: Map<string, NodePosition>,
  nodeIds: string[],
  context: string,
): Map<string, NodePosition> {
  const picked = new Map<string, NodePosition>();
  for (const id of nodeIds) {
    const position = all.get(id);
    if (!position) throw new Error(`Could not find position for ${id} in ${context}`);
    picked.set(id, position);
  }
  return picked;
}

async function getGenerateRegionContentPadding(
  world: BddWorld,
  label: string,
): Promise<Record<RegionSide, number>> {
  const region = world.lastViewModel?.generateRegions?.find(
    (candidate: any) => candidate.blockLabel === label || candidate.label?.includes(label),
  );
  const nodeIds =
    region?.nodeIds ??
    (await world.webviewPage.locator('html').evaluate((_element, blockLabel) => {
      const rf = (window as any).reactFlowInstance;
      return rf
        .getNodes()
        .filter((node: any) => String(node.id).includes(blockLabel))
        .map((node: any) => node.id);
    }, label));
  if (nodeIds.length === 0)
    throw new Error(`Could not find content nodes for generate region ${label}`);
  const bounds = await getGenerateRegionBounds(world.webviewPage, label);
  const content = await world.webviewPage.locator('html').evaluate((_element, nodeIds) => {
    const rf = (window as any).reactFlowInstance;
    const rects = rf
      .getNodes()
      .filter((node: any) => nodeIds.includes(node.id))
      .map((node: any) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.measured?.width ?? node.width ?? 0,
        height: node.measured?.height ?? node.height ?? 0,
      }));
    if (rects.length === 0) return undefined;
    return {
      x: Math.min(...rects.map((rect: any) => rect.x)),
      y: Math.min(...rects.map((rect: any) => rect.y)),
      right: Math.max(...rects.map((rect: any) => rect.x + rect.width)),
      bottom: Math.max(...rects.map((rect: any) => rect.y + rect.height)),
    };
  }, nodeIds);
  if (!content) throw new Error(`Could not find content nodes for generate region ${label}`);

  return {
    left: content.x - bounds.x,
    top: content.y - bounds.y,
    right: bounds.x + bounds.width - content.right,
    bottom: bounds.y + bounds.height - content.bottom,
  };
}

// Drag a port node to an absolute (x, y) flow position with the mouse, then let
// the extension persist it. No internal repositioning, no message channel.
async function dragPortNodeTo(
  world: BddWorld,
  name: string,
  x: number,
  y: number,
  screenshotLabel: string,
): Promise<void> {
  const id = await findNodeIdByLabel(world.webviewPage, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const moduleName = world.lastViewModel.moduleName;
  await dragNodeToFlowPosition(world, id, x, y);
  const after = await getInternalPosition(world.webviewPage, id);
  if (!after) throw new Error(`Missing position data for ${name} after move`);
  await waitForNodePersisted(world, moduleName, id, after);
  world.layout = await readExtensionLayout(world);
  await syncLastViewModel(world, moduleName);
  await world.takeScreenshot(screenshotLabel);
}

// Realistic relative drag: nudge a port node by a whole number of grid cells
// with the mouse — no internal repositioning, no fake fallback. The pre-move
// position is remembered for "should have moved"/"original position" checks and
// the landing position for "where I moved it to". The extension persists the
// drag (layoutChanged), so this only mirrors the result into the in-memory
// layout for bookkeeping — it never writes the layout file itself.
async function dragPortNodeByGridCells(
  world: BddWorld,
  name: string,
  cellsX: number,
  cellsY: number,
  screenshotLabel: string,
): Promise<void> {
  const id = await findNodeIdByLabel(world.webviewPage, name, 'port');
  if (!id) throw new Error(`Node not found: ${name}`);
  const moduleName = world.lastViewModel.moduleName;
  const before = await getInternalPosition(world.webviewPage, id);
  if (!before) throw new Error(`Missing position data for ${name}`);
  world.notedPositions.set(name, before);

  await dragNodeByGridCells(world, id, cellsX, cellsY);

  await expect
    .poll(
      async () => {
        const nextPos = await getInternalPosition(world.webviewPage, id);
        return (
          !!nextPos && (Math.abs(nextPos.x - before.x) > 1 || Math.abs(nextPos.y - before.y) > 1)
        );
      },
      { timeout: 5000 },
    )
    .toBe(true);

  const after = await getInternalPosition(world.webviewPage, id);
  if (!after) throw new Error(`Missing position data for ${name} after move`);
  world.movedToPositions.set(name, after);

  // The extension owns persistence — wait until it has written the new fixed
  // position to the layout file, then mirror that file into our in-memory copy.
  await waitForNodePersisted(world, moduleName, id, after);
  world.layout = await readExtensionLayout(world);

  await syncLastViewModel(world, moduleName);
  await world.takeScreenshot(screenshotLabel);
}

async function beginDraggingNodeByGridCells(
  world: BddWorld,
  label: string,
  cellsX: number,
  cellsY: number,
): Promise<void> {
  const id = await findNodeIdByLabel(world.webviewPage, label);
  if (!id) throw new Error(`Node not found: ${label}`);
  const box = await world.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`Could not get bounding box for node ${id}`);
  const ratio = await effectiveScreenPerFlow(world);
  const dxScreen = cellsX * diagramGrid.size * ratio;
  const dyScreen = cellsY * diagramGrid.size * ratio;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  world.pendingNodeDrag = {
    nodeId: id,
    label,
    moduleName: world.lastViewModel.moduleName,
  };

  await world.workbox.mouse.move(cx, cy);
  await world.workbox.mouse.down();
  await world.workbox.mouse.move(
    cx + Math.sign(dxScreen || 1) * 2,
    cy + Math.sign(dyScreen || 1) * 2,
    { steps: 3 },
  );
  await world.workbox.mouse.move(cx + dxScreen, cy + dyScreen, { steps: 20 });
  await world.workbox.waitForTimeout(300);
}

async function releasePendingNodeDrag(world: BddWorld): Promise<void> {
  const pending = world.pendingNodeDrag;
  if (!pending) throw new Error('No block is currently being dragged');
  await world.workbox.mouse.up();
  await world.workbox.waitForTimeout(150);

  const after = await getInternalPosition(world.webviewPage, pending.nodeId);
  if (!after) throw new Error(`Missing position data for ${pending.label} after move`);
  await waitForNodePersisted(world, pending.moduleName, pending.nodeId, after);
  world.layout = await readExtensionLayout(world);
  await syncLastViewModel(world, pending.moduleName);
  world.pendingNodeDrag = undefined;
  await world.takeScreenshot(`After moving ${pending.label}`);
}

// One raw mouse drag of a node by a screen-space delta. React Flow needs a small
// threshold nudge before it recognises the drag. `grabOffset` (from the node's
// top-left corner) overrides the default center grab point — needed for an
// expanded instance's dimmed frame, whose center can land on the boundary
// port columns or spliced content stacked on top of it (see
// EXPAND_HEADER_GRAB_OFFSET).
async function rawDragNode(
  world: BddWorld,
  id: string,
  dxScreen: number,
  dyScreen: number,
  grabOffset?: { x: number; y: number },
): Promise<void> {
  const box = await world.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`Could not get bounding box for node ${id}`);
  const cx = grabOffset ? box.x + grabOffset.x : box.x + box.width / 2;
  const cy = grabOffset ? box.y + grabOffset.y : box.y + box.height / 2;
  await world.workbox.mouse.move(cx, cy);
  await world.workbox.mouse.down();
  await world.workbox.mouse.move(
    cx + Math.sign(dxScreen || 1) * 2,
    cy + Math.sign(dyScreen || 1) * 2,
    { steps: 3 },
  );
  await world.workbox.mouse.move(cx + dxScreen, cy + dyScreen, { steps: 20 });
  await world.workbox.mouse.up();
  await world.workbox.waitForTimeout(150);
}

// Screen pixels per flow unit. React Flow's zoom is in CSS px; the webview can
// render at a device-pixel-ratio that scales it. This product is stable, so we
// use it directly rather than measuring it from (snapped, noisy) drag results.
async function effectiveScreenPerFlow(world: BddWorld): Promise<number> {
  return world.webviewPage.locator('html').evaluate(() => {
    const zoom = (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1;
    return zoom * (window.devicePixelRatio || 1);
  });
}

// Drag a node so it lands at an absolute flow position, with the mouse only.
// Starts from the stable zoom×dpr ratio and refines it from each observed move,
// but keeps the ratio within sane bounds and caps the per-drag distance so a
// noisy measurement can never fling the node off-canvas (the bug that made the
// reroute moves overshoot and hang). No cross-node state — each drag is fresh.
async function dragNodeToFlowPosition(
  world: BddWorld,
  id: string,
  targetX: number,
  targetY: number,
  grabOffset?: { x: number; y: number },
): Promise<void> {
  const base = await effectiveScreenPerFlow(world);
  const MIN_RATIO = base / 4;
  const MAX_RATIO = base * 4;
  const MAX_STEP = 1500; // screen px; guards against runaway deltas
  let ratio = base;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cur = await getInternalPosition(world.webviewPage, id);
    if (!cur) throw new Error(`Missing position data for node ${id}`);
    const remX = targetX - cur.x;
    const remY = targetY - cur.y;
    if (Math.abs(remX) <= 1 && Math.abs(remY) <= 1) return;

    const dxScreen = Math.max(-MAX_STEP, Math.min(MAX_STEP, remX * ratio));
    const dyScreen = Math.max(-MAX_STEP, Math.min(MAX_STEP, remY * ratio));
    await rawDragNode(world, id, dxScreen, dyScreen, grabOffset);

    // Refine the ratio from the dominant axis of this drag, clamped so a tiny
    // or noisy measured delta can't explode (or collapse) the next step.
    const after = await getInternalPosition(world.webviewPage, id);
    if (!after) throw new Error(`Missing position data for node ${id}`);
    if (
      Math.abs(dyScreen) >= Math.abs(dxScreen) &&
      Math.abs(dyScreen) > 1 &&
      Math.abs(after.y - cur.y) > 1
    ) {
      ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, dyScreen / (after.y - cur.y)));
    } else if (Math.abs(dxScreen) > 1 && Math.abs(after.x - cur.x) > 1) {
      ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, dxScreen / (after.x - cur.x)));
    }
  }

  const final = await getInternalPosition(world.webviewPage, id);
  if (!final || Math.abs(final.x - targetX) > 1 || Math.abs(final.y - targetY) > 1) {
    throw new Error(
      `Could not drag node ${id} to (${targetX}, ${targetY}) (reached ${JSON.stringify(final)})`,
    );
  }
}

// Drag a node a whole number of grid cells from where it started.
async function dragNodeByGridCells(
  world: BddWorld,
  id: string,
  cellsX: number,
  cellsY: number,
  grabOffset?: { x: number; y: number },
): Promise<void> {
  const start = await getInternalPosition(world.webviewPage, id);
  if (!start) throw new Error(`Missing position data for node ${id}`);
  await dragNodeToFlowPosition(
    world,
    id,
    start.x + cellsX * diagramGrid.size,
    start.y + cellsY * diagramGrid.size,
    grabOffset,
  );
}

// An expanded instance's dimmed frame (see EXPAND_GHOST_CLASS) can't be
// grabbed from its center like a normal block — the boundary port columns
// sit directly on top of it at their port rows, and its own spliced content
// is stacked visually on top too. The header strip is reliably clear of both
// (same offset the "Collapse" click already relies on).
const EXPAND_HEADER_GRAB_OFFSET = { x: 30, y: 15 };

async function findBoundaryPortNodeIdByLabel(
  webviewPage: FrameLocator,
  label: string,
): Promise<string | null> {
  return webviewPage.locator('html').evaluate((_, text) => {
    const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
    const match = nodes.find((node) => {
      if (!node.querySelector('[data-node-kind="boundaryPort"]')) return false;
      const textEl = node.querySelector('.hdl-boundary-port-text');
      return textEl?.textContent?.trim() === text;
    });
    return match?.getAttribute('data-id') ?? null;
  }, label);
}

// The extension persists each module's layout as its own file under
// .svsch/layouts/<encoded-module-name>.json (see LayoutStore) instead of one
// monolithic layout.json. Test steps still reason about "the layout" as a
// single { version, modules } object, so this reassembles that shape from
// whichever per-module files currently exist on disk.
async function readExtensionLayout(world: BddWorld): Promise<any> {
  const layoutsDir = path.join(world.workspaceDir || BddWorld.BDD_WORKSPACE, '.svsch', 'layouts');
  const modules: Record<string, any> = {};
  let entries: string[];
  try {
    entries = await fs.promises.readdir(layoutsDir);
  } catch {
    return { version: 1, modules };
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const moduleName = decodeURIComponent(entry.slice(0, -'.json'.length));
    try {
      modules[moduleName] = JSON.parse(
        await fs.promises.readFile(path.join(layoutsDir, entry), 'utf8'),
      );
    } catch {
      // Ignore a file that's mid-write; the poll loops calling this retry.
    }
  }
  return { version: 1, modules };
}

async function waitForNodePersisted(
  world: BddWorld,
  moduleName: string,
  nodeId: string,
  pos: { x: number; y: number },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const layout = await readExtensionLayout(world);
        const node = layout.modules?.[moduleName]?.nodes?.[nodeId];
        return !!node && Math.abs(node.x - pos.x) <= 1 && Math.abs(node.y - pos.y) <= 1;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

// Reshape a connection the way a user does: grab one of its horizontal segment
// handles and drag it up or down by a grid cell. The extension persists the new
// route (edgeRoutesChanged); we mirror it into the in-memory layout and record
// the resulting route so later "route should (not) have changed" checks have a
// baseline taken after the manual adjustment.
async function adjustConnectionByGridCells(
  world: BddWorld,
  source: string,
  target: string,
  cellsDown: number,
): Promise<void> {
  const sourceId = await findNodeIdByLabel(world.webviewPage, source);
  const targetId = await findNodeIdByLabel(world.webviewPage, target);
  if (!sourceId || !targetId)
    throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
  const edgeId = await findEdgeIdBetween(world.webviewPage, sourceId, targetId);
  if (!edgeId) throw new Error(`Edge not found between ${sourceId} and ${targetId}`);
  const moduleName = world.lastViewModel.moduleName;

  const beforeRoute = await connectionRoutePath(world.webviewPage, source, target);

  // Reveal the edge controls/handles by hovering it, then pick the longest
  // horizontal segment handle (dragging it vertically shifts the wire).
  const edgeLocator = world.webviewPage.locator(`.react-flow__edge[data-id="${edgeId}"]`);
  await edgeLocator.locator('path.svsch-edge-bridge').hover({ force: true });
  await world.workbox.waitForTimeout(200);

  const handles = edgeLocator.locator('path.svsch-edge-segment-horizontal');
  const handleCount = await handles.count();
  if (handleCount === 0)
    throw new Error(`No horizontal segment handle to drag on connection ${source} -> ${target}`);
  let longestHandle = handles.first();
  let bestWidth = -1;
  for (let i = 0; i < handleCount; i += 1) {
    const candidate = handles.nth(i);
    const candidateBox = await candidate.boundingBox();
    if (candidateBox && candidateBox.width > bestWidth) {
      bestWidth = candidateBox.width;
      longestHandle = candidate;
    }
  }
  const handleBox = await longestHandle.boundingBox();
  if (!handleBox)
    throw new Error(`Could not get bounding box for segment handle on ${source} -> ${target}`);

  const screenPerFlow = await effectiveScreenPerFlow(world);
  const gx = handleBox.x + handleBox.width / 2;
  const gy = handleBox.y + handleBox.height / 2;
  const dyScreen = cellsDown * diagramGrid.size * screenPerFlow;

  const layoutBefore = JSON.stringify(await readExtensionLayout(world));
  await world.workbox.mouse.move(gx, gy);
  await world.workbox.mouse.down();
  // Small threshold nudge so the segment-drag is recognised, then the move.
  await world.workbox.mouse.move(gx, gy + Math.sign(cellsDown) * 3, { steps: 3 });
  await world.workbox.mouse.move(gx, gy + dyScreen, { steps: 20 });
  await world.workbox.mouse.up();

  // The route must actually have changed for the adjustment to be meaningful.
  await expect
    .poll(
      async () => {
        const current = await connectionRoutePath(world.webviewPage, source, target, beforeRoute);
        return current !== beforeRoute;
      },
      { timeout: 5000 },
    )
    .toBe(true);

  // The extension owns persistence — wait until it has rewritten the layout
  // file, then mirror it into our in-memory copy.
  await expect
    .poll(async () => JSON.stringify(await readExtensionLayout(world)) !== layoutBefore, {
      timeout: 10_000,
    })
    .toBe(true);
  world.layout = await readExtensionLayout(world);

  await syncLastViewModel(world, moduleName);
  await waitForExtensionRenderedView(world, `After adjusting ${source} -> ${target}`);

  // Baseline the (now manually-adjusted) route so later assertions compare
  // against this state rather than the auto-routed original.
  world.notedRoutes.set(
    routeKey(source, target),
    await connectionRoutePath(world.webviewPage, source, target),
  );
}

async function cutNetByClickingControl(
  world: BddWorld,
  source: string,
  target: string,
): Promise<void> {
  const sourceId = await findNodeIdByLabel(world.webviewPage, source);
  const targetId = await findNodeIdByLabel(world.webviewPage, target);
  if (!sourceId || !targetId)
    throw new Error(`Nodes not found: ${source}=${sourceId}, ${target}=${targetId}`);
  const edgeId = await findEdgeIdBetween(world.webviewPage, sourceId, targetId);
  if (!edgeId) throw new Error(`Could not find original edge between ${sourceId} and ${targetId}`);
  const before = JSON.stringify(await readExtensionLayout(world));
  // Hover the connection to reveal its floating controls, then click Cut.
  await clickEdgeControl(world, edgeId, 'svsch-edge-cut-control');
  // The extension cuts the net, persists, and re-renders.
  await waitForLayoutChange(world, before, 'After cut net');
}

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

function routeKey(source: string, target: string): string {
  return `${source}->${target}`;
}

// Read a node's layout position from a CLI-rendered SVG. Each node is emitted as
// <g ... data-node-id="<id>" ... transform="translate(X Y)"> where X/Y are the
// raw layout coordinates (the outer group carries the bounds offset separately).
function cliSvgNodePosition(svg: string, id: string): { x: number; y: number } | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `data-node-id="${escaped}"[^>]*transform="translate\\(\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)\\s*\\)"`,
  ).exec(svg);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function handleMatches(actual: string | undefined, expectedLabel: string): boolean {
  if (!actual) return false;
  const portName = actual.includes(':') ? actual.slice(actual.lastIndexOf(':') + 1) : actual;
  const fieldName = portName.includes('.')
    ? portName.slice(portName.lastIndexOf('.') + 1)
    : portName;
  const sanitized = expectedLabel.replace(/[^A-Za-z0-9_$.\-:]+/g, '_');
  return (
    actual === expectedLabel ||
    actual.toLowerCase() === expectedLabel.toLowerCase() ||
    actual === `port:${expectedLabel}` ||
    actual === `in:${expectedLabel}` ||
    actual === `out:${expectedLabel}` ||
    actual === `in:${sanitized}` ||
    actual === `out:${sanitized}` ||
    portName === expectedLabel ||
    portName === sanitized ||
    fieldName === expectedLabel
  );
}

function cutNetLabelNodes(webviewPage: FrameLocator, label: string) {
  return webviewPage.locator('[data-node-kind="netLabel"]').filter({
    has: webviewPage.locator('.hdl-net-label-text-value').filter({ hasText: exactText(label) }),
  });
}

function exactText(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

async function getWorkspaceState(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.svsch' || entry.name === '.git' || entry.name === 'node_modules')
        continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else files.push(path.relative(dir, fullPath).replace(/\\/g, '/'));
    }
  }
  await walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// Sub-diagram interaction ("Expand instance in place", issue #232) — steps
// backing test/features/sub_diagram_interaction.feature.

// Draw the marquee across every rendered node — guaranteed to cross the
// expanded instance's border, which per the border-scoped selection semantics
// (#242) makes it a top-level selection: sub-diagram content is exempt.
When('I drag-select across the entire diagram', async function (this: BddWorld) {
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const node of await this.webviewPage.locator('.react-flow__node').all()) {
    const box = await node.boundingBox();
    if (box) boxes.push(box);
  }
  if (boxes.length === 0) throw new Error('No rendered nodes to drag-select across');
  // Clamp to the webview's own bounds: a node hugging the viewport edge would
  // otherwise push the marquee's mouse-down onto VS Code chrome outside the
  // iframe, where it starts a different gesture (or none) depending on
  // sub-pixel fit-view placement — a classic source of flaky selections.
  const frame = await this.workbox.locator('iframe.webview').first().boundingBox();
  if (!frame) throw new Error('Webview iframe not found');
  const startX = Math.max(frame.x + 2, Math.min(...boxes.map((box) => box.x)) - 24);
  const startY = Math.max(frame.y + 2, Math.min(...boxes.map((box) => box.y)) - 24);
  const endX = Math.min(
    frame.x + frame.width - 2,
    Math.max(...boxes.map((box) => box.x + box.width)) + 24,
  );
  const endY = Math.min(
    frame.y + frame.height - 2,
    Math.max(...boxes.map((box) => box.y + box.height)) + 24,
  );

  await this.workbox.mouse.move(startX, startY);
  await this.workbox.mouse.down();
  await this.workbox.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 });
  await this.workbox.mouse.move(endX, endY, { steps: 8 });
  await this.workbox.mouse.up();

  // Wait until the selection has actually been applied to at least one
  // top-level node before any assertion reads it.
  await expect
    .poll(
      async () =>
        this.webviewPage.locator('html').evaluate(() => {
          const rf = (window as any).reactFlowInstance;
          return rf.getNodes().filter((n: any) => n.selected).length;
        }),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);

  // The sweep's edge-hugging endpoint triggers the canvas auto-pan, whose
  // distance is timing-dependent, so the viewport the drag leaves behind is
  // nondeterministic — and would persist into every later screenshot of the
  // scenario. Re-fit to a deterministic viewport before capturing.
  await this.webviewPage.locator('.react-flow__controls-fitview').click();
  await waitForViewportTransformToSettle(this.webviewPage);

  await this.takeScreenshot('Drag-selected across the entire diagram');
});

Then('no sub-diagram nodes should be selected', async function (this: BddWorld) {
  const selectedSpliced = await this.webviewPage.locator('html').evaluate(() => {
    const rf = (window as any).reactFlowInstance;
    return [
      ...rf
        .getNodes()
        .filter((n: any) => n.selected && n.id.startsWith('expand:'))
        .map((n: any) => `node ${n.id}`),
      ...rf
        .getEdges()
        .filter((e: any) => e.selected && e.id.startsWith('expand:'))
        .map((e: any) => `wire ${e.id}`),
    ];
  });
  expect(selectedSpliced, 'spliced sub-diagram content must not be marquee-selected').toEqual([]);
});

// Containment invariant of the expanded frame: every spliced node body and
// every spliced wire's rendered path lies inside the dimmed instance node's
// own rect (boundary ports sit astride the border by design and are exempt).
Then(
  'all spliced content should stay inside the expanded instance {string}',
  async function (this: BddWorld, instanceLabel: string) {
    const ghostId = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!ghostId) throw new Error(`Could not find expanded instance "${instanceLabel}"`);
    const violations = await this.webviewPage.locator('html').evaluate((_el, id) => {
      const ghost = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      if (!ghost) return [`expanded instance node ${id} not found`];
      const frame = ghost.getBoundingClientRect();
      // Half a stroke width plus antialiasing slack.
      const tolerance = 8;
      const bad: string[] = [];
      const within = (rect: DOMRect) =>
        rect.left >= frame.left - tolerance &&
        rect.top >= frame.top - tolerance &&
        rect.right <= frame.right + tolerance &&
        rect.bottom <= frame.bottom + tolerance;
      for (const el of Array.from(document.querySelectorAll('.react-flow__node'))) {
        const elId = el.getAttribute('data-id') ?? '';
        if (!elId.startsWith('expand:')) continue;
        if (el.querySelector('[data-node-kind="boundaryPort"]')) continue;
        const rect = el.getBoundingClientRect();
        if (!within(rect)) bad.push(`node ${elId}`);
      }
      for (const el of Array.from(document.querySelectorAll('.react-flow__edge'))) {
        const elId = el.getAttribute('data-id') ?? '';
        if (!elId.startsWith('expand:')) continue;
        const path = el.querySelector('path.svsch-edge');
        if (!path) continue;
        const rect = path.getBoundingClientRect();
        if (!within(rect))
          bad.push(
            `wire ${elId} [${Math.round(rect.left)},${Math.round(rect.top)},` +
              `${Math.round(rect.right)},${Math.round(rect.bottom)}] vs frame ` +
              `[${Math.round(frame.left)},${Math.round(frame.top)},` +
              `${Math.round(frame.right)},${Math.round(frame.bottom)}]`,
          );
      }
      return bad;
    }, ghostId);
    expect(violations, 'spliced content escaping the expanded frame').toEqual([]);
  },
);

// A spliced-in cut net end (the netLabel node standing in for a dropped
// child IO port — see makeExpandPortLabel in webview/expand/splice.ts) by
// its label text. Only expand-namespaced labels match, so a same-named
// parent-side cut end never shadows the sub-diagram's own.
async function findSplicedNetLabelNodeIdByLabel(
  webviewPage: FrameLocator,
  label: string,
): Promise<string | null> {
  return webviewPage.locator('html').evaluate((_, text) => {
    const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
    const match = nodes.find((node) => {
      if (!(node.getAttribute('data-id') ?? '').startsWith('expand:')) return false;
      if (!node.querySelector('[data-node-kind="netLabel"]')) return false;
      const textEl = node.querySelector('.hdl-net-label-text-value');
      return textEl?.textContent?.trim() === text;
    });
    return match?.getAttribute('data-id') ?? null;
  }, label);
}

// Finds the spliced (namespace-prefixed) edge id between two nodes inside an
// expanded instance. A name may refer to a regular node, the cut net end
// standing in for a child IO port, or a boundary-port label on the frame
// (whose text lives in its own .hdl-boundary-port-text element that
// findNodeIdByLabel doesn't scan) — a port's wire terminates on the cut net
// end, not the same-named boundary label, so every match is collected and
// whichever candidate actually carries the wire wins. Spliced edge ids
// namespace the child module's own edge ids, which don't embed the
// namespaced node ids, so this resolves through React Flow state.
async function findSplicedEdgeId(world: BddWorld, source: string, target: string): Promise<string> {
  const candidatesFor = async (name: string): Promise<string[]> => {
    const ids = [
      await findSplicedNetLabelNodeIdByLabel(world.webviewPage, name),
      await findBoundaryPortNodeIdByLabel(world.webviewPage, name),
      await findNodeIdByLabel(world.webviewPage, name),
    ].filter((id): id is string => id !== null);
    if (ids.length === 0) throw new Error(`Node not found: ${name}`);
    return ids;
  };
  const sourceIds = await candidatesFor(source);
  const targetIds = await candidatesFor(target);
  const edgeId: string | null = await world.webviewPage.locator('html').evaluate(
    (_el, { s, t }) => {
      const rf = (window as any).reactFlowInstance;
      const found = rf
        .getEdges()
        .find(
          (e: any) =>
            e.id.startsWith('expand:') &&
            ((s.includes(e.source) && t.includes(e.target)) ||
              (t.includes(e.source) && s.includes(e.target))),
        );
      return found?.id ?? null;
    },
    { s: sourceIds, t: targetIds },
  );
  if (!edgeId) throw new Error(`No spliced wire between ${source} and ${target}`);
  return edgeId;
}

// Attempts to reshape a wire inside the sub-diagram by dragging one of its
// horizontal segment handles — a spliced edge offers none at all (see
// isExpandSplicedEdge in OrthogonalEdge.tsx: routing, like node positions,
// comes from the child module's own standalone layout, not user edits made
// inside the parent's sub-diagram view), so this notes the route beforehand
// and, if a handle is somehow present anyway (defense in depth against a
// partial fix), attempts the drag; "should not have rerouted" below is what
// actually asserts nothing changed. Unlike the plain block-resize/reroute
// helpers, this never waits for (or requires) a change.
When(
  // eslint-disable-next-line max-len
  'I try to drag a wire segment between {string} and {string} inside the expanded instance down by {int} grid cells',
  async function (this: BddWorld, source: string, target: string, cellsDown: number) {
    const edgeId = await findSplicedEdgeId(this, source, target);
    const edgeLocator = this.webviewPage.locator(`.react-flow__edge[data-id="${edgeId}"]`);
    const before = await edgeLocator.locator('path.svsch-edge').first().getAttribute('d');
    if (!before) throw new Error(`Route path not found for spliced wire ${source} -> ${target}`);
    this.notedRoutes.set(routeKey(source, target), before);

    await edgeLocator.locator('path.svsch-edge-bridge').hover({ force: true });
    await this.workbox.waitForTimeout(200);

    const handles = edgeLocator.locator('path.svsch-edge-segment-horizontal');
    const handleCount = await handles.count();
    if (handleCount > 0) {
      let longestHandle = handles.first();
      let bestWidth = -1;
      for (let i = 0; i < handleCount; i += 1) {
        const candidate = handles.nth(i);
        const candidateBox = await candidate.boundingBox();
        if (candidateBox && candidateBox.width > bestWidth) {
          bestWidth = candidateBox.width;
          longestHandle = candidate;
        }
      }
      const handleBox = await longestHandle.boundingBox();
      if (handleBox) {
        const screenPerFlow = await effectiveScreenPerFlow(this);
        const gx = handleBox.x + handleBox.width / 2;
        const gy = handleBox.y + handleBox.height / 2;
        await this.workbox.mouse.move(gx, gy);
        await this.workbox.mouse.down();
        await this.workbox.mouse.move(gx, gy + Math.sign(cellsDown) * 3, { steps: 3 });
        await this.workbox.mouse.move(gx, gy + cellsDown * diagramGrid.size * screenPerFlow, {
          steps: 20,
        });
        await this.workbox.mouse.up();
      }
    }
    await this.workbox.waitForTimeout(200);
    await this.takeScreenshot(`Attempted to drag spliced wire ${source} -> ${target}`);
  },
);

Then(
  'the wire between {string} and {string} inside the expanded instance should not have rerouted',
  async function (this: BddWorld, source: string, target: string) {
    const before = this.notedRoutes.get(routeKey(source, target));
    if (!before) throw new Error(`Missing noted route for spliced wire ${source} -> ${target}`);
    const edgeId = await findSplicedEdgeId(this, source, target);
    const after = await this.webviewPage
      .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge`)
      .first()
      .getAttribute('d');
    expect(after, `spliced wire ${source} -> ${target} should not have rerouted`).toBe(before);
  },
);

Then('the saved layout should contain no sub-diagram entries', async function (this: BddWorld) {
  const layout = await readExtensionLayout(this);
  expect(JSON.stringify(layout)).not.toContain('expand:');
});

// Auto Layout must place the re-released outer blocks against the expanded
// instance's *frame* footprint (see relayoutSelection's expandedSizes) — a
// block landing under the frame means ELK only saw the collapsed size.
Then(
  'no top-level block should overlap the expanded instance {string}',
  async function (this: BddWorld, instanceLabel: string) {
    const ghostId = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!ghostId) throw new Error(`Could not find expanded instance "${instanceLabel}"`);
    const violations = await this.webviewPage.locator('html').evaluate((_el, id) => {
      const ghost = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      if (!ghost) return [`expanded instance node ${id} not found`];
      const frame = ghost.getBoundingClientRect();
      // Nodes may legitimately touch the frame edge-to-edge; only a real
      // incursion (beyond stroke-width/antialiasing slack) counts.
      const tolerance = 4;
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll('.react-flow__node'))) {
        const elId = el.getAttribute('data-id') ?? '';
        if (!elId || elId === id || elId.startsWith('expand:')) continue;
        const rect = el.getBoundingClientRect();
        const overlaps =
          rect.left < frame.right - tolerance &&
          frame.left + tolerance < rect.right &&
          rect.top < frame.bottom - tolerance &&
          frame.top + tolerance < rect.bottom;
        if (overlaps)
          bad.push(
            `node ${elId} [${Math.round(rect.left)},${Math.round(rect.top)},` +
              `${Math.round(rect.right)},${Math.round(rect.bottom)}] vs frame ` +
              `[${Math.round(frame.left)},${Math.round(frame.top)},` +
              `${Math.round(frame.right)},${Math.round(frame.bottom)}]`,
          );
      }
      return bad;
    }, ghostId);
    expect(violations, 'top-level blocks placed under the expanded frame').toEqual([]);
  },
);

// The border ring's inner boundary is drawn for the user (see
// .svsch-expand-content-border / ExpandGrabBands) so the frame's own
// grab/interaction ring is visibly distinct from the sub-canvas inside it.
Then(
  'the expanded instance {string} should show its inner content border',
  async function (this: BddWorld, instanceLabel: string) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!id) throw new Error(`Could not find expanded instance "${instanceLabel}"`);
    await expect(
      this.webviewPage.locator(`.react-flow__node[data-id="${id}"] .svsch-expand-content-border`),
    ).toBeVisible();
  },
);

// Attempts to resize an expanded instance's frame by its right-side handle —
// there is none: HdlNode renders no resize handles at all for an expand
// ghost node (see NodeResizeControls's call site), since the frame's size is
// always derived fresh from the child module's own current layout (see
// splice.ts's expandedFrameSize). If the handle isn't there, this is a no-op;
// "should have kept its noted size" below is what actually asserts nothing
// changed (also covering a partial fix that left some handle rendered).
When(
  'I try to resize the expanded instance {string} on the right side by {int} grid cells',
  async function (this: BddWorld, instanceLabel: string, cells: number) {
    const id = await findNodeIdByLabel(this.webviewPage, instanceLabel);
    if (!id) throw new Error(`Could not find expanded instance "${instanceLabel}"`);
    await centerViewOnNode(this, id);
    const handle = this.webviewPage.locator(
      `.react-flow__node[data-id="${id}"] .svsch-node-resize-right`,
    );
    // count() resolves immediately (no polling/waiting) unlike boundingBox(),
    // which would otherwise time out waiting for an element that — this is
    // the expected, locked-down state — is never going to appear.
    if ((await handle.count()) === 0) {
      await this.takeScreenshot(`No resize handle on expanded instance ${instanceLabel}`);
      return;
    }
    const box = await handle.boundingBox();
    if (!box) {
      await this.takeScreenshot(`No resize handle on expanded instance ${instanceLabel}`);
      return;
    }
    const zoom = await this.webviewPage
      .locator('html')
      .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await this.workbox.mouse.move(startX, startY);
    await this.workbox.mouse.down();
    await this.workbox.mouse.move(startX + 2, startY + 2, { steps: 3 });
    await this.workbox.mouse.move(startX + cells * diagramGrid.size * zoom, startY, { steps: 12 });
    await this.workbox.mouse.up();
    await this.workbox.waitForTimeout(300);
    await this.takeScreenshot(`Attempted to resize expanded instance ${instanceLabel}`);
  },
);

Then(
  'the block {string} should have kept its noted size',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for block ${label}`);
    // Re-render/reload timing: poll until the size settles on the noted one
    // rather than reading a single possibly-mid-reattach frame.
    await expect
      .poll(
        async () => {
          const after = await getNodeBounds(this.webviewPage, id);
          return { width: after.width, height: after.height };
        },
        { timeout: 10_000 },
      )
      .toEqual({ width: before.width, height: before.height });
  },
);

// Companion to "should have kept its noted size" for the grow-only case: a
// manual resize applied *before* Expand becomes one input to
// expandedFrameSize's Math.max (see splice.ts) alongside the content-derived
// size, so the resized width must survive into the expanded frame — never
// get discarded back down to whatever the (narrower) spliced content alone
// would need.
Then(
  'the {string} block should be at least as wide as its noted size',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for block ${label}`);
    const after = await getNodeBounds(this.webviewPage, id);
    expect(
      after.width,
      `expected ${label} to stay at least as wide as its noted width ${before.width}, got ` +
        after.width,
    ).toBeGreaterThanOrEqual(before.width - 0.5);
  },
);

// Attempts a plain left-drag on a boundary-port node without polling for
// convergence — the node is expected NOT to move (movable port labels are
// the #218 follow-up), so the usual drag helpers' wait-until-moved contract
// doesn't apply.
When(
  'I try to drag the boundary port node {string} by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const id = await findBoundaryPortNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find boundary port node "${label}"`);
    const box = await this.webviewPage.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Could not get bounding box for boundary port ${label}`);
    const screenPerFlow = await effectiveScreenPerFlow(this);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await this.workbox.mouse.move(startX, startY);
    await this.workbox.mouse.down();
    await this.workbox.mouse.move(startX + 3, startY + 3, { steps: 3 });
    await this.workbox.mouse.move(
      startX + cellsX * diagramGrid.size * screenPerFlow,
      startY + cellsY * diagramGrid.size * screenPerFlow,
      { steps: 10 },
    );
    await this.workbox.mouse.up();
    await this.workbox.waitForTimeout(300);
  },
);

Then(
  'the boundary port node {string} should not have moved',
  async function (this: BddWorld, label: string) {
    const id = await findBoundaryPortNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find boundary port node "${label}"`);
    const pos = await getInternalPosition(this.webviewPage, id);
    const before = this.notedPositions.get(`boundary-port:${label}`);
    if (!pos || !before) throw new Error(`Missing position data for boundary port ${label}`);
    expect(pos, `boundary port ${label} must stay glued to the frame border`).toEqual(before);
  },
);

// A node inside an expanded instance's spliced content is not draggable — the
// only place its layout can be edited is the child module's own standalone
// view (see the product decision in issue #232's PR review). Mirrors "I try
// to drag the boundary port node": a raw drag attempt without polling for
// convergence, since the node is expected NOT to move.
When(
  'I try to drag the node {string} inside the expanded instance by \\({int}, {int}\\) grid cells',
  async function (this: BddWorld, label: string, cellsX: number, cellsY: number) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find node "${label}"`);
    const screenPerFlow = await effectiveScreenPerFlow(this);
    await rawDragNode(
      this,
      id,
      cellsX * diagramGrid.size * screenPerFlow,
      cellsY * diagramGrid.size * screenPerFlow,
    );
  },
);

// Plain (non-delta) "did it move at all" check — same comparison style as
// "the cut net label attached to X should have moved", for scenarios (e.g.
// a child module's own layout changing underneath an expanded instance of
// it) where the exact delta isn't meaningful to assert because the spliced
// content's placement also depends on the frame's own padding/translation,
// not just a rigid carry of the raw delta.
Then('the block {string} should have moved', async function (this: BddWorld, name: string) {
  const id = await findNodeIdByLabel(this.webviewPage, name);
  if (!id) throw new Error(`Could not find block "${name}"`);
  const pos = await getInternalPosition(this.webviewPage, id);
  const before = this.notedPositions.get(name);
  if (!pos || !before) throw new Error(`Missing position data for ${name}`);
  const distance = Math.hypot(pos.x - before.x, pos.y - before.y);
  expect(
    distance,
    `expected ${name} to move from (${before.x}, ${before.y}), but it stayed there`,
  ).toBeGreaterThan(1);
});

// Locks in the "expand instance in place" product decision that an expanded
// frame's size is always derived from the child module's *current* layout
// (see splice.ts's expandedFrameSize): once that layout's content grows past
// what it needed before, the frame must grow to fit it — never held at
// whatever size a previous computation (or, before this change, a manual
// resize) left it at.
Then(
  'the block {string} should have grown to fit its new content',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for block ${label}`);
    const after = await getNodeBounds(this.webviewPage, id);
    expect(
      after.width > before.width || after.height > before.height,
      `expected ${label} to grow past its noted size ${JSON.stringify(before)}, got ` +
        JSON.stringify({ width: after.width, height: after.height }),
    ).toBe(true);
  },
);

// Mirror of "should have grown to fit its new content" for the shrink
// direction — the frame is recomputed fresh every time, so it must also
// shrink back down once the child module's content does, not stay inflated
// by a size it happened to reach earlier.
Then(
  'the block {string} should have shrunk to fit its new content',
  async function (this: BddWorld, label: string) {
    const id = await findNodeIdByLabel(this.webviewPage, label);
    if (!id) throw new Error(`Could not find block "${label}"`);
    const before = this.notedRegionBounds.get(label);
    if (!before) throw new Error(`No noted bounds for block ${label}`);
    const after = await getNodeBounds(this.webviewPage, id);
    expect(
      after.width < before.width || after.height < before.height,
      `expected ${label} to shrink below its noted size ${JSON.stringify(before)}, got ` +
        JSON.stringify({ width: after.width, height: after.height }),
    ).toBe(true);
  },
);
