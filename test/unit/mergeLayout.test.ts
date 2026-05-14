import { describe, expect, it } from 'vitest';
import { buildViewModel, mergeEdgeRoutePoints, mergeEdgeWaypoint, mergeNodePositions } from '../../src/layout/mergeLayout';
import { diagramSizing, ioPortCenterOffset, muxHeightForPortRows, nodeHeightForPortRows, nodePortCenterOffset } from '../../src/diagram/constants';
import { diagramNodeDimensions } from '../../src/diagram/nodeSizing';
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
    expect(ioPortCenterOffset()).toBe(diagramSizing.gridSize / 2);
    expect(nodePortCenterOffset(0) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(1) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(2) % diagramSizing.gridSize).toBe(0);
    expect(nodePortCenterOffset(1) - nodePortCenterOffset(0)).toBe(diagramSizing.gridSize);
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
    expect(merged.modules.top.nodes.a).toEqual({ x: 24, y: 36, fixed: true });
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

  it('uses ELK routes for ordinary feedback edges so wires wrap around default node boxes', async () => {
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
                { id: 'd', name: 'D', direction: 'input' }
              ]
            },
            {
              id: 'mux',
              kind: 'mux',
              label: 'if en',
              ports: [
                { id: 'sel', name: 'sel', direction: 'input' },
                { id: 'true', name: 'true', direction: 'input' },
                { id: 'out', name: 'out', direction: 'output' }
              ]
            }
          ],
          edges: [
            { id: 'feedback', source: 'latch', sourcePort: 'q', target: 'mux', targetPort: 'true' },
            { id: 'mux-latch', source: 'mux', sourcePort: 'out', target: 'latch', targetPort: 'd' }
          ]
        }
      }
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
      y: latch.position.y + diagramSizing.nodeHeaderHeight + diagramSizing.gridSize / 2
    });
    expect(route![route!.length - 1]).toEqual({
      x: mux.position.x - diagramSizing.edgeLeadLength,
      y: mux.position.y + diagramSizing.gridSize * 2
    });
    expect(Math.max(...route!.map((point) => point.y))).toBeGreaterThanOrEqual(Math.max(latchBottom, muxBottom));
  });

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
            { id: 'rst', kind: 'port', label: 'rst', ports: [{ id: 'rst', name: 'rst', direction: 'input' }] },
            {
              id: 'reg',
              kind: 'register',
              label: 'q',
              ports: [
                { id: 'd', name: 'D', direction: 'input' },
                { id: 'clk', name: 'clk', direction: 'input' },
                { id: 'reset', name: 'rst', direction: 'input' },
                { id: 'q', name: 'Q', direction: 'output' }
              ],
              metadata: { clockSignal: 'clk', resetSignal: 'rst' }
            }
          ],
          edges: [
            { id: 'rst-reg', source: 'rst', sourcePort: 'rst', target: 'reg', targetPort: 'reset' }
          ]
        }
      }
    };

    const view = await buildViewModel(resetGraph, 'top', { version: 1, modules: {} });
    const route = view.edges.find((edge) => edge.id === 'rst-reg')?.routePoints;
    const rst = view.nodes.find((node) => node.id === 'rst')!;
    const reg = view.nodes.find((node) => node.id === 'reg')!;
    const regDims = diagramNodeDimensions(reg);

    expect(route).toBeDefined();
    expect(route![0]).toEqual({
      x: rst.position.x + diagramNodeDimensions(rst).width + diagramSizing.edgeLeadLength,
      y: rst.position.y + diagramSizing.portHeight / 2
    });
    expect(route![route!.length - 1]).toEqual({
      x: reg.position.x + regDims.width / 2,
      y: reg.position.y + regDims.height + diagramSizing.gridSize
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
                { id: 'in', name: 'i', direction: 'input' }
              ]
            },
            { id: 'i', kind: 'port', label: 'i', ports: [{ id: 'i', name: 'i', direction: 'input' }] },
            { id: 'o', kind: 'port', label: 'o', ports: [{ id: 'o', name: 'o', direction: 'output' }] }
          ],
          edges: [
            { id: 'i-comb', source: 'i', sourcePort: 'i', target: 'comb', targetPort: 'in' },
            { id: 'comb-o', source: 'comb', sourcePort: 'out', target: 'o', targetPort: 'o' }
          ]
        }
      }
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
                { id: 'b', name: 'b', direction: 'input' }
              ]
            },
            { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'a', name: 'a', direction: 'input' }] },
            { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'b', name: 'b', direction: 'input' }] }
          ],
          edges: [
            { id: 'a-comb', source: 'a', sourcePort: 'a', target: 'comb', targetPort: 'a' },
            { id: 'b-comb', source: 'b', sourcePort: 'b', target: 'comb', targetPort: 'b' }
          ]
        }
      }
    };

    const view = await buildViewModel(multiInputGraph, 'top', { version: 1, modules: {} });
    const a = view.nodes.find((node) => node.id === 'a')!;
    const b = view.nodes.find((node) => node.id === 'b')!;
    const comb = view.nodes.find((node) => node.id === 'comb')!;

    expect(renderedNodeInputCenterY(comb, 1) - renderedNodeInputCenterY(comb, 0)).toBe(diagramSizing.gridSize);
    expect(Math.abs(renderedPortCenterY(b) - renderedPortCenterY(a))).toBeGreaterThanOrEqual(diagramSizing.gridSize * 2);
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
                { id: 'out', name: 'y', direction: 'output' }
              ]
            },
            { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'a', name: 'a', direction: 'input' }] },
            { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'b', name: 'b', direction: 'input' }] }
          ],
          edges: [
            { id: 'a-mux', source: 'a', sourcePort: 'a', target: 'mux', targetPort: 'a' },
            { id: 'b-mux', source: 'b', sourcePort: 'b', target: 'mux', targetPort: 'b' }
          ]
        }
      }
    };

    const view = await buildViewModel(muxGraph, 'top', { version: 1, modules: {} });
    const a = view.nodes.find((node) => node.id === 'a')!;
    const b = view.nodes.find((node) => node.id === 'b')!;
    const mux = view.nodes.find((node) => node.id === 'mux')!;

    expect(renderedMuxSideInputCenterY(mux, 1, 2) - renderedMuxSideInputCenterY(mux, 0, 2)).toBe(diagramSizing.gridSize);
    expect(Math.abs(renderedPortCenterY(b) - renderedPortCenterY(a))).toBeGreaterThanOrEqual(diagramSizing.gridSize * 2);
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
                { id: 'out', name: 'y', direction: 'output' }
              ]
            },
            { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'a', name: 'a', direction: 'input' }] },
            { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'b', name: 'b', direction: 'input' }] },
            { id: 'y', kind: 'port', label: 'y', ports: [{ id: 'y', name: 'y', direction: 'output' }] }
          ],
          edges: [
            { id: 'a-alu', source: 'a', sourcePort: 'a', target: 'alu', targetPort: 'lhs' },
            { id: 'b-alu', source: 'b', sourcePort: 'b', target: 'alu', targetPort: 'rhs' },
            { id: 'alu-y', source: 'alu', sourcePort: 'out', target: 'y', targetPort: 'y' }
          ]
        }
      }
    };

    const view = await buildViewModel(aluGraph, 'top', { version: 1, modules: {} });
    const alu = view.nodes.find((node) => node.id === 'alu')!;
    const lhsRoute = view.edges.find((edge) => edge.id === 'a-alu')?.routePoints;
    const rhsRoute = view.edges.find((edge) => edge.id === 'b-alu')?.routePoints;
    const outRoute = view.edges.find((edge) => edge.id === 'alu-y')?.routePoints;

    expect(renderedAluInputCenterY(alu, 0) % diagramSizing.gridSize).toBe(0);
    expect(renderedAluInputCenterY(alu, 1) - renderedAluInputCenterY(alu, 0)).toBe(diagramSizing.gridSize * 2);
    expect(lhsRoute?.[lhsRoute.length - 1]).toEqual({
      x: alu.position.x - diagramSizing.edgeLeadLength,
      y: renderedAluInputCenterY(alu, 0)
    });
    expect(rhsRoute?.[rhsRoute.length - 1]).toEqual({
      x: alu.position.x - diagramSizing.edgeLeadLength,
      y: renderedAluInputCenterY(alu, 1)
    });
    expect(outRoute?.[0]).toEqual({
      x: alu.position.x + diagramNodeDimensions(alu).width + diagramSizing.edgeLeadLength,
      y: alu.position.y + diagramNodeDimensions(alu).height / 2
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
            { id: 'literal', kind: 'literal', label: "8'h42", ports: [{ id: 'y', name: 'y', direction: 'output' }] },
            { id: 'y', kind: 'port', label: 'y', ports: [{ id: 'y', name: 'y', direction: 'output' }] }
          ],
          edges: [
            { id: 'literal-y', source: 'literal', sourcePort: 'y', target: 'y', targetPort: 'y' }
          ]
        }
      }
    };

    const view = await buildViewModel(literalGraph, 'top', { version: 1, modules: {} });
    const literal = view.nodes.find((node) => node.id === 'literal')!;
    const y = view.nodes.find((node) => node.id === 'y')!;

    expect(literal.position.y + diagramNodeDimensions(literal).height / 2).toBe(renderedPortCenterY(y));
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
            { id: 'literal', kind: 'literal', label: "1'b1", ports: [{ id: 'out', name: "1'b1", direction: 'output' }] },
            {
              id: 'rep',
              kind: 'replicate',
              label: 'x4',
              ports: [
                { id: 'in', name: 'in', direction: 'input' },
                { id: 'out', name: 'fill_ones', direction: 'output' }
              ]
            },
            { id: 'fill', kind: 'port', label: 'fill_ones', ports: [{ id: 'fill', name: 'fill_ones', direction: 'output' }] }
          ],
          edges: [
            { id: 'literal-rep', source: 'literal', sourcePort: 'out', target: 'rep', targetPort: 'in' },
            { id: 'rep-fill', source: 'rep', sourcePort: 'out', target: 'fill', targetPort: 'fill' }
          ]
        }
      }
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
                { id: 'flag', name: 'instr[30]', direction: 'output' }
              ]
            },
            { id: 'instr', kind: 'port', label: 'instr', ports: [{ id: 'instr', name: 'instr', direction: 'input' }] },
            { id: 'opcode', kind: 'port', label: 'opcode', ports: [{ id: 'opcode', name: 'opcode', direction: 'output' }] },
            { id: 'flag', kind: 'port', label: 'flag', ports: [{ id: 'flag', name: 'flag', direction: 'output' }] }
          ],
          edges: [
            { id: 'instr-bus', source: 'instr', sourcePort: 'instr', target: 'bus', targetPort: 'in' },
            { id: 'bus-opcode', source: 'bus', sourcePort: 'opcode', target: 'opcode', targetPort: 'opcode' },
            { id: 'bus-flag', source: 'bus', sourcePort: 'flag', target: 'flag', targetPort: 'flag' }
          ]
        }
      }
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
                { id: 'b', name: 'b', direction: 'input' }
              ]
            },
            { id: 'a', kind: 'port', label: 'a', ports: [{ id: 'a', name: 'a', direction: 'input' }] },
            { id: 'b', kind: 'port', label: 'b', ports: [{ id: 'b', name: 'b', direction: 'input' }] },
            { id: 'decoded', kind: 'port', label: 'decoded', ports: [{ id: 'decoded', name: 'decoded', direction: 'output' }] }
          ],
          edges: [
            { id: 'a-comb', source: 'a', sourcePort: 'a', target: 'comb', targetPort: 'a' },
            { id: 'b-comb', source: 'b', sourcePort: 'b', target: 'comb', targetPort: 'b' },
            { id: 'comb-decoded', source: 'comb', sourcePort: 'out', target: 'decoded', targetPort: 'decoded' }
          ]
        }
      }
    };
    const seededLayout: SavedLayout = {
      version: 1,
      modules: {
        top: {
          nodes: {
            comb: { x: 240, y: 96 },
            a: { x: 48, y: 96 },
            b: { x: 48, y: 144 },
            decoded: { x: 480, y: 96 }
          }
        }
      }
    };

    const view = await buildViewModel(seededGraph, 'top', seededLayout);
    const a = view.nodes.find((node) => node.id === 'a')!;
    const comb = view.nodes.find((node) => node.id === 'comb')!;
    const edge = view.edges.find((candidate) => candidate.id === 'a-comb')!;
    const targetLead = edge.routePoints?.[edge.routePoints.length - 1];
    const beforeTargetLead = edge.routePoints?.[edge.routePoints.length - 2];

    expect(edge.routePoints?.[0]).toMatchObject({
      x: a.position.x + diagramNodeDimensions(a).width + diagramSizing.edgeLeadLength,
      y: renderedPortCenterY(a)
    });
    expect(targetLead).toEqual({
      x: comb.position.x - diagramSizing.edgeLeadLength,
      y: renderedNodeInputCenterY(comb, 0)
    });
    expect(beforeTargetLead?.y).toBe(targetLead?.y);
    expect(beforeTargetLead?.x).toBeLessThan(targetLead!.x);
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
            'port:top:ccc': { x: 192, y: 732, fixed: true },
            'port:top:clk': { x: 192, y: 564, fixed: true },
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
