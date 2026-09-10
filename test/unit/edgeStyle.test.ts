import { describe, expect, it } from 'vitest';
import { annotateWireStyles } from '../../src/ir/edgeStyle';
import type { DiagramEdge, DiagramNode } from '../../src/ir/types';

function node(id: string, options: { array?: boolean; portWidth?: string } = {}): DiagramNode {
  return {
    id,
    kind: 'mux',
    label: id,
    ports:
      options.portWidth === undefined
        ? []
        : [{ id: 'value', name: 'value', direction: 'unknown', width: options.portWidth }],
    isArrayNode: options.array,
  } as DiagramNode;
}

function stackedEdge(id: string, source: string, target: string, width?: string): DiagramEdge {
  return { id, source, target, width, isStacked: true };
}

describe('annotateWireStyles stacked components', () => {
  it('propagates a known multi-bit port to every array node in a stacked mux chain', () => {
    const nodes = [
      node('source', { portWidth: '[7:0]' }),
      node('first', { array: true }),
      node('second', { array: true }),
      node('storage', { array: true }),
    ];
    const edges = [
      stackedEdge('input', 'source', 'first'),
      stackedEdge('intermediate', 'first', 'second'),
      stackedEdge('output', 'second', 'storage'),
    ];

    annotateWireStyles({ nodes, edges });

    // The layer spacing reaches every array node in the component, but none
    // of these edges carry their own width, so they stay thin — only the
    // node's own ports or an edge's own width can make an edge thick.
    expect(edges.map((edge) => edge.metadata?.thick)).toEqual([undefined, undefined, undefined]);
    expect(nodes.slice(1).map((item) => item.metadata?.stackWide)).toEqual([true, true, true]);
  });

  it('uses a known multi-bit edge to widen node spacing through the stacked component', () => {
    const nodes = [node('first', { array: true }), node('second', { array: true })];
    const edges = [
      stackedEdge('known', 'first', 'second', '[3:0]'),
      stackedEdge('unknown', 'second', 'first'),
    ];

    annotateWireStyles({ nodes, edges });

    // 'known' is independently thick because of its own width; 'unknown'
    // never gets a width of its own and must not inherit one.
    expect(edges.map((edge) => edge.metadata?.thick)).toEqual([true, undefined]);
    expect(nodes.map((item) => item.metadata?.stackWide)).toEqual([true, true]);
  });

  it('does not widen a single-bit control edge sharing a stacked component with wide data', () => {
    const nodes = [
      node('clkSource', {}),
      node('dataSource', { portWidth: '[7:0]' }),
      node('registerArray', { array: true }),
    ];
    const clk = stackedEdge('clk', 'clkSource', 'registerArray');
    const data = stackedEdge('data', 'dataSource', 'registerArray');
    const edges = [clk, data];

    annotateWireStyles({ nodes, edges });

    // The array node's layers still widen, but the single-bit clock wire
    // feeding it must not be reclassified as a thick/multi-bit wire.
    expect(nodes[2].metadata?.stackWide).toBe(true);
    expect(clk.metadata?.thick).toBeUndefined();
    expect(data.metadata?.thick).toBeUndefined();
  });

  it('keeps a single-bit stacked component compact', () => {
    const nodes = [
      node('source', { portWidth: '[0:0]' }),
      node('mux', { array: true }),
      node('storage', { array: true }),
    ];
    const edges = [stackedEdge('input', 'source', 'mux'), stackedEdge('output', 'mux', 'storage')];

    annotateWireStyles({ nodes, edges });

    expect(edges.map((edge) => edge.metadata?.thick)).toEqual([undefined, undefined]);
    expect(nodes.slice(1).map((item) => item.metadata?.stackWide)).toEqual([undefined, undefined]);
  });

  it('does not propagate width across an unstacked boundary', () => {
    const nodes = [
      node('source', { portWidth: '[7:0]' }),
      node('wide-array', { array: true }),
      node('read-mux'),
      node('downstream-array', { array: true }),
      node('sink', { array: true }),
    ];
    const upstream = stackedEdge('upstream', 'source', 'wide-array');
    const scalarized: DiagramEdge = {
      id: 'scalarized',
      source: 'wide-array',
      target: 'read-mux',
    };
    const downstream = stackedEdge('downstream', 'read-mux', 'downstream-array');
    const tail = stackedEdge('tail', 'downstream-array', 'sink');
    const edges = [upstream, scalarized, downstream, tail];

    annotateWireStyles({ nodes, edges });

    expect(upstream.metadata?.thick).toBeUndefined();
    expect(nodes[1].metadata?.stackWide).toBe(true);
    expect(scalarized.metadata?.thick).toBeUndefined();
    expect(downstream.metadata?.thick).toBeUndefined();
    expect(tail.metadata?.thick).toBeUndefined();
    expect(nodes[3].metadata?.stackWide).toBeUndefined();
    expect(nodes[4].metadata?.stackWide).toBeUndefined();
  });
});
