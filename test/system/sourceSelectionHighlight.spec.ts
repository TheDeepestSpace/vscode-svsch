import { test, expect } from 'vscode-test-playwright';
import type { FrameLocator } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {
  type EvaluateInVSCode,
  clearSystemLayout,
  openSystemDiagram,
  openSystemModule,
  waitForViewportToSettle,
} from './helpers';
import { SNAPSHOT_THRESHOLDS } from '../snapshotPolicy';

interface HighlightExpectation {
  kind: string;
  label?: string;
}

interface HighlightCase {
  id: string;
  module: string;
  file: string;
  select: string | string[];
  exclusive?: boolean;
  expect: HighlightExpectation[];
}

const root = path.resolve(__dirname, '../..');
const { cases } = yaml.load(
  fs.readFileSync(path.join(__dirname, 'selection-highlight.cases.yaml'), 'utf8'),
) as { cases: HighlightCase[] };

// Selection → highlight is pure extension/webview logic with no VS Code API
// surface that varies across the supported builds, so running the sweep on
// every version would only re-prove the same mapping at 3× the suite cost.
// Pin it to the oldest supported build (the compatibility floor) — one set of
// baseline screenshots in version control instead of one per version.
const versions: string[] = JSON.parse(
  fs.readFileSync(path.join(root, 'vscode-versions.json'), 'utf8'),
);
const oldestVersion = versions.slice().sort((a, b) => compareVersions(a, b))[0];
// Default mirrors test/system/playwright.config.ts's vscodeVersion fallback.
const currentVersion = process.env.VSCODE_VERSION || '1.91.0';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

test.skip(
  currentVersion !== oldestVersion,
  `selection-highlight sweep runs only on the oldest supported VS Code (${oldestVersion})`,
);

test('highlights the declared diagram nodes for each selected source construct', async ({
  workbox,
  evaluateInVSCode,
}) => {
  // One VS Code session walks every case (module switches are cheap; a fresh
  // session + Surelog elaboration per case would not be).
  test.setTimeout(600_000);
  await clearSystemLayout();
  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    // Same arrangement as the BDD "I arrange the diagram and the editor side
    // by side" step: two editor groups so the source file opened below never
    // tabs over (and thereby hides) the diagram webview.
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 1,
        groups: [{}, {}],
      });
    });

    for (const highlightCase of cases) {
      await test.step(highlightCase.id, async () => {
        await openSystemModule(workbox, webview, evaluateInVSCode, highlightCase.module);
        // A single case may list several selections (e.g. an ideal one plus
        // non-ideal/partial ones) that must all resolve to the same `expect`
        // — each gets its own screenshot, the first keeping the bare
        // `${id}.png` name so existing baselines stay put.
        const selections = Array.isArray(highlightCase.select)
          ? highlightCase.select
          : [highlightCase.select];
        for (const [index, sourceText] of selections.entries()) {
          await selectSourceText(evaluateInVSCode, highlightCase.file, sourceText);
          await assertHighlightedNodes(webview, highlightCase);
          // Capture the moment the assertion above confirms: source selected
          // on the right, matching diagram node(s) highlighted on the left.
          const screenshotName =
            index === 0 ? `${highlightCase.id}.png` : `${highlightCase.id}--${index}.png`;
          // A few cases show a sub-pixel rendering flake on VS Code 1.90.0
          // that needs a wider tolerance — see the comments next to each
          // entry in SNAPSHOT_THRESHOLDS.playwright.system (PR #376).
          const caseThresholds: Partial<Record<string, number>> = {
            'inverter-not-expression': SNAPSHOT_THRESHOLDS.playwright.system.inverterNotExpression,
            'mux-ternary-assign': SNAPSHOT_THRESHOLDS.playwright.system.muxTernaryAssign,
            'interface-declaration': SNAPSHOT_THRESHOLDS.playwright.system.interfaceDeclaration,
          };
          const maxDiffPixels = caseThresholds[highlightCase.id];
          await expect(workbox).toHaveScreenshot(screenshotName, { maxDiffPixels });
        }
      });
    }
  } finally {
    await clearSystemLayout();
  }
});

