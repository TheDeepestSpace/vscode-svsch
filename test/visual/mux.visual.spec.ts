import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import {
  expectGraphAndScreenshot as recordAndScreenshot,
  fitGraphView,
  fixtureRoot,
  paddedAllNodesClip,
  trackView,
  recordVisualBenchmark,
} from './helper';
import {
  buildViewModel,
  mergeNetCut,
  firstOpenAutoCutEdges,
  mergeFirstOpenNetCuts,
} from '../../src/layout/mergeLayout';
import { buildDesignGraph } from '../../src/parser/backend';
import { diagramSizing } from '../../src/diagram/constants';
import {
  ARRAY_STACK_LANE_OFFSET,
  ARRAY_STACK_WIDE_LANE_OFFSET,
} from '../../src/webview/arrayStackGeometry';
import type { DesignGraph, DiagramViewModel } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';
import { SNAPSHOT_THRESHOLDS } from '../snapshotPolicy';

// This file predates helper.ts's benchmark instrumentation and keeps its own
// local openFixture()/postView() rather than the shared ones — so it needs
// its own copy of the postView -> render-ready timing, wired into the same
// recordVisualBenchmark() sink. openFixture() below resolves it precisely via
// its ready selector; this wrapper is the fallback for the ~20 call sites
// that use postView()/openView() directly with a hand-built view.
const postViewStartedAt = new WeakMap<Page, number>();

async function expectGraphAndScreenshot(page: Page, name: string, options?: any) {
  const startedAt = postViewStartedAt.get(page);
  if (startedAt !== undefined) {
    postViewStartedAt.delete(page);
    recordVisualBenchmark('rendering', Date.now() - startedAt);
  }
  return recordAndScreenshot(page, name, options);
}

async function expectStackedEdgeSegmentsOrthogonal(page: Page): Promise<void> {
  const diagonalSegments = await page
    .locator('.svsch-edge-stacked, .svsch-edge-stacked-back, .svsch-edge-stacked-front')
    .evaluateAll((paths) => {
      const numberPattern = /-?\d+(?:\.\d+)?/g;
      const diagonals: string[] = [];

      for (const path of paths) {
        // Line-jump arcs (Q curves) hop over crossing edges; collapse each arc to
        // its endpoint so only genuine diagonal line segments are flagged.
        const d = (path.getAttribute('d') ?? '').replace(
          /Q\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
          'L $3 $4',
        );
        const values = [...d.matchAll(numberPattern)].map((match) => Number(match[0]));
        const points: Array<{ x: number; y: number }> = [];
        for (let index = 0; index + 1 < values.length; index += 2) {
          points.push({ x: values[index], y: values[index + 1] });
        }
        for (let index = 1; index < points.length; index++) {
          const dx = Math.abs(points[index].x - points[index - 1].x);
          const dy = Math.abs(points[index].y - points[index - 1].y);
          if (dx > 0.5 && dy > 0.5) {
            diagonals.push(d);
            break;
          }
        }
      }

      return diagonals;
    });

  expect(diagonalSegments).toEqual([]);
}

async function expectArrayStackEdgeLanes(
  page: Page,
  edgeId: string,
  laneOffset: number = ARRAY_STACK_LANE_OFFSET,
): Promise<void> {
  const lanes = await page
    .locator(
      `.react-flow__edge[data-id="${edgeId}"] .svsch-edge-stacked-back, ` +
        `.react-flow__edge[data-id="${edgeId}"] .svsch-edge-stacked-front, ` +
        `.react-flow__edge[data-id="${edgeId}"] .svsch-edge-stacked`,
    )
    .evaluateAll((paths) => {
      const pointPattern = /[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;

      return paths.map((path) => {
        const d = path.getAttribute('d') ?? '';
        const points: Array<{ x: number; y: number }> = [];
        let match = pointPattern.exec(d);
        while (match) {
          points.push({ x: Number(match[1]), y: Number(match[2]) });
          match = pointPattern.exec(d);
        }

        return {
          d,
          start: points[0],
          end: points[points.length - 1],
        };
      });
    });

  expect(lanes).toHaveLength(3);
  expect(lanes.every((lane) => lane.start && lane.end)).toBe(true);

  const bySourceLayer = [...lanes].sort((a, b) => a.start.y - b.start.y);
  expect(bySourceLayer[1].start.x - bySourceLayer[0].start.x).toBeGreaterThan(0);
  expect(bySourceLayer[2].start.x - bySourceLayer[1].start.x).toBeGreaterThan(0);
  expect(bySourceLayer[1].start.y - bySourceLayer[0].start.y).toBeCloseTo(laneOffset, 0);
  expect(bySourceLayer[2].start.y - bySourceLayer[1].start.y).toBeCloseTo(laneOffset, 0);

  const byTargetLayer = [...lanes].sort((a, b) => a.end.y - b.end.y);
  expect(Math.abs(byTargetLayer[1].end.x - byTargetLayer[0].end.x)).toBeGreaterThan(0);
  expect(Math.abs(byTargetLayer[2].end.x - byTargetLayer[1].end.x)).toBeGreaterThan(0);
  expect(byTargetLayer[1].end.y - byTargetLayer[0].end.y).toBeCloseTo(laneOffset, 0);
  expect(byTargetLayer[2].end.y - byTargetLayer[1].end.y).toBeCloseTo(laneOffset, 0);
}

async function expectArrayStackEdgeLayerCoordinates(
  page: Page,
  edgeId: string,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<void> {
  const geometry = await page.evaluate(
    ({
      edgeId: currentEdgeId,
      sourceNodeId: currentSourceNodeId,
      targetNodeId: currentTargetNodeId,
    }) => {
      type Rect = {
        left: number;
        right: number;
        top: number;
        bottom: number;
        width: number;
        height: number;
      };

      function pointFromPath(path: Element, useEnd: boolean): { x: number; y: number } | undefined {
        const d = path.getAttribute('d') ?? '';
        const matches = [...d.matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
        const match = useEnd ? matches[matches.length - 1] : matches[0];
        const matrix = (path as SVGPathElement).getScreenCTM();
        if (!match || !matrix) return undefined;
        const x = Number(match[1]);
        const y = Number(match[2]);
        return {
          x: matrix.a * x + matrix.c * y + matrix.e,
          y: matrix.b * x + matrix.d * y + matrix.f,
        };
      }

      function rectFor(selector: string): Rect | undefined {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        if (!rect) return undefined;
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      }

      function layerRects(nodeId: string): { front?: Rect; middle?: Rect; back?: Rect } {
        const portFront = rectFor(`[data-node-id="${nodeId}"] .port-skin-array-front`);
        if (portFront) {
          return {
            front: portFront,
            middle: rectFor(`[data-node-id="${nodeId}"] .port-skin-array-middle`),
            back: rectFor(`[data-node-id="${nodeId}"] .port-skin-array-back`),
          };
        }
        return {
          front: rectFor(`[data-node-id="${nodeId}"] .hdl-node-array-front`),
          middle: rectFor(`[data-node-id="${nodeId}"] .hdl-node-array-middle`),
          back: rectFor(`[data-node-id="${nodeId}"] .hdl-node-array-back`),
        };
      }

      const edge = document.querySelector(`.react-flow__edge[data-id="${currentEdgeId}"]`);
      const paths = [
        ...(edge?.querySelectorAll(
          '.svsch-edge-stacked-back, .svsch-edge-stacked-front, .svsch-edge-stacked',
        ) ?? []),
      ];
      const sourceLeadPaths = [
        ...document.querySelectorAll(
          `[data-node-id="${currentSourceNodeId}"] .svsch-array-stack-lead-source-right`,
        ),
      ];
      const targetLeadPaths = [
        ...document.querySelectorAll(
          `[data-node-id="${currentTargetNodeId}"] .svsch-array-stack-lead-target-left`,
        ),
      ];
      return {
        edgeId: currentEdgeId,
        lanes: paths.map((path) => ({
          className: path.getAttribute('class'),
          stroke: getComputedStyle(path).stroke,
          d: path.getAttribute('d'),
          start: pointFromPath(path, false),
          end: pointFromPath(path, true),
        })),
        sourceLeads: sourceLeadPaths.map((path) => ({
          className: path.getAttribute('class'),
          stroke: getComputedStyle(path).stroke,
          start: pointFromPath(path, false),
          end: pointFromPath(path, true),
        })),
        targetLeads: targetLeadPaths.map((path) => ({
          className: path.getAttribute('class'),
          stroke: getComputedStyle(path).stroke,
          start: pointFromPath(path, false),
          end: pointFromPath(path, true),
        })),
        source: layerRects(currentSourceNodeId),
        target: layerRects(currentTargetNodeId),
      };
    },
    { edgeId, sourceNodeId, targetNodeId },
  );

  expect(geometry.lanes).toHaveLength(3);
  expect(geometry.source.front).toBeDefined();
  expect(geometry.source.middle).toBeDefined();
  expect(geometry.source.back).toBeDefined();
  expect(geometry.target.front).toBeDefined();
  expect(geometry.target.middle).toBeDefined();
  expect(geometry.target.back).toBeDefined();

  const bySourceLayer = [...geometry.lanes].sort((a, b) => (a.start?.y ?? 0) - (b.start?.y ?? 0));
  // Lead length equals the layer trim, which scales up for wide (multi-bit) stacks —
  // allow the scaled wide-stack trim (0.9 grid) plus rounding between a lane start and its
  // card edge.
  expect(Math.abs((bySourceLayer[0].start?.x ?? 0) - geometry.source.front!.right)).toBeLessThan(
    34,
  );
  expect(Math.abs((bySourceLayer[1].start?.x ?? 0) - geometry.source.middle!.right)).toBeLessThan(
    34,
  );
  expect(Math.abs((bySourceLayer[2].start?.x ?? 0) - geometry.source.back!.right)).toBeLessThan(34);
  const sourceLaneYs = bySourceLayer.map((lane) => lane.start?.y ?? 0);
  const bySourceLead = geometry.sourceLeads
    .filter((lead) => sourceLaneYs.some((y) => Math.abs((lead.start?.y ?? 0) - y) < 1))
    .sort((a, b) => (a.start?.y ?? 0) - (b.start?.y ?? 0));
  expect(bySourceLead).toHaveLength(3);
  // Each lead's far endpoint should land exactly where its own layer's wire
  // begins (same side-aware trim formula on both sides; right/bottom mirror
  // front↔back so every junction clears the outermost sibling skin) —
  // so the lead and wire form one continuous line with no visible seam.
  expect(bySourceLead[0].start?.x).toBeCloseTo(bySourceLayer[0].start!.x, -1);
  expect(Math.abs((bySourceLead[0].end?.x ?? 0) - geometry.source.front!.right)).toBeLessThan(8);
  expect(bySourceLead[0].stroke).toBe(bySourceLayer[0].stroke);
  expect(bySourceLead[1].start?.x).toBeCloseTo(bySourceLayer[1].start!.x, -1);
  expect(Math.abs((bySourceLead[1].end?.x ?? 0) - geometry.source.middle!.right)).toBeLessThan(8);
  expect(bySourceLead[1].stroke).toBe(bySourceLayer[1].stroke);
  expect(bySourceLead[2].start?.x).toBeCloseTo(bySourceLayer[2].start!.x, -1);
  expect(Math.abs((bySourceLead[2].end?.x ?? 0) - geometry.source.back!.right)).toBeLessThan(8);
  expect(bySourceLead[2].stroke).toBe(bySourceLayer[2].stroke);

  const byTargetLayer = [...geometry.lanes].sort((a, b) => (a.end?.y ?? 0) - (b.end?.y ?? 0));
  expect(Math.abs((byTargetLayer[0].end?.x ?? 0) - geometry.target.front!.left)).toBeLessThan(34);
  expect(Math.abs((byTargetLayer[1].end?.x ?? 0) - geometry.target.middle!.left)).toBeLessThan(34);
  expect(Math.abs((byTargetLayer[2].end?.x ?? 0) - geometry.target.back!.left)).toBeLessThan(34);

  const targetLaneYs = byTargetLayer.map((lane) => lane.end?.y ?? 0);
  const byTargetLead = geometry.targetLeads
    .filter((lead) => targetLaneYs.some((y) => Math.abs((lead.start?.y ?? 0) - y) < 1))
    .sort((a, b) => (a.start?.y ?? 0) - (b.start?.y ?? 0));
  expect(byTargetLead).toHaveLength(3);
  // Leads snap to whole pixels while lanes keep fractional trims, so allow the
  // sub-pixel rounding gap (precision -1 → within 5px) between lead and lane.
  expect(byTargetLead[0].start?.x).toBeCloseTo(byTargetLayer[0].end!.x, -1);
  expect(Math.abs((byTargetLead[0].end?.x ?? 0) - geometry.target.front!.left)).toBeLessThan(8);
  expect(byTargetLead[1].start?.x).toBeCloseTo(byTargetLayer[1].end!.x, -1);
  expect(Math.abs((byTargetLead[1].end?.x ?? 0) - geometry.target.middle!.left)).toBeLessThan(8);
  expect(byTargetLead[2].start?.x).toBeCloseTo(byTargetLayer[2].end!.x, -1);
  expect(Math.abs((byTargetLead[2].end?.x ?? 0) - geometry.target.back!.left)).toBeLessThan(8);
}

async function expectPromotedStackFanoutPaint(
  page: Page,
  edgeId: string,
  expectedOrder: {
    frontBeforeBackX?: boolean;
    frontBeforeBackY?: boolean;
    breakoutDistanceGridUnits?: number;
  } = {},
): Promise<void> {
  const fanout = await page.locator(`.react-flow__edge[data-id="${edgeId}"]`).evaluate((edge) => {
    type Point = { x: number; y: number };

    function pathPoints(path: Element): Point[] {
      return [
        ...(path.getAttribute('d') ?? '').matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g),
      ].map((match) => ({
        x: Number(match[1]),
        y: Number(match[2]),
      }));
    }

    const layers = ['front', 'middle', 'back'] as const;
    const branches = layers.map((layer) => {
      const path = edge.querySelector(`.svsch-edge-stacked-side-${layer}`);
      const points = path ? pathPoints(path) : [];
      return {
        layer,
        className: path?.getAttribute('class'),
        stroke: path ? getComputedStyle(path).stroke : undefined,
        start: points[0],
        end: points[points.length - 1],
      };
    });
    const bar = edge.querySelector('.svsch-edge-stacked-breakout');
    const barPoints = bar ? pathPoints(bar) : [];
    const bridge = edge.querySelector('.svsch-edge-bridge');
    const bridgePoints = bridge ? pathPoints(bridge) : [];
    const target = bridgePoints[bridgePoints.length - 1];
    const gradient = edge.querySelector('linearGradient');
    const stops = [...(gradient?.querySelectorAll('stop') ?? [])].map((stop) => ({
      offset: stop.getAttribute('offset'),
      color: getComputedStyle(stop).getPropertyValue('stop-color'),
    }));

    return {
      branches,
      bar: {
        style: bar?.getAttribute('style'),
        start: barPoints[0],
        end: barPoints[barPoints.length - 1],
      },
      target,
      gradient: gradient
        ? {
            x1: Number(gradient.getAttribute('x1')),
            y1: Number(gradient.getAttribute('y1')),
            x2: Number(gradient.getAttribute('x2')),
            y2: Number(gradient.getAttribute('y2')),
          }
        : undefined,
      stops,
    };
  });

  const [front, middle, back] = fanout.branches;
  expect(front.className).toContain('svsch-edge-stacked-front');
  expect(middle.className).toContain('svsch-edge-stacked');
  expect(back.className).toContain('svsch-edge-stacked-back');
  expect(fanout.stops.map((stop) => stop.offset)).toEqual(['0%', '50%', '100%']);
  expect([front.stroke, middle.stroke, back.stroke]).toEqual(
    fanout.stops.map((stop) => stop.color),
  );
  expect(fanout.bar.style).toContain('url(');
  expect(fanout.bar.start).toEqual(front.start);
  expect(fanout.bar.end).toEqual(back.start);
  expect(fanout.gradient?.x1).toBeCloseTo(front.start.x, 3);
  expect(fanout.gradient?.y1).toBeCloseTo(front.start.y, 3);
  expect(fanout.gradient?.x2).toBeCloseTo(back.start.x, 3);
  expect(fanout.gradient?.y2).toBeCloseTo(back.start.y, 3);

  if (expectedOrder.breakoutDistanceGridUnits !== undefined) {
    const barCenter = {
      x: (fanout.bar.start.x + fanout.bar.end.x) / 2,
      y: (fanout.bar.start.y + fanout.bar.end.y) / 2,
    };
    const branchDx = middle.end.x - middle.start.x;
    const branchDy = middle.end.y - middle.start.y;
    const breakoutDistance =
      Math.abs(branchDx) >= Math.abs(branchDy)
        ? Math.abs(fanout.target.x - barCenter.x)
        : Math.abs(fanout.target.y - barCenter.y);
    expect(breakoutDistance).toBeCloseTo(
      diagramSizing.gridSize * expectedOrder.breakoutDistanceGridUnits,
      0,
    );
  }

  if (expectedOrder.frontBeforeBackX !== undefined) {
    if (expectedOrder.frontBeforeBackX) {
      expect(front.start.x).toBeLessThan(back.start.x);
    } else {
      expect(front.start.x).toBeGreaterThan(back.start.x);
    }
  }
  if (expectedOrder.frontBeforeBackY !== undefined) {
    if (expectedOrder.frontBeforeBackY) {
      expect(front.start.y).toBeLessThan(back.start.y);
    } else {
      expect(front.start.y).toBeGreaterThan(back.start.y);
    }
  }
}

async function expectConvergingStackEdgePaint(page: Page, edgeId: string): Promise<void> {
  const paint = await page.locator(`.react-flow__edge[data-id="${edgeId}"]`).evaluate((edge) => {
    type Point = { x: number; y: number };
    type LayerId = 'front' | 'middle' | 'back';

    function pathPoints(path: Element): Point[] {
      return [
        ...(path.getAttribute('d') ?? '').matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g),
      ].map((match) => ({
        x: Number(match[1]),
        y: Number(match[2]),
      }));
    }

    function layerFromClass(className: string): LayerId {
      if (className.includes('svsch-edge-stacked-front')) return 'front';
      if (className.includes('svsch-edge-stacked-back')) return 'back';
      return 'middle';
    }

    const paths = [...edge.querySelectorAll('.svsch-edge-stacked-converge')].map((path) => {
      const points = pathPoints(path);
      const className = path.getAttribute('class') ?? '';
      return {
        layer: layerFromClass(className),
        className,
        style: path.getAttribute('style') ?? '',
        start: points[0],
        end: points[points.length - 1],
      };
    });
    const gradients = [
      ...edge.querySelectorAll('linearGradient[id^="svsch-stack-converge-gradient"]'),
    ].map((gradient) => ({
      id: gradient.id,
      stops: [...gradient.querySelectorAll('stop')].map((stop) => ({
        offset: stop.getAttribute('offset'),
        className: stop.getAttribute('class'),
      })),
    }));

    return { paths, gradients };
  });

  expect(paint.paths).toHaveLength(3);
  expect(paint.gradients).toHaveLength(3);
  expect(
    paint.gradients.every(
      (gradient) => gradient.stops.map((stop) => stop.offset).join(',') === '0%,78%,100%',
    ),
  ).toBe(true);
  expect(
    paint.gradients.every(
      (gradient) => gradient.stops[1]?.className === 'svsch-stack-gradient-regular-stop',
    ),
  ).toBe(true);
  expect(paint.paths.every((path) => path.style.includes('url('))).toBe(true);

  const byLayer = Object.fromEntries(paint.paths.map((path) => [path.layer, path])) as Record<
    'front' | 'middle' | 'back',
    (typeof paint.paths)[number]
  >;
  expect(byLayer.front.className).toContain('svsch-edge-stacked-front');
  expect(byLayer.middle.className).toContain('svsch-edge-stacked');
  expect(byLayer.back.className).toContain('svsch-edge-stacked-back');
  expect(byLayer.front.start.y).toBeLessThan(byLayer.middle.start.y);
  expect(byLayer.middle.start.y).toBeLessThan(byLayer.back.start.y);
  expect(byLayer.front.start.x).toBeLessThan(byLayer.middle.start.x);
  expect(byLayer.middle.start.x).toBeLessThan(byLayer.back.start.x);
  expect(byLayer.front.end.x).toBeCloseTo(byLayer.middle.end.x, 3);
  expect(byLayer.back.end.x).toBeCloseTo(byLayer.middle.end.x, 3);
  expect(byLayer.front.end.y).not.toBeCloseTo(byLayer.middle.end.y, 0);
  expect(byLayer.back.end.y).not.toBeCloseTo(byLayer.middle.end.y, 0);
  expect(byLayer.front.end.y).toBeLessThan(byLayer.middle.end.y);
  expect(byLayer.back.end.y).toBeGreaterThan(byLayer.middle.end.y);
}

async function expectArrayStackSelectionCoversFullStack(page: Page, nodeId: string): Promise<void> {
  const geometry = await page.locator(`[data-node-id="${nodeId}"]`).evaluate((node) => {
    type Rect = {
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      height: number;
    };

    function rectFor(selector: string): Rect | undefined {
      const rect = node.querySelector(selector)?.getBoundingClientRect();
      if (!rect) return undefined;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    }

    return {
      selection: rectFor('.hdl-node-array-selection'),
      front: rectFor('.hdl-node-array-front'),
      middle: rectFor('.hdl-node-array-middle'),
      back: rectFor('.hdl-node-array-back'),
      hasMiddleMuxSelection: Boolean(
        node.querySelector(':scope > svg.mux-skin .node-skin-selection'),
      ),
    };
  });

  expect(geometry.selection).toBeDefined();
  expect(geometry.front).toBeDefined();
  expect(geometry.middle).toBeDefined();
  expect(geometry.back).toBeDefined();
  expect(geometry.selection!.left).toBeLessThanOrEqual(
    Math.min(geometry.front!.left, geometry.middle!.left, geometry.back!.left) + 0.5,
  );
  expect(geometry.selection!.top).toBeLessThanOrEqual(
    Math.min(geometry.front!.top, geometry.middle!.top, geometry.back!.top) + 0.5,
  );
  expect(geometry.selection!.right).toBeGreaterThanOrEqual(
    Math.max(geometry.front!.right, geometry.middle!.right, geometry.back!.right) - 0.5,
  );
  expect(geometry.selection!.bottom).toBeGreaterThanOrEqual(
    Math.max(geometry.front!.bottom, geometry.middle!.bottom, geometry.back!.bottom) - 0.5,
  );
  expect(geometry.hasMiddleMuxSelection).toBe(false);
}

async function expectMuxBodyMasksTopStackLead(page: Page, nodeId: string): Promise<void> {
  const clip = await page.locator(`[data-node-id="${nodeId}"]`).evaluate((node) => {
    const skin = node.querySelector('svg.mux-skin') as SVGSVGElement | null;
    const matrix = skin?.getScreenCTM();
    if (!skin || !matrix) {
      throw new Error('Unable to find mux skin geometry');
    }

    const width = skin.viewBox.baseVal.width || Number(skin.getAttribute('width'));
    const height = skin.viewBox.baseVal.height || Number(skin.getAttribute('height'));
    const rightTop = (height - Math.min(height, 48)) / 2;
    const localX = width / 2;
    const localY = rightTop * 0.5 + 16;
    const x = matrix.a * localX + matrix.c * localY + matrix.e;
    const y = matrix.b * localX + matrix.d * localY + matrix.f;

    return {
      x: Math.floor(x - 4),
      y: Math.floor(y - 4),
      width: 8,
      height: 8,
    };
  });

  const before = PNG.sync.read(await page.screenshot({ clip }));

  async function changedPixelsWhenHidden(css: string): Promise<number> {
    const style = await page.addStyleTag({ content: css });
    const after = PNG.sync.read(await page.screenshot({ clip }));
    await style.evaluate((node) => node.remove());

    let changedPixels = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      if (
        before.data[i] !== after.data[i] ||
        before.data[i + 1] !== after.data[i + 1] ||
        before.data[i + 2] !== after.data[i + 2] ||
        before.data[i + 3] !== after.data[i + 3]
      ) {
        changedPixels += 1;
      }
    }
    return changedPixels;
  }

  const topLeadChangedPixels = await changedPixelsWhenHidden(`
    [data-node-id="${nodeId}"] .svsch-array-stack-leads-top {
      visibility: hidden !important;
    }
  `);
  const edgeChangedPixels = await changedPixelsWhenHidden(`
    .react-flow__edge .svsch-edge,
    .react-flow__edge .svsch-edge-jump-halo {
      visibility: hidden !important;
    }
  `);
  const layerInfo = await page.locator(`[data-node-id="${nodeId}"]`).evaluate((node) => {
    const edgeSvg = document
      .querySelector('.react-flow__edge')
      ?.closest('svg') as SVGSVGElement | null;
    const nodeLayer = document.querySelector('.react-flow__nodes') as HTMLElement | null;
    const edgeLayer = document.querySelector('.react-flow__edges') as HTMLElement | null;
    return {
      edgeSvgZIndex: edgeSvg ? getComputedStyle(edgeSvg).zIndex : undefined,
      edgeLayerZIndex: edgeLayer ? getComputedStyle(edgeLayer).zIndex : undefined,
      nodeLayerZIndex: nodeLayer ? getComputedStyle(nodeLayer).zIndex : undefined,
      nodeZIndex: getComputedStyle(node.closest('.react-flow__node') as Element).zIndex,
    };
  });

  expect(layerInfo).toEqual({
    edgeSvgZIndex: '1',
    edgeLayerZIndex: '1',
    nodeLayerZIndex: '2',
    nodeZIndex: '2',
  });
  expect({ topLeadChangedPixels, edgeChangedPixels }).toEqual({
    topLeadChangedPixels: 0,
    edgeChangedPixels: 0,
  });
}

