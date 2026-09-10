import { test, expect } from '@playwright/test';
import { openView, paddedAllNodesClip, waitForViewportTransformToSettle } from './helper';
import { GRID, collectNodes, buildGridView } from './nodeGridFixtures';

// Same "one node of every diagram kind" grid as elk_geometry.visual.spec.ts,
// but instead of overlaying ELK geometry, selects every node so each one
// renders its own selection outline (node-skin-selection / selection-rect /
// netLabel-selected styling) exactly as it would in the real diagram.

test.describe('selection styles grid', () => {
  test.use({ viewport: { width: 1700, height: 2200 } });

  test('shows the selection outline for every node kind', async ({ page }) => {
    // collectNodes() calls buildFixtureView() once per selection (30+, one
    // per node kind), each re-sampling elaboration BENCHMARK_SAMPLE_COUNT
    // times — same reasoning as interface.visual.spec.ts's multi-fixture
    // test. On a contended CI runner that collection alone has been observed
    // to eat a full 240s budget before the page is even opened, so give it
    // extra headroom.
    test.setTimeout(360_000);

    const collected = await collectNodes();
    const { view, overlay } = buildGridView(collected);

    await openView(page, view);
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.react-flow__node').length >= expected,
      view.nodes.length,
    );

    // Fit the viewport ourselves from the known grid bounds instead of
    // fitView: the webview's own auto-fit races with it and can settle on a
    // clamped zoom that pushes the first grid row off screen (see
    // elk_geometry.visual.spec.ts).
    const margin = GRID * 2;
    const minX = Math.min(...overlay.map((e) => e.placementRect.x)) - margin;
    const minY = Math.min(...overlay.map((e) => e.placementRect.y)) - margin;
    const maxX =
      Math.max(...overlay.map((e) => e.placementRect.x + e.placementRect.width)) + margin;
    const maxY =
      Math.max(...overlay.map((e) => e.placementRect.y + e.placementRect.height)) + margin;
    await page.waitForFunction(() => Boolean((window as any).reactFlowInstance));
    await page.evaluate(
      async (bounds) => {
        // Fit against the pane's own box, not window.innerWidth/Height — a
        // toolbar and a "Module parameters" bar sit above the pane, so the
        // pane is shorter than the full window. Fitting to the window
        // overflows content past the pane's actual (interactive) box, which
        // silently swallows clicks/drags on the rows pushed past its edge.
        const paneRect = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
        const viewport = { width: paneRect.width, height: paneRect.height };
        const zoom = Math.min(
          viewport.width / (bounds.maxX - bounds.minX),
          viewport.height / (bounds.maxY - bounds.minY),
          1,
        );
        await (window as any).reactFlowInstance.setViewport({
          x: (viewport.width - (bounds.maxX - bounds.minX) * zoom) / 2 - bounds.minX * zoom,
          y: (viewport.height - (bounds.maxY - bounds.minY) * zoom) / 2 - bounds.minY * zoom,
          zoom,
        });
      },
      { minX, minY, maxX, maxY },
    );
    await waitForViewportTransformToSettle(page);

    // Ctrl-click every node to build one big multi-selection (React Flow's
    // `multiSelectionKeyCode` defaults to Control on non-Mac, not Shift —
    // Shift instead drives the marquee drag). A single whole-canvas marquee
    // would be simpler, but the grid is taller than `.react-flow__pane`'s own
    // box in this headless harness (content still renders and is visible,
    // just outside the pane's hit region), so a drag ending over the bottom
    // rows never lands on the pane. Ctrl-click sidesteps that entirely.
    const centers = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.react-flow__node')).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }),
    );
    // React Flow's multi-selection key check listens for real keydown/keyup
    // (useKeyPress), not just the click event's ctrlKey flag — hold the key
    // down for the whole loop instead of passing it per-click.
    await page.keyboard.down('Control');
    for (const { x, y } of centers) {
      await page.mouse.click(x, y);
    }

    // A node's exact geometric center can land on a gap between painted
    // sub-elements for wider skins (e.g. struct/interface field taps) where
    // nothing under the cursor is click-selectable. Retry any stragglers
    // against other points inside the same bounding box, checking after each
    // click so we stop as soon as it lands — with the multi-select modifier
    // held, an extra click on an already-selected node toggles it back off.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remaining = await page.evaluate(() => {
        const rf = (window as any).reactFlowInstance;
        const selectedIds = new Set(
          rf
            .getNodes()
            .filter((n: any) => n.selected)
            .map((n: any) => n.id),
        );
        return Array.from(document.querySelectorAll('.react-flow__node'))
          .filter((el) => !selectedIds.has(el.getAttribute('data-id')))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
          });
      });
      if (remaining.length === 0) break;
      const [fx, fy] = [
        [0.25, 0.5],
        [0.75, 0.5],
        [0.5, 0.25],
        [0.5, 0.75],
      ][attempt];
      for (const r of remaining) {
        await page.mouse.click(r.left + r.width * fx, r.top + r.height * fy);
      }
    }
    await page.keyboard.up('Control');

    await expect
      .poll(async () =>
        page.evaluate((expected) => {
          const rf = (window as any).reactFlowInstance;
          return rf.getNodes().filter((n: any) => n.selected).length === expected;
        }, view.nodes.length),
      )
      .toBe(true);

    await waitForViewportTransformToSettle(page);
    await page.waitForTimeout(100);

    await expect(page).toHaveScreenshot('selection-styles-grid.png', {
      clip: await paddedAllNodesClip(page),
    });
  });
});
