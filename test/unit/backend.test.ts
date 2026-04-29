import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runParser } from '../helper';

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

describe.each(['fallback', 'verible', 'uhdm'] as const)('parser backend: %s', (backend) => {
  it('extracts modules, instances, registers, muxes, and ports', async () => {
    const graph = await runParser(backend, 'simple.sv', fixture('simple.sv'));

    expect(Object.keys(graph.modules).sort()).toEqual(['child', 'top']);
    expect(graph.rootModules).toEqual(['top']);

    const top = graph.modules.top;
    expect(top.nodes.some((node) => node.kind === 'instance' && node.label === 'u_child')).toBe(true);
    expect(top.nodes.some((node) => node.kind === 'register' && node.label === 'q')).toBe(true);
    expect(top.nodes.some((node) => node.kind === 'mux' && node.label === 'case sel')).toBe(true);
    expect(top.nodes.filter((node) => node.kind === 'port').map((node) => node.label)).toContain('clk');
    expect(top.edges.some((edge) => edge.source === 'port:top:a' && edge.target === 'reg:top:q' && edge.targetPort === 'd')).toBe(true);
    expect(top.edges.some((edge) => edge.source === 'port:top:clk' && edge.target === 'reg:top:q' && edge.targetPort === 'clk')).toBe(true);
    expect(top.edges.some((edge) => edge.source === 'port:top:sel' && edge.target.startsWith('mux:top:'))).toBe(true);
    expect(top.edges.some((edge) => edge.source === 'port:top:b' && edge.target.startsWith('mux:top:'))).toBe(true);
    expect(top.edges.some((edge) => edge.source.startsWith('mux:top:') && edge.target === 'port:top:y')).toBe(true);
    const mux = top.nodes.find((node) => node.kind === 'mux');
    expect(mux?.ports.find((port) => port.name === 'a')?.label).toBe("1'b0");
    expect(mux?.ports.find((port) => port.name === 'b')?.label).toBe('default');
    expect(top.edges.some((edge) => edge.source === 'instance:top:u_child' && edge.target === 'port:top:y')).toBe(true);
    expect(graph.diagnostics.some((diagnostic) => diagnostic.message.includes('top.y has multiple diagram drivers'))).toBe(true);
  });

  it('represents unsupported constructs as unknown blocks', async () => {
    const graph = await runParser(backend, 'unknown.sv', fixture('unknown.sv'));
    const complex = graph.modules.complex;

    expect(complex.nodes.some((node) => node.kind === 'unknown' && node.label === 'generate')).toBe(true);
    expect(complex.nodes.some((node) => node.kind === 'unknown' && node.label === 'initial')).toBe(true);
  });

  it('extracts a clean single-driver fixture without multi-driver diagnostics', async () => {
    const graph = await runParser(backend, 'simple_clean.sv', fixture('simple_clean.sv'));
    const top = graph.modules.top_clean;

    expect(top.edges.some((edge) => edge.source.startsWith('mux:top_clean:') && edge.target === 'port:top_clean:y')).toBe(true);
    expect(top.edges.some((edge) => edge.source.startsWith('mux:top_clean:') && edge.target === 'instance:top_clean:u_child' && edge.targetPort === 'port:y')).toBe(true);
    expect(top.edges.some((edge) => edge.source === 'port:top_clean:y' && edge.target === 'instance:top_clean:u_child')).toBe(false);
    expect(graph.diagnostics.some((diagnostic) => diagnostic.message.includes('multiple diagram drivers'))).toBe(false);
  });

  it('keeps simple mux ids stable when unrelated source text is inserted before the case', async () => {
    const original = await runParser(backend, 'simple_clean.sv', fixture('simple_clean.sv'));
    const editedText = fixture('simple_clean.sv').replace(
      '  logic q;',
      '  logic q;\n  logic c;\n  logic c_q;'
    );
    const edited = await runParser(backend, [{ file: 'simple_clean.sv', text: editedText }] );
    const originalMux = original.modules.top_clean.nodes.find((node) => node.kind === 'mux');
    const editedMux = edited.modules.top_clean.nodes.find((node) => node.kind === 'mux');

    expect(originalMux?.id).toBe('mux:top_clean:y:sel');
    expect(editedMux?.id).toBe(originalMux?.id);
  });

  it('connects register outputs into downstream register inputs', async () => {
    const graph = await runParser(backend, 'reg_chain.sv', fixture('reg_chain.sv'));
    const regChain = graph.modules.reg_chain;

    expect(regChain.nodes.some((node) => node.id === 'reg:reg_chain:a_q')).toBe(true);
    expect(regChain.nodes.some((node) => node.id === 'reg:reg_chain:b_q')).toBe(true);
    const comb = regChain.nodes.find((node) => node.kind === 'comb');
    expect(comb?.label).toBe('');
    expect(comb?.ports.map((port) => port.name).sort()).toEqual(['a_q', 'b_q', 'c', 'd']);
    expect(regChain.edges.some((edge) => edge.source === 'reg:reg_chain:a_q' && edge.target === comb?.id && edge.signal === 'a_q')).toBe(true);
    expect(regChain.edges.some((edge) => edge.source === 'port:reg_chain:c' && edge.target === comb?.id && edge.signal === 'c')).toBe(true);
    expect(regChain.edges.some((edge) => edge.source === 'port:reg_chain:d' && edge.target === comb?.id && edge.signal === 'd')).toBe(true);
    expect(regChain.edges.some((edge) => (
      edge.source === comb?.id
      && edge.target === 'reg:reg_chain:b_q'
      && edge.targetPort === 'd'
      && edge.signal === 'b_q'
    ))).toBe(true);
    expect(regChain.edges.some((edge) => (
      edge.source === 'reg:reg_chain:b_q'
      && edge.sourcePort === 'q'
      && edge.target === 'port:reg_chain:y'
      && edge.signal === 'b_q'
    ))).toBe(true);
  });

  it('infers clock and reset semantics for async and sync always_ff registers', async () => {
    const graph = await runParser(backend, 'register_resets.sv', fixture('register_resets.sv'));
    const module = graph.modules.reg_resets;
    const asyncLow = module.nodes.find((node) => node.id === 'reg:reg_resets:q_async_low');
    const asyncHigh = module.nodes.find((node) => node.id === 'reg:reg_resets:q_async_high');
    const syncHigh = module.nodes.find((node) => node.id === 'reg:reg_resets:q_sync_high');

    expect(asyncLow?.ports.map((port) => port.name)).toEqual(['D', 'Q', 'c_main', 'rst_n']);
    expect(asyncHigh?.ports.map((port) => port.name)).toEqual(['D', 'Q', 'c_main', 'rst']);
    expect(syncHigh?.ports.map((port) => port.name)).toEqual(['D', 'Q', 'c_main', 'rst']);
    expect(asyncLow?.metadata?.resetKind).toBe('async');
    expect(asyncLow?.metadata?.resetActiveLow).toBe(true);
    expect(asyncHigh?.metadata?.resetKind).toBe('async');
    expect(asyncHigh?.metadata?.resetActiveLow).toBe(false);
    expect(syncHigh?.metadata?.resetKind).toBe('sync');
    expect(syncHigh?.metadata?.resetActiveLow).toBe(false);
    expect(module.edges.some((edge) => edge.source === 'port:reg_resets:c_main' && edge.target === 'reg:reg_resets:q_async_low' && edge.targetPort === 'clk')).toBe(true);
    expect(module.edges.some((edge) => edge.source === 'port:reg_resets:rst_n' && edge.target === 'reg:reg_resets:q_async_low' && edge.targetPort === 'reset')).toBe(true);
    expect(module.edges.some((edge) => edge.source === 'port:reg_resets:rst' && edge.target === 'reg:reg_resets:q_async_high' && edge.targetPort === 'reset')).toBe(true);
    expect(module.edges.some((edge) => edge.source === 'port:reg_resets:rst' && edge.target === 'reg:reg_resets:q_sync_high' && edge.targetPort === 'reset')).toBe(true);
  });

  it('keeps simple continuous assignments as wires and promotes expressions to combinational blocks', async () => {
    const graph = await runParser(backend, 'comb_assigns.sv', fixture('comb_assigns.sv'));
    const assignWire = graph.modules.assign_wire;
    const assignAnd = graph.modules.assign_and;
    const assignConstExpr = graph.modules.assign_const_expr;
    const assignCombChain = graph.modules.assign_comb_chain;

    expect(assignWire.nodes.some((node) => node.kind === 'unknown')).toBe(false);
    expect(assignWire.edges.some((edge) => (
      edge.source === 'port:assign_wire:a'
      && edge.target === 'port:assign_wire:y'
      && edge.signal === 'a'
    ))).toBe(true);

    const andBlock = assignAnd.nodes.find((node) => node.kind === 'comb');
    expect(andBlock?.label).toBe('');
    expect(andBlock?.ports.map((port) => port.name).sort()).toEqual(['a', 'b', 'y']);
    expect(assignAnd.edges.some((edge) => edge.source === 'port:assign_and:a' && edge.target === andBlock?.id)).toBe(true);
    expect(assignAnd.edges.some((edge) => edge.source === 'port:assign_and:b' && edge.target === andBlock?.id)).toBe(true);
    expect(assignAnd.edges.some((edge) => edge.source === andBlock?.id && edge.target === 'port:assign_and:y')).toBe(true);

    const constBlock = assignConstExpr.nodes.find((node) => node.kind === 'comb');
    expect(constBlock?.label).toBe('');
    expect(constBlock?.ports.map((port) => port.name).sort()).toEqual(['a', 'y']);
    expect(assignConstExpr.edges.some((edge) => edge.source === 'port:assign_const_expr:a' && edge.target === constBlock?.id)).toBe(true);
    expect(assignConstExpr.edges.some((edge) => edge.source === constBlock?.id && edge.target === 'port:assign_const_expr:y')).toBe(true);

    const chainBlocks = assignCombChain.nodes.filter((node) => node.kind === 'comb');
    const midBlock = chainBlocks.find((node) => node.ports.some((port) => port.direction === 'output' && port.name === 'mid'));
    const yBlock = chainBlocks.find((node) => node.ports.some((port) => port.direction === 'output' && port.name === 'y'));
    expect(chainBlocks).toHaveLength(2);
    expect(midBlock?.ports.map((port) => port.name).sort()).toEqual(['a', 'b', 'mid']);
    expect(yBlock?.ports.map((port) => port.name).sort()).toEqual(['a', 'c', 'mid', 'y']);
    expect(assignCombChain.edges.some((edge) => edge.source === midBlock?.id && edge.target === yBlock?.id && edge.signal === 'mid')).toBe(true);
  });

  it('promotes complex mux selector expressions to combinational blocks', async () => {
    const graph = await runParser(backend, 'mux_selector_expr.sv', fixture('mux_selector_expr.sv'));
    const muxSelectorExpr = graph.modules.mux_selector_expr;
    const mux = muxSelectorExpr.nodes.find((node) => node.kind === 'mux');
    const selectorComb = muxSelectorExpr.nodes.find((node) => node.kind === 'comb');

    expect(mux).toBeDefined();
    expect(selectorComb?.metadata?.expression).toBe('sel & sidekick');
    expect(selectorComb?.ports.map((port) => port.name).sort()).toEqual(['s', 'sel', 'sidekick']);
    expect(mux?.ports.find((port) => port.name === 's')?.label).toBe('s');
    expect(mux?.ports.find((port) => port.name === 'a')?.label).toBe("1'b0");
    expect(mux?.ports.find((port) => port.name === 'b')?.label).toBe('default');
    expect(muxSelectorExpr.edges.some((edge) => (
      edge.source === 'port:mux_selector_expr:sel'
      && edge.target === selectorComb?.id
      && edge.targetPort === 'in:sel'
    ))).toBe(true);
    expect(muxSelectorExpr.edges.some((edge) => (
      edge.source === 'port:mux_selector_expr:sidekick'
      && edge.target === selectorComb?.id
      && edge.targetPort === 'in:sidekick'
    ))).toBe(true);
    expect(muxSelectorExpr.edges.some((edge) => (
      edge.source === selectorComb?.id
      && edge.target === mux?.id
      && edge.sourcePort === 'out:s'
      && edge.targetPort === 'in:s'
    ))).toBe(true);
    expect(muxSelectorExpr.edges.some((edge) => edge.source === 'port:mux_selector_expr:a' && edge.target === mux?.id && edge.targetPort === 'in:a')).toBe(true);
    expect(muxSelectorExpr.edges.some((edge) => edge.source === 'port:mux_selector_expr:b' && edge.target === mux?.id && edge.targetPort === 'in:b')).toBe(true);
  });

  it('represents multi-bit buses and part-select taps', async () => {
    const graph = await runParser(backend, 'bus_slices.sv', fixture('bus_slices.sv'));
    const busSlices = graph.modules.bus_slices;
    const instrPort = busSlices.nodes.find((node) => node.id === 'port:bus_slices:instr');
    const bus = busSlices.nodes.find((node) => node.kind === 'bus' && node.label === 'instr');
    const decodedComb = busSlices.nodes.find((node) => (
      node.kind === 'comb'
      && node.ports.some((port) => port.direction === 'output' && port.name === 'decoded')
    ));
    const mux = busSlices.nodes.find((node) => node.kind === 'mux');

    expect(instrPort?.ports[0].width).toBe('[31:0]');
    expect(bus?.ports.find((port) => port.direction === 'input')?.width).toBe('[31:0]');
    expect(bus?.ports.find((port) => port.name === 'instr[14:12]')?.label).toBe('[14:12]');
    expect(bus?.ports.find((port) => port.name === 'instr[14:12]')?.width).toBe('[2:0]');
    expect(bus?.ports.find((port) => port.name === 'instr[6:0]')?.width).toBe('[6:0]');
    expect(bus?.ports.find((port) => port.name === 'instr[30]')?.width).toBe('[0:0]');
    expect(busSlices.nodes.find((node) => node.id === 'reg:bus_slices:funct3_q')?.metadata?.width).toBe('[2:0]');
    expect(decodedComb?.ports.find((port) => port.name === 'instr[6:0]')?.label).toBe('[6:0]');
    expect(decodedComb?.ports.find((port) => port.name === 'decoded')?.width).toBe('[7:0]');
    expect(mux?.ports.find((port) => port.name === 's')?.width).toBe('[0:0]');
    expect(busSlices.edges.some((edge) => (
      edge.source === 'port:bus_slices:instr'
      && edge.target === bus?.id
      && edge.width === '[31:0]'
    ))).toBe(true);
    expect(busSlices.edges.some((edge) => (
      edge.source === bus?.id
      && edge.sourcePort === 'out:instr_14_12_'
      && edge.target === 'reg:bus_slices:funct3_q'
      && edge.width === '[2:0]'
    ))).toBe(true);
    expect(busSlices.edges.some((edge) => (
      edge.source === bus?.id
      && edge.sourcePort === 'out:instr_30_'
      && edge.target === mux?.id
      && edge.targetPort === 'in:s'
    ))).toBe(true);
  });

  it('assigns proper source ranges to nodes in bus_slices.sv', async () => {
    const graph = await runParser(backend, 'bus_slices.sv', fixture('bus_slices.sv'));
    const busSlices = graph.modules.bus_slices;

    // Check register: always_ff @(posedge clk) begin ... end is lines 11-13
    const funct3_q = busSlices.nodes.find((node) => node.id === 'reg:bus_slices:funct3_q');
    expect(funct3_q?.source).toBeDefined();
    expect(funct3_q?.source?.file).toBe('bus_slices.sv');
    expect(funct3_q?.source?.startLine).toBe(11);
    expect(funct3_q?.source?.startColumn).toBe(2);
    expect(funct3_q?.source?.endLine).toBe(13);
    expect(funct3_q?.source?.endColumn).toBe(5);

    // Check comb block from assign: line 15
    const decodedComb = busSlices.nodes.find((node) => (
      node.kind === 'comb' && node.ports.some(p => p.name === 'decoded' && p.direction === 'output')
    ));
    expect(decodedComb?.source).toBeDefined();
    expect(decodedComb?.source?.file).toBe('bus_slices.sv');
    expect(decodedComb?.source?.startLine).toBe(15);
    expect(decodedComb?.source?.startColumn).toBe(2);
    expect(decodedComb?.source?.endLine).toBe(15);
    expect(decodedComb?.source?.endColumn).toBe(34);

    // Check mux from case: lines 18-21
    const mux = busSlices.nodes.find((node) => node.kind === 'mux');
    expect(mux?.source).toBeDefined();
    expect(mux?.source?.file).toBe('bus_slices.sv');
    expect(mux?.source?.startLine).toBe(18);
    expect(mux?.source?.startColumn).toBe(4);
    expect(mux?.source?.endLine).toBe(21);
    expect(mux?.source?.endColumn).toBe(11);

    // Check ports
    const clkPort = busSlices.nodes.find(node => node.id === 'port:bus_slices:clk');
    expect(clkPort?.source).toBeDefined();
    expect(clkPort?.source?.startLine).toBe(2);
    expect(clkPort?.source?.startColumn).toBe(2);
    expect(clkPort?.source?.endLine).toBe(2);
    expect(clkPort?.source?.endColumn).toBe(17);
  });

  it('does not crash on malformed source', async () => {
    const graph = await runParser(backend, [{ file: 'bad.sv', text: 'module broken(input logic a); always_ff @(' }] );

    expect(graph.modules.broken).toBeDefined();
    expect(graph.diagnostics).toEqual([]);
  });

  it('connects one submodule output to another submodule input', async () => {
    const graph = await runParser(backend, 'submodule_chain.sv', fixture('submodule_chain.sv'));
    const top = graph.modules.top_chain;

    expect(top).toBeDefined();
    expect(top.nodes.some((n) => n.id === 'instance:top_chain:u_sub_a')).toBe(true);
    expect(top.nodes.some((n) => n.id === 'instance:top_chain:u_sub_b')).toBe(true);

    // Check edge from u_sub_a to u_sub_b
    const edge = top.edges.find((e) => (
      e.source === 'instance:top_chain:u_sub_a'
      && e.target === 'instance:top_chain:u_sub_b'
    ));

    expect(edge).toBeDefined();
    expect(edge?.sourcePort).toBe('port:out_a');
    expect(edge?.targetPort).toBe('port:in_b');
    expect(edge?.signal).toBe('mid');
  });

  it('connects positional ports to instances', async () => {
    const topSv = 'module top(input i, output o); Sub sub_inst(i, o); endmodule';
    const subSv = 'module Sub(input i, output o); assign o = i; endmodule';
    const graph = await runParser(backend, [
      { file: 'top.sv', text: topSv },
      { file: 'sub.sv', text: subSv }
    ]);

    const top = graph.modules.top;
    const subInst = top.nodes.find((n) => n.label === 'sub_inst');
    const inputEdge = top.edges.find((e) => e.target === subInst?.id && e.signal === 'i');
    const outputEdge = top.edges.find((e) => e.source === subInst?.id && e.signal === 'o');

    expect(inputEdge).toBeDefined();
    expect(outputEdge).toBeDefined();
  });

  it('orders modules with roots first', async () => {
    const topSv = 'module top(input i, output o); A a_inst(i, o); endmodule';
    const aSv = 'module A(input i, output o); assign o = i; endmodule';
    const bSv = 'module B(input i, output o); assign o = ~i; endmodule';
    const graph = await runParser(backend, [
      { file: 'top.sv', text: topSv },
      { file: 'a.sv', text: aSv },
      { file: 'b.sv', text: bSv }
    ]);

    // Check that rootModules contains only the uninstantiated modules ('top', 'B')
    // and that the overall keys are ordered with roots first, then dependencies.
    // E.g., 'top', 'A', 'B' OR 'B', 'top', 'A' (as long as 'top' is before 'A')
    const keys = Object.keys(graph.modules);
    
    // The roots should be 'top' and 'B' (since neither is instantiated)
    expect(graph.rootModules).toContain('top');
    expect(graph.rootModules).toContain('B');
    
    // 'A' must appear AFTER 'top' because it's instantiated by 'top'
    const indexOfTop = keys.indexOf('top');
    const indexOfA = keys.indexOf('A');
    expect(indexOfTop).toBeLessThan(indexOfA);
  });
});