test.describe('mux visual rendering', () => {
  test('renders a ternary expression as a two-way mux', async ({ page }) => {
    const view = await openFixture(page, 'mux_ternary.sv');

    expect(view.nodes.filter((node) => node.kind === 'mux')).toHaveLength(1);
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator('.mux-skin')).toBeVisible();
    await expect(page.locator('.svsch-mux-select-port >> text=s')).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=1'b1")).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=1'b0")).toBeVisible();

    await expectGraphAndScreenshot(page, 'mux-ternary-node.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders nested ternaries as cascaded muxes', async ({ page }) => {
    const view = await openFixture(page, 'mux_nested_ternary.sv');
    const muxes = view.nodes.filter((node) => node.kind === 'mux');

    expect(muxes).toHaveLength(2);
    expect(
      view.edges.some(
        (edge) =>
          muxes.some((source) => source.id === edge.source) &&
          muxes.some((target) => target.id === edge.target),
      ),
    ).toBe(true);
    await expect(page.locator('[data-node-kind="mux"]')).toHaveCount(2);

    await expectGraphAndScreenshot(page, 'mux-nested-ternary.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a ternary mux feeding its containing ALU', async ({ page }) => {
    const view = await openFixture(page, 'mux_ternary_in_alu.sv');
    const mux = view.nodes.find((node) => node.kind === 'mux');
    const alu = view.nodes.find((node) => node.kind === 'alu');

    expect(mux).toBeDefined();
    expect(alu).toBeDefined();
    expect(view.edges.some((edge) => edge.source === mux?.id && edge.target === alu?.id)).toBe(
      true,
    );
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator('[data-node-kind="alu"]')).toBeVisible();

    await expectGraphAndScreenshot(page, 'mux-ternary-in-alu.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a mux node interpreted from SystemVerilog', async ({ page }) => {
    await openFixture(page, 'mux_only.sv', 'manual');

    // Assert ports and blocks
    await expect(page.locator('[data-node-kind="port"] >> text=sel')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=a')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=b')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=y')).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator('.mux-skin')).toBeVisible();
    await expect(page.locator('.svsch-mux-select-port >> text=s')).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=1'b0")).toBeVisible();
    await expect(page.locator('.svsch-mux-side-port >> text=default')).toBeVisible();

    await expectGraphAndScreenshot(page, 'mux-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-kind="mux"]'),
    });

    const mux = page.locator('[data-node-kind="mux"]');
    await mux.click();
    await expect(mux.locator('.node-skin-selection')).toHaveCSS('opacity', '1');
    await expect(mux.locator('.hdl-node-selection-rect')).toHaveCount(0);
  });

  test('renders a connected mux canvas interpreted from SystemVerilog', async ({ page }) => {
    await openFixture(page, 'mux_wired.sv');

    await expect(page.locator('[data-node-kind="port"] >> text=sel')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=a')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=b')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=y')).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=1'b0")).toBeVisible();
    await expect(page.locator('.svsch-mux-side-port >> text=default')).toBeVisible();

    await expectGraphAndScreenshot(page, 'mux-wired-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders muxes with different input counts', async ({ page }) => {
    await openFixture(page, 'mux_three_inputs.sv');

    await expect(page.locator('[data-node-kind="port"] >> text=sel')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=a')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=b')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=c')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=y')).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=2'd0")).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=2'd1")).toBeVisible();
    await expect(page.locator('.svsch-mux-side-port >> text=default')).toBeVisible();

    await expectGraphAndScreenshot(page, 'mux-three-inputs-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders long mux signal names in the full webview', async ({ page }) => {
    await openFixture(page, 'mux_long_names.sv');

    await expect(
      page.locator('[data-node-kind="port"] >> text=select_between_pipeline_values'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-kind="port"] >> text=somewhat_long_input_name_a'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-kind="port"] >> text=another_long_input_name_b'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-kind="port"] >> text=fallback_path_with_extra_words'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-kind="port"] >> text=output_value_with_long_name'),
    ).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=2'd0")).toBeVisible();
    await expect(page.locator(".svsch-mux-side-port >> text=2'd1")).toBeVisible();
    await expect(page.locator('.svsch-mux-side-port >> text=default')).toBeVisible();

    await expectGraphAndScreenshot(page, 'mux-long-names-webview.png', {
      fullPage: true,
      maxDiffPixels: SNAPSHOT_THRESHOLDS.playwright.visual.muxLongNames,
    });
  });

  test(
    'renders a mux with complex literal expressions on side ports ' + '(write-enable decode case)',
    async ({ page }) => {
      await openFixture(page, 'write_enable_decode.sv');
      await page.waitForSelector('[data-node-kind="mux"]');
      await waitForViewportTransformToSettle(page);

      await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
      await expect(page.locator('.svsch-mux-side-port >> text="{BYTE, 2\'d0}"')).toBeVisible();
      await expect(page.locator('.svsch-mux-side-port >> text=default')).toBeVisible();

      await expectGraphAndScreenshot(page, 'mux-complex-case-literal.png', {
        clip: await paddedLocatorClip(page, '[data-node-kind="mux"]'),
      });
    },
  );
});

test.describe('register visual rendering', () => {
  test('renders a register with recovered clock and reset ports', async ({ page }) => {
    await openFixture(page, 'register_async_reset.sv', 'register');

    await expect(page.locator('[data-node-kind="register"]')).toBeVisible();
    await expect(page.locator('.svsch-register-clock-port')).toBeVisible();
    await expect(page.locator('.svsch-register-reset-port')).toBeVisible();
    await expect(page.locator('.svsch-register-reset-label >> text=R')).toBeVisible();

    await expectGraphAndScreenshot(page, 'register-async-reset-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-kind="register"]'),
    });
  });

  test('renders a register with active-low reset bar', async ({ page }) => {
    await openFixture(page, 'register_active_low_reset.sv', 'register');

    await expect(page.locator('[data-node-kind="register"]')).toBeVisible();
    await expect(page.locator('.svsch-register-reset-port')).toBeVisible();
    await expect(page.locator('.svsch-register-reset-label >> text=R\u0305')).toBeVisible();

    await expectGraphAndScreenshot(page, 'register-active-low-reset-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-kind="register"]'),
      maxDiffPixels: SNAPSHOT_THRESHOLDS.playwright.visual.default,
    });
  });

  test('renders a register without reset', async ({ page }) => {
    await openFixture(page, 'register_no_reset.sv', 'register');

    await expect(page.locator('[data-node-kind="register"]')).toBeVisible();
    await expect(page.locator('.svsch-register-clock-port')).toBeVisible();
    await expect(page.locator('.svsch-register-reset-port')).not.toBeVisible();

    await expectGraphAndScreenshot(page, 'register-no-reset-node.png', {
      clip: await paddedLocatorClip(page, '[data-node-kind="register"]'),
    });
  });

  test('renders a clock-enabled register with feedback mux and reset', async ({ page }) => {
    await openFixture(page, 'register_clock_enable.sv', 'register-enable');

    await expect(page.locator('[data-node-kind="register"]')).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]')).toBeVisible();
    await expect(page.locator('.svsch-register-clock-port')).toBeVisible();
    await expect(page.locator('.svsch-register-reset-port')).toBeVisible();
    await expect(page.locator('.svsch-mux-select-port >> text=s')).toBeVisible();
    await expect(page.locator('.svsch-mux-side-port >> text=true')).toBeVisible();
    await expect(page.locator('.svsch-mux-side-port >> text=false')).toBeVisible();

    await expectGraphAndScreenshot(page, 'register-clock-enable-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders an array register with isometric stacking layers and a dimension badge', async ({
    page,
  }) => {
    // Wider viewport so the multi-mux chain fits without being cut off by
    // paddedClipFromBox clamping
    await page.setViewportSize({ width: 2200, height: 1100 });
    const view = await openFixture(page, 'array_register.sv', 'register');
    // The clock is auto-cut on first open (see withFirstOpenAutoCutEdges), so
    // its stacked fanout now lives on the cut-stub edge running from the cut
    // label into the register rather than straight from the clk port.
    const clockStorageEdge = view.edges.find(
      (edge) =>
        edge.target === 'reg:array_register:M' && edge.targetPort === 'clk' && edge.isStacked,
    );
    const resetSelectEdge = view.edges.find(
      (edge) =>
        edge.source === 'port:array_register:rst' && edge.targetPort === 'sel' && edge.isStacked,
    );

    await expect(page.locator('[data-node-kind="register"]')).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]').first()).toBeVisible();
    await expect(page.locator('.hdl-node-array').first()).toBeVisible();
    await expect(page.locator('.hdl-node-array-layer').first()).toBeVisible();
    expect(clockStorageEdge).toBeDefined();
    expect(resetSelectEdge).toBeDefined();
    await expectPromotedStackFanoutPaint(page, clockStorageEdge!.id, {
      breakoutDistanceGridUnits: 1,
    });
    await expectPromotedStackFanoutPaint(page, resetSelectEdge!.id, {
      breakoutDistanceGridUnits: 2,
    });

    await fitGraphView(page);
    await expectGraphAndScreenshot(page, 'array-register-canvas.png', {
      clip: await paddedGraphClip(page),
    });
    // Close-up with extra bottom padding to capture the leads extending below the R port
    const regBox = await page
      .locator('[data-node-id="reg:array_register:M"]')
      .first()
      .boundingBox();
    if (!regBox) throw new Error('Register node not found');
    const viewport = page.viewportSize() ?? { width: 900, height: 640 };
    const nodePad = 24;
    const bottomPad = 72;
    const nodeClip = {
      x: Math.max(0, Math.floor(regBox.x - nodePad)),
      y: Math.max(0, Math.floor(regBox.y - nodePad)),
      width:
        Math.min(viewport.width, Math.ceil(regBox.x + regBox.width + nodePad)) -
        Math.max(0, Math.floor(regBox.x - nodePad)),
      height:
        Math.min(viewport.height, Math.ceil(regBox.y + regBox.height + bottomPad)) -
        Math.max(0, Math.floor(regBox.y - nodePad)),
    };
    await expectGraphAndScreenshot(page, 'array-register-node.png', { clip: nodeClip });
  });

  test('renders a whole-array reset as a stacked register reset', async ({ page }) => {
    const view = await openFixture(page, 'array_complete_reset.sv', 'register');
    // Clock and reset are auto-cut on first open (see withFirstOpenAutoCutEdges),
    // so their stacked fanout now lives on the cut-stub edges running from the
    // cut labels into the register rather than straight from the ports.
    const clockStorageEdge = view.edges.find(
      (edge) =>
        edge.target === 'reg:array_complete_reset:arr' &&
        edge.targetPort === 'clk' &&
        edge.isStacked,
    );
    const resetStorageEdge = view.edges.find(
      (edge) =>
        edge.target === 'reg:array_complete_reset:arr' &&
        edge.targetPort === 'rst' &&
        edge.isStacked,
    );

    await expect(page.locator('[data-node-kind="register"]')).toBeVisible();
    await expect(page.locator('.hdl-node-array').first()).toBeVisible();
    await expect(page.locator('.svsch-register-reset-port >> text=R')).toBeVisible();
    expect(clockStorageEdge).toBeDefined();
    expect(resetStorageEdge).toBeDefined();
    await expectPromotedStackFanoutPaint(page, clockStorageEdge!.id, {
      breakoutDistanceGridUnits: 1,
    });
    await expectPromotedStackFanoutPaint(page, resetStorageEdge!.id, {
      breakoutDistanceGridUnits: 1,
    });

    await expectGraphAndScreenshot(page, 'array-complete-reset-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders an array input through a stacked register to an array output', async ({ page }) => {
    const view = await openFixture(page, 'array_port_register.sv', 'register');

    expect(
      view.nodes.some(
        (node) =>
          node.id === 'port:array_port_register:in_data' &&
          (node.isArrayNode || node.metadata?.isArrayNode),
      ),
    ).toBe(true);
    expect(
      view.nodes.some(
        (node) =>
          node.id === 'reg:array_port_register:storage' &&
          (node.isArrayNode || node.metadata?.isArrayNode),
      ),
    ).toBe(true);
    expect(
      view.nodes.some(
        (node) =>
          node.id === 'port:array_port_register:out_data' &&
          (node.isArrayNode || node.metadata?.isArrayNode),
      ),
    ).toBe(true);
    expect(
      view.edges.some(
        (edge) =>
          edge.source === 'port:array_port_register:in_data' &&
          edge.target === 'reg:array_port_register:storage' &&
          edge.isStacked,
      ),
    ).toBe(true);
    expect(
      view.edges.some(
        (edge) =>
          edge.source === 'reg:array_port_register:storage' &&
          edge.target === 'port:array_port_register:out_data' &&
          edge.isStacked,
      ),
    ).toBe(true);
    // The clock is auto-cut on first open (see withFirstOpenAutoCutEdges), so
    // its stacked fanout now lives on the cut-stub edge running from the cut
    // label into the register rather than straight from the clk port.
    expect(
      view.edges.some(
        (edge) =>
          edge.target === 'reg:array_port_register:storage' &&
          edge.targetPort === 'clk' &&
          edge.isStacked,
      ),
    ).toBe(true);
    const dataInputEdge = view.edges.find(
      (edge) =>
        edge.source === 'port:array_port_register:in_data' &&
        edge.target === 'reg:array_port_register:storage' &&
        edge.isStacked,
    );
    const dataOutputEdge = view.edges.find(
      (edge) =>
        edge.source === 'reg:array_port_register:storage' &&
        edge.target === 'port:array_port_register:out_data' &&
        edge.isStacked,
    );
    const clockStorageEdge = view.edges.find(
      (edge) =>
        edge.target === 'reg:array_port_register:storage' &&
        edge.targetPort === 'clk' &&
        edge.isStacked,
    );
    expect(dataInputEdge).toBeDefined();
    expect(dataOutputEdge).toBeDefined();
    expect(clockStorageEdge).toBeDefined();

    await expect(
      page.locator('[data-node-id="port:array_port_register:in_data"].hdl-node-array'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-id="reg:array_port_register:storage"].hdl-node-array'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-id="port:array_port_register:out_data"].hdl-node-array'),
    ).toBeVisible();
    await expect(
      page.locator('[data-node-id="port:array_port_register:in_data"] .port-skin-array-layer'),
    ).toHaveCount(2);
    await expect(
      page.locator('[data-node-id="port:array_port_register:out_data"] .port-skin-array-layer'),
    ).toHaveCount(2);
    await expect(
      page.locator(
        '[data-node-id="reg:array_port_register:storage"] .svsch-array-stack-lead-target-left',
      ),
    ).toHaveCount(6);
    await expect(
      page.locator(
        '[data-node-id="reg:array_port_register:storage"] .svsch-array-stack-lead-source-right',
      ),
    ).toHaveCount(3);
    await expect(
      page.locator(
        '[data-node-id="port:array_port_register:in_data"] .svsch-array-stack-lead-source-right',
      ),
    ).toHaveCount(3);
    await expect(
      page.locator(
        '[data-node-id="port:array_port_register:out_data"] .svsch-array-stack-lead-target-left',
      ),
    ).toHaveCount(3);
    expect(
      await page.locator('.svsch-edge-stacked-back, .svsch-edge-stacked-front').count(),
    ).toBeGreaterThanOrEqual(4);
    await expectStackedEdgeSegmentsOrthogonal(page);
    await expectArrayStackEdgeLanes(page, dataInputEdge!.id, ARRAY_STACK_WIDE_LANE_OFFSET);
    await expectArrayStackEdgeLanes(page, dataOutputEdge!.id, ARRAY_STACK_WIDE_LANE_OFFSET);
    await expectArrayStackEdgeLayerCoordinates(
      page,
      dataInputEdge!.id,
      'port:array_port_register:in_data',
      'reg:array_port_register:storage',
    );
    await expectArrayStackEdgeLayerCoordinates(
      page,
      dataOutputEdge!.id,
      'reg:array_port_register:storage',
      'port:array_port_register:out_data',
    );
    await expectPromotedStackFanoutPaint(page, clockStorageEdge!.id, {
      breakoutDistanceGridUnits: 1,
    });

    await expectGraphAndScreenshot(page, 'array-port-register-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a variable-index array read as a flat mux fed by converging stacked wires', async ({
    page,
  }) => {
    const view = await openFixture(page, 'array_address_read.sv', 'array-address-read');

    const arrayPort = view.nodes.find((node) => node.id === 'port:array_address_read:M');
    const readMux = view.nodes.find((node) => node.kind === 'mux' && node.label === 'read');
    const outputPort = view.nodes.find((node) => node.id === 'port:array_address_read:read_data');
    const arrayReadEdge = view.edges.find(
      (edge) => edge.source === arrayPort?.id && edge.target === readMux?.id && edge.isStacked,
    );
    const selectorEdge = view.edges.find(
      (edge) =>
        edge.source === 'port:array_address_read:address' &&
        edge.target === readMux?.id &&
        edge.targetPort === 'sel',
    );
    const outputEdge = view.edges.find(
      (edge) =>
        edge.source === readMux?.id &&
        edge.target === outputPort?.id &&
        edge.signal === 'read_data',
    );

    expect(arrayPort?.isArrayNode ?? arrayPort?.metadata?.isArrayNode).toBe(true);
    expect(readMux).toBeDefined();
    expect(readMux?.isArrayNode ?? readMux?.metadata?.isArrayNode).toBeFalsy();
    expect(outputPort?.isArrayNode ?? outputPort?.metadata?.isArrayNode).toBeFalsy();
    expect(arrayReadEdge).toBeDefined();
    expect(selectorEdge).toBeDefined();
    expect(selectorEdge?.isStacked).toBeFalsy();
    expect(outputEdge).toBeDefined();
    expect(outputEdge?.isStacked).toBeFalsy();

    await expect(page.locator(`[data-node-id="${arrayPort!.id}"].hdl-node-array`)).toBeVisible();
    await expect(page.locator(`[data-node-id="${readMux!.id}"].hdl-node-mux`)).toBeVisible();
    await expect(page.locator(`[data-node-id="${readMux!.id}"]`)).not.toHaveClass(/hdl-node-array/);
    await expect(
      page.locator(`[data-node-id="${readMux!.id}"] .svsch-mux-select-port`, { hasText: 's' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${readMux!.id}"] .svsch-mux-side-port`, { hasText: 'in' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${arrayPort!.id}"] .svsch-array-stack-lead-source-right`),
    ).toHaveCount(3);
    await expect(
      page.locator(`[data-node-id="${readMux!.id}"] .svsch-array-stack-lead-target-left`),
    ).toHaveCount(3);
    await expect(
      page.locator(
        `.react-flow__edge[data-id="${arrayReadEdge!.id}"] .svsch-edge-stacked-converge`,
      ),
    ).toHaveCount(3);
    await expectConvergingStackEdgePaint(page, arrayReadEdge!.id);
    await expectStackedEdgeSegmentsOrthogonal(page);

    await expectGraphAndScreenshot(page, 'array-address-read-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a scalar write through a stacked address mux into an array register', async ({
    page,
  }) => {
    const view = await openFixture(page, 'array_address_write_register.sv', 'array-address-write');

    const addrMux = view.nodes.find(
      (node) =>
        node.kind === 'mux' &&
        (node.isArrayNode || node.metadata?.isArrayNode) &&
        node.ports.some((port) => port.name === 'sel' && port.connectedSignal === 'address'),
    );
    const arrayReg = view.nodes.find(
      (node) => node.id === 'reg:array_address_write_register:storage',
    );
    const addressSelectEdge = view.edges.find(
      (edge) =>
        edge.source === 'port:array_address_write_register:address' &&
        edge.target === addrMux?.id &&
        edge.targetPort === 'sel' &&
        edge.isStacked,
    );
    // The clock is auto-cut on first open (see withFirstOpenAutoCutEdges), so
    // its stacked fanout now lives on the cut-stub edge running from the cut
    // label into the register rather than straight from the clk port.
    const clockStorageEdge = view.edges.find(
      (edge) => edge.target === arrayReg?.id && edge.targetPort === 'clk' && edge.isStacked,
    );
    expect(addrMux).toBeDefined();
    expect(
      addrMux?.ports.some((port) => port.label === "2'b0" && port.connectedSignal === 'in_data'),
    ).toBe(true);
    expect(
      addrMux?.ports.some((port) => port.label === 'default' && port.connectedSignal === 'storage'),
    ).toBe(true);
    expect(addressSelectEdge).toBeDefined();
    expect(clockStorageEdge).toBeDefined();
    expect(
      view.edges.some(
        (edge) =>
          edge.source === 'port:array_address_write_register:in_data' &&
          edge.target === addrMux?.id &&
          edge.isStacked,
      ),
    ).toBe(true);
    // The register's own declared "storage" output net is auto-cut on first
    // open (see withFirstOpenAutoCutEdges), so its stacked fanout into addrMux
    // now lives on a cut-stub edge sourced from its cut label.
    expect(
      view.edges.some(
        (edge) =>
          (edge.source === arrayReg?.id || edge.source?.startsWith(`cut-label:${arrayReg?.id}:`)) &&
          edge.target === addrMux?.id &&
          edge.isStacked,
      ),
    ).toBe(true);
    expect(
      view.edges.some(
        (edge) => edge.source === addrMux?.id && edge.target === arrayReg?.id && edge.isStacked,
      ),
    ).toBe(true);

    await expect(
      page.locator(`[data-node-id="${addrMux!.id}"].hdl-node-mux.hdl-node-array`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${addrMux!.id}"] .svsch-mux-select-port`, { hasText: 's[]' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${addrMux!.id}"] .svsch-array-stack-lead-target-top`),
    ).toHaveCount(3);
    const muxTopLeadLayering = await page
      .locator(`[data-node-id="${addrMux!.id}"]`)
      .evaluate((node) => {
        const topLeadLayer = node.querySelector(
          '.svsch-array-stack-leads-target.svsch-array-stack-leads-top',
        );
        const backSkinLayer = node.querySelector('.hdl-node-array-back');
        const middleSkinLayer = node.querySelector('.hdl-node-array-middle');
        const frontSkinLayer = node.querySelector('.hdl-node-array-front');
        if (!topLeadLayer || !backSkinLayer || !middleSkinLayer || !frontSkinLayer) {
          return undefined;
        }
        const follows = (a: Element, b: Element) =>
          Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          topLeadBeforeBack: follows(topLeadLayer, backSkinLayer),
          backBeforeMiddle: follows(backSkinLayer, middleSkinLayer),
          middleBeforeFront: follows(middleSkinLayer, frontSkinLayer),
        };
      });
    expect(muxTopLeadLayering).toEqual({
      topLeadBeforeBack: true,
      backBeforeMiddle: true,
      middleBeforeFront: true,
    });
    await expectMuxBodyMasksTopStackLead(page, addrMux!.id);
    await expect(
      page.locator(`[data-node-id="${addrMux!.id}"] .svsch-array-stack-lead-target-left`),
    ).toHaveCount(6);
    await expect(
      page.locator(`[data-node-id="${addrMux!.id}"] .svsch-array-stack-lead-source-right`),
    ).toHaveCount(3);
    // Libavoid may place the fanout junction directly on the source pin, where
    // there is no interior branch point to mark. Any visible stacked junction
    // must still contain a complete three-layer marker.
    expect((await page.locator('.svsch-edge-junction-stacked-dot').count()) % 3).toBe(0);
    await expectStackedEdgeSegmentsOrthogonal(page);
    await expectPromotedStackFanoutPaint(page, addressSelectEdge!.id, {
      frontBeforeBackX: true,
      frontBeforeBackY: true,
      breakoutDistanceGridUnits: 2,
    });
    await expectPromotedStackFanoutPaint(page, clockStorageEdge!.id, {
      frontBeforeBackY: true,
      breakoutDistanceGridUnits: 1,
    });

    await expectGraphAndScreenshot(page, 'array-address-write-register-canvas.png', {
      clip: await paddedGraphClip(page, 112),
    });
  });

  test('renders selected stack outlines for array address mux and storage register', async ({
    page,
  }) => {
    const view = await openFixture(page, 'array_address_write_register.sv', 'array-address-write');

    const addrMux = view.nodes.find(
      (node) =>
        node.kind === 'mux' &&
        (node.isArrayNode || node.metadata?.isArrayNode) &&
        node.ports.some((port) => port.name === 'sel' && port.connectedSignal === 'address'),
    );
    const arrayReg = view.nodes.find(
      (node) => node.id === 'reg:array_address_write_register:storage',
    );
    expect(addrMux).toBeDefined();
    expect(arrayReg).toBeDefined();

    await expectArrayStackSelectionCoversFullStack(page, addrMux!.id);
    const muxStack = page.locator(`[data-node-id="${addrMux!.id}"]`);
    await muxStack.focus();
    await expect(muxStack.locator('.hdl-node-array-selection')).toHaveCSS('opacity', '1');
    await expectGraphAndScreenshot(page, 'array-address-write-mux-stack-selection.png', {
      clip: await paddedLocatorClip(page, `[data-node-id="${addrMux!.id}"]`),
    });

    await expectArrayStackSelectionCoversFullStack(page, arrayReg!.id);
    const regStack = page.locator(`[data-node-id="${arrayReg!.id}"]`);
    await regStack.focus();
    await expect(regStack.locator('.hdl-node-array-selection')).toHaveCSS('opacity', '1');
    await expectGraphAndScreenshot(page, 'array-address-write-register-stack-selection.png', {
      clip: await paddedLocatorClip(page, `[data-node-id="${arrayReg!.id}"]`),
    });
  });

  test(
    'renders a stacked write-enable mux chained upstream of the stacked ' +
      'address mux for a conditional array write',
    async ({ page }) => {
      const view = await openFixture(page, 'array_address_write_enable_register.sv', 'auto');

      const writeEnMux = view.nodes.find(
        (node) =>
          node.kind === 'mux' &&
          (node.isArrayNode || node.metadata?.isArrayNode) &&
          node.ports.some((port) => port.name === 'sel' && port.connectedSignal === 'write_en'),
      );
      const addrMux = view.nodes.find(
        (node) =>
          node.kind === 'mux' &&
          (node.isArrayNode || node.metadata?.isArrayNode) &&
          node.ports.some((port) => port.name === 'sel' && port.connectedSignal === 'address'),
      );
      const arrayReg = view.nodes.find(
        (node) => node.id === 'reg:array_address_write_enable_register:storage',
      );

      expect(writeEnMux).toBeDefined();
      expect(addrMux).toBeDefined();
      expect(arrayReg).toBeDefined();

      // write_en mux: true=in_data (write data), false=storage (hold whole array when disabled)
      expect(
        writeEnMux?.ports.some(
          (port) => port.name === 'true' && port.connectedSignal === 'in_data',
        ),
      ).toBe(true);
      expect(
        writeEnMux?.ports.some(
          (port) => port.name === 'false' && port.connectedSignal === 'storage',
        ),
      ).toBe(true);
      // addr mux: default=storage (hold unaddressed elements)
      expect(
        addrMux?.ports.some(
          (port) => port.label === 'default' && port.connectedSignal === 'storage',
        ),
      ).toBe(true);

      // The register's own declared "storage" output net (and the clock feeding
      // it) are auto-cut on first open (see withFirstOpenAutoCutEdges), so a
      // source node's stacked fanout may now live on a cut-stub edge running
      // from that source's cut label rather than straight from the node —
      // matched here by allowing the source to be a cut label of `sourceId`.
      const findStackedEdge = (sourceId: string | undefined, targetId: string | undefined) =>
        view.edges.find(
          (edge) =>
            (edge.source === sourceId || edge.source?.startsWith(`cut-label:${sourceId}:`)) &&
            edge.target === targetId &&
            edge.isStacked,
        );

      // write_en mux output feeds the addr mux's addressed-write input (stacked chain)
      const writeEnToAddrEdge = findStackedEdge(writeEnMux?.id, addrMux?.id);
      expect(writeEnToAddrEdge).toBeDefined();
      // addr mux output feeds the array register
      expect(findStackedEdge(addrMux?.id, arrayReg?.id)).toBeDefined();
      // storage Q feeds both muxes' hold inputs
      expect(findStackedEdge(arrayReg?.id, writeEnMux?.id)).toBeDefined();
      expect(findStackedEdge(arrayReg?.id, addrMux?.id)).toBeDefined();

      // Scalar inputs promoted to stacked on entry to each stacked mux
      const writeEnSelectEdge = view.edges.find(
        (edge) =>
          edge.source === 'port:array_address_write_enable_register:write_en' &&
          edge.target === writeEnMux?.id &&
          edge.targetPort === 'sel' &&
          edge.isStacked,
      );
      const addressSelectEdge = view.edges.find(
        (edge) =>
          edge.source === 'port:array_address_write_enable_register:address' &&
          edge.target === addrMux?.id &&
          edge.targetPort === 'sel' &&
          edge.isStacked,
      );
      const inDataEdge = view.edges.find(
        (edge) =>
          edge.source === 'port:array_address_write_enable_register:in_data' &&
          edge.target === writeEnMux?.id &&
          edge.isStacked,
      );
      const clockStorageEdge = view.edges.find(
        (edge) => edge.target === arrayReg?.id && edge.targetPort === 'clk' && edge.isStacked,
      );
      expect(writeEnSelectEdge).toBeDefined();
      expect(addressSelectEdge).toBeDefined();
      expect(inDataEdge).toBeDefined();
      expect(clockStorageEdge).toBeDefined();

      // Both muxes render as stacked array nodes with isometric layers
      await expect(
        page.locator(`[data-node-id="${writeEnMux!.id}"].hdl-node-mux.hdl-node-array`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-node-id="${addrMux!.id}"].hdl-node-mux.hdl-node-array`),
      ).toBeVisible();

      // Each stacked mux has 3 layer leads at the top (front / middle / back)
      await expect(
        page.locator(`[data-node-id="${writeEnMux!.id}"] .svsch-array-stack-lead-target-top`),
      ).toHaveCount(3);
      await expect(
        page.locator(`[data-node-id="${addrMux!.id}"] .svsch-array-stack-lead-target-top`),
      ).toHaveCount(3);

      // Addr mux selector is 2-bit (address [1:0]) so shows 's[]'
      await expect(
        page.locator(`[data-node-id="${addrMux!.id}"] .svsch-mux-select-port`, { hasText: 's[]' }),
      ).toBeVisible();

      await expectMuxBodyMasksTopStackLead(page, writeEnMux!.id);
      await expectMuxBodyMasksTopStackLead(page, addrMux!.id);
      await expectStackedEdgeSegmentsOrthogonal(page);
      await expectPromotedStackFanoutPaint(page, writeEnSelectEdge!.id, {
        breakoutDistanceGridUnits: 2,
      });
      await expectPromotedStackFanoutPaint(page, addressSelectEdge!.id, {
        breakoutDistanceGridUnits: 2,
      });
      await expectPromotedStackFanoutPaint(page, inDataEdge!.id, { breakoutDistanceGridUnits: 1 });
      await expectPromotedStackFanoutPaint(page, clockStorageEdge!.id, {
        breakoutDistanceGridUnits: 1,
      });

      await expectGraphAndScreenshot(page, 'array-address-write-enable-register-canvas.png', {
        clip: await paddedGraphClip(page),
      });
    },
  );

  test('renders a full-range zero reset loop on the stacked array register', async ({ page }) => {
    const view = await openFixture(page, 'array_multi_index_write_reset_sorts_first.sv', 'auto');

    const arrayReg = view.nodes.find(
      (node) => node.id === 'reg:array_multi_index_write_reset_sorts_first:storage',
    );
    const addressMuxes = view.nodes.filter((node) =>
      node.id.startsWith('mux:array_multi_index_write_reset_sorts_first:storage_addr'),
    );
    const finalMux = view.nodes.find(
      (node) => node.id === 'mux:array_multi_index_write_reset_sorts_first:storage_addr',
    );
    const resetEdge = view.edges.find(
      (edge) => edge.signal === 'reset' && edge.target === arrayReg?.id,
    );

    expect(arrayReg).toBeDefined();
    expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);
    expect(arrayReg?.ports.some((port) => port.name === 'reset')).toBe(true);
    expect(arrayReg?.ports.some((port) => port.name === 'RV')).toBe(false);
    expect(addressMuxes).toHaveLength(1);
    expect(finalMux?.ports.find((port) => port.name === 'sel')?.connectedSignal).toBe('address');
    expect(view.nodes.some((node) => node.kind === 'mux' && node.label === 'if reset')).toBe(false);
    expect(resetEdge?.isStacked).toBe(true);
    expect(
      view.edges.some(
        (edge) => edge.source === finalMux?.id && edge.target === arrayReg?.id && edge.isStacked,
      ),
    ).toBe(true);

    await expect(page.locator(`[data-node-id="${arrayReg!.id}"].hdl-node-array`)).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${finalMux!.id}"].hdl-node-mux.hdl-node-array`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${arrayReg!.id}"] .svsch-register-reset-port`, { hasText: 'R' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${finalMux!.id}"] .svsch-mux-select-port`, { hasText: 's[]' }),
    ).toBeVisible();

    await expectStackedEdgeSegmentsOrthogonal(page);
    await expectGraphAndScreenshot(page, 'array-multi-index-write-reset-sorts-first-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders RV for a non-zero full-range reset loop', async ({ page }) => {
    const view = await openFixture(page, 'array_multi_index_write_reset_nonzero.sv', 'auto');
    const arrayReg = view.nodes.find(
      (node) => node.id === 'reg:array_multi_index_write_reset_nonzero:storage',
    );
    const resetEdge = view.edges.find(
      (edge) => edge.signal === 'reset' && edge.target === arrayReg?.id,
    );
    const resetValueEdge = view.edges.find(
      (edge) => edge.signal === "32'hDEADBEEF" && edge.target === arrayReg?.id,
    );

    expect(arrayReg?.ports.some((port) => port.name === 'reset')).toBe(true);
    expect(arrayReg?.ports.find((port) => port.name === 'RV')?.connectedSignal).toBe(
      "32'hDEADBEEF",
    );
    expect(resetEdge?.isStacked).toBe(true);
    expect(resetValueEdge?.isStacked).toBe(true);
    expect(
      view.nodes.filter((node) =>
        node.id.startsWith('mux:array_multi_index_write_reset_nonzero:storage_addr'),
      ),
    ).toHaveLength(1);

    await expect(
      page.locator(`[data-node-id="${arrayReg!.id}"] .svsch-register-reset-port`, { hasText: 'R' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${arrayReg!.id}"] text`, { hasText: 'RV' }),
    ).toBeVisible();
    await expectStackedEdgeSegmentsOrthogonal(page);
    await expectGraphAndScreenshot(page, 'array-multi-index-write-reset-nonzero-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a full-range descending reset loop on the stacked array register', async ({
    page,
  }) => {
    // storage[a] <= 0 for a counting down from 31 to 0 covers the full array just like the
    // ascending 0..N-1 form — only the direction differs — so it folds into the same
    // register R port + single addr-mux structure as the ascending canonical case.
    const view = await openFixture(page, 'array_multi_index_write_reset_descending.sv', 'auto');

    const arrayReg = view.nodes.find(
      (node) => node.id === 'reg:array_multi_index_write_reset_descending:storage',
    );
    const addressMuxes = view.nodes.filter((node) =>
      node.id.startsWith('mux:array_multi_index_write_reset_descending:storage_addr'),
    );
    const finalMux = view.nodes.find(
      (node) => node.id === 'mux:array_multi_index_write_reset_descending:storage_addr',
    );
    const resetEdge = view.edges.find(
      (edge) => edge.signal === 'reset' && edge.target === arrayReg?.id,
    );

    expect(arrayReg).toBeDefined();
    expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);
    expect(arrayReg?.ports.some((port) => port.name === 'reset')).toBe(true);
    expect(arrayReg?.ports.some((port) => port.name === 'RV')).toBe(false);
    expect(addressMuxes).toHaveLength(1);
    expect(finalMux?.ports.find((port) => port.name === 'sel')?.connectedSignal).toBe('address');
    expect(view.nodes.some((node) => node.kind === 'mux' && node.label === 'if reset')).toBe(false);
    expect(resetEdge?.isStacked).toBe(true);
    expect(
      view.edges.some(
        (edge) => edge.source === finalMux?.id && edge.target === arrayReg?.id && edge.isStacked,
      ),
    ).toBe(true);

    await expect(page.locator(`[data-node-id="${arrayReg!.id}"].hdl-node-array`)).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${finalMux!.id}"].hdl-node-mux.hdl-node-array`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${arrayReg!.id}"] .svsch-register-reset-port`, { hasText: 'R' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-node-id="${finalMux!.id}"] .svsch-mux-select-port`, { hasText: 's[]' }),
    ).toBeVisible();

    await expectStackedEdgeSegmentsOrthogonal(page);
    await expectGraphAndScreenshot(page, 'array-multi-index-write-reset-descending-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });
});

test.describe('bus visual rendering', () => {
  test('renders a bus with one breakout', async ({ page }) => {
    const view = await openFixture(page, 'bus_one_tap.sv', 'bus');

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }

    await expectGraphAndScreenshot(page, 'bus-one-tap-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a bus with two breakouts', async ({ page }) => {
    const view = await openFixture(page, 'bus_two_taps.sv', 'bus');

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }

    await expectGraphAndScreenshot(page, 'bus-two-taps-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders a bus with three overlapping breakouts', async ({ page }) => {
    const view = await openFixture(page, 'bus_three_taps.sv', 'bus');

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }

    await expectGraphAndScreenshot(page, 'bus-three-taps-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });
});

test.describe('struct visual rendering', () => {
  test('renders a packed struct breakout with field annotations and a thick aggregate net', async ({
    page,
  }) => {
    await openFixture(page, 'struct_breakout.sv', 'struct');

    await expect(page.locator('[data-node-kind="struct"]')).toBeVisible();
    await expect(
      page.locator('.hdl-struct-node .svsch-bus-tap', { hasText: 'opcode' }),
    ).toBeVisible();
    await expect(
      page.locator('.hdl-struct-node .svsch-bus-tap', { hasText: '[6:3]' }),
    ).toBeVisible();
    await expect(
      page.locator('.hdl-struct-node .svsch-bus-tap', { hasText: 'lane' }),
    ).toBeVisible();
    await expect(
      page.locator('.hdl-struct-node .svsch-bus-tap', { hasText: '[1:0]' }),
    ).toBeVisible();

    const structAnnotationColors = await page
      .locator('.hdl-struct-node .svsch-bus-tap-label', { hasText: 'opcode' })
      .first()
      .evaluate((label) => {
        const annotation = label.querySelector('.svsch-struct-field-annotation');
        return {
          labelFill: getComputedStyle(label).fill,
          annotationFill: annotation ? getComputedStyle(annotation).fill : '',
        };
      });
    expect(structAnnotationColors.annotationFill).toBeTruthy();
    expect(structAnnotationColors.annotationFill).not.toBe(structAnnotationColors.labelFill);

    const minimapPortWidths = await page.evaluate(() => {
      const widthOf = (id: string) => {
        const node = document.querySelector(`[data-minimap-node-id="${id}"]`);
        if (!(node instanceof SVGGraphicsElement)) {
          throw new Error(`Missing minimap node ${id}`);
        }
        return node.getBBox().width;
      };
      return {
        opcode: widthOf('port:struct_breakout:opcode'),
        valid: widthOf('port:struct_breakout:valid'),
        lane: widthOf('port:struct_breakout:lane'),
      };
    });
    expect(minimapPortWidths.opcode).toBeGreaterThan(minimapPortWidths.valid);
    expect(minimapPortWidths.opcode).toBeGreaterThan(minimapPortWidths.lane);

    const structEdgeWidth = await page
      .locator('path.svsch-edge-struct')
      .first()
      .evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).strokeWidth);
      });
    const normalEdgeWidth = await page
      .locator(
        'path.svsch-edge:not(.svsch-edge-struct):not(.svsch-edge-struct-bg):not(.svsch-edge-thick)',
      )
      .first()
      .evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).strokeWidth);
      });
    expect(structEdgeWidth).toBeGreaterThanOrEqual(normalEdgeWidth * 2.9);
  });

  test(
    'renders a struct composition with field drivers merging into a ' + 'thick aggregate net',
    async ({ page }) => {
      await openFixture(page, 'struct_composition.sv', 'struct');

      await expect(page.locator('[data-node-id^="struct_comp:"]')).toBeVisible();
      await expect(page.locator('[data-node-kind="register"]')).toHaveCount(2);
      await expect(page.locator('[data-node-id="port:struct_composition:opcode_i"]')).toContainText(
        'opcode_i',
      );
      await expect(page.locator('[data-node-id="port:struct_composition:opcode_i"]')).toContainText(
        '[3:0]',
      );
      await expect(
        page.locator('[data-node-id="reg:struct_composition:pkt.opcode"]'),
      ).toContainText('pkt.opcode');
      await expect(
        page.locator('[data-node-id="reg:struct_composition:pkt.opcode"]'),
      ).toContainText('[3:0]');
      await expect(page.locator('[data-node-id="port:struct_composition:flat"]')).toContainText(
        'flat',
      );
      await expect(page.locator('[data-node-id="port:struct_composition:flat"]')).toContainText(
        '[4:0]',
      );
      await expect(
        page.locator('.hdl-struct-node .svsch-bus-tap', { hasText: 'opcode' }),
      ).toBeVisible();
      await expect(
        page.locator('.hdl-struct-node .svsch-bus-tap', { hasText: 'valid' }),
      ).toBeVisible();
      // The composition output feeds a plain [4:0] vector — an implicit cast in
      // SV terms — so it routes as a thick multi-bit wire, not a struct route.
      // Its declared net name ("flat") is auto-cut on first open (see
      // withFirstOpenAutoCutEdges), so the wire that carries it is now the
      // cut-stub sink edge running into the flat port, not a live
      // "edge:struct_comp..." edge.
      await expect(page.locator('path.svsch-edge-struct')).toHaveCount(0);
      await expect(
        page.locator('.react-flow__edge[data-id*=":flat:"] path.svsch-edge-thick'),
      ).toHaveCount(1);
    },
  );

  test('renders struct field mux reads separately from output recomposition', async ({ page }) => {
    const view = await openFixture(
      page,
      'internal_wire_instances.sv',
      'struct',
      'internal_wire_instance',
    );

    const breakout = page.locator('[data-node-id="struct:internal_wire_instance:pkt"]');
    const composition = page.locator(
      '[data-node-id="struct_comp:internal_wire_instance:pkt_recomb"]',
    );

    await expect(breakout).toBeVisible();
    await expect(composition).toBeVisible();
    await expect(page.locator('[data-node-kind="mux"]')).toHaveCount(2);
    await expect(breakout.locator('.svsch-bus-tap')).toHaveCount(3);
    await expect(composition.locator('.svsch-bus-tap')).toHaveCount(3);
    await expect(breakout.locator('.svsch-bus-tap', { hasText: 'pkt_recomb' })).toHaveCount(0);
    await expect(breakout.locator('.svsch-bus-tap', { hasText: 'opcode1' })).toBeVisible();
    await expect(breakout.locator('.svsch-bus-tap', { hasText: 'opcode2' })).toBeVisible();
    await expect(composition.locator('.svsch-bus-tap', { hasText: 'opcode1' })).toBeVisible();
    await expect(composition.locator('.svsch-bus-tap', { hasText: 'opcode2' })).toBeVisible();

    for (const edge of view.edges) {
      await expect(page.locator(`.react-flow__edge[data-id="${edge.id}"]`)).toBeAttached();
    }
  });
});

