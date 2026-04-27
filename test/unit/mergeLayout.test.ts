import { describe, expect, it } from 'vitest';
import { buildViewModel, mergeEdgeRoutePoints, mergeEdgeWaypoint, mergeNodePositions } from '../../src/layout/mergeLayout';
import { diagramSizing, ioPortCenterOffset, muxHeightForPortRows, nodeHeightForPortRows, nodePortCenterOffset } from '../../src/diagram/constants';
import type { DesignGraph, PositionedNode } from '../../src/ir/types';
import type { SavedLayout } from '../../src/storage/layoutStore';

const graph: DesignGraph = {
  rootModules: ['top'],
  generatedAt: 'now',
  diagnostics: [],
  modules: {
    top: {
      name: 'top',
      file: 'top.sv',
      ports: [],
      edges: [
        { id: 'e-a-u', source: 'a', target: 'u' }
      ],
      nodes: [
        { id: 'a', kind: 'port', label: 'a', ports: [] },
        { id: 'u', kind: 'instance', label: 'u', ports: [] }
      ]
    }
  }
};

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
    expect(diagramSizing.minNodeSeparation).toBeGreaterThanOrEqual(diagramSizing.edgeLeadLength * 2);
    expect(nodeHeightForPortRows(1)).toBe(diagramSizing.nodeHeight);
    expect(nodeHeightForPortRows(3)).toBe(diagramSizing.gridSize * 5);
    expect(muxHeightForPortRows(3)).toBe(diagramSizing.gridSize * 6);
    expect((muxHeightForPortRows(3) / 2) % diagramSizing.gridSize).toBe(0);
    expect(nodeHeightForPortRows(5) % diagramSizing.gridSize).toBe(0);
    expect(ioPortCenterOffset() % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(0) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(1) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(2) % diagramSizing.gridSize).toBe(0);
  });

  it('preserves saved node positions on the snap grid', async () => {
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            a: { x: 10, y: 20, fixed: true }
          }
        }
      }
    };

    const view = await buildViewModel(graph, 'top', layout);

    expect(view.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 0, y: 24 });
    expect(view.nodes.find((node) => node.id === 'u')?.position).toBeDefined();
  });

  it('snaps initial auto-layout positions before the webview sees them', async () => {
    const view = await buildViewModel(graph, 'top', { version: 1, modules: {} });

    for (const node of view.nodes) {
      expect(node.position.x % diagramSizing.gridSize).toBe(0);
      expect(node.position.y % diagramSizing.gridSize).toBe(0);
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
            auto: { x: 5, y: 6 } // not fixed
          }
        }
      }
    };
    const nodes: PositionedNode[] = [
      { id: 'a', kind: 'port', label: 'a', ports: [], position: { x: 20.2, y: 31.8 }, fixed: true },
      { id: 'b', kind: 'port', label: 'b', ports: [], position: { x: 100, y: 100 } } // not fixed
    ];

    const merged = mergeNodePositions(layout, 'top', nodes);

    expect(merged.modules.top.nodes.old.stale).toBe(true);
    expect(merged.modules.top.nodes.old.fixed).toBe(true);
    expect(merged.modules.top.nodes.a).toEqual({ x: 24, y: 24, fixed: true });
    expect(merged.modules.top.nodes.auto).toBeUndefined(); // auto was not fixed
    expect(merged.modules.top.nodes.b).toBeUndefined(); // b was not fixed
  });

  it('persists edge waypoints and applies them to the view model', async () => {
    const layout = mergeEdgeWaypoint({ version: 1, modules: {} }, 'top', 'e-a-u', { x: 42.4, y: 92.6 });
    const view = await buildViewModel(graph, 'top', layout);

    expect(layout.modules.top.edges?.['e-a-u'].waypoint).toEqual({ x: 42, y: 93 });
    expect(view.edges.find((edge) => edge.id === 'e-a-u')?.waypoint).toEqual({ x: 42, y: 93 });
  });

  it('persists edge route points and applies them to the view model', async () => {
    const layout = mergeEdgeRoutePoints({ version: 1, modules: {} }, 'top', 'e-a-u', [
      { x: 10.2, y: 20.8 },
      { x: 30.1, y: 40.5 }
    ]);
    const view = await buildViewModel(graph, 'top', layout);

    expect(layout.modules.top.edges?.['e-a-u'].routePoints).toEqual([
      { x: 10, y: 21 },
      { x: 30, y: 41 }
    ]);
    expect(view.edges.find((edge) => edge.id === 'e-a-u')?.routePoints).toEqual([
      { x: 10, y: 21 },
      { x: 30, y: 41 }
    ]);
  });

  it('preserves explicit seeded positions for existing nodes when new nodes appear later', async () => {
    const initialView = await buildViewModel(graph, 'top', { version: 1, modules: {} });
    initialView.nodes.forEach(n => n.fixed = true);
    const seeded = mergeNodePositions({ version: 1, modules: {} }, 'top', initialView.nodes);
    const expandedGraph: DesignGraph = {
      ...graph,
      modules: {
        top: {
          ...graph.modules.top,
          nodes: [
            ...graph.modules.top.nodes,
            { id: 'new', kind: 'mux', label: 'new', ports: [] }
          ]
        }
      }
    };

    const expandedView = await buildViewModel(expandedGraph, 'top', seeded);

    expect(expandedView.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: seeded.modules.top.nodes.a.x, y: seeded.modules.top.nodes.a.y });
    expect(expandedView.nodes.find((node) => node.id === 'u')?.position).toEqual({ x: seeded.modules.top.nodes.u.x, y: seeded.modules.top.nodes.u.y });
    expect(expandedView.nodes.find((node) => node.id === 'new')?.position).toBeDefined();
  });

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
            { id: 'sink', kind: 'instance', label: 'sink', ports: [] }
          ],
          edges: [
            { id: 'input-new', source: 'input', target: 'new_reg' },
            { id: 'new-sink', source: 'new_reg', target: 'sink' }
          ]
        }
      }
    };
    const layout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            input: { x: 500, y: 500, fixed: true },
            sink: { x: 900, y: 500, fixed: true },
            old_reg: { x: 700, y: 500, stale: true, fixed: true }
          }
        }
      }
    };
    connectedGraph.modules.top.nodes[1] = { id: 'new_reg', kind: 'register', label: 'new_reg', ports: [] };

    const view = await buildViewModel(connectedGraph, 'top', layout);
    const newReg = view.nodes.find((node) => node.id === 'new_reg');

    expect(view.nodes.find((node) => node.id === 'input')?.position).toEqual({ x: 504, y: 504 });
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
            { id: 'port:top:clk', kind: 'port', label: 'clk', ports: [{ id: 'clk', name: 'clk', direction: 'input' }] },
            { id: 'port:top:d', kind: 'port', label: 'd', ports: [{ id: 'd', name: 'd', direction: 'input' }] },
            { id: 'port:top:q', kind: 'port', label: 'q', ports: [{ id: 'q', name: 'q', direction: 'output' }] },
            {
              id: 'reg:top:q',
              kind: 'register',
              label: 'q',
              ports: [
                { id: 'd', name: 'D', direction: 'input' },
                { id: 'clk', name: 'clk', direction: 'input' },
                { id: 'q', name: 'Q', direction: 'output' }
              ],
              metadata: { clockSignal: 'clk' }
            }
          ],
          edges: [
            { id: 'd-q', source: 'port:top:d', sourcePort: 'd', target: 'reg:top:q', targetPort: 'd' },
            { id: 'clk-q', source: 'port:top:clk', sourcePort: 'clk', target: 'reg:top:q', targetPort: 'clk' },
            { id: 'q-out', source: 'reg:top:q', sourcePort: 'q', target: 'port:top:q', targetPort: 'q' }
          ]
        }
      }
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
              return { ...node, id: 'port:top:q_new', label: 'q_new', ports: [{ id: 'q_new', name: 'q_new', direction: 'output' }] };
            }
            if (node.id === 'reg:top:q') {
              return { ...node, id: 'reg:top:q_new', label: 'q_new' };
            }
            return node;
          }),
          edges: [
            { id: 'd-q-new', source: 'port:top:d', sourcePort: 'd', target: 'reg:top:q_new', targetPort: 'd' },
            { id: 'clk-q-new', source: 'port:top:clk', sourcePort: 'clk', target: 'reg:top:q_new', targetPort: 'clk' },
            { id: 'q-new-out', source: 'reg:top:q_new', sourcePort: 'q', target: 'port:top:q_new', targetPort: 'q_new' }
          ]
        }
      }
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
            { id: 'mux:top:y:sel', kind: 'mux', label: 'case sel', ports: [] }
          ],
          edges: [
            { id: 'ccc-cq', source: 'port:top:ccc', target: 'reg:top:c_q' },
            { id: 'clk-cq', source: 'port:top:clk', target: 'reg:top:c_q' }
          ]
        }
      }
    };
    const arrangedLayout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            'port:top:ccc': { x: 192, y: 720, fixed: true },
            'port:top:clk': { x: 192, y: 552, fixed: true },
            'reg:top:c_q': { x: 528, y: 696, fixed: true },
            'mux:top:y:sel': { x: 528, y: 312, fixed: true }
          }
        }
      }
    };
    const expandedGraph: DesignGraph = {
      ...baseGraph,
      modules: {
        top: {
          ...baseGraph.modules.top,
          nodes: [
            ...baseGraph.modules.top.nodes,
            { id: 'reg:top:cc_q', kind: 'register', label: 'cc_q', ports: [] }
          ],
          edges: [
            ...baseGraph.modules.top.edges,
            { id: 'ccc-ccq', source: 'port:top:ccc', target: 'reg:top:cc_q' },
            { id: 'clk-ccq', source: 'port:top:clk', target: 'reg:top:cc_q' }
          ]
        }
      }
    };

    const expandedView = await buildViewModel(expandedGraph, 'top', arrangedLayout);
    const expandedLayout = mergeNodePositions(arrangedLayout, 'top', expandedView.nodes);
    const collapsedView = await buildViewModel(baseGraph, 'top', expandedLayout);

    for (const [id, expected] of Object.entries(arrangedLayout.modules.top.nodes)) {
      expect(expandedView.nodes.find((node) => node.id === id)?.position).toEqual({ x: expected.x, y: expected.y });
      expect(collapsedView.nodes.find((node) => node.id === id)?.position).toEqual({ x: expected.x, y: expected.y });
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
            { id: 'p_a', kind: 'port', label: 'a', ports: [{ id: 'out', name: 'out', direction: 'output' }] },
            { id: 'p_b', kind: 'port', label: 'b', ports: [{ id: 'out', name: 'out', direction: 'output' }] },
            { id: 'c', kind: 'comb', label: 'comb', ports: [
              { id: 'in_a', name: 'a', direction: 'input' },
              { id: 'in_b', name: 'b', direction: 'input' }
            ] }
          ],
          edges: [
            { id: 'e_a', source: 'p_a', target: 'c', sourcePort: 'out', targetPort: 'in_a' },
            { id: 'e_b', source: 'p_b', target: 'c', sourcePort: 'out', targetPort: 'in_b' }
          ]
        }
      }
    };

    const view = await buildViewModel(orderedGraph, 'top', { version: 1, modules: {} });
    const posA = view.nodes.find(n => n.id === 'p_a')!.position;
    const posB = view.nodes.find(n => n.id === 'p_b')!.position;

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
              { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'out', name: 'out', direction: 'input' }] },
              { id: 'y', kind: 'port', label: 'y', ports: [{ id: 'in', name: 'in', direction: 'output' }] }
            ],
            edges: [
              { id: 'a-y', source: 'a', target: 'y', sourcePort: 'out', targetPort: 'in' }
            ]
          }
        }
      };

      const initialView = await buildViewModel(initialGraph, 'top', { version: 1, modules: {} });
      const originalYPos = initialView.nodes.find(n => n.id === 'y')!.position.x;
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
              { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'out', name: 'out', direction: 'output' }] },
              { id: 'c', kind: 'comb', label: 'comb', ports: [
                { id: 'in_a', name: 'in_a', direction: 'input' },
                { id: 'in_b', name: 'in_b', direction: 'input' },
                { id: 'out_y', name: 'out_y', direction: 'output' }
              ] }
            ],
            edges: [
              { id: 'a-c', source: 'a', target: 'c', sourcePort: 'out', targetPort: 'in_a' },
              { id: 'b-c', source: 'b', target: 'c', sourcePort: 'out', targetPort: 'in_b' },
              { id: 'c-y', source: 'c', target: 'y', sourcePort: 'out_y', targetPort: 'in' }
            ]
          }
        }
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
            { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'out', name: 'out', direction: 'input' }] },
            { id: 'y', kind: 'port', label: 'y', ports: [{ id: 'in', name: 'in', direction: 'output' }] }
          ],
          edges: [
            { id: 'a-y', source: 'a', target: 'y', sourcePort: 'out', targetPort: 'in' }
          ]
        }
      }
    };

    const initialView = await buildViewModel(initialGraph, 'top', { version: 1, modules: {} });
    initialView.nodes.find(n => n.id === 'y')!.fixed = true;
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
            { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'out', name: 'out', direction: 'output' }] },
            { id: 'c', kind: 'comb', label: 'comb', ports: [
              { id: 'in_a', name: 'in_a', direction: 'input' },
              { id: 'in_b', name: 'in_b', direction: 'input' },
              { id: 'out_y', name: 'out_y', direction: 'output' }
            ] }
          ],
          edges: [
            { id: 'a-c', source: 'a', target: 'c', sourcePort: 'out', targetPort: 'in_a' },
            { id: 'b-c', source: 'b', target: 'c', sourcePort: 'out', targetPort: 'in_b' },
            { id: 'c-y', source: 'c', target: 'y', sourcePort: 'out_y', targetPort: 'in' }
          ]
        }
      }
    };

    const expandedView = await buildViewModel(expandedGraph, 'top', layout);
    const newYPos = expandedView.nodes.find((node) => node.id === 'y')?.position.x;

    expect(newYPos).toBe(originalYPos!);
    });
    });
