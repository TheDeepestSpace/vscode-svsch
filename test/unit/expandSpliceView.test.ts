import { AvoidLib } from 'libavoid-js';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  DesignCallable,
  DesignGraph,
  DesignModule,
  DiagramPort,
  InstanceDiagramNode,
} from '../../src/ir/types';
import { applyExpandedInstances } from '../../src/layout/expandSpliceView';
import { setLibavoidRuntimeForTests } from '../../src/layout/libavoidRouter';
import { buildViewModel } from '../../src/layout/mergeLayout';
import { edgeNetKey } from '../../src/ir/edgeNet';
import type { SavedLayout } from '../../src/storage/layoutStore';

beforeAll(async () => {
  await AvoidLib.load();
  setLibavoidRuntimeForTests(AvoidLib.getInstance());
});

const innerAPort: DiagramPort = { id: 'p:a', name: 'a', direction: 'input' };
const innerYPort: DiagramPort = { id: 'p:y', name: 'y', direction: 'output' };

const innerModule: DesignModule = {
  name: 'inner',
  file: 'inner.sv',
  ports: [innerAPort, innerYPort],
  nodes: [
    { id: 'port:a', kind: 'port', label: 'a', ports: [innerAPort] },
    { id: 'port:y', kind: 'port', label: 'y', ports: [innerYPort] },
    {
      id: 'comb1',
      kind: 'comb',
      label: 'comb1',
      ports: [
        { id: 'in', name: 'in', direction: 'input' },
        { id: 'out', name: 'out', direction: 'output' },
      ],
    },
  ],
  edges: [
    { id: 'e-a-comb1', source: 'port:a', target: 'comb1', sourcePort: 'p:a', targetPort: 'in' },
    { id: 'e-comb1-y', source: 'comb1', target: 'port:y', sourcePort: 'out', targetPort: 'p:y' },
  ],
};

const u1Node: InstanceDiagramNode = {
  id: 'u1',
  kind: 'instance',
  label: 'u1',
  moduleName: 'inner',
  ports: [
    { id: 'u1:a', name: 'a', direction: 'input' },
    { id: 'u1:y', name: 'y', direction: 'output' },
  ],
};

const topAPort: DiagramPort = { id: 'p:top-a', name: 'a', direction: 'input' };
const topYPort: DiagramPort = { id: 'p:top-y', name: 'y', direction: 'output' };

const topModule: DesignModule = {
  name: 'top',
  file: 'top.sv',
  ports: [topAPort, topYPort],
  nodes: [
    { id: 'port:top:a', kind: 'port', label: 'a', ports: [topAPort] },
    { id: 'port:top:y', kind: 'port', label: 'y', ports: [topYPort] },
    u1Node,
  ],
  edges: [
    {
      id: 'e-top-a-u1',
      source: 'port:top:a',
      target: 'u1',
      sourcePort: 'p:top-a',
      targetPort: 'u1:a',
    },
    {
      id: 'e-u1-top-y',
      source: 'u1',
      target: 'port:top:y',
      sourcePort: 'u1:y',
      targetPort: 'p:top-y',
    },
  ],
};

const graph: DesignGraph = {
  rootModules: ['top'],
  modules: { top: topModule, inner: innerModule },
  diagnostics: [],
  generatedAt: 'test',
};

function layoutWithExpandedU1(): SavedLayout {
  return { version: 1, modules: { top: { nodes: {}, expanded: { u1: true } } } };
}

