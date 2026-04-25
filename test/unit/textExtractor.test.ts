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
    expect(top.edges.some((edge) => edge.source === 'port:top_clean:y' && edge.target === 'instance:top_clean:u_child')).toBe(true);
    expect(graph.diagnostics.some((diagnostic) => diagnostic.message.includes('multiple diagram drivers'))).toBe(false);
  });

  it('does not crash on malformed source', () => {
    const graph = extractDesignFromText([{ file: 'bad.sv', text: 'module broken(input logic a); always_ff @(' }]);

    expect(graph.modules.broken).toBeDefined();
    expect(graph.diagnostics).toEqual([]);
  });
});
