import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runParser } from '../helper';
import {
  buildViewModel,
  defaultNetCutLabel,
  elkNodeForDiagramNode,
  elkRoutingNodeForDiagramNode,
  enforceMinimumBlockGaps,
  firstOpenAutoCutEdges,
  markFirstOpenHandled,
  mergeEdgeRoutePoints,
  mergeEdgeSnapshot,
  mergeEdgeWaypoint,
  mergeFirstOpenNetCuts,
  mergeNetCut,
  mergeNetCuts,
  mergeNodePositions,
  mergeNodeSnapshot,
  mergeRegionBounds,
  mergeRelayoutSelection,
  mergeRerouteEdges,
  mergeRerouteLayout,
  removeNetCut,
  renameCutNet,
  resetCutLabelPosition,
  revertCutNetLabel,
  revertNodeSize,
  revertNodeSizes,
} from '../../src/layout/mergeLayout';
import {
  diagramSizing,
  ioPortCenterOffset,
  muxHeightForPortRows,
  nodeHeightForPortRows,
  nodePortCenterOffset,
} from '../../src/diagram/constants';
import { diagramNodeDimensions, resolvedNodeDimensions } from '../../src/diagram/nodeSizing';
import { edgeNetKey } from '../../src/ir/edgeNet';
import type { DesignGraph, DiagramEdge, DiagramNode, PositionedNode } from '../../src/ir/types';
import { LayoutStore, type SavedLayout } from '../../src/storage/layoutStore';

function boundsOf(node: PositionedNode): { x: number; y: number; width: number; height: number } {
  const { width, height } = diagramNodeDimensions(node);
  return { x: node.position.x, y: node.position.y, width, height };
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const graph: DesignGraph = {
  rootModules: ['top'],
  generatedAt: 'now',
  diagnostics: [],
  modules: {
    top: {
      name: 'top',
      file: 'top.sv',
      ports: [],
      edges: [{ id: 'e-a-u', source: 'a', target: 'u' }],
      nodes: [
        { id: 'a', kind: 'port', label: 'a', ports: [] },
        { id: 'u', kind: 'instance', label: 'u', ports: [] },
      ],
    },
  },
};

const fanoutGraph: DesignGraph = {
  rootModules: ['top'],
  generatedAt: 'now',
  diagnostics: [],
  modules: {
    top: {
      name: 'top',
      file: 'top.sv',
      ports: [],
      nodes: [
        {
          id: 'clk',
          kind: 'port',
          label: 'clk',
          ports: [{ id: 'p', name: 'clk', direction: 'input' }],
        },
        {
          id: 'u1',
          kind: 'instance',
          label: 'u1',
          ports: [{ id: 'in', name: 'in', direction: 'input' }],
        },
        {
          id: 'u2',
          kind: 'instance',
          label: 'u2',
          ports: [{ id: 'in', name: 'in', direction: 'input' }],
        },
      ],
      edges: [
        {
          id: 'e-clk-u1',
          source: 'clk',
          sourcePort: 'p',
          target: 'u1',
          targetPort: 'in',
          signal: 'clk',
        },
        {
          id: 'e-clk-u2',
          source: 'clk',
          sourcePort: 'p',
          target: 'u2',
          targetPort: 'in',
          signal: 'clk',
        },
      ],
    },
  },
};

const twoNetGraph: DesignGraph = {
  rootModules: ['top'],
  generatedAt: 'now',
  diagnostics: [],
  modules: {
    top: {
      name: 'top',
      file: 'top.sv',
      ports: [],
      nodes: [
        { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'p', name: 'a', direction: 'output' }] },
        { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'p', name: 'b', direction: 'output' }] },
        { id: 'x', kind: 'port', label: 'x', ports: [{ id: 'p', name: 'x', direction: 'input' }] },
        { id: 'y', kind: 'port', label: 'y', ports: [{ id: 'p', name: 'y', direction: 'input' }] },
      ],
      edges: [
        { id: 'e-a-x', source: 'a', sourcePort: 'p', target: 'x', targetPort: 'p' },
        { id: 'e-b-y', source: 'b', sourcePort: 'p', target: 'y', targetPort: 'p' },
      ],
    },
  },
};

describe('first-open auto-cuts', () => {
  const module = {
    name: 'top',
    file: 'top.sv',
    ports: [],
    nodes: [
      {
        id: 'src',
        kind: 'port' as const,
        label: 'src',
        ports: [{ id: 'out', name: 'src', direction: 'output' as const }],
      },
      {
        id: 'reg',
        kind: 'register' as const,
        label: 'q',
        clockSignal: 'clk',
        resetSignal: 'rst_n',
        ports: [
          { id: 'd', name: 'D', direction: 'input' as const },
          { id: 'clock-pin', name: 'clk', direction: 'input' as const },
          { id: 'reset-pin', name: 'rst_n', direction: 'input' as const },
        ],
      },
      {
        id: 'sink',
        kind: 'instance' as const,
        label: 'sink',
        ports: [{ id: 'in', name: 'in', direction: 'input' as const }],
      },
    ],
    edges: [
      {
        id: 'clock',
        source: 'clock-src',
        sourcePort: 'out',
        target: 'reg',
        targetPort: 'clock-pin',
      },
      {
        id: 'reset',
        source: 'reset-src',
        sourcePort: 'out',
        target: 'reg',
        targetPort: 'reset-pin',
      },
      { id: 'data', source: 'src', sourcePort: 'out', target: 'reg', targetPort: 'd' },
      {
        id: 'declared',
        source: 'named-src',
        sourcePort: 'out',
        target: 'sink',
        targetPort: 'in',
        metadata: { declaredNetName: 'named_wire' },
      },
      { id: 'inline', source: 'reg', sourcePort: 'd', target: 'sink', targetPort: 'in' },
    ],
  };

  it('selects register control nets and declared-name nets', () => {
    expect(firstOpenAutoCutEdges(module, true).map((edge) => edge.id)).toEqual([
      'clock',
      'reset',
      'declared',
    ]);
  });

  it('can disable register control cuts without disabling declared nets', () => {
    expect(firstOpenAutoCutEdges(module, false).map((edge) => edge.id)).toEqual(['declared']);
  });

  it('does not auto-cut an untagged compound event-control signal', () => {
    // A register whose compound `always_ff` sensitivity list has no signal matching
    // svsch.clockSignalNames/resetSignalNames -- so the extractor leaves clockSignal
    // and resetSignal unset, and the extra event-control ports (a, b, c) must not be
    // first-open auto-cut even though includeClockAndReset is true.
    const compoundModule = {
      name: 'top',
      file: 'top.sv',
      ports: [],
      nodes: [
        {
          id: 'reg',
          kind: 'register' as const,
          label: 'q',
          ports: [
            { id: 'd', name: 'D', direction: 'input' as const },
            { id: 'a-pin', name: 'a', direction: 'input' as const },
            { id: 'b-pin', name: 'b', direction: 'input' as const },
            { id: 'c-pin', name: 'c', direction: 'input' as const },
          ],
        },
      ],
      edges: [
        { id: 'a-edge', source: 'a-src', sourcePort: 'out', target: 'reg', targetPort: 'a-pin' },
        { id: 'b-edge', source: 'b-src', sourcePort: 'out', target: 'reg', targetPort: 'b-pin' },
        { id: 'c-edge', source: 'c-src', sourcePort: 'out', target: 'reg', targetPort: 'c-pin' },
      ],
    };
    expect(firstOpenAutoCutEdges(compoundModule, true).map((edge) => edge.id)).toEqual([]);
  });

  it('auto-cuts every declared-net edge across mutually exclusive generate arms', () => {
    // Two generate arms (e.g. `g_other`/`g_zero`) each drive the module's
    // `y` output from their own internal source node — different netKeys
    // (different source nodes), same declared net. Both still get auto-cut;
    // buildNetCutProjection (see below) is what collapses their sink ends
    // down to one, not this selection step.
    const generateArmModule = {
      name: 'top',
      file: 'top.sv',
      ports: [],
      nodes: [
        {
          id: 'g_other_driver',
          kind: 'comb' as const,
          label: 'assign',
          ports: [{ id: 'out', name: 'out', direction: 'output' as const }],
        },
        {
          id: 'g_zero_driver',
          kind: 'comb' as const,
          label: 'assign',
          ports: [{ id: 'out', name: 'out', direction: 'output' as const }],
        },
        {
          id: 'y',
          kind: 'port' as const,
          label: 'y',
          ports: [{ id: 'p', name: 'y', direction: 'output' as const }],
        },
      ],
      edges: [
        {
          id: 'g_other-y',
          source: 'g_other_driver',
          sourcePort: 'out',
          target: 'y',
          targetPort: 'p',
          metadata: {
            declaredNetName: 'y',
            generateRegionId: 'g_other',
            generateActiveState: 'inactive',
          },
        },
        {
          id: 'g_zero-y',
          source: 'g_zero_driver',
          sourcePort: 'out',
          target: 'y',
          targetPort: 'p',
          metadata: {
            declaredNetName: 'y',
            generateRegionId: 'g_zero',
            generateActiveState: 'active',
          },
        },
      ],
    };

    expect(firstOpenAutoCutEdges(generateArmModule, true).map((edge) => edge.id)).toEqual([
      'g_other-y',
      'g_zero-y',
    ]);
  });

  it('collapses duplicate sink ends across mutually exclusive generate arms', async () => {
    // Both g_other's and g_zero's edges are auto-cut (see the test above),
    // each keeping its own dead-end source label near its own driver. But
    // routing *both* of their sink stubs into the real `y` port would stack
    // a redundant, overlapping cut-net-end on top of the same target — so
    // only one sink label/stub should survive; neither edge should be left
    // as a live wire straight into the output port. The `y` port is always
    // driven by whichever arm is actually active, so the surviving label
    // must be g_zero's (the active arm), not g_other's (inactive) even
    // though "g_other-y" sorts first alphabetically — the target itself is
    // never left undriven, so its cut-net end must never dim.
    const generateArmModule = {
      name: 'top',
      file: 'top.sv',
      ports: [],
      nodes: [
        {
          id: 'g_other_driver',
          kind: 'comb' as const,
          label: 'assign',
          ports: [{ id: 'out', name: 'out', direction: 'output' as const }],
        },
        {
          id: 'g_zero_driver',
          kind: 'comb' as const,
          label: 'assign',
          ports: [{ id: 'out', name: 'out', direction: 'output' as const }],
        },
        {
          id: 'y',
          kind: 'port' as const,
          label: 'y',
          ports: [{ id: 'p', name: 'y', direction: 'output' as const }],
        },
      ],
      edges: [
        {
          id: 'g_other-y',
          source: 'g_other_driver',
          sourcePort: 'out',
          target: 'y',
          targetPort: 'p',
          metadata: {
            declaredNetName: 'y',
            generateRegionId: 'g_other',
            generateActiveState: 'inactive',
          },
        },
        {
          id: 'g_zero-y',
          source: 'g_zero_driver',
          sourcePort: 'out',
          target: 'y',
          targetPort: 'p',
          metadata: {
            declaredNetName: 'y',
            generateRegionId: 'g_zero',
            generateActiveState: 'active',
          },
        },
      ],
    };
    const positioned: PositionedNode[] = [
      { ...generateArmModule.nodes[0], position: { x: 0, y: 0 } },
      { ...generateArmModule.nodes[1], position: { x: 0, y: 96 } },
      { ...generateArmModule.nodes[2], position: { x: 240, y: 96 } },
    ];

    const firstCutEdge = generateArmModule.edges.find((edge) => edge.id === 'g_other-y')!;
    const secondCutEdge = generateArmModule.edges.find((edge) => edge.id === 'g_zero-y')!;
    const cutLayout = [firstCutEdge, secondCutEdge].reduce(
      (layout, edge) => mergeNetCut(layout, 'top', edge, generateArmModule, positioned),
      { version: 1, modules: {} } as SavedLayout,
    );
    const view = await buildViewModel(
      {
        rootModules: ['top'],
        generatedAt: 'now',
        diagnostics: [],
        modules: { top: generateArmModule },
      },
      'top',
      cutLayout,
    );

    const firstNetKey = edgeNetKey(firstCutEdge);
    const secondNetKey = edgeNetKey(secondCutEdge);
    const byId = new Map(view.nodes.map((node) => [node.id, node]));

    // Each arm keeps its own dead-end source label near its own driver.
    expect(byId.has(`cut-label:${firstNetKey}:source`)).toBe(true);
    expect(byId.has(`cut-label:${secondNetKey}:source`)).toBe(true);

    // Only the active arm's (g_zero's) sink label/stub lands on the shared
    // `y` port...
    expect(byId.has(`cut-label:${secondNetKey}:sink:${secondCutEdge.id}`)).toBe(true);
    expect(
      view.edges.some((edge) => edge.id === `cut-stub:${secondNetKey}:sink:${secondCutEdge.id}`),
    ).toBe(true);
    const sinkLabel = byId.get(`cut-label:${secondNetKey}:sink:${secondCutEdge.id}`);
    expect(sinkLabel?.metadata?.generateActiveState).toBe('active');

    // ...the inactive arm's redundant one is skipped entirely.
    expect(byId.has(`cut-label:${firstNetKey}:sink:${firstCutEdge.id}`)).toBe(false);
    expect(
      view.edges.some((edge) => edge.id === `cut-stub:${firstNetKey}:sink:${firstCutEdge.id}`),
    ).toBe(false);

    // Neither arm is left as a live wire straight into the output port.
    expect(view.edges.some((edge) => edge.id === 'g_other-y')).toBe(false);
    expect(view.edges.some((edge) => edge.id === 'g_zero-y')).toBe(false);
  });

  it('keeps links touching interface nodes whole on first open', () => {
    const interfaceModule = {
      name: 'top',
      file: 'top.sv',
      ports: [],
      nodes: [
        {
          id: 'clk',
          kind: 'port' as const,
          label: 'clk',
          ports: [{ id: 'p', name: 'clk', direction: 'input' as const }],
        },
        {
          id: 'link',
          kind: 'interface' as const,
          label: 'link',
          ports: [{ id: 'clk', name: 'clk', direction: 'input' as const }],
        },
        {
          id: 'consumer',
          kind: 'instance' as const,
          label: 'consumer',
          ports: [{ id: 'bus', name: 'bus', direction: 'input' as const }],
        },
        {
          id: 'src',
          kind: 'port' as const,
          label: 'src',
          ports: [{ id: 'p', name: 'src', direction: 'input' as const }],
        },
        {
          id: 'sink',
          kind: 'port' as const,
          label: 'sink',
          ports: [{ id: 'p', name: 'sink', direction: 'output' as const }],
        },
      ],
      edges: [
        {
          id: 'clk-link',
          source: 'clk',
          sourcePort: 'p',
          target: 'link',
          targetPort: 'clk',
          metadata: { declaredNetName: 'clk' },
        },
        {
          id: 'link-consumer',
          source: 'link',
          sourcePort: 'clk',
          target: 'consumer',
          targetPort: 'bus',
          metadata: { declaredNetName: 'link' },
        },
        {
          id: 'ordinary',
          source: 'src',
          sourcePort: 'p',
          target: 'sink',
          targetPort: 'p',
          metadata: { declaredNetName: 'ordinary' },
        },
      ],
    };

    expect(firstOpenAutoCutEdges(interfaceModule, true).map((edge) => edge.id)).toEqual([
      'ordinary',
    ]);
  });

  it(
    'columnizes a top-level port that lost every edge to ' +
      'a first-open cut, flanking the rest of the design',
    async () => {
      const designModule = {
        name: 'top',
        file: 'top.sv',
        ports: [],
        nodes: [
          {
            id: 'a',
            kind: 'port' as const,
            label: 'a',
            ports: [{ id: 'out', name: 'a', direction: 'input' as const }],
          },
          {
            id: 'u',
            kind: 'instance' as const,
            label: 'u',
            ports: [{ id: 'in', name: 'a', direction: 'input' as const }],
          },
        ],
        edges: [
          {
            id: 'a-u',
            source: 'a',
            sourcePort: 'out',
            target: 'u',
            targetPort: 'in',
            metadata: { declaredNetName: 'a_to_u' },
          },
        ],
      };
      const cutLayout = mergeFirstOpenNetCuts(
        { version: 1, modules: {} },
        'top',
        designModule.edges,
        designModule,
      );
      expect(cutLayout.modules.top.nodes).toEqual({});

      const view = await buildViewModel(
        {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: { top: designModule },
        },
        'top',
        cutLayout,
      );
      const byId = new Map(view.nodes.map((node) => [node.id, node]));
      const source = byId.get('a')!;
      const target = byId.get('u')!;
      const sourceLabel = byId.get('cut-label:a:out:source')!;
      const sinkLabel = byId.get('cut-label:a:out:sink:a-u')!;
      const sourceBounds = boundsOf(source);
      const targetBounds = boundsOf(target);
      const sourceLabelBounds = boundsOf(sourceLabel);
      const sinkLabelBounds = boundsOf(sinkLabel);

      // 'a' is the only node in the design apart from 'u', so 'u' alone forms
      // the "body" the disconnected input port is columnized against. Port
      // nodes snap to the half-grid row (y ≡ gridSize/2 mod gridSize).
      expect(sourceBounds.y % diagramSizing.gridSize).toBe(diagramSizing.gridSize / 2);
      expect(sourceBounds.x + sourceBounds.width).toBe(targetBounds.x - diagramSizing.columnGap);
      expect(sourceBounds.x + sourceBounds.width).toBeLessThan(sourceLabelBounds.x);
      expect(sourceLabelBounds.x + sourceLabelBounds.width).toBeLessThan(sinkLabelBounds.x);
      expect(sinkLabelBounds.x + sinkLabelBounds.width).toBeLessThan(targetBounds.x);
    },
  );

  it(
    'stacks multiple disconnected ports on the same side ' +
      'top-to-bottom and sorts input/output into opposite columns',
    async () => {
      const designModule = {
        name: 'top',
        file: 'top.sv',
        ports: [],
        nodes: [
          {
            id: 'clk',
            kind: 'port' as const,
            label: 'clk',
            ports: [{ id: 'clk', name: 'clk', direction: 'input' as const }],
          },
          {
            id: 'rst_n',
            kind: 'port' as const,
            label: 'rst_n',
            ports: [{ id: 'rst_n', name: 'rst_n', direction: 'input' as const }],
          },
          {
            id: 'y',
            kind: 'port' as const,
            label: 'y',
            ports: [{ id: 'y', name: 'y', direction: 'output' as const }],
          },
          {
            id: 'u',
            kind: 'instance' as const,
            label: 'u',
            ports: [
              { id: 'clk', name: 'clk', direction: 'input' as const },
              { id: 'rst_n', name: 'rst_n', direction: 'input' as const },
              { id: 'y', name: 'y', direction: 'output' as const },
            ],
          },
        ],
        edges: [
          {
            id: 'clk-u',
            source: 'clk',
            sourcePort: 'clk',
            target: 'u',
            targetPort: 'clk',
            metadata: { declaredNetName: 'clk' },
          },
          {
            id: 'rst-u',
            source: 'rst_n',
            sourcePort: 'rst_n',
            target: 'u',
            targetPort: 'rst_n',
            metadata: { declaredNetName: 'rst_n' },
          },
          {
            id: 'u-y',
            source: 'u',
            sourcePort: 'y',
            target: 'y',
            targetPort: 'y',
            metadata: { declaredNetName: 'y' },
          },
        ],
      };
      const cutLayout = mergeFirstOpenNetCuts(
        { version: 1, modules: {} },
        'top',
        designModule.edges,
        designModule,
      );

      const view = await buildViewModel(
        {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: { top: designModule },
        },
        'top',
        cutLayout,
      );
      const byId = new Map(view.nodes.map((node) => [node.id, node]));
      const clkBounds = boundsOf(byId.get('clk')!);
      const rstBounds = boundsOf(byId.get('rst_n')!);
      const yBounds = boundsOf(byId.get('y')!);
      const targetBounds = boundsOf(byId.get('u')!);

      // Both cut inputs land left of the body, stacked with no vertical overlap.
      expect(clkBounds.x + clkBounds.width).toBe(targetBounds.x - diagramSizing.columnGap);
      expect(rstBounds.x + rstBounds.width).toBe(targetBounds.x - diagramSizing.columnGap);
      expect(boxesOverlap(clkBounds, rstBounds)).toBe(false);

      // The cut output lands right of the body, on the opposite side from the inputs.
      expect(yBounds.x).toBe(targetBounds.x + targetBounds.width + diagramSizing.columnGap);
    },
  );

  it(
    'columnizes fully-cut ports even when nothing ' + 'else survives to anchor a body against',
    async () => {
      const designModule = {
        name: 'top',
        file: 'top.sv',
        ports: [],
        nodes: [
          {
            id: 'a',
            kind: 'port' as const,
            label: 'a',
            ports: [{ id: 'p', name: 'a', direction: 'input' as const }],
          },
          {
            id: 'x',
            kind: 'port' as const,
            label: 'x',
            ports: [{ id: 'p', name: 'x', direction: 'output' as const }],
          },
          {
            id: 'y',
            kind: 'port' as const,
            label: 'y',
            ports: [{ id: 'p', name: 'y', direction: 'output' as const }],
          },
        ],
        edges: [
          {
            id: 'a-x',
            source: 'a',
            sourcePort: 'p',
            target: 'x',
            targetPort: 'p',
            metadata: { declaredNetName: 'chip_select' },
          },
          {
            id: 'a-y',
            source: 'a',
            sourcePort: 'p',
            target: 'y',
            targetPort: 'p',
            metadata: { declaredNetName: 'chip_select' },
          },
        ],
      };
      const cutLayout = mergeFirstOpenNetCuts(
        { version: 1, modules: {} },
        'top',
        designModule.edges,
        designModule,
      );

      const view = await buildViewModel(
        {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: { top: designModule },
        },
        'top',
        cutLayout,
      );
      const byId = new Map(view.nodes.map((node) => [node.id, node]));
      const aBounds = boundsOf(byId.get('a')!);
      const xBounds = boundsOf(byId.get('x')!);
      const yBounds = boundsOf(byId.get('y')!);
      const sourceLabelBounds = boundsOf(byId.get('cut-label:a:p:source')!);
      const xLabelBounds = boundsOf(byId.get('cut-label:a:p:sink:a-x')!);

      // 'a' (the only source-direction port) is alone in the left column; 'x'
      // and 'y' stack in the right column, sorted top-to-bottom. There's no
      // surviving body here, so the columns sit right next to each other
      // rather than flanking body-sized empty space.
      expect(aBounds.x).toBeLessThan(xBounds.x);
      expect(aBounds.x).toBeLessThan(yBounds.x);
      expect(xBounds.x).toBe(yBounds.x);
      expect(xBounds.y).toBeLessThan(yBounds.y);
      expect(boxesOverlap(xBounds, yBounds)).toBe(false);
      expect(xBounds.x - (aBounds.x + aBounds.width)).toBe(
        diagramSizing.edgeLeadLength * 2 + sourceLabelBounds.width * 2 + diagramSizing.gridSize,
      );
      expect(sourceLabelBounds.x).toBe(aBounds.x + aBounds.width + diagramSizing.edgeLeadLength);
      expect(sourceLabelBounds.y + sourceLabelBounds.height / 2).toBe(
        aBounds.y + aBounds.height / 2,
      );
      expect(sourceLabelBounds.x + sourceLabelBounds.width + diagramSizing.gridSize).toBe(
        xLabelBounds.x,
      );
      expect(xLabelBounds.x + xLabelBounds.width + diagramSizing.edgeLeadLength).toBe(xBounds.x);
    },
  );

  it(
    'does not columnize once the layout has any saved ' +
      'node position (post-drag / after Auto Layout)',
    async () => {
      const designModule = {
        name: 'top',
        file: 'top.sv',
        ports: [],
        nodes: [
          {
            id: 'a',
            kind: 'port' as const,
            label: 'a',
            ports: [{ id: 'out', name: 'a', direction: 'input' as const }],
          },
          {
            id: 'other',
            kind: 'port' as const,
            label: 'other',
            ports: [{ id: 'out', name: 'other', direction: 'input' as const }],
          },
          {
            id: 'u',
            kind: 'instance' as const,
            label: 'u',
            ports: [{ id: 'in', name: 'a', direction: 'input' as const }],
          },
        ],
        edges: [
          {
            id: 'a-u',
            source: 'a',
            sourcePort: 'out',
            target: 'u',
            targetPort: 'in',
            metadata: { declaredNetName: 'a_to_u' },
          },
        ],
      };
      const cutLayout = mergeFirstOpenNetCuts(
        { version: 1, modules: {} },
        'top',
        designModule.edges,
        designModule,
      );
      // Simulate the module already having a customized layout (e.g. the user
      // dragged an unrelated node) — moduleLayout.nodes is no longer empty.
      const customizedLayout: SavedLayout = {
        version: 1,
        modules: {
          ...cutLayout.modules,
          top: {
            ...cutLayout.modules.top,
            nodes: { other: { x: 999, y: 999, fixed: true } },
          },
        },
      };

      const view = await buildViewModel(
        {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: { top: designModule },
        },
        'top',
        customizedLayout,
      );
      const byId = new Map(view.nodes.map((node) => [node.id, node]));
      const source = boundsOf(byId.get('a')!);
      const target = boundsOf(byId.get('u')!);

      expect(source.x + source.width).not.toBe(target.x - diagramSizing.columnGap);
    },
  );
});