describe('applyExpandedInstances', () => {
  it('leaves the view untouched when nothing is flagged expanded', async () => {
    const layout: SavedLayout = { version: 1, modules: {} };
    const view = await buildViewModel(graph, 'top', layout);
    const result = await applyExpandedInstances({
      graph,
      layout,
      view,
    });
    expect(result).toBe(view);
  });

  it('splices the boundary/internal nodes and edges of an expanded instance', async () => {
    const layout = layoutWithExpandedU1();
    const view = await buildViewModel(graph, 'top', layout);
    const result = await applyExpandedInstances({
      graph,
      layout,
      view,
    });

    const boundaryNodes = result.nodes.filter((node) => node.kind === 'boundaryPort');
    expect(boundaryNodes.map((node) => node.id).sort()).toEqual([
      'expand:u1::port:a',
      'expand:u1::port:y',
    ]);

    const internal = result.nodes.find((node) => node.id === 'expand:u1::comb1');
    expect(internal).toBeDefined();

    const region = result.generateRegions?.find((r) => r.kind === 'expand');
    expect(region).toBeDefined();
    expect(region!.expandedInstance).toEqual({
      instanceId: 'u1',
      childModuleName: 'inner',
      parentModuleName: 'top',
    });
    expect(region!.nodeIds).toEqual(
      expect.arrayContaining([...boundaryNodes.map((n) => n.id), 'expand:u1::comb1']),
    );
  });

  it('dims the instance node into a ghost, grown to contain the spliced content', async () => {
    const layout = layoutWithExpandedU1();
    const view = await buildViewModel(graph, 'top', layout);
    const result = await applyExpandedInstances({
      graph,
      layout,
      view,
    });

    const ghost = result.nodes.find((node) => node.id === 'u1')!;
    expect(ghost.metadata?.expandGhost).toBeDefined();
    expect(ghost.sizeOverride).toBeDefined();
    expect(ghost.sizeOverride!.width).toBeGreaterThan(0);
    expect(ghost.sizeOverride!.height).toBeGreaterThan(0);
  });

  it("rewires the parent's edges off the instance onto the matching boundary node", async () => {
    const layout = layoutWithExpandedU1();
    const view = await buildViewModel(graph, 'top', layout);
    const result = await applyExpandedInstances({
      graph,
      layout,
      view,
    });

    const inbound = result.edges.find((edge) => edge.id === 'e-top-a-u1')!;
    expect(inbound.target).toBe('expand:u1::port:a');
    expect(inbound.targetPort).toBe('outer');
    expect(inbound.routePoints).toBeDefined();

    const outbound = result.edges.find((edge) => edge.id === 'e-u1-top-y')!;
    expect(outbound.source).toBe('expand:u1::port:y');
    expect(outbound.sourcePort).toBe('outer');
  });

  it('keeps an expanded-size obstacle route on a rewired cut stub', async () => {
    const cutEdge = topModule.edges[0];
    const netKey = edgeNetKey(cutEdge);
    const sinkLabelId = `cut-label:${netKey}:sink:${cutEdge.id}`;
    const sinkStubId = `cut-stub:${netKey}:sink:${cutEdge.id}`;
    const staleStraightRoute = [
      { x: 1_296, y: 24 },
      { x: 216, y: 24 },
    ];
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            'port:top:a': { x: 0, y: 0, fixed: true },
            u1: { x: 240, y: 0, fixed: true },
            // Pin the dangling sink beyond the instance's far side: once u1
            // expands, a default straight stub would cut through its frame.
            [sinkLabelId]: { x: 1_200, y: 0, fixed: true },
          },
          expanded: { u1: true },
          netCuts: {
            [netKey]: {
              label: 'a',
              source: { nodeId: cutEdge.source, portId: cutEdge.sourcePort },
            },
          },
          edges: { [sinkStubId]: { routePoints: staleStraightRoute } },
        },
      },
    };
    const base = await buildViewModel(graph, 'top', layout);
    const result = await applyExpandedInstances({ graph, layout, view: base });
    const sinkStub = result.edges.find(
      (edge) =>
        edge.metadata?.cutStub?.role === 'sink' &&
        edge.metadata.cutStub.originalEdgeId === cutEdge.id,
    );

    expect(sinkStub?.target).toBe('expand:u1::port:a');
    expect(sinkStub?.routePoints).toBeDefined();
    expect(sinkStub!.routePoints!.length).toBeGreaterThan(1);
    expect(sinkStub?.routePoints).not.toEqual(staleStraightRoute);
  });
});

