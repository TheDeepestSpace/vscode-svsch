import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractDesignFromText } from '../../src/parser/textExtractor';

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

describe('extractDesignFromText', () => {
  it('extracts modules, instances, registers, muxes, and ports', () => {
    const graph = extractDesignFromText([{ file: 'simple.sv', text: fixture('simple.sv') }]);

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
    expect(top.edges.some((edge) => edge.source === 'instance:top:u_child' && edge.target === 'port:top:y')).toBe(true);
    expect(graph.diagnostics.some((diagnostic) => diagnostic.message.includes('top.y has multiple diagram drivers'))).toBe(true);
  });

  it('represents unsupported constructs as unknown blocks', () => {
    const graph = extractDesignFromText([{ file: 'unknown.sv', text: fixture('unknown.sv') }]);
    const complex = graph.modules.complex;

    expect(complex.nodes.some((node) => node.kind === 'unknown' && node.label === 'generate')).toBe(true);
    expect(complex.nodes.some((node) => node.kind === 'unknown' && node.label === 'initial')).toBe(true);
  });

  it('extracts a clean single-driver fixture without multi-driver diagnostics', () => {
    const graph = extractDesignFromText([{ file: 'simple_clean.sv', text: fixture('simple_clean.sv') }]);
    const top = graph.modules.top_clean;

    expect(top.edges.some((edge) => edge.source.startsWith('mux:top_clean:') && edge.target === 'port:top_clean:y')).toBe(true);
    expect(top.edges.some((edge) => edge.source.startsWith('mux:top_clean:') && edge.target === 'instance:top_clean:u_child' && edge.targetPort === 'port:y')).toBe(true);
    expect(top.edges.some((edge) => edge.source === 'port:top_clean:y' && edge.target === 'instance:top_clean:u_child')).toBe(false);
    expect(graph.diagnostics.some((diagnostic) => diagnostic.message.includes('multiple diagram drivers'))).toBe(false);
  });

  it('keeps simple mux ids stable when unrelated source text is inserted before the case', () => {
    const original = extractDesignFromText([{ file: 'simple_clean.sv', text: fixture('simple_clean.sv') }]);
    const editedText = fixture('simple_clean.sv').replace(
      '  logic q;',
      '  logic q;\n  logic c;\n  logic c_q;'
    );
    const edited = extractDesignFromText([{ file: 'simple_clean.sv', text: editedText }]);
    const originalMux = original.modules.top_clean.nodes.find((node) => node.kind === 'mux');
    const editedMux = edited.modules.top_clean.nodes.find((node) => node.kind === 'mux');

    expect(originalMux?.id).toBe('mux:top_clean:y:sel');
    expect(editedMux?.id).toBe(originalMux?.id);
  });

  it('connects register outputs into downstream register inputs', () => {
    const graph = extractDesignFromText([{ file: 'reg_chain.sv', text: fixture('reg_chain.sv') }]);
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

  it('keeps simple continuous assignments as wires and promotes expressions to combinational blocks', () => {
    const graph = extractDesignFromText([{ file: 'comb_assigns.sv', text: fixture('comb_assigns.sv') }]);
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

  it('does not crash on malformed source', () => {
    const graph = extractDesignFromText([{ file: 'bad.sv', text: 'module broken(input logic a); always_ff @(' }]);

    expect(graph.modules.broken).toBeDefined();
    expect(graph.diagnostics).toEqual([]);
  });
});