test.describe('comb visual rendering', () => {
  test('renders connected combinational ports with flat orthogonal connectors', async ({
    page,
  }) => {
    const view = await openFixture(page, 'comb_connected.sv', 'comb');

    await expectGraphAndScreenshot(page, 'comb-connected-canvas.png', {
      clip: await paddedGraphClip(page),
    });

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }
  });
});

test.describe('ALU visual rendering', () => {
  test('renders connected arithmetic ALU ports with flat orthogonal connectors', async ({
    page,
  }) => {
    const view = await openFixture(page, 'alu_connected.sv', 'alu');

    await expect(page.locator('[data-node-kind="alu"]')).toBeVisible();
    await expect(page.locator('.svsch-alu-operation')).toHaveText('+');
    await expectGraphAndScreenshot(page, 'alu-connected-canvas.png', {
      clip: await paddedGraphClip(page),
    });

    const alu = page.locator('[data-node-kind="alu"]');
    await alu.click();
    await expect(alu.locator('.node-skin-selection')).toHaveCSS('opacity', '1');
    await expect(alu.locator('.hdl-node-selection-rect')).toHaveCount(0);

    for (const edge of view.edges) {
      await expect(page.locator(`.react-flow__edge[data-id="${edge.id}"]`)).toBeAttached();
    }
  });

  test('renders cascaded arithmetic as a combinational block', async ({ page }) => {
    const view = await openFixture(page, 'alu_chain.sv', 'comb');

    await expect(page.locator('[data-node-kind="comb"]')).toHaveCount(1);
    await expect(page.locator('[data-node-kind="alu"]')).toHaveCount(0);
    await expectGraphAndScreenshot(page, 'alu-chain-comb-canvas.png', {
      clip: await paddedGraphClip(page),
    });

    for (const edge of view.edges) {
      await expect(page.locator(`.react-flow__edge[data-id="${edge.id}"]`)).toBeAttached();
    }
  });
});