function renderedPortCenterY(node: PositionedNode): number {
  return node.position.y + diagramSizing.portHeight / 2;
}

function renderedNodeInputCenterY(node: PositionedNode, row: number): number {
  return node.position.y + nodePortCenterOffset(row);
}

function renderedBusTapCenterY(node: PositionedNode, tapIndex: number): number {
  return node.position.y + diagramSizing.gridSize * (tapIndex * 2 + 1);
}

function renderedMuxSideInputCenterY(node: PositionedNode, index: number, count: number): number {
  const height = diagramNodeDimensions(node).height;
  const heightUnits = Math.max(1, Math.round(height / diagramSizing.gridSize));
  const startUnit = Math.max(1, Math.ceil((heightUnits - count + 1) / 2));
  return node.position.y + diagramSizing.gridSize * (startUnit + index);
}

function renderedAluInputCenterY(node: PositionedNode, index: number): number {
  return node.position.y + (index === 0 ? diagramSizing.gridSize : diagramSizing.gridSize * 3);
}

function routeCrossesNodeInterior(
  route: Array<{ x: number; y: number }>,
  node: PositionedNode,
): boolean {
  const dimensions = diagramNodeDimensions(node);
  const epsilon = 0.5;

  return route.slice(0, -1).some((point, index) => {
    const next = route[index + 1];
    if (point.y === next.y) {
      return (
        point.y > node.position.y + epsilon &&
        point.y < node.position.y + dimensions.height - epsilon &&
        Math.min(point.x, next.x) < node.position.x + dimensions.width - epsilon &&
        Math.max(point.x, next.x) > node.position.x + epsilon
      );
    }
    if (point.x === next.x) {
      return (
        point.x > node.position.x + epsilon &&
        point.x < node.position.x + dimensions.width - epsilon &&
        Math.min(point.y, next.y) < node.position.y + dimensions.height - epsilon &&
        Math.max(point.y, next.y) > node.position.y + epsilon
      );
    }
    return false;
  });
}

function boundsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function hasShortInitialStair(points: Array<{ x: number; y: number }>): boolean {
  if (points.length < 5) return false;
  const [source, first, second, third, fourth] = points;
  return (
    first.y === source.y &&
    second.x === first.x &&
    third.y === second.y &&
    fourth.x === third.x &&
    second.y !== source.y &&
    Math.abs(third.x - first.x) <= diagramSizing.gridSize * 2
  );
}

