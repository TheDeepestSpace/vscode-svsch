import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runParser } from '../helper';

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

describe('parser: concatenation as bus composition', () => {
  it('represents replication expressions as xN nodes with distinct output nets (UHDM)', async () => {
    const graph = await runParser('uhdm', 'replication_expr.sv', fixture('replication_expr.sv'));
    const mod = graph.modules.replication_expr;

    expect(mod).toBeDefined();

    const repeat = mod.nodes.find(n => n.kind === 'replicate' && n.label === 'x20');
    expect(repeat).toBeDefined();
    expect(repeat?.metadata?.repeatCount).toBe(20);
    expect(repeat?.ports.some(p => p.direction === 'input' && p.connectedSignal === 'some_wire')).toBe(true);
    expect(repeat?.ports.some(p => p.direction === 'output' && p.connectedSignal === 'repeated')).toBe(true);
    expect(mod.edges.some(e => e.source === 'port:replication_expr:some_wire' && e.target === repeat?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === repeat?.id && e.target === 'port:replication_expr:repeated')).toBe(true);
    expect(mod.edges.some(e => e.source === 'port:replication_expr:some_wire' && e.target === 'port:replication_expr:repeated')).toBe(false);
  });

  it('uses replication nodes as inputs to concatenation bus compositions (UHDM)', async () => {
    const graph = await runParser('uhdm', 'replication_expr.sv', fixture('replication_expr.sv'));
    const mod = graph.modules.replication_expr;

    const bus = mod.nodes.find(n => n.kind === 'bus' && n.label === 'concat_repeated');
    const repeat = mod.nodes.find(n => n.kind === 'replicate' && n.label === 'x22');

    expect(bus).toBeDefined();
    expect(repeat).toBeDefined();
    expect(bus?.ports.some(p => p.direction === 'input' && p.connectedSignal === 'head')).toBe(true);
    expect(bus?.ports.some(p => p.direction === 'input' && p.connectedSignal === repeat?.ports.find(port => port.direction === 'output')?.connectedSignal)).toBe(true);
    expect(bus?.ports.some(p => p.direction === 'input' && p.connectedSignal === 'tail')).toBe(true);
    expect(mod.edges.some(e => e.source === repeat?.id && e.target === bus?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === 'port:replication_expr:some_wire' && e.target === bus?.id)).toBe(false);
  });

  it('handles replication quirks: vector operands, repeated concatenations, and constant parameters (UHDM)', async () => {
    const graph = await runParser('uhdm', 'replication_expr.sv', fixture('replication_expr.sv'));
    const mod = graph.modules.replication_expr;

    const repeatedPair = mod.nodes.find(n => n.kind === 'replicate' && n.label === 'x4' && n.ports.some(p => p.connectedSignal === 'repeated_pair'));
    const nested = mod.nodes.find(n => n.kind === 'replicate' && n.label === 'x2' && n.ports.some(p => p.connectedSignal === 'nested_concat'));
    const nestedInputBus = mod.nodes.find(n => (
      n.kind === 'bus'
      && n.ports.some(p => p.direction === 'input' && p.connectedSignal === 'head')
      && n.ports.some(p => p.direction === 'input' && p.connectedSignal === 'pair')
      && n.ports.some(p => p.direction === 'output' && p.connectedSignal === nested?.ports.find(port => port.direction === 'input')?.connectedSignal)
    ));
    const fill = mod.nodes.find(n => n.kind === 'replicate' && n.label === 'x FILL' && n.ports.some(p => p.connectedSignal === 'fill_ones'));

    expect(repeatedPair).toBeDefined();
    expect(repeatedPair?.ports.some(p => p.direction === 'input' && p.connectedSignal === 'pair')).toBe(true);
    expect(repeatedPair?.ports.find(p => p.direction === 'output')?.width).toBe('[7:0]');

    expect(nested).toBeDefined();
    expect(nested?.ports.filter(p => p.direction === 'input')).toHaveLength(1);
    expect(nestedInputBus).toBeDefined();
    expect(nestedInputBus?.ports.find(p => p.direction === 'output')?.width).toBe('[2:0]');
    expect(nestedInputBus?.ports.find(p => p.connectedSignal === 'head')).toMatchObject({ name: '[2]', width: '[0:0]' });
    expect(nestedInputBus?.ports.find(p => p.connectedSignal === 'pair')).toMatchObject({ name: '[1:0]', width: '[1:0]' });
    expect(mod.edges.some(e => e.source === 'port:replication_expr:head' && e.target === nestedInputBus?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === 'port:replication_expr:pair' && e.target === nestedInputBus?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === nestedInputBus?.id && e.target === nested?.id)).toBe(true);

    expect(fill).toBeDefined();
    expect(fill?.metadata?.repeatCount).toBe(4);
    expect(fill?.metadata?.repeatExpression).toBe('FILL');
    expect(fill?.metadata?.repeatExpressionSource).toMatchObject({ startLine: 12 });
    expect(fill?.source).toMatchObject({ startLine: 18, startColumn: 21, endLine: 18, endColumn: 33 });
    expect(fill?.ports.some(p => p.direction === 'input' && p.connectedSignal === "1'b1")).toBe(true);
  });

  it('interprets {a, b} as a bus composition (UHDM)', async () => {
    const graph = await runParser('uhdm', 'bus_concat.sv', fixture('bus_concat.sv'));
    const mod = graph.modules.bus_concat;

    expect(mod).toBeDefined();

    // Check y_comb
    // It should be interpreted as a bus composition (kind 'bus')
    const busCombs = mod.nodes.filter(n => (n.label === 'y_comb') && n.kind === 'bus');
    expect(busCombs.length).toBe(1);
    const busComb = busCombs[0];
    expect(busComb).toBeDefined();
    expect(busComb?.label).toBe('y_comb');
    expect(busComb?.ports.find(p => p.direction === 'output')?.width).toBe('[1:0]');
    expect(busComb?.ports.find(p => p.direction === 'output')?.label).toBe('y_comb');
    
    // Check inputs and outputs
    expect(busComb?.ports.some(p => p.direction === 'input' && p.name === '[1]' && p.connectedSignal === 'a')).toBe(true);
    expect(busComb?.ports.some(p => p.direction === 'input' && p.name === '[0]' && p.connectedSignal === 'b')).toBe(true);
    expect(busComb?.ports.some(p => p.direction === 'output' && p.name === 'y_comb')).toBe(true);

    // Check edges
    expect(mod.edges.some(e => e.source === 'port:bus_concat:a' && e.target === busComb?.id && e.targetPort === busComb?.ports.find(p => p.name === '[1]')?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === 'port:bus_concat:b' && e.target === busComb?.id && e.targetPort === busComb?.ports.find(p => p.name === '[0]')?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === busComb?.id && e.target === 'port:bus_concat:y_comb')).toBe(true);

    // Check source range
    expect(busComb?.source).toBeDefined();
    // assign y_comb = {a, b}; is on line 8
    // {a, b} is columns 20 to 26 (0-based)
    expect(busComb?.source?.startLine).toBe(8);
    expect(busComb?.source?.startColumn).toBe(20);
    expect(busComb?.source?.endLine).toBe(8);
    expect(busComb?.source?.endColumn).toBe(26);

    // Check y_ff
    const busFfs = mod.nodes.filter(n => (n.label === 'y_ff') && n.kind === 'bus');
    expect(busFfs.length).toBe(1);
    const busFf = busFfs[0];
    expect(busFf).toBeDefined();
    expect(busFf?.label).toBe('y_ff');
    expect(busFf?.ports.find(p => p.direction === 'output')?.width).toBe('[1:0]');
    expect(busFf?.ports.find(p => p.direction === 'output')?.label).toBe('y_ff');
    expect(busFf?.ports.some(p => p.direction === 'input' && p.name === '[1]' && p.connectedSignal === 'b')).toBe(true);
    expect(busFf?.ports.some(p => p.direction === 'input' && p.name === '[0]' && p.connectedSignal === 'a')).toBe(true);
    
    // y_ff <= {b, a}; is on line 11
    // {b, a} is columns 16 to 22 (0-based)
    expect(busFf?.source?.startLine).toBe(11);
    expect(busFf?.source?.startColumn).toBe(16);
    expect(busFf?.source?.endLine).toBe(11);
    expect(busFf?.source?.endColumn).toBe(22);
    
    const regFf = mod.nodes.find(n => n.kind === 'register' && n.label === 'y_ff');
    expect(regFf).toBeDefined();
    
    // Edge from bus composition to register
    expect(mod.edges.some(e => e.source === busFf?.id && e.target === regFf?.id && e.targetPort === 'd')).toBe(true);
  });

  it('interprets {a, b} for structs as a bus composition (UHDM)', async () => {
    const graph = await runParser('uhdm', 'bus_concat.sv', fixture('bus_concat.sv'));
    const mod = graph.modules.struct_concat;

    expect(mod).toBeDefined();

    const busNodes = mod.nodes.filter(n => (n.label === 'y' || n.id.includes('y:expr') || n.id.includes('bus_comp:struct_concat:y')) && n.kind === 'struct');
    expect(busNodes.length).toBe(1);
    const busNode = busNodes[0];
    expect(busNode).toBeDefined();
    expect(busNode?.kind).toBe('struct');
    expect(busNode?.metadata?.role).toBe('composition');
    expect(busNode?.label).toBe('y');
    expect(busNode?.ports.find(p => p.direction === 'output')?.width).toBe('[1:0]');

    expect(busNode?.ports.some(p => p.direction === 'input' && p.name === 'f_a' && p.connectedSignal === 'a')).toBe(true);
    expect(busNode?.ports.some(p => p.direction === 'input' && p.name === 'f_b' && p.connectedSignal === 'b')).toBe(true);
    expect(busNode?.ports.some(p => p.direction === 'output' && p.name === 'y')).toBe(true);

    // Check edge aggregate metadata
    const structEdge = mod.edges.find(e => e.source === busNode?.id && e.signal === 'y');
    expect(structEdge).toBeDefined();
    expect(structEdge?.metadata?.aggregate).toBe('struct');

    // Check source range for struct concat
    // assign y = {a, b}; is on line 25
    // {a, b} is columns 15 to 21 (0-based)
    expect(busNode?.source).toBeDefined();
    expect(busNode?.source?.startLine).toBe(25);
    expect(busNode?.source?.startColumn).toBe(15);
    expect(busNode?.source?.endLine).toBe(25);
    expect(busNode?.source?.endColumn).toBe(21);
  });

  it('interprets struct breakout as individual thin lines (UHDM)', async () => {
    const graph = await runParser('uhdm', 'bus_concat.sv', fixture('bus_concat.sv'));
    const mod = graph.modules.struct_breakout;

    expect(mod).toBeDefined();

    const structNode = mod.nodes.find(n => n.kind === 'struct' && n.label === 'u');
    expect(structNode).toBeDefined();
    expect(structNode?.metadata?.role).toBe('breakout');

    // Check edges originating from breakout node
    const edgesFromStruct = mod.edges.filter(e => e.source === structNode?.id);
    expect(edgesFromStruct.length).toBeGreaterThan(0);

    for (const edge of edgesFromStruct) {
        // Individual fields should NOT be aggregated as 'struct' (thick lines)
        // because they represent single fields, not the whole bundle.
        expect(edge.metadata?.aggregate).not.toBe('struct');
    }
  });
});