test.describe('replication visual rendering', () => {
  test('renders replication as a red xN block with distinct input and output nets', async ({
    page,
  }) => {
    const view = await openFixture(page, 'replication_expr.sv', 'replicate');

    const replicate = page.locator('[data-node-kind="replicate"]', { hasText: 'x20' });
    await expect(replicate).toBeVisible();
    await expect(replicate).toContainText('x20');
    await expect(replicate).not.toContainText('some_wire');

    const style = await replicate.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { borderColor: computed.borderColor, height: computed.height };
    });
    expect(style.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(Number.parseFloat(style.height)).toBe(48);
    const handleBoxes = await replicate.locator('.react-flow__handle').evaluateAll((handles) =>
      handles.map((handle) => {
        const box = handle.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }),
    );
    expect(handleBoxes.every((box) => box.width === 0 && box.height === 0)).toBe(true);
    expect(
      view.edges.some(
        (edge) =>
          edge.source === 'port:replication_expr:some_wire' && edge.target.includes('replicate:'),
      ),
    ).toBe(true);
    expect(
      view.edges.some(
        (edge) =>
          edge.source.includes('replicate:') && edge.target === 'port:replication_expr:repeated',
      ),
    ).toBe(true);

    const fillReplicate = page.locator('[data-node-kind="replicate"]', { hasText: 'x FILL' });
    await expect(fillReplicate).toBeVisible();

    const labelMessagePromise = page.waitForEvent('console', (message) =>
      message.text().startsWith('NAVIGATE:'),
    );
    await fillReplicate.locator('.svsch-repeat-label-clickable', { hasText: 'FILL' }).click();
    const labelMessage = await labelMessagePromise;
    const labelPosted = JSON.parse(labelMessage.text().slice('NAVIGATE:'.length).trim());
    expect(labelPosted).toMatchObject({
      type: 'navigateToSource',
      source: { file: 'replication_expr.sv', startLine: 12 },
    });

    const nodeMessagePromise = page.waitForEvent('console', (message) =>
      message.text().startsWith('NAVIGATE:'),
    );
    await fillReplicate.dblclick({ position: { x: 4, y: 4 } });
    const nodeMessage = await nodeMessagePromise;
    const nodePosted = JSON.parse(nodeMessage.text().slice('NAVIGATE:'.length).trim());
    expect(nodePosted).toMatchObject({
      type: 'navigateToSource',
      source: { file: 'replication_expr.sv', startLine: 18 },
    });

    await expectGraphAndScreenshot(page, 'replication-block-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });
});

test.describe('loop visual rendering', () => {
  test('renders a loop block with input and output connections', async ({ page }) => {
    const view = await openFixture(page, 'loop_logic.sv', 'loop');

    await expect(page.locator('[data-node-kind="loop"]').first()).toBeVisible();
    await expect(page.locator('[data-node-kind="loop"]').first()).toContainText('LOOP');

    await expectGraphAndScreenshot(page, 'loop-node.png', { clip: await paddedGraphClip(page) });

    for (const edge of view.edges) {
      const locator = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
      await expect(locator).toBeAttached();
    }
  });
});

test.describe('module switching', () => {
  test('removes stale edge paths when switching to a smaller diagram', async ({ page }) => {
    const busView = await buildFixtureView('bus_slices.sv', 'bus');
    const assignView = await buildFixtureView('comb_assigns.sv', 'auto', 'assign_wire');

    await page.goto('/');
    await installStableTheme(page);

    // Scoped to `.react-flow__edge` (one per edge id) rather than the broader
    // `.svsch-edge` class: cut nets' netLabel nodes render their own little
    // stub wire with that same class (see NetLabelWire.tsx), which would
    // otherwise inflate the count by one per cut end.
    await postView(page, busView);
    await page.waitForSelector('[data-node-kind="bus"]');
    await waitForViewportTransformToSettle(page);
    await expect(page.locator('.react-flow__edge')).toHaveCount(busView.edges.length);

    await postView(page, assignView);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-node-kind="bus"]').length === 0,
    );
    await waitForViewportTransformToSettle(page);
    await expect(page.locator('.react-flow__edge')).toHaveCount(assignView.edges.length);
  });
});