const functionBody: DesignCallable = {
  name: 'function_top.foo',
  file: 'function_top.sv',
  parentModule: 'function_top',
  callableName: 'foo',
  callableKind: 'function',
  ports: [
    { id: 'lhs', name: 'lhs', direction: 'input', width: '[7:0]' },
    { id: 'rhs', name: 'rhs', direction: 'input', width: '[7:0]' },
    { id: 'foo', name: 'foo', direction: 'output', width: '[7:0]' },
  ],
  nodes: [
    {
      id: 'port:lhs',
      kind: 'port',
      label: 'lhs',
      ports: [{ id: 'lhs', name: 'lhs', direction: 'input', width: '[7:0]' }],
    },
    {
      id: 'port:rhs',
      kind: 'port',
      label: 'rhs',
      ports: [{ id: 'rhs', name: 'rhs', direction: 'input', width: '[7:0]' }],
    },
    {
      id: 'port:foo',
      kind: 'port',
      label: 'foo',
      ports: [{ id: 'foo', name: 'foo', direction: 'output', width: '[7:0]' }],
    },
    {
      id: 'add',
      kind: 'alu',
      label: '+',
      operation: '+',
      ports: [
        { id: 'add:lhs', name: 'lhs', direction: 'input', width: '[7:0]' },
        { id: 'add:rhs', name: 'rhs', direction: 'input', width: '[7:0]' },
        { id: 'add:foo', name: 'foo', direction: 'output', width: '[7:0]' },
      ],
    },
  ],
  edges: [
    { id: 'lhs-add', source: 'port:lhs', target: 'add', sourcePort: 'lhs', targetPort: 'add:lhs' },
    { id: 'rhs-add', source: 'port:rhs', target: 'add', sourcePort: 'rhs', targetPort: 'add:rhs' },
    { id: 'add-foo', source: 'add', target: 'port:foo', sourcePort: 'add:foo', targetPort: 'foo' },
  ],
};

const functionCallGraph: DesignGraph = {
  rootModules: ['function_top'],
  generatedAt: 'test',
  diagnostics: [],
  functions: { 'function_top.foo': functionBody },
  tasks: {},
  modules: {
    function_top: {
      name: 'function_top',
      file: 'function_top.sv',
      ports: [
        { id: 'a', name: 'a', direction: 'input', width: '[7:0]' },
        { id: 'b', name: 'b', direction: 'input', width: '[7:0]' },
        { id: 'y', name: 'y', direction: 'output', width: '[7:0]' },
      ],
      nodes: [
        {
          id: 'port:a',
          kind: 'port',
          label: 'a',
          ports: [{ id: 'a', name: 'a', direction: 'input' }],
        },
        {
          id: 'port:b',
          kind: 'port',
          label: 'b',
          ports: [{ id: 'b', name: 'b', direction: 'input' }],
        },
        {
          id: 'port:y',
          kind: 'port',
          label: 'y',
          ports: [{ id: 'y', name: 'y', direction: 'output' }],
        },
        {
          id: 'callFoo:1',
          kind: 'funcCall',
          label: 'foo',
          functionId: 'function_top.foo',
          functionName: 'foo',
          ports: [
            { id: 'call1:lhs', name: 'lhs', direction: 'input', width: '[7:0]' },
            { id: 'call1:rhs', name: 'rhs', direction: 'input', width: '[7:0]' },
            { id: 'call1:foo', name: 'foo', direction: 'output', width: '[7:0]' },
          ],
        },
        {
          id: 'callFoo:2',
          kind: 'funcCall',
          label: 'foo',
          functionId: 'function_top.foo',
          functionName: 'foo',
          ports: [
            { id: 'call2:lhs', name: 'lhs', direction: 'input', width: '[7:0]' },
            { id: 'call2:rhs', name: 'rhs', direction: 'input', width: '[7:0]' },
            { id: 'call2:foo', name: 'foo', direction: 'output', width: '[7:0]' },
          ],
        },
      ],
      edges: [
        {
          id: 'a-call',
          source: 'port:a',
          target: 'callFoo:1',
          sourcePort: 'a',
          targetPort: 'call1:lhs',
        },
        {
          id: 'b-call',
          source: 'port:b',
          target: 'callFoo:1',
          sourcePort: 'b',
          targetPort: 'call1:rhs',
        },
        {
          id: 'call-y',
          source: 'callFoo:1',
          target: 'port:y',
          sourcePort: 'call1:foo',
          targetPort: 'y',
        },
      ],
    },
  },
};

