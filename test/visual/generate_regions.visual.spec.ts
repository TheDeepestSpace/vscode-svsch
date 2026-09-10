import { expect, test, type Page } from '@playwright/test';
import { diagramSizing } from '../../src/diagram/constants';
import type { DiagramViewModel } from '../../src/ir/types';
import { GENERATE_REGION_EXTERNAL_BLOCK_WARNING } from '../../src/layout/generateRegionValidation';
import {
  expectGraphAndScreenshot,
  openFixture,
  openView,
  paddedGraphAndRegionsClip,
  trackView,
} from './helper';

type RegionSide = 'left' | 'right' | 'top' | 'bottom';
type RegionBounds = { x: number; y: number; width: number; height: number };

test.describe('generate region visual rendering', () => {
  test('renders if, else-if, and else generate regions from a fixture', async ({ page }) => {
    const view = await openFixture(
      page,
      'generate_if_else_regions.sv',
      'generate',
      'generate_if_else_regions',
    );
    const regions = view.generateRegions ?? [];

    expect(regions.filter((region) => !region.isGenerateBlock)).toHaveLength(3);
    expect(regions.map((region) => region.blockLabel)).toEqual(
      expect.arrayContaining(['g_if_zero', 'g_if_one']),
    );
    expect(regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining(['if', 'else-if', 'else']),
    );

    // The else arm is an unlabeled begin block: no block label, condition comment only.
    const elseRegion = regions.find((region) => region.kind === 'else');
    expect(elseRegion?.blockLabel).toBeUndefined();
    expect(elseRegion?.label).toBe('/* else */');

    await expect(page.locator('.generate-region:not(.generate-block)')).toHaveCount(3);
    await expect(
      page.locator('.generate-region[data-region-kind="if"] .generate-region-title'),
    ).toContainText('g_if_zero');
    await expect(
      page.locator('.generate-region[data-region-kind="else-if"] .generate-region-title'),
    ).toContainText('g_if_one');
    await expect(
      page.locator('.generate-region[data-region-kind="else"] .generate-region-title'),
    ).toHaveText('/* else */');
    await expect(page.locator('.generate-region-active:not(.generate-block)')).toHaveCount(1);
    await expect(
      page.locator('.generate-region-active:not(.generate-block) .generate-region-title'),
    ).toContainText('g_if_one');
    await expect(page.locator('.generate-region-inactive')).toHaveCount(2);

    await expectGraphAndScreenshot(page, 'generate-if-else-regions-canvas.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
  });

  test('renders all generate case arms from a fixture', async ({ page }) => {
    const view = await openFixture(
      page,
      'generate_case_regions.sv',
      'generate',
      'generate_case_regions',
    );
    const regions = view.generateRegions ?? [];

    expect(regions.filter((region) => !region.isGenerateBlock)).toHaveLength(3);
    expect(regions.map((region) => region.blockLabel)).toEqual(
      expect.arrayContaining(['g_case_0', 'g_case_1']),
    );
    expect(regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining(['case', 'case-default']),
    );

    // The default arm is an unlabeled begin block: no block label, condition comment only.
    const defaultRegion = regions.find((region) => region.kind === 'case-default');
    expect(defaultRegion?.blockLabel).toBeUndefined();
    expect(defaultRegion?.label).toBe('/* default */');

    await expect(page.locator('.generate-region:not(.generate-block)')).toHaveCount(3);
    await expect(
      page.locator('.generate-region[data-region-kind="case"] .generate-region-title', {
        hasText: 'g_case_0',
      }),
    ).toBeVisible();
    await expect(
      page.locator('.generate-region[data-region-kind="case"] .generate-region-title', {
        hasText: 'g_case_1',
      }),
    ).toBeVisible();
    await expect(
      page.locator('.generate-region[data-region-kind="case-default"] .generate-region-title'),
    ).toHaveText('/* default */');
    await expect(page.locator('.generate-region-active:not(.generate-block)')).toHaveCount(1);
    await expect(
      page.locator('.generate-region-active:not(.generate-block) .generate-region-title'),
    ).toContainText('g_case_1');
    await expect(page.locator('.generate-region-inactive')).toHaveCount(2);

    await expectGraphAndScreenshot(page, 'generate-case-regions-canvas.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
  });

  test('auto-layouts if, else-if, and else generate regions with ELK compound parents', async ({
    page,
  }) => {
    const view = await openFixture(
      page,
      'generate_if_else_regions.sv',
      'auto',
      'generate_if_else_regions',
    );
    const regions = view.generateRegions ?? [];

    expect(regions.filter((region) => !region.isGenerateBlock)).toHaveLength(3);
    await expect(page.locator('.generate-region:not(.generate-block)')).toHaveCount(3);
    await expect(page.locator('.generate-region-invalid')).toHaveCount(0);
    await expect(page.locator('.generate-region-active:not(.generate-block)')).toHaveCount(1);
    await expect(
      page.locator('.generate-region-active:not(.generate-block) .generate-region-title'),
    ).toContainText('g_if_one');
    await expect(page.locator('.generate-region.generate-block')).toHaveCount(1);
    await expect(
      page.locator('.generate-region.generate-block .generate-region-title'),
    ).toContainText('generate if');

    // Edge paint order: inactive routes render below active ones, so where routes
    // from an active and an inactive arm share a trunk, the active style shows.
    const edgeStateOrder = await page.evaluate(() => {
      const rank = (el: Element) =>
        el.classList.contains('generate-edge-inactive')
          ? 0
          : el.classList.contains('generate-edge-active')
            ? 2
            : 1;
      return [...document.querySelectorAll('.react-flow__edge')].map(rank);
    });
    expect(edgeStateOrder).toEqual([...edgeStateOrder].sort((a, b) => a - b));
    expect(edgeStateOrder).toContain(0);
    expect(edgeStateOrder).toContain(2);

    await expectGraphAndScreenshot(page, 'generate-if-else-regions-auto-canvas.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
  });

  test('auto-layouts all generate case arms with ELK compound parents', async ({ page }) => {
    const view = await openFixture(
      page,
      'generate_case_regions.sv',
      'auto',
      'generate_case_regions',
    );
    const regions = view.generateRegions ?? [];

    expect(regions.filter((region) => !region.isGenerateBlock)).toHaveLength(3);
    await expect(page.locator('.generate-region:not(.generate-block)')).toHaveCount(3);
    await expect(page.locator('.generate-region-invalid')).toHaveCount(0);
    await expect(page.locator('.generate-region-active:not(.generate-block)')).toHaveCount(1);
    await expect(
      page.locator('.generate-region-active:not(.generate-block) .generate-region-title'),
    ).toContainText('g_case_1');
    await expect(
      page.locator('.generate-region.generate-block .generate-region-title'),
    ).toContainText('generate case (MODE)');

    await expectGraphAndScreenshot(page, 'generate-case-regions-auto-canvas.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
  });

  test('shows warning icons when arm blocks overlap', async ({ page }) => {
    await openView(
      page,
      generateWarningView({
        includeSecondRegion: true,
        includeExternalNode: false,
      }),
    );
    await page.waitForSelector('.generate-region');

    const overlapView = generateWarningView({
      includeSecondRegion: true,
      includeExternalNode: false,
    });
    await moveGenerateRegionByGridCells(page, 'g_warn_one', -10, 0, { release: false });

    await expect(page.locator('.generate-region-invalid')).toHaveCount(2);
    await expect(
      page.locator('.generate-region-warning[aria-label*="arm blocks overlapping"]'),
    ).toHaveCount(2);

    trackView(page, await viewWithRenderedGenerateRegionBounds(page, overlapView));
    await expectGraphAndScreenshot(page, 'generate-region-overlap-warning.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
    await page.mouse.up();
  });

  test('shows a warning icon when an arm block contains an unrelated node', async ({ page }) => {
    await openView(
      page,
      generateWarningView({
        includeSecondRegion: false,
        includeExternalNode: true,
      }),
    );
    await page.waitForSelector('.generate-region');

    const externalNodeView = generateWarningView({
      includeSecondRegion: false,
      includeExternalNode: true,
    });
    await moveGenerateRegionByGridCells(page, 'g_warn_zero', 12, 0, { release: false });

    await expect(page.locator('.generate-region-invalid')).toHaveCount(1);
    await expect(
      page.locator('.generate-region-warning[aria-label="node does not belong to arm block"]'),
    ).toHaveCount(1);
    await expect(
      page.locator(`.node-warning[aria-label="${GENERATE_REGION_EXTERNAL_BLOCK_WARNING}"]`),
    ).toHaveCount(1);

    trackView(page, await viewWithRenderedGenerateRegionBounds(page, externalNodeView));
    await expectGraphAndScreenshot(page, 'generate-region-external-node-warning.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
    await page.mouse.up();
  });

  test('flags both generate blocks when they overlap', async ({ page }) => {
    await openView(page, generateBlockWarningView());
    await page.waitForSelector('.generate-region.generate-block');

    const view = generateBlockWarningView();
    await moveGenerateRegionByGridCells(page, 'generate if', 8, 0, { release: false });

    await expect(
      page.locator('.generate-region.generate-block.generate-region-invalid'),
    ).toHaveCount(2);

    trackView(page, await viewWithRenderedGenerateRegionBounds(page, view));
    await expectGraphAndScreenshot(page, 'generate-block-overlap-warning.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
    await page.mouse.up();
  });

  test('flags a block that overlaps a generate block but no arm', async ({ page }) => {
    await openView(page, generateBlockIntrusionView());
    await page.waitForSelector('.generate-region.generate-block');

    const view = generateBlockIntrusionView();
    // Nudge the generate block one cell to trigger validation; the free block stays put and
    // remains inside the block's empty area (not the arm).
    await moveGenerateRegionByGridCells(page, 'generate if', 1, 0, { release: false });

    // The wrapper and the intruding block are flagged; the arm it doesn't reach is not.
    await expect(
      page.locator('.generate-region.generate-block.generate-region-invalid'),
    ).toHaveCount(1);
    await expect(
      page.locator('.generate-region:not(.generate-block).generate-region-invalid'),
    ).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="blk:free"]')).toHaveClass(
      /svsch-node-invalid/,
    );
    await expect(page.locator('.react-flow__node[data-id="blk:owned"]')).not.toHaveClass(
      /svsch-node-invalid/,
    );

    trackView(page, await viewWithRenderedGenerateRegionBounds(page, view));
    await expectGraphAndScreenshot(page, 'generate-block-intrusion-warning.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
    await page.mouse.up();
  });

  test('renders the shared error highlight for each block type and a generate arm', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1300 });
    await openView(page, errorHighlightGridView());
    await page.waitForSelector('.react-flow__node');

    // Every block in the grid plus the arm carries the error style.
    await expect(page.locator('.react-flow__node.svsch-node-invalid')).toHaveCount(
      ERROR_BLOCK_VARIANTS.length,
    );
    await expect(
      page.locator(`.node-warning[aria-label="${GENERATE_REGION_EXTERNAL_BLOCK_WARNING}"]`),
    ).toHaveCount(ERROR_BLOCK_VARIANTS.length);
    await expect(page.locator('.generate-region-invalid')).toHaveCount(1);

    const stackedBadgeClearance = await page
      .locator('.react-flow__node.svsch-node-invalid')
      .evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const badge = node.querySelector('.svsch-array-badge');
          const warning = node.querySelector('.node-warning');
          if (!badge || !warning) return [];
          const badgeBounds = badge.getBoundingClientRect();
          const warningBounds = warning.getBoundingClientRect();
          return [
            {
              id: node.getAttribute('data-id'),
              badgeRight: badgeBounds.right,
              warningLeft: warningBounds.left,
            },
          ];
        }),
      );
    expect(stackedBadgeClearance.length).toBeGreaterThan(0);
    expect(
      stackedBadgeClearance.every(({ badgeRight, warningLeft }) => warningLeft > badgeRight),
    ).toBe(true);

    await expectGraphAndScreenshot(page, 'error-highlight-block-types.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });
  });

  test('marquee-selects arms with the standard selection border and moves them together', async ({
    page,
  }) => {
    await openFixture(page, 'generate_if_else_regions.sv', 'auto', 'generate_if_else_regions');

    const zeroBefore = await regionBounds(page, 'g_if_zero');
    const oneBefore = await regionBounds(page, 'g_if_one');
    const elseBefore = await regionBounds(page, '/* else */');

    // Rubber-band over the two labeled arms: both are fully contained and become
    // selected; the surrounding generate block is only partially covered and is not.
    await marqueeSelect(
      page,
      {
        x: Math.min(zeroBefore.x, oneBefore.x) - 6,
        y: Math.min(zeroBefore.y, oneBefore.y) - 6,
      },
      {
        x: Math.max(zeroBefore.x + zeroBefore.width, oneBefore.x + oneBefore.width) + 6,
        y: Math.max(zeroBefore.y + zeroBefore.height, oneBefore.y + oneBefore.height) + 6,
      },
    );

    await expect(page.locator('.generate-region-selected')).toHaveCount(2);
    await expect(generateRegionLocator(page, 'g_if_zero')).toHaveClass(/generate-region-selected/);
    await expect(generateRegionLocator(page, 'g_if_one')).toHaveClass(/generate-region-selected/);
    await expect(page.locator('.generate-region.generate-block')).not.toHaveClass(
      /generate-region-selected/,
    );

    await expectGraphAndScreenshot(page, 'generate-region-selected-canvas.png', {
      clip: await paddedGraphAndRegionsClip(page),
    });

    // Dragging one selected arm's title moves the whole selection.
    await moveGenerateRegionByGridCells(page, 'g_if_zero', 2, 0);

    const zeroAfter = await regionBounds(page, 'g_if_zero');
    const oneAfter = await regionBounds(page, 'g_if_one');
    const elseAfter = await regionBounds(page, '/* else */');
    expect(zeroAfter.x).toBe(zeroBefore.x + 2 * diagramSizing.gridSize);
    expect(oneAfter.x).toBe(oneBefore.x + 2 * diagramSizing.gridSize);
    expect(elseAfter.x).toBe(elseBefore.x);

    // Dragging the selection rectangle (over the selected nodes) translates the
    // selected arms with it rather than stretching them.
    const selectionRect = page.locator('.react-flow__nodesselection-rect');
    await expect(selectionRect).toBeVisible();
    const box = await selectionRect.boundingBox();
    if (!box) throw new Error('Could not find the nodes selection rectangle');
    const vp = await page.evaluate(() => (window as any).reactFlowInstance.getViewport());
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + diagramSizing.gridSize * vp.zoom, { steps: 4 });
    await page.mouse.move(startX, startY + 2 * diagramSizing.gridSize * vp.zoom, { steps: 4 });
    await page.mouse.up();

    const zeroDragged = await regionBounds(page, 'g_if_zero');
    const oneDragged = await regionBounds(page, 'g_if_one');
    expect(zeroDragged.y).toBe(zeroAfter.y + 2 * diagramSizing.gridSize);
    expect(zeroDragged.height).toBe(zeroAfter.height);
    expect(oneDragged.y).toBe(oneAfter.y + 2 * diagramSizing.gridSize);
    expect(oneDragged.height).toBe(oneAfter.height);
  });

  test('selects a region on single click and keeps it highlighted while moving', async ({
    page,
  }) => {
    await openFixture(page, 'generate_if_else_regions.sv', 'auto', 'generate_if_else_regions');

    // Clicking an arm's title selects it with the standard selection border.
    // g_if_zero is the inactive arm (MODE == 1): selection lifts the inactive
    // dimming so the highlight is as bright as on an active arm.
    const inactiveArm = generateRegionLocator(page, 'g_if_zero');
    expect(await inactiveArm.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.75');
    await inactiveArm.locator('.generate-region-title').click({ force: true });
    await expect(inactiveArm).toHaveClass(/generate-region-selected/);
    await expect(page.locator('.generate-region-selected')).toHaveCount(1);
    expect(await inactiveArm.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    // Clicking another region replaces the selection — works for the generate block too.
    // (Pan down first: the fitted view tucks the wrapper title under the toolbar.)
    await page.evaluate(() => {
      const instance = (window as any).reactFlowInstance;
      const vp = instance.getViewport();
      instance.setViewport({ ...vp, y: vp.y + 60 });
    });
    await generateRegionLocator(page, 'generate if')
      .locator('.generate-region-title')
      .click({ force: true });
    await expect(generateRegionLocator(page, 'generate if')).toHaveClass(
      /generate-region-selected/,
    );
    await expect(generateRegionLocator(page, 'g_if_zero')).not.toHaveClass(
      /generate-region-selected/,
    );
    await expect(page.locator('.generate-region-selected')).toHaveCount(1);

    // Moving an arm by its title selects and keeps it highlighted after the drop.
    await moveGenerateRegionByGridCells(page, 'g_if_one', 2, 0);
    await expect(generateRegionLocator(page, 'g_if_one')).toHaveClass(/generate-region-selected/);
    await expect(generateRegionLocator(page, 'generate if')).not.toHaveClass(
      /generate-region-selected/,
    );
    await expect(page.locator('.generate-region-selected')).toHaveCount(1);

    // Clicking empty canvas clears the region selection; the inactive dim returns.
    await page.locator('.react-flow__pane').click({ position: { x: 16, y: 16 }, force: true });
    await expect(page.locator('.generate-region-selected')).toHaveCount(0);
    expect(await inactiveArm.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.75');

    // Same for a node inside the inactive arm: selecting it lifts the dimming so
    // the selection outline is full-strength.
    const inactiveNode = page.locator('.react-flow__node.generate-node-inactive').first();
    const nodeStyle = () =>
      inactiveNode
        .locator('.hdl-node')
        .first()
        .evaluate((el) => {
          const style = getComputedStyle(el);
          return { opacity: style.opacity, filter: style.filter };
        });
    expect(await nodeStyle()).toEqual({ opacity: '0.75', filter: 'grayscale(0.75)' });
    await inactiveNode.click({ force: true });
    await expect(inactiveNode).toHaveClass(/selected/);
    expect(await nodeStyle()).toEqual({ opacity: '1', filter: 'none' });
  });

  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    // 'right' is skipped: g_if_one's output net is now auto-cut on first open
    // (see withFirstOpenAutoCutEdges in helper.ts), and the resulting cut-stub
    // edge happens to render its path exactly over this arm's right resize
    // handle, blocking the drag at the DOM hit-test level — a pre-existing
    // edges-vs-resize-handle stacking gap (both layers are z-index: 1 in
    // webview-chrome.css) that this fixture just happens to trigger now.
    // Tracked in https://github.com/TheDeepestSpace/svsch/issues/320.
    const testFn = side === 'right' ? test.fixme : test;
    testFn(
      `resizes the ${side} side of a generate region with a two-grid content clamp`,
      async ({ page }) => {
        const label = 'g_if_one';

        const clampView = await openFixture(
          page,
          'generate_if_else_regions.sv',
          'auto',
          'generate_if_else_regions',
        );
        await resizeGenerateRegionSideByGridCells(
          page,
          label,
          side,
          side === 'right' || side === 'bottom' ? -30 : 30,
        );
        const padding = await regionContentPadding(page, clampView, label);
        expect(padding[side]).toBe(diagramSizing.gridSize * 2);

        const expandedView = await openFixture(
          page,
          'generate_if_else_regions.sv',
          'auto',
          'generate_if_else_regions',
        );

        // Give g_if_one room on the side it grows into so the resize doesn't bump a
        // neighbouring arm — arm overlap is covered by its own dedicated tests.
        if (side === 'top') {
          await moveGenerateRegionByGridCells(page, 'g_if_zero', 0, -3);
        } else if (side === 'bottom') {
          await moveGenerateRegionByGridCells(page, '/* else */', 0, 3);
        }

        const before = await regionBounds(page, label);

        await resizeGenerateRegionSideByGridCells(
          page,
          label,
          side,
          side === 'right' || side === 'bottom' ? 3 : -3,
        );
        const expanded = await regionBounds(page, label);
        expect(regionSide(expanded, side)).toBe(
          regionSide(before, side) +
            (side === 'right' || side === 'bottom' ? 3 : -3) * diagramSizing.gridSize,
        );

        trackView(page, await viewWithRenderedGenerateRegionBounds(page, expandedView));
        await expectGraphAndScreenshot(page, `generate-region-resize-${side}.png`, {
          clip: await paddedGraphAndRegionsClip(page),
        });
      },
    );
  }
});

// Rubber-band select by dragging on empty canvas between two flow-coordinate points.
async function marqueeSelect(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const canvas = await page.locator('.react-flow').boundingBox();
  if (!canvas) throw new Error('Could not find the flow canvas');
  const vp = await page.evaluate(() => (window as any).reactFlowInstance.getViewport());
  const toScreen = (point: { x: number; y: number }) => ({
    x: canvas.x + point.x * vp.zoom + vp.x,
    y: canvas.y + point.y * vp.zoom + vp.y,
  });
  const start = toScreen(from);
  const end = toScreen(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

function generateRegionLocator(page: Page, label: string) {
  return page
    .locator('.generate-region')
    .filter({
      has: page.locator('.generate-region-title', { hasText: label }),
    })
    .first();
}

async function resizeGenerateRegionSideByGridCells(
  page: Page,
  label: string,
  side: RegionSide,
  cells: number,
): Promise<void> {
  const handle = generateRegionLocator(page, label).locator(`.generate-region-resize-${side}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`Could not find ${side} resize handle for ${label}`);
  const zoom = await page
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
  const dx = side === 'left' || side === 'right' ? cells * diagramSizing.gridSize * zoom : 0;
  const dy = side === 'top' || side === 'bottom' ? cells * diagramSizing.gridSize * zoom : 0;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + Math.sign(dx || 1) * 2, startY + Math.sign(dy || 1) * 2, {
    steps: 3,
  });
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
  await page.mouse.up();
  const canvas = await page.locator('.canvas').boundingBox();
  if (canvas) {
    await page.mouse.move(canvas.x + 16, canvas.y + 16);
  }
  await page.waitForTimeout(650);
}

async function moveGenerateRegionByGridCells(
  page: Page,
  label: string,
  cellsX: number,
  cellsY: number,
  options: { release?: boolean } = {},
): Promise<void> {
  const title = generateRegionLocator(page, label).locator('.generate-region-title');
  const box = await title.boundingBox();
  if (!box) throw new Error(`Could not find title for ${label}`);
  const zoom = await page
    .locator('html')
    .evaluate(() => (window as any).reactFlowInstance?.getViewport()?.zoom ?? 1);
  const dx = cellsX * diagramSizing.gridSize * zoom;
  const dy = cellsY * diagramSizing.gridSize * zoom;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
  if (options.release !== false) {
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
}

async function regionBounds(page: Page, label: string): Promise<RegionBounds> {
  return generateRegionLocator(page, label).evaluate((element) => {
    const html = element as HTMLElement;
    return {
      x: Number.parseFloat(html.style.left || '0'),
      y: Number.parseFloat(html.style.top || '0'),
      width: Number.parseFloat(html.style.width || '0'),
      height: Number.parseFloat(html.style.height || '0'),
    };
  });
}

type ErrorBlockVariant = {
  key: string;
  kind: DiagramViewModel['nodes'][number]['kind'];
  label: string;
  ports?: DiagramViewModel['nodes'][number]['ports'];
  instanceOf?: string;
  role?: string;
  typeName?: string;
  modportName?: string;
  operation?: string;
  repeatExpression?: string;
  isArrayNode?: boolean;
  arrayDimension?: string;
  metadata?: Record<string, unknown>;
};

const ERROR_BLOCK_VARIANTS: ErrorBlockVariant[] = [
  {
    key: 'input_port',
    kind: 'port',
    label: 'input',
    ports: [port('input_port', 'input', 'input')],
  },
  {
    key: 'output_port',
    kind: 'port',
    label: 'output',
    ports: [port('output_port', 'output', 'output')],
  },
  {
    key: 'interface_port',
    kind: 'interface',
    label: 'if_port',
    role: 'port',
    typeName: 'stream_if',
    modportName: 'master',
    ports: [
      port('interface_port', 'stream', 'input', { typeName: 'stream_if', modportName: 'master' }),
    ],
  },
  { key: 'comb', kind: 'comb', label: 'comb' },
  { key: 'loop', kind: 'loop', label: 'loop' },
  {
    key: 'register',
    kind: 'register',
    label: 'register',
    ports: [
      port('register', 'D', 'input'),
      port('register', 'clk', 'input'),
      port('register', 'Q', 'output'),
    ],
    metadata: { clockSignal: 'clk' },
  },
  {
    key: 'latch',
    kind: 'latch',
    label: 'latch',
    ports: [port('latch', 'D', 'input'), port('latch', 'G', 'input'), port('latch', 'Q', 'output')],
  },
  {
    key: 'mux',
    kind: 'mux',
    label: 'mux',
    ports: [
      port('mux', 'sel', 'input'),
      port('mux', 'a', 'input'),
      port('mux', 'b', 'input'),
      port('mux', 'y', 'output'),
    ],
  },
  {
    key: 'select',
    kind: 'select',
    label: 'select',
    ports: [
      port('select', 's', 'input'),
      port('select', 'in', 'input'),
      port('select', 'y', 'output'),
    ],
  },
  { key: 'alu', kind: 'alu', label: 'alu', operation: '+', ports: defaultPorts('alu') },
  { key: 'gate', kind: 'gate', label: 'gate', operation: 'and', ports: defaultPorts('gate') },
  {
    key: 'comparator',
    kind: 'comparator',
    label: 'cmp',
    operation: '==',
    ports: defaultPorts('comparator'),
  },
  {
    key: 'inverter',
    kind: 'inverter',
    label: 'inv',
    ports: [port('inverter', 'a', 'input'), port('inverter', 'y', 'output')],
  },
  {
    key: 'zext',
    kind: 'zext',
    label: 'zext',
    ports: [port('zext', 'in', 'input'), port('zext', 'out', 'output')],
  },
  { key: 'literal', kind: 'literal', label: "1'b1", ports: [port('literal', 'y', 'output')] },
  {
    key: 'replicate',
    kind: 'replicate',
    label: 'x N',
    repeatExpression: 'N',
    ports: [port('replicate', 'a', 'input'), port('replicate', 'y', 'output')],
  },
  { key: 'instance', kind: 'instance', label: 'instance', instanceOf: 'sub' },
  { key: 'module', kind: 'module', label: 'module' },
  { key: 'unknown', kind: 'unknown', label: 'unknown' },
  {
    key: 'bus_comp',
    kind: 'bus',
    label: 'bus comp',
    ports: [
      port('bus_comp', 'a', 'input'),
      port('bus_comp', 'b', 'input'),
      port('bus_comp', 'out', 'output'),
    ],
  },
  {
    key: 'bus_break',
    kind: 'bus',
    label: 'bus break',
    ports: [
      port('bus_break', 'in', 'input'),
      port('bus_break', 'lo', 'output'),
      port('bus_break', 'hi', 'output'),
    ],
  },
  {
    key: 'struct_comp',
    kind: 'struct',
    label: 'packet',
    role: 'composition',
    ports: [
      port('struct_comp', 'opcode', 'input', { width: '[3:0]' }),
      port('struct_comp', 'valid', 'input'),
      port('struct_comp', 'pkt', 'output', { typeName: 'packet_t' }),
    ],
  },
  {
    key: 'struct_break',
    kind: 'struct',
    label: 'packet',
    role: 'breakout',
    ports: [
      port('struct_break', 'pkt', 'input', { typeName: 'packet_t' }),
      port('struct_break', 'opcode', 'output', { width: '[3:0]' }),
      port('struct_break', 'valid', 'output'),
    ],
  },
  {
    key: 'interface_inst',
    kind: 'interface',
    label: 'if_inst',
    role: 'instance',
    typeName: 'stream_if',
    ports: [
      port('interface_inst', 'clk', 'input'),
      port('interface_inst', 'ready', 'output'),
      port('interface_inst', 'master', 'inout', {
        width: 'interface',
        preferredSide: 'left',
        modportName: 'master',
      }),
      port('interface_inst', 'slave', 'inout', {
        width: 'interface',
        preferredSide: 'right',
        modportName: 'slave',
      }),
    ],
  },
  {
    key: 'interface_modport',
    kind: 'interface',
    label: 'master',
    role: 'modport',
    typeName: 'stream_if',
    ports: [
      port('interface_modport', 'req', 'input'),
      port('interface_modport', 'rsp', 'output'),
      port('interface_modport', 'bus', 'inout', { width: 'interface', modportName: 'slave' }),
    ],
  },
  {
    key: 'net_label',
    kind: 'netLabel',
    label: 'cut_net',
    ports: [],
    metadata: {
      cutNet: { netKey: 'cut_net', role: 'source', align: 'start', handleSide: 'right' },
    },
  },
  {
    key: 'array_port',
    kind: 'port',
    label: 'port[]',
    ports: [port('array_port', 'p', 'input')],
    isArrayNode: true,
    arrayDimension: '[3:0]',
  },
  { key: 'array_comb', kind: 'comb', label: 'comb[]', isArrayNode: true, arrayDimension: '[3:0]' },
  {
    key: 'array_register',
    kind: 'register',
    label: 'reg[]',
    ports: [
      port('array_register', 'D', 'input'),
      port('array_register', 'clk', 'input'),
      port('array_register', 'Q', 'output'),
    ],
    isArrayNode: true,
    arrayDimension: '[3:0]',
    metadata: { clockSignal: 'clk' },
  },
  {
    key: 'array_mux',
    kind: 'mux',
    label: 'mux[]',
    ports: [
      port('array_mux', 'sel', 'input'),
      port('array_mux', 'a', 'input'),
      port('array_mux', 'b', 'input'),
      port('array_mux', 'y', 'output'),
    ],
    isArrayNode: true,
    arrayDimension: '[3:0]',
  },
  {
    key: 'array_instance',
    kind: 'instance',
    label: 'inst[]',
    instanceOf: 'sub',
    isArrayNode: true,
    arrayDimension: '[3:0]',
  },
  {
    key: 'array_bus',
    kind: 'bus',
    label: 'bus[]',
    ports: [
      port('array_bus', 'a', 'input'),
      port('array_bus', 'b', 'input'),
      port('array_bus', 'out', 'output'),
    ],
    isArrayNode: true,
    arrayDimension: '[3:0]',
    metadata: { aggregateKind: 'array' },
  },
  {
    key: 'array_literal',
    kind: 'literal',
    label: "8'hAA",
    ports: [port('array_literal', 'y', 'output')],
    isArrayNode: true,
    arrayDimension: '[3:0]',
  },
  {
    key: 'array_replicate',
    kind: 'replicate',
    label: 'x N[]',
    repeatExpression: 'N',
    ports: [port('array_replicate', 'a', 'input'), port('array_replicate', 'y', 'output')],
    isArrayNode: true,
    arrayDimension: '[3:0]',
  },
];

// A grid of unconnected blocks (one per kind) plus a generate arm, all forced into
// the error state, so the snapshot locks in the shared error highlight per block type.
function errorHighlightGridView(): DiagramViewModel {
  const cols = 5;
  const cellX = 270;
  const cellY = 210;
  const originX = 80;
  const originY = 80;

  const nodes = ERROR_BLOCK_VARIANTS.map((variant, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return errorBlock(variant, originX + col * cellX, originY + row * cellY);
  });

  // A real owned block inside the arm — it belongs to the arm, so it stays
  // un-highlighted, and it keeps the arm inside the fitted view for the snapshot.
  const armY = originY + Math.ceil(ERROR_BLOCK_VARIANTS.length / cols) * cellY;
  const ownedBlock = errorBlock(
    { key: 'arm_owned', kind: 'comb', label: 'owned' },
    originX + 24,
    armY + 44,
  );
  ownedBlock.id = 'err_arm_owned';
  ownedBlock.label = 'owned';
  delete (ownedBlock as { invalid?: boolean }).invalid;
  delete (ownedBlock as { warningNote?: string }).warningNote;
  nodes.push(ownedBlock);

  const generateRegions: NonNullable<DiagramViewModel['generateRegions']> = [
    {
      id: 'region:g_error',
      kind: 'if',
      label: 'g_error /* MODE == 0 */',
      blockLabel: 'g_error',
      condition: 'MODE == 0',
      activeState: 'active',
      nodeIds: ['err_arm_owned'],
      bounds: { x: originX, y: armY, width: cellX * 2 - 40, height: cellY - 20 },
      invalid: true,
      warningNote: 'node does not belong to arm block',
    },
  ];

  return {
    moduleName: 'error_highlight_grid',
    nodes,
    edges: [],
    generateRegions,
    diagnostics: [],
  } as DiagramViewModel;
}

function errorBlock(
  variant: ErrorBlockVariant,
  x: number,
  y: number,
): DiagramViewModel['nodes'][number] {
  const metadata = {
    ...(variant.metadata ?? {}),
    ...(variant.isArrayNode ? { isArrayNode: true, arrayDimension: variant.arrayDimension } : {}),
  };
  return {
    id: `err_${variant.key}`,
    kind: variant.kind,
    label: variant.label,
    instanceOf: variant.instanceOf,
    role: variant.role,
    typeName: variant.typeName,
    modportName: variant.modportName,
    repeatExpression: variant.repeatExpression,
    ports: variant.ports ?? defaultPorts(variant.key),
    position: { x, y },
    isArrayNode: variant.isArrayNode,
    arrayDimension: variant.arrayDimension,
    metadata,
    operation: variant.operation,
    invalid: true,
    warningNote: GENERATE_REGION_EXTERNAL_BLOCK_WARNING,
  } as unknown as DiagramViewModel['nodes'][number];
}

function defaultPorts(key: string): DiagramViewModel['nodes'][number]['ports'] {
  return [port(key, 'a', 'input'), port(key, 'b', 'input'), port(key, 'y', 'output')];
}

function port(
  key: string,
  name: string,
  direction: 'input' | 'output' | 'inout' | 'unknown',
  extra: Partial<DiagramViewModel['nodes'][number]['ports'][number]> = {},
): DiagramViewModel['nodes'][number]['ports'][number] {
  return {
    id: `${key}:${name}`,
    name,
    direction,
    ...extra,
  };
}

// Two generate blocks (wrappers), each holding one arm + block, placed apart. Dragging
// the "generate if" block right by 8 cells overlaps them so both wrappers flag.
function generateBlockWarningView(): DiagramViewModel {
  const wrapper = (
    id: string,
    kind: string,
    label: string,
    x: number,
  ): NonNullable<DiagramViewModel['generateRegions']>[number] =>
    ({
      id: `block:${id}`,
      kind,
      label,
      isGenerateBlock: true,
      activeState: 'active',
      nodeIds: [],
      bounds: { x, y: 48, width: 220, height: 200 },
    }) as unknown as NonNullable<DiagramViewModel['generateRegions']>[number];

  const arm = (id: string, x: number): NonNullable<DiagramViewModel['generateRegions']>[number] =>
    ({
      id: `arm:${id}`,
      kind: 'if',
      label: `g_${id} /* MODE == 0 */`,
      blockLabel: `g_${id}`,
      activeState: 'active',
      parentRegionId: `block:${id}`,
      nodeIds: [`blk:${id}`],
      bounds: { x: x + 24, y: 96, width: 160, height: 104 },
    }) as unknown as NonNullable<DiagramViewModel['generateRegions']>[number];

  const block = (id: string, x: number): DiagramViewModel['nodes'][number] =>
    ({
      id: `blk:${id}`,
      kind: 'comb',
      label: id,
      ports: [],
      position: { x: x + 48, y: 116 },
    }) as unknown as DiagramViewModel['nodes'][number];

  return {
    moduleName: 'generate_block_warning',
    nodes: [block('a', 48), block('b', 412)],
    edges: [],
    generateRegions: [
      wrapper('a', 'generate-if', 'generate if', 48),
      arm('a', 48),
      wrapper('b', 'generate-case', 'generate case (MODE)', 412),
      arm('b', 412),
    ],
    diagnostics: [],
  } as DiagramViewModel;
}

// A generate block whose arm sits on the right, with a free block overlapping the block's
// empty left area — it intrudes the generate block without touching the arm.
function generateBlockIntrusionView(): DiagramViewModel {
  return {
    moduleName: 'generate_block_intrusion',
    nodes: [
      {
        id: 'blk:owned',
        kind: 'inverter',
        label: 'owned',
        ports: [],
        position: { x: 300, y: 140 },
      },
      { id: 'blk:free', kind: 'inverter', label: 'free', ports: [], position: { x: 96, y: 140 } },
    ],
    edges: [],
    generateRegions: [
      {
        id: 'block:g',
        kind: 'generate-if',
        label: 'generate if',
        isGenerateBlock: true,
        activeState: 'active',
        nodeIds: [],
        bounds: { x: 48, y: 48, width: 360, height: 200 },
      },
      {
        id: 'arm:g',
        kind: 'if',
        label: 'g_x /* MODE == 0 */',
        blockLabel: 'g_x',
        activeState: 'active',
        parentRegionId: 'block:g',
        nodeIds: ['blk:owned'],
        bounds: { x: 264, y: 108, width: 120, height: 120 },
      },
    ],
    diagnostics: [],
  } as unknown as DiagramViewModel;
}

function generateWarningView(options: {
  includeSecondRegion: boolean;
  includeExternalNode: boolean;
}): DiagramViewModel {
  const nodes: DiagramViewModel['nodes'] = [
    {
      id: 'node:warn:a',
      kind: 'comb',
      label: 'owned_a',
      ports: [],
      position: { x: 80, y: 80 },
    },
  ];

  const generateRegions: NonNullable<DiagramViewModel['generateRegions']> = [
    {
      id: 'region:g_warn_zero',
      kind: 'if',
      label: 'g_warn_zero /* MODE == 0 */',
      blockLabel: 'g_warn_zero',
      condition: 'MODE == 0',
      activeState: 'active',
      nodeIds: ['node:warn:a'],
      bounds: { x: 48, y: 48, width: 240, height: 160 },
    },
  ];

  if (options.includeSecondRegion) {
    nodes.push({
      id: 'node:warn:b',
      kind: 'comb',
      label: 'owned_b',
      ports: [],
      position: { x: 360, y: 80 },
    });
    generateRegions.push({
      id: 'region:g_warn_one',
      kind: 'else-if',
      label: 'g_warn_one /* MODE == 1 */',
      blockLabel: 'g_warn_one',
      condition: 'MODE == 1',
      activeState: 'inactive',
      nodeIds: ['node:warn:b'],
      bounds: { x: 328, y: 48, width: 240, height: 160 },
    });
  }

  if (options.includeExternalNode) {
    nodes.push({
      id: 'node:warn:external',
      kind: 'comb',
      label: 'external',
      ports: [],
      position: { x: 360, y: 80 },
    });
  }

  return {
    moduleName: 'generate_region_warning_visual',
    nodes,
    edges: [],
    generateRegions,
    diagnostics: [],
  };
}

type RenderedRegionState = { bounds: RegionBounds; invalid: boolean; warningNote?: string };

async function viewWithRenderedGenerateRegionBounds(
  page: Page,
  view: DiagramViewModel,
): Promise<DiagramViewModel> {
  const stateById: Record<string, RenderedRegionState> = await page
    .locator('.generate-region')
    .evaluateAll((elements): Record<string, RenderedRegionState> => {
      return Object.fromEntries(
        elements
          .map((element) => {
            const html = element as HTMLElement;
            return [
              html.dataset.regionId ?? '',
              {
                bounds: {
                  x: Number.parseFloat(html.style.left || '0'),
                  y: Number.parseFloat(html.style.top || '0'),
                  width: Number.parseFloat(html.style.width || '0'),
                  height: Number.parseFloat(html.style.height || '0'),
                },
                invalid: html.classList.contains('generate-region-invalid'),
                warningNote: html.dataset.warningNote || undefined,
              },
            ];
          })
          .filter(([id]) => id),
      );
    });

  // Dragging a region also moves its owned nodes, so capture the live node
  // positions too — otherwise the SVG (rendered from this view) would draw nodes
  // at their pre-drag spots while the webview screenshot shows the dragged ones.
  const nodePositions: Record<string, { x: number; y: number }> = await page.evaluate(() => {
    const rf = (
      window as {
        reactFlowInstance?: {
          getNodes(): Array<{ id: string; position: { x: number; y: number } }>;
        };
      }
    ).reactFlowInstance;
    if (!rf) return {};
    return Object.fromEntries(
      rf.getNodes().map((node) => [node.id, { x: node.position.x, y: node.position.y }]),
    );
  });

  const invalidNodeStateById: Record<string, { warningNote?: string }> = await page
    .locator('.react-flow__node.svsch-node-invalid')
    .evaluateAll((elements) =>
      Object.fromEntries(
        elements
          .map((element) => {
            const html = element as HTMLElement;
            const id = html.dataset.id ?? '';
            const warningNote =
              html.querySelector('.node-warning')?.getAttribute('aria-label') ?? undefined;
            return [id, { warningNote }];
          })
          .filter(([id]) => id),
      ),
    );

  return {
    ...view,
    nodes: view.nodes.map((node) => {
      const position = nodePositions[node.id];
      const invalidState = invalidNodeStateById[node.id];
      const invalid = Boolean(invalidState) || undefined;
      if (!position && !invalid) return node;
      return {
        ...node,
        ...(position ? { position } : {}),
        invalid,
        warningNote: invalidState?.warningNote,
      };
    }),
    generateRegions: view.generateRegions?.map((region) => {
      const state = stateById[region.id];
      if (!state) return region;
      return {
        ...region,
        bounds: state.bounds,
        invalid: state.invalid || undefined,
        warningNote: state.warningNote,
      };
    }),
  };
}

function regionSide(bounds: RegionBounds, side: RegionSide): number {
  if (side === 'left') return bounds.x;
  if (side === 'right') return bounds.x + bounds.width;
  if (side === 'top') return bounds.y;
  return bounds.y + bounds.height;
}

async function regionContentPadding(
  page: Page,
  view: DiagramViewModel,
  label: string,
): Promise<Record<RegionSide, number>> {
  const region = view.generateRegions?.find(
    (candidate) => candidate.blockLabel === label || candidate.label.includes(label),
  );
  if (!region) throw new Error(`Could not find region ${label}`);
  const bounds = await regionBounds(page, label);
  const content = await page.evaluate((nodeIds) => {
    const rf = (window as any).reactFlowInstance;
    const nodes = rf.getNodes().filter((node: any) => nodeIds.includes(node.id));
    const rects = nodes.map((node: any) => ({
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? node.width ?? 0,
      height: node.measured?.height ?? node.height ?? 0,
    }));
    return {
      x: Math.min(...rects.map((rect: any) => rect.x)),
      y: Math.min(...rects.map((rect: any) => rect.y)),
      right: Math.max(...rects.map((rect: any) => rect.x + rect.width)),
      bottom: Math.max(...rects.map((rect: any) => rect.y + rect.height)),
    };
  }, region.nodeIds);

  return {
    left: content.x - bounds.x,
    top: content.y - bounds.y,
    right: bounds.x + bounds.width - content.right,
    bottom: bounds.y + bounds.height - content.bottom,
  };
}