describe('layout merge', () => {
  it('uses node and port dimensions that align with the snap grid', () => {
    expect(diagramSizing.nodeWidth % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.muxWidth % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.muxWidth).toBe(diagramSizing.gridSize * 4);
    expect(diagramSizing.registerWidth % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.registerWidth).toBe(diagramSizing.gridSize * 4);
    expect(diagramSizing.nodeHeight % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.portWidth % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.portHeight % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.portSkinHeight % diagramSizing.gridSize).toBe(0);
    expect((diagramSizing.portNoseLength * 2) % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.muxRightSideHeight % (diagramSizing.gridSize * 2)).toBe(0);
    expect(diagramSizing.edgeLeadLength % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.minNodeSeparation % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.sameLayerNodeSeparation % diagramSizing.gridSize).toBe(0);
    expect(diagramSizing.sameLayerNodeSeparation).toBeLessThan(diagramSizing.minNodeSeparation);
    expect(diagramSizing.minNodeSeparation).toBeGreaterThanOrEqual(
      diagramSizing.edgeLeadLength * 2,
    );
    expect(nodeHeightForPortRows(1)).toBe(diagramSizing.nodeHeight);
    expect(nodeHeightForPortRows(3)).toBe(diagramSizing.gridSize * 5);
    expect(muxHeightForPortRows(3)).toBe(diagramSizing.gridSize * 6);
    expect((muxHeightForPortRows(3) / 2) % diagramSizing.gridSize).toBe(0);
    expect(nodeHeightForPortRows(5) % diagramSizing.gridSize).toBe(0);
    expect(ioPortCenterOffset()).toBe(diagramSizing.gridSize / 2);
    expect(nodePortCenterOffset(0) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(1) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(2) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(1) - nodePortCenterOffset(0)).toBe(diagramSizing.gridSize);
  });

  // The ELK placement pass must lay neighbors out against each node's
  // *rendered* box, not its canonical size — a saved manual resize or the
  // transient expanded-frame footprint of an "Expand instance in place"
  // Auto Layout (BuildViewModelOptions.elkSizeOverrides) both grow the node.
  describe('auto-layout node size awareness', () => {
    const overrideGridSize = { width: 40, height: 20 };
    const overridePx = {
      width: overrideGridSize.width * diagramSizing.gridSize,
      height: overrideGridSize.height * diagramSizing.gridSize,
    };

    function expandedBox(node: PositionedNode): {
      x: number;
      y: number;
      width: number;
      height: number;
    } {
      return { x: node.position.x, y: node.position.y, ...overridePx };
    }

    it('places released nodes clear of a transient elkSizeOverride footprint', async () => {
      const view = await buildViewModel(
        fanoutGraph,
        'top',
        { version: 1, modules: {} },
        { elkSizeOverrides: { u1: overrideGridSize } },
      );

      const u1 = view.nodes.find((node) => node.id === 'u1')!;
      const u2 = view.nodes.find((node) => node.id === 'u2')!;
      expect(boxesOverlap(expandedBox(u1), boundsOf(u2))).toBe(false);
      // Transient means transient: the override never echoes back on the
      // view's own nodes (it would otherwise leak into the webview's splice
      // bookkeeping as a persisted manual resize).
      expect(u1.sizeOverride).toBeUndefined();
    });

    it('places released nodes clear of a saved manual resize', async () => {
      const layout: SavedLayout = {
        version: 1,
        modules: {
          top: {
            nodes: {
              u1: { x: 0, y: 0, ...overrideGridSize },
            },
          },
        },
      };

      const view = await buildViewModel(fanoutGraph, 'top', layout);

      const u1 = view.nodes.find((node) => node.id === 'u1')!;
      const u2 = view.nodes.find((node) => node.id === 'u2')!;
      expect(boxesOverlap(expandedBox(u1), boundsOf(u2))).toBe(false);
      // A saved resize (unlike the transient override) is the node's real
      // rendered size, and does flow onto the view.
      expect(u1.sizeOverride).toEqual(overrideGridSize);
    });

    // Regression for the "Expand instance in place" (#232/#233) bug where a
    // wire unrelated to the expanded instance cuts straight through the
    // expanded frame: the router only ever saw the collapsed instance's
    // saved size as an obstacle, because the frame's real (much bigger) size
    // lives only in the webview and was never threaded into the routing
    // pass the way it already was for ELK's *placement* pass above. Uses a
    // feedback (cyclic) edge, like the "ordinary feedback edges" test below,
    // so the assertion exercises ELK's own obstacle-aware route derivation
    // deterministically regardless of whether the libavoid-js native module
    // is available in the current test environment.
    it(
      'routes a feedback edge clear of an elkSizeOverride footprint, ' +
        'not just the collapsed size',
      async () => {
        const feedbackGraph: DesignGraph = {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: {
            top: {
              name: 'top',
              file: 'top.sv',
              ports: [],
              nodes: [
                {
                  id: 'latch',
                  kind: 'latch',
                  label: 'next_r',
                  ports: [
                    { id: 'q', name: 'Q', direction: 'output' },
                    { id: 'd', name: 'D', direction: 'input' },
                  ],
                },
                {
                  id: 'mux',
                  kind: 'mux',
                  label: 'if en',
                  ports: [
                    { id: 'sel', name: 'sel', direction: 'input' },
                    { id: 'true', name: 'true', direction: 'input' },
                    { id: 'out', name: 'out', direction: 'output' },
                  ],
                },
              ],
              edges: [
                {
                  id: 'feedback',
                  source: 'latch',
                  sourcePort: 'q',
                  target: 'mux',
                  targetPort: 'true',
                },
                {
                  id: 'mux-latch',
                  source: 'mux',
                  sourcePort: 'out',
                  target: 'latch',
                  targetPort: 'd',
                },
              ],
            },
          },
        };

        const emptyLayout: SavedLayout = { version: 1, modules: {} };
        const baseline = await buildViewModel(feedbackGraph, 'top', emptyLayout);
        const baselineRoute = baseline.edges.find((edge) => edge.id === 'feedback')?.routePoints;
        expect(baselineRoute).toBeDefined();
        const baselineMaxY = Math.max(...baselineRoute!.map((point) => point.y));

        const muxOverride = { width: 20, height: 40 };
        const overridden = await buildViewModel(feedbackGraph, 'top', emptyLayout, {
          elkSizeOverrides: { mux: muxOverride },
        });
        const mux = overridden.nodes.find((node) => node.id === 'mux')!;
        const overriddenBottom = mux.position.y + diagramNodeDimensions(mux).height;
        const overriddenRoute = overridden.edges.find(
          (edge) => edge.id === 'feedback',
        )?.routePoints;
        expect(overriddenRoute).toBeDefined();
        const overriddenMaxY = Math.max(...overriddenRoute!.map((point) => point.y));

        // The wrap must clear the *expanded* frame's real bottom edge...
        expect(overriddenMaxY).toBeGreaterThanOrEqual(overriddenBottom);
        // ...which is a strictly deeper detour than routing around the
        // collapsed instance's saved size would have produced.
        expect(overriddenMaxY).toBeGreaterThan(baselineMaxY);
      },
    );
  });

  it('preserves saved node positions on the snap grid', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            a: { x: 10, y: 20, fixed: true },
          },
        },
      },
    };

    const view = await buildViewModel(graph, 'top', layout);

    expect(view.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 0, y: 12 });
    expect(view.nodes.find((node) => node.id === 'u')?.position).toBeDefined();
  });

  it('snaps initial auto-layout positions before the webview sees them', async () => {
    const view = await buildViewModel(graph, 'top', { version: 1, modules: {} });

    for (const node of view.nodes) {
      expect(node.position.x % diagramSizing.gridSize).toBe(0);
      if (node.kind === 'port' || node.kind === 'literal') {
        expect(node.position.y % diagramSizing.gridSize).toBe(diagramSizing.gridSize / 2);
      } else {
        expect(node.position.y % diagramSizing.gridSize).toBe(0);
      }
    }
  });

  it('preserves a full grid gap between literals after snapping', () => {
    const literals: DiagramNode[] = [
      { id: 'start', kind: 'literal', label: 'START', ports: [] },
      { id: 'busy', kind: 'literal', label: 'BUSY', ports: [] },
    ];
    const positions = new Map([
      ['start', { x: 504, y: 36 }],
      ['busy', { x: 504, y: 60 }],
    ]);

    enforceMinimumBlockGaps(literals, positions, { nodes: {} });
    const ordered = literals
      .map((node) => ({ ...node, position: positions.get(node.id)! }))
      .sort((a, b) => a.position.y - b.position.y);

    expect(
      ordered[1].position.y - (ordered[0].position.y + diagramNodeDimensions(ordered[0]).height),
    ).toBeGreaterThanOrEqual(diagramSizing.gridSize);
  });

  it('preserves a full grid gap below a register reset lead after snapping', () => {
    const register: DiagramNode = {
      id: 'register',
      kind: 'register',
      label: 'state',
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'clk', name: 'clk', direction: 'input' },
        { id: 'rst_n', name: 'rst_n', direction: 'input' },
        { id: 'rv', name: 'RV', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' },
      ],
      metadata: { clockSignal: 'clk', resetSignal: 'rst_n' },
    };
    const done: DiagramNode = { id: 'done', kind: 'literal', label: 'DONE', ports: [] };
    const positions = new Map([
      [register.id, { x: 480, y: 144 }],
      [done.id, { x: 504, y: 300 }],
    ]);

    const registerGeometry = elkNodeForDiagramNode(register, true);
    const doneGeometry = elkNodeForDiagramNode(done, true);
    const originalRegisterBottom =
      positions.get(register.id)!.y - registerGeometry.layoutOffset.y + registerGeometry.height;
    const originalDoneTop = positions.get(done.id)!.y - doneGeometry.layoutOffset.y;
    expect(originalRegisterBottom).toBeGreaterThan(originalDoneTop);

    enforceMinimumBlockGaps([register, done], positions, { nodes: {} });
    const registerBottom =
      positions.get(register.id)!.y - registerGeometry.layoutOffset.y + registerGeometry.height;
    const doneTop = positions.get(done.id)!.y - doneGeometry.layoutOffset.y;

    expect(doneTop - registerBottom).toBeGreaterThanOrEqual(diagramSizing.gridSize);
  });

  it('anchors a resized register reset port at the resolved bottom center', () => {
    const register: DiagramNode = {
      id: 'register',
      kind: 'register',
      label: 'state',
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'clk', name: 'clk', direction: 'input' },
        { id: 'rst_n', name: 'rst_n', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' },
      ],
      metadata: { clockSignal: 'clk', resetSignal: 'rst_n' },
      sizeOverride: { width: 12, height: 8 },
    };

    const resolved = resolvedNodeDimensions(register);
    const geometry = elkNodeForDiagramNode(register);
    const resetPort = geometry.ports.find((port) => port.id === 'register:rst_n');

    expect(geometry.width).toBe(resolved.width);
    expect(geometry.height).toBe(resolved.height);
    expect(resetPort).toMatchObject({ x: resolved.width / 2, y: resolved.height });
    expect(resetPort?.layoutOptions['elk.port.side']).toBe('SOUTH');
  });

  it('stacks unmatched compound event-control ports at distinct rows', () => {
    // A register whose compound `always_ff` sensitivity list has no clock/reset name
    // match has no clock/reset port at all -- every event-control signal (a, b, c)
    // must still get its own row so wires don't overlap at the same anchor point.
    const register: DiagramNode = {
      id: 'register',
      kind: 'register',
      label: 'q',
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'a', name: 'a', direction: 'input' },
        { id: 'b', name: 'b', direction: 'input' },
        { id: 'c', name: 'c', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' },
      ],
    };
    const geometry = elkNodeForDiagramNode(register);
    const aPort = geometry.ports.find((port) => port.id === 'register:a');
    const bPort = geometry.ports.find((port) => port.id === 'register:b');
    const cPort = geometry.ports.find((port) => port.id === 'register:c');

    const positions = [aPort?.y, bPort?.y, cPort?.y];
    expect(positions.every((y) => y !== undefined)).toBe(true);
    expect(new Set(positions).size).toBe(3);
  });

  it('adds obstacle margins to route-only ELK geometry without moving port anchors', () => {
    const register: DiagramNode = {
      id: 'register',
      kind: 'register',
      label: 'M',
      isArrayNode: true,
      ports: [
        { id: 'd', name: 'D', direction: 'input' },
        { id: 'clk', name: 'clk', direction: 'input' },
        { id: 'q', name: 'Q', direction: 'output' },
      ],
      metadata: { clockSignal: 'clk' },
    };
    const placement = elkNodeForDiagramNode(register, true);
    const routing = elkRoutingNodeForDiagramNode(register);

    expect(routing.width).toBe(placement.width);
    expect(routing.height).toBe(placement.height + diagramSizing.gridSize);
    expect(routing.layoutOffset).toEqual({
      x: placement.layoutOffset.x,
      y: placement.layoutOffset.y + diagramSizing.gridSize / 2,
    });

    for (const placementPort of placement.ports) {
      const routingPort = routing.ports.find((port) => port.id === placementPort.id)!;
      expect({
        x: routingPort.x! - routing.layoutOffset.x,
        y: routingPort.y! - routing.layoutOffset.y,
      }).toEqual({
        x: placementPort.x! - placement.layoutOffset.x,
        y: placementPort.y! - placement.layoutOffset.y,
      });
    }
  });

  it('centers cut-label ELK leads on the rendered wire', () => {
    const cutEnds: DiagramNode[] = [
      {
        id: 'cut-label:clk:source',
        kind: 'netLabel',
        label: 'clk',
        ports: [{ id: 'cut', name: 'cut', direction: 'input' }],
        metadata: { cutNet: { netKey: 'clk', role: 'source', align: 'end', handleSide: 'left' } },
      },
      {
        id: 'cut-label:clk:sink',
        kind: 'netLabel',
        label: 'clk',
        ports: [{ id: 'cut', name: 'cut', direction: 'output' }],
        metadata: { cutNet: { netKey: 'clk', role: 'sink', align: 'start', handleSide: 'right' } },
      },
    ];

    for (const cutEnd of cutEnds) {
      const geometry = elkNodeForDiagramNode(cutEnd, true);
      expect(geometry.ports[0].y! - geometry.layoutOffset.y).toBe(
        diagramNodeDimensions(cutEnd).height / 2,
      );
    }
  });

  it('marks removed fixed layout entries stale and writes active fixed positions', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            old: { x: 1, y: 2, fixed: true },
            a: { x: 3, y: 4, fixed: true },
            auto: { x: 5, y: 6 }, // not fixed
          },
        },
      },
    };
    const nodes: PositionedNode[] = [
      { id: 'a', kind: 'port', label: 'a', ports: [], position: { x: 20.2, y: 31.8 }, fixed: true },
      { id: 'b', kind: 'port', label: 'b', ports: [], position: { x: 100, y: 100 } }, // not fixed
    ];

    const merged = mergeNodePositions(layout, 'top', nodes);

    expect(merged.modules.top.nodes.old.stale).toBe(true);
    expect(merged.modules.top.nodes.old.fixed).toBe(true);
    expect(merged.modules.top.nodes.a).toEqual({ x: 24, y: 36, fixed: true });
    expect(merged.modules.top.nodes.auto).toBeUndefined(); // auto was not fixed
    expect(merged.modules.top.nodes.b).toBeUndefined(); // b was not fixed
  });

  it('persists a node size override as grid units alongside its fixed position', () => {
    const nodes: PositionedNode[] = [
      {
        id: 'u',
        kind: 'instance',
        label: 'u',
        ports: [],
        position: { x: 120, y: 96 },
        fixed: true,
        sizeOverride: { width: 12, height: 8 },
      },
    ];

    const merged = mergeNodePositions({ version: 1, modules: {} }, 'top', nodes);

    expect(merged.modules.top.nodes.u).toEqual({
      x: 120,
      y: 96,
      fixed: true,
      width: 12,
      height: 8,
    });
  });

  it('drops a previously saved size override once the node reports none (revert)', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            u: { x: 120, y: 96, fixed: true, width: 12, height: 8 },
          },
        },
      },
    };
    const nodes: PositionedNode[] = [
      {
        id: 'u',
        kind: 'instance',
        label: 'u',
        ports: [],
        position: { x: 120, y: 96 },
        fixed: true,
      },
    ];

    const merged = mergeNodePositions(layout, 'top', nodes);

    expect(merged.modules.top.nodes.u).toEqual({ x: 120, y: 96, fixed: true });
  });

  it('revertNodeSize clears only the size override, keeping position and fixed', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            u: { x: 100, y: 100, fixed: true, width: 12, height: 8 },
          },
        },
      },
    };

    const reverted = revertNodeSize(layout, 'top', 'u');

    expect(reverted.modules.top.nodes.u).toEqual({ x: 100, y: 100, fixed: true });
  });

  it('revertNodeSize is a no-op when the node has no saved override', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: { top: { nodes: { u: { x: 100, y: 100, fixed: true } } } },
    };

    expect(revertNodeSize(layout, 'top', 'u')).toEqual(layout);
    expect(revertNodeSize(layout, 'top', 'missing')).toEqual(layout);
    expect(revertNodeSize(layout, 'missing-module', 'u')).toEqual(layout);
  });

  it('revertNodeSizes clears every selected override and leaves other nodes alone', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            u1: { x: 100, y: 100, fixed: true, width: 12, height: 8 },
            u2: { x: 300, y: 100, fixed: true, width: 10, height: 6 },
            u3: { x: 500, y: 100, fixed: true, width: 9, height: 5 },
          },
        },
      },
    };

    const reverted = revertNodeSizes(layout, 'top', ['u1', 'u2']);

    expect(reverted.modules.top.nodes).toEqual({
      u1: { x: 100, y: 100, fixed: true },
      u2: { x: 300, y: 100, fixed: true },
      u3: { x: 500, y: 100, fixed: true, width: 9, height: 5 },
    });
  });

  // eslint-disable-next-line max-len
  it('grows a resized instance past its saved size at view-model build time, floored by canonical size', async () => {
    const canonical = diagramNodeDimensions({ id: 'u', kind: 'instance', label: 'u', ports: [] });
    const grid = diagramSizing.gridSize;
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            u: {
              x: 0,
              y: 0,
              fixed: true,
              width: canonical.width / grid + 3,
              height: canonical.height / grid + 2,
            },
          },
        },
      },
    };

    const view = await buildViewModel(graph, 'top', layout);
    const node = view.nodes.find((candidate) => candidate.id === 'u');

    expect(node?.sizeOverride).toEqual({
      width: canonical.width / grid + 3,
      height: canonical.height / grid + 2,
    });
    const resolved = node && resolvedNodeDimensions(node);
    expect(resolved?.width).toBe(canonical.width + grid * 3);
    expect(resolved?.height).toBe(canonical.height + grid * 2);
  });

  it('persists edge waypoints and applies them to the view model', async () => {
    const layout = mergeEdgeWaypoint({ version: 1, modules: {} }, 'top', 'e-a-u', {
      x: 42.4,
      y: 92.6,
    });
    const view = await buildViewModel(graph, 'top', layout);

    expect(layout.modules.top.edges?.['e-a-u'].waypoint).toEqual({ x: 42, y: 93 });
    expect(view.edges.find((edge) => edge.id === 'e-a-u')?.waypoint).toEqual({ x: 42, y: 93 });
  });

  it('persists edge route points and applies them to the view model', async () => {
    const layout = mergeEdgeRoutePoints({ version: 1, modules: {} }, 'top', 'e-a-u', [
      { x: 10.2, y: 20.8 },
      { x: 30.1, y: 40.5 },
    ]);
    const view = await buildViewModel(graph, 'top', layout);

    expect(layout.modules.top.edges?.['e-a-u'].routePoints).toEqual([
      { x: 10, y: 21 },
      { x: 30, y: 41 },
    ]);
    expect(view.edges.find((edge) => edge.id === 'e-a-u')?.routePoints).toEqual([
      { x: 10, y: 21 },
      { x: 30, y: 41 },
    ]);
  });

  it('preserves moved node positions when route points are persisted afterward', async () => {
    const moved = mergeNodePositions({ version: 1, modules: {} }, 'top', [
      { id: 'a', kind: 'port', label: 'a', ports: [], position: { x: 120, y: 132 }, fixed: true },
      {
        id: 'u',
        kind: 'instance',
        label: 'u',
        ports: [],
        position: { x: 360, y: 240 },
        fixed: true,
      },
    ]);
    const routed = mergeEdgeRoutePoints(moved, 'top', 'e-a-u', [
      { x: 168, y: 144 },
      { x: 264, y: 144 },
    ]);
    const view = await buildViewModel(graph, 'top', routed);

    expect(routed.modules.top.nodes).toEqual({
      a: { x: 120, y: 132, fixed: true },
      u: { x: 360, y: 240, fixed: true },
    });
    expect(view.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 120, y: 132 });
    expect(view.nodes.find((node) => node.id === 'u')?.position).toEqual({ x: 360, y: 240 });
    expect(view.edges.find((edge) => edge.id === 'e-a-u')?.routePoints).toEqual([
      { x: 168, y: 144 },
      { x: 264, y: 144 },
    ]);
  });

  it('computes generate region bounds around owned nodes with one-grid inset', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            u: { x: 240, y: 120, fixed: true },
          },
        },
      },
    };
    const graphWithRegion: DesignGraph = {
      ...graph,
      modules: {
        top: {
          ...graph.modules.top,
          nodes: [{ id: 'u', kind: 'instance', label: 'u', ports: [] }],
          edges: [],
          generateRegions: [
            {
              id: 'r0',
              kind: 'case',
              label: 'MODE == 0 (g_case_0)',
              condition: 'MODE == 0',
              blockLabel: 'g_case_0',
              siblingGroupId: 'case:1',
              nodeIds: ['u'],
            },
          ],
        },
      },
    };

    const view = await buildViewModel(graphWithRegion, 'top', layout);
    const node = view.nodes.find((candidate) => candidate.id === 'u')!;
    const region = view.generateRegions?.[0]!;
    const size = diagramNodeDimensions(node);

    expect(region.blockLabel).toBe('g_case_0');
    expect(region.bounds.x).toBeLessThanOrEqual(node.position.x - diagramSizing.gridSize);
    expect(region.bounds.y).toBeLessThanOrEqual(node.position.y - diagramSizing.gridSize);
    expect(region.bounds.x + region.bounds.width).toBeGreaterThanOrEqual(
      node.position.x + size.width + diagramSizing.gridSize,
    );
    expect(region.bounds.y + region.bounds.height).toBeGreaterThanOrEqual(
      node.position.y + size.height + diagramSizing.gridSize,
    );
  });

  it('keeps saved generate region bounds from shrinking automatically', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            u: { x: 240, y: 120, fixed: true },
          },
          regions: {
            r0: { x: 96, y: 48, width: 480, height: 360, fixed: true },
          },
        },
      },
    };
    const graphWithRegion: DesignGraph = {
      ...graph,
      modules: {
        top: {
          ...graph.modules.top,
          nodes: [{ id: 'u', kind: 'instance', label: 'u', ports: [] }],
          edges: [],
          generateRegions: [
            {
              id: 'r0',
              kind: 'if',
              label: 'if (ENABLE)',
              condition: 'ENABLE',
              siblingGroupId: 'if:1',
              nodeIds: ['u'],
            },
          ],
        },
      },
    };

    const view = await buildViewModel(graphWithRegion, 'top', layout);

    expect(view.generateRegions?.[0].bounds).toEqual({ x: 96, y: 48, width: 480, height: 360 });
    expect(view.generateRegions?.[0].fixed).toBe(true);
  });

  it('persists fixed generate region bounds and marks removed fixed regions stale', () => {
    const merged = mergeRegionBounds(
      {
        version: 1,
        modules: {
          top: {
            nodes: {},
            regions: {
              old: { x: 1, y: 2, width: 3, height: 4, fixed: true },
            },
          },
        },
      },
      'top',
      [
        {
          id: 'r0',
          kind: 'case',
          label: 'MODE == 0',
          bounds: { x: 24.4, y: 48.5, width: 191.8, height: 96.2 },
          nodeIds: [],
          fixed: true,
        },
      ],
    );

    expect(merged.modules.top.regions?.old).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      fixed: true,
      stale: true,
    });
    expect(merged.modules.top.regions?.r0).toEqual({
      x: 24,
      y: 49,
      width: 192,
      height: 96,
      fixed: true,
    });
  });

  it('places nested empty generate regions inside their parent placeholder', async () => {
    const graphWithRegions: DesignGraph = {
      ...graph,
      modules: {
        top: {
          ...graph.modules.top,
          nodes: [],
          edges: [],
          generateRegions: [
            {
              id: 'outer',
              kind: 'if',
              label: 'if (ENABLE) (g_if_on)',
              condition: 'ENABLE',
              blockLabel: 'g_if_on',
              siblingGroupId: 'if:1',
              nodeIds: [],
            },
            {
              id: 'inner',
              kind: 'case',
              label: 'MODE == 0 (g_case_0)',
              condition: 'MODE == 0',
              blockLabel: 'g_case_0',
              parentRegionId: 'outer',
              siblingGroupId: 'case:1',
              nodeIds: [],
            },
          ],
        },
      },
    };

    const view = await buildViewModel(graphWithRegions, 'top', { version: 1, modules: {} });
    const outer = view.generateRegions?.find((region) => region.id === 'outer')!;
    const inner = view.generateRegions?.find((region) => region.id === 'inner')!;

    expect(inner.bounds.x).toBeGreaterThan(outer.bounds.x);
    expect(inner.bounds.y).toBeGreaterThan(outer.bounds.y);
    expect(inner.bounds.x + inner.bounds.width).toBeLessThanOrEqual(
      outer.bounds.x + outer.bounds.width,
    );
    expect(inner.bounds.y + inner.bounds.height).toBeLessThanOrEqual(
      outer.bounds.y + outer.bounds.height,
    );
  });

  it(
    'uses ELK compound regions to keep generate ' + 'arm siblings separated during auto-layout',
    async () => {
      const graphWithCaseRegions: DesignGraph = {
        ...graph,
        modules: {
          top: {
            ...graph.modules.top,
            nodes: [
              {
                id: 'a',
                kind: 'port',
                label: 'a',
                ports: [{ id: 'p', name: 'a', direction: 'input' }],
              },
              {
                id: 'b',
                kind: 'port',
                label: 'b',
                ports: [{ id: 'p', name: 'b', direction: 'input' }],
              },
              {
                id: 'c',
                kind: 'port',
                label: 'c',
                ports: [{ id: 'p', name: 'c', direction: 'input' }],
              },
              {
                id: 'u0',
                kind: 'instance',
                label: 'u0',
                ports: [
                  { id: 'a', name: 'a', direction: 'input' },
                  { id: 'y', name: 'y', direction: 'output' },
                ],
              },
              {
                id: 'u1',
                kind: 'instance',
                label: 'u1',
                ports: [
                  { id: 'a', name: 'a', direction: 'input' },
                  { id: 'y', name: 'y', direction: 'output' },
                ],
              },
              {
                id: 'ud',
                kind: 'instance',
                label: 'ud',
                ports: [
                  { id: 'a', name: 'a', direction: 'input' },
                  { id: 'y', name: 'y', direction: 'output' },
                ],
              },
              {
                id: 'y',
                kind: 'port',
                label: 'y',
                ports: [{ id: 'p', name: 'y', direction: 'output' }],
              },
            ],
            edges: [
              {
                id: 'e-a-u0',
                source: 'a',
                sourcePort: 'p',
                target: 'u0',
                targetPort: 'a',
                signal: 'w0',
              },
              {
                id: 'e-u0-y',
                source: 'u0',
                sourcePort: 'y',
                target: 'y',
                targetPort: 'p',
                signal: 'w',
              },
              {
                id: 'e-b-u1',
                source: 'b',
                sourcePort: 'p',
                target: 'u1',
                targetPort: 'a',
                signal: 'w1',
              },
              {
                id: 'e-u1-y',
                source: 'u1',
                sourcePort: 'y',
                target: 'y',
                targetPort: 'p',
                signal: 'w',
              },
              {
                id: 'e-c-ud',
                source: 'c',
                sourcePort: 'p',
                target: 'ud',
                targetPort: 'a',
                signal: 'wd',
              },
              {
                id: 'e-ud-y',
                source: 'ud',
                sourcePort: 'y',
                target: 'y',
                targetPort: 'p',
                signal: 'w',
              },
            ],
            generateRegions: [
              {
                id: 'r0',
                kind: 'case',
                label: 'g_case_0 /* MODE == 0 */',
                blockLabel: 'g_case_0',
                caseValue: 'MODE == 0',
                siblingGroupId: 'case:1',
                armIndex: 0,
                nodeIds: ['u0'],
              },
              {
                id: 'r1',
                kind: 'case',
                label: 'g_case_1 /* MODE == 1 */',
                blockLabel: 'g_case_1',
                caseValue: 'MODE == 1',
                siblingGroupId: 'case:1',
                armIndex: 1,
                nodeIds: ['u1'],
              },
              {
                id: 'rd',
                kind: 'case-default',
                label: 'g_case_default /* default */',
                blockLabel: 'g_case_default',
                caseValue: 'default',
                siblingGroupId: 'case:1',
                armIndex: 2,
                nodeIds: ['ud'],
              },
            ],
          },
        },
      };

      const view = await buildViewModel(graphWithCaseRegions, 'top', { version: 1, modules: {} });
      const regions = [...view.generateRegions!].sort(
        (a, b) => (a.armIndex ?? 0) - (b.armIndex ?? 0),
      );

      expect(regions.map((region) => region.blockLabel)).toEqual([
        'g_case_0',
        'g_case_1',
        'g_case_default',
      ]);
      expect(regions[0].bounds.y).toBeLessThan(regions[1].bounds.y);
      expect(regions[1].bounds.y).toBeLessThan(regions[2].bounds.y);
      for (let i = 0; i < regions.length; i++) {
        for (let j = i + 1; j < regions.length; j++) {
          expect(boundsOverlap(regions[i].bounds, regions[j].bounds)).toBe(false);
        }
      }

      for (const region of regions) {
        const node = view.nodes.find((candidate) => candidate.id === region.nodeIds[0])!;
        const size = diagramNodeDimensions(node);
        const padding = {
          left: node.position.x - region.bounds.x,
          top: node.position.y - region.bounds.y,
          right: region.bounds.x + region.bounds.width - node.position.x - size.width,
          bottom: region.bounds.y + region.bounds.height - node.position.y - size.height,
        };
        expect(padding.left).toBeGreaterThanOrEqual(diagramSizing.gridSize);
        expect(padding.right).toBe(padding.left);
        expect(padding.top).toBe(padding.left);
        expect(padding.bottom).toBe(padding.left);
      }

      const defaultArmRoute = view.edges.find((edge) => edge.id === 'e-ud-y')?.routePoints ?? [];
      expect(hasShortInitialStair(defaultArmRoute)).toBe(false);
    },
  );

  it('freezes active nodes and clears manual edge routes for rerouting', () => {
    const layout = mergeEdgeRoutePoints(
      {
        version: 1,
        modules: {
          top: {
            nodes: {
              old: { x: 1, y: 2, fixed: true },
            },
            viewport: { x: 4, y: 5, zoom: 1.25 },
          },
        },
      },
      'top',
      'e-a-u',
      [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
    );

    const rerouted = mergeRerouteLayout(layout, 'top', [
      { id: 'a', kind: 'port', label: 'a', ports: [], position: { x: 120, y: 132 } },
      { id: 'u', kind: 'instance', label: 'u', ports: [], position: { x: 360, y: 240 } },
    ]);

    expect(rerouted.modules.top.nodes).toEqual({
      a: { x: 120, y: 132, fixed: true },
      u: { x: 360, y: 240, fixed: true },
      old: { x: 1, y: 2, fixed: true, stale: true },
    });
    expect(rerouted.modules.top.edges).toBeUndefined();
    expect(rerouted.modules.top.viewport).toEqual({ x: 4, y: 5, zoom: 1.25 });
  });

  it(
    'clears manual routes for exactly the given ' + 'edges when batch-rerouting a wire selection',
    () => {
      const withFirstRoute = mergeEdgeRoutePoints(
        {
          version: 1,
          modules: { top: { nodes: {} } },
        },
        'top',
        'e-clk-u1',
        [{ x: 10, y: 20 }],
      );
      const layout = mergeEdgeRoutePoints(withFirstRoute, 'top', 'e-clk-u2', [{ x: 30, y: 40 }]);

      const positioned: PositionedNode[] = [
        { ...fanoutGraph.modules.top.nodes[0], position: { x: 0, y: 12 } },
        { ...fanoutGraph.modules.top.nodes[1], position: { x: 240, y: 0 } },
        { ...fanoutGraph.modules.top.nodes[2], position: { x: 240, y: 96 } },
      ];

      const rerouted = mergeRerouteEdges(layout, 'top', ['e-clk-u1'], positioned);

      expect(rerouted.modules.top.edges?.['e-clk-u1']).toBeUndefined();
      expect(rerouted.modules.top.edges?.['e-clk-u2']).toEqual({ routePoints: [{ x: 30, y: 40 }] });
      expect(rerouted.modules.top.nodes).toEqual({
        clk: { x: 0, y: 12, fixed: true },
        u1: { x: 240, y: 0, fixed: true },
        u2: { x: 240, y: 96, fixed: true },
      });
    },
  );

  it('cuts every edge in a multi-wire selection in one batch', () => {
    const module = twoNetGraph.modules.top;
    // All four nodes are port-kind, which snaps to the half-grid row (y ≡ 12 mod 24).
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 0, y: 60 } },
      { ...module.nodes[2], position: { x: 240, y: 12 } },
      { ...module.nodes[3], position: { x: 240, y: 60 } },
    ];

    const cut = mergeNetCuts({ version: 1, modules: {} }, 'top', module.edges, module, positioned);

    expect(Object.keys(cut.modules.top.netCuts ?? {}).sort()).toEqual(['a:p', 'b:p']);
    expect(cut.modules.top.nodes.a).toEqual({ x: 0, y: 12, fixed: true });
    expect(cut.modules.top.nodes.b).toEqual({ x: 0, y: 60, fixed: true });

    // Cutting the same batch again is a no-op — mergeNetCut's per-net guard
    // still applies within the batch.
    const duplicateCut = mergeNetCuts(cut, 'top', module.edges, module, positioned);
    expect(duplicateCut.modules.top.netCuts).toEqual(cut.modules.top.netCuts);
  });

  it('releases only the selected nodes back to auto-layout, freezing everything else', () => {
    const module = fanoutGraph.modules.top;
    const seeded: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            clk: { x: 0, y: 12, fixed: true },
            u1: { x: 240, y: 0, fixed: true },
            u2: { x: 240, y: 96, fixed: true },
          },
          edges: {
            'e-clk-u1': { routePoints: [{ x: 10, y: 10 }] },
            'e-clk-u2': { routePoints: [{ x: 20, y: 20 }] },
          },
        },
      },
    };

    // The user dragged u1 to a new spot before clicking "Auto Layout" — its
    // current on-screen position becomes ELK's placement hint once released.
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 288, y: 0 } },
      { ...module.nodes[2], position: { x: 240, y: 96 } },
    ];

    const relayouted = mergeRelayoutSelection(seeded, 'top', ['u1'], positioned, module);

    // u1 is released: its position is kept only as a placement hint (not fixed).
    expect(relayouted.modules.top.nodes.u1).toEqual({ x: 288, y: 0, fixed: false });
    // clk and u2 were not part of the selection — they stay exactly where they
    // were and remain fixed, same as "Reroute All" freezes the whole diagram.
    expect(relayouted.modules.top.nodes.clk).toEqual({ x: 0, y: 12, fixed: true });
    expect(relayouted.modules.top.nodes.u2).toEqual({ x: 240, y: 96, fixed: true });
    // Only the edge touching the released node is cleared for re-routing.
    expect(relayouted.modules.top.edges?.['e-clk-u1']).toBeUndefined();
    expect(relayouted.modules.top.edges?.['e-clk-u2']).toEqual({ routePoints: [{ x: 20, y: 20 }] });
  });

  it("preserves a resized node's size override when releasing it back to auto-layout", () => {
    const module = fanoutGraph.modules.top;
    const seeded: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            clk: { x: 0, y: 12, fixed: true },
            u1: { x: 240, y: 0, width: 96, height: 64, fixed: true },
            u2: { x: 240, y: 96, fixed: true },
          },
        },
      },
    };

    // u1 was manually resized before the user clicked "Auto Layout" for it.
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 288, y: 0 }, sizeOverride: { width: 96, height: 64 } },
      { ...module.nodes[2], position: { x: 240, y: 96 } },
    ];

    const relayouted = mergeRelayoutSelection(seeded, 'top', ['u1'], positioned, module);

    // u1 is released back to auto-layout, but its resize override survives.
    expect(relayouted.modules.top.nodes.u1).toEqual({
      x: 288,
      y: 0,
      fixed: false,
      width: 96,
      height: 64,
    });
  });

  it('uses shared net keys for ordinary, literal, and cut stub edges', () => {
    expect(edgeNetKey({ id: 'e', source: 'n1', sourcePort: 'out', target: 'n2' } as any)).toBe(
      'n1:out',
    );
    expect(
      edgeNetKey({ id: 'lit', source: 'literal:1', sourcePort: 'out', target: 'n2' } as any),
    ).toBe('literal:1');
    expect(
      edgeNetKey({
        id: 'stub',
        source: 'cut-label:n1:out:sink:e',
        sourcePort: 'cut',
        target: 'n2',
        metadata: { cutStub: { netKey: 'n1:out', role: 'sink', originalEdgeId: 'e' } },
      }),
    ).toBe('n1:out');
  });

  it('generates default cut labels from source endpoint context', () => {
    const module = fanoutGraph.modules.top;
    expect(defaultNetCutLabel(module.edges[0], module, { nodes: {} })).toBe('clk');

    const instanceModule = {
      ...module,
      nodes: [
        {
          id: 'u_alu',
          kind: 'instance' as const,
          label: 'u_alu',
          ports: [{ id: 'result', name: 'result', direction: 'output' as const }],
        },
      ],
      edges: [{ id: 'result-y', source: 'u_alu', sourcePort: 'result', target: 'y' }],
    };
    expect(defaultNetCutLabel(instanceModule.edges[0], instanceModule, { nodes: {} })).toBe(
      'u_alu.result',
    );

    const anonymousModule = {
      ...module,
      nodes: [
        {
          id: 'comb:1',
          kind: 'comb' as const,
          label: 'assign',
          ports: [{ id: 'out', name: 'out', direction: 'output' as const }],
        },
      ],
      edges: [{ id: 'comb-y', source: 'comb:1', sourcePort: 'out', target: 'y' }],
    };
    expect(
      defaultNetCutLabel(anonymousModule.edges[0], anonymousModule, {
        nodes: {},
        netCuts: {
          'old:out': { label: 'NET_1', source: { nodeId: 'old', portId: 'out' } },
        },
      }),
    ).toBe('NET_2');
  });

  it(
    'prefers a declared net name over structural ' + 'heuristics, even for an instance-driven net',
    () => {
      const instanceModule = {
        ...fanoutGraph.modules.top,
        nodes: [
          {
            id: 'u_alu',
            kind: 'instance' as const,
            label: 'u_alu',
            ports: [{ id: 'result', name: 'result', direction: 'output' as const }],
          },
        ],
        edges: [
          {
            id: 'result-y',
            source: 'u_alu',
            sourcePort: 'result',
            target: 'y',
            signal: 'chip_select',
            metadata: { declaredNetName: 'chip_select' },
          },
        ],
      };
      // Without a declaredNetName this would fall back to 'u_alu.result' (see
      // the test above) — a real declared name always wins over that guess.
      expect(defaultNetCutLabel(instanceModule.edges[0], instanceModule, { nodes: {} })).toBe(
        'chip_select',
      );
    },
  );

  it(
    'marks a cut net origin as declared or synthetic based ' +
      'on whether the label came from a declared net name',
    () => {
      const module = fanoutGraph.modules.top;
      const positioned: PositionedNode[] = [
        { ...module.nodes[0], position: { x: 0, y: 12 } },
        { ...module.nodes[1], position: { x: 240, y: 0 } },
        { ...module.nodes[2], position: { x: 240, y: 96 } },
      ];

      // No declaredNetName on this fixture edge -> the label is tool-guessed.
      const synthetic = mergeNetCut(
        { version: 1, modules: {} },
        'top',
        module.edges[0],
        module,
        positioned,
      );
      expect(synthetic.modules.top.netCuts?.['clk:p'].origin).toBe('synthetic');

      const declaredModule = {
        ...module,
        edges: [{ ...module.edges[0], metadata: { declaredNetName: 'clk' } }, module.edges[1]],
      };
      const declared = mergeNetCut(
        { version: 1, modules: {} },
        'top',
        declaredModule.edges[0],
        declaredModule,
        positioned,
      );
      expect(declared.modules.top.netCuts?.['clk:p']).toEqual({
        label: 'clk',
        source: { nodeId: 'clk', portId: 'p' },
        deferLabelPlacement: true,
        origin: 'declared',
        defaultLabel: 'clk',
      });
    },
  );

  it('dims a cut end the same way as its wire on an inactive generate arm', async () => {
    const module = {
      ...fanoutGraph.modules.top,
      edges: [
        {
          ...fanoutGraph.modules.top.edges[0],
          metadata: { generateRegionId: 'g_other', generateActiveState: 'inactive' },
        },
        fanoutGraph.modules.top.edges[1],
      ],
    };
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 240, y: 0 } },
      { ...module.nodes[2], position: { x: 240, y: 96 } },
    ];

    const cutLayout = mergeNetCut(
      { version: 1, modules: {} },
      'top',
      module.edges[0],
      module,
      positioned,
    );
    const view = await buildViewModel(
      {
        rootModules: ['top'],
        generatedAt: 'now',
        diagnostics: [],
        modules: { top: module },
      },
      'top',
      cutLayout,
    );

    const netKey = edgeNetKey(module.edges[0]);
    const byId = new Map(view.nodes.map((node) => [node.id, node]));
    const sourceLabel = byId.get(`cut-label:${netKey}:source`);
    const sinkLabel = byId.get(`cut-label:${netKey}:sink:${module.edges[0].id}`);
    expect(sourceLabel?.metadata?.generateActiveState).toBe('inactive');
    expect(sourceLabel?.metadata?.generateRegionId).toBe('g_other');
    expect(sinkLabel?.metadata?.generateActiveState).toBe('inactive');
    expect(sinkLabel?.metadata?.generateRegionId).toBe('g_other');

    // The other fanout branch (e-clk-u2) is untouched — its own sink label
    // must not inherit the inactive state from a sibling edge on the net.
    const otherSinkLabel = byId.get(`cut-label:${netKey}:sink:${module.edges[1].id}`);
    expect(otherSinkLabel?.metadata?.generateActiveState).toBeUndefined();
  });

  it('refuses to rename a declared net but still allows renaming a synthetic one', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {},
          netCuts: {
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' }, origin: 'declared' },
            'old:out': {
              label: 'NET_1',
              source: { nodeId: 'old', portId: 'out' },
              origin: 'synthetic',
            },
          },
        },
      },
    };

    const afterDeclaredRename = renameCutNet(layout, 'top', 'clk:p', 'renamed_clk');
    expect(afterDeclaredRename).toBe(layout);
    expect(afterDeclaredRename.modules.top.netCuts?.['clk:p'].label).toBe('clk');

    const afterSyntheticRename = renameCutNet(layout, 'top', 'old:out', 'renamed_net');
    expect(afterSyntheticRename.modules.top.netCuts?.['old:out'].label).toBe('renamed_net');

    // A cut saved before this field existed (no `origin` at all) is treated
    // as synthetic for backward compatibility, so it stays renameable.
    const legacyLayout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {},
          netCuts: {
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
          },
        },
      },
    };
    const afterLegacyRename = renameCutNet(legacyLayout, 'top', 'clk:p', 'renamed_clk');
    expect(afterLegacyRename.modules.top.netCuts?.['clk:p'].label).toBe('renamed_clk');
  });

  it('cutting a plain `assign y = a;` net (no formal wire name) stays renameable', async () => {
    // Real end-to-end check (not a hand-built fixture): a net whose only
    // identity is borrowed from one of its own endpoint ports has nothing
    // declared to protect, so it must come out 'synthetic' even though its
    // default label ("a") looks just as legitimate as a real wire name.
    const graph = await runParser(
      'uhdm',
      'top.sv',
      `
      module top(input a, output y);
        assign y = a;
      endmodule
    `,
    );
    const view = await buildViewModel(graph, 'top', { version: 1, modules: {} });
    const edge = view.edges[0];
    expect(edge.label).toBeUndefined();

    const cutLayout = mergeNetCut(
      { version: 1, modules: {} },
      'top',
      edge,
      graph.modules.top,
      view.nodes,
    );
    const cut = cutLayout.modules.top.netCuts?.[edgeNetKey(edge)];
    expect(cut?.label).toBe('a');
    expect(cut?.origin).toBe('synthetic');

    const renamed = renameCutNet(cutLayout, 'top', edgeNetKey(edge), 'chip_select');
    expect(renamed.modules.top.netCuts?.[edgeNetKey(edge)].label).toBe('chip_select');
  });

  it(
    'a cut net stays regular type (not renamed) until the label ' +
      'actually diverges from its default, and reverting restores it',
    async () => {
      const graph = await runParser(
        'uhdm',
        'top.sv',
        `
      module top(input a, output y);
        assign y = a;
      endmodule
    `,
      );
      const view = await buildViewModel(graph, 'top', { version: 1, modules: {} });
      const edge = view.edges[0];
      const netKey = edgeNetKey(edge);

      const cutLayout = mergeNetCut(
        { version: 1, modules: {} },
        'top',
        edge,
        graph.modules.top,
        view.nodes,
      );
      const freshCutView = await buildViewModel(graph, 'top', cutLayout);
      const freshLabelNode = freshCutView.nodes.find((n) => n.metadata?.cutNet?.netKey === netKey);
      expect(freshLabelNode?.metadata?.cutNet?.isRenamed).toBe(false);

      const renamedLayout = renameCutNet(cutLayout, 'top', netKey, 'chip_select');
      const renamedView = await buildViewModel(graph, 'top', renamedLayout);
      const renamedLabelNode = renamedView.nodes.find((n) => n.metadata?.cutNet?.netKey === netKey);
      expect(renamedLabelNode?.metadata?.cutNet?.isRenamed).toBe(true);

      // Typing the exact original name back also counts as "not renamed".
      const revertedByTypingBack = renameCutNet(renamedLayout, 'top', netKey, 'a');
      const typedBackView = await buildViewModel(graph, 'top', revertedByTypingBack);
      const typedBackLabelNode = typedBackView.nodes.find(
        (n) => n.metadata?.cutNet?.netKey === netKey,
      );
      expect(typedBackLabelNode?.metadata?.cutNet?.isRenamed).toBe(false);

      const revertedLayout = revertCutNetLabel(renamedLayout, 'top', netKey);
      expect(revertedLayout.modules.top.netCuts?.[netKey].label).toBe('a');
      const revertedView = await buildViewModel(graph, 'top', revertedLayout);
      const revertedLabelNode = revertedView.nodes.find(
        (n) => n.metadata?.cutNet?.netKey === netKey,
      );
      expect(revertedLabelNode?.metadata?.cutNet?.isRenamed).toBe(false);
    },
  );

  it('adds, renames, removes, and reroutes net cuts without discarding the cut state', () => {
    const module = fanoutGraph.modules.top;
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 240, y: 0 } },
      { ...module.nodes[2], position: { x: 240, y: 96 } },
    ];

    const cut = mergeNetCut(
      { version: 1, modules: {} },
      'top',
      module.edges[0],
      module,
      positioned,
    );

    expect(cut.modules.top.nodes.clk).toEqual({ x: 0, y: 12, fixed: true });
    expect(cut.modules.top.netCuts?.['clk:p']).toEqual({
      label: 'clk',
      source: { nodeId: 'clk', portId: 'p' },
      deferLabelPlacement: true,
      origin: 'synthetic',
      defaultLabel: 'clk',
    });

    const duplicateCut = mergeNetCut(cut, 'top', module.edges[0], module, positioned);
    expect(duplicateCut).toBe(cut);

    const renamed = renameCutNet(cut, 'top', 'clk:p', ' data_clk ');
    expect(renamed.modules.top.netCuts?.['clk:p'].label).toBe('data_clk');
    expect(renameCutNet(renamed, 'top', 'clk:p', '   ')).toBe(renamed);

    const withSyntheticLayouts: SavedLayout = {
      version: 1,
      modules: {
        top: {
          ...renamed.modules.top,
          nodes: {
            ...renamed.modules.top.nodes,
            'cut-label:clk:p:source': { x: 24, y: 12, fixed: true },
            'cut-label:clk:p:sink:e-clk-u1': { x: 180, y: 12, fixed: true },
          },
          edges: {
            'cut-stub:clk:p:source': { routePoints: [{ x: 0, y: 0 }] },
            'cut-stub:clk:p:sink:e-clk-u1': { routePoints: [{ x: 1, y: 1 }] },
            'e-clk-u1': { routePoints: [{ x: 2, y: 2 }] },
          },
        },
      },
    };

    const removed = removeNetCut(withSyntheticLayouts, 'top', 'clk:p');
    expect(removed.modules.top.netCuts).toBeUndefined();
    expect(removed.modules.top.nodes['cut-label:clk:p:source']).toBeUndefined();
    expect(removed.modules.top.edges?.['cut-stub:clk:p:source']).toBeUndefined();
    expect(removed.modules.top.edges?.['e-clk-u1']).toEqual({ routePoints: [{ x: 2, y: 2 }] });

    const rerouted = mergeRerouteLayout(renamed, 'top', positioned);
    expect(rerouted.modules.top.netCuts).toEqual(renamed.modules.top.netCuts);
    expect(rerouted.modules.top.edges).toBeUndefined();
  });

  it('projects active fanout cuts into source and sink label stubs', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            clk: { x: 0, y: 12, fixed: true },
            u1: { x: 240, y: 0, fixed: true },
            u2: { x: 240, y: 96, fixed: true },
          },
          netCuts: {
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
          },
        },
      },
    };

    const view = await buildViewModel(fanoutGraph, 'top', layout);
    const edgeIds = view.edges.map((edge) => edge.id);
    expect(edgeIds).not.toContain('e-clk-u1');
    expect(edgeIds).not.toContain('e-clk-u2');
    expect(
      view.nodes
        .filter((node) => node.kind === 'netLabel')
        .map((node) => node.id)
        .sort(),
    ).toEqual([
      'cut-label:clk:p:sink:e-clk-u1',
      'cut-label:clk:p:sink:e-clk-u2',
      'cut-label:clk:p:source',
    ]);

    const stubs = view.edges.filter((edge) => edge.metadata?.cutStub);
    expect(stubs).toHaveLength(3);
    expect(stubs.every((edge) => edge.metadata?.forceStraight === true)).toBe(true);
    expect(stubs.every((edge) => edgeNetKey(edge) === 'clk:p')).toBe(true);
    expect(stubs.find((edge) => edge.metadata?.cutStub?.role === 'source')?.target).toBe(
      'cut-label:clk:p:source',
    );
    expect(
      stubs
        .filter((edge) => edge.metadata?.cutStub?.role === 'sink')
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['cut-label:clk:p:sink:e-clk-u1', 'cut-label:clk:p:sink:e-clk-u2']);
  });

  it('separates automatic cut labels that share the same canonical position', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            clk: { x: 0, y: 0, fixed: true },
            u1: { x: 144, y: 0, fixed: true },
            u2: { x: 144, y: 0, fixed: true },
          },
          netCuts: {
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
          },
        },
      },
    };

    const view = await buildViewModel(fanoutGraph, 'top', layout);
    const labels = view.nodes.filter((node) => node.kind === 'netLabel').map(boundsOf);
    expect(labels).toHaveLength(3);
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        expect(boxesOverlap(labels[i], labels[j])).toBe(false);
      }
    }
  });

  it('stacks cut labels that share one endpoint across that endpoint axis', async () => {
    const sharedSinkGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'p', name: 'a', direction: 'input' }],
            },
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'p', name: 'b', direction: 'input' }],
            },
            {
              id: 'y',
              kind: 'port',
              label: 'y',
              ports: [{ id: 'p', name: 'y', direction: 'output' }],
            },
          ],
          edges: [
            { id: 'a-y', source: 'a', sourcePort: 'p', target: 'y', targetPort: 'p' },
            { id: 'b-y', source: 'b', sourcePort: 'p', target: 'y', targetPort: 'p' },
          ],
        },
      },
    };
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            a: { x: 0, y: 0, fixed: true },
            b: { x: 0, y: 96, fixed: true },
            y: { x: 240, y: 0, fixed: true },
          },
          netCuts: {
            'a:p': { label: 'a', source: { nodeId: 'a', portId: 'p' } },
            'b:p': { label: 'b', source: { nodeId: 'b', portId: 'p' } },
          },
        },
      },
    };

    const view = await buildViewModel(sharedSinkGraph, 'top', layout);
    const sinks = view.nodes.filter((node) => node.metadata?.cutNet?.role === 'sink').map(boundsOf);

    expect(sinks).toHaveLength(2);
    expect(sinks[0].x).toBe(sinks[1].x);
    expect(sinks[0].y).not.toBe(sinks[1].y);
    expect(boxesOverlap(sinks[0], sinks[1])).toBe(false);
  });

  it('keeps adjacent register cut labels level with their input ports', async () => {
    const registerCutGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'data',
              kind: 'port',
              label: 'data',
              ports: [{ id: 'p', name: 'data', direction: 'input' }],
            },
            {
              id: 'clk',
              kind: 'port',
              label: 'clk',
              ports: [{ id: 'p', name: 'clk', direction: 'input' }],
            },
            {
              id: 'r',
              kind: 'register',
              label: 'r',
              clockSignal: 'clk',
              ports: [
                { id: 'd', name: 'D', direction: 'input' },
                { id: 'clk', name: 'clk', direction: 'input' },
                { id: 'q', name: 'Q', direction: 'output' },
              ],
            },
          ],
          edges: [
            { id: 'data-r', source: 'data', sourcePort: 'p', target: 'r', targetPort: 'd' },
            { id: 'clk-r', source: 'clk', sourcePort: 'p', target: 'r', targetPort: 'clk' },
          ],
        },
      },
    };
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            data: { x: 0, y: 12, fixed: true },
            clk: { x: 0, y: 108, fixed: true },
            r: { x: 456, y: 432, fixed: true },
          },
          netCuts: {
            'data:p': { label: 'data', source: { nodeId: 'data', portId: 'p' } },
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
          },
        },
      },
    };

    const view = await buildViewModel(registerCutGraph, 'top', layout);
    const byId = new Map(view.nodes.map((node) => [node.id, node]));
    const register = byId.get('r')!;
    const dataLabel = byId.get('cut-label:data:p:sink:data-r')!;
    const clockLabel = byId.get('cut-label:clk:p:sink:clk-r')!;
    const dataBounds = boundsOf(dataLabel);
    const clockBounds = boundsOf(clockLabel);

    expect(dataBounds.y + dataBounds.height / 2).toBe(
      register.position.y + diagramSizing.nodeHeaderHeight + diagramSizing.gridSize / 2,
    );
    expect(clockBounds.y + clockBounds.height / 2).toBe(
      register.position.y + diagramSizing.nodeHeaderHeight + diagramSizing.gridSize * 1.5,
    );
    expect(boxesOverlap(dataBounds, clockBounds)).toBe(false);
  });

  it('lets a manual cut overlap until an endpoint participates in Auto Layout', async () => {
    const manualCutGraph: DesignGraph = {
      ...twoNetGraph,
      modules: {
        top: {
          ...twoNetGraph.modules.top,
          nodes: twoNetGraph.modules.top.nodes.map((node) => ({
            ...node,
            ports: node.ports.map((port) => ({
              ...port,
              direction: node.id === 'a' ? 'input' : node.id === 'x' ? 'output' : port.direction,
            })),
          })),
        },
      },
    };
    const module = manualCutGraph.modules.top;
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 0, y: 60 } },
      { ...module.nodes[2], position: { x: 240, y: 12 } },
      { ...module.nodes[3], position: { x: 240, y: 60 } },
    ];
    const netKey = edgeNetKey(module.edges[0]);
    const cut = mergeNetCut(
      { version: 1, modules: {} },
      'top',
      module.edges[0],
      module,
      positioned,
    );

    expect(cut.modules.top.netCuts?.[netKey].deferLabelPlacement).toBe(true);
    const cutView = await buildViewModel(manualCutGraph, 'top', cut);
    const cutLabels = cutView.nodes.filter((node) => node.metadata?.cutNet?.netKey === netKey);
    expect(cutLabels).toHaveLength(2);
    expect(boxesOverlap(boundsOf(cutLabels[0]), boundsOf(cutLabels[1]))).toBe(true);

    const relayouted = mergeRelayoutSelection(cut, 'top', ['a', 'x'], cutView.nodes, module);
    expect(relayouted.modules.top.netCuts?.[netKey].deferLabelPlacement).toBeUndefined();

    const relaidView = await buildViewModel(manualCutGraph, 'top', relayouted);
    const relaidLabels = relaidView.nodes.filter(
      (node) => node.metadata?.cutNet?.netKey === netKey,
    );
    expect(relaidLabels).toHaveLength(2);
    expect(boxesOverlap(boundsOf(relaidLabels[0]), boundsOf(relaidLabels[1]))).toBe(false);
  });

  it('moves an automatic cut label away from an overlapping design node', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            clk: { x: 0, y: 12, fixed: true },
            u1: { x: 240, y: 0, fixed: true },
            u2: { x: 240, y: 96, fixed: true },
          },
          netCuts: {
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
          },
        },
      },
    };
    const baseline = await buildViewModel(fanoutGraph, 'top', layout);
    const sourceLabel = baseline.nodes.find((node) => node.id === 'cut-label:clk:p:source')!;
    const graphWithBlocker: DesignGraph = {
      ...fanoutGraph,
      modules: {
        top: {
          ...fanoutGraph.modules.top,
          nodes: [
            ...fanoutGraph.modules.top.nodes,
            { id: 'blocker', kind: 'instance', label: 'blocker', ports: [] },
          ],
        },
      },
    };
    const blockedLayout: SavedLayout = {
      ...layout,
      modules: {
        top: {
          ...layout.modules.top,
          nodes: {
            ...layout.modules.top.nodes,
            blocker: { ...sourceLabel.position, fixed: true },
          },
        },
      },
    };

    const view = await buildViewModel(graphWithBlocker, 'top', blockedLayout);
    const blocker = view.nodes.find((node) => node.id === 'blocker')!;
    const relocatedSource = view.nodes.find((node) => node.id === sourceLabel.id)!;
    expect(boxesOverlap(boundsOf(relocatedSource), boundsOf(blocker))).toBe(false);
    expect(relocatedSource.position).not.toEqual(sourceLabel.position);
  });

  it('falls back when the bounded cut-label collision search finds no clear spot', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            clk: { x: 0, y: 12, fixed: true },
            u1: { x: 240, y: 0, fixed: true },
            u2: { x: 240, y: 96, fixed: true },
          },
          netCuts: {
            'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
          },
        },
      },
    };
    const baseline = await buildViewModel(fanoutGraph, 'top', layout);
    const sourceLabel = baseline.nodes.find((node) => node.id === 'cut-label:clk:p:source')!;
    const blocker: DiagramNode = {
      id: 'blocker',
      kind: 'instance',
      label: 'blocker'.repeat(40),
      ports: Array.from({ length: 80 }, (_, index) => ({
        id: `in-${index}`,
        name: `in-${index}`,
        direction: 'input' as const,
      })),
    };
    const blockerSize = diagramNodeDimensions(blocker);
    const sourceLabelSize = diagramNodeDimensions(sourceLabel);
    const graphWithBlocker: DesignGraph = {
      ...fanoutGraph,
      modules: {
        top: {
          ...fanoutGraph.modules.top,
          nodes: [...fanoutGraph.modules.top.nodes, blocker],
        },
      },
    };
    const blockedLayout: SavedLayout = {
      ...layout,
      modules: {
        top: {
          ...layout.modules.top,
          nodes: {
            ...layout.modules.top.nodes,
            blocker: {
              x: sourceLabel.position.x - (blockerSize.width - sourceLabelSize.width) / 2,
              y: sourceLabel.position.y - (blockerSize.height - sourceLabelSize.height) / 2,
              fixed: true,
            },
          },
        },
      },
    };

    const view = await buildViewModel(graphWithBlocker, 'top', blockedLayout);
    const blockedSource = view.nodes.find((node) => node.id === sourceLabel.id)!;
    const positionedBlocker = view.nodes.find((node) => node.id === blocker.id)!;
    // The oversized blocker covers every candidate within the search bound.
    // Remaining overlapped confirms that resolution fell back instead of
    // continuing outward until it eventually escaped the blocker.
    expect(boxesOverlap(boundsOf(blockedSource), boundsOf(positionedBlocker))).toBe(true);
  });

  it(
    "projects a cut net's declared origin and alias " +
      'chain onto both its source and sink labels',
    async () => {
      const declaredFanoutGraph: DesignGraph = {
        ...fanoutGraph,
        modules: {
          top: {
            ...fanoutGraph.modules.top,
            edges: fanoutGraph.modules.top.edges.map((edge) => ({
              ...edge,
              metadata: { declaredNetName: 'clk', aliasNames: ['sys_clk', 'core_clk'] },
            })),
          },
        },
      };
      const layout: SavedLayout = {
        version: 1,
        modules: {
          top: {
            nodes: {
              clk: { x: 0, y: 12, fixed: true },
              u1: { x: 240, y: 0, fixed: true },
              u2: { x: 240, y: 96, fixed: true },
            },
            netCuts: {
              'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' }, origin: 'declared' },
            },
          },
        },
      };

      const view = await buildViewModel(declaredFanoutGraph, 'top', layout);
      const labelNodes = view.nodes.filter((node) => node.kind === 'netLabel');
      expect(labelNodes).toHaveLength(3);
      for (const node of labelNodes) {
        expect(node.metadata?.cutNet?.origin).toBe('declared');
        expect(node.metadata?.cutNet?.aliasNames).toEqual(['sys_clk', 'core_clk']);
      }
    },
  );

  it('shows no label on a plain net whose declared name matches an endpoint port', async () => {
    // assign y = a; -- the net's own name ('a') is already visible on the
    // port itself, so labeling the wire too would just repeat it.
    const view = await buildViewModel(
      {
        rootModules: ['top'],
        generatedAt: 'now',
        diagnostics: [],
        modules: {
          top: {
            name: 'top',
            file: 'top.sv',
            ports: [],
            nodes: [
              {
                id: 'a',
                kind: 'port',
                label: 'a',
                ports: [{ id: 'p', name: 'a', direction: 'input' }],
              },
              {
                id: 'y',
                kind: 'port',
                label: 'y',
                ports: [{ id: 'p', name: 'y', direction: 'output' }],
              },
            ],
            edges: [
              {
                id: 'e-a-y',
                source: 'a',
                sourcePort: 'p',
                target: 'y',
                targetPort: 'p',
                signal: 'y',
                metadata: { declaredNetName: 'a', aliasNames: ['y'] },
              },
            ],
          },
        },
      } as DesignGraph,
      'top',
      { version: 1, modules: {} },
    );
    expect(view.edges[0].label).toBeUndefined();
  });

  it('labels a plain wire whose declared name differs from both endpoint ports', async () => {
    // wire x; assign x = a; assign y = x; -- 'x' isn't visible anywhere else
    // in the diagram, so the uncut wire shows it directly.
    const view = await buildViewModel(
      {
        rootModules: ['top'],
        generatedAt: 'now',
        diagnostics: [],
        modules: {
          top: {
            name: 'top',
            file: 'top.sv',
            ports: [],
            nodes: [
              {
                id: 'a',
                kind: 'port',
                label: 'a',
                ports: [{ id: 'p', name: 'a', direction: 'input' }],
              },
              {
                id: 'y',
                kind: 'port',
                label: 'y',
                ports: [{ id: 'p', name: 'y', direction: 'output' }],
              },
            ],
            edges: [
              {
                id: 'e-a-y',
                source: 'a',
                sourcePort: 'p',
                target: 'y',
                targetPort: 'p',
                signal: 'y',
                metadata: { declaredNetName: 'x', aliasNames: ['a', 'y'] },
              },
            ],
          },
        },
      } as DesignGraph,
      'top',
      { version: 1, modules: {} },
    );
    expect(view.edges[0].label).toBe('x');
  });

  it(
    'keeps only the alias names that are not already ' +
      'visible at either endpoint, for a multi-hop chain',
    async () => {
      // wire x1, x2; assign x1 = a; assign x2 = x1; assign y = x2; -- 'x1' wins
      // as the label (declared first). 'a' and 'y' are already shown as the
      // ports at either end of this exact wire, so repeating them in the
      // popover would say nothing new — only 'x2' (the other internal wire
      // this chain passed through) is worth surfacing there.
      const view = await buildViewModel(
        {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: {
            top: {
              name: 'top',
              file: 'top.sv',
              ports: [],
              nodes: [
                {
                  id: 'a',
                  kind: 'port',
                  label: 'a',
                  ports: [{ id: 'p', name: 'a', direction: 'input' }],
                },
                {
                  id: 'y',
                  kind: 'port',
                  label: 'y',
                  ports: [{ id: 'p', name: 'y', direction: 'output' }],
                },
              ],
              edges: [
                {
                  id: 'e-a-y',
                  source: 'a',
                  sourcePort: 'p',
                  target: 'y',
                  targetPort: 'p',
                  signal: 'y',
                  metadata: { declaredNetName: 'x1', aliasNames: ['x2', 'a', 'y'] },
                },
              ],
            },
          },
        } as DesignGraph,
        'top',
        { version: 1, modules: {} },
      );
      expect(view.edges[0].label).toBe('x1');
      expect(view.edges[0].metadata?.aliasNames).toEqual(['x2']);
    },
  );

  it(
    'does not label a wire whose declared name ' + "only repeats the connected block's own title",
    async () => {
      // An interface instance's block title *is* its instance name (e.g.
      // `simple_if link(clk);` draws a block titled "link") — the connected
      // port ("master"/"slave") differs from that name, but the block already
      // says "link" regardless, so labeling the wire "link" too is redundant.
      const view = await buildViewModel(
        {
          rootModules: ['top'],
          generatedAt: 'now',
          diagnostics: [],
          modules: {
            top: {
              name: 'top',
              file: 'top.sv',
              ports: [],
              nodes: [
                {
                  id: 'instance:top:u_producer',
                  kind: 'instance',
                  label: 'u_producer',
                  ports: [{ id: 'port:bus', name: 'bus', direction: 'output' }],
                },
                {
                  id: 'interface:top:link',
                  kind: 'interface',
                  label: 'link',
                  ports: [{ id: 'in:master', name: 'master', direction: 'input' }],
                },
              ],
              edges: [
                {
                  id: 'e-producer-link',
                  source: 'instance:top:u_producer',
                  sourcePort: 'port:bus',
                  target: 'interface:top:link',
                  targetPort: 'in:master',
                  signal: 'link',
                  metadata: { declaredNetName: 'link' },
                },
              ],
            },
          },
        } as DesignGraph,
        'top',
        { version: 1, modules: {} },
      );
      expect(view.edges[0].label).toBeUndefined();
    },
  );

  it(
    're-derives a released cut-label position ' + 'from geometry instead of a stale saved hint',
    async () => {
      const baseLayout: SavedLayout = {
        version: 1,
        modules: {
          top: {
            nodes: {
              clk: { x: 0, y: 12, fixed: true },
              u1: { x: 240, y: 0, fixed: true },
              u2: { x: 240, y: 96, fixed: true },
            },
            netCuts: {
              'clk:p': { label: 'clk', source: { nodeId: 'clk', portId: 'p' } },
            },
          },
        },
      };

      const baseline = await buildViewModel(fanoutGraph, 'top', baseLayout);
      const baselineSource = baseline.nodes.find((node) => node.id === 'cut-label:clk:p:source')!;

      // Simulate a stale, non-fixed position hint left behind for the label —
      // e.g. by an earlier selection Auto Layout pass that released it without
      // ELK ever placing it. This must not stick: only a *pinned* (fixed) save
      // should override the geometry-derived fallback.
      const staleLayout: SavedLayout = {
        version: 1,
        modules: {
          top: {
            ...baseLayout.modules.top,
            nodes: {
              ...baseLayout.modules.top.nodes,
              'cut-label:clk:p:source': { x: 999, y: 999, fixed: false },
            },
          },
        },
      };

      const view = await buildViewModel(fanoutGraph, 'top', staleLayout);
      const source = view.nodes.find((node) => node.id === 'cut-label:clk:p:source')!;
      expect(source.position).toEqual(baselineSource.position);

      // A genuinely pinned (fixed: true) save — e.g. the user dragged the label
      // by hand — is still honored verbatim.
      const pinnedLayout: SavedLayout = {
        version: 1,
        modules: {
          top: {
            ...baseLayout.modules.top,
            nodes: {
              ...baseLayout.modules.top.nodes,
              'cut-label:clk:p:source': { x: 999, y: 999, fixed: true },
            },
          },
        },
      };
      const pinnedView = await buildViewModel(fanoutGraph, 'top', pinnedLayout);
      const pinnedSource = pinnedView.nodes.find((node) => node.id === 'cut-label:clk:p:source')!;
      expect(pinnedSource.position).toEqual({ x: 999, y: 999 });
    },
  );

  it(
    'reserves ELK margin for a net-cut label on the ' +
      'lead side so it does not collide with a neighbor',
    () => {
      const outputPort: DiagramNode = {
        id: 'a',
        kind: 'port',
        label: 'a',
        ports: [{ id: 'p', name: 'a', direction: 'output' }],
      };
      const bare = elkNodeForDiagramNode(outputPort, true);
      // An output port on a 'port' node is WEST-side — the label protrudes
      // further left of the node and is vertically centered on the port, so a
      // label that's both wider and taller than the base lead/box grows both
      // the left margin (more room in the lead's own direction) and top/bottom
      // margins (room for the part of the label that overshoots the box
      // vertically), while leaving the right margin untouched.
      const withLabel = elkNodeForDiagramNode(
        outputPort,
        true,
        new Map([['p', { width: 80, height: 96 }]]),
      );
      expect(withLabel.width).toBeGreaterThan(bare.width);
      expect(withLabel.layoutOffset.x).toBeGreaterThan(bare.layoutOffset.x);
      expect(withLabel.height).toBeGreaterThan(bare.height);
      expect(withLabel.width - bare.width).toBeCloseTo(80, 0);

      // No entry for this port at all: behaves exactly like the call with no
      // extraPortMargins argument (the common case is unaffected).
      const untouched = elkNodeForDiagramNode(outputPort, true, new Map());
      expect(untouched).toEqual(bare);
    },
  );

  it(
    'lays out several stacked net-cut source ports ' +
      'without their dangling ends overlapping a neighbor',
    async () => {
      // Cut both nets, but save no node positions at all — ELK must freely
      // place "a" and "b" (naturally stacked in the same layer, since both are
      // plain sources with no other constraint) and, with them, reserve room
      // for their now-active cut labels.
      const layout: SavedLayout = {
        version: 1,
        modules: {
          top: {
            nodes: {},
            netCuts: {
              'a:p': { label: 'a', source: { nodeId: 'a', portId: 'p' } },
              'b:p': { label: 'b', source: { nodeId: 'b', portId: 'p' } },
            },
          },
        },
      };

      const view = await buildViewModel(twoNetGraph, 'top', layout);
      const boxes = view.nodes.map((node) => ({ id: node.id, ...boundsOf(node) }));
      expect(boxes.some((box) => box.id === 'cut-label:a:p:source')).toBe(true);
      expect(boxes.some((box) => box.id === 'cut-label:b:p:source')).toBe(true);

      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(boxesOverlap(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`).toBe(
            false,
          );
        }
      }
    },
  );

  it('resets a cut label back to its canonical position by clearing its saved override', () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            'cut-label:a:p:source': { x: 999, y: 999, fixed: true },
            a: { x: 0, y: 12, fixed: true },
          },
        },
      },
    };

    const reset = resetCutLabelPosition(layout, 'top', 'cut-label:a:p:source');
    expect(reset.modules.top.nodes['cut-label:a:p:source']).toBeUndefined();
    expect(reset.modules.top.nodes.a).toEqual({ x: 0, y: 12, fixed: true });

    // No-op when there's nothing saved for that id.
    const noop = resetCutLabelPosition(reset, 'top', 'cut-label:a:p:source');
    expect(noop).toBe(reset);
  });

  it("cutting a second net does not pin the first net's still-dynamic dangling end", () => {
    const module = twoNetGraph.modules.top;
    const positioned: PositionedNode[] = [
      { ...module.nodes[0], position: { x: 0, y: 12 } },
      { ...module.nodes[1], position: { x: 0, y: 60 } },
      { ...module.nodes[2], position: { x: 240, y: 12 } },
      { ...module.nodes[3], position: { x: 240, y: 60 } },
    ];

    // Cut a->x first...
    let layout = mergeNetCut(
      { version: 1, modules: {} },
      'top',
      module.edges[0],
      module,
      positioned,
    );
    // ...its dangling end is dynamic (never dragged), so it has no saved entry yet.
    expect(layout.modules.top.nodes['cut-label:a:p:source']).toBeUndefined();

    // Cutting a second, unrelated net (b->y) passes every currently-rendered
    // node — including a->x's cut label — through mergeNetCut again.
    const withBothCuts: PositionedNode[] = [
      ...positioned,
      {
        id: 'cut-label:a:p:source',
        kind: 'netLabel',
        label: 'a',
        ports: [],
        position: { x: -120, y: -12 },
      },
    ];
    layout = mergeNetCut(layout, 'top', module.edges[1], module, withBothCuts);

    // The unrelated cut must not have implicitly pinned a->x's dangling end.
    expect(layout.modules.top.nodes['cut-label:a:p:source']).toBeUndefined();
    // The real blocks are still frozen, exactly as mergeNetCut intends.
    expect(layout.modules.top.nodes.a).toEqual({ x: 0, y: 12, fixed: true });
    expect(layout.modules.top.nodes.b).toEqual({ x: 0, y: 60, fixed: true });
  });

  it(
    'uses ELK routes for ordinary feedback edges ' + 'so wires wrap around default node boxes',
    async () => {
      const feedbackGraph: DesignGraph = {
        rootModules: ['top'],
        generatedAt: 'now',
        diagnostics: [],
        modules: {
          top: {
            name: 'top',
            file: 'top.sv',
            ports: [],
            nodes: [
              {
                id: 'latch',
                kind: 'latch',
                label: 'next_r',
                ports: [
                  { id: 'q', name: 'Q', direction: 'output' },
                  { id: 'd', name: 'D', direction: 'input' },
                ],
              },
              {
                id: 'mux',
                kind: 'mux',
                label: 'if en',
                ports: [
                  { id: 'sel', name: 'sel', direction: 'input' },
                  { id: 'true', name: 'true', direction: 'input' },
                  { id: 'out', name: 'out', direction: 'output' },
                ],
              },
            ],
            edges: [
              {
                id: 'feedback',
                source: 'latch',
                sourcePort: 'q',
                target: 'mux',
                targetPort: 'true',
              },
              {
                id: 'mux-latch',
                source: 'mux',
                sourcePort: 'out',
                target: 'latch',
                targetPort: 'd',
              },
            ],
          },
        },
      };

      const view = await buildViewModel(feedbackGraph, 'top', { version: 1, modules: {} });
      const route = view.edges.find((edge) => edge.id === 'feedback')?.routePoints;
      const latch = view.nodes.find((node) => node.id === 'latch')!;
      const mux = view.nodes.find((node) => node.id === 'mux')!;
      const latchBottom = latch.position.y + diagramNodeDimensions(latch).height;
      const muxBottom = mux.position.y + diagramNodeDimensions(mux).height;

      expect(route).toBeDefined();
      expect(route!.length).toBeGreaterThanOrEqual(4);
      expect(route![0]).toEqual({
        x: latch.position.x + diagramNodeDimensions(latch).width + diagramSizing.edgeLeadLength,
        y: latch.position.y + diagramSizing.nodeHeaderHeight + diagramSizing.gridSize / 2,
      });
      expect(route![route!.length - 1]).toEqual({
        x: mux.position.x - diagramSizing.edgeLeadLength,
        y: mux.position.y + diagramSizing.gridSize * 2,
      });
      expect(Math.max(...route!.map((point) => point.y))).toBeGreaterThanOrEqual(
        Math.max(latchBottom, muxBottom),
      );
    },
  );

  it('routes register reset edges to the rendered one-grid bottom lead endpoint', async () => {
    const resetGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'rst',
              kind: 'port',
              label: 'rst',
              ports: [{ id: 'rst', name: 'rst', direction: 'input' }],
            },
            {
              id: 'reg',
              kind: 'register',
              label: 'q',
              ports: [
                { id: 'd', name: 'D', direction: 'input' },
                { id: 'clk', name: 'clk', direction: 'input' },
                { id: 'reset', name: 'rst', direction: 'input' },
                { id: 'q', name: 'Q', direction: 'output' },
              ],
              metadata: { clockSignal: 'clk', resetSignal: 'rst' },
            },
          ],
          edges: [
            { id: 'rst-reg', source: 'rst', sourcePort: 'rst', target: 'reg', targetPort: 'reset' },
          ],
        },
      },
    };

    const view = await buildViewModel(resetGraph, 'top', { version: 1, modules: {} });
    const route = view.edges.find((edge) => edge.id === 'rst-reg')?.routePoints;
    const rst = view.nodes.find((node) => node.id === 'rst')!;
    const reg = view.nodes.find((node) => node.id === 'reg')!;
    const regDims = diagramNodeDimensions(reg);

    expect(route).toBeDefined();
    expect(route![0]).toEqual({
      x: rst.position.x + diagramNodeDimensions(rst).width,
      y: rst.position.y + diagramSizing.portHeight / 2,
    });
    expect(route![route!.length - 1]).toEqual({
      x: reg.position.x + regDims.width / 2,
      y: 108,
    });
  });

  it('aligns simple input ports with the rendered input row of standard nodes', async () => {
    const simpleGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'comb',
              kind: 'comb',
              label: '',
              ports: [
                { id: 'out', name: 'o', direction: 'output' },
                { id: 'in', name: 'i', direction: 'input' },
              ],
            },
            {
              id: 'i',
              kind: 'port',
              label: 'i',
              ports: [{ id: 'i', name: 'i', direction: 'input' }],
            },
            {
              id: 'o',
              kind: 'port',
              label: 'o',
              ports: [{ id: 'o', name: 'o', direction: 'output' }],
            },
          ],
          edges: [
            { id: 'i-comb', source: 'i', sourcePort: 'i', target: 'comb', targetPort: 'in' },
            { id: 'comb-o', source: 'comb', sourcePort: 'out', target: 'o', targetPort: 'o' },
          ],
        },
      },
    };

    const view = await buildViewModel(simpleGraph, 'top', { version: 1, modules: {} });
    const input = view.nodes.find((node) => node.id === 'i')!;
    const output = view.nodes.find((node) => node.id === 'o')!;
    const comb = view.nodes.find((node) => node.id === 'comb')!;

    expect(renderedPortCenterY(input)).toBe(renderedNodeInputCenterY(comb, 0));
    expect(renderedPortCenterY(output)).toBe(renderedNodeInputCenterY(comb, 0));
  });

  it('lets ELK distribute simple leaf ports feeding multiple standard-node inputs', async () => {
    const multiInputGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'comb',
              kind: 'comb',
              label: '',
              ports: [
                { id: 'out', name: 'o', direction: 'output' },
                { id: 'a', name: 'a', direction: 'input' },
                { id: 'b', name: 'b', direction: 'input' },
              ],
            },
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'a', name: 'a', direction: 'input' }],
            },
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'b', name: 'b', direction: 'input' }],
            },
          ],
          edges: [
            { id: 'a-comb', source: 'a', sourcePort: 'a', target: 'comb', targetPort: 'a' },
            { id: 'b-comb', source: 'b', sourcePort: 'b', target: 'comb', targetPort: 'b' },
          ],
        },
      },
    };

    const view = await buildViewModel(multiInputGraph, 'top', { version: 1, modules: {} });
    const a = view.nodes.find((node) => node.id === 'a')!;
    const b = view.nodes.find((node) => node.id === 'b')!;
    const comb = view.nodes.find((node) => node.id === 'comb')!;

    expect(renderedNodeInputCenterY(comb, 1) - renderedNodeInputCenterY(comb, 0)).toBe(
      diagramSizing.gridSize,
    );
    expect(Math.abs(renderedPortCenterY(b) - renderedPortCenterY(a))).toBeGreaterThanOrEqual(
      diagramSizing.gridSize * 2,
    );
  });

  it('lets ELK distribute simple leaf ports feeding multiple mux side inputs', async () => {
    const muxGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'mux',
              kind: 'mux',
              label: 'case sel',
              ports: [
                { id: 'sel', name: 'sel', direction: 'input' },
                { id: 'a', name: 'a', direction: 'input' },
                { id: 'b', name: 'b', direction: 'input' },
                { id: 'out', name: 'y', direction: 'output' },
              ],
            },
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'a', name: 'a', direction: 'input' }],
            },
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'b', name: 'b', direction: 'input' }],
            },
          ],
          edges: [
            { id: 'a-mux', source: 'a', sourcePort: 'a', target: 'mux', targetPort: 'a' },
            { id: 'b-mux', source: 'b', sourcePort: 'b', target: 'mux', targetPort: 'b' },
          ],
        },
      },
    };

    const view = await buildViewModel(muxGraph, 'top', { version: 1, modules: {} });
    const a = view.nodes.find((node) => node.id === 'a')!;
    const b = view.nodes.find((node) => node.id === 'b')!;
    const mux = view.nodes.find((node) => node.id === 'mux')!;

    expect(renderedMuxSideInputCenterY(mux, 1, 2) - renderedMuxSideInputCenterY(mux, 0, 2)).toBe(
      diagramSizing.gridSize,
    );
    expect(Math.abs(renderedPortCenterY(b) - renderedPortCenterY(a))).toBeGreaterThanOrEqual(
      diagramSizing.gridSize * 2,
    );
  });

  it('uses fixed grid-aligned ALU port centers for routing', async () => {
    const aluGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'alu',
              kind: 'alu',
              label: '',
              metadata: { operation: '+' },
              ports: [
                { id: 'lhs', name: 'lhs', direction: 'input' },
                { id: 'rhs', name: 'rhs', direction: 'input' },
                { id: 'out', name: 'y', direction: 'output' },
              ],
            },
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'a', name: 'a', direction: 'input' }],
            },
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'b', name: 'b', direction: 'input' }],
            },
            {
              id: 'y',
              kind: 'port',
              label: 'y',
              ports: [{ id: 'y', name: 'y', direction: 'output' }],
            },
          ],
          edges: [
            { id: 'a-alu', source: 'a', sourcePort: 'a', target: 'alu', targetPort: 'lhs' },
            { id: 'b-alu', source: 'b', sourcePort: 'b', target: 'alu', targetPort: 'rhs' },
            { id: 'alu-y', source: 'alu', sourcePort: 'out', target: 'y', targetPort: 'y' },
          ],
        },
      },
    };

    const view = await buildViewModel(aluGraph, 'top', { version: 1, modules: {} });
    const alu = view.nodes.find((node) => node.id === 'alu')!;
    const lhsRoute = view.edges.find((edge) => edge.id === 'a-alu')?.routePoints;
    const rhsRoute = view.edges.find((edge) => edge.id === 'b-alu')?.routePoints;
    const outRoute = view.edges.find((edge) => edge.id === 'alu-y')?.routePoints;

    expect(renderedAluInputCenterY(alu, 0) % diagramSizing.gridSize).toBe(0);
    expect(renderedAluInputCenterY(alu, 1) - renderedAluInputCenterY(alu, 0)).toBe(
      diagramSizing.gridSize * 2,
    );
    expect(lhsRoute?.[lhsRoute.length - 1]).toEqual({
      x: alu.position.x - diagramSizing.edgeLeadLength,
      y: renderedAluInputCenterY(alu, 0),
    });
    expect(rhsRoute?.[rhsRoute.length - 1]).toEqual({
      x: alu.position.x - diagramSizing.edgeLeadLength,
      y: renderedAluInputCenterY(alu, 1),
    });
    expect(outRoute?.[0]).toEqual({
      x: alu.position.x + diagramNodeDimensions(alu).width + diagramSizing.edgeLeadLength,
      y: alu.position.y + diagramNodeDimensions(alu).height / 2,
    });
  });

  it('aligns literal nodes with their output ports for direct assignments', async () => {
    const literalGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'literal',
              kind: 'literal',
              label: "8'h42",
              ports: [{ id: 'y', name: 'y', direction: 'output' }],
            },
            {
              id: 'y',
              kind: 'port',
              label: 'y',
              ports: [{ id: 'y', name: 'y', direction: 'output' }],
            },
          ],
          edges: [
            { id: 'literal-y', source: 'literal', sourcePort: 'y', target: 'y', targetPort: 'y' },
          ],
        },
      },
    };

    const view = await buildViewModel(literalGraph, 'top', { version: 1, modules: {} });
    const literal = view.nodes.find((node) => node.id === 'literal')!;
    const y = view.nodes.find((node) => node.id === 'y')!;

    expect(literal.position.y + diagramNodeDimensions(literal).height / 2).toBe(
      renderedPortCenterY(y),
    );
  });

  it('aligns compact replication nodes with literal inputs and output ports', async () => {
    const replicationGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'literal',
              kind: 'literal',
              label: "1'b1",
              ports: [{ id: 'out', name: "1'b1", direction: 'output' }],
            },
            {
              id: 'rep',
              kind: 'replicate',
              label: 'x4',
              ports: [
                { id: 'in', name: 'in', direction: 'input' },
                { id: 'out', name: 'fill_ones', direction: 'output' },
              ],
            },
            {
              id: 'fill',
              kind: 'port',
              label: 'fill_ones',
              ports: [{ id: 'fill', name: 'fill_ones', direction: 'output' }],
            },
          ],
          edges: [
            {
              id: 'literal-rep',
              source: 'literal',
              sourcePort: 'out',
              target: 'rep',
              targetPort: 'in',
            },
            {
              id: 'rep-fill',
              source: 'rep',
              sourcePort: 'out',
              target: 'fill',
              targetPort: 'fill',
            },
          ],
        },
      },
    };

    const view = await buildViewModel(replicationGraph, 'top', { version: 1, modules: {} });
    const literal = view.nodes.find((node) => node.id === 'literal')!;
    const rep = view.nodes.find((node) => node.id === 'rep')!;
    const fill = view.nodes.find((node) => node.id === 'fill')!;
    const replicateCenterY = rep.position.y + diagramNodeDimensions(rep).height / 2;

    expect(literal.position.y + diagramNodeDimensions(literal).height / 2).toBe(replicateCenterY);
    expect(renderedPortCenterY(fill)).toBe(replicateCenterY);
  });

  it('aligns bus breakout output ports with their rendered tap rows', async () => {
    const busGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'bus',
              kind: 'bus',
              label: 'instr',
              ports: [
                { id: 'in', name: 'instr', direction: 'input' },
                { id: 'opcode', name: 'instr[6:0]', direction: 'output' },
                { id: 'flag', name: 'instr[30]', direction: 'output' },
              ],
            },
            {
              id: 'instr',
              kind: 'port',
              label: 'instr',
              ports: [{ id: 'instr', name: 'instr', direction: 'input' }],
            },
            {
              id: 'opcode',
              kind: 'port',
              label: 'opcode',
              ports: [{ id: 'opcode', name: 'opcode', direction: 'output' }],
            },
            {
              id: 'flag',
              kind: 'port',
              label: 'flag',
              ports: [{ id: 'flag', name: 'flag', direction: 'output' }],
            },
          ],
          edges: [
            {
              id: 'instr-bus',
              source: 'instr',
              sourcePort: 'instr',
              target: 'bus',
              targetPort: 'in',
            },
            {
              id: 'bus-opcode',
              source: 'bus',
              sourcePort: 'opcode',
              target: 'opcode',
              targetPort: 'opcode',
            },
            {
              id: 'bus-flag',
              source: 'bus',
              sourcePort: 'flag',
              target: 'flag',
              targetPort: 'flag',
            },
          ],
        },
      },
    };

    const view = await buildViewModel(busGraph, 'top', { version: 1, modules: {} });
    const bus = view.nodes.find((node) => node.id === 'bus')!;
    const opcode = view.nodes.find((node) => node.id === 'opcode')!;
    const flag = view.nodes.find((node) => node.id === 'flag')!;

    expect(renderedPortCenterY(opcode)).toBe(renderedBusTapCenterY(bus, 0));
    expect(renderedPortCenterY(flag)).toBe(renderedBusTapCenterY(bus, 1));
  });

  it('routes non-fixed seeded layouts against final ELK node positions', async () => {
    const seededGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'comb',
              kind: 'comb',
              label: '',
              ports: [
                { id: 'out', name: 'decoded', direction: 'output' },
                { id: 'a', name: 'a', direction: 'input' },
                { id: 'b', name: 'b', direction: 'input' },
              ],
            },
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'a', name: 'a', direction: 'input' }],
            },
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'b', name: 'b', direction: 'input' }],
            },
            {
              id: 'decoded',
              kind: 'port',
              label: 'decoded',
              ports: [{ id: 'decoded', name: 'decoded', direction: 'output' }],
            },
          ],
          edges: [
            { id: 'a-comb', source: 'a', sourcePort: 'a', target: 'comb', targetPort: 'a' },
            { id: 'b-comb', source: 'b', sourcePort: 'b', target: 'comb', targetPort: 'b' },
            {
              id: 'comb-decoded',
              source: 'comb',
              sourcePort: 'out',
              target: 'decoded',
              targetPort: 'decoded',
            },
          ],
        },
      },
    };
    const seededLayout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            comb: { x: 240, y: 96 },
            a: { x: 48, y: 96 },
            b: { x: 48, y: 144 },
            decoded: { x: 480, y: 96 },
          },
        },
      },
    };

    const view = await buildViewModel(seededGraph, 'top', seededLayout);
    const a = view.nodes.find((node) => node.id === 'a')!;
    const comb = view.nodes.find((node) => node.id === 'comb')!;
    const edge = view.edges.find((candidate) => candidate.id === 'a-comb')!;
    const targetLead = edge.routePoints?.[edge.routePoints.length - 1];
    const beforeTargetLead = edge.routePoints?.[edge.routePoints.length - 2];

    expect(edge.routePoints?.[0]).toMatchObject({
      x: a.position.x + diagramNodeDimensions(a).width + diagramSizing.edgeLeadLength,
      y: renderedPortCenterY(a),
    });
    expect(targetLead).toEqual({
      x: comb.position.x - diagramSizing.edgeLeadLength,
      y: renderedNodeInputCenterY(comb, 0),
    });
    expect(beforeTargetLead?.y).toBe(targetLead?.y);
    expect(beforeTargetLead?.x).toBeLessThan(targetLead!.x);
  });

  it(
    'preserves explicit seeded positions for ' + 'existing nodes when new nodes appear later',
    async () => {
      const initialView = await buildViewModel(graph, 'top', { version: 1, modules: {} });
      initialView.nodes.forEach((n) => (n.fixed = true));
      const seeded = mergeNodePositions({ version: 1, modules: {} }, 'top', initialView.nodes);
      const expandedGraph: DesignGraph = {
        ...graph,
        modules: {
          top: {
            ...graph.modules.top,
            nodes: [
              ...graph.modules.top.nodes,
              { id: 'new', kind: 'mux', label: 'new', ports: [] },
            ],
          },
        },
      };

      const expandedView = await buildViewModel(expandedGraph, 'top', seeded);

      expect(expandedView.nodes.find((node) => node.id === 'a')?.position).toEqual({
        x: seeded.modules.top.nodes.a.x,
        y: seeded.modules.top.nodes.a.y,
      });
      expect(expandedView.nodes.find((node) => node.id === 'u')?.position).toEqual({
        x: seeded.modules.top.nodes.u.x,
        y: seeded.modules.top.nodes.u.y,
      });
      expect(expandedView.nodes.find((node) => node.id === 'new')?.position).toBeDefined();
    },
  );

  it('places renamed connected nodes with graph context instead of near the origin', async () => {
    const connectedGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            { id: 'input', kind: 'port', label: 'input', ports: [] },
            { id: 'old_reg', kind: 'register', label: 'old_reg', ports: [] },
            { id: 'sink', kind: 'instance', label: 'sink', ports: [] },
          ],
          edges: [
            { id: 'input-new', source: 'input', target: 'new_reg' },
            { id: 'new-sink', source: 'new_reg', target: 'sink' },
          ],
        },
      },
    };
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            input: { x: 500, y: 500, fixed: true },
            sink: { x: 900, y: 500, fixed: true },
            old_reg: { x: 700, y: 500, stale: true, fixed: true },
          },
        },
      },
    };
    connectedGraph.modules.top.nodes[1] = {
      id: 'new_reg',
      kind: 'register',
      label: 'new_reg',
      ports: [],
    };

    const view = await buildViewModel(connectedGraph, 'top', layout);
    const newReg = view.nodes.find((node) => node.id === 'new_reg');

    expect(view.nodes.find((node) => node.id === 'input')?.position).toEqual({ x: 504, y: 492 });
    expect(view.nodes.find((node) => node.id === 'sink')?.position).toEqual({ x: 912, y: 504 });
    expect(newReg?.position.x).toBeGreaterThan(100);
    expect(newReg?.position.y).toBeGreaterThanOrEqual(0);
  });

  it('keeps a renamed register in the ELK layer between its input and output ports', async () => {
    const before: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'port:top:clk',
              kind: 'port',
              label: 'clk',
              ports: [{ id: 'clk', name: 'clk', direction: 'input' }],
            },
            {
              id: 'port:top:d',
              kind: 'port',
              label: 'd',
              ports: [{ id: 'd', name: 'd', direction: 'input' }],
            },
            {
              id: 'port:top:q',
              kind: 'port',
              label: 'q',
              ports: [{ id: 'q', name: 'q', direction: 'output' }],
            },
            {
              id: 'reg:top:q',
              kind: 'register',
              label: 'q',
              ports: [
                { id: 'd', name: 'D', direction: 'input' },
                { id: 'clk', name: 'clk', direction: 'input' },
                { id: 'q', name: 'Q', direction: 'output' },
              ],
              metadata: { clockSignal: 'clk' },
            },
          ],
          edges: [
            {
              id: 'd-q',
              source: 'port:top:d',
              sourcePort: 'd',
              target: 'reg:top:q',
              targetPort: 'd',
            },
            {
              id: 'clk-q',
              source: 'port:top:clk',
              sourcePort: 'clk',
              target: 'reg:top:q',
              targetPort: 'clk',
            },
            {
              id: 'q-out',
              source: 'reg:top:q',
              sourcePort: 'q',
              target: 'port:top:q',
              targetPort: 'q',
            },
          ],
        },
      },
    };
    const initialView = await buildViewModel(before, 'top', { version: 1, modules: {} });
    const seededLayout = mergeNodePositions({ version: 1, modules: {} }, 'top', initialView.nodes);
    const after: DesignGraph = {
      ...before,
      modules: {
        top: {
          ...before.modules.top,
          nodes: before.modules.top.nodes.map((node) => {
            if (node.id === 'port:top:q') {
              return {
                ...node,
                id: 'port:top:q_new',
                label: 'q_new',
                ports: [{ id: 'q_new', name: 'q_new', direction: 'output' }],
              };
            }
            if (node.id === 'reg:top:q') {
              return { ...node, id: 'reg:top:q_new', label: 'q_new' };
            }
            return node;
          }),
          edges: [
            {
              id: 'd-q-new',
              source: 'port:top:d',
              sourcePort: 'd',
              target: 'reg:top:q_new',
              targetPort: 'd',
            },
            {
              id: 'clk-q-new',
              source: 'port:top:clk',
              sourcePort: 'clk',
              target: 'reg:top:q_new',
              targetPort: 'clk',
            },
            {
              id: 'q-new-out',
              source: 'reg:top:q_new',
              sourcePort: 'q',
              target: 'port:top:q_new',
              targetPort: 'q_new',
            },
          ],
        },
      },
    };

    const view = await buildViewModel(after, 'top', seededLayout);
    const d = view.nodes.find((node) => node.id === 'port:top:d')!;
    const qNew = view.nodes.find((node) => node.id === 'port:top:q_new')!;
    const reg = view.nodes.find((node) => node.id === 'reg:top:q_new')!;

    expect(reg.position.x).toBeGreaterThan(d.position.x);
    expect(reg.position.x).toBeLessThan(qNew.position.x);
    expect(reg.position.x).toBeGreaterThanOrEqual(diagramSizing.gridSize * 10);
  });

  it('keeps pre-arranged nodes stable when adding and removing a ccc-fed register', async () => {
    const baseGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            { id: 'port:top:ccc', kind: 'port', label: 'ccc', ports: [] },
            { id: 'port:top:clk', kind: 'port', label: 'clk', ports: [] },
            { id: 'reg:top:c_q', kind: 'register', label: 'c_q', ports: [] },
            { id: 'mux:top:y:sel', kind: 'mux', label: 'case sel', ports: [] },
          ],
          edges: [
            { id: 'ccc-cq', source: 'port:top:ccc', target: 'reg:top:c_q' },
            { id: 'clk-cq', source: 'port:top:clk', target: 'reg:top:c_q' },
          ],
        },
      },
    };
    const arrangedLayout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            'port:top:ccc': { x: 192, y: 732, fixed: true },
            'port:top:clk': { x: 192, y: 564, fixed: true },
            'reg:top:c_q': { x: 528, y: 696, fixed: true },
            'mux:top:y:sel': { x: 528, y: 312, fixed: true },
          },
        },
      },
    };
    const expandedGraph: DesignGraph = {
      ...baseGraph,
      modules: {
        top: {
          ...baseGraph.modules.top,
          nodes: [
            ...baseGraph.modules.top.nodes,
            { id: 'reg:top:cc_q', kind: 'register', label: 'cc_q', ports: [] },
          ],
          edges: [
            ...baseGraph.modules.top.edges,
            { id: 'ccc-ccq', source: 'port:top:ccc', target: 'reg:top:cc_q' },
            { id: 'clk-ccq', source: 'port:top:clk', target: 'reg:top:cc_q' },
          ],
        },
      },
    };

    const expandedView = await buildViewModel(expandedGraph, 'top', arrangedLayout);
    const expandedLayout = mergeNodePositions(arrangedLayout, 'top', expandedView.nodes);
    const collapsedView = await buildViewModel(baseGraph, 'top', expandedLayout);

    for (const [id, expected] of Object.entries(arrangedLayout.modules.top.nodes)) {
      expect(expandedView.nodes.find((node) => node.id === id)?.position).toEqual({
        x: expected.x,
        y: expected.y,
      });
      expect(collapsedView.nodes.find((node) => node.id === id)?.position).toEqual({
        x: expected.x,
        y: expected.y,
      });
    }
    expect(expandedView.nodes.some((node) => node.id === 'reg:top:cc_q')).toBe(true);
    expect(collapsedView.nodes.some((node) => node.id === 'reg:top:cc_q')).toBe(false);
  });

  it('respects port order during auto-layout to avoid wire crossings', async () => {
    // a connects to port0 (top), b connects to port1 (bottom)
    // If ELK respects order, 'a' should be above 'b'.
    const orderedGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'p_a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'out', name: 'out', direction: 'output' }],
            },
            {
              id: 'p_b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'out', name: 'out', direction: 'output' }],
            },
            {
              id: 'c',
              kind: 'comb',
              label: 'comb',
              ports: [
                { id: 'in_a', name: 'a', direction: 'input' },
                { id: 'in_b', name: 'b', direction: 'input' },
              ],
            },
          ],
          edges: [
            { id: 'e_a', source: 'p_a', target: 'c', sourcePort: 'out', targetPort: 'in_a' },
            { id: 'e_b', source: 'p_b', target: 'c', sourcePort: 'out', targetPort: 'in_b' },
          ],
        },
      },
    };

    const view = await buildViewModel(orderedGraph, 'top', { version: 1, modules: {} });
    const posA = view.nodes.find((n) => n.id === 'p_a')!.position;
    const posB = view.nodes.find((n) => n.id === 'p_b')!.position;

    // 'a' should be above 'b'
    expect(posA.y).toBeLessThan(posB.y);
  });

  it('allows auto-layout to move previously positioned nodes if they are not fixed', async () => {
    const initialGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'out', name: 'out', direction: 'input' }],
            },
            {
              id: 'y',
              kind: 'port',
              label: 'y',
              ports: [{ id: 'in', name: 'in', direction: 'output' }],
            },
          ],
          edges: [{ id: 'a-y', source: 'a', target: 'y', sourcePort: 'out', targetPort: 'in' }],
        },
      },
    };

    const initialView = await buildViewModel(initialGraph, 'top', { version: 1, modules: {} });
    const originalYPos = initialView.nodes.find((n) => n.id === 'y')!.position.x;
    const layout = mergeNodePositions({ version: 1, modules: {} }, 'top', initialView.nodes);

    // Node 'a' should NOT be in the layout because it's not fixed
    expect(layout.modules.top.nodes['a']).toBeUndefined();

    const expandedGraph: DesignGraph = {
      ...initialGraph,
      modules: {
        top: {
          ...initialGraph.modules.top,
          nodes: [
            ...initialGraph.modules.top.nodes,
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'out', name: 'out', direction: 'output' }],
            },
            {
              id: 'c',
              kind: 'comb',
              label: 'comb',
              ports: [
                { id: 'in_a', name: 'in_a', direction: 'input' },
                { id: 'in_b', name: 'in_b', direction: 'input' },
                { id: 'out_y', name: 'out_y', direction: 'output' },
              ],
            },
          ],
          edges: [
            { id: 'a-c', source: 'a', target: 'c', sourcePort: 'out', targetPort: 'in_a' },
            { id: 'b-c', source: 'b', target: 'c', sourcePort: 'out', targetPort: 'in_b' },
            { id: 'c-y', source: 'c', target: 'y', sourcePort: 'out_y', targetPort: 'in' },
          ],
        },
      },
    };

    const expandedView = await buildViewModel(expandedGraph, 'top', layout);
    const newYPos = expandedView.nodes.find((node) => node.id === 'y')?.position.x;

    expect(newYPos).toBeGreaterThan(originalYPos!);
  });
  it('prevents auto-layout from moving nodes that are explicitly fixed', async () => {
    const initialGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'a',
              kind: 'port',
              label: 'a',
              ports: [{ id: 'out', name: 'out', direction: 'input' }],
            },
            {
              id: 'y',
              kind: 'port',
              label: 'y',
              ports: [{ id: 'in', name: 'in', direction: 'output' }],
            },
          ],
          edges: [{ id: 'a-y', source: 'a', target: 'y', sourcePort: 'out', targetPort: 'in' }],
        },
      },
    };

    const initialView = await buildViewModel(initialGraph, 'top', { version: 1, modules: {} });
    initialView.nodes.find((n) => n.id === 'y')!.fixed = true;
    const layout = mergeNodePositions({ version: 1, modules: {} }, 'top', initialView.nodes);

    expect(layout.modules.top.nodes['y'].fixed).toBe(true);
    const originalYPos = layout.modules.top.nodes['y'].x;

    const expandedGraph: DesignGraph = {
      ...initialGraph,
      modules: {
        top: {
          ...initialGraph.modules.top,
          nodes: [
            ...initialGraph.modules.top.nodes,
            {
              id: 'b',
              kind: 'port',
              label: 'b',
              ports: [{ id: 'out', name: 'out', direction: 'output' }],
            },
            {
              id: 'c',
              kind: 'comb',
              label: 'comb',
              ports: [
                { id: 'in_a', name: 'in_a', direction: 'input' },
                { id: 'in_b', name: 'in_b', direction: 'input' },
                { id: 'out_y', name: 'out_y', direction: 'output' },
              ],
            },
          ],
          edges: [
            { id: 'a-c', source: 'a', target: 'c', sourcePort: 'out', targetPort: 'in_a' },
            { id: 'b-c', source: 'b', target: 'c', sourcePort: 'out', targetPort: 'in_b' },
            { id: 'c-y', source: 'c', target: 'y', sourcePort: 'out_y', targetPort: 'in' },
          ],
        },
      },
    };

    const expandedView = await buildViewModel(expandedGraph, 'top', layout);
    const newYPos = expandedView.nodes.find((node) => node.id === 'y')?.position.x;

    expect(newYPos).toBe(originalYPos!);
  });

  it(
    'gives stacked mux nodes enough bottom margin so ' +
      'backward edges clear the visual back-layer overhang',
    async () => {
      // The back layer of a stacked node is rendered ARRAY_STACK_LANE_OFFSET (4 px) below the
      // logical node boundary.  ELK routes edges outside ELK-node boundaries; the ELK node
      // bottom = logical_bottom + bottom_margin.  If bottom_margin == 4 == ARRAY_STACK_LANE_OFFSET
      // the route sits exactly on the back-layer skin, producing visible overlap.  We need
      // bottom_margin > ARRAY_STACK_LANE_OFFSET so routes clear the skin entirely.
      const ARRAY_STACK_LANE_OFFSET = 4; // mirror of arrayStackGeometry.ts

      // Topology mirrors array_address_write_enable_register:
      //   inputs → write_en mux → addr mux → array register → outputs
      //   array register Q feeds back to write_en mux.false and addr_mux.default
      const stackedFeedbackGraph: DesignGraph = {
        rootModules: ['top'],
        generatedAt: 'now',
        diagnostics: [],
        modules: {
          top: {
            name: 'top',
            file: 'top.sv',
            ports: [],
            nodes: [
              {
                id: 'wen_mux',
                kind: 'mux',
                label: 'if write_en',
                ports: [
                  { id: 'wen_sel', name: 'sel', direction: 'input' },
                  { id: 'wen_true', name: 'true', direction: 'input' },
                  { id: 'wen_false', name: 'false', direction: 'input' },
                  { id: 'wen_out', name: 'out', direction: 'output' },
                ],
                metadata: { isArrayNode: true },
              },
              {
                id: 'addr_mux',
                kind: 'mux',
                label: 'write address',
                ports: [
                  { id: 'addr_sel', name: 'sel', direction: 'input' },
                  { id: 'addr_data', name: "2'b0", direction: 'input' },
                  { id: 'addr_default', name: 'default', direction: 'input' },
                  { id: 'addr_out', name: 'out', direction: 'output' },
                ],
                metadata: { isArrayNode: true },
              },
              {
                id: 'reg',
                kind: 'register',
                label: 'storage',
                ports: [
                  { id: 'reg_d', name: 'D', direction: 'input' },
                  { id: 'reg_clk', name: 'clk', direction: 'input' },
                  { id: 'reg_q', name: 'Q', direction: 'output' },
                ],
                metadata: { isArrayNode: true, clockSignal: 'clk' },
              },
            ],
            edges: [
              {
                id: 'wen-addr',
                source: 'wen_mux',
                sourcePort: 'wen_out',
                target: 'addr_mux',
                targetPort: 'addr_data',
              },
              {
                id: 'addr-reg',
                source: 'addr_mux',
                sourcePort: 'addr_out',
                target: 'reg',
                targetPort: 'reg_d',
              },
              // Backward feedback edges: reg Q drives both mux hold inputs
              {
                id: 'reg-wen-fb',
                source: 'reg',
                sourcePort: 'reg_q',
                target: 'wen_mux',
                targetPort: 'wen_false',
              },
              {
                id: 'reg-addr-fb',
                source: 'reg',
                sourcePort: 'reg_q',
                target: 'addr_mux',
                targetPort: 'addr_default',
              },
            ],
          },
        },
      };

      const view = await buildViewModel(stackedFeedbackGraph, 'top', { version: 1, modules: {} });

      const wenMux = view.nodes.find((n) => n.id === 'wen_mux')!;
      const addrMux = view.nodes.find((n) => n.id === 'addr_mux')!;
      expect(wenMux).toBeDefined();
      expect(addrMux).toBeDefined();

      // Any route point that dips below a stacked mux's logical bottom must also clear the
      // back-layer overhang.  With only 4 px bottom margin the route lands exactly at the
      // back-layer skin; with edgeLeadLength margin it lands well below it.
      for (const edge of view.edges) {
        if (!edge.routePoints) continue;
        for (const point of edge.routePoints) {
          for (const mux of [wenMux, addrMux]) {
            const muxLogicalBottom = mux.position.y + diagramNodeDimensions(mux).height;
            if (point.y > muxLogicalBottom) {
              expect(point.y).toBeGreaterThan(muxLogicalBottom + ARRAY_STACK_LANE_OFFSET);
            }
          }
        }
      }
    },
  );

  it('keeps forward register fanout routes from backtracking through blocks', async () => {
    const stackedFanoutGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'wen_mux',
              kind: 'mux',
              label: 'if write_en',
              ports: [
                { id: 'sel', name: 'sel', direction: 'input' },
                { id: 'wen_true', name: 'true', direction: 'input' },
                { id: 'wen_false', name: 'false', direction: 'input' },
                { id: 'out', name: 'out', direction: 'output' },
              ],
              metadata: { isArrayNode: true },
            },
            {
              id: 'addr_mux',
              kind: 'mux',
              label: 'write address',
              ports: [
                { id: 'sel', name: 'sel', direction: 'input' },
                { id: 'addr_data', name: "2'b0", direction: 'input' },
                { id: 'addr_default', name: 'default', direction: 'input' },
                { id: 'out', name: 'out', direction: 'output' },
              ],
              metadata: { isArrayNode: true },
            },
            {
              id: 'reg',
              kind: 'register',
              label: 'storage',
              ports: [
                { id: 'd', name: 'D', direction: 'input' },
                { id: 'q', name: 'Q', direction: 'output' },
                { id: 'clk', name: 'clk', direction: 'input' },
              ],
              metadata: { isArrayNode: true, clockSignal: 'clk' },
            },
            {
              id: 'out_data',
              kind: 'port',
              label: 'out_data',
              ports: [{ id: 'out_data', name: 'out_data', direction: 'output' }],
            },
          ],
          edges: [
            {
              id: 'wen-addr',
              source: 'wen_mux',
              sourcePort: 'out',
              target: 'addr_mux',
              targetPort: 'addr_data',
            },
            {
              id: 'addr-reg',
              source: 'addr_mux',
              sourcePort: 'out',
              target: 'reg',
              targetPort: 'd',
            },
            {
              id: 'reg-out',
              source: 'reg',
              sourcePort: 'q',
              target: 'out_data',
              targetPort: 'out_data',
            },
            {
              id: 'reg-wen-fb',
              source: 'reg',
              sourcePort: 'q',
              target: 'wen_mux',
              targetPort: 'wen_false',
            },
            {
              id: 'reg-addr-fb',
              source: 'reg',
              sourcePort: 'q',
              target: 'addr_mux',
              targetPort: 'addr_default',
            },
          ],
        },
      },
    };

    const view = await buildViewModel(stackedFanoutGraph, 'top', {
      version: 1,
      modules: {
        top: {
          nodes: {
            reg: { x: 360, y: 216, fixed: true },
            wen_mux: { x: 768, y: 120, fixed: true },
            addr_mux: { x: 1128, y: 120, fixed: true },
            out_data: { x: 768, y: 252, fixed: true },
          },
        },
      },
    });

    const reg = view.nodes.find((node) => node.id === 'reg')!;
    const wenMux = view.nodes.find((node) => node.id === 'wen_mux')!;
    const outData = view.nodes.find((node) => node.id === 'out_data')!;
    const qLeadX = reg.position.x + diagramNodeDimensions(reg).width + diagramSizing.edgeLeadLength;

    for (const edge of view.edges.filter((candidate) => candidate.source === 'reg')) {
      expect(edge.routePoints).toBeDefined();
      expect(Math.min(...edge.routePoints!.map((point) => point.x))).toBeGreaterThanOrEqual(qLeadX);
    }

    const addrRoute = view.edges.find((edge) => edge.id === 'reg-addr-fb')!.routePoints!;
    expect(routeCrossesNodeInterior(addrRoute, wenMux)).toBe(false);
    expect(routeCrossesNodeInterior(addrRoute, outData)).toBe(false);
    expect(Math.max(...addrRoute.map((point) => point.y))).toBeGreaterThan(
      outData.position.y + diagramNodeDimensions(outData).height,
    );
  });

  it('keeps source-side fanout stems off the source lead', async () => {
    const fanoutGraph: DesignGraph = {
      rootModules: ['top'],
      generatedAt: 'now',
      diagnostics: [],
      modules: {
        top: {
          name: 'top',
          file: 'top.sv',
          ports: [],
          nodes: [
            {
              id: 'data',
              kind: 'port',
              label: 'data',
              ports: [{ id: 'data', name: 'data', direction: 'input' }],
            },
            {
              id: 'upper',
              kind: 'loop',
              label: 'loop',
              ports: [
                { id: 'in', name: 'in', direction: 'input' },
                { id: 'out', name: 'out', direction: 'output' },
              ],
            },
            {
              id: 'lower',
              kind: 'loop',
              label: 'loop',
              ports: [
                { id: 'in', name: 'in', direction: 'input' },
                { id: 'out', name: 'out', direction: 'output' },
              ],
            },
          ],
          edges: [
            {
              id: 'data-upper',
              source: 'data',
              sourcePort: 'data',
              target: 'upper',
              targetPort: 'in',
            },
            {
              id: 'data-lower',
              source: 'data',
              sourcePort: 'data',
              target: 'lower',
              targetPort: 'in',
            },
          ],
        },
      },
    };

    const view = await buildViewModel(fanoutGraph, 'top', {
      version: 1,
      modules: {
        top: {
          nodes: {
            data: { x: 24, y: 36, fixed: true },
            upper: { x: 408, y: 24, fixed: true },
            lower: { x: 408, y: 144, fixed: true },
          },
        },
      },
    });

    const source = view.nodes.find((node) => node.id === 'data')!;
    const route = view.edges.find((edge) => edge.id === 'data-lower')!.routePoints!;
    const sourceLeadX =
      source.position.x + diagramNodeDimensions(source).width + diagramSizing.edgeLeadLength;

    expect(route[0].x).toBe(sourceLeadX);
    expect(route[1].x).toBeGreaterThan(sourceLeadX);
    expect(route.some((point) => point.x === sourceLeadX && point.y !== route[0].y)).toBe(false);
  });
});

describe('unconditional full-render layout snapshot', () => {
  const chainModule = {
    name: 'top',
    file: 'top.sv',
    ports: [],
    nodes: [
      {
        id: 'a',
        kind: 'port' as const,
        label: 'a',
        ports: [{ id: 'out', name: 'a', direction: 'input' as const }],
      },
      {
        id: 'u',
        kind: 'instance' as const,
        label: 'u',
        ports: [
          { id: 'in', name: 'a', direction: 'input' as const },
          { id: 'out', name: 'y', direction: 'output' as const },
        ],
      },
      {
        id: 'y',
        kind: 'port' as const,
        label: 'y',
        ports: [{ id: 'y', name: 'y', direction: 'output' as const }],
      },
    ],
    edges: [
      {
        id: 'a-u',
        source: 'a',
        sourcePort: 'out',
        target: 'u',
        targetPort: 'in',
        metadata: { declaredNetName: 'a' },
      },
      {
        id: 'u-y',
        source: 'u',
        sourcePort: 'out',
        target: 'y',
        targetPort: 'y',
        metadata: { declaredNetName: 'y' },
      },
    ],
  };
  const chainGraph: DesignGraph = {
    rootModules: ['top'],
    generatedAt: 'now',
    diagnostics: [],
    modules: { top: chainModule },
  };

  it('mergeNodeSnapshot records every position without marking anything fixed', async () => {
    const view = await buildViewModel(chainGraph, 'top', { version: 1, modules: {} });

    const snapshot = mergeNodeSnapshot({ version: 1, modules: {} }, 'top', view.nodes);
    const saved = snapshot.modules.top.nodes;

    for (const node of view.nodes) {
      expect(saved[node.id]).toEqual({
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      });
      expect(saved[node.id].fixed).toBeUndefined();
    }
  });

  it('mergeNodeSnapshot never overwrites an already-pinned node', () => {
    const pinned: SavedLayout = {
      version: 1,
      modules: { top: { nodes: { a: { x: 999, y: 999, fixed: true } } } },
    };

    const snapshot = mergeNodeSnapshot(pinned, 'top', [
      { ...chainModule.nodes[0], fixed: true, position: { x: 1, y: 2 } } as PositionedNode,
    ]);

    expect(snapshot.modules.top.nodes.a).toEqual({ x: 999, y: 999, fixed: true });
  });

  it('mergeNodeSnapshot skips synthetic net-cut label nodes', () => {
    const snapshot = mergeNodeSnapshot({ version: 1, modules: {} }, 'top', [
      {
        ...chainModule.nodes[0],
        position: { x: 10, y: 10 },
      } as PositionedNode,
      {
        id: 'cut-label:a:out:source',
        kind: 'netLabel' as const,
        label: 'a',
        ports: [],
        position: { x: 20, y: 20 },
      } as unknown as PositionedNode,
    ]);

    expect(Object.keys(snapshot.modules.top.nodes)).toEqual(['a']);
  });

  it('mergeEdgeSnapshot records every route into routeSnapshot, not routePoints', async () => {
    const view = await buildViewModel(chainGraph, 'top', { version: 1, modules: {} });

    const snapshot = mergeEdgeSnapshot({ version: 1, modules: {} }, 'top', view.edges);
    const saved = snapshot.modules.top.edges!;

    for (const edge of view.edges) {
      expect(edge.routePoints).toBeDefined();
      expect(saved[edge.id]).toEqual({ routeSnapshot: edge.routePoints });
      expect(saved[edge.id].routePoints).toBeUndefined();
    }
  });

  it('mergeEdgeSnapshot never overwrites a user-fixed routePoints entry', () => {
    const fixed: SavedLayout = {
      version: 1,
      modules: {
        top: { nodes: {}, edges: { 'a-u': { routePoints: [{ x: 1, y: 1 }] } } },
      },
    };

    const snapshot = mergeEdgeSnapshot(fixed, 'top', [
      { ...chainModule.edges[0], routePoints: [{ x: 999, y: 999 }] } as DiagramEdge,
    ]);

    expect(snapshot.modules.top.edges!['a-u']).toEqual({ routePoints: [{ x: 1, y: 1 }] });
  });

  it('mergeEdgeSnapshot skips synthetic cut-stub edges', () => {
    const snapshot = mergeEdgeSnapshot({ version: 1, modules: {} }, 'top', [
      { ...chainModule.edges[0], routePoints: [{ x: 1, y: 1 }] } as DiagramEdge,
      {
        id: 'cut-stub:a:out:source',
        source: 'a',
        target: 'cut-label:a:out:source',
        routePoints: [{ x: 2, y: 2 }],
      } as unknown as DiagramEdge,
    ]);

    expect(Object.keys(snapshot.modules.top.edges!)).toEqual(['a-u']);
  });

  it('a routeSnapshot never excludes its edge from re-routing on the next render', async () => {
    const opened = await buildViewModel(chainGraph, 'top', { version: 1, modules: {} });
    const layout = mergeEdgeSnapshot({ version: 1, modules: {} }, 'top', opened.edges);
    const savedRoute = layout.modules.top.edges!['a-u'].routeSnapshot;
    expect(savedRoute).toBeDefined();

    // A routeSnapshot must not be treated like a fixed routePoints entry: the
    // edge stays a normal re-routing candidate on the next render, and its
    // freshly-computed route (not the stale snapshot) wins.
    const rerendered = await buildViewModel(chainGraph, 'top', layout);
    const edge = rerendered.edges.find((candidate) => candidate.id === 'a-u')!;
    const freshRoute = opened.edges.find((candidate) => candidate.id === 'a-u')!.routePoints;
    expect(edge.routePoints).toEqual(freshRoute);
  });

  it('markFirstOpenHandled sets the flag once and is idempotent', () => {
    const empty: SavedLayout = { version: 1, modules: {} };
    const handled = markFirstOpenHandled(empty, 'top');
    expect(handled.modules.top.firstOpenHandled).toBe(true);

    const handledAgain = markFirstOpenHandled(handled, 'top');
    expect(handledAgain).toBe(handled);
  });

  it(
    "a full-render snapshot doesn't opt an untouched module out of the " +
      'pristine "free preset" columnizing once the module reopens',
    async () => {
      const cutEdges = firstOpenAutoCutEdges(chainModule, true);
      const firstOpenLayout = mergeFirstOpenNetCuts(
        { version: 1, modules: {} },
        'top',
        cutEdges,
        chainModule,
      );

      const firstRender = await buildViewModel(chainGraph, 'top', firstOpenLayout);
      // Simulate the per-render durability write: nothing was dragged, but the
      // resolved positions get snapshotted into moduleLayout.nodes anyway.
      const persistedAfterRender = mergeNodeSnapshot(firstOpenLayout, 'top', firstRender.nodes);
      expect(Object.keys(persistedAfterRender.modules.top.nodes).length).toBeGreaterThan(0);

      // Reopening the module ("reload") must still treat it as pristine —
      // isPristineLayout has to key off `fixed`, not off `nodes` being empty.
      const secondRender = await buildViewModel(chainGraph, 'top', persistedAfterRender);
      const before = new Map(firstRender.nodes.map((node) => [node.id, node.position]));
      for (const node of secondRender.nodes) {
        expect(node.position).toEqual(before.get(node.id));
      }
    },
  );

  it('layout state (auto positions and a manual edit) survives a reload from disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svsch-test-'));
    try {
      // "Open the diagram": render once with nothing saved yet.
      const opened = await buildViewModel(chainGraph, 'top', { version: 1, modules: {} });
      let layout = mergeNodeSnapshot({ version: 1, modules: {} }, 'top', opened.nodes);

      // "Mutate layout": the user drags node 'u' to an explicit position.
      // mergeNodePositions (the existing, unchanged interactive-edit path)
      // only ever persists pinned nodes, so this alone drops the other,
      // untouched nodes' snapshot entries again — that's expected and fine,
      // since those nodes are still trivially recoverable via Auto Layout.
      const draggedU = opened.nodes.map((node) =>
        node.id === 'u' ? { ...node, position: { x: 768, y: 552 }, fixed: true } : node,
      );
      layout = mergeNodePositions(layout, 'top', draggedU);

      // The diagram renders again at some point after the drag (switching
      // tabs, a rebuild, simply reopening later) — that's the render-driven
      // safety net restoring full coverage on top of the manual edit.
      const rerendered = await buildViewModel(chainGraph, 'top', layout);
      layout = mergeNodeSnapshot(layout, 'top', rerendered.nodes);

      const store = new LayoutStore(tmpDir);
      await store.writeModuleLayout('top', layout.modules.top);
      await store.flush();

      // "Reload": a fresh store instance reading straight from disk, as a new
      // session would.
      const reloadedStore = new LayoutStore(tmpDir);
      const reloadedModuleLayout = await reloadedStore.readModuleLayout('top');
      const reloadedLayout: SavedLayout = { version: 1, modules: { top: reloadedModuleLayout } };

      // The manual pin survived exactly.
      expect(reloadedModuleLayout.nodes.u).toEqual({ x: 768, y: 552, fixed: true });

      // The auto-placed port node — never dragged — also survived, because
      // the full-render snapshot wrote it, not just the manual edit.
      const aBefore = rerendered.nodes.find((node) => node.id === 'a')!.position;
      expect(reloadedModuleLayout.nodes.a).toEqual({
        x: Math.round(aBefore.x),
        y: Math.round(aBefore.y),
      });

      const reopened = await buildViewModel(chainGraph, 'top', reloadedLayout);
      expect(reopened.nodes.find((node) => node.id === 'u')!.position).toEqual({ x: 768, y: 552 });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