describe('applyExpandedInstances (function calls)', () => {
  it('splices a callable body and persists expansion independently per call-site', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        function_top: {
          nodes: {},
          expandedFunctionCalls: { 'callFoo:1': true },
        },
      },
    };
    const base = await buildViewModel(functionCallGraph, 'function_top', layout);
    const result = await applyExpandedInstances({ graph: functionCallGraph, layout, view: base });

    expect(
      result.nodes.find((node) => node.id === 'callFoo:1')?.metadata?.expandGhost,
    ).toBeDefined();
    expect(
      result.nodes.find((node) => node.id === 'callFoo:2')?.metadata?.expandGhost,
    ).toBeUndefined();
    expect(result.nodes.find((node) => node.id === 'expand:callFoo:1::add')).toBeDefined();
    expect(
      result.generateRegions?.find((region) => region.kind === 'expand')?.expandedFunctionCall,
    ).toEqual({
      callId: 'callFoo:1',
      functionId: 'function_top.foo',
      parentModuleName: 'function_top',
    });
    expect(result.edges.find((edge) => edge.id === 'a-call')?.target).toBe(
      'expand:callFoo:1::port:lhs',
    );
    expect(result.edges.find((edge) => edge.id === 'call-y')?.source).toBe(
      'expand:callFoo:1::port:foo',
    );
  });
});

// Three levels — top instantiates mid (u_mid), mid instantiates leaf
// (u_leaf) — with `u_leaf` flagged expanded in *mid's own* saved layout: the
// spliced sub-diagram must mirror the child module's own diagram, expansions
// included (issue #233). Port names deliberately collide across the levels
// (both mid and leaf expose `a`/`y`) to pin the boundary-map scoping.
const leafModule: DesignModule = {
  name: 'leaf',
  file: 'leaf.sv',
  ports: [
    { id: 'p:a', name: 'a', direction: 'input' },
    { id: 'p:y', name: 'y', direction: 'output' },
  ],
  nodes: [
    {
      id: 'port:a',
      kind: 'port',
      label: 'a',
      ports: [{ id: 'p:a', name: 'a', direction: 'input' }],
    },
    {
      id: 'port:y',
      kind: 'port',
      label: 'y',
      ports: [{ id: 'p:y', name: 'y', direction: 'output' }],
    },
    {
      id: 'lcomb',
      kind: 'comb',
      label: 'lcomb',
      ports: [
        { id: 'in', name: 'in', direction: 'input' },
        { id: 'out', name: 'out', direction: 'output' },
      ],
    },
  ],
  edges: [
    { id: 'e-a-lcomb', source: 'port:a', target: 'lcomb', sourcePort: 'p:a', targetPort: 'in' },
    { id: 'e-lcomb-y', source: 'lcomb', target: 'port:y', sourcePort: 'out', targetPort: 'p:y' },
  ],
};

