import { AvoidLib } from 'libavoid-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLibavoidRuntimeForTests } from '../../src/layout/libavoidRouter';
import {
  buildPartialViewModel,
  resolveExtendTarget,
  type PartialDiagramState,
} from '../../src/layout/partialDiagram';
import type { SavedLayout } from '../../src/storage/layoutStore';
import { runParser } from '../helper';

beforeAll(async () => {
  await AvoidLib.load();
  setLibavoidRuntimeForTests(AvoidLib.getInstance());
});

// An instance feeds a struct into a second instance, and the same struct wire
// is broken out (bus breakout) into a third instance. The extractor leaves a
// phantom boundary hub edge on the breakout (`port:top:s` is not a node — the
// struct is an internal net, not a module port); extending the struct net from
// u1 must not leave a dangling cut end carrying the struct's name.
const DESIGN = `
typedef struct packed {
  logic [3:0] a;
  logic [3:0] b;
} my_struct_t;

module producer(output my_struct_t s_out);
  assign s_out = '0;
endmodule

module consumer(input my_struct_t s_in);
endmodule

module field_consumer(input logic [3:0] f_in);
endmodule

module top;
  my_struct_t s;
  producer u1(.s_out(s));
  consumer u2(.s_in(s));
  field_consumer u3(.f_in(s.a));
endmodule
`;

describe('partial diagram: struct fanout into an instance and a bus breakout', () => {
  it('extending the struct net leaves no dangling struct-named cut end', async () => {
    const graph = await runParser('uhdm', 'top.sv', DESIGN);
    const mod = graph.modules.top;
    const u1 = mod.nodes.find((n) => n.kind === 'instance' && n.label === 'u1')!;
    const layout: SavedLayout = { version: 1, modules: {} };

    let state: PartialDiagramState = {
      sourceModuleName: 'top',
      includedNodeIds: [u1.id],
      tiedNetKeys: [],
    };
    const before = await buildPartialViewModel(mod, state, layout);
    const structLabel = before.nodes.find(
      (n) => n.kind === 'netLabel' && n.metadata?.cutNet?.role === 'source',
    )!;
    expect(structLabel.label).toBe('s');

    // Extend the struct cut end the way partialDiagramPanel.extendNet does.
    const netKey = structLabel.metadata!.cutNet!.netKey;
    const target = resolveExtendTarget(
      mod,
      state,
      netKey,
      structLabel.metadata!.cutNet!.originalEdgeId,
    )!;
    state = {
      ...state,
      includedNodeIds: [...state.includedNodeIds, ...target.newNodeIds],
      tiedNetKeys: [netKey],
    };

    const after = await buildPartialViewModel(mod, state, layout);
    const realNodes = after.nodes.filter((n) => n.kind !== 'netLabel');
    // The fanout extend pulled in the consumer and the breakout together.
    expect(realNodes.map((n) => n.kind).sort()).toEqual(['instance', 'instance', 'struct']);
    // The only remaining cut end is the breakout's not-yet-expanded field tap
    // — in particular no dangling "s" end from the extractor's phantom
    // boundary hub edge on the breakout's input.
    const labels = after.nodes.filter((n) => n.kind === 'netLabel');
    expect(labels.map((n) => n.label)).toEqual(['s.a']);
  }, 120000);
});