test('brings an off-screen highlighted node into view on a large, zoomed-in diagram', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await clearSystemLayout();
  try {
    await openSystemDiagram(workbox, evaluateInVSCode);

    const webview = workbox.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    await webview.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });

    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 1,
        groups: [{}, {}],
      });
    });

    // fixtures/long_register_chain.sv is a 15-stage register chain, laid out
    // left to right — far wider than any reasonable viewport at 100% zoom.
    await openSystemModule(workbox, webview, evaluateInVSCode, 'long_register_chain');

    // Zoom in on the chain's first stage, putting the last stage ("q") well
    // off screen — the state a user zoomed into one part of a large diagram
    // would be in.
    await webview.locator('html').evaluate(() => {
      const rf = (window as any).reactFlowInstance;
      const firstNode = rf
        .getNodes()
        .find(
          (node: any) => node.data?.node?.kind === 'register' && node.data?.node?.label === 's1',
        );
      rf.setViewport(
        { x: 100 - firstNode.position.x, y: 100 - firstNode.position.y, zoom: 1 },
        { duration: 0 },
      );
    });
    await waitForViewportToSettle(webview);

    // Confirm the setup: "q" starts off screen.
    await expect(registerNodeIsOnScreen(webview, 'q')).resolves.toBe(false);

    await selectSourceText(
      evaluateInVSCode,
      'fixtures/long_register_chain.sv',
      'always_ff @(posedge clk) q <= s14;',
    );

    // The register lights up...
    await expect
      .poll(
        () =>
          webview.locator('html').evaluate(() => {
            const rf = (window as any).reactFlowInstance;
            return (rf?.getNodes() ?? []).some(
              (node: any) =>
                node.data?.node?.kind === 'register' &&
                node.data?.node?.label === 'q' &&
                node.selected === true,
            );
          }),
        { timeout: 10_000 },
      )
      .toBe(true);

    // ...and the diagram pans/zooms so it's actually visible, not just
    // selected somewhere off in the distance.
    await waitForViewportToSettle(webview);
    await expect.poll(() => registerNodeIsOnScreen(webview, 'q'), { timeout: 10_000 }).toBe(true);
  } finally {
    await clearSystemLayout();
  }
});

// True if the given register node's DOM element is fully within the
// diagram pane's visible bounds (not just present in the DOM — React Flow
// keeps off-screen nodes mounted, just transformed out of view).
async function registerNodeIsOnScreen(webview: FrameLocator, label: string): Promise<boolean> {
  return webview.locator('html').evaluate((_el, targetLabel) => {
    const rf = (window as any).reactFlowInstance;
    const node = (rf?.getNodes() ?? []).find(
      (n: any) => n.data?.node?.kind === 'register' && n.data?.node?.label === targetLabel,
    );
    if (!node) return false;
    const nodeElement = document.querySelector(`.react-flow__node[data-id="${node.id}"]`);
    const container = document.querySelector('.react-flow');
    if (!nodeElement || !container) return false;
    const nodeRect = nodeElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return (
      nodeRect.left >= containerRect.left &&
      nodeRect.top >= containerRect.top &&
      nodeRect.right <= containerRect.right &&
      nodeRect.bottom <= containerRect.bottom
    );
  }, label);
}

// Mirrors the BDD "I select the source text {string} in {string}" step.
async function selectSourceText(
  evaluateInVSCode: EvaluateInVSCode,
  filename: string,
  sourceText: string,
): Promise<void> {
  await evaluateInVSCode(
    async (vscode, selection: { filename: string; sourceText: string }) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!workspaceRoot) throw new Error('No workspace folder is open');
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(workspaceRoot, selection.filename),
      );
      const offset = document.getText().indexOf(selection.sourceText);
      if (offset < 0) {
        throw new Error(`Source text not found in ${selection.filename}: ${selection.sourceText}`);
      }
      const range = new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + selection.sourceText.length),
      );
      await vscode.window.showTextDocument(document, {
        // The diagram occupies the first (top) group; target the second so
        // the source file doesn't tab over it.
        viewColumn: vscode.ViewColumn.Two,
        selection: range,
      });
    },
    { filename, sourceText },
  );
}

async function assertHighlightedNodes(
  webview: FrameLocator,
  highlightCase: HighlightCase,
): Promise<void> {
  let lastHighlighted: Array<{ kind: string; label: string }> = [];
  await expect
    .poll(
      async () => {
        lastHighlighted = await webview.locator('html').evaluate(() => {
          const rf = (window as any).reactFlowInstance;
          return (rf?.getNodes?.() ?? [])
            .filter((node: any) => node.selected === true)
            .map((node: any) => ({
              kind: node.data?.node?.kind ?? '',
              label: node.data?.node?.label ?? '',
            }));
        });
        return highlightedSetMatches(lastHighlighted, highlightCase);
      },
      {
        timeout: 15_000,
        message:
          `Case ${highlightCase.id}: expected ${JSON.stringify(highlightCase.expect)} ` +
          `(exclusive: ${highlightCase.exclusive !== false}), ` +
          `last highlighted: ${JSON.stringify(lastHighlighted)}`,
      },
    )
    .toBe(true);
}

function highlightedSetMatches(
  highlighted: Array<{ kind: string; label: string }>,
  highlightCase: HighlightCase,
): boolean {
  const unmatched = [...highlighted];
  for (const expected of highlightCase.expect) {
    const index = unmatched.findIndex(
      (node) =>
        node.kind === expected.kind &&
        (expected.label === undefined || node.label === expected.label),
    );
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return highlightCase.exclusive === false || unmatched.length === 0;
}