const midModule: DesignModule = {
  name: 'mid',
  file: 'mid.sv',
  ports: [
    { id: 'p:a', name: 'a', direction: 'input' },
    { id: 'p:y', name: 'y', direction: 'output' },
  ],
  nodes: [
    {
      id: 'port:a',
      kind: 'port',
      label: 'a',
      ports: [{ id: 'p:a', name: 'a', direction: 'input' }],
    },
    {
      id: 'port:y',
      kind: 'port',
      label: 'y',
      ports: [{ id: 'p:y', name: 'y', direction: 'output' }],
    },
    {
      id: 'u_leaf',
      kind: 'instance',
      label: 'u_leaf',
      moduleName: 'leaf',
      ports: [
        { id: 'u_leaf:a', name: 'a', direction: 'input' },
        { id: 'u_leaf:y', name: 'y', direction: 'output' },
      ],
    } satisfies InstanceDiagramNode,
  ],
  edges: [
    {
      id: 'e-a-u_leaf',
      source: 'port:a',
      target: 'u_leaf',
      sourcePort: 'p:a',
      targetPort: 'u_leaf:a',
    },
    {
      id: 'e-u_leaf-y',
      source: 'u_leaf',
      target: 'port:y',
      sourcePort: 'u_leaf:y',
      targetPort: 'p:y',
    },
  ],
};

const nestedTopModule: DesignModule = {
  name: 'top',
  file: 'top.sv',
  ports: [topAPort, topYPort],
  nodes: [
    { id: 'port:top:a', kind: 'port', label: 'a', ports: [topAPort] },
    { id: 'port:top:y', kind: 'port', label: 'y', ports: [topYPort] },
    {
      id: 'u_mid',
      kind: 'instance',
      label: 'u_mid',
      moduleName: 'mid',
      ports: [
        { id: 'u_mid:a', name: 'a', direction: 'input' },
        { id: 'u_mid:y', name: 'y', direction: 'output' },
      ],
    } satisfies InstanceDiagramNode,
  ],
  edges: [
    {
      id: 'e-top-a-u_mid',
      source: 'port:top:a',
      target: 'u_mid',
      sourcePort: 'p:top-a',
      targetPort: 'u_mid:a',
    },
    {
      id: 'e-u_mid-top-y',
      source: 'u_mid',
      target: 'port:top:y',
      sourcePort: 'u_mid:y',
      targetPort: 'p:top-y',
    },
  ],
};

const nestedGraph: DesignGraph = {
  rootModules: ['top'],
  modules: { top: nestedTopModule, mid: midModule, leaf: leafModule },
  diagnostics: [],
  generatedAt: 'test',
};

function nestedLayout(): SavedLayout {
  return {
    version: 1,
    modules: {
      top: { nodes: {}, expanded: { u_mid: true } },
      mid: { nodes: {}, expanded: { u_leaf: true } },
    },
  };
}