test.describe('edge crossing and overlap extension', () => {
  test('routes feedback around a chain of tall blocks instead of through them', async ({
    page,
  }) => {
    await openView(page, createFeedbackChainView());
    await page.waitForSelector('[data-node-id="block:last"]');
    await waitForViewportTransformToSettle(page);

    const geometry = await page.evaluate(() => {
      const path =
        document
          .querySelector('.react-flow__edge[data-id="edge-feedback"] path.svsch-edge')
          ?.getAttribute('d') ?? '';
      const points: Array<{ x: number; y: number }> = [];
      const pattern = /[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
      let match = pattern.exec(path);
      while (match) {
        points.push({ x: Number(match[1]), y: Number(match[2]) });
        match = pattern.exec(path);
      }

      const nodes = (window as any).reactFlowInstance
        .getNodes()
        .filter((node: any) => node.id.startsWith('block:'));
      const top = Math.min(...nodes.map((node: any) => node.position.y));
      const bottom = Math.max(
        ...nodes.map((node: any) => node.position.y + (node.measured?.height ?? node.height ?? 0)),
      );
      const longHorizontalSegments = points
        .slice(0, -1)
        .map((point, index) => ({ start: point, end: points[index + 1] }))
        .filter((segment) => Math.abs(segment.start.y - segment.end.y) < 0.5)
        .filter((segment) => Math.abs(segment.start.x - segment.end.x) > 300);

      return {
        path,
        top,
        bottom,
        longHorizontalYs: longHorizontalSegments.map((segment) => segment.start.y),
      };
    });

    expect(geometry.path).toContain('L');
    expect(geometry.longHorizontalYs.length).toBeGreaterThan(0);
    expect(geometry.longHorizontalYs.every((y) => y < geometry.top || y > geometry.bottom)).toBe(
      true,
    );
  });

  test('renders line jumps for two manually routed assignments that intersect', async ({
    page,
  }) => {
    await openView(page, createLineJumpCrossingView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('[data-node-kind="port"] >> text=c')).toBeVisible();
    await expect(page.locator('[data-node-kind="port"] >> text=z')).toBeVisible();
    await expect(page.locator('.svsch-edge')).toHaveCount(3);
    await expect(page.locator('.svsch-edge-overlap-hint')).toHaveCount(1);
    await expect
      .poll(async () => {
        const paths = await page
          .locator('.svsch-edge')
          .evaluateAll((edges) => edges.map((edge) => edge.getAttribute('d') ?? ''));
        return paths.join('\n');
      })
      .toContain('Q');
    await expect(page.locator('.svsch-edge-jump-halo')).toHaveCount(1);

    await expectGraphAndScreenshot(page, 'line-jumps-crossing-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders overlap hints for two manually routed assignments that share a segment', async ({
    page,
  }) => {
    await openView(page, createLineOverlapView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('.svsch-edge')).toHaveCount(2);
    await expect(page.locator('.svsch-edge-jump-halo')).toHaveCount(0);
    await expect(page.locator('.svsch-edge-overlap-hint')).toHaveCount(3);
    await expect
      .poll(async () => {
        const paths = await page
          .locator('.svsch-edge')
          .evaluateAll((edges) => edges.map((edge) => edge.getAttribute('d') ?? ''));
        return paths.join('\n');
      })
      .not.toContain('Q');

    const hint = page.locator('.svsch-edge-overlap-hint').first();
    const hintGeometry = await hint.evaluate((element) => ({
      d: element.getAttribute('d') ?? '',
      stroke: getComputedStyle(element).stroke,
      strokeDasharray: getComputedStyle(element).strokeDasharray,
      strokeWidth: getComputedStyle(element).strokeWidth,
    }));
    const edgeStroke = await page
      .locator('.svsch-edge')
      .first()
      .evaluate((element) => getComputedStyle(element).stroke);
    expect(hintGeometry.d).toMatch(/^M .+ L .+$/);
    expect(hintGeometry.stroke).not.toBe('none');
    expect(hintGeometry.strokeDasharray).not.toBe('none');
    expect(Number.parseFloat(hintGeometry.strokeWidth)).toBeGreaterThan(1);
    expect(edgeStroke).not.toMatch(/rgba\([^)]*,\s*(?:0|0?\.\d+)/);
    expect(edgeStroke).not.toMatch(/\/\s*0?\.\d/);

    await expectGraphAndScreenshot(page, 'line-overlap-hint-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });
});

test.describe('edge route editing', () => {
  test('highlights every connection in a hovered source net', async ({ page }) => {
    await openView(page, createBranchedNetHighlightView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('.svsch-edge')).toHaveCount(3);
    await expect(page.locator('.svsch-edge-net-highlight')).toHaveCount(0);

    // Hover over the edge bridge (which captures the mouse events in our component)
    await page
      .locator('.react-flow__edge[data-id="edge-a-to-x"] path.svsch-edge-bridge')
      .hover({ force: true });

    // In our new implementation, all halos (2 in this case) are rendered inside the hovered
    // edge component
    await expect(
      page.locator('.react-flow__edge[data-id="edge-a-to-x"] .svsch-edge-net-highlight'),
    ).toHaveCount(2);
    // And other edges should NOT render halos themselves to avoid compounding
    await expect(
      page.locator('.react-flow__edge[data-id="edge-a-to-y"] .svsch-edge-net-highlight'),
    ).toHaveCount(0);

    await page.locator('.react-flow__pane').hover({ position: { x: 20, y: 20 } });
    await expect(page.locator('.svsch-edge-net-highlight')).toHaveCount(0);
  });

  test('highlights every connection from a shared literal node', async ({ page }) => {
    await openView(page, createLiteralFanoutHighlightView());
    await page.waitForSelector('[data-node-id="literal:fsm_literal:IDLE:IDLE"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('.svsch-edge')).toHaveCount(3);
    const edgeGrouping = await page.evaluate(() => {
      return (window as any).reactFlowInstance.getEdges().map((edge: any) => ({
        id: edge.id,
        isNetLeader: edge.data?.isNetLeader,
        netEdgeIds: edge.data?.netEdgeIds,
      }));
    });
    expect(edgeGrouping).toContainEqual({
      id: 'edge-idle-default',
      isNetLeader: true,
      netEdgeIds: ['edge-idle-default', 'edge-idle-done', 'edge-idle-reset'],
    });

    await hoverEdgeBridge(page, 'edge-idle-default');

    await expect(page.locator('.svsch-edge-net-highlight')).toHaveCount(3);
  });

  test('posts cut, rename, and tie messages for visual net labels', async ({ page }) => {
    await installMessageCapture(page);
    await openView(page, createBranchedNetHighlightView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    await page
      .locator('.react-flow__edge[data-id="edge-a-to-x"] path.svsch-edge-bridge')
      .hover({ force: true });
    await page.locator('.react-flow__edge[data-id="edge-a-to-x"] .svsch-edge-cut-control').click();

    await expect
      .poll(async () => capturedMessages(page))
      .toContainEqual(
        expect.objectContaining({
          type: 'cutNet',
          moduleName: 'branched_net_highlight',
          edge: expect.objectContaining({ id: 'edge-a-to-x' }),
        }),
      );

    await postView(page, createCutBranchedNetView());
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await expect(page.locator('[data-node-kind="netLabel"]')).toHaveCount(3);

    await page.locator('[data-node-id="cut-label:source:a:p:source"]').dblclick();
    const input = page.locator('[data-node-id="cut-label:source:a:p:source"] .hdl-net-label-input');
    await input.fill('renamed_a');
    await input.press('Enter');

    await expect
      .poll(async () => capturedMessages(page))
      .toContainEqual(
        expect.objectContaining({
          type: 'renameCutNet',
          moduleName: 'branched_net_highlight',
          netKey: 'source:a:p',
          label: 'renamed_a',
        }),
      );

    await page.mouse.move(0, 0);
    const tieTarget = page.locator('[data-node-id="cut-label:source:a:p:sink:edge-a-to-x"]');
    const tieButton = tieTarget.locator('.hdl-net-label-tie');
    await expect(tieButton).toBeHidden();
    await tieTarget.hover({ force: true });
    await expect(tieButton).toBeVisible();
    await tieButton.click();
    await expect
      .poll(async () => capturedMessages(page))
      .toContainEqual(
        expect.objectContaining({
          type: 'tieNet',
          moduleName: 'branched_net_highlight',
          netKey: 'source:a:p',
        }),
      );
  });

  test(
    'shows declared and freshly-cut labels in regular type (locked/unrenamed), ' +
      'and only a renamed one in italic with a Revert button',
    async ({ page }) => {
      await installMessageCapture(page);
      await openView(page, createDeclaredAndSyntheticCutNetView());
      await page.waitForSelector('[data-node-kind="netLabel"]');
      await waitForViewportTransformToSettle(page);

      const declaredLabel = page.locator('[data-node-id="cut-label:declared:source"]');
      const syntheticLabel = page.locator('[data-node-id="cut-label:synthetic:source"]');
      const renamedLabel = page.locator('[data-node-id="cut-label:renamed:source"]');

      // The declared net's name came straight from the SV source: regular
      // weight, and double-clicking it must not open the rename editor.
      await expect(declaredLabel.locator('.hdl-net-label-text-synthetic')).toHaveCount(0);
      await declaredLabel.dblclick({ force: true });
      await expect(declaredLabel.locator('.hdl-net-label-input')).toBeHidden();

      // A freshly-cut net with no formal wire name still shows its default
      // label in regular type — italics only kick in once it's been renamed —
      // but it stays editable, and no "Revert label" button shows since the
      // label hasn't diverged from its default yet.
      await expect(syntheticLabel.locator('.hdl-net-label-text-synthetic')).toHaveCount(0);
      await expect(syntheticLabel.locator('.hdl-net-label-revert')).toHaveCount(0);
      await syntheticLabel.dblclick({ force: true });
      const input = syntheticLabel.locator('.hdl-net-label-input');
      await expect(input).toBeVisible();
      await input.fill('renamed_net');
      await input.press('Enter');
      await expect
        .poll(async () => capturedMessages(page))
        .toContainEqual(
          expect.objectContaining({
            type: 'renameCutNet',
            moduleName: 'declared_and_synthetic_cut_net',
            netKey: 'synthetic',
            label: 'renamed_net',
          }),
        );

      // The synthetic net's alias chain (from a collapsed assign chain) shows
      // as a hoverable marker next to its label.
      const aliasMarker = syntheticLabel.locator('.hdl-net-label-alias-marker');
      await expect(aliasMarker).toBeVisible();
      await aliasMarker.hover({ force: true });
      await expect(
        page.locator('.svsch-tooltip', { hasText: 'Also declared as: legacy_a, legacy_b' }),
      ).toBeVisible();

      // A net already diverged from its default label reads in italic and
      // shows a "Revert label" button that resets it back to that default.
      await expect(renamedLabel.locator('.hdl-net-label-text-synthetic')).toHaveCount(1);
      await page.mouse.move(0, 0);
      const revertButton = renamedLabel.locator('.hdl-net-label-revert');
      await expect(revertButton).toBeHidden();
      await renamedLabel.hover({ force: true });
      await expect(revertButton).toBeVisible();
      await revertButton.click();
      await expect
        .poll(async () => capturedMessages(page))
        .toContainEqual(
          expect.objectContaining({
            type: 'revertCutNetLabel',
            moduleName: 'declared_and_synthetic_cut_net',
            netKey: 'renamed',
          }),
        );

      await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
      await expectGraphAndScreenshot(page, 'cut-net-label-declared-vs-synthetic-canvas.png', {
        clip: await paddedAllNodesClip(page),
      });
    },
  );

  test(
    'shows a declared net name directly on an uncut wire, with an alias ' +
      'popover for the rest of the chain',
    async ({ page }) => {
      await openView(page, createEdgeNetLabelView());
      await page.waitForSelector('[data-node-kind="port"]');
      await waitForViewportTransformToSettle(page);

      const label = page.locator('.svsch-edge-label');
      await expect(label).toContainText('x1');

      const aliasMarker = label.locator('.hdl-net-label-alias-marker');
      await expect(aliasMarker).toBeVisible();
      await aliasMarker.hover({ force: true });
      await expect(
        page.locator('.svsch-tooltip', { hasText: 'Also declared as: x2' }),
      ).toBeVisible();

      await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
      await expectGraphAndScreenshot(page, 'edge-declared-net-label-canvas.png', {
        clip: await paddedAllNodesClip(page),
      });
    },
  );

  // wire_alias_chains.sv has no mux — openFixture's default 'auto' selector
  // waits on a mux node, so these open the fixture view directly and wait
  // on the port nodes it actually has instead.
  test('shows no label on a plain assign with no intermediate wire', async ({ page }) => {
    await openView(page, await buildFixtureView('wire_alias_chains.sv', 'auto', 'wire_no_alias'));
    await page.waitForSelector('[data-node-kind="port"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('.svsch-edge-label')).toHaveCount(0);

    await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
    await expectGraphAndScreenshot(page, 'wire-no-alias-canvas.png', {
      clip: await paddedAllNodesClip(page),
    });
  });

  // A wire's declared net name is auto-cut on first open (see
  // firstOpenAutoCutEdges/withFirstOpenAutoCutEdges), same as production —
  // so its name now shows on the source/sink cut labels instead of an inline
  // edge label.
  test('shows a single declared wire name with no alias marker', async ({ page }) => {
    await openView(
      page,
      await buildFixtureView('wire_alias_chains.sv', 'auto', 'wire_single_alias'),
    );
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await waitForViewportTransformToSettle(page);

    const labels = page.locator('[data-node-kind="netLabel"]');
    await expect(labels).toHaveCount(2);
    await expect(labels.locator('.hdl-net-label-text-value')).toHaveText(['x', 'x']);
    await expect(labels.locator('.hdl-net-label-alias-marker')).toHaveCount(0);

    await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
    await expectGraphAndScreenshot(page, 'wire-single-alias-canvas.png', {
      clip: await paddedAllNodesClip(page),
    });
  });

  test('shows the first-declared wire name with an alias popover for a multi-hop chain', async ({
    page,
  }) => {
    await openView(
      page,
      await buildFixtureView('wire_alias_chains.sv', 'auto', 'wire_multiple_aliases'),
    );
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await waitForViewportTransformToSettle(page);

    const labels = page.locator('[data-node-kind="netLabel"]');
    await expect(labels).toHaveCount(2);
    await expect(labels.locator('.hdl-net-label-text-value')).toHaveText(['x1', 'x1']);

    const aliasMarker = labels.first().locator('.hdl-net-label-alias-marker');
    await expect(aliasMarker).toBeVisible();
    await aliasMarker.hover({ force: true });
    await expect(page.locator('.svsch-tooltip', { hasText: 'Also declared as: x2' })).toBeVisible();

    await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
    await expectGraphAndScreenshot(page, 'wire-multiple-aliases-canvas.png', {
      clip: await paddedAllNodesClip(page),
    });
  });

  test('renders cut labels above styled wire stubs of every kind', async ({ page }) => {
    // Six style rows need more height than the default viewport to keep the
    // fitted view (and the screenshot clip) clear of the app toolbar.
    await page.setViewportSize({ width: 1400, height: 1100 });
    await openView(page, createStyledCutNetView());
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('.hdl-net-label-struct')).toHaveCount(2);
    await expect(page.locator('.hdl-net-label-interface')).toHaveCount(2);
    await expect(page.locator('.hdl-net-label-stacked')).toHaveCount(4);

    for (const nodeId of [
      'cut-label:styled:plain:source',
      'cut-label:styled:plain:sink',
      'cut-label:styled:thick:source',
      'cut-label:styled:thick:sink',
      'cut-label:styled:struct:source',
      'cut-label:styled:struct:sink',
      'cut-label:styled:interface:source',
      'cut-label:styled:interface:sink',
      'cut-label:styled:stacked:source',
      'cut-label:styled:stacked:sink',
      'cut-label:styled:wstacked:source',
      'cut-label:styled:wstacked:sink',
    ]) {
      await expectCutLabelAboveWire(page, nodeId);
    }

    await page.addStyleTag({ content: '.react-flow__minimap { display: none !important; }' });
    await expectGraphAndScreenshot(page, 'cut-net-label-styled-stubs-canvas.png', {
      clip: await paddedAllNodesClip(page),
    });
  });

  test(
    'highlights a drag-selected dangling end with the same halo and name ' +
      'style as its hovered net',
    async ({ page }) => {
      await openView(page, createStyledCutNetView());
      await page.waitForSelector('[data-node-kind="netLabel"]');
      await waitForViewportTransformToSettle(page);

      const nodeId = 'cut-label:styled:plain:source';
      const labelLocator = page.locator(`.react-flow__node[data-id="${nodeId}"]`);

      // Before selection: no halo on the stub, no highlight on the name.
      await expect(labelLocator.locator('.svsch-edge-net-highlight')).toHaveCount(0);
      await expect(labelLocator.locator('.hdl-net-label-text-hovered')).toHaveCount(0);

      const labelBox = await labelLocator.boundingBox();
      if (!labelBox) throw new Error('Unable to locate cut-label bounding box');
      const startX = labelBox.x - 8;
      const startY = labelBox.y - 8;
      const endX = labelBox.x + labelBox.width + 8;
      const endY = labelBox.y + labelBox.height + 8;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 12 });
      await page.mouse.up();

      await expect(labelLocator).toHaveClass(
        /react-flow__node-hdl.*selected|selected.*react-flow__node-hdl/,
      );

      await expect(labelLocator.locator('.svsch-edge-net-highlight')).toHaveCount(1);
      await expect(labelLocator.locator('.hdl-net-label-text-hovered')).toHaveCount(1);

      await expectGraphAndScreenshot(page, 'cut-net-label-selected.png', {
        clip: await paddedLocatorClip(page, `[data-node-id="${nodeId}"]`),
      });
    },
  );

  test(
    'does not highlight a dangling end merely because its real port was ' +
      'marquee-selected, since the label itself sits outside the lasso and is not itself selected',
    async ({ page }) => {
      await openView(page, createStyledCutNetView());
      await page.waitForSelector('[data-node-kind="netLabel"]');
      await waitForViewportTransformToSettle(page);

      // A later row, well clear of the top-left "Module: ..." info panel that
      // would otherwise swallow the marquee's mousedown.
      const nodeId = 'cut-label:styled:struct:source';
      const labelLocator = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
      const portLocator = page.locator('.react-flow__node[data-id="source:struct"]');

      await expect(labelLocator.locator('.svsch-edge-net-highlight')).toHaveCount(0);
      await expect(labelLocator.locator('.hdl-net-label-text-hovered')).toHaveCount(0);

      // Lasso just the port, deliberately stopping short of the label so the
      // marquee rectangle never touches it directly — mirrors a real diagram,
      // where a cut end can sit well outside the block/port it's attached to.
      const portBox = await portLocator.boundingBox();
      const labelBox = await labelLocator.boundingBox();
      if (!portBox || !labelBox) throw new Error('Unable to locate port or label bounding boxes');
      expect(portBox.x + portBox.width).toBeLessThan(labelBox.x);

      const startX = portBox.x - 20;
      const startY = portBox.y - 20;
      const endX = portBox.x + portBox.width + 20;
      const endY = portBox.y + portBox.height + 20;
      expect(endX).toBeLessThan(labelBox.x);

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 });
      await page.mouse.move(endX, endY, { steps: 8 });
      await page.mouse.up();

      await expect(portLocator).toHaveClass(/selected/);
      await expect(labelLocator).not.toHaveClass(/selected/);
      await expect(labelLocator.locator('.svsch-edge-net-highlight')).toHaveCount(0);
      await expect(labelLocator.locator('.hdl-net-label-text-hovered')).toHaveCount(0);
    },
  );

  test('matches cut label segment paint to decorated wire styles', async ({ page }) => {
    await openView(page, createStyledCutNetView());
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await waitForViewportTransformToSettle(page);

    const structPaint = await cutLabelPaint(
      page,
      'cut-label:styled:struct:source',
      'cut-stub:styled:struct:source',
      '.svsch-edge-struct-bg',
    );
    expect(structPaint.wireStrokeWidth).toBeCloseTo(structPaint.edgeStrokeWidth, 1);
    expect(structPaint.wireStroke).toBe(structPaint.edgeStroke);

    const interfacePaint = await cutLabelPaint(
      page,
      'cut-label:styled:interface:source',
      'cut-stub:styled:interface:source',
      '.svsch-edge-interface-bg',
    );
    expect(interfacePaint.wireStrokeWidth).toBeCloseTo(interfacePaint.edgeStrokeWidth, 1);
    expect(interfacePaint.wireStroke).toBe(interfacePaint.edgeStroke);

    const stackedPaint = await cutLabelPaint(
      page,
      'cut-label:styled:stacked:source',
      'cut-stub:styled:stacked:source',
      '.svsch-edge-stacked',
    );
    expect(stackedPaint.wireStroke).toBe(stackedPaint.edgeStroke);
    await expect(
      page.locator(
        '.react-flow__edge[data-id="cut-stub:styled:stacked:source"] .svsch-edge-stacked-back, ' +
          '.react-flow__edge[data-id="cut-stub:styled:stacked:source"] .svsch-edge-stacked-front',
      ),
    ).toHaveCount(2);

    const thickPaint = await cutLabelPaint(
      page,
      'cut-label:styled:thick:source',
      'cut-stub:styled:thick:source',
      '.svsch-edge-thick',
    );
    expect(thickPaint.wireStrokeWidth).toBeCloseTo(thickPaint.edgeStrokeWidth, 1);
    expect(thickPaint.wireStroke).toBe(thickPaint.edgeStroke);

    const wideStackedPaint = await cutLabelPaint(
      page,
      'cut-label:styled:wstacked:source',
      'cut-stub:styled:wstacked:source',
      '.svsch-edge-stacked',
    );
    expect(wideStackedPaint.wireStrokeWidth).toBeCloseTo(wideStackedPaint.edgeStrokeWidth, 1);
    await expect(
      page.locator(
        '.react-flow__edge[data-id="cut-stub:styled:wstacked:source"] .svsch-edge-thick',
      ),
    ).toHaveCount(3);
  });

  test('renders cut labels for vertical reset connections on registers', async ({ page }) => {
    // Let ELK position everything, then cut the rst reset net
    const graph = await buildGraphFromFixture('register_async_reset.sv');
    const moduleName = graph.rootModules[0];
    const designModule = graph.modules[moduleName];
    const emptyLayout: SavedLayout = { version: 1, modules: {} };

    const baseView = await buildViewModel(graph, moduleName, emptyLayout);
    const rstEdge = baseView.edges.find((e) => e.signal === 'rst');
    if (!rstEdge) throw new Error('rst edge not found in auto-layout view');

    const cutLayout = mergeNetCut(emptyLayout, moduleName, rstEdge, designModule, baseView.nodes);
    const cutView = await buildViewModel(graph, moduleName, cutLayout);

    await openView(page, cutView);
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await waitForViewportTransformToSettle(page);
    await expectGraphAndScreenshot(page, 'cut-net-label-register-reset.png', {
      clip: await paddedGraphClip(page),
    });

    // Drag the source cut label and verify it snaps to the half-grid
    const sourceLabelNode = cutView.nodes.find(
      (n) => n.kind === 'netLabel' && n.metadata?.cutNet?.role === 'source',
    );
    if (!sourceLabelNode) throw new Error('source cut label node not found');

    const labelLocator = page.locator(`.react-flow__node[data-id="${sourceLabelNode.id}"]`);
    const box = await labelLocator.boundingBox();
    if (!box) throw new Error('cut label bounding box not found');

    const grid = diagramSizing.gridSize;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + grid * 3, box.y + box.height / 2 + grid * 2, {
      steps: 10,
    });
    await page.mouse.up();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);

    // Position must be on the grid (x ≡ 0 mod grid, same for y)
    const pos = await page.evaluate((nodeId) => {
      const instance = (window as any).reactFlowInstance;
      return instance?.getNodes().find((n: any) => n.id === nodeId)?.position ?? null;
    }, sourceLabelNode.id);
    expect(pos).toBeTruthy();
    const xMod = ((Math.round(pos.x) % grid) + grid) % grid;
    const yMod = ((Math.round(pos.y) % grid) + grid) % grid;
    expect(xMod).toBe(0);
    expect(yMod).toBe(0);

    // Hover over the moved source label to show the net highlight in the screenshot
    const movedLabelLocator = page.locator(`.react-flow__node[data-id="${sourceLabelNode.id}"]`);
    await movedLabelLocator.hover({ force: true });
    await page.waitForTimeout(200);

    await waitForViewportTransformToSettle(page);
    await expectGraphAndScreenshot(page, 'cut-net-label-register-reset-after-move.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders cut labels for clock connections to stacked registers (plurality check)', async ({
    page,
  }) => {
    await openView(page, createRegisterClockCutView());
    await page.waitForSelector('[data-node-kind="netLabel"]');
    await waitForViewportTransformToSettle(page);

    await expectGraphAndScreenshot(page, 'cut-net-label-register-clock.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('shows joined reroute and cut controls on edge hover', async ({ page }) => {
    await openView(page, createSingleAssignmentRouteEditView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    await hoverEdgeBridge(page, 'edge-a-to-y');
    await page.waitForSelector('.svsch-edge-connection-controls');
    await page.waitForTimeout(100);

    await expectGraphAndScreenshot(page, 'edge-connection-controls-hover.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test(
    'keeps an over-dragged assignment segment editable after clamping to ' + 'the target lead',
    async ({ page }) => {
      await openView(page, createSingleAssignmentRouteEditView());
      await page.waitForSelector('[data-node-id="source:a"]');
      await waitForViewportTransformToSettle(page);

      await expect(page.locator('.svsch-edge')).toHaveCount(1);
      await expect(page.locator('.svsch-edge-segment-vertical')).toHaveCount(1);

      const initialX = await firstVerticalSegmentX(page);
      await dragFirstVerticalSegmentBy(page, 260, 0);
      const clampedX = await firstVerticalSegmentX(page);
      expect(clampedX).toBeGreaterThan(initialX);

      await dragFirstVerticalSegmentBy(page, -120, 0);
      await expect.poll(async () => firstVerticalSegmentX(page)).toBeLessThan(clampedX - 24);
    },
  );

  test('keeps a dragged feedback return segment away from the target block', async ({ page }) => {
    await openView(page, createFeedbackChainView());
    await page.waitForSelector('[data-node-id="block:last"]');
    await waitForViewportTransformToSettle(page);

    await expect(
      page.locator('.react-flow__edge[data-id="edge-feedback"] .svsch-edge-segment-vertical'),
    ).toHaveCount(2);
    const initialX = await lastEditableVerticalSegmentX(page, 'edge-feedback');
    await dragLastVerticalSegmentByEdge(page, 'edge-feedback', -96, 0);

    await expect
      .poll(async () => lastEditableVerticalSegmentX(page, 'edge-feedback'))
      .toBeLessThan(initialX - 24);
  });

  test('renders junction dots for a branched same-source net', async ({ page }) => {
    await openView(page, createSharedBranchedRouteView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    await expect(page.locator('.svsch-edge')).toHaveCount(3);
    await expect(page.locator('.svsch-edge-junction')).toHaveCount(1);
    await expect(page.locator('.svsch-edge-junction')).toHaveAttribute('r', '4.75');
    await expect(page.locator('.svsch-edge-junction-interface')).toHaveCount(0);
    await expectGraphAndScreenshot(page, 'branched-net-junctions-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('moves same-net shared trunk segments together', async ({ page }) => {
    await openView(page, createSharedBranchedRouteView());
    await page.waitForSelector('[data-node-id="source:a"]');
    await waitForViewportTransformToSettle(page);

    const initialX = await firstEditableVerticalSegmentX(page, 'edge-a-to-x');
    const initialY = await firstEditableVerticalSegmentX(page, 'edge-a-to-y');
    await dragFirstVerticalSegmentByEdge(page, 'edge-a-to-x', 48, 0);

    await expect
      .poll(async () => firstEditableVerticalSegmentX(page, 'edge-a-to-x'))
      .toBeGreaterThan(initialX + 12);
    await expect
      .poll(async () => firstEditableVerticalSegmentX(page, 'edge-a-to-y'))
      .toBeGreaterThan(initialY + 12);
    await expect.poll(async () => firstEditableHorizontalSegmentY(page, 'edge-b-to-z')).toBe(264);
  });
});

test.describe('node sizing visual rendering', () => {
  test('renders a single-output comb at compact minimum height', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await openView(page, createNodeSizingGalleryView(false));
    const height = await page
      .locator('[data-node-id="comb"]')
      .evaluate((element) => getComputedStyle(element).height);
    const style = await page
      .locator('[data-node-id="comb"]')
      .evaluate((element) => element.getAttribute('style'));
    const kind = await page
      .locator('[data-node-id="comb"]')
      .evaluate((element) => element.getAttribute('data-node-kind'));

    expect(kind).toBe('comb');
    expect(style).toContain('--svsch-node-height: 72px');
    expect(height).toBe('72px');
  });

  test('renders every current node kind at its default width', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await openView(page, createNodeSizingGalleryView(false));
    await page.waitForSelector('[data-node-id="unknown"]');
    await waitForViewportTransformToSettle(page);

    // Assert all node kinds are present
    await expect(page.locator('[data-node-id="port:in"]')).toBeVisible();
    await expect(page.locator('[data-node-id="port:out"]')).toBeVisible();
    await expect(page.locator('[data-node-id="mux"]')).toBeVisible();
    await expect(page.locator('[data-node-id="register"]')).toBeVisible();
    await expect(page.locator('[data-node-id="comb"]')).toBeVisible();
    await expect(page.locator('[data-node-id="literal:value"]')).toBeVisible();
    await expect(page.locator('[data-node-id="literal:constant"]')).toBeVisible();
    await expect(page.locator('[data-node-id="literal:value"] .svsch-literal-content')).toHaveText(
      "8'h42",
    );
    await expect(
      page.locator('[data-node-id="literal:constant"] .svsch-literal-content'),
    ).toHaveText('VERSION');
    await expect(page.locator('[data-node-id="bus"]')).toBeVisible();
    await expect(page.locator('[data-node-id="instance"]')).toBeVisible();
    await expect(page.locator('[data-node-id="module"]')).toBeVisible();
    await expect(page.locator('[data-node-id="unknown"]')).toBeVisible();

    await expectGraphAndScreenshot(page, 'node-sizing-defaults-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });

  test('renders every current node kind widened for long labels', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await openView(page, createNodeSizingGalleryView(true));
    await page.waitForSelector('[data-node-id="unknown"]');
    await waitForViewportTransformToSettle(page);

    // Assert all node kinds are present
    await expect(page.locator('[data-node-id="port:in"]')).toBeVisible();
    await expect(page.locator('[data-node-id="port:out"]')).toBeVisible();
    await expect(page.locator('[data-node-id="mux"]')).toBeVisible();
    await expect(page.locator('[data-node-id="register"]')).toBeVisible();
    await expect(page.locator('[data-node-id="comb"]')).toBeVisible();
    await expect(page.locator('[data-node-id="literal:value"]')).toBeVisible();
    await expect(page.locator('[data-node-id="literal:constant"]')).toBeVisible();
    await expect(page.locator('[data-node-id="bus"]')).toBeVisible();
    await expect(page.locator('[data-node-id="instance"]')).toBeVisible();
    await expect(page.locator('[data-node-id="module"]')).toBeVisible();
    await expect(page.locator('[data-node-id="unknown"]')).toBeVisible();

    await expectGraphAndScreenshot(page, 'node-sizing-extended-canvas.png', {
      clip: await paddedGraphClip(page),
    });
  });
});

type VisualLayoutMode =
  | 'auto'
  | 'manual'
  | 'bus'
  | 'struct'
  | 'register'
  | 'register-enable'
  | 'array-address-write'
  | 'array-address-read'
  | 'comb'
  | 'alu'
  | 'loop'
  | 'replicate';

async function openFixture(
  page: Page,
  fixtureName: string,
  layoutMode: VisualLayoutMode = 'auto',
  moduleName?: string,
): Promise<DiagramViewModel> {
  const view = await buildFixtureView(fixtureName, layoutMode, moduleName);

  await openView(page, view);
  const readySelector =
    layoutMode === 'bus'
      ? '[data-node-kind="bus"]'
      : layoutMode === 'struct'
        ? '[data-node-kind="struct"]'
        : layoutMode === 'register'
          ? '[data-node-kind="register"]'
          : layoutMode === 'comb'
            ? '[data-node-kind="comb"]'
            : layoutMode === 'alu'
              ? '[data-node-kind="alu"]'
              : layoutMode === 'loop'
                ? '[data-node-kind="loop"]'
                : layoutMode === 'replicate'
                  ? '[data-node-kind="replicate"]'
                  : '[data-node-kind="mux"]';
  await page.waitForSelector(readySelector, { state: 'attached' });
  const startedAt = postViewStartedAt.get(page);
  if (startedAt !== undefined) {
    postViewStartedAt.delete(page);
    recordVisualBenchmark('rendering', Date.now() - startedAt);
  }
  await waitForViewportTransformToSettle(page);
  await page.waitForTimeout(100);
  return view;
}

async function openView(page: Page, view: DiagramViewModel): Promise<void> {
  await page.goto('/');
  await installStableTheme(page);
  // Wait a bit for React to initialize and add the event listener
  await page.waitForTimeout(500);
  await postView(page, view);
}

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

async function capturedMessages(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as any).__svschMessages ?? []);
}

async function expectCutLabelAboveWire(page: Page, nodeId: string): Promise<void> {
  const metrics = await page.locator(`[data-node-id="${nodeId}"]`).evaluate((node) => {
    const text = node.querySelector('.hdl-net-label-text');
    const svg = node.querySelector('.hdl-net-label-wire-svg');
    if (!text || !svg) {
      throw new Error(`Missing net label text or wire for ${node.getAttribute('data-node-id')}`);
    }
    const textBox = text.getBoundingClientRect();
    const svgBox = svg.getBoundingClientRect();
    return {
      textBottom: textBox.bottom,
      wireMiddle: svgBox.top + svgBox.height / 2,
    };
  });

  expect(metrics.textBottom).toBeLessThanOrEqual(metrics.wireMiddle);
}

async function cutLabelPaint(
  page: Page,
  nodeId: string,
  edgeId: string,
  edgeSelector: string,
  wireSelector = 'path:not(.svsch-edge-stacked-back):not(.svsch-edge-stacked-front)',
): Promise<{
  edgeStroke: string;
  edgeStrokeWidth: number;
  wireFill: string;
  wireStroke: string;
  wireStrokeWidth: number;
}> {
  return page.evaluate(
    ({ nodeId: id, edgeId: edge, selector, wirePathSelector }) => {
      const wire = document.querySelector(
        `[data-node-id="${id}"] .hdl-net-label-wire-svg ${wirePathSelector}`,
      );
      const path = document.querySelector(`.react-flow__edge[data-id="${edge}"] ${selector}`);
      if (!wire || !path) {
        throw new Error(
          `Missing paint target for ${id}/${edge} (wire: ${!!wire}, edge: ${!!path})`,
        );
      }

      const wireStyle = getComputedStyle(wire);
      const pathStyle = getComputedStyle(path);
      return {
        edgeStroke: pathStyle.stroke,
        edgeStrokeWidth: Number.parseFloat(pathStyle.strokeWidth),
        wireFill: wireStyle.fill,
        wireStroke: wireStyle.stroke,
        wireStrokeWidth: Number.parseFloat(wireStyle.strokeWidth),
      };
    },
    { nodeId, edgeId, selector: edgeSelector, wirePathSelector: wireSelector },
  );
}

async function postView(page: Page, view: DiagramViewModel): Promise<void> {
  trackView(page, view);
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

async function paddedLocatorClip(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const padding = 24;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`Unable to find screenshot target: ${selector}`);
  }
  return paddedClipFromBox(page, box, padding);
}

async function paddedGraphClip(
  page: Page,
  padding = 48,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.react-flow__nodes').boundingBox();
  if (!box) {
    throw new Error('Unable to find rendered graph nodes');
  }
  return paddedClipFromBox(page, box, padding);
}

function paddedClipFromBox(
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

async function waitForViewportTransformToSettle(page: Page): Promise<void> {
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

async function hoverEdgeBridge(page: Page, edgeId: string): Promise<void> {
  const point = await page
    .locator(`.react-flow__edge[data-id="${edgeId}"] path.svsch-edge-bridge`)
    .evaluate((path) => {
      const svgPath = path as SVGPathElement;
      const length = svgPath.getTotalLength();
      const local = svgPath.getPointAtLength(length / 2);
      const matrix = svgPath.getScreenCTM();
      if (!matrix) {
        throw new Error(`Unable to calculate screen coordinates for ${edgeId}`);
      }
      return {
        x: matrix.a * local.x + matrix.c * local.y + matrix.e,
        y: matrix.b * local.x + matrix.d * local.y + matrix.f,
      };
    });

  await page.mouse.move(point.x, point.y);
}

async function buildGraphFromFixture(fixtureName: string): Promise<DesignGraph> {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-visual-'));
  try {
    const tmpFile = path.join(tmpDir, path.basename(fixtureName));
    fs.writeFileSync(tmpFile, fs.readFileSync(fixturePath));
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

// Mirrors diagramPanel.ts's first-open handling and helper.ts's
// withFirstOpenAutoCutEdges(), so this file's hand-built fixture layouts cut
// the same clock/reset/declared-net edges a real first open would.
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

async function buildFixtureView(
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

    const elaborationStartedAt = Date.now();
    const graph = await buildDesignGraph({
      workspaceRoot: tmpDir,
      projectFolder: '.',
      backend: 'uhdm',
      veriblePath: 'verible-verilog-syntax',
      surelogPath,
      backendPath,
      includeExternalDiagnostics: false,
    });
    recordVisualBenchmark('elaboration', Date.now() - elaborationStartedAt);

    const moduleName = requestedModuleName ?? graph.rootModules[0];
    const layout =
      layoutMode === 'manual'
        ? createVisualLayout(graph, moduleName)
        : layoutMode === 'bus'
          ? createBusVisualLayout(graph, moduleName)
          : layoutMode === 'struct'
            ? createStructVisualLayout(graph, moduleName)
            : layoutMode === 'register'
              ? createRegisterVisualLayout(graph, moduleName)
              : layoutMode === 'register-enable'
                ? createRegisterEnableVisualLayout(graph, moduleName)
                : layoutMode === 'array-address-read'
                  ? createArrayAddressReadVisualLayout(graph, moduleName)
                  : layoutMode === 'comb'
                    ? createCombVisualLayout(graph, moduleName)
                    : layoutMode === 'alu'
                      ? createAluVisualLayout(graph, moduleName)
                      : ({ version: 1, modules: {} } as SavedLayout);

    return buildViewModel(graph, moduleName, withFirstOpenAutoCutEdges(layout, graph, moduleName));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

function createRegisterEnableVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const reg = designModule.nodes.find((node) => node.kind === 'register');
  const mux = designModule.nodes.find((node) => node.kind === 'mux');
  const selectorSignal = mux?.ports.find((port) => port.name === 'sel')?.connectedSignal;
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;

  const muxX = grid * 9;
  const muxY = grid * 4;
  const regX = grid * 19;
  const regY = grid * 4;

  if (mux) nodes[mux.id] = { x: muxX, y: muxY };
  if (reg) nodes[reg.id] = { x: regX, y: regY };

  const clkLike = inputPorts.filter((p) => /^c/i.test(p.label));
  const rstLike = inputPorts.filter((p) => /^r/i.test(p.label));
  const selectorPorts = inputPorts.filter((p) => p.label === selectorSignal);
  const dataPorts = inputPorts.filter(
    (p) => !clkLike.includes(p) && !rstLike.includes(p) && !selectorPorts.includes(p),
  );

  selectorPorts.forEach((port, i) => {
    nodes[port.id] = { x: muxX - grid * 3, y: muxY - grid * 5 - i * grid * 2 };
  });

  dataPorts.forEach((port, i) => {
    nodes[port.id] = { x: grid * 0, y: muxY + grid * 2 + i * grid * 2 };
  });

  clkLike.forEach((port, i) => {
    nodes[port.id] = { x: regX + grid * i * 6, y: regY + grid * 7 };
  });

  rstLike.forEach((port, i) => {
    nodes[port.id] = { x: regX + grid * 4 + i * grid * 6, y: regY + grid * 7 };
  });

  outputPorts.forEach((port) => {
    nodes[port.id] = { x: regX + grid * 11, y: regY };
  });

  return { version: 1, modules: { [moduleName]: { nodes } } };
}

function createArrayAddressReadVisualLayout(graph: DesignGraph, moduleName: string): SavedLayout {
  const designModule = graph.modules[moduleName];
  const readMux =
    designModule.nodes.find((node) => node.kind === 'mux' && node.label === 'read') ??
    designModule.nodes.find((node) => node.kind === 'mux');
  const inputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'input',
  );
  const outputPorts = designModule.nodes.filter(
    (node) => node.kind === 'port' && node.ports[0]?.direction === 'output',
  );
  const nodes: Record<string, { x: number; y: number }> = {};
  const grid = 24;
  const muxX = grid * 12;
  const muxY = grid * 6;

  if (readMux) {
    nodes[readMux.id] = { x: muxX, y: muxY };
  }

  inputPorts.forEach((port) => {
    if (port.label === 'address') {
      nodes[port.id] = { x: muxX - grid, y: muxY - grid * 5 };
    } else {
      nodes[port.id] = { x: grid, y: muxY + grid * 2 };
    }
  });

  outputPorts.forEach((port) => {
    nodes[port.id] = { x: muxX + grid * 9, y: muxY + grid * 2 };
  });

  return { version: 1, modules: { [moduleName]: { nodes } } };
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

function visualPort(
  id: string,
  label: string,
  direction: 'input' | 'output',
  x: number,
  y: number,
  isArray = false,
  width?: string,
): DiagramViewModel['nodes'][number] {
  return {
    id,
    kind: 'port',
    label,
    ports: [{ id: 'p', name: label, direction, isArrayNode: isArray, width }],
    position: { x, y },
    isArrayNode: isArray,
    metadata: { isArrayNode: isArray },
  };
}

function createLineJumpCrossingView(): DiagramViewModel {
  return {
    moduleName: 'line_jump_crossing_visual',
    nodes: [
      visualPort('source:a', 'a', 'input', 0, 108),
      visualPort('source:b', 'b', 'input', 120, 12),
      visualPort('target:x', 'x', 'output', 360, 108),
      visualPort('target:y', 'y', 'output', 360, 204),
      visualPort('source:c', 'c', 'input', 0, 156),
      visualPort('target:z', 'z', 'output', 360, 156),
    ],
    edges: [
      {
        id: 'edge-a-to-x',
        source: 'source:a',
        target: 'target:x',
        sourcePort: 'p',
        targetPort: 'p',
        routePoints: [
          { x: 144, y: 120 },
          { x: 336, y: 120 },
        ],
      },
      {
        id: 'edge-b-to-y',
        source: 'source:b',
        target: 'target:y',
        sourcePort: 'p',
        targetPort: 'p',
        routePoints: [
          { x: 264, y: 24 },
          { x: 240, y: 24 },
          { x: 240, y: 216 },
          { x: 336, y: 216 },
        ],
      },
      {
        id: 'edge-c-to-z',
        source: 'source:c',
        target: 'target:z',
        sourcePort: 'p',
        targetPort: 'p',
        routePoints: [
          { x: 144, y: 168 },
          { x: 0, y: 168 },
          { x: 0, y: 216 },
          { x: 360, y: 216 },
          { x: 360, y: 168 },
          { x: 336, y: 168 },
        ],
      },
    ],
    diagnostics: [],
  };
}

function createLineOverlapView(): DiagramViewModel {
  const port = (
    id: string,
    label: string,
    direction: 'input' | 'output',
    x: number,
    y: number,
  ): DiagramViewModel['nodes'][number] => ({
    id,
    kind: 'port',
    label,
    ports: [{ id: 'p', name: label, direction }],
    position: { x, y },
  });

  return {
    moduleName: 'line_overlap_visual',
    nodes: [
      port('source:a', 'a', 'input', 0, 108),
      port('source:b', 'b', 'input', 48, 108),
      port('target:x', 'x', 'output', 360, 108),
      port('target:y', 'y', 'output', 408, 108),
    ],
    edges: [
      {
        id: 'edge-a-to-x',
        source: 'source:a',
        target: 'target:x',
        sourcePort: 'p',
        targetPort: 'p',
        routePoints: [
          { x: 144, y: 120 },
          { x: 336, y: 120 },
        ],
      },
      {
        id: 'edge-b-to-y',
        source: 'source:b',
        target: 'target:y',
        sourcePort: 'p',
        targetPort: 'p',
        routePoints: [
          { x: 192, y: 120 },
          { x: 384, y: 120 },
        ],
      },
    ],
    diagnostics: [],
  };
}

function feedbackBlock(
  id: string,
  label: string,
  x: number,
  y: number,
): DiagramViewModel['nodes'][number] {
  const ports: DiagramViewModel['nodes'][number]['ports'] = [];
  for (let index = 0; index < 8; index += 1) {
    ports.push({ id: `in${index}`, name: `in${index}`, direction: 'input' });
  }
  for (let index = 0; index < 8; index += 1) {
    ports.push({ id: `out${index}`, name: `out${index}`, direction: 'output' });
  }

  return {
    id,
    kind: 'instance',
    label,
    ports,
    position: { x, y },
  };
}

function createFeedbackChainView(): DiagramViewModel {
  return {
    moduleName: 'feedback_chain_visual',
    nodes: [
      feedbackBlock('block:first', 'first', 0, 0),
      feedbackBlock('block:middle', 'middle', 264, 0),
      feedbackBlock('block:last', 'last', 528, 0),
    ],
    edges: [
      {
        id: 'edge-first-middle',
        source: 'block:first',
        target: 'block:middle',
        sourcePort: 'out0',
        targetPort: 'in0',
        signal: 'a',
      },
      {
        id: 'edge-middle-last',
        source: 'block:middle',
        target: 'block:last',
        sourcePort: 'out0',
        targetPort: 'in0',
        signal: 'b',
      },
      {
        id: 'edge-feedback',
        source: 'block:last',
        target: 'block:first',
        sourcePort: 'out0',
        targetPort: 'in0',
        signal: 'feedback',
      },
    ],
    diagnostics: [],
  };
}

function createSingleAssignmentRouteEditView(): DiagramViewModel {
  return {
    moduleName: 'single_assignment_route_edit',
    nodes: [
      visualPort('source:a', 'a', 'input', 0, 108),
      visualPort('target:y', 'y', 'output', 360, 204),
    ],
    edges: [
      {
        id: 'edge-a-to-y',
        source: 'source:a',
        target: 'target:y',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'a',
      },
    ],
    diagnostics: [],
  };
}

function createBranchedNetHighlightView(): DiagramViewModel {
  return {
    moduleName: 'branched_net_highlight',
    nodes: [
      visualPort('source:a', 'a', 'input', 0, 108),
      visualPort('source:b', 'b', 'input', 0, 204),
      visualPort('target:x', 'x', 'output', 360, 60),
      visualPort('target:y', 'y', 'output', 360, 156),
      visualPort('target:z', 'z', 'output', 360, 252),
    ],
    edges: [
      {
        id: 'edge-a-to-x',
        source: 'source:a',
        target: 'target:x',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'a',
      },
      {
        id: 'edge-a-to-y',
        source: 'source:a',
        target: 'target:y',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'a',
      },
      {
        id: 'edge-b-to-z',
        source: 'source:b',
        target: 'target:z',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'b',
      },
    ],
    diagnostics: [],
  };
}

function createCutBranchedNetView(): DiagramViewModel {
  const netKey = 'source:a:p';
  return {
    moduleName: 'branched_net_highlight',
    nodes: [
      visualPort('source:a', 'a', 'input', 0, 108),
      visualPort('target:x', 'x', 'output', 360, 60),
      visualPort('target:y', 'y', 'output', 360, 156),
      {
        id: 'cut-label:source:a:p:source',
        kind: 'netLabel',
        label: 'a',
        parentModule: 'branched_net_highlight',
        ports: [{ id: 'cut', name: 'cut', direction: 'input' }],
        position: { x: 144, y: 108 },
        metadata: {
          cutNet: {
            netKey,
            role: 'source',
            align: 'end',
            handleSide: 'left',
            originalEdgeId: 'edge-a-to-x',
          },
        },
      },
      {
        id: 'cut-label:source:a:p:sink:edge-a-to-x',
        kind: 'netLabel',
        label: 'a',
        parentModule: 'branched_net_highlight',
        ports: [{ id: 'cut', name: 'cut', direction: 'output' }],
        position: { x: 216, y: 60 },
        metadata: {
          cutNet: {
            netKey,
            role: 'sink',
            align: 'start',
            handleSide: 'right',
            originalEdgeId: 'edge-a-to-x',
          },
        },
      },
      {
        id: 'cut-label:source:a:p:sink:edge-a-to-y',
        kind: 'netLabel',
        label: 'a',
        parentModule: 'branched_net_highlight',
        ports: [{ id: 'cut', name: 'cut', direction: 'output' }],
        position: { x: 216, y: 156 },
        metadata: {
          cutNet: {
            netKey,
            role: 'sink',
            align: 'start',
            handleSide: 'right',
            originalEdgeId: 'edge-a-to-y',
          },
        },
      },
    ],
    edges: [
      {
        id: 'cut-stub:source:a:p:source',
        source: 'source:a',
        sourcePort: 'p',
        target: 'cut-label:source:a:p:source',
        targetPort: 'cut',
        signal: 'a',
        metadata: {
          forceStraight: true,
          cutStub: { netKey, role: 'source', originalEdgeId: 'edge-a-to-x' },
        },
      },
      {
        id: 'cut-stub:source:a:p:sink:edge-a-to-x',
        source: 'cut-label:source:a:p:sink:edge-a-to-x',
        sourcePort: 'cut',
        target: 'target:x',
        targetPort: 'p',
        signal: 'a',
        metadata: {
          forceStraight: true,
          cutStub: { netKey, role: 'sink', originalEdgeId: 'edge-a-to-x' },
        },
      },
      {
        id: 'cut-stub:source:a:p:sink:edge-a-to-y',
        source: 'cut-label:source:a:p:sink:edge-a-to-y',
        sourcePort: 'cut',
        target: 'target:y',
        targetPort: 'p',
        signal: 'a',
        metadata: {
          forceStraight: true,
          cutStub: { netKey, role: 'sink', originalEdgeId: 'edge-a-to-y' },
        },
      },
    ],
    diagnostics: [],
  };
}

function createEdgeNetLabelView(): DiagramViewModel {
  return {
    moduleName: 'edge_net_label',
    nodes: [
      visualPort('source:a', 'a', 'input', 0, 40),
      visualPort('target:y', 'y', 'output', 360, 40),
    ],
    edges: [
      {
        id: 'edge-a-to-y',
        source: 'source:a',
        target: 'target:y',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'y',
        label: 'x1',
        // 'a' and 'y' are this exact edge's own two endpoints (already shown
        // as the ports on either side), so the real pipeline filters them
        // out of the popover — only 'x2' (the other wire the chain passed
        // through) is worth surfacing there.
        metadata: { declaredNetName: 'x1', aliasNames: ['x2'] },
      },
    ],
    diagnostics: [],
  };
}

function createDeclaredAndSyntheticCutNetView(): DiagramViewModel {
  return {
    moduleName: 'declared_and_synthetic_cut_net',
    nodes: [
      visualPort('source:declared', 'chip_select', 'input', 0, 40),
      visualPort('source:synthetic', 'b', 'input', 0, 160),
      visualPort('source:renamed', 'c', 'input', 0, 280),
      {
        id: 'cut-label:declared:source',
        kind: 'netLabel',
        label: 'chip_select',
        parentModule: 'declared_and_synthetic_cut_net',
        ports: [{ id: 'cut', name: 'cut', direction: 'input' }],
        // Wider than the other rows' x=144: "chip_select" is long enough to
        // auto-widen its source port node past that x, so a label placed
        // there would sit flush against (or behind) the port's own right
        // edge — tripping the router's "backward connection" loop-back
        // heuristic instead of a plain short stub.
        // y matches labelPositionForHandlePoint's real formula (port lead's
        // y minus half the label's own height) so the stub renders as a
        // straight line, same as a real cut net — not an arbitrary bend.
        position: { x: 192, y: 28 },
        metadata: {
          cutNet: {
            netKey: 'declared',
            role: 'source',
            align: 'end',
            handleSide: 'left',
            originalEdgeId: 'edge-declared',
            origin: 'declared',
          },
        },
      },
      {
        // A net freshly cut with no formal declared name still carries a
        // legitimate default label — it must render in regular type until
        // the user actively renames it away from that default.
        id: 'cut-label:synthetic:source',
        kind: 'netLabel',
        label: 'NET_1',
        parentModule: 'declared_and_synthetic_cut_net',
        ports: [{ id: 'cut', name: 'cut', direction: 'input' }],
        // y = port lead's y (160 + 12) minus half the label's own height
        // (24), matching labelPositionForHandlePoint, for a straight stub.
        position: { x: 144, y: 148 },
        metadata: {
          cutNet: {
            netKey: 'synthetic',
            role: 'source',
            align: 'end',
            handleSide: 'left',
            originalEdgeId: 'edge-synthetic',
            origin: 'synthetic',
            isRenamed: false,
            aliasNames: ['legacy_a', 'legacy_b'],
          },
        },
      },
      {
        // Already diverged from its default label ("NET_2") — this is the
        // italic, revertable state.
        id: 'cut-label:renamed:source',
        kind: 'netLabel',
        label: 'my_custom_name',
        parentModule: 'declared_and_synthetic_cut_net',
        ports: [{ id: 'cut', name: 'cut', direction: 'input' }],
        // y = port lead's y (280 + 12) minus half the label's own height
        // (24), matching labelPositionForHandlePoint, for a straight stub.
        position: { x: 144, y: 268 },
        metadata: {
          cutNet: {
            netKey: 'renamed',
            role: 'source',
            align: 'end',
            handleSide: 'left',
            originalEdgeId: 'edge-renamed',
            origin: 'synthetic',
            isRenamed: true,
          },
        },
      },
    ],
    edges: [
      {
        id: 'cut-stub:declared:source',
        source: 'source:declared',
        sourcePort: 'p',
        target: 'cut-label:declared:source',
        targetPort: 'cut',
        signal: 'chip_select',
        metadata: {
          forceStraight: true,
          cutStub: { netKey: 'declared', role: 'source', originalEdgeId: 'edge-declared' },
        },
      },
      {
        id: 'cut-stub:synthetic:source',
        source: 'source:synthetic',
        sourcePort: 'p',
        target: 'cut-label:synthetic:source',
        targetPort: 'cut',
        signal: 'b',
        metadata: {
          forceStraight: true,
          cutStub: { netKey: 'synthetic', role: 'source', originalEdgeId: 'edge-synthetic' },
        },
      },
      {
        id: 'cut-stub:renamed:source',
        source: 'source:renamed',
        sourcePort: 'p',
        target: 'cut-label:renamed:source',
        targetPort: 'cut',
        signal: 'c',
        metadata: {
          forceStraight: true,
          cutStub: { netKey: 'renamed', role: 'source', originalEdgeId: 'edge-renamed' },
        },
      },
    ],
    diagnostics: [],
  };
}

function createStyledCutNetView(): DiagramViewModel {
  // One row per wire style, top to bottom: single-bit, multi-bit, struct,
  // interface, single-bit array, multi-bit array.
  const rows: Array<{
    key: string;
    label: string;
    srcLabel: string;
    tgtLabel: string;
    edgeStyle: { aggregate?: 'struct' | 'interface'; isStacked?: boolean; thick?: boolean };
    stackedPorts?: boolean;
    portWidth?: string;
  }> = [
    { key: 'plain', label: 'bit_lane', srcLabel: 'bit_i', tgtLabel: 'bit_o', edgeStyle: {} },
    {
      key: 'thick',
      label: 'data_bus',
      srcLabel: 'data_i',
      tgtLabel: 'data_o',
      edgeStyle: { thick: true },
      portWidth: '[7:0]',
    },
    {
      key: 'struct',
      label: 'packet_bus',
      srcLabel: 'pkt_i',
      tgtLabel: 'pkt_o',
      edgeStyle: { aggregate: 'struct' },
    },
    {
      key: 'interface',
      label: 'if_link',
      srcLabel: 'if_m',
      tgtLabel: 'if_s',
      edgeStyle: { aggregate: 'interface' },
    },
    {
      key: 'stacked',
      label: 'array_lane',
      srcLabel: 'arr_i',
      tgtLabel: 'arr_o',
      edgeStyle: { isStacked: true },
      stackedPorts: true,
    },
    {
      key: 'wstacked',
      label: 'array_bus',
      srcLabel: 'abus_i',
      tgtLabel: 'abus_o',
      edgeStyle: { isStacked: true, thick: true },
      stackedPorts: true,
      portWidth: '[7:0]',
    },
  ];

  const nodes: DiagramViewModel['nodes'] = [];
  const edges: DiagramViewModel['edges'] = [];
  rows.forEach((row, i) => {
    const labelY = 120 + i * 72;
    const portY = labelY + 12;
    nodes.push(
      visualPort(
        `source:${row.key}`,
        row.srcLabel,
        'input',
        0,
        portY,
        row.stackedPorts,
        row.portWidth,
      ),
    );
    nodes.push(
      visualPort(
        `target:${row.key}`,
        row.tgtLabel,
        'output',
        600,
        portY,
        row.stackedPorts,
        row.portWidth,
      ),
    );
    nodes.push(
      styledCutLabelNode(
        `cut-label:styled:${row.key}:source`,
        row.label,
        `styled:${row.key}`,
        'source',
        168,
        labelY,
        'end',
        'left',
        row.edgeStyle,
        row.stackedPorts,
      ),
    );
    nodes.push(
      styledCutLabelNode(
        `cut-label:styled:${row.key}:sink`,
        row.label,
        `styled:${row.key}`,
        'sink',
        432,
        labelY,
        'start',
        'right',
        row.edgeStyle,
        row.stackedPorts,
      ),
    );
    edges.push(
      styledCutStubEdge(
        `cut-stub:styled:${row.key}:source`,
        `source:${row.key}`,
        `cut-label:styled:${row.key}:source`,
        `styled:${row.key}`,
        'source',
        row.edgeStyle,
      ),
    );
    edges.push(
      styledCutStubEdge(
        `cut-stub:styled:${row.key}:sink`,
        `cut-label:styled:${row.key}:sink`,
        `target:${row.key}`,
        `styled:${row.key}`,
        'sink',
        row.edgeStyle,
      ),
    );
  });

  return {
    moduleName: 'styled_cut_net_labels',
    nodes,
    edges,
    diagnostics: [],
  };
}

function styledCutLabelNode(
  id: string,
  label: string,
  netKey: string,
  role: 'source' | 'sink',
  x: number,
  y: number,
  align: 'start' | 'end',
  handleSide: 'left' | 'right' | 'top' | 'bottom',
  edgeStyle: { aggregate?: 'struct' | 'interface'; isStacked?: boolean; thick?: boolean },
  isSourceStacked?: boolean,
): DiagramViewModel['nodes'][number] {
  return {
    id,
    kind: 'netLabel',
    label,
    parentModule: 'styled_cut_net_labels',
    ports: [
      {
        id: 'cut',
        name: 'cut',
        direction: role === 'source' ? 'input' : 'output',
      },
    ],
    position: { x, y },
    isArrayNode: !!isSourceStacked,
    metadata: {
      cutNet: {
        netKey,
        role,
        align,
        handleSide,
        edgeStyle,
        isSourceStacked: !!isSourceStacked,
      },
    },
  };
}

function styledCutStubEdge(
  id: string,
  source: string,
  target: string,
  netKey: string,
  role: 'source' | 'sink',
  edgeStyle: { aggregate?: 'struct' | 'interface'; isStacked?: boolean; thick?: boolean },
  customPort?: string,
): DiagramViewModel['edges'][number] {
  return {
    id,
    source,
    target,
    sourcePort: role === 'source' ? (customPort && role === 'source' ? customPort : 'p') : 'cut',
    targetPort: role === 'source' ? 'cut' : customPort && role === 'sink' ? customPort : 'p',
    signal: netKey,
    width: edgeStyle.thick ? '[7:0]' : undefined,
    isStacked: edgeStyle.isStacked,
    metadata: {
      ...(edgeStyle.aggregate ? { aggregate: edgeStyle.aggregate } : {}),
      forceStraight: true,
      cutStub: { netKey, role, originalEdgeId: `edge:${netKey}` },
    },
  };
}

function createRegisterClockCutView(): DiagramViewModel {
  const grid = 24;
  const regX = grid * 8; // 192
  const regY = grid * 2; // 48
  return {
    moduleName: 'register_clock_cut_visual',
    nodes: [
      {
        id: 'reg:target',
        kind: 'register',
        label: 'state_reg',
        ports: [
          { id: 'port:D', name: 'D', direction: 'input' },
          { id: 'port:Q', name: 'Q', direction: 'output' },
          { id: 'port:clk', name: 'clk', direction: 'input', isArray: true },
          { id: 'port:reset', name: 'reset', direction: 'input' },
        ],
        metadata: {
          resetSignal: 'reset',
          clockSignal: 'clk',
        },
        isArrayNode: true,
        position: { x: regX, y: regY },
      },
      visualPort('source:clk', 'clk', 'input', 0, 156),
      styledCutLabelNode(
        'cut-label:clk_n',
        'clk',
        'clock_net',
        'source',
        168,
        144,
        'end',
        'left',
        { isStacked: true },
        false,
      ), // isSourceStacked: false
      styledCutLabelNode(
        'cut-label:clk_sink',
        'clk',
        'clock_net',
        'sink',
        432,
        144,
        'start',
        'right',
        { isStacked: true },
        false,
      ), // isSourceStacked: false
    ],
    edges: [
      styledCutStubEdge(
        'cut-stub:clk:source',
        'source:clk',
        'cut-label:clk_n',
        'clock_net',
        'source',
        { isStacked: true },
      ),
      styledCutStubEdge(
        'cut-stub:clk:sink',
        'cut-label:clk_sink',
        'reg:target',
        'clock_net',
        'sink',
        { isStacked: true },
        'port:clk',
      ),
    ],
    diagnostics: [],
  };
}

function createLiteralFanoutHighlightView(): DiagramViewModel {
  return {
    moduleName: 'literal_fanout_highlight',
    nodes: [
      {
        id: 'literal:fsm_literal:IDLE:IDLE',
        kind: 'literal',
        label: 'IDLE',
        ports: [
          { id: 'port:IDLE', name: 'IDLE', direction: 'output', width: '[1:0]' },
          {
            id: 'port:next_state_DONE',
            name: 'next_state_DONE',
            direction: 'output',
            width: '[1:0]',
          },
          {
            id: 'port:next_state_default',
            name: 'next_state_default',
            direction: 'output',
            width: '[1:0]',
          },
        ],
        position: { x: 0, y: 108 },
      },
      visualPort('sink:reset', 'state_reg', 'output', 360, 60),
      visualPort('sink:done', 'DONE', 'output', 360, 156),
      visualPort('sink:default', 'default', 'output', 360, 252),
    ],
    edges: [
      {
        id: 'edge-idle-reset',
        source: 'literal:fsm_literal:IDLE:IDLE',
        target: 'sink:reset',
        sourcePort: 'port:IDLE',
        targetPort: 'p',
        signal: 'IDLE',
      },
      {
        id: 'edge-idle-done',
        source: 'literal:fsm_literal:IDLE:IDLE',
        target: 'sink:done',
        sourcePort: 'port:next_state_DONE',
        targetPort: 'p',
        signal: 'next_state_DONE',
      },
      {
        id: 'edge-idle-default',
        source: 'literal:fsm_literal:IDLE:IDLE',
        target: 'sink:default',
        sourcePort: 'port:next_state_default',
        targetPort: 'p',
        signal: 'next_state_default',
      },
    ],
    diagnostics: [],
  };
}

function createSharedBranchedRouteView(): DiagramViewModel {
  return {
    moduleName: 'shared_branched_route',
    nodes: [
      visualPort('source:a', 'a', 'input', 0, 108),
      visualPort('source:b', 'b', 'input', 0, 252),
      visualPort('target:x', 'x', 'output', 360, 60),
      visualPort('target:y', 'y', 'output', 360, 156),
      visualPort('target:z', 'z', 'output', 360, 252),
    ],
    edges: [
      {
        id: 'edge-a-to-x',
        source: 'source:a',
        target: 'target:x',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'a',
        routePoints: [
          { x: 144, y: 120 },
          { x: 240, y: 120 },
          { x: 240, y: 168 },
          { x: 336, y: 168 },
          { x: 336, y: 72 },
        ],
      },
      {
        id: 'edge-a-to-y',
        source: 'source:a',
        target: 'target:y',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'a',
        routePoints: [
          { x: 144, y: 120 },
          { x: 240, y: 120 },
          { x: 240, y: 168 },
          { x: 336, y: 168 },
        ],
      },
      {
        id: 'edge-b-to-z',
        source: 'source:b',
        target: 'target:z',
        sourcePort: 'p',
        targetPort: 'p',
        signal: 'b',
        routePoints: [
          { x: 144, y: 264 },
          { x: 336, y: 264 },
        ],
      },
    ],
    diagnostics: [],
  };
}

function createNodeSizingGalleryView(extended: boolean): DiagramViewModel {
  const long = 'wide_label_growth';
  const label = (shortLabel: string) => (extended ? `${shortLabel}_${long}` : shortLabel);
  const width = extended ? '[255:0]' : undefined;
  const grid = 24;
  const secondColumnX = grid * (extended ? 24 : 12);
  const nodes: DiagramViewModel['nodes'] = [
    {
      id: 'port:in',
      kind: 'port',
      label: label('a'),
      ports: [{ id: 'p', name: label('a'), direction: 'input', width }],
      position: { x: 0, y: 0 },
    },
    {
      id: 'port:out',
      kind: 'port',
      label: label('y'),
      ports: [{ id: 'p', name: label('y'), direction: 'output', width }],
      position: { x: secondColumnX, y: 0 },
    },
    {
      id: 'mux',
      kind: 'mux',
      label: 'case sel',
      ports: [
        { id: 'sel', name: 'sel', direction: 'input' },
        { id: 'i0', name: 'i0', label: extended ? long : "1'b0", direction: 'input', width },
        {
          id: 'i1',
          name: 'i1',
          label: extended ? `default_${long}` : 'default',
          direction: 'input',
        },
        { id: 'y', name: extended ? long : 'y', direction: 'output' },
      ],
      position: { x: 0, y: grid * 4 },
    },
    {
      id: 'register',
      kind: 'register',
      label: label('q'),
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'clk', name: 'clk', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' },
      ],
      metadata: width ? { width } : undefined,
      position: { x: secondColumnX, y: grid * 4 },
    },
    {
      id: 'comb',
      kind: 'comb',
      label: label('comb'),
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('decoded'), direction: 'output', width },
      ],
      position: { x: 0, y: grid * 9 },
    },
    {
      id: 'literal:value',
      kind: 'literal',
      label: extended ? label("8'h42") : "8'h42",
      ports: [
        {
          id: 'out',
          name: extended ? label('literal_y') : 'literal_y',
          direction: 'output',
          width,
        },
      ],
      position: { x: 0, y: grid * 14 },
    },
    {
      id: 'literal:constant',
      kind: 'literal',
      label: label('VERSION'),
      ports: [
        {
          id: 'out',
          name: extended ? label('version_y') : 'version_y',
          direction: 'output',
          width,
        },
      ],
      position: { x: secondColumnX, y: grid * 14 },
    },
    {
      id: 'bus',
      kind: 'bus',
      label: label('instr'),
      ports: [
        { id: 'in', name: 'instr', direction: 'input', width: '[31:0]' },
        {
          id: 'tap',
          name: extended ? long : '[14:12]',
          label: extended ? long : '[14:12]',
          direction: 'output',
        },
      ],
      position: { x: secondColumnX, y: grid * 9 },
    },
    {
      id: 'alu',
      kind: 'alu',
      label: '',
      metadata: { operation: extended ? '-' : '+' },
      ports: [
        { id: 'lhs', name: 'lhs', direction: 'input', width },
        { id: 'rhs', name: 'rhs', direction: 'input', width },
        { id: 'out', name: extended ? label('sum') : 'sum', direction: 'output', width },
      ],
      position: { x: secondColumnX, y: grid * 19 },
    },
    {
      id: 'instance',
      kind: 'instance',
      label: label('u_child'),
      instanceOf: label('child_sink'),
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('y'), direction: 'output', width },
      ],
      position: { x: 0, y: grid * 19 },
    },
    {
      id: 'module',
      kind: 'module',
      label: label('submodule'),
      moduleName: 'submodule',
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('y'), direction: 'output', width },
      ],
      position: { x: extended ? 0 : secondColumnX, y: grid * 24 },
    },
    {
      id: 'unknown',
      kind: 'unknown',
      label: label('unsupported'),
      ports: [
        { id: 'a', name: label('a'), direction: 'input', width },
        { id: 'y', name: label('y'), direction: 'output', width },
      ],
      position: { x: 0, y: grid * 29 },
    },
  ];

  return {
    moduleName: extended ? 'node_sizing_extended' : 'node_sizing_defaults',
    nodes,
    edges: [],
    diagnostics: [],
  };
}

async function dragFirstVerticalSegmentBy(page: Page, dx: number, dy: number): Promise<void> {
  const segment = page.locator('.svsch-edge-segment-vertical').first();
  const box = await segment.boundingBox();
  if (!box) {
    throw new Error('Unable to locate vertical route segment');
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function dragFirstVerticalSegmentByEdge(
  page: Page,
  edgeId: string,
  dx: number,
  dy: number,
): Promise<void> {
  const segment = page
    .locator(`.react-flow__edge[data-id="${edgeId}"] .svsch-edge-segment-vertical`)
    .first();
  const box = await segment.boundingBox();
  if (!box) {
    throw new Error(`Unable to locate vertical route segment for ${edgeId}`);
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function dragLastVerticalSegmentByEdge(
  page: Page,
  edgeId: string,
  dx: number,
  dy: number,
): Promise<void> {
  const segment = page
    .locator(`.react-flow__edge[data-id="${edgeId}"] .svsch-edge-segment-vertical`)
    .last();
  const box = await segment.boundingBox();
  if (!box) {
    throw new Error(`Unable to locate vertical route segment for ${edgeId}`);
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function firstVerticalSegmentX(page: Page): Promise<number> {
  const path = await page.locator('.svsch-edge').first().getAttribute('d');
  if (!path) {
    throw new Error('Unable to locate edge path');
  }

  const points = parsePathPoints(path);
  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (Math.abs(point.x - next.x) < 0.5 && Math.abs(point.y - next.y) > 0.5) {
      return point.x;
    }
  }

  throw new Error(`Unable to find vertical segment in path: ${path}`);
}

async function firstEditableVerticalSegmentX(page: Page, edgeId: string): Promise<number> {
  const path = await page
    .locator(`.react-flow__edge[data-id="${edgeId}"] .svsch-edge-segment-vertical`)
    .first()
    .getAttribute('d');
  if (!path) {
    throw new Error(`Unable to locate editable vertical segment path for ${edgeId}`);
  }
  return parsePathPoints(path)[0]?.x ?? Number.NaN;
}

async function lastEditableVerticalSegmentX(page: Page, edgeId: string): Promise<number> {
  const path = await page
    .locator(`.react-flow__edge[data-id="${edgeId}"] .svsch-edge-segment-vertical`)
    .last()
    .getAttribute('d');
  if (!path) {
    throw new Error(`Unable to locate editable vertical segment path for ${edgeId}`);
  }
  return parsePathPoints(path)[0]?.x ?? Number.NaN;
}

async function firstEditableHorizontalSegmentY(page: Page, edgeId: string): Promise<number> {
  const path = await page
    .locator(`.react-flow__edge[data-id="${edgeId}"] .svsch-edge-segment-horizontal`)
    .first()
    .getAttribute('d');
  if (!path) {
    throw new Error(`Unable to locate editable horizontal segment path for ${edgeId}`);
  }
  return parsePathPoints(path)[0]?.y ?? Number.NaN;
}

function parsePathPoints(pathData: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const commandPattern = /[ML]\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/g;
  let match = commandPattern.exec(pathData);
  while (match) {
    points.push({ x: Number.parseFloat(match[1]), y: Number.parseFloat(match[2]) });
    match = commandPattern.exec(pathData);
  }
  return points;
}

async function installStableTheme(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      :root {
        --vscode-editor-background: #000000;
        --vscode-editor-foreground: #d6d6d6;
        --vscode-font-family: Arial, sans-serif;
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
      }
    `,
  });
}
