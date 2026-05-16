import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runParser } from '../helper';

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

describe('aggregate assignment issues', () => {
  it('connects aggregate breakouts into slice and struct composition nodes', async () => {
    const graph = await runParser('uhdm', 'aggregate_assignment_showcase.sv', fixture('aggregate_assignment_showcase.sv'));
    const mod = graph.modules.aggregate_assignment_showcase;

    expect(mod).toBeDefined();

    const mirroredBreakout = mod.nodes.find(n => n.kind === 'bus' && n.metadata?.expression === '[aggregate-breakout]' && n.ports.some(p => p.connectedSignal === 'mirrored[7:4]'));
    expect(mirroredBreakout).toBeDefined();

    const mirroredComp = mod.nodes.find(n => n.id === `bus_comp:${mod.name}:mirrored`);
    expect(mirroredComp).toBeDefined();
    expect(mod.edges.some(e => e.source === mirroredBreakout?.id && e.target === mirroredComp?.id)).toBe(true);
    expect(mod.edges.some(e => e.source === mirroredComp?.id && e.target === 'port:aggregate_assignment_showcase:mirrored')).toBe(true);

    const pktOComp = mod.nodes.find(n => n.id === `struct_comp:${mod.name}:pkt_o`);
    expect(pktOComp).toBeDefined();
    const pktOBreakout = mod.nodes.find(n => n.kind === 'bus' && n.metadata?.expression === '[aggregate-breakout]' && n.ports.some(p => p.connectedSignal === 'pkt_o.lane'));
    expect(pktOBreakout).toBeDefined();

    expect(mod.edges.some(e => e.source === pktOBreakout?.id && e.target === pktOComp?.id && e.signal === 'pkt_o.opcode')).toBe(true);
    expect(mod.edges.some(e => e.source === pktOBreakout?.id && e.target === pktOComp?.id && e.signal === 'pkt_o.valid')).toBe(true);
    expect(mod.edges.some(e => e.source === pktOBreakout?.id && e.target === pktOComp?.id && e.signal === 'pkt_o.lane')).toBe(true);
  });

  it('correctly handles nested concatenations and replications', async () => {
    const graph = await runParser('uhdm', 'aggregate_assignment_showcase.sv', fixture('aggregate_assignment_showcase.sv'));
    const mod = graph.modules.aggregate_assignment_showcase;

    const breakout = mod.nodes.find(n => n.kind === 'bus' && n.metadata?.expression === '[aggregate-breakout]' && n.ports.some(p => p.connectedSignal === 'mirrored[7:4]'));
    const edgesToBreakout = mod.edges.filter(e => e.target === breakout?.id);
    const composeId = edgesToBreakout.find(e => e.targetPort === 'in:in')?.source;
    const compose = mod.nodes.find(n => n.id === composeId);

    expect(compose).toBeDefined();
    
    // 1. Should NOT have a zero pad if sizes match (8 bits)
    const padPort = compose?.ports.find(p => p.name === 'rhs_pad');
    expect(padPort).toBeUndefined();
    expect(compose?.ports.filter(p => p.direction === 'input')).toHaveLength(2);

    // Find replicate node for 'd'
    const replicateNode = mod.nodes.find(n => n.kind === 'replicate' && n.ports.some(p => p.connectedSignal === 'd'));
    expect(replicateNode).toBeDefined();
    expect(replicateNode?.ports.find(p => p.direction === 'output')?.width).toBe('[3:0]');

    expect(mod.edges.some(e => e.source === replicateNode?.id && e.target === compose?.id)).toBe(true);
    const innerEdge = mod.edges.find(e => e.target === compose?.id && e.source !== replicateNode?.id);
    const innerCompose = mod.nodes.find(n => n.id === innerEdge?.source);
    expect(innerCompose).toBeDefined();
    expect(innerCompose?.kind).toBe('bus');
    expect(innerCompose?.ports.some(p => p.connectedSignal === 'opcode_lo')).toBe(true);
    expect(innerCompose?.ports.some(p => p.connectedSignal === 'opcode_hi')).toBe(true);

    // 3. Check port indices on outer compose
    // Should be [7:4] for replicate and [3:0] for inner compose
    const repEdge = mod.edges.find(e => e.source === replicateNode?.id && e.target === compose?.id);
    
    expect(compose?.ports.find(p => p.id === repEdge?.targetPort)?.label).toBe('[7:4]');
    expect(compose?.ports.find(p => p.id === innerEdge?.targetPort)?.label).toBe('[3:0]');
    expect(compose?.ports.find(p => p.id === repEdge?.targetPort)?.width).toBe('[3:0]');
    expect(compose?.ports.find(p => p.id === innerEdge?.targetPort)?.width).toBe('[3:0]');
  });

  it('labels procedural aggregate breakout slices by their aggregate bit ranges', async () => {
    const graph = await runParser('uhdm', 'aggregate_assignment_showcase.sv', fixture('aggregate_assignment_showcase.sv'));
    const mod = graph.modules.aggregate_assignment_showcase;

    const breakout = mod.nodes.find(n => (
      n.kind === 'bus'
      && n.metadata?.expression === '[aggregate-breakout]'
      && n.ports.some(p => p.connectedSignal === 'registered[2]_next')
    ));

    expect(breakout).toBeDefined();
    expect(breakout?.ports.find(p => p.connectedSignal === 'registered[2]_next')).toMatchObject({ label: '[2]', width: '[0:0]' });
    expect(breakout?.ports.find(p => p.connectedSignal === 'registered[1:0]_next')).toMatchObject({ label: '[1:0]', width: '[1:0]' });
    expect(breakout?.ports.find(p => p.direction === 'input')).toMatchObject({ width: '[2:0]' });
  });
});