describe('applyExpandedInstances (nested inheritance)', () => {
  it("splices the child's own expanded instances too, recursively", async () => {
    const layout = nestedLayout();
    const view = await buildViewModel(nestedGraph, 'top', layout);
    const result = await applyExpandedInstances({ graph: nestedGraph, layout, view });

    // The nested instance rides along as a dimmed ghost inside mid's splice…
    const nestedGhost = result.nodes.find((node) => node.id === 'expand:u_mid::u_leaf')!;
    expect(nestedGhost).toBeDefined();
    expect(nestedGhost.metadata?.expandGhost).toBeDefined();
    expect(nestedGhost.sizeOverride).toBeDefined();

    // …with leaf's content and boundary labels spliced in under it.
    expect(
      result.nodes.find((node) => node.id === 'expand:u_mid::expand:u_leaf::lcomb'),
    ).toBeDefined();
    const nestedBoundaries = result.nodes.filter(
      (node) => node.kind === 'boundaryPort' && node.id.startsWith('expand:u_mid::expand:u_leaf::'),
    );
    expect(nestedBoundaries.map((node) => node.id).sort()).toEqual([
      'expand:u_mid::expand:u_leaf::port:a',
      'expand:u_mid::expand:u_leaf::port:y',
    ]);

    // Leaf's own IO ports collapsed into cut net ends, same as a top-level
    // expand — never raw port nodes inside a splice.
    expect(result.nodes.some((node) => node.kind === 'port' && node.id.includes('u_leaf'))).toBe(
      false,
    );

    // The whole nested chain belongs to the outer region so frame drags
    // carry it rigidly.
    const region = result.generateRegions?.find((r) => r.kind === 'expand')!;
    expect(region.nodeIds).toEqual(
      expect.arrayContaining(['expand:u_mid::u_leaf', 'expand:u_mid::expand:u_leaf::lcomb']),
    );
  });

  it("also carries the child's own nested expand region, not just its outer frame", async () => {
    // Regression test: leaf is expanded two levels down (top -> u_mid ->
    // u_leaf). Both frames must survive in top's own generateRegions — a
    // prior bug dropped everything past the immediate child's frame, so
    // deeply-nested expand outlines silently vanished (e.g. from the
    // minimap, which draws one rect per region).
    const layout = nestedLayout();
    const view = await buildViewModel(nestedGraph, 'top', layout);
    const result = await applyExpandedInstances({ graph: nestedGraph, layout, view });

    const expandRegions = result.generateRegions?.filter((r) => r.kind === 'expand') ?? [];
    expect(expandRegions).toHaveLength(2);

    const leafRegion = expandRegions.find((r) =>
      r.nodeIds.includes('expand:u_mid::expand:u_leaf::lcomb'),
    );
    expect(leafRegion).toBeDefined();
  });

  it("keeps the parent's edges on the outer boundary despite nested name collisions", async () => {
    const layout = nestedLayout();
    const view = await buildViewModel(nestedGraph, 'top', layout);
    const result = await applyExpandedInstances({ graph: nestedGraph, layout, view });

    // mid and leaf both expose ports named `a`/`y`; the parent's wires must
    // land on *mid's* boundary labels, not leaf's nested ones.
    const inbound = result.edges.find((edge) => edge.id === 'e-top-a-u_mid')!;
    expect(inbound.target).toBe('expand:u_mid::port:a');
    const outbound = result.edges.find((edge) => edge.id === 'e-u_mid-top-y')!;
    expect(outbound.source).toBe('expand:u_mid::port:y');
  });

  it('leaves a recursively-instantiated module collapsed instead of looping', async () => {
    const recModule: DesignModule = {
      name: 'rec',
      file: 'rec.sv',
      ports: [],
      nodes: [
        {
          id: 'u_rec',
          kind: 'instance',
          label: 'u_rec',
          moduleName: 'rec',
          ports: [],
        } satisfies InstanceDiagramNode,
        {
          id: 'rcomb',
          kind: 'comb',
          label: 'rcomb',
          ports: [{ id: 'out', name: 'out', direction: 'output' }],
        },
      ],
      edges: [],
    };
    const recGraph: DesignGraph = {
      rootModules: ['rec'],
      modules: { rec: recModule },
      diagnostics: [],
      generatedAt: 'test',
    };
    const layout: SavedLayout = {
      version: 1,
      modules: { rec: { nodes: {}, expanded: { u_rec: true } } },
    };

    const view = await buildViewModel(recGraph, 'rec', layout);
    const result = await applyExpandedInstances({ graph: recGraph, layout, view });

    // The directly-opened diagram still expands its instance one level…
    expect(result.nodes.find((node) => node.id === 'u_rec')?.metadata?.expandGhost).toBeDefined();
    // …but the copy inside the splice stays collapsed: no second-level ids.
    const inner = result.nodes.find((node) => node.id === 'expand:u_rec::u_rec')!;
    expect(inner).toBeDefined();
    expect(inner.metadata?.expandGhost).toBeUndefined();
    expect(result.nodes.some((node) => node.id.startsWith('expand:u_rec::expand:'))).toBe(false);
  });
});
