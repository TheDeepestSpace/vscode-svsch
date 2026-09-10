import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runParser } from '../helper';
import { expectMuxSelector } from './helpers';
import type { DesignModule, DiagramNode } from '../../src/ir/types';

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

async function proceduralIfFixtureGraph(backend: 'uhdm') {
  return runParser(backend, 'procedural_ifs.sv', fixture('procedural_ifs.sv'));
}

function muxesSelectedBy(module: DesignModule, selector: string): DiagramNode[] {
  return module.nodes.filter(
    (node) =>
      node.kind === 'mux' &&
      node.ports.some((port) => port.name === 'sel' && port.connectedSignal === selector),
  );
}

function expectMuxInput(
  module: DesignModule,
  mux: DiagramNode | undefined,
  signal: string,
  label?: string,
): void {
  expect(mux).toBeDefined();
  expect(
    mux?.ports.some(
      (port) =>
        port.direction === 'input' &&
        port.name !== 'sel' &&
        port.connectedSignal === signal &&
        (label === undefined || port.label === label),
    ),
  ).toBe(true);
  expect(module.edges.some((edge) => edge.target === mux?.id && edge.signal === signal)).toBe(true);
}

function expectMuxOutput(module: DesignModule, mux: DiagramNode | undefined, signal: string): void {
  expect(mux).toBeDefined();
  expect(
    mux?.ports.some(
      (port) =>
        port.direction === 'output' && port.name === 'out' && port.connectedSignal === signal,
    ),
  ).toBe(true);
  expect(module.edges.some((edge) => edge.source === mux?.id && edge.signal === signal)).toBe(true);
}

function regionNodes(module: DesignModule, blockLabel: string): DiagramNode[] {
  const region = module.generateRegions?.find((candidate) => candidate.blockLabel === blockLabel);
  expect(region, `generate region ${blockLabel}`).toBeDefined();
  expect(region?.nodeIds, `generate region ${blockLabel} nodeIds`).toBeDefined();
  return (region?.nodeIds ?? [])
    .map((id) => module.nodes.find((node) => node.id === id))
    .filter((node): node is DiagramNode => node !== undefined);
}

function generatedInstance(
  module: DesignModule,
  blockLabel: string,
  instanceName: string,
): DiagramNode | undefined {
  return regionNodes(module, blockLabel).find(
    (node) =>
      node.kind === 'instance' &&
      (node.label === instanceName || node.label.endsWith(`.${instanceName}`)),
  );
}

function expectEdge(module: DesignModule, source: string, target: string, signal: string): void {
  expect(
    module.edges.some(
      (edge) => edge.source === source && edge.target === target && edge.signal === signal,
    ),
    `edge ${source} -> ${target} carrying ${signal}`,
  ).toBe(true);
}

describe.each(['uhdm'] as const)('parser backend: %s', (backend) => {
  it('extracts function calls and their combinational callable bodies', async () => {
    const graph = await runParser(backend, 'function_call.sv', fixture('function_call.sv'));

    const call = graph.modules.function_call.nodes.find((node) => node.kind === 'funcCall');
    expect(call).toMatchObject({
      kind: 'funcCall',
      label: 'foo',
      functionId: 'function_call.foo',
      functionName: 'foo',
    });
    expect(call?.ports.map((port) => [port.name, port.direction, port.width])).toEqual([
      ['lhs', 'input', '[7:0]'],
      ['rhs', 'input', '[7:0]'],
      ['foo', 'output', '[7:0]'],
    ]);

    const body = graph.functions?.['function_call.foo'];
    expect(body).toMatchObject({
      parentModule: 'function_call',
      callableName: 'foo',
      callableKind: 'function',
    });
    expect(body?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'alu', operation: '+' })]),
    );
    expect(body?.ports.map((port) => [port.name, port.direction, port.width])).toEqual([
      ['lhs', 'input', '[7:0]'],
      ['rhs', 'input', '[7:0]'],
      ['foo', 'output', '[7:0]'],
    ]);
  });

  it('extracts modules, instances, registers, muxes, and ports', async () => {
    const graph = await runParser(backend, 'simple.sv', fixture('simple.sv'));

    expect(Object.keys(graph.modules).sort()).toEqual(['child', 'top']);
    expect(graph.rootModules).toEqual(['top']);

    const top = graph.modules.top;
    expect(top.nodes.some((node) => node.kind === 'instance' && node.label === 'u_child')).toBe(
      true,
    );
    expect(top.nodes.some((node) => node.kind === 'register' && node.label === 'q')).toBe(true);
    expect(top.nodes.some((node) => node.kind === 'mux' && node.label === 'case sel')).toBe(true);
    expect(top.nodes.filter((node) => node.kind === 'port').map((node) => node.label)).toContain(
      'clk',
    );
    expect(
      top.edges.some(
        (edge) =>
          edge.source === 'port:top:a' && edge.target === 'reg:top:q' && edge.targetPort === 'd',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === 'port:top:clk' &&
          edge.target === 'reg:top:q' &&
          edge.targetPort === 'clk',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) => edge.source === 'port:top:sel' && edge.target.startsWith('mux:top:'),
      ),
    ).toBe(true);
    expect(
      top.edges.some((edge) => edge.source === 'port:top:b' && edge.target.startsWith('mux:top:')),
    ).toBe(true);
    expect(
      top.edges.some((edge) => edge.source.startsWith('mux:top:') && edge.target === 'port:top:y'),
    ).toBe(true);
    const mux = top.nodes.find((node) => node.kind === 'mux');
    expect(mux?.ports.find((port) => port.label === "1'b0")?.connectedSignal).toBe('a');
    expect(mux?.ports.find((port) => port.label === 'default')?.connectedSignal).toBe('b');
    expect(
      top.edges.some(
        (edge) => edge.source === 'instance:top:u_child' && edge.target === 'port:top:y',
      ),
    ).toBe(true);
    expect(
      graph.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('top.y has multiple diagram drivers'),
      ),
    ).toBe(true);
  });

  it('represents unsupported constructs as unknown blocks', async () => {
    const graph = await runParser(backend, 'unknown.sv', fixture('unknown.sv'));
    const complex = graph.modules.complex;

    if (backend !== 'uhdm') {
      expect(
        complex.nodes.some((node) => node.kind === 'unknown' && node.label === 'generate'),
      ).toBe(true);
    }
    expect(complex.nodes.some((node) => node.kind === 'unknown' && node.label === 'initial')).toBe(
      true,
    );
  });

  it('extracts source-side generate if and case regions with block labels', async () => {
    const graph = await runParser(backend, 'generate_regions.sv', fixture('generate_regions.sv'));

    const regions = graph.modules.generate_regions.generateRegions ?? [];
    expect(regions.map((region) => region.blockLabel)).toEqual(
      expect.arrayContaining([
        'g_if_zero',
        'g_if_one',
        'g_if_other',
        'g_case_0',
        'g_case_1',
        'g_case_default',
      ]),
    );

    const ifZero = regions.find((region) => region.blockLabel === 'g_if_zero');
    const ifOne = regions.find((region) => region.blockLabel === 'g_if_one');
    const ifOther = regions.find((region) => region.blockLabel === 'g_if_other');
    expect(ifZero?.kind).toBe('if');
    expect(ifOne?.kind).toBe('else-if');
    expect(ifOther?.kind).toBe('else');
    expect(ifZero?.condition).toContain('ENABLE == 0');
    expect(ifOne?.condition).toContain('ENABLE == 1');
    expect(ifOne?.siblingGroupId).toBe(ifZero?.siblingGroupId);
    expect(ifOther?.siblingGroupId).toBe(ifZero?.siblingGroupId);
    expect(ifOne?.label).toContain('g_if_one');

    // The synthesized generate-block wrappers parent their arms: the top-level "generate
    // if" wrapper holds the if arms, and a "generate case" wrapper (nested under g_if_one)
    // holds the case arms.
    const ifBlock = regions.find((region) => region.isGenerateBlock && !region.parentRegionId);
    expect(ifBlock?.label).toBe('generate if');
    expect(ifZero?.parentRegionId).toBe(ifBlock?.id);
    expect(ifOne?.parentRegionId).toBe(ifBlock?.id);

    const caseBlock = regions.find(
      (region) => region.isGenerateBlock && region.parentRegionId === ifOne?.id,
    );
    expect(caseBlock?.label).toBe('generate case (MODE)');

    const case0 = regions.find((region) => region.blockLabel === 'g_case_0');
    const case1 = regions.find((region) => region.blockLabel === 'g_case_1');
    const caseDefault = regions.find((region) => region.blockLabel === 'g_case_default');
    expect(case0?.parentRegionId).toBe(caseBlock?.id);
    expect(case1?.parentRegionId).toBe(caseBlock?.id);
    expect(caseDefault?.parentRegionId).toBe(caseBlock?.id);
    expect(case0?.condition).toContain('MODE == 0');
    expect(case1?.condition).toContain('MODE == 1');
    expect(caseDefault?.kind).toBe('case-default');
    expect(caseDefault?.condition).toBe('default');
  });

  it('extracts schematic blocks and external connections for every generate arm', async () => {
    const graph = await runParser(backend, 'generate_regions.sv', fixture('generate_regions.sv'));
    const module = graph.modules.generate_regions;

    expect(
      module.nodes.some(
        (node) =>
          node.kind === 'comb' &&
          node.ports.some((port) => port.direction === 'input' && port.connectedSignal === 'w') &&
          node.ports.some((port) => port.direction === 'output' && port.connectedSignal === 'y'),
      ),
      'top-level assign y = w should collapse to direct wires',
    ).toBe(false);
    expect(module.nodes.find((node) => node.id === 'port:generate_regions:y')).toBeDefined();

    const ifZero = generatedInstance(module, 'g_if_zero', 'u_zero');
    const case0 = generatedInstance(module, 'g_case_0', 'u_case_0');
    const case1 = generatedInstance(module, 'g_case_1', 'u_case_1');
    expect(ifZero?.instanceOf).toBe('leaf');
    expect(case0?.instanceOf).toBe('leaf');
    expect(case1?.instanceOf).toBe('leaf');
    expect(
      module.generateRegions?.find((region) => region.blockLabel === 'g_if_one')?.activeState,
    ).toBe('active');
    expect(
      module.generateRegions?.find((region) => region.blockLabel === 'g_if_zero')?.activeState,
    ).toBe('inactive');
    expect(
      module.generateRegions?.find((region) => region.blockLabel === 'g_case_1')?.activeState,
    ).toBe('active');
    expect(
      module.generateRegions?.find((region) => region.blockLabel === 'g_case_0')?.activeState,
    ).toBe('inactive');

    const caseDefault = regionNodes(module, 'g_case_default').find(
      (node) =>
        node.kind === 'comb' &&
        node.ports.some((port) => port.direction === 'input' && port.connectedSignal === 'c') &&
        node.ports.some((port) => port.direction === 'output' && port.connectedSignal === 'w'),
    );
    const ifOther = regionNodes(module, 'g_if_other').find(
      (node) =>
        (node.kind === 'literal' || node.kind === 'comb') &&
        node.ports.some((port) => port.direction === 'output' && port.connectedSignal === 'w'),
    );
    expect(caseDefault, 'default arm assignment w = c').toBeDefined();
    expect(ifOther, "else arm assignment w = 1'b0").toBeDefined();

    expectEdge(module, 'port:generate_regions:a', ifZero!.id, 'a');
    expectEdge(module, 'port:generate_regions:a', case0!.id, 'a');
    expectEdge(module, 'port:generate_regions:b', case1!.id, 'b');
    expectEdge(module, 'port:generate_regions:c', caseDefault!.id, 'c');

    for (const armDriver of [ifZero, case0, case1, caseDefault, ifOther]) {
      expectEdge(module, armDriver!.id, 'port:generate_regions:y', 'y');
      expect(
        armDriver?.metadata?.generateRegionId,
        `${armDriver?.id} generate metadata`,
      ).toBeDefined();
    }

    expect(
      graph.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('generate_regions.y has multiple diagram drivers'),
      ),
    ).toEqual([]);
  });

  it('connects operands of expression assignments inside generate arms', async () => {
    const graph = await runParser(backend, [
      {
        file: 'generate_expression_assign.sv',
        text: `
        module leaf(input logic a, output logic y);
          assign y = a;
        endmodule

        module generate_expression_assign #(parameter MODE = 1) (
          input logic a,
          input logic b,
          input logic sel,
          output logic y
        );
          generate
            if (MODE == 1) begin : g_if_one
              logic left_tap;
              logic right_tap;

              leaf u_path_a(.a(a), .y(left_tap));
              leaf u_path_b(.a(b), .y(right_tap));
              assign y = sel ? left_tap : right_tap;
            end else begin : g_if_other
              assign y = b;
            end
          endgenerate
        endmodule
      `,
      },
    ]);

    const module = graph.modules.generate_expression_assign;
    const pathA = generatedInstance(module, 'g_if_one', 'u_path_a');
    const pathB = generatedInstance(module, 'g_if_one', 'u_path_b');
    const expr = regionNodes(module, 'g_if_one').find(
      (node) =>
        node.kind === 'mux' &&
        node.ports.some((port) => port.direction === 'input' && port.connectedSignal === 'sel') &&
        node.ports.some(
          (port) => port.direction === 'input' && port.connectedSignal === 'left_tap',
        ) &&
        node.ports.some(
          (port) => port.direction === 'input' && port.connectedSignal === 'right_tap',
        ) &&
        node.ports.some((port) => port.direction === 'output' && port.connectedSignal === 'y'),
    );

    expect(pathA, 'left generated leaf instance').toBeDefined();
    expect(pathB, 'right generated leaf instance').toBeDefined();
    expect(expr, 'generate ternary assignment expression').toBeDefined();
    expect(expr?.ports.find((port) => port.direction === 'output')?.name).toBe('out');

    expectEdge(module, 'port:generate_expression_assign:a', pathA!.id, 'a');
    expectEdge(module, 'port:generate_expression_assign:b', pathB!.id, 'b');
    expectEdge(module, pathA!.id, expr!.id, 'left_tap');
    expectEdge(module, pathB!.id, expr!.id, 'right_tap');
    expectEdge(module, 'port:generate_expression_assign:sel', expr!.id, 'sel');
    expectEdge(module, expr!.id, 'port:generate_expression_assign:y', 'y');
  });

  it.skip('extracts a clean single-driver fixture without multi-driver diagnostics', async () => {
    const graph = await runParser(backend, 'simple_clean.sv', fixture('simple_clean.sv'));
    const top = graph.modules.top_clean;

    expect(
      top.edges.some(
        (edge) => edge.source.startsWith('mux:top_clean:') && edge.target === 'port:top_clean:y',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source.startsWith('mux:top_clean:') &&
          edge.target === 'instance:top_clean:u_child' &&
          edge.targetPort === 'port:y',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === 'port:top_clean:y' && edge.target === 'instance:top_clean:u_child',
      ),
    ).toBe(false);
    expect(
      graph.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('multiple diagram drivers'),
      ),
    ).toBe(false);
  });

  it(
    'keeps simple mux ids stable when unrelated source text is inserted ' + 'before the case',
    async () => {
      const original = await runParser(backend, 'simple_clean.sv', fixture('simple_clean.sv'));
      const editedText = fixture('simple_clean.sv').replace(
        '  logic q;',
        '  logic q;\n  logic c;\n  logic c_q;',
      );
      const edited = await runParser(backend, [{ file: 'simple_clean.sv', text: editedText }]);
      const originalMux = original.modules.top_clean.nodes.find((node) => node.kind === 'mux');
      const editedMux = edited.modules.top_clean.nodes.find((node) => node.kind === 'mux');

      expect(originalMux?.id).toBe('mux:top_clean:y:sel:y');

      expect(editedMux?.id).toBe(originalMux?.id);
    },
  );

  it('connects register outputs into downstream register inputs', async () => {
    const graph = await runParser(backend, 'reg_chain.sv', fixture('reg_chain.sv'));
    const regChain = graph.modules.reg_chain;

    expect(regChain.nodes.some((node) => node.id === 'reg:reg_chain:a_q')).toBe(true);
    expect(regChain.nodes.some((node) => node.id === 'reg:reg_chain:b_q')).toBe(true);
    const comb = regChain.nodes.find(
      (node) =>
        node.kind === 'gate' && node.id.includes(backend === 'uhdm' ? 'b_q_next' : 'c_and_d'),
    );
    expect(comb?.label).toBe('');
    expect(comb?.metadata?.operation).toBe('and');
    if (backend === 'uhdm') {
      expect(comb?.ports.map((port) => port.connectedSignal).sort()).toEqual([
        'a_q',
        'b_q_next',
        'c',
        'd',
      ]);
    } else {
      expect(comb?.ports.map((port) => port.connectedSignal).sort()).toEqual([
        'a_q',
        'b_q',
        'c',
        'd',
      ]);
    }
    expect(
      regChain.edges.some(
        (edge) =>
          edge.source === 'reg:reg_chain:a_q' && edge.target === comb?.id && edge.signal === 'a_q',
      ),
    ).toBe(true);
    expect(
      regChain.edges.some(
        (edge) =>
          edge.source === 'port:reg_chain:c' && edge.target === comb?.id && edge.signal === 'c',
      ),
    ).toBe(true);
    expect(
      regChain.edges.some(
        (edge) =>
          edge.source === 'port:reg_chain:d' && edge.target === comb?.id && edge.signal === 'd',
      ),
    ).toBe(true);
    expect(
      regChain.edges.some(
        (edge) =>
          edge.source === comb?.id &&
          edge.target === 'reg:reg_chain:b_q' &&
          edge.targetPort === 'd' &&
          (edge.signal === 'b_q' || edge.signal === 'b_q_next'),
      ),
    ).toBe(true);
    expect(
      regChain.edges.some(
        (edge) =>
          edge.source === 'reg:reg_chain:b_q' &&
          edge.sourcePort === 'q' &&
          edge.target === 'port:reg_chain:y' &&
          (edge.signal === 'b_q' || edge.signal === 'y'),
      ),
    ).toBe(true);
  });

  it('infers clock and reset semantics for async and sync always_ff registers', async () => {
    const graph = await runParser(backend, 'register_resets.sv', fixture('register_resets.sv'));
    const module = graph.modules.reg_resets;
    const asyncLow = module.nodes.find((node) => node.id === 'reg:reg_resets:q_async_low');
    const asyncHigh = module.nodes.find((node) => node.id === 'reg:reg_resets:q_async_high');
    const syncHigh = module.nodes.find((node) => node.id === 'reg:reg_resets:q_sync_high');

    if (backend === 'uhdm') {
      expect(asyncLow?.ports.map((port) => port.name).sort()).toEqual(
        ['D', 'Q', 'c_main', 'rst_n'].sort(),
      );
      expect(asyncHigh?.ports.map((port) => port.name).sort()).toEqual(
        ['D', 'Q', 'c_main', 'rst'].sort(),
      );
      expect(syncHigh?.ports.map((port) => port.name).sort()).toEqual(
        ['D', 'Q', 'c_main', 'rst'].sort(),
      );
    } else {
      expect(asyncLow?.ports.map((port) => port.name)).toEqual(['D', 'Q', 'c_main', 'rst_n']);
      expect(asyncHigh?.ports.map((port) => port.name)).toEqual(['D', 'Q', 'c_main', 'rst']);
      expect(syncHigh?.ports.map((port) => port.name)).toEqual(['D', 'Q', 'c_main', 'rst']);
    }
    expect(asyncLow?.metadata?.resetKind).toBe('async');
    expect(asyncLow?.metadata?.resetActiveLow).toBe(true);
    expect(asyncHigh?.metadata?.resetKind).toBe('async');
    expect(asyncHigh?.metadata?.resetActiveLow).toBe(false);
    expect(syncHigh?.metadata?.resetKind).toBe('sync');
    expect(syncHigh?.metadata?.resetActiveLow).toBe(false);
    if (backend === 'uhdm') {
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:c_main' &&
            edge.target === 'reg:reg_resets:q_async_low',
        ),
      ).toBe(true);
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:rst_n' && edge.target === 'reg:reg_resets:q_async_low',
        ),
      ).toBe(true);
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:rst' && edge.target === 'reg:reg_resets:q_async_high',
        ),
      ).toBe(true);
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:rst' && edge.target === 'reg:reg_resets:q_sync_high',
        ),
      ).toBe(true);
    } else {
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:c_main' &&
            edge.target === 'reg:reg_resets:q_async_low' &&
            edge.targetPort === 'clk',
        ),
      ).toBe(true);
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:rst_n' &&
            edge.target === 'reg:reg_resets:q_async_low' &&
            edge.targetPort === 'reset',
        ),
      ).toBe(true);
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:rst' &&
            edge.target === 'reg:reg_resets:q_async_high' &&
            edge.targetPort === 'reset',
        ),
      ).toBe(true);
      expect(
        module.edges.some(
          (edge) =>
            edge.source === 'port:reg_resets:rst' &&
            edge.target === 'reg:reg_resets:q_sync_high' &&
            edge.targetPort === 'reset',
        ),
      ).toBe(true);
    }
  });

  it('deduplicates literals like IDLE in FSMs and ensures all usages are connected', async () => {
    const graph = await runParser(backend, 'fsm_literal.sv', fixture('fsm_literal.sv'));
    const mod = graph.modules.fsm_literal;

    const idleNodes = mod.nodes.filter((n) => n.kind === 'literal' && n.label === 'IDLE');
    expect(idleNodes).toHaveLength(1);
    const idleNode = idleNodes[0];

    const startNodes = mod.nodes.filter((n) => n.kind === 'literal' && n.label === 'START');
    expect(startNodes).toHaveLength(1);

    // 1. Check reset value connection for state_reg
    const stateReg = mod.nodes.find((n) => n.id === 'reg:fsm_literal:state_reg');
    expect(stateReg).toBeDefined();
    const resetValEdge = mod.edges.find((e) => e.target === stateReg?.id && e.targetPort === 'rv');
    expect(resetValEdge).toBeDefined();
    expect(resetValEdge?.source).toBe(idleNode.id);

    // 2. Check mux connections for next_state
    const nextStateMux = mod.nodes.find((n) => n.kind === 'mux');
    expect(nextStateMux).toBeDefined();

    // DONE branch: next_state = IDLE
    const doneEdge = mod.edges.find(
      (e) => e.target === nextStateMux?.id && e.targetPort.includes('DONE'),
    );
    expect(doneEdge).toBeDefined();
    expect(doneEdge?.source).toBe(idleNode.id);

    // default branch: next_state = IDLE
    const defaultEdge = mod.edges.find(
      (e) => e.target === nextStateMux?.id && e.targetPort.includes('default'),
    );
    expect(defaultEdge).toBeDefined();
    expect(defaultEdge?.source).toBe(idleNode.id);
  });

  it('extracts module port widths correctly', async () => {
    const graph = await runParser(backend, [
      {
        file: 'width_test.sv',
        text: `
      module width_test (input logic [3:0] a, output logic [7:0] y);
        assign y = {a, a};
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.width_test;
    expect(mod).toBeDefined();

    const portA = mod.ports.find((p) => p.name === 'a');
    const portY = mod.ports.find((p) => p.name === 'y');

    expect(portA?.width).toBe('[3:0]');
    expect(portY?.width).toBe('[7:0]');
  });

  it('extracts parameter declarations and symbolic port width references from UHDM', async () => {
    const graph = await runParser(backend, [
      {
        file: 'parameter_sizing.sv',
        text: `
      module parameter_sizing #(
        parameter WIDTH = 8,
        parameter ADDR_W = 3,
        localparam DATA_W = WIDTH
      ) (
        input logic [WIDTH-1:0] x,
        output logic [ADDR_W+DATA_W-1:0] y
      );
        assign y = {{ADDR_W{x[0]}}, x};
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.parameter_sizing;

    expect(mod.parameters?.map((param) => [param.kind, param.name])).toEqual(
      expect.arrayContaining([
        ['parameter', 'WIDTH'],
        ['parameter', 'ADDR_W'],
        ['localparam', 'DATA_W'],
      ]),
    );

    const portX = mod.ports.find((port) => port.name === 'x');
    const portY = mod.ports.find((port) => port.name === 'y');

    expect(portX?.width).toBeTruthy();
    expect(portX?.widthExpression).toContain('WIDTH');
    expect(portX?.parameterRefs?.map((ref) => ref.name)).toContain('WIDTH');
    expect(
      portX?.parameterRefs?.find((ref) => ref.name === 'WIDTH')?.declarationSource,
    ).toMatchObject({
      file: 'parameter_sizing.sv',
    });

    expect(portY?.widthExpression).toContain('ADDR_W');
    expect(portY?.parameterRefs?.map((ref) => ref.name)).toEqual(
      expect.arrayContaining(['ADDR_W', 'DATA_W']),
    );
  });

  it(
    'extracts instance parameter values and preserves explicit override ' + 'expressions from UHDM',
    async () => {
      const graph = await runParser(backend, [
        {
          file: 'instance_params.sv',
          text: `
      module child #(parameter WIDTH = 8, parameter DEPTH = 4) (
        input logic [WIDTH-1:0] a,
        output logic [WIDTH-1:0] y
      );
        assign y = a;
      endmodule

      module top #(parameter TOP_W = 12) (
        input logic [7:0] a,
        input logic [TOP_W-1:0] b,
        output logic [7:0] y0,
        output logic [TOP_W-1:0] y1
      );
        localparam LOCAL_DEPTH = 2;
        child u_default(.a(a), .y(y0));
        child #(.WIDTH(TOP_W), .DEPTH(LOCAL_DEPTH)) u_override(.a(b), .y(y1));
      endmodule
    `,
        },
      ]);
      const top = graph.modules.top;
      const uDefault = top.nodes.find(
        (node) => node.kind === 'instance' && node.label === 'u_default',
      );
      const uOverride = top.nodes.find(
        (node) => node.kind === 'instance' && node.label === 'u_override',
      );

      expect(
        uDefault?.metadata?.instanceParameters?.map((param) => [param.name, param.value]),
      ).toEqual(
        expect.arrayContaining([
          ['WIDTH', '8'],
          ['DEPTH', '4'],
        ]),
      );
      expect(
        uOverride?.metadata?.instanceParameters?.map((param) => [param.name, param.value]),
      ).toEqual(
        expect.arrayContaining([
          ['WIDTH', 'TOP_W'],
          ['DEPTH', 'LOCAL_DEPTH'],
        ]),
      );
      expect(
        uOverride?.metadata?.instanceParameters
          ?.find((param) => param.name === 'DEPTH')
          ?.parameterRefs?.map((ref) => ref.name),
      ).toContain('LOCAL_DEPTH');
    },
  );

  it(
    'keeps simple continuous assignments as wires and promotes expressions ' +
      'to combinational blocks',
    async () => {
      const graph = await runParser(backend, 'comb_assigns.sv', fixture('comb_assigns.sv'));

      const assignWire = graph.modules.assign_wire;
      const assignAnd = graph.modules.assign_and;
      const assignConstExpr = graph.modules.assign_const_expr;
      const assignCombChain = graph.modules.assign_comb_chain;

      expect(assignWire.nodes.some((node) => node.kind === 'unknown')).toBe(false);
      expect(
        assignWire.edges.some(
          (edge) =>
            edge.source === 'port:assign_wire:a' &&
            edge.target === 'port:assign_wire:y' &&
            (edge.signal === 'a' || edge.signal === 'y'),
        ),
      ).toBe(true);

      const andBlock = assignAnd.nodes.find((node) => node.kind === 'gate');
      expect(andBlock?.label).toBe('');
      expect(andBlock?.metadata?.operation).toBe('and');
      expect(andBlock?.ports.map((port) => port.connectedSignal).sort()).toEqual(['a', 'b', 'y']);
      expect(
        assignAnd.edges.some(
          (edge) => edge.source === 'port:assign_and:a' && edge.target === andBlock?.id,
        ),
      ).toBe(true);
      expect(
        assignAnd.edges.some(
          (edge) => edge.source === 'port:assign_and:b' && edge.target === andBlock?.id,
        ),
      ).toBe(true);
      expect(
        assignAnd.edges.some(
          (edge) => edge.source === andBlock?.id && edge.target === 'port:assign_and:y',
        ),
      ).toBe(true);

      // `a | '0` is a 2-input OR gate now, not a comb blob.
      const constBlock = assignConstExpr.nodes.find((node) => node.kind === 'gate');
      expect(constBlock?.label).toBe('');
      expect(constBlock?.metadata?.operation).toBe('or');
      expect(constBlock?.ports.map((port) => port.connectedSignal).sort()).toEqual([
        "'0",
        'a',
        'y',
      ]);
      expect(
        assignConstExpr.edges.some(
          (edge) => edge.source === 'port:assign_const_expr:a' && edge.target === constBlock?.id,
        ),
      ).toBe(true);
      expect(
        assignConstExpr.edges.some(
          (edge) => edge.source === constBlock?.id && edge.target === 'port:assign_const_expr:y',
        ),
      ).toBe(true);

      // `y = mid | a & c` parses as `mid | (a & c)` (`&` binds tighter than `|`),
      // two different operators, so this is 3 gates: AND(a,b)->mid, AND(a,c) (an
      // anonymous leaf), and OR(mid, that AND)->y — never a single flattened node.
      const chainGates = assignCombChain.nodes.filter((node) => node.kind === 'gate');
      const midBlock = chainGates.find((node) =>
        node.ports.some((port) => port.direction === 'output' && port.name === 'mid'),
      );
      const yBlock = chainGates.find((node) => node.metadata?.operation === 'or');
      const acBlock = chainGates.find((node) => node !== midBlock && node !== yBlock);
      expect(chainGates).toHaveLength(3);
      expect(midBlock?.metadata?.operation).toBe('and');
      expect(midBlock?.ports.map((port) => port.connectedSignal).sort()).toEqual(['a', 'b', 'mid']);
      expect(acBlock?.metadata?.operation).toBe('and');
      expect(
        acBlock?.ports
          .filter((port) => port.direction === 'input')
          .map((port) => port.connectedSignal)
          .sort(),
      ).toEqual(['a', 'c']);
      expect(yBlock?.ports.map((port) => port.connectedSignal)).toContain('mid');
      expect(yBlock?.ports.map((port) => port.connectedSignal)).toContain('y');
      expect(
        assignCombChain.edges.some(
          (edge) =>
            edge.source === midBlock?.id && edge.target === yBlock?.id && edge.signal === 'mid',
        ),
      ).toBe(true);
      expect(
        assignCombChain.edges.some(
          (edge) => edge.source === acBlock?.id && edge.target === yBlock?.id,
        ),
      ).toBe(true);
    },
  );

  it('promotes ternary expressions to recursively connected muxes', async () => {
    const graph = await runParser(backend, [
      {
        file: 'ternary_muxes.sv',
        text: `
      module ternary_simple(input logic sel, a, b, output logic y);
        assign y = sel ? a : b;
      endmodule

      module ternary_nested(input logic sel1, sel2, a, b, c, output logic y);
        assign y = sel1 ? (sel2 ? a : b) : c;
      endmodule

      module ternary_in_alu(input logic sel, a, b, c, output logic y);
        assign y = a + (sel ? b : c);
      endmodule

      module ternary_array(
        input logic sel,
        input logic [7:0] a [0:1],
        input logic [7:0] b [0:1],
        output logic [7:0] y [0:1]
      );
        assign y = sel ? a : b;
      endmodule
    `,
      },
    ]);

    const simple = graph.modules.ternary_simple;
    const simpleMux = muxesSelectedBy(simple, 'sel')[0];
    expect(simple.nodes.filter((node) => node.kind === 'mux')).toHaveLength(1);
    expectMuxInput(simple, simpleMux, 'a', "1'b1");
    expectMuxInput(simple, simpleMux, 'b', "1'b0");
    expectMuxSelector(simple, simpleMux, 'sel');
    expectMuxOutput(simple, simpleMux, 'y');
    expect(simple.nodes.some((node) => node.kind === 'comb')).toBe(false);

    const nested = graph.modules.ternary_nested;
    const outerMux = muxesSelectedBy(nested, 'sel1')[0];
    const innerMux = muxesSelectedBy(nested, 'sel2')[0];
    expect(nested.nodes.filter((node) => node.kind === 'mux')).toHaveLength(2);
    expectMuxInput(nested, innerMux, 'a', "1'b1");
    expectMuxInput(nested, innerMux, 'b', "1'b0");
    expectMuxInput(nested, outerMux, 'c', "1'b0");
    expectMuxSelector(nested, outerMux, 'sel1');
    expectMuxSelector(nested, innerMux, 'sel2');
    expect(
      nested.edges.some((edge) => edge.source === innerMux?.id && edge.target === outerMux?.id),
    ).toBe(true);

    const embedded = graph.modules.ternary_in_alu;
    const embeddedMux = muxesSelectedBy(embedded, 'sel')[0];
    const alu = embedded.nodes.find((node) => node.kind === 'alu');
    expect(embedded.nodes.filter((node) => node.kind === 'mux')).toHaveLength(1);
    expect(alu).toBeDefined();
    expect(embedded.nodes.some((node) => node.kind === 'comb')).toBe(false);
    expectMuxSelector(embedded, embeddedMux, 'sel');
    expect(
      embedded.edges.some((edge) => edge.source === embeddedMux?.id && edge.target === alu?.id),
    ).toBe(true);

    const array = graph.modules.ternary_array;
    const arrayMux = muxesSelectedBy(array, 'sel')[0];
    expect(arrayMux?.isArrayNode ?? arrayMux?.metadata?.isArrayNode).toBe(true);
    expect(arrayMux?.arrayDimension ?? arrayMux?.metadata?.arrayDimension).toBe('[0:1]');
    expect(arrayMux?.arraySize ?? arrayMux?.metadata?.arraySize).toBe(2);
  });

  it(
    'promotes unary bitwise inversions to inverter nodes for scalar and ' + 'vector signals',
    async () => {
      const graph = await runParser(backend, [
        {
          file: 'inverters.sv',
          text: `
      module inv_scalar(input logic a, output logic y);
        assign y = ~a;
      endmodule

      module inv_vector(input logic [3:0] a, output logic [3:0] y);
        assign y = ~a;
      endmodule

      module inv_proc(input logic [7:0] a, output logic [7:0] y);
        always_comb begin
          y = ~a;
        end
      endmodule
    `,
        },
      ]);

      const scalar = graph.modules.inv_scalar;
      const scalarInv = scalar.nodes.find((node) => node.kind === 'inverter');
      expect(scalar.nodes.filter((node) => node.kind === 'inverter')).toHaveLength(1);
      expect(scalar.nodes.some((node) => node.kind === 'comb')).toBe(false);
      expect(scalarInv?.metadata?.operation).toBe('~');
      expect(scalarInv?.ports.map((port) => [port.name, port.direction]).sort()).toEqual([
        ['a', 'input'],
        ['y', 'output'],
      ]);
      expect(
        scalar.edges.some(
          (edge) => edge.source === 'port:inv_scalar:a' && edge.target === scalarInv?.id,
        ),
      ).toBe(true);
      expect(
        scalar.edges.some(
          (edge) => edge.source === scalarInv?.id && edge.target === 'port:inv_scalar:y',
        ),
      ).toBe(true);

      const vector = graph.modules.inv_vector;
      const vectorInv = vector.nodes.find((node) => node.kind === 'inverter');
      const vectorInput = vectorInv?.ports.find((port) => port.direction === 'input');
      const vectorOutput = vectorInv?.ports.find((port) => port.direction === 'output');
      expect(vector.nodes.filter((node) => node.kind === 'inverter')).toHaveLength(1);
      expect(vector.nodes.some((node) => node.kind === 'comb')).toBe(false);
      expect(vectorInput?.width).toBe('[3:0]');
      expect(vectorOutput?.width).toBe('[3:0]');

      const procedural = graph.modules.inv_proc;
      const proceduralInv = procedural.nodes.find((node) => node.kind === 'inverter');
      expect(procedural.nodes.filter((node) => node.kind === 'inverter')).toHaveLength(1);
      expect(procedural.nodes.some((node) => node.kind === 'comb')).toBe(false);
      expect(proceduralInv?.ports.find((port) => port.direction === 'input')?.width).toBe('[7:0]');
      expect(proceduralInv?.ports.find((port) => port.direction === 'output')?.width).toBe('[7:0]');
    },
  );

  it(
    'promotes logical NOT to inverter for 1-bit signals but keeps it as ' +
      'comb for multi-bit and compound operands',
    async () => {
      const graph = await runParser(backend, [
        {
          file: 'logical_not.sv',
          text: `
      // 1-bit !: identical semantics to ~, should become an inverter
      module lnot_scalar(
        input logic a,
        output logic y
      );
        assign y = !a;
      endmodule

      // multi-bit !: zero-test reduction (1-bit output, 8-bit input), NOT an inverter
      module lnot_vector(
        input logic [7:0] data,
        output logic is_zero
      );
        assign is_zero = !data;
      endmodule

      // ! of a compound expression: the operand is not a simple signal ref → comb
      module lnot_expr(
        input logic a,
        input logic b,
        output logic y
      );
        assign y = !(a & b);
      endmodule

      // procedural 1-bit !: should become an inverter like the continuous case
      module lnot_proc(
        input logic n_en,
        output logic en
      );
        always_comb en = !n_en;
      endmodule
    `,
        },
      ]);

      // 1-bit scalar: must be an inverter, never a comb
      const scalar = graph.modules.lnot_scalar;
      expect(scalar.nodes.filter((n) => n.kind === 'inverter')).toHaveLength(1);
      expect(scalar.nodes.some((n) => n.kind === 'comb')).toBe(false);
      const scalarInv = scalar.nodes.find((n) => n.kind === 'inverter');
      // operation is '!' (the original SV operator), not '~'
      expect(scalarInv?.metadata?.operation).toBe('!');

      // multi-bit: must stay as a comb (logical zero-test, not a gate inversion)
      const vector = graph.modules.lnot_vector;
      expect(vector.nodes.some((n) => n.kind === 'inverter')).toBe(false);
      expect(vector.nodes.some((n) => n.kind === 'comb')).toBe(true);

      // compound operand: must stay as comb even though a and b are 1-bit
      const expr = graph.modules.lnot_expr;
      expect(expr.nodes.some((n) => n.kind === 'inverter')).toBe(false);
      expect(expr.nodes.some((n) => n.kind === 'comb')).toBe(true);

      // procedural 1-bit !: inverter
      const proc = graph.modules.lnot_proc;
      expect(proc.nodes.filter((n) => n.kind === 'inverter')).toHaveLength(1);
      expect(proc.nodes.some((n) => n.kind === 'comb')).toBe(false);
      const procInv = proc.nodes.find((n) => n.kind === 'inverter');
      expect(procInv?.metadata?.operation).toBe('!');
    },
  );

  it('promotes simple arithmetic assignments to ALU blocks but keeps chains as combs', async () => {
    const graph = await runParser(backend, [
      {
        file: 'alu_simple.sv',
        text: `
      module alu_add(input logic a, input logic b, output logic y);
        assign y = a + b;
      endmodule

      module alu_sub(input logic a, input logic b, output logic y);
        assign y = a - b;
      endmodule

      module bitwise_and(input logic a, input logic b, output logic y);
        assign y = a & b;
      endmodule

      module alu_chain(input logic a, input logic b, input logic c, output logic y);
        assign y = a + b + c;
      endmodule
    `,
      },
    ]);

    const add = graph.modules.alu_add;
    const addAlu = add.nodes.find((node) => node.kind === 'alu');
    expect(add.nodes.filter((node) => node.kind === 'alu')).toHaveLength(1);
    expect(addAlu?.metadata?.operation).toBe('+');

    const sub = graph.modules.alu_sub;
    const subAlu = sub.nodes.find((node) => node.kind === 'alu');
    expect(sub.nodes.filter((node) => node.kind === 'alu')).toHaveLength(1);
    expect(subAlu?.metadata?.operation).toBe('-');

    const bitwise = graph.modules.bitwise_and;
    expect(bitwise.nodes.some((node) => node.kind === 'alu')).toBe(false);

    const chain = graph.modules.alu_chain;
    expect(chain.nodes.filter((node) => node.kind === 'alu')).toHaveLength(0);
    expect(chain.nodes.filter((node) => node.kind === 'comb')).toHaveLength(1);
  });

  it('keeps non-arithmetic subexpressions as dedicated gate nodes feeding ALU nodes', async () => {
    const graph = await runParser(backend, [
      {
        file: 'alu_complex.sv',
        text: `
      module alu_with_comb(input logic a, input logic b, input logic c, output logic y);
        assign y = a + (b | c);
      endmodule
    `,
      },
    ]);

    const withComb = graph.modules.alu_with_comb;
    const alu = withComb.nodes.find((node) => node.kind === 'alu');
    const gate = withComb.nodes.find((node) => node.kind === 'gate');
    expect(withComb.nodes.filter((node) => node.kind === 'alu')).toHaveLength(1);
    expect(withComb.nodes.filter((node) => node.kind === 'gate')).toHaveLength(1);
    expect(withComb.nodes.filter((node) => node.kind === 'comb')).toHaveLength(0);
    expect(gate?.metadata?.operation).toBe('or');
    expect(
      withComb.edges.some(
        (edge) =>
          edge.source === 'port:alu_with_comb:a' &&
          edge.target === alu?.id &&
          edge.targetPort === 'lhs',
      ),
    ).toBe(true);
    expect(
      withComb.edges.some(
        (edge) => edge.source === gate?.id && edge.target === alu?.id && edge.targetPort === 'rhs',
      ),
    ).toBe(true);
    expect(
      withComb.edges.some(
        (edge) => edge.source === 'port:alu_with_comb:b' && edge.target === gate?.id,
      ),
    ).toBe(true);
    expect(
      withComb.edges.some(
        (edge) => edge.source === 'port:alu_with_comb:c' && edge.target === gate?.id,
      ),
    ).toBe(true);
  });

  it('represents direct literal and named constant assignments as literal nodes', async () => {
    const graph = await runParser(backend, [
      {
        file: 'literal_assigns.sv',
        text: `
      module literal_assigns(output logic [7:0] literal_y, output logic [3:0] version_y);
        localparam logic [3:0] VERSION = 4'd5;
        assign literal_y = 8'h42;
        assign version_y = VERSION;
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.literal_assigns;
    const literal = mod.nodes.find((node) => node.kind === 'literal' && node.label === "8'h42");
    const version = mod.nodes.find((node) => node.kind === 'literal' && node.label === 'VERSION');

    expect(literal).toBeDefined();
    expect(version).toBeDefined();
    expect(literal?.source).toMatchObject({
      file: 'literal_assigns.sv',
      startLine: 4,
      startColumn: 27,
      endLine: 4,
      endColumn: 32,
    });
    expect(literal?.ports.find((port) => port.direction === 'output')?.width).toBe('[7:0]');
    expect(version?.source).toMatchObject({ file: 'literal_assigns.sv', startLine: 3 });
    expect(version?.ports.find((port) => port.direction === 'output')?.width).toBe('[3:0]');
    expect(mod.nodes.some((node) => node.kind === 'comb')).toBe(false);
    expect(
      mod.edges.some(
        (edge) => edge.source === literal?.id && edge.target === 'port:literal_assigns:literal_y',
      ),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) => edge.source === version?.id && edge.target === 'port:literal_assigns:version_y',
      ),
    ).toBe(true);
  });

  it('connects instance ports whose expression is an inline bit-select or literal', async () => {
    const graph = await runParser(backend, [
      {
        file: 'inline_port_exprs.sv',
        text: `
      module sub (input logic [3:0] a, input logic [3:0] b, input logic c, inout wire [3:0] io, output logic [3:0] y);
        assign y = a + b;
      endmodule

      module top (input logic [7:0] data, inout wire [7:0] ext_bus, output logic [3:0] result);
        sub u_sub (
          .a (data[7:4]),
          .b (4'd1),
          .c (data[0]),
          .io (ext_bus[3:0]),
          .y (result)
        );
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.top;
    const instance = mod.nodes.find((node) => node.kind === 'instance' && node.label === 'u_sub');
    expect(instance).toBeDefined();

    const busNode = mod.nodes.find((node) => node.kind === 'bus' && node.label === 'data');
    expect(busNode).toBeDefined();
    expect(
      busNode?.ports.some(
        (port) => port.direction === 'output' && port.connectedSignal === 'data[7:4]',
      ),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === busNode?.id &&
          edge.target === instance?.id &&
          edge.targetPort === 'port:a' &&
          edge.signal === 'data[7:4]',
      ),
    ).toBe(true);

    const literal = mod.nodes.find((node) => node.kind === 'literal' && node.label === "4'd1");
    expect(literal).toBeDefined();
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === literal?.id &&
          edge.target === instance?.id &&
          edge.targetPort === 'port:b' &&
          edge.signal === "4'd1",
      ),
    ).toBe(true);

    expect(
      busNode?.ports.some(
        (port) => port.direction === 'output' && port.connectedSignal === 'data[0]',
      ),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === busNode?.id &&
          edge.target === instance?.id &&
          edge.targetPort === 'port:c' &&
          edge.signal === 'data[0]',
      ),
    ).toBe(true);

    const extBusNode = mod.nodes.find((node) => node.kind === 'bus' && node.label === 'ext_bus');
    expect(extBusNode).toBeDefined();
    expect(
      extBusNode?.ports.some(
        (port) => port.direction === 'output' && port.connectedSignal === 'ext_bus[3:0]',
      ),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === extBusNode?.id &&
          edge.target === instance?.id &&
          edge.targetPort === 'port:io' &&
          edge.signal === 'ext_bus[3:0]',
      ),
    ).toBe(true);
  });

  it('represents enum state literals in simple FSM reset and transition logic', async () => {
    const graph = await runParser(backend, 'fsm_literal.sv', fixture('fsm_literal.sv'));
    const mod = graph.modules.fsm_literal;
    const states = ['IDLE', 'START', 'BUSY', 'DONE'];

    for (const state of states) {
      expect(mod.nodes.some((node) => node.kind === 'literal' && node.label === state)).toBe(true);
    }

    const stateReg = mod.nodes.find(
      (node) => node.kind === 'register' && node.label === 'state_reg',
    );
    const idle = mod.nodes.find((node) => node.kind === 'literal' && node.label === 'IDLE');
    const mux = mod.nodes.find((node) => node.kind === 'mux');
    expect(stateReg).toBeDefined();
    expect(idle).toBeDefined();
    expect(stateReg?.ports.find((port) => port.name === 'D')?.width).toBe('[1:0]');
    expect(stateReg?.ports.find((port) => port.name === 'Q')?.width).toBe('[1:0]');
    expect(idle?.ports.find((port) => port.direction === 'output')?.width).toBe('[1:0]');
    expect(idle?.metadata?.typeName).toBe('state_t');
    expect(idle?.metadata?.typeSource).toMatchObject({ file: 'fsm_literal.sv', startLine: 10 });
    expect(idle?.source).toMatchObject({ file: 'fsm_literal.sv', startLine: 11 });
    expect(mux?.ports.find((port) => port.name === 'sel')?.width).toBe('[1:0]');
    expect(mux?.ports.find((port) => port.name === 'out')?.width).toBe('[1:0]');
    expect(mod.edges.some((edge) => edge.source === idle?.id && edge.target === stateReg?.id)).toBe(
      true,
    );
    expect(new Set(mux?.ports.map((port) => port.id)).size).toBe(mux?.ports.length);
    expect(new Set(mod.edges.map((edge) => edge.id)).size).toBe(mod.edges.length);
  });

  it('detects inferred latch in FSM when else is missing', async () => {
    const graph = await runParser(backend, [
      {
        file: 'fsm_latch.sv',
        text: `
      module fsm_latch (
          input logic next_state_en,
          output logic [1:0] next_state
      );
        always_comb begin
          if (next_state_en) begin
            next_state = 2'b01;
          end
        end
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.fsm_latch;
    const latch = mod.nodes.find((n) => n.kind === 'latch');
    expect(latch).toBeDefined();
    expect(latch?.label).toBe('next_state');
    expect(graph.diagnostics.some((d) => d.message.includes('inferred latch'))).toBe(true);
  });

  it('detects inferred latch in FSM when else is missing (nested)', async () => {
    const graph = await runParser(backend, [
      {
        file: 'fsm_latch_nested.sv',
        text: `
      module fsm_latch_nested (
          input logic en,
          input logic [1:0] r,
          output logic [1:0] next_r
      );
        always_comb begin
          if (en) begin
            case (r)
              2'b00: next_r = 2'b01;
              default: next_r = 2'b00;
            endcase
          end
        end
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.fsm_latch_nested;
    const latch = mod.nodes.find((n) => n.kind === 'latch');
    expect(latch).toBeDefined();
    expect(latch?.label).toBe('next_r');
  });

  it('detects inferred latch in FSM with enum and missing else', async () => {
    const graph = await runParser(backend, [
      {
        file: 'fsm_enum_latch.sv',
        text: `
      module fsm_enum_latch (
          input logic en,
          output logic [1:0] state_out
      );
        typedef enum logic [1:0] {IDLE, START, BUSY, DONE} state_t;
        state_t next_state;
        always_comb begin
          if (en) next_state = START;
        end
        assign state_out = next_state;
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.fsm_enum_latch;
    const latch = mod.nodes.find((n) => n.kind === 'latch' && n.label === 'next_state');
    expect(latch).toBeDefined();
    expect(
      graph.diagnostics.some(
        (d) =>
          d.message.includes('fsm_enum_latch.next_state') && d.message.includes('inferred latch'),
      ),
    ).toBe(true);
  });

  it('detects inferred latch in FSM with complex if condition', async () => {
    const graph = await runParser(backend, [
      {
        file: 'fsm_complex_latch.sv',
        text: `
      module fsm_complex_latch (
          input logic en,
          input logic sidekick,
          input logic [1:0] d,
          output logic [1:0] q
      );
        always_comb begin
          if (en & sidekick) q = d;
        end
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.fsm_complex_latch;
    const latch = mod.nodes.find((n) => n.kind === 'latch' && n.label === 'q');
    const mux = mod.nodes.find((n) => n.kind === 'mux');
    // `en & sidekick` now gets a dedicated gate node instead of a generic comb block.
    const gate = mod.nodes.find((n) => n.kind === 'gate');

    expect(latch).toBeDefined();
    expect(mux).toBeDefined();
    expect(gate).toBeDefined();
    expect(gate?.metadata?.operation).toBe('and');
    expect(mod.edges.some((e) => e.source === mux?.id && e.target === latch?.id)).toBe(true);
    expect(
      mod.edges.some(
        (e) => e.source === gate?.id && e.target === mux?.id && e.targetPort === 'sel',
      ),
    ).toBe(true);
  });

  it('detects inferred latch for struct field', async () => {
    const graph = await runParser(backend, [
      {
        file: 'fsm_struct_latch.sv',
        text: `
      module fsm_struct_latch (
          input logic en,
          output logic [3:0] opcode_out
      );
        typedef struct packed { logic [3:0] opcode; logic valid; } packet_t;
        packet_t pkt;
        always_comb begin
          if (en) pkt.opcode = 4'hA;
        end
        assign opcode_out = pkt.opcode;
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.fsm_struct_latch;
    const latch = mod.nodes.find((n) => n.kind === 'latch' && n.label === 'pkt.opcode');
    expect(latch).toBeDefined();
  });

  it('extracts loop nodes with correct input and output connectivity', async () => {
    const graph = await runParser(backend, 'loop_logic.sv', fixture('loop_logic.sv'));
    const mod = graph.modules.loop_logic;

    const loop = mod.nodes.find((node) => node.kind === 'loop' && node.id.includes(':11:'));
    expect(loop).toBeDefined();

    // Check output connectivity: loop should drive data_out (directly or via final signal)
    const dataOutEdge = mod.edges.find((edge) => edge.target === 'port:loop_logic:data_out');
    expect(dataOutEdge).toBeDefined();
    expect(dataOutEdge?.source).toBe(loop?.id);

    // Check input connectivity: loop should consume shift_amt
    const shiftAmtEdge = mod.edges.find(
      (edge) => edge.target === loop?.id && edge.signal === 'shift_amt',
    );
    expect(shiftAmtEdge).toBeDefined();
    expect(
      loop?.ports.some((p) => p.direction === 'input' && p.connectedSignal === 'shift_amt'),
    ).toBe(true);

    // Check input connectivity: loop should consume data_in
    expect(mod.edges.some((edge) => edge.target === loop?.id && edge.signal === 'data_in')).toBe(
      true,
    );
  });

  it('handles multi-stage procedural initialization and avoids feedback loops', async () => {
    const graph = await runParser(backend, 'multi_init_loop.sv', fixture('multi_init_loop.sv'));
    const mod = graph.modules.multi_init_loop;

    const literal = mod.nodes.find((n) => n.kind === 'literal' && n.label === "8'h01");
    const loop = mod.nodes.find((n) => n.kind === 'loop');
    const alu = mod.nodes.find((n) => n.kind === 'alu');

    expect(literal).toBeDefined();
    expect(loop).toBeDefined();
    expect(alu).toBeDefined();

    // 1. Literal should drive ALU input (via branch signal)
    const litToAlu = mod.edges.find((e) => e.source === literal?.id && e.target === alu?.id);
    expect(litToAlu).toBeDefined();

    // 2. ALU should drive loop input (via branch signal)
    const aluToLoop = mod.edges.find((e) => e.source === alu?.id && e.target === loop?.id);
    expect(aluToLoop).toBeDefined();

    // 3. Loop should drive final output
    const loopToPort = mod.edges.find(
      (e) => e.source === loop?.id && e.target === 'port:multi_init_loop:data_out',
    );
    expect(loopToPort).toBeDefined();

    // 4. Verify no direct port-to-ALU feedback for data_out
    const portToAlu = mod.edges.find(
      (e) => e.source === 'port:multi_init_loop:data_out' && e.target === alu?.id,
    );
    expect(portToAlu).toBeUndefined();

    // 5. Verify loop index 'i' is NOT an input
    expect(loop?.ports.some((p) => p.name === 'i')).toBe(false);
  });

  it('connects multiple case branches assigning the same signal', async () => {
    const graph = await runParser(backend, [
      {
        file: 'mux_same_signal.sv',
        text: `
      module mux_same_signal (
          input logic [1:0] sel,
          input logic a,
          input logic b,
          output logic y
      );
        always_comb begin
          case (sel)
            2'b00: y = a;
            2'b01: y = b;
            2'b10: y = a;
            default: y = a;
          endcase
        end
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.mux_same_signal;
    const mux = mod.nodes.find((n) => n.kind === 'mux');
    expect(mux).toBeDefined();

    // We expect 4 input ports (+ sel)
    // "2'b00", "2'b01", "2'b10", "default"
    const inputPorts = mux?.ports.filter((p) => p.direction === 'input' && p.name !== 'sel');
    expect(inputPorts).toHaveLength(4);

    // Check connections
    const edgesToMux = mod.edges.filter((e) => e.target === mux?.id);
    // 1 for sel, 1 for b (at "2'b01"), 3 for a (at "2'b00", "2'b10", "default")
    expect(edgesToMux).toHaveLength(5);

    const aEdges = edgesToMux.filter((e) => e.signal === 'a');
    expect(aEdges).toHaveLength(3);

    const defaultEdge = aEdges.find((e) => e.targetPort.includes('default'));
    expect(defaultEdge).toBeDefined();
  });

  it('promotes complex mux selector expressions to combinational blocks', async () => {
    const graph = await runParser(backend, 'mux_selector_expr.sv', fixture('mux_selector_expr.sv'));
    const muxSelectorExpr = graph.modules.mux_selector_expr;
    const mux = muxSelectorExpr.nodes.find((node) => node.kind === 'mux');
    // `sel & sidekick` now gets a dedicated gate node instead of a generic comb block.
    const selectorComb = muxSelectorExpr.nodes.find(
      (node) =>
        node.kind === 'gate' &&
        ['sel', 'sidekick'].every((signal) =>
          node.ports.some((port) => port.direction === 'input' && port.connectedSignal === signal),
        ),
    );

    expect(mux).toBeDefined();
    if (backend === 'uhdm') {
      // `sel & sidekick` now promotes to a 2-input AND gate node rather than a comb blob.
      expect(selectorComb).toBeDefined();
      expect(selectorComb?.metadata?.operation).toBe('and');
    } else {
      expect(selectorComb?.metadata?.expression).toBe('sel & sidekick');
      expect(selectorComb?.ports.map((port) => port.name).sort()).toEqual(
        ['s', 'sel', 'sidekick'].sort(),
      );
      expect(mux?.ports.find((port) => port.name === 's')?.label).toBe('s');
    }

    expect(mux?.ports.find((port) => port.label === "1'b0")?.connectedSignal).toBe('a');
    expect(mux?.ports.find((port) => port.label === 'default')?.connectedSignal).toBe('b');
    expect(
      muxSelectorExpr.edges.some(
        (edge) => edge.source === 'port:mux_selector_expr:sel' && edge.target === selectorComb?.id,
      ),
    ).toBe(true);
    expect(
      muxSelectorExpr.edges.some(
        (edge) =>
          edge.source === 'port:mux_selector_expr:sidekick' && edge.target === selectorComb?.id,
      ),
    ).toBe(true);
    expect(
      muxSelectorExpr.edges.some(
        (edge) =>
          edge.source === selectorComb?.id &&
          edge.target === mux?.id &&
          (edge.targetPort === 'sel' || edge.targetPort === 'in:s'),
      ),
    ).toBe(true);
    expect(
      muxSelectorExpr.edges.some(
        (edge) =>
          edge.source === 'port:mux_selector_expr:a' &&
          edge.target === mux?.id &&
          edge.targetPort === 'in:1_b0',
      ),
    ).toBe(true);
    expect(
      muxSelectorExpr.edges.some(
        (edge) =>
          edge.source === 'port:mux_selector_expr:b' &&
          edge.target === mux?.id &&
          edge.targetPort === 'in:default',
      ),
    ).toBe(true);
  });

  it('represents multi-bit buses and part-select taps', async () => {
    const graph = await runParser(backend, 'bus_slices.sv', fixture('bus_slices.sv'));
    const busSlices = graph.modules.bus_slices;

    const instrPort = busSlices.nodes.find((node) => node.id === 'port:bus_slices:instr');
    const bus = busSlices.nodes.find((node) => node.kind === 'bus' && node.label === 'instr');
    // `instr[6:0] & a` now gets a dedicated gate node instead of a generic comb block.
    const decodedComb = busSlices.nodes.find(
      (node) =>
        node.kind === 'gate' &&
        node.ports.some((port) => port.direction === 'output' && port.name === 'decoded'),
    );
    const mux = busSlices.nodes.find((node) => node.kind === 'mux');

    expect(instrPort?.ports[0].width).toBe('[31:0]');
    expect(bus?.ports.find((port) => port.direction === 'input')?.width).toBe('[31:0]');
    expect(bus?.ports.find((port) => port.name === 'instr[14:12]')?.label).toBe('[14:12]');
    expect(bus?.ports.find((port) => port.name === 'instr[14:12]')?.width).toBe('[2:0]');
    expect(bus?.ports.find((port) => port.name.endsWith('[6:0]'))?.width).toBe('[6:0]');
    expect(bus?.ports.find((port) => port.name.endsWith('[30]'))?.width).toBe('[0:0]');
    expect(
      bus?.ports.filter((port) => port.direction === 'output').map((port) => port.label),
    ).toEqual(['[30]', '[14:12]', '[6:0]']);
    expect(
      busSlices.nodes.find((node) => node.id === 'reg:bus_slices:funct3_q')?.metadata?.width,
    ).toBe('[2:0]');

    // Gate node ports label a bracket-select input with its slice (e.g. "[6:0]"),
    // matching how comb/inverter display bus-tap inputs.
    const instrPortInComb = decodedComb?.ports.find((port) =>
      port.connectedSignal?.endsWith('[6:0]'),
    );
    expect(instrPortInComb?.label).toBe('[6:0]');
    expect(decodedComb?.ports.find((port) => port.name === 'decoded')?.width).toBe('[7:0]');
    if (backend !== 'uhdm') {
      expect(mux?.ports.find((port) => port.name === 's')?.width).toBe('[0:0]');
    }
    expect(
      busSlices.edges.some(
        (edge) =>
          edge.source === 'port:bus_slices:instr' &&
          edge.target === bus?.id &&
          edge.width === '[31:0]',
      ),
    ).toBe(true);
    expect(
      busSlices.edges.some(
        (edge) =>
          edge.source === bus?.id &&
          edge.sourcePort === bus?.ports.find((port) => port.name === 'instr[14:12]')?.id &&
          edge.target === 'reg:bus_slices:funct3_q' &&
          edge.width === '[2:0]',
      ),
    ).toBe(true);

    const instrSixToZeroTaps = bus?.ports.filter(
      (port) => port.direction === 'output' && port.name.endsWith('[6:0]'),
    );
    expect(instrSixToZeroTaps).toHaveLength(1);

    expect(busSlices.nodes.some((node) => node.kind === 'bus' && node.label === 'expr')).toBe(
      false,
    );
    expect(
      busSlices.edges.filter(
        (edge) =>
          edge.source === bus?.id &&
          edge.target === decodedComb?.id &&
          edge.signal === 'instr[6:0]',
      ),
    ).toHaveLength(1);

    if (backend === 'uhdm') {
      expect(
        busSlices.edges.some(
          (edge) =>
            edge.source.startsWith('bus:') && edge.target === mux?.id && edge.targetPort === 'sel',
        ),
      ).toBe(true);
    } else {
      expect(
        busSlices.edges.some(
          (edge) =>
            edge.source === bus?.id &&
            edge.sourcePort === 'out:instr_30_' &&
            edge.target === mux?.id &&
            edge.targetPort === 'in:s',
        ),
      ).toBe(true);
    }
  });

  it(
    'represents variable bit and indexed part-selects as select nodes ' + 'without bus taps',
    async () => {
      const graph = await runParser(backend, [
        {
          file: 'var_selects.sv',
          text: `
      module var_selects(
        input logic [31:0] bus,
        input logic sel_1bit,
        input logic [4:0] sel_multi,
        output logic bit_out_1,
        output logic bit_out_2,
        output logic [7:0] part_out_1,
        output logic [7:0] part_out_2
      );
        assign bit_out_1 = bus[sel_1bit];
        assign bit_out_2 = bus[sel_multi];
        assign part_out_1 = bus[sel_1bit * 8 +: 8];
        assign part_out_2 = bus[sel_multi * 8 +: 8];
      endmodule
    `,
        },
      ]);
      const mod = graph.modules.var_selects;
      const selects = mod.nodes.filter((node) => node.kind === 'select');

      expect(selects).toHaveLength(4);
      expect(
        mod.nodes.some(
          (node) =>
            node.kind === 'bus' &&
            node.label === 'bus' &&
            node.ports.some(
              (port) =>
                port.direction === 'output' && /sel_/.test(port.connectedSignal ?? port.name),
            ),
        ),
      ).toBe(false);

      const bitSelect = selects.find((node) =>
        node.ports.some(
          (port) => port.connectedSignal === 'bus[sel_multi]' && port.direction === 'output',
        ),
      );
      expect(bitSelect?.ports.find((port) => port.name === 'sel')?.connectedSignal).toBe(
        'sel_multi',
      );
      expect(
        mod.edges.some(
          (edge) =>
            edge.target === bitSelect?.id &&
            edge.targetPort === 'port:in' &&
            edge.width === '[31:0]',
        ),
      ).toBe(true);
      expect(bitSelect?.ports.find((port) => port.name === 'out')?.width).toBe('[0:0]');

      const partSelect = selects.find((node) =>
        node.ports.some(
          (port) =>
            port.direction === 'output' &&
            (port.connectedSignal ?? '').includes('sel_multi') &&
            (port.connectedSignal ?? '').includes('+:8'),
        ),
      );
      expect(partSelect?.ports.find((port) => port.name === 'sel')?.connectedSignal).toContain(
        'sel_multi',
      );
      expect(partSelect?.ports.find((port) => port.name === 'width')?.connectedSignal).toBe('8');
      expect(partSelect?.ports.find((port) => port.name === 'out')?.width).toBe('[7:0]');
      expect(
        mod.edges.some(
          (edge) =>
            edge.source === partSelect?.id &&
            edge.target === 'port:var_selects:part_out_2' &&
            edge.width === '[7:0]',
        ),
      ).toBe(true);
    },
  );

  it('keeps literal bus breakouts separate from variable selects in the same module', async () => {
    const graph = await runParser(backend, [
      {
        file: 'literal_and_variable_select.sv',
        text: `
      module literal_and_variable_select(
        input logic [31:0] bus,
        input logic [4:0] sel,
        output logic [7:0] byte_out,
        output logic bit_out
      );
        assign byte_out = bus[15:8];
        assign bit_out = bus[sel];
      endmodule
    `,
      },
    ]);
    const mod = graph.modules.literal_and_variable_select;
    const bus = mod.nodes.find((node) => node.kind === 'bus' && node.label === 'bus');
    const select = mod.nodes.find((node) => node.kind === 'select');

    expect(select).toBeDefined();
    expect(select?.ports.find((port) => port.name === 'out')?.connectedSignal).toBe('bus[sel]');
    expect(
      bus?.ports.some(
        (port) =>
          port.direction === 'output' &&
          (port.connectedSignal ?? port.name) === 'bus[15:8]' &&
          port.label === '[15:8]',
      ),
    ).toBe(true);
    expect(
      bus?.ports.some(
        (port) => port.direction === 'output' && (port.connectedSignal ?? port.name) === 'bus[sel]',
      ),
    ).toBe(false);
  });

  it('represents packed struct field reads as breakout nodes', async () => {
    const graph = await runParser(backend, [
      {
        file: 'struct_breakout.sv',
        text: `
      typedef struct packed {
        logic [3:0] opcode;
        logic valid;
        logic [1:0] lane;
      } packet_t;

      module top(input packet_t pkt, output logic [3:0] opcode, output logic valid, output logic [1:0] lane);
        assign opcode = pkt.opcode;
        assign valid = pkt.valid;
        assign lane = pkt.lane;
      endmodule
    `,
      },
    ]);

    const top = graph.modules.top;
    const struct = top.nodes.find((node) => node.kind === 'struct' && node.id === 'struct:top:pkt');

    expect(struct).toBeDefined();
    expect(struct?.metadata?.role).toBe('breakout');
    expect(struct?.metadata?.typeName).toBe('packet_t');
    expect(struct?.metadata?.packed).toBe(true);
    expect(top.ports.find((port) => port.name === 'pkt')?.width).toBe('[6:0]');
    expect(struct?.ports.find((port) => port.name === 'pkt')?.width).toBe('[6:0]');
    expect(struct?.ports.find((port) => port.name === 'pkt.opcode')?.width).toBe('[3:0]');
    expect(
      (struct?.metadata?.fields as any[]).find((field) => field.name === 'opcode')?.bitRange,
    ).toBe('[6:3]');
    expect(
      (struct?.metadata?.fields as any[]).find((field) => field.name === 'lane')?.bitRange,
    ).toBe('[1:0]');
    expect(
      top.nodes.some(
        (node) => node.kind === 'comb' && node.ports.some((port) => port.name === 'opcode'),
      ),
    ).toBe(false);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === 'port:top:pkt' &&
          edge.target === struct?.id &&
          edge.metadata?.aggregate === 'struct',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === struct?.id &&
          edge.target === 'port:top:opcode' &&
          edge.signal === 'pkt.opcode' &&
          edge.sourceRange?.startColumn !== undefined,
      ),
    ).toBe(true);
    expect(graph.modules['struct packet_t']?.nodes[0].kind).toBe('struct');
  });

  it('wires struct field reads directly into mux inputs without combinational shims', async () => {
    const graph = await runParser(backend, [
      {
        file: 'struct_direct_mux.sv',
        text: `
      typedef struct packed {
        logic [3:0] opcode;
        logic valid;
      } packet_t;

      module top(input packet_t pkt, input logic sel, input logic [3:0] fallback, output logic [3:0] y);
        always_comb begin
          if (sel) y = pkt.opcode;
          else y = fallback;
        end
      endmodule
    `,
      },
    ]);

    const top = graph.modules.top;
    const struct = top.nodes.find((node) => node.kind === 'struct' && node.id === 'struct:top:pkt');
    const mux = top.nodes.find((node) => node.kind === 'mux');

    expect(struct).toBeDefined();
    expect(mux).toBeDefined();
    expect(
      top.nodes.some((node) => node.kind === 'comb' && node.metadata?.expression === 'pkt.opcode'),
    ).toBe(false);
    expect(
      mux?.ports.some(
        (port) => port.direction === 'input' && port.connectedSignal === 'pkt.opcode',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === struct?.id && edge.target === mux?.id && edge.signal === 'pkt.opcode',
      ),
    ).toBe(true);
  });

  it('wires struct-field internal aliases into mux inputs through the breakout node', async () => {
    const graph = await runParser(backend, [
      {
        file: 'struct_internal_mux.sv',
        text: `
      typedef struct packed {
        logic [3:0] opcode;
        logic valid;
      } packet_t;

      module top(input packet_t pkt, input logic sel, input logic [3:0] fallback, output logic [3:0] y);
        logic [3:0] opcode_w;
        assign opcode_w = pkt.opcode;

        always_comb begin
          if (sel) y = opcode_w;
          else y = fallback;
        end
      endmodule
    `,
      },
    ]);

    const top = graph.modules.top;
    const struct = top.nodes.find((node) => node.kind === 'struct' && node.id === 'struct:top:pkt');
    const mux = top.nodes.find((node) => node.kind === 'mux');

    expect(struct).toBeDefined();
    expect(mux).toBeDefined();
    expect(
      top.nodes.some((node) => node.kind === 'comb' && node.metadata?.expression === 'pkt.opcode'),
    ).toBe(false);
    expect(
      struct?.ports.some(
        (port) =>
          port.direction === 'output' &&
          port.connectedSignal === 'opcode_w' &&
          port.label === 'opcode',
      ),
    ).toBe(true);
    expect(
      mux?.ports.some((port) => port.direction === 'input' && port.connectedSignal === 'opcode_w'),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === struct?.id && edge.target === mux?.id && edge.signal === 'opcode_w',
      ),
    ).toBe(true);
  });

  it('wires struct field selections on submodule ports through struct nodes', async () => {
    const graph = await runParser(backend, [
      {
        file: 'struct_instance_field.sv',
        text: `
      typedef struct packed {
        logic [3:0] opcode;
        logic valid;
      } packet_t;

      module opcode_consumer(input logic [3:0] opcode, output logic [3:0] y);
        assign y = opcode;
      endmodule

      module valid_consumer(input logic valid, output logic y);
        assign y = valid;
      endmodule

      module opcode_producer(output logic [3:0] opcode);
        assign opcode = 4'hf;
      endmodule

      module top(input packet_t pkt, output logic [3:0] opcode_y, output logic valid_y, output packet_t out_pkt);
        opcode_consumer u_opcode (.opcode(pkt.opcode), .y(opcode_y));
        valid_consumer u_valid (.valid(pkt.valid), .y(valid_y));
        opcode_producer u_producer (.opcode(out_pkt.opcode));
      endmodule
    `,
      },
    ]);

    const top = graph.modules.top;
    const struct = top.nodes.find((node) => node.kind === 'struct' && node.id === 'struct:top:pkt');
    const composition = top.nodes.find(
      (node) => node.kind === 'struct' && node.id === 'struct_comp:top:out_pkt',
    );
    const opcodeInst = top.nodes.find(
      (node) => node.kind === 'instance' && node.id === 'instance:top:u_opcode',
    );
    const validInst = top.nodes.find(
      (node) => node.kind === 'instance' && node.id === 'instance:top:u_valid',
    );
    const producerInst = top.nodes.find(
      (node) => node.kind === 'instance' && node.id === 'instance:top:u_producer',
    );

    expect(struct).toBeDefined();
    expect(composition).toBeDefined();
    expect(opcodeInst).toBeDefined();
    expect(validInst).toBeDefined();
    expect(producerInst).toBeDefined();
    expect(
      opcodeInst?.ports.some(
        (port) =>
          port.name === 'opcode' && port.connectedSignal === 'pkt.opcode' && port.width === '[3:0]',
      ),
    ).toBe(true);
    expect(
      validInst?.ports.some(
        (port) => port.name === 'valid' && port.connectedSignal === 'pkt.valid',
      ),
    ).toBe(true);
    expect(
      producerInst?.ports.some(
        (port) =>
          port.name === 'opcode' &&
          port.connectedSignal === 'out_pkt.opcode' &&
          port.width === '[3:0]',
      ),
    ).toBe(true);
    expect(
      top.nodes.some((node) => node.kind === 'comb' && node.metadata?.expression === 'pkt.opcode'),
    ).toBe(false);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === struct?.id &&
          edge.target === opcodeInst?.id &&
          edge.signal === 'pkt.opcode' &&
          edge.targetPort === 'port:opcode',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === struct?.id &&
          edge.target === validInst?.id &&
          edge.signal === 'pkt.valid' &&
          edge.targetPort === 'port:valid',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === producerInst?.id &&
          edge.target === composition?.id &&
          edge.signal === 'out_pkt.opcode' &&
          edge.targetPort === 'in:out_pkt.opcode',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === composition?.id &&
          edge.target === 'port:top:out_pkt' &&
          edge.metadata?.aggregate === 'struct',
      ),
    ).toBe(true);
  });

  it('keeps struct field reads and writes on separate breakout and composition nodes', async () => {
    const graph = await runParser(backend, [
      {
        file: 'internal_wire_instances.sv',
        text: `
      typedef struct packed {
        logic [3:0] opcode1;
        logic [3:0] opcode2;
        logic valid;
      } packet_t;

      module internal_wire_instance(
          input packet_t pkt,
          input logic [1:0] sel,
          input logic [3:0] fallback,
          output logic [3:0] y,
          output packet_t pkt_recomb
      );
        always_comb begin
          if (sel == 2'b11) begin
            y = pkt.opcode1;
          end else if (sel == 2'b10) begin
            y = pkt.opcode2;
          end else begin
            y = fallback;
          end
        end

        assign pkt_recomb.opcode1 = pkt.opcode2;
        assign pkt_recomb.opcode2 = pkt.opcode1;
        assign pkt_recomb.valid = pkt.valid;
      endmodule
    `,
      },
    ]);

    const mod = graph.modules.internal_wire_instance;
    const breakout = mod.nodes.find(
      (node) => node.kind === 'struct' && node.id === 'struct:internal_wire_instance:pkt',
    );
    const composition = mod.nodes.find(
      (node) =>
        node.kind === 'struct' && node.id === 'struct_comp:internal_wire_instance:pkt_recomb',
    );
    const muxes = mod.nodes.filter((node) => node.kind === 'mux');

    expect(breakout).toBeDefined();
    expect(composition).toBeDefined();
    expect(breakout?.metadata?.role).toBe('breakout');
    expect(composition?.metadata?.role).toBe('composition');
    expect(
      breakout?.ports
        .filter((port) => port.direction === 'output')
        .map((port) => port.name)
        .sort(),
    ).toEqual(['pkt.opcode1', 'pkt.opcode2', 'pkt.valid']);
    expect(
      composition?.ports
        .filter((port) => port.direction === 'input')
        .map((port) => port.name)
        .sort(),
    ).toEqual(['pkt_recomb.opcode1', 'pkt_recomb.opcode2', 'pkt_recomb.valid']);
    expect(
      muxes.some((mux) => mux.ports.some((port) => port.connectedSignal === 'pkt.opcode1')),
    ).toBe(true);
    expect(
      muxes.some((mux) => mux.ports.some((port) => port.connectedSignal === 'pkt.opcode2')),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === breakout?.id &&
          edge.target === composition?.id &&
          edge.signal === 'pkt.opcode2' &&
          edge.targetPort === 'in:pkt_recomb.opcode1',
      ),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === breakout?.id &&
          edge.target === composition?.id &&
          edge.signal === 'pkt.opcode1' &&
          edge.targetPort === 'in:pkt_recomb.opcode2',
      ),
    ).toBe(true);
    expect(
      mod.edges.some(
        (edge) =>
          edge.source === composition?.id &&
          edge.target === 'port:internal_wire_instance:pkt_recomb' &&
          edge.metadata?.aggregate === 'struct',
      ),
    ).toBe(true);
  });

  it('represents struct field registers as a composition node', async () => {
    const graph = await runParser(backend, [
      {
        file: 'struct_composition.sv',
        text: `
      module top(input logic clk, input logic [3:0] opcode_i, input logic valid_i, output logic [4:0] flat);
        typedef struct packed {
          logic [3:0] opcode;
          logic valid;
        } packet_t;
        packet_t pkt;
        always_ff @(posedge clk) begin
          pkt.opcode <= opcode_i;
          pkt.valid <= valid_i;
        end
        assign flat = pkt;
      endmodule
    `,
      },
    ]);

    const top = graph.modules.top;
    const comp = top.nodes.find(
      (node) => node.kind === 'struct' && node.id === 'struct_comp:top:pkt',
    );

    expect(comp).toBeDefined();
    expect(comp?.metadata?.role).toBe('composition');
    expect(comp?.ports.find((port) => port.name === 'pkt')?.width).toBe('[4:0]');
    expect(comp?.ports.find((port) => port.name === 'pkt.opcode')?.width).toBe('[3:0]');
    expect(
      top.nodes
        .find((node) => node.id === 'reg:top:pkt.opcode')
        ?.ports.find((port) => port.name === 'Q')?.width,
    ).toBe('[3:0]');
    expect(
      top.edges.some(
        (edge) =>
          edge.source === 'reg:top:pkt.opcode' &&
          edge.target === comp?.id &&
          edge.signal === 'pkt.opcode',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (edge) =>
          edge.source === comp?.id && edge.target === 'port:top:flat' && edge.signal === 'pkt',
      ),
    ).toBe(true);
  });

  it('represents unpacked struct field reads without packed bit ranges', async () => {
    const graph = await runParser(backend, [
      {
        file: 'unpacked_struct.sv',
        text: `
      typedef struct {
        logic [3:0] opcode;
        logic valid;
      } packet_u;

      module top(input packet_u pkt, output logic [3:0] opcode);
        assign opcode = pkt.opcode;
      endmodule
    `,
      },
    ]);

    const top = graph.modules.top;
    const struct = top.nodes.find((node) => node.kind === 'struct' && node.id === 'struct:top:pkt');
    const fields = struct?.metadata?.fields as any[];

    expect(struct).toBeDefined();
    expect(struct?.metadata?.packed).toBe(false);
    expect(fields.find((field) => field.name === 'opcode')?.width).toBe('[3:0]');
    expect(fields.find((field) => field.name === 'opcode')?.bitRange).toBeUndefined();
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

    // Check gate node from assign: line 15
    const decodedComb = busSlices.nodes.find(
      (node) =>
        node.kind === 'gate' &&
        node.ports.some((p) => p.name === 'decoded' && p.direction === 'output'),
    );
    // Gate nodes get a refined source range narrowed to just the expression
    // ("instr[6:0] & a"), like ALU/inverter nodes — not the whole `assign` statement.
    expect(decodedComb?.source).toBeDefined();
    expect(decodedComb?.source?.file).toBe('bus_slices.sv');
    expect(decodedComb?.source?.startLine).toBe(15);
    expect(decodedComb?.source?.startColumn).toBe(19);
    expect(decodedComb?.source?.endLine).toBe(15);
    expect(decodedComb?.source?.endColumn).toBe(33);

    // Check mux from case: lines 18-21
    const mux = busSlices.nodes.find((node) => node.kind === 'mux');
    expect(mux?.source).toBeDefined();
    expect(mux?.source?.file).toBe('bus_slices.sv');
    if (backend === 'uhdm') {
      expect([17, 18]).toContain(mux?.source?.startLine);
      expect(mux?.source?.startColumn).toBeDefined();
      expect([21, 22]).toContain(mux?.source?.endLine);
      expect(mux?.source?.endColumn).toBeDefined();
    } else {
      expect(mux?.source?.startLine).toBe(18);
      expect(mux?.source?.startColumn).toBe(4);
      expect(mux?.source?.endLine).toBe(21);
      expect(mux?.source?.endColumn).toBe(11);
    }

    // Check ports
    const clkPort = busSlices.nodes.find((node) => node.id === 'port:bus_slices:clk');
    expect(clkPort?.source).toBeDefined();
    expect(clkPort?.source?.startLine).toBe(2);
    if (backend === 'uhdm') {
      expect(clkPort?.source?.startColumn).toBe(14);
    } else {
      expect(clkPort?.source?.startColumn).toBe(2);
    }
    expect(clkPort?.source?.endLine).toBe(2);
    expect(clkPort?.source?.endColumn).toBe(17);
  });

  it('does not crash on malformed source', async () => {
    const graph = await runParser(backend, [
      { file: 'bad.sv', text: 'module broken(input logic a); always_ff @(' },
    ]);

    // With UHDM backend, malformed source results in an error diagnostic
    expect(graph.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('connects one submodule output to another submodule input', async () => {
    const graph = await runParser(backend, 'submodule_chain.sv', fixture('submodule_chain.sv'));
    const top = graph.modules.top_chain;

    expect(top).toBeDefined();
    expect(top.nodes.some((n) => n.id === 'instance:top_chain:u_sub_a')).toBe(true);
    expect(top.nodes.some((n) => n.id === 'instance:top_chain:u_sub_b')).toBe(true);

    // Check edge from u_sub_a to u_sub_b
    const edge = top.edges.find(
      (e) => e.source === 'instance:top_chain:u_sub_a' && e.target === 'instance:top_chain:u_sub_b',
    );

    expect(edge).toBeDefined();
    expect(edge?.sourcePort).toBe('port:out_a');
    expect(edge?.targetPort).toBe('port:in_b');
    expect(edge?.signal).toBe('mid');
  });

  it('extracts module instances through a four-level hierarchy', async () => {
    const graph = await runParser(backend, [
      {
        file: 'nested_hierarchy.sv',
        text: `
          module leaf(input logic i, output logic o);
            assign o = i;
          endmodule

          module level3(input logic i, output logic o);
            leaf u_leaf (.i(i), .o(o));
          endmodule

          module level2(input logic i, output logic o);
            level3 u_level3 (.i(i), .o(o));
          endmodule

          module level1(input logic i, output logic o);
            level2 u_level2 (.i(i), .o(o));
          endmodule

          module top(input logic i, output logic o);
            level1 u_level1 (.i(i), .o(o));
          endmodule
        `,
      },
    ]);

    expect(graph.rootModules).toEqual(['top']);
    expect(
      graph.modules.top.nodes.some(
        (node) => node.id === 'instance:top:u_level1' && node.instanceOf === 'level1',
      ),
    ).toBe(true);
    expect(
      graph.modules.level1.nodes.some(
        (node) => node.id === 'instance:level1:u_level2' && node.instanceOf === 'level2',
      ),
    ).toBe(true);
    expect(
      graph.modules.level2.nodes.some(
        (node) => node.id === 'instance:level2:u_level3' && node.instanceOf === 'level3',
      ),
    ).toBe(true);
    expect(
      graph.modules.level3.nodes.some(
        (node) => node.id === 'instance:level3:u_leaf' && node.instanceOf === 'leaf',
      ),
    ).toBe(true);
  });

  it('handles multiple assignments within always_comb and always_ff', async () => {
    const graph = await runParser(
      backend,
      'multiple_procedural_assigns.sv',
      fixture('multiple_procedural_assigns.sv'),
    );
    const mod = graph.modules.multiple_procedural_assigns;

    // Verify always_comb assignments to different signals
    const xNodes = mod.nodes.filter((n) =>
      n.ports.some((p) => p.direction === 'output' && p.connectedSignal === 'x'),
    );
    const yNodes = mod.nodes.filter((n) =>
      n.ports.some((p) => p.direction === 'output' && p.connectedSignal === 'y'),
    );
    expect(xNodes.length).toBe(1);
    expect(yNodes.length).toBe(1);
    expect(xNodes[0].metadata?.isProcedural).toBe(true);
    expect(yNodes[0].metadata?.isProcedural).toBe(true);

    // Verify always_comb multiple assignments to the SAME signal
    const zNodes = mod.nodes.filter((n) =>
      n.ports.some((p) => p.direction === 'output' && p.connectedSignal === 'z'),
    );
    expect(zNodes.length).toBe(2);
    expect(zNodes.every((n) => n.metadata?.isProcedural === true)).toBe(true);

    // Verify always_ff assignments
    const rNodes = mod.nodes.filter((n) => n.kind === 'register');
    expect(rNodes.length).toBeGreaterThanOrEqual(2);
    expect(rNodes.every((n) => n.metadata?.isProcedural === true)).toBe(true);
  });

  it(
    'correctly represents bus breakouts without extraneous direct ' + 'connections (UHDM)',
    async () => {
      if (backend !== 'uhdm') return;

      const graph = await runParser(backend, 'bus_three_taps.sv', fixture('bus_three_taps.sv'));
      const top = graph.modules.bus_three_taps;

      const busNode = top.nodes.find((n) => n.kind === 'bus' && n.label === 'instr');
      expect(busNode).toBeDefined();

      const outputPorts = busNode?.ports.filter((p) => p.direction === 'output');
      expect(outputPorts?.length).toBe(3);

      // Should have edge from port to bus
      const portToBus = top.edges.find(
        (e) => e.source === 'port:bus_three_taps:instr' && e.target === busNode?.id,
      );
      expect(portToBus).toBeDefined();

      // Should have edges from bus to outputs (mediated by bus node)
      const busToOpcode = top.edges.find(
        (e) => e.source === busNode?.id && e.target === 'port:bus_three_taps:opcode',
      );
      expect(busToOpcode).toBeDefined();
      expect(busToOpcode?.signal).toBe('instr[6:0]');

      // CRITICAL: Should NOT have direct edge from port to output
      const directEdge = top.edges.find(
        (e) =>
          e.source === 'port:bus_three_taps:instr' && e.target === 'port:bus_three_taps:opcode',
      );
      expect(directEdge).toBeUndefined();

      // Check rd and overlap too
      expect(
        top.edges.some((e) => e.source === busNode?.id && e.target === 'port:bus_three_taps:rd'),
      ).toBe(true);
      expect(
        top.edges.some(
          (e) => e.source === busNode?.id && e.target === 'port:bus_three_taps:overlap',
        ),
      ).toBe(true);
      expect(
        top.edges.some(
          (e) => e.source === 'port:bus_three_taps:instr' && e.target === 'port:bus_three_taps:rd',
        ),
      ).toBe(false);

      // Verify widths
      const instrPortNode = top.nodes.find((n) => n.id === 'port:bus_three_taps:instr');
      expect(instrPortNode?.metadata?.width).toBeUndefined();
      expect(instrPortNode?.ports[0].width).toBe('[31:0]');

      const opcodePortNode = top.nodes.find((n) => n.id === 'port:bus_three_taps:opcode');
      expect(opcodePortNode?.metadata?.width).toBeUndefined();
      expect(opcodePortNode?.ports[0].width).toBe('[6:0]');
    },
  );

  it('connects positional ports to instances', async () => {
    const topSv = 'module top(input i, output o); Sub sub_inst(i, o); endmodule';
    const subSv = 'module Sub(input i, output o); assign o = i; endmodule';
    const graph = await runParser(backend, [
      { file: 'top.sv', text: topSv },
      { file: 'sub.sv', text: subSv },
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
      { file: 'b.sv', text: bSv },
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

  it(
    'generically promotes complex expressions in processes to ' + 'combinational blocks (UHDM)',
    async () => {
      if (backend !== 'uhdm') return;

      const graph = await runParser(backend, 'complex_process.sv', fixture('complex_process.sv'));
      const mod = graph.modules.complex_process;

      // 1. Check complex selector
      const muxY = mod.nodes.find((n) => n.kind === 'mux' && n.id.includes(':y:'));
      expect(muxY).toBeDefined();
      // Should have a gate node for (sel & sidekick)
      const selComb = mod.nodes.find((n) => n.kind === 'gate' && n.id.includes('y_sel'));
      expect(selComb).toBeDefined();
      expect(selComb?.metadata?.operation).toBe('and');
      expect(
        mod.edges.some(
          (e) => e.source === selComb?.id && e.target === muxY?.id && e.targetPort === 'sel',
        ),
      ).toBe(true);

      // 2. Check complex RHS in case branch
      const muxZ = mod.nodes.find((n) => n.kind === 'mux' && n.id.includes(':z:'));
      expect(muxZ).toBeDefined();
      const branchComb = mod.nodes.find((n) => n.kind === 'bus' && n.id.includes('z_1_b0'));
      expect(branchComb).toBeDefined();
      expect(mod.edges.some((e) => e.source === branchComb?.id && e.target === muxZ?.id)).toBe(
        true,
      );

      // 3. Check complex RHS in register
      const regR = mod.nodes.find((n) => n.kind === 'register' && n.label === 'r');
      expect(regR).toBeDefined();
      const regComb = mod.nodes.find((n) => n.kind === 'bus' && n.id.includes('r_next'));
      expect(regComb).toBeDefined();
      expect(
        mod.edges.some(
          (e) => e.source === regComb?.id && e.target === regR?.id && e.targetPort === 'd',
        ),
      ).toBe(true);
    },
  );

  it('synthesizes bus composition nodes for multiple slice assignments (UHDM)', async () => {
    if (backend !== 'uhdm') return;

    const graph = await runParser(backend, 'bus_composition.sv', fixture('bus_composition.sv'));
    const top = graph.modules.bus_composition;

    expect(top).toBeDefined();

    // Find the composition node for 'r'
    const compNode = top.nodes.find((n) => n.id === 'bus_comp:bus_composition:r');
    expect(compNode).toBeDefined();

    expect(compNode?.kind).toBe('bus');

    const inputs = compNode?.ports.filter((p) => p.direction === 'input') || [];
    const outputs = compNode?.ports.filter((p) => p.direction === 'output') || [];
    expect(inputs.map((p) => p.name).sort()).toEqual(['[0]', '[1]', '[3:2]']);
    expect(inputs.map((p) => p.connectedSignal).sort()).toEqual(['r[0]', 'r[1]', 'r[3:2]']);
    expect(outputs.map((p) => p.name)).toEqual(['r']);
    expect(outputs[0].connectedSignal).toBe('r');

    // Verify output edge to port node
    // Port IDs follow the bus stableId scheme: out:name for outputs, in:sanitized(name) for inputs.
    const outEdge = top.edges.find(
      (e) => e.source === compNode?.id && e.target === 'port:bus_composition:r',
    );
    expect(outEdge).toBeDefined();
    expect(outEdge?.targetPort).toBe('port:r');
    expect(outEdge?.sourcePort).toBe('out:r');
    expect(outEdge?.signal).toBe('r');

    // Ensure register nodes exist and connect to the composition node
    const r0 = top.nodes.find((n) => n.label === 'r[0]');
    const r1 = top.nodes.find((n) => n.label === 'r[1]');
    const r32 = top.nodes.find((n) => n.label === 'r[3:2]');
    expect(r0).toBeDefined();
    expect(r1).toBeDefined();
    expect(r32).toBeDefined();

    // Input port IDs: stableId('in', slice) where special chars are sanitized to '_'
    expect(
      top.edges.some(
        (e) =>
          e.source === r0?.id &&
          e.sourcePort === 'q' &&
          e.target === compNode?.id &&
          e.targetPort === 'in:_0_' &&
          e.signal === 'r[0]',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (e) =>
          e.source === r1?.id &&
          e.sourcePort === 'q' &&
          e.target === compNode?.id &&
          e.targetPort === 'in:_1_' &&
          e.signal === 'r[1]',
      ),
    ).toBe(true);
    expect(
      top.edges.some(
        (e) =>
          e.source === r32?.id &&
          e.sourcePort === 'q' &&
          e.target === compNode?.id &&
          e.targetPort === 'in:_3:2_' &&
          e.signal === 'r[3:2]',
      ),
    ).toBe(true);

    expect(
      top.edges.some((e) => e.source === r0?.id && e.target === 'port:bus_composition:r'),
    ).toBe(false);
    expect(
      top.edges.some((e) => e.source === r1?.id && e.target === 'port:bus_composition:r'),
    ).toBe(false);
    expect(
      top.edges.some((e) => e.source === r32?.id && e.target === 'port:bus_composition:r'),
    ).toBe(false);
  });

  describe('assign-chain alias collapsing', () => {
    it(
      'collapses a long chain of wire-to-wire assigns into a single edge, ' +
        'naming it after the first-declared wire',
      async () => {
        const graph = await runParser(
          backend,
          'assign_chain.sv',
          `
        module top(input i, output o);
          wire a,b,c,d,e,f;
          assign a = b;
          assign b = c;
          assign c = d;
          assign d = e;
          assign e = f;
          assign f = i;
          assign o = a;
        endmodule
      `,
        );
        const top = graph.modules.top;

        // No intermediate buffer/alias nodes should remain — the whole chain
        // is one net from the input port straight through to the output port.
        expect(top.nodes.filter((n) => n.kind !== 'port')).toEqual([]);
        expect(top.edges).toHaveLength(1);

        const edge = top.edges[0];
        expect(edge.source).toBe('port:top:i');
        expect(edge.target).toBe('port:top:o');
        // `edge.signal` keeps its own long-standing "closest to the sink"
        // convention (unrelated to declaration order) so edge identity/matching
        // elsewhere in the pipeline never shifts because of this feature.
        expect(edge.signal).toBe('o');
        // An internal wire's own explicit declaration outranks a port name even
        // though ports are always declared earlier in source (the header
        // precedes the body) — a port names the boundary contract, not this
        // net specifically. 'a' is the first internal wire declared, so it wins;
        // everything else the chain passed through (including both ports) is
        // still recorded for display (e.g. a hover popover on the cut label).
        expect(edge.metadata?.declaredNetName).toBe('a');
        expect(edge.metadata?.aliasNames).toEqual(['b', 'c', 'd', 'e', 'f', 'i', 'o']);
      },
    );

    it(
      'marks a net driven by a real expression (not a plain alias) with ' +
        'its declared output name, and no alias list',
      async () => {
        const graph = await runParser(
          backend,
          'assign_chain_expr.sv',
          `
        module top(input a, input b, output y);
          wire mid;
          assign mid = a & b;
          assign y = mid;
        endmodule
      `,
        );
        const top = graph.modules.top;
        // `a & b` now gets a dedicated gate node instead of a generic comb block.
        const combNode = top.nodes.find((n) => n.kind === 'gate');
        expect(combNode).toBeDefined();

        const outEdge = top.edges.find((e) => e.source === combNode?.id);
        expect(outEdge).toBeDefined();
        // `assign y = mid;` is a plain alias of the comb node's output, so it
        // collapses into the edge leaving the comb node — 'mid' is an explicit
        // internal wire declaration, which outranks the 'y' port it aliases to.
        expect(outEdge?.signal).toBe('y');
        expect(outEdge?.metadata?.declaredNetName).toBe('mid');
        expect(outEdge?.metadata?.aliasNames).toEqual(['y']);
      },
    );

    it(
      'does not mark a port name (or a tool-synthesized name) as a ' + 'declared net name',
      async () => {
        const graph = await runParser(
          backend,
          'assign_expr_only.sv',
          `
        module top(input a, input b, output y);
          assign y = a & b;
        endmodule
      `,
        );
        const top = graph.modules.top;
        // `a & b` now gets a dedicated gate node instead of a generic comb block.
        const combNode = top.nodes.find((n) => n.kind === 'gate');
        expect(combNode).toBeDefined();

        // 'a' and 'b' are ports — they name the module's boundary, not a net
        // of their own, and neither has an internal wire declared for it. So
        // this net has no formal declared name at all (same as a plain
        // `assign y = a;` alias with no intermediate wire).
        const inEdges = top.edges.filter((e) => e.target === combNode?.id);
        expect(inEdges).toHaveLength(2);
        for (const e of inEdges) {
          expect(e.metadata?.declaredNetName).toBeUndefined();
        }
      },
    );

    it(
      'does not mistake a select block\'s raw expression text ("bus[sel]") ' +
        'for a declared name',
      async () => {
        const graph = await runParser(
          backend,
          'select_alias.sv',
          `
        module top(input logic [3:0] bus, input logic [1:0] sel, output logic bit_out);
          assign bit_out = bus[sel];
        endmodule
      `,
        );
        const top = graph.modules.top;
        const selectNode = top.nodes.find((n) => n.kind === 'select');
        expect(selectNode).toBeDefined();

        // The select block's own signal text ("bus[sel]") isn't a real
        // declared identifier — it has no source location of its own, unlike
        // 'bit_out' (a real port). Neither should end up declaredNetName:
        // 'bit_out' alone means nothing beyond the port itself, so this net
        // has no formal name (matches a plain `assign y = a;` alias).
        const outEdge = top.edges.find((e) => e.source === selectNode?.id);
        expect(outEdge).toBeDefined();
        expect(outEdge?.metadata?.declaredNetName).toBeUndefined();
        expect(outEdge?.metadata?.aliasNames).toBeUndefined();
      },
    );

    it(
      'does not mistake a variable-index array write\'s synthesized "_next" ' +
        'wire ("M[address]_next") for a declared name',
      async () => {
        const graph = await runParser(
          backend,
          'array_variable_write.sv',
          `
        module top(
          input logic clk,
          input logic [2:0] address,
          input logic [31:0] write_data,
          input logic write_en
        );
          logic [31:0] M [0:7];
          always_ff @(posedge clk) begin
            if (write_en) M[address] <= write_data;
          end
        endmodule
      `,
        );
        const top = graph.modules.top;

        // "M" itself is a real declared array, so an edge whose signal is
        // exactly "M" still gets declaredNetName: 'M' — but the mux feeding
        // the register's D input carries a tool-synthesized helper name
        // ("M[address]_next") that only *starts* with the declared array's
        // name; it isn't the array itself, so it must stay undeclared (same
        // reasoning as the "bus[sel]" select-expression case above).
        const plainArrayEdge = top.edges.find((e) => e.signal === 'M');
        expect(plainArrayEdge?.metadata?.declaredNetName).toBe('M');

        const synthesizedNextEdge = top.edges.find((e) => e.signal === 'M[address]_next');
        expect(synthesizedNextEdge).toBeDefined();
        expect(synthesizedNextEdge?.metadata?.declaredNetName).toBeUndefined();
      },
    );
  });

  describe('procedural if lowering (UHDM)', () => {
    it('lowers a complete always_comb if/else into a mux', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_comb;
      const mux = muxesSelectedBy(mod, 'sel')[0];

      expect(mod.nodes.filter((node) => node.kind === 'mux')).toHaveLength(1);
      expectMuxInput(mod, mux, 'a', 'true');
      expectMuxInput(mod, mux, 'b', 'false');
      expectMuxOutput(mod, mux, 'y');
      expect(
        mod.edges.some((edge) => edge.source === mux?.id && edge.target === 'port:if_comb:y'),
      ).toBe(true);
    });

    it('lowers else-if chains into nested muxes', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_else_chain;
      const outer = muxesSelectedBy(mod, 'a_sel')[0];
      const inner = muxesSelectedBy(mod, 'b_sel')[0];

      expect(mod.nodes.filter((node) => node.kind === 'mux')).toHaveLength(2);
      expectMuxInput(mod, outer, 'a', 'true');
      expectMuxInput(mod, inner, 'b', 'true');
      expectMuxInput(mod, inner, 'c', 'false');
      expectMuxOutput(mod, outer, 'y');
      expect(
        mod.edges.some(
          (edge) =>
            edge.source === inner?.id &&
            edge.target === outer?.id &&
            edge.signal?.startsWith('y_if'),
        ),
      ).toBe(true);
      expect(
        mod.edges.some(
          (edge) => edge.source === outer?.id && edge.target === 'port:if_else_chain:y',
        ),
      ).toBe(true);
    });

    it('lowers nested if statements in the true arm', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_nested_true;
      const outerMux = muxesSelectedBy(mod, 'outer')[0];
      const innerMux = muxesSelectedBy(mod, 'inner')[0];

      expect(mod.nodes.filter((node) => node.kind === 'mux')).toHaveLength(2);
      expectMuxInput(mod, innerMux, 'a', 'true');
      expectMuxInput(mod, innerMux, 'b', 'false');
      expectMuxInput(mod, outerMux, 'c', 'false');
      expectMuxOutput(mod, outerMux, 'y');
      expect(
        mod.edges.some(
          (edge) =>
            edge.source === innerMux?.id &&
            edge.target === outerMux?.id &&
            edge.signal?.startsWith('y_if'),
        ),
      ).toBe(true);
    });

    it('lowers nested if statements in the false arm', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_nested_false;
      const outerMux = muxesSelectedBy(mod, 'outer')[0];
      const innerMux = muxesSelectedBy(mod, 'inner')[0];

      expect(mod.nodes.filter((node) => node.kind === 'mux')).toHaveLength(2);
      expectMuxInput(mod, outerMux, 'a', 'true');
      expectMuxInput(mod, innerMux, 'b', 'true');
      expectMuxInput(mod, innerMux, 'c', 'false');
      expectMuxOutput(mod, outerMux, 'y');
      expect(
        mod.edges.some(
          (edge) =>
            edge.source === innerMux?.id &&
            edge.target === outerMux?.id &&
            edge.signal?.startsWith('y_if'),
        ),
      ).toBe(true);
    });

    it('promotes complex if conditions to selector comb nodes', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_complex_condition;
      const selectorComb = mod.nodes.find(
        (node) =>
          node.kind === 'comb' &&
          node.ports.some(
            (port) => port.direction === 'output' && port.connectedSignal?.startsWith('if_sel_'),
          ) &&
          ['sel', 'valid', 'force_i'].every((signal) =>
            node.ports.some(
              (port) => port.direction === 'input' && port.connectedSignal === signal,
            ),
          ),
      );
      const mux = mod.nodes.find(
        (node) =>
          node.kind === 'mux' &&
          node.ports.some(
            (port) =>
              port.name === 'sel' &&
              port.connectedSignal ===
                selectorComb?.ports.find((p) => p.direction === 'output')?.connectedSignal,
          ),
      );

      expect(selectorComb).toBeDefined();
      expect(mux).toBeDefined();
      expect(
        mod.edges.some(
          (edge) =>
            edge.source === selectorComb?.id &&
            edge.target === mux?.id &&
            edge.targetPort === 'sel',
        ),
      ).toBe(true);
      expectMuxInput(mod, mux, 'a', 'true');
      expectMuxInput(mod, mux, 'b', 'false');
    });

    it('lowers clock enables to register feedback muxes', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_clock_enable;
      const reg = mod.nodes.find((node) => node.kind === 'register' && node.label === 'q');
      const mux = muxesSelectedBy(mod, 'en')[0];

      expect(reg).toBeDefined();
      expectMuxInput(mod, mux, 'd', 'true');
      expectMuxInput(mod, mux, 'q', 'false');
      expect(
        mod.edges.some(
          (edge) => edge.source === mux?.id && edge.target === reg?.id && edge.targetPort === 'd',
        ),
      ).toBe(true);
      expect(
        graph.diagnostics.some(
          (diagnostic) =>
            diagnostic.message.includes('if_clock_enable.q') &&
            diagnostic.message.includes('inferred latch'),
        ),
      ).toBe(false);
    });

    it('lowers clock enable inside reset else-branch to a feedback mux', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_reset_then_enable;
      const reg = mod.nodes.find((node) => node.kind === 'register' && node.label === 'q');
      const mux = muxesSelectedBy(mod, 'en')[0];

      expect(reg).toBeDefined();
      expectMuxInput(mod, mux, 'd', 'true');
      expectMuxInput(mod, mux, 'q', 'false');
      expect(
        mod.edges.some(
          (edge) => edge.source === mux?.id && edge.target === reg?.id && edge.targetPort === 'd',
        ),
      ).toBe(true);
    });

    it('adds independent feedback muxes for partially assigned clocked registers', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_two_registers;
      const regA = mod.nodes.find((node) => node.kind === 'register' && node.label === 'a');
      const regB = mod.nodes.find((node) => node.kind === 'register' && node.label === 'b');
      const muxes = muxesSelectedBy(mod, 'sel');
      const muxA = muxes.find((mux) =>
        mux.ports.some((port) => port.direction === 'output' && port.connectedSignal === 'a_next'),
      );
      const muxB = muxes.find((mux) =>
        mux.ports.some((port) => port.direction === 'output' && port.connectedSignal === 'b_next'),
      );

      expect(regA).toBeDefined();
      expect(regB).toBeDefined();
      expect(muxes).toHaveLength(2);
      expectMuxInput(mod, muxA, 'x', 'true');
      expectMuxInput(mod, muxA, 'a', 'false');
      expectMuxInput(mod, muxB, 'b', 'true');
      expectMuxInput(mod, muxB, 'y', 'false');
      expect(
        mod.edges.some(
          (edge) => edge.source === muxA?.id && edge.target === regA?.id && edge.targetPort === 'd',
        ),
      ).toBe(true);
      expect(
        mod.edges.some(
          (edge) => edge.source === muxB?.id && edge.target === regB?.id && edge.targetPort === 'd',
        ),
      ).toBe(true);
    });

    it('represents incomplete always_comb if assignments as inferred latches', async () => {
      if (backend !== 'uhdm') return;

      const graph = await proceduralIfFixtureGraph(backend);
      const mod = graph.modules.if_inferred_latch;
      const latch = mod.nodes.find((node) => node.kind === 'latch' && node.label === 'y');
      const mux = muxesSelectedBy(mod, 'sel')[0];

      expect(latch).toBeDefined();
      expect(latch?.metadata?.inferred).toBe(true);
      expectMuxInput(mod, mux, 'a', 'true');
      expectMuxInput(mod, mux, 'y', 'false');
      expect(
        mod.edges.some(
          (edge) => edge.source === mux?.id && edge.target === latch?.id && edge.targetPort === 'd',
        ),
      ).toBe(true);
      expect(
        mod.edges.some(
          (edge) => edge.source === latch?.id && edge.target === 'port:if_inferred_latch:y',
        ),
      ).toBe(true);
      expect(
        graph.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === 'warning' &&
            diagnostic.message.includes('inferred latch') &&
            diagnostic.message.includes('y'),
        ),
      ).toBe(true);
    });

    it('extracts ALU chains as single combinational blocks', async () => {
      const graph = await runParser(backend, 'alu_chain.sv', fixture('alu_chain.sv'));
      const aluChain = graph.modules.alu_chain;

      const alus = aluChain.nodes.filter((n) => n.kind === 'alu');
      // Should now be 0 ALU nodes because a + b + c is an arithmetic chain
      expect(alus).toHaveLength(0);

      const comb = aluChain.nodes.find((n) => n.kind === 'comb');
      expect(comb).toBeDefined();
      expect(comb?.metadata.expression?.replace(/[()\s]+/g, '')).toBe('a+b+c');

      // Verify source range exists and is on the correct line
      expect(comb?.source).toBeDefined();
      if (comb?.source) {
        expect(comb.source.startLine).toBe(7);
      }
    });

    it('extracts ALU with combinational logic in operands', async () => {
      const graph = await runParser(backend, 'alu_with_comb.sv', fixture('alu_with_comb.sv'));
      const aluWithComb = graph.modules.alu_with_comb;

      const alus = aluWithComb.nodes.filter((n) => n.kind === 'alu');
      expect(alus).toHaveLength(1);
      const alu = alus[0];

      // With parentheses, it should be "a + (b | c)"
      expect(alu.metadata.expression?.replace(/\s+/g, '')).toBe('a+(b|c)');

      // Check that RHS of ALU is connected to a dedicated gate node
      const rhsPort = alu.ports.find((p) => p.name === 'rhs');
      expect(rhsPort).toBeDefined();

      const combNode = aluWithComb.nodes.find(
        (n) =>
          n.kind === 'gate' &&
          n.ports.some(
            (p) => p.direction === 'output' && p.connectedSignal === rhsPort?.connectedSignal,
          ),
      );
      expect(combNode).toBeDefined();
      expect(combNode?.metadata.expression?.replace(/\s+/g, '')).toBe('b|c');
      expect(combNode?.metadata.operation).toBe('or');

      // Verify source range is refined
      expect(alu.source).toBeDefined();
      if (alu.source) {
        expect(alu.source.startColumn).toBeGreaterThan(5);
      }
    });

    it('resolves macros from included header files using includePaths', async () => {
      const files = [
        { file: 'sub/params.svh', text: '`define MY_BITNESS 16' },
        {
          file: 'top.sv',
          text:
            '`include "params.svh"\n' +
            'module include_test (input logic [`MY_BITNESS-1:0] a, ' +
            'output logic [`MY_BITNESS-1:0] y); assign y = a; endmodule',
        },
      ];
      // We pass 'sub' as an include path. Surelog should find sub/params.svh when top.sv
      // includes it.
      const graph = await runParser(backend, files, undefined, ['sub']);
      const mod = graph.modules.include_test;
      expect(mod).toBeDefined();

      const portA = mod.nodes.find((n) => n.id === 'port:include_test:a');
      const portY = mod.nodes.find((n) => n.id === 'port:include_test:y');

      expect(portA).toBeDefined();
      expect(portY).toBeDefined();

      // If macro was resolved, Surelog parses successfully and we extract the raw width string.
      // (Full constant evaluation in UHDM depends on Surelog version/elaboration depth).
      expect(portA?.ports[0].width).toContain('MY_BITNESS');
      expect(portY?.ports[0].width).toContain('MY_BITNESS');
    });

    it('resolves enum literals from guarded headers in multiple source files', async () => {
      const header = [
        '`ifndef TYPES_VH',
        '`define TYPES_VH',
        'typedef enum logic [1:0] {',
        "  RESULT_SRC__ALU_RESULT = 2'b00,",
        "  RESULT_SRC__READ_DATA  = 2'b01",
        '} result_src_t;',
        '`endif',
      ].join('\n');
      const sourceFor = (moduleName: string, literal: string) =>
        [
          '`default_nettype none',
          '`include "src/headers/types.svh"',
          `module ${moduleName} (input result_src_t result_src, output var logic result);`,
          '  always_comb',
          '    case (result_src)',
          `      ${literal}: result = 1'b1;`,
          "      default: result = 1'b0;",
          '    endcase',
          'endmodule',
        ].join('\n');
      const files = [
        { file: 'src/headers/types.svh', text: header },
        { file: 'src/first.sv', text: sourceFor('first_enum_consumer', 'RESULT_SRC__ALU_RESULT') },
        { file: 'src/second.sv', text: sourceFor('second_enum_consumer', 'RESULT_SRC__READ_DATA') },
      ];

      const graph = await runParser(backend, files, undefined, ['.']);

      expect(graph.diagnostics).toEqual([]);
      expect(graph.modules.first_enum_consumer).toBeDefined();
      expect(graph.modules.second_enum_consumer).toBeDefined();
    });

    it('handles module instantiation across different files', async () => {
      const files = [
        {
          file: 'lib/submodule.sv',
          text: 'module Sub (input logic a, output logic y); assign y = ~a; endmodule',
        },
        {
          file: 'top.sv',
          text:
            'module Top (input logic in, output logic out); ' +
            'Sub u_sub (.a(in), .y(out)); endmodule',
        },
      ];

      const graph = await runParser(backend, files);
      expect(graph.modules.Top).toBeDefined();
      expect(graph.modules.Sub).toBeDefined();

      const top = graph.modules.Top;
      const instance = top.nodes.find((n) => n.kind === 'instance' && n.label === 'u_sub');
      expect(instance).toBeDefined();
      expect(instance?.instanceOf).toBe('Sub');

      // Check connectivity in Top
      expect(top.edges.some((e) => e.source === 'port:Top:in' && e.target === instance?.id)).toBe(
        true,
      );
      expect(top.edges.some((e) => e.source === instance?.id && e.target === 'port:Top:out')).toBe(
        true,
      );
    });

    it('resolves enums declared in a different file for mux branches', async () => {
      const files = [
        {
          file: 'pkg.svh',
          text: "typedef enum logic [1:0] { IDLE=2'b00, RUN=2'b01, STOP=2'b10 } state_t;",
        },
        {
          file: 'top.sv',
          text:
            '`include "pkg.svh"\n' +
            'module Top (input state_t state, input logic a, input logic b, output logic y); ' +
            "always_comb begin case (state) IDLE: y = a; RUN: y = b; default: y = 1'b0; " +
            'endcase end endmodule',
        },
      ];

      // Pass '.' as include path so it finds pkg.svh
      const graph = await runParser(backend, files, undefined, ['.']);
      const top = graph.modules.Top;
      expect(top).toBeDefined();

      const mux = top.nodes.find((n) => n.kind === 'mux');
      expect(mux).toBeDefined();

      // Check mux inputs for enum labels
      const idlePort = mux?.ports.find((p) => p.label === 'IDLE');
      const runPort = mux?.ports.find((p) => p.label === 'RUN');

      expect(idlePort).toBeDefined();
      expect(runPort).toBeDefined();

      // Check that IDLE branch is connected to port 'a'
      expect(
        top.edges.some(
          (e) => e.source === 'port:Top:a' && e.target === mux?.id && e.targetPort === idlePort?.id,
        ),
      ).toBe(true);
      // Check that RUN branch is connected to port 'b'
      expect(
        top.edges.some(
          (e) => e.source === 'port:Top:b' && e.target === mux?.id && e.targetPort === runPort?.id,
        ),
      ).toBe(true);
    });
  });

  describe('array register extraction', () => {
    async function arrayRegisterGraph() {
      return runParser(backend, 'array_register.sv', fixture('array_register.sv'));
    }

    it('emits a stacked write_en mux driven by write_en', async () => {
      const graph = await arrayRegisterGraph();
      const mod = graph.modules.array_register ?? Object.values(graph.modules)[0];
      expect(mod).toBeDefined();

      const writeEnMux = mod.nodes.find(
        (n) =>
          n.kind === 'mux' &&
          (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
          n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'write_en'),
      );
      expect(writeEnMux).toBeDefined();
      expectMuxInput(mod, writeEnMux, 'write_data', 'true');
      expectMuxInput(mod, writeEnMux, 'M', 'false');
    });

    it('emits an array register node tagged with isArrayNode', async () => {
      const graph = await runParser(backend, 'array_register.sv', fixture('array_register.sv'));
      const mod = graph.modules.array_register;
      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'M');
      expect(arrayReg).toBeDefined();
      expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);
    });

    it('records the unpacked array dimension on the register when available', async () => {
      const graph = await runParser(backend, 'array_register.sv', fixture('array_register.sv'));
      const mod = graph.modules.array_register ?? Object.values(graph.modules)[0];
      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'M');
      expect(arrayReg).toBeDefined();
      const dim = arrayReg?.arrayDimension ?? arrayReg?.metadata?.arrayDimension;
      if (dim !== undefined) {
        expect(dim).toMatch(/\[0:\d+\]/);
      }
    });

    let instanceArrayGraphPromise: ReturnType<typeof runParser> | undefined;
    function instanceArrayGraph() {
      instanceArrayGraphPromise ??= runParser(
        backend,
        'instance_array.sv',
        fixture('instance_array.sv'),
      );
      return instanceArrayGraphPromise;
    }

    it(
      'collapses a [MSB:LSB] multi-instance instantiation into a single stacked ' + 'instance node',
      async () => {
        const graph = await instanceArrayGraph();
        const mod = graph.modules.instance_array_top;
        expect(mod).toBeDefined();

        const instanceNodes = mod.nodes.filter((n) => n.kind === 'instance');
        expect(instanceNodes.length).toBe(1);

        const arrayInstance = instanceNodes[0];
        expect(arrayInstance.label).toBe('u_mux');
        expect(arrayInstance.instanceOf).toBe('mux2');
        expect(arrayInstance.isArrayNode ?? arrayInstance.metadata?.isArrayNode).toBe(true);
        expect(arrayInstance.arraySize ?? arrayInstance.metadata?.arraySize).toBe(4);
        expect(arrayInstance.arrayDimension ?? arrayInstance.metadata?.arrayDimension).toBe(
          '[3:0]',
        );

        // The submodule body is elaborated once, not once per array element.
        expect(Object.keys(graph.modules).sort()).toEqual(['instance_array_top', 'mux2']);
      },
    );

    it('broadcasts a scalar port connection to every element of an instance array', async () => {
      const graph = await instanceArrayGraph();
      const mod = graph.modules.instance_array_top;
      const arrayInstance = mod.nodes.find((n) => n.kind === 'instance');
      expect(arrayInstance).toBeDefined();

      // A single shared scalar wire ("sel"), not one element-indexed signal per array slot.
      const selPort = arrayInstance?.ports.find((p) => p.name === 'sel');
      expect(selPort?.connectedSignal).toBe('sel');

      expect(
        mod.edges.some(
          (e) =>
            e.source === 'port:instance_array_top:sel' &&
            e.sourcePort === 'port:sel' &&
            e.target === arrayInstance?.id &&
            e.targetPort === 'port:sel',
        ),
      ).toBe(true);
    });

    it('connects a matching-size unpacked array port element-wise as a stacked edge', async () => {
      const graph = await instanceArrayGraph();
      const mod = graph.modules.instance_array_top;
      const arrayInstance = mod.nodes.find((n) => n.kind === 'instance');
      expect(arrayInstance).toBeDefined();

      // The array-typed actuals ("a_arr"/"y_arr"), not a single element's indexed name.
      const aPort = arrayInstance?.ports.find((p) => p.name === 'a');
      const yPort = arrayInstance?.ports.find((p) => p.name === 'y');
      expect(aPort?.connectedSignal).toBe('a_arr');
      expect(yPort?.connectedSignal).toBe('y_arr');

      expect(
        mod.edges.some(
          (e) =>
            e.target === arrayInstance?.id &&
            e.targetPort === 'port:a' &&
            e.signal === 'a_arr' &&
            e.isStacked,
        ),
      ).toBe(true);
      expect(
        mod.edges.some(
          (e) =>
            e.source === arrayInstance?.id &&
            e.sourcePort === 'port:y' &&
            e.signal === 'y_arr' &&
            e.isStacked,
        ),
      ).toBe(true);
    });

    it('composes the per-element y_arr reads back into the y_bus output port', async () => {
      const graph = await instanceArrayGraph();
      const mod = graph.modules.instance_array_top;

      // "assign y_bus[i] = y_arr[i]" reads a scalar out of the stacked instance's
      // array output on each of the 4 lines; those reads must recompose into a
      // single driver for the y_bus output port, not leave it unconnected.
      const compNode = mod.nodes.find((n) => n.id === 'bus_comp:instance_array_top:y_bus');
      expect(compNode).toBeDefined();
      for (let i = 0; i < 4; i++) {
        expect(mod.edges.some((e) => e.target === compNode?.id && e.signal === `y_bus[${i}]`)).toBe(
          true,
        );
      }
      expect(
        mod.edges.some(
          (e) =>
            e.source === compNode?.id &&
            e.target === 'port:instance_array_top:y_bus' &&
            e.signal === 'y_bus',
        ),
      ).toBe(true);
    });

    it(
      'keeps the declared element width when composing a bus from multi-bit ' +
        'unpacked-array elements',
      async () => {
        const graph = await runParser(backend, [
          {
            file: 'wide_reg_array.sv',
            text: `
        module reg8 (
            input  logic [7:0] d,
            output logic [7:0] q
        );
            assign q = d;
        endmodule

        module wide_reg_array_top (
            input  logic clk,
            input  logic [7:0] d0,
            input  logic [7:0] d1,
            input  logic [7:0] d2,
            input  logic [7:0] d3,
            output logic [7:0] q_arr [3:0]
        );
            logic [7:0] arr [3:0];

            always_ff @(posedge clk) begin
                arr[0] <= d0;
                arr[1] <= d1;
                arr[2] <= d2;
                arr[3] <= d3;
            end

            reg8 u_reg [3:0] (
                .d (arr),
                .q (q_arr)
            );
        endmodule
      `,
          },
        ]);
        const mod = graph.modules.wide_reg_array_top;
        expect(mod).toBeDefined();

        // "arr" is `logic [7:0] arr [3:0]`: each constant-index register write
        // ("arr[i] <= di;") drives a full 8-bit element, not a single packed bit.
        // Since arr is also read whole (the "u_reg" array's ".d" port), a bus_comp
        // node must be synthesized from those 4 element drivers — and each must
        // keep its declared 8-bit element width, not collapse to 1 bit the way a
        // packed-bus bit-index slice would.
        const compNode = mod?.nodes.find((n) => n.id === 'bus_comp:wide_reg_array_top:arr');
        expect(compNode).toBeDefined();

        const inputs = compNode?.ports.filter((p) => p.direction === 'input') || [];
        expect(inputs.length).toBe(4);
        for (const p of inputs) {
          expect(p.width).toBe('[7:0]');
        }
      },
    );

    it(
      'preserves element-wise stacked connections for a reversed [0:MSB] ' + 'array range',
      async () => {
        const graph = await runParser(backend, [
          {
            file: 'instance_array_reversed.sv',
            text: `
        module mux2 (
            input  logic sel,
            input  logic a,
            input  logic b,
            output logic y
        );
            assign y = sel ? b : a;
        endmodule

        module instance_array_reversed_top (
            input  logic sel,
            input  logic [3:0] a_bus,
            input  logic [3:0] b_bus,
            output logic [3:0] y_bus
        );
            logic a_arr [0:3];
            logic b_arr [0:3];
            logic y_arr [0:3];

            assign a_arr[0] = a_bus[0];
            assign a_arr[1] = a_bus[1];
            assign a_arr[2] = a_bus[2];
            assign a_arr[3] = a_bus[3];

            assign b_arr[0] = b_bus[0];
            assign b_arr[1] = b_bus[1];
            assign b_arr[2] = b_bus[2];
            assign b_arr[3] = b_bus[3];

            mux2 u_mux [0:3] (
                .sel (sel),
                .a   (a_arr),
                .b   (b_arr),
                .y   (y_arr)
            );

            assign y_bus[0] = y_arr[0];
            assign y_bus[1] = y_arr[1];
            assign y_bus[2] = y_arr[2];
            assign y_bus[3] = y_arr[3];
        endmodule
      `,
          },
        ]);
        const mod = graph.modules.instance_array_reversed_top;
        const instanceNodes = mod.nodes.filter((n) => n.kind === 'instance');
        expect(instanceNodes).toHaveLength(1);
        const arrayInstance = instanceNodes[0];
        expect(arrayInstance.label).toBe('u_mux');
        expect(arrayInstance?.arraySize ?? arrayInstance?.metadata?.arraySize).toBe(4);
        expect(arrayInstance?.arrayDimension ?? arrayInstance?.metadata?.arrayDimension).toBe(
          '[0:3]',
        );

        expect(arrayInstance?.ports.find((p) => p.name === 'a')?.connectedSignal).toBe('a_arr');
        expect(arrayInstance?.ports.find((p) => p.name === 'y')?.connectedSignal).toBe('y_arr');
        expect(
          mod.edges.some(
            (e) =>
              e.target === arrayInstance?.id &&
              e.targetPort === 'port:a' &&
              e.signal === 'a_arr' &&
              e.isStacked,
          ),
        ).toBe(true);
      },
    );

    it(
      'falls back to the parsed element count when the array range bound is ' + 'parameterized',
      async () => {
        const graph = await runParser(backend, [
          {
            file: 'instance_array_param.sv',
            text: `
        module mux2 (
            input  logic sel,
            input  logic a,
            input  logic b,
            output logic y
        );
            assign y = sel ? b : a;
        endmodule

        module instance_array_param_top (
            input  logic sel,
            input  logic [3:0] a_bus,
            input  logic [3:0] b_bus,
            output logic [3:0] y_bus
        );
            localparam N = 4;
            logic a_arr [3:0];
            logic b_arr [3:0];
            logic y_arr [3:0];

            assign a_arr[0] = a_bus[0];
            assign a_arr[1] = a_bus[1];
            assign a_arr[2] = a_bus[2];
            assign a_arr[3] = a_bus[3];

            assign b_arr[0] = b_bus[0];
            assign b_arr[1] = b_bus[1];
            assign b_arr[2] = b_bus[2];
            assign b_arr[3] = b_bus[3];

            mux2 u_mux [N-1:0] (
                .sel (sel),
                .a   (a_arr),
                .b   (b_arr),
                .y   (y_arr)
            );

            assign y_bus[0] = y_arr[0];
            assign y_bus[1] = y_arr[1];
            assign y_bus[2] = y_arr[2];
            assign y_bus[3] = y_arr[3];
        endmodule
      `,
          },
        ]);
        const mod = graph.modules.instance_array_param_top;
        const instanceNodes = mod.nodes.filter((n) => n.kind === 'instance');
        expect(instanceNodes).toHaveLength(1);
        const arrayInstance = instanceNodes[0];
        expect(arrayInstance.label).toBe('u_mux');
        // The bound expression doesn't decompile to constant text, so arraySize falls back
        // to the number of elaborated elements instead of throwing or miscounting.
        expect(arrayInstance?.arraySize ?? arrayInstance?.metadata?.arraySize).toBe(4);
        expect(arrayInstance?.ports.find((p) => p.name === 'a')?.connectedSignal).toBe('a_arr');
        expect(arrayInstance?.ports.find((p) => p.name === 'y')?.connectedSignal).toBe('y_arr');
      },
    );

    it('emits a single stacked addr mux for variable-index writes', async () => {
      const graph = await arrayRegisterGraph();
      const mod = graph.modules.array_register ?? Object.values(graph.modules)[0];
      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'M');

      const addrMuxes = mod.nodes.filter(
        (n) =>
          n.kind === 'mux' &&
          (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
          n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'address'),
      );
      expect(addrMuxes.length).toBe(1);
      const addrMux = addrMuxes[0];

      expect(addrMux.ports.some((p) => p.direction === 'input' && p.label === "3'b0")).toBe(true);
      expect(
        addrMux.ports.some(
          (p) => p.direction === 'input' && p.connectedSignal === 'M' && p.label === 'default',
        ),
      ).toBe(true);

      expect(mod.edges.some((e) => e.source === addrMux.id && e.target === arrayReg?.id)).toBe(
        true,
      );
    });

    it('treats edge-triggered plain always array writes as stacked register updates', async () => {
      const graph = await runParser(backend, [
        {
          file: 'register_file.sv',
          text: `
        module register_file
          ( input clk
          , input reset
          , input logic [4:0] addr
          , input logic [31:0] val_in
          , output logic [31:0] val_out
          );

          reg [31:0] M [0:31];

          always @(posedge clk) begin
            if (reset) begin
              M[addr] <= 32'b0;
            end else begin
              M[addr] <= val_in;
            end
          end

          assign val_out = M[addr];
        endmodule
      `,
        },
      ]);
      const mod = graph.modules.register_file ?? Object.values(graph.modules)[0];
      expect(mod).toBeDefined();

      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'M');
      expect(arrayReg).toBeDefined();
      expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);

      const addrMux = mod.nodes.find(
        (n) =>
          n.kind === 'mux' &&
          (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
          n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'addr') &&
          n.label === 'write address',
      );
      expect(addrMux).toBeDefined();
      expect(addrMux?.ports.find((p) => p.label === 'default')?.connectedSignal).toBe('M');
      expect(
        mod.edges.some((e) => e.source === addrMux?.id && e.target === arrayReg?.id && e.isStacked),
      ).toBe(true);

      const resetMux = mod.nodes.find(
        (n) =>
          n.kind === 'mux' &&
          (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
          n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'reset'),
      );
      expect(resetMux).toBeDefined();

      const readMux = mod.nodes.find((n) => n.kind === 'mux' && n.label === 'read');
      expect(readMux).toBeDefined();
      expect(readMux?.ports.find((p) => p.name === 'in')?.connectedSignal).toBe('M');
      expect(readMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('addr');

      expect(mod.nodes.some((n) => n.kind === 'select' && n.label === 'M[addr]')).toBe(false);
      expect(mod.nodes.some((n) => n.id === 'bus_comp:register_file:M')).toBe(false);
    });

    it('uses the address mux to broadcast scalar writes and hold stacked Q values', async () => {
      const graph = await runParser(
        backend,
        'array_address_write_register.sv',
        fixture('array_address_write_register.sv'),
      );
      const mod = graph.modules.array_address_write_register ?? Object.values(graph.modules)[0];
      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'storage');

      const addrMux = mod.nodes.find(
        (n) =>
          n.kind === 'mux' &&
          (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
          n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'address'),
      );
      expect(addrMux).toBeDefined();
      expect(addrMux?.ports.find((p) => p.label === "2'b0")?.connectedSignal).toBe('in_data');
      expect(addrMux?.ports.find((p) => p.label === 'default')?.connectedSignal).toBe('storage');
      expect(addrMux?.ports.find((p) => p.direction === 'output')?.connectedSignal).toBe(
        'storage_next',
      );

      expect(
        mod.edges.some(
          (e) =>
            e.signal === 'address' &&
            e.target === addrMux?.id &&
            e.targetPort === 'sel' &&
            e.isStacked,
        ),
      ).toBe(true);
      expect(
        mod.edges.some((e) => e.signal === 'in_data' && e.target === addrMux?.id && e.isStacked),
      ).toBe(true);
      expect(
        mod.edges.some(
          (e) =>
            e.source === arrayReg?.id &&
            e.target === addrMux?.id &&
            e.signal === 'storage' &&
            e.isStacked,
        ),
      ).toBe(true);
      expect(
        mod.edges.some(
          (e) =>
            e.source === addrMux?.id &&
            e.target === arrayReg?.id &&
            e.signal === 'storage_next' &&
            e.isStacked,
        ),
      ).toBe(true);

      // Verify source mapping for the address mux points to the index expression [address]
      expect(addrMux?.source?.startLine).toBe(10);
      expect(addrMux?.source?.startColumn).toBe(16);
      expect(addrMux?.source?.endColumn).toBe(24);
    });

    it('keeps parameterized register-array reads and writes single-driven', async () => {
      const graph = await runParser(backend, [
        {
          file: 'a_top.sv',
          text: `
            module a_top;
              parameterized_register_file u_register_file();
            endmodule
          `,
        },
        {
          file: 'parameterized_register_file.sv',
          text: fixture('parameterized_register_file.sv'),
        },
      ]);
      const mod = graph.modules.parameterized_register_file;
      expect(mod).toBeDefined();

      const arrayReg = mod.nodes.find((node) => node.id === 'reg:parameterized_register_file:regs');
      expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);
      expect(arrayReg?.arrayDimension ?? arrayReg?.metadata?.arrayDimension).toBe('[0:3]');
      expect(arrayReg?.arraySize ?? arrayReg?.metadata?.arraySize).toBe(4);
      expect(
        mod.edges.some(
          (edge) =>
            edge.source === 'port:parameterized_register_file:reset_n' &&
            edge.target === arrayReg?.id &&
            edge.targetPort === 'reset_n',
        ),
      ).toBe(true);

      const addressMuxes = mod.nodes.filter((node) =>
        node.id.startsWith('mux:parameterized_register_file:regs_addr'),
      );
      expect(addressMuxes).toHaveLength(1);
      expect(addressMuxes[0].ports.find((port) => port.name === 'sel')?.connectedSignal).toBe(
        'rd_addr',
      );

      for (const address of ['rs1_addr', 'rs2_addr']) {
        const arrayReadSignal = `regs[${address}]`;
        const readMux = mod.nodes.find(
          (node) =>
            node.kind === 'mux' &&
            node.label === 'read' &&
            node.ports.some(
              (port) => port.direction === 'output' && port.connectedSignal === arrayReadSignal,
            ),
        );
        const outputMux = mod.nodes.find(
          (node) =>
            node.kind === 'mux' &&
            node.ports.some(
              (port) =>
                port.direction === 'output' &&
                port.connectedSignal === address.replace('addr', 'data'),
            ),
        );

        expect(readMux).toBeDefined();
        expect(
          mod.nodes.some((node) => node.kind === 'select' && node.label === arrayReadSignal),
        ).toBe(false);
        expect(
          mod.edges.filter(
            (edge) => edge.target === outputMux?.id && edge.targetPort === 'in:false',
          ),
        ).toEqual([
          expect.objectContaining({
            source: readMux?.id,
            signal: arrayReadSignal,
          }),
        ]);
      }

      for (const node of mod.nodes) {
        if (node.kind === 'port') continue;
        for (const port of node.ports.filter((candidate) => candidate.direction === 'input')) {
          const incoming = mod.edges.filter(
            (edge) => edge.target === node.id && edge.targetPort === port.id,
          );
          expect(incoming, `${node.id}.${port.id}`).toHaveLength(1);
        }
      }
    });

    it(
      'merges multiple normal index expressions into a chained address ' + 'mux for the same array',
      async () => {
        const graph = await runParser(backend, [
          {
            file: 'array_multi_index_write.sv',
            text: `
        module array_multi_index_write
          ( input logic clk
          , input logic [4:0] address
          , input logic [4:0] i
          , input logic [31:0] in_data
          );

          reg [31:0] storage [0:31];

          always @(posedge clk) begin
            storage[i] <= 32'b0;
            storage[address] <= in_data;
          end
        endmodule
      `,
          },
        ]);
        const mod = graph.modules.array_multi_index_write ?? Object.values(graph.modules)[0];

        // Exactly one array register — both writes fold into the same stacked storage node.
        const arrayRegs = mod.nodes.filter((n) => n.kind === 'register' && n.label === 'storage');
        expect(arrayRegs).toHaveLength(1);
        const arrayReg = arrayRegs[0];

        // Both index expressions are represented, and the later source assignment is the
        // canonical final stage so procedural last-assignment priority is preserved.
        const addressMuxes = mod.nodes.filter((n) =>
          n.id.startsWith('mux:array_multi_index_write:storage_addr'),
        );
        expect(addressMuxes).toHaveLength(2);

        // The mux that keeps the canonical id is the one wired to the register's D input.
        const finalMux = mod.nodes.find((n) => n.id === 'mux:array_multi_index_write:storage_addr');
        expect(finalMux).toBeDefined();
        expect(finalMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('address');
        expect(
          mod.edges.some(
            (e) =>
              e.source === finalMux?.id && e.target === arrayReg.id && e.signal === 'storage_next',
          ),
        ).toBe(true);

        const stageMux = addressMuxes.find((n) => n.id !== finalMux?.id);
        expect(stageMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('i');
        expect(stageMux?.ports.find((p) => p.name === "5'b0")?.connectedSignal).toBe("32'b0");
        expect(stageMux?.ports.find((p) => p.name === 'default')?.connectedSignal).toBe('storage');

        // The earlier write stage feeds the later write's default path.
        const stageOutSignal = stageMux?.ports.find(
          (p) => p.direction === 'output',
        )?.connectedSignal;
        expect(stageOutSignal).toBeTruthy();
        expect(finalMux?.ports.find((p) => p.name === 'default')?.connectedSignal).toBe(
          stageOutSignal,
        );
        expect(
          mod.edges.some(
            (e) =>
              e.source === stageMux?.id && e.target === finalMux?.id && e.signal === stageOutSignal,
          ),
        ).toBe(true);

        // No dangling/empty inputs on either mux — both writes are fully connected.
        expect(stageMux?.ports.every((p) => p.direction !== 'input' || !!p.connectedSignal)).toBe(
          true,
        );
        expect(finalMux?.ports.every((p) => p.direction !== 'input' || !!p.connectedSignal)).toBe(
          true,
        );
      },
    );

    it('folds a full-range zero reset loop into the stacked array register reset', async () => {
      const graph = await runParser(
        backend,
        'array_multi_index_write_reset_sorts_first.sv',
        fixture('array_multi_index_write_reset_sorts_first.sv'),
      );
      const mod =
        graph.modules.array_multi_index_write_reset_sorts_first ?? Object.values(graph.modules)[0];

      const arrayReg = mod.nodes.find(
        (n) => n.id === 'reg:array_multi_index_write_reset_sorts_first:storage',
      );
      expect(arrayReg).toBeDefined();
      expect(arrayReg?.ports.some((p) => p.name === 'reset' && p.connectedSignal === 'reset')).toBe(
        true,
      );
      expect(arrayReg?.ports.some((p) => p.name === 'RV')).toBe(false);

      const addressMuxes = mod.nodes.filter((n) =>
        n.id.startsWith('mux:array_multi_index_write_reset_sorts_first:storage_addr'),
      );
      expect(addressMuxes).toHaveLength(1);
      const finalMux = mod.nodes.find(
        (n) => n.id === 'mux:array_multi_index_write_reset_sorts_first:storage_addr',
      );
      expect(finalMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('address');
      expect(mod.nodes.some((n) => n.kind === 'mux' && n.label === 'if reset')).toBe(false);
      expect(
        mod.edges.some((e) => e.signal === 'reset' && e.target === arrayReg?.id && e.isStacked),
      ).toBe(true);
    });

    it('adds RV to the stacked array register for a non-zero full-range reset loop', async () => {
      const graph = await runParser(
        backend,
        'array_multi_index_write_reset_nonzero.sv',
        fixture('array_multi_index_write_reset_nonzero.sv'),
      );
      const mod =
        graph.modules.array_multi_index_write_reset_nonzero ?? Object.values(graph.modules)[0];
      const arrayReg = mod.nodes.find(
        (n) => n.id === 'reg:array_multi_index_write_reset_nonzero:storage',
      );

      expect(arrayReg?.ports.some((p) => p.name === 'reset' && p.connectedSignal === 'reset')).toBe(
        true,
      );
      expect(arrayReg?.ports.find((p) => p.name === 'RV')?.connectedSignal).toBe("32'hDEADBEEF");
      expect(
        mod.nodes.filter((n) =>
          n.id.startsWith('mux:array_multi_index_write_reset_nonzero:storage_addr'),
        ),
      ).toHaveLength(1);
      expect(mod.nodes.some((n) => n.kind === 'mux' && n.label === 'if reset')).toBe(false);
    });

    it('does not fold a partial-range reset loop into a whole-array reset', async () => {
      const canonicalSource = fixture('array_multi_index_write_reset_sorts_first.sv');
      const source = canonicalSource.replace('a < 32', 'a < 16');
      expect(source).not.toBe(canonicalSource);
      const graph = await runParser(
        backend,
        'array_multi_index_write_reset_sorts_first.sv',
        source,
      );
      const mod =
        graph.modules.array_multi_index_write_reset_sorts_first ?? Object.values(graph.modules)[0];
      const arrayReg = mod.nodes.find(
        (n) => n.id === 'reg:array_multi_index_write_reset_sorts_first:storage',
      );

      expect(arrayReg?.ports.some((p) => p.name === 'reset')).toBe(false);
      expect(
        mod.nodes.filter((n) =>
          n.id.startsWith('mux:array_multi_index_write_reset_sorts_first:storage_addr'),
        ),
      ).toHaveLength(2);
    });

    it(
      'folds a full-range descending reset loop into the stacked array ' + 'register reset',
      async () => {
        // storage[a] <= 0 for a counting down from 31 to 0 covers the full array just like the
        // ascending 0..N-1 form — only the direction differs — so it folds into the same
        // register R/RV representation instead of falling back to per-index addr/rst muxing.
        const graph = await runParser(
          backend,
          'array_multi_index_write_reset_descending.sv',
          fixture('array_multi_index_write_reset_descending.sv'),
        );
        const mod =
          graph.modules.array_multi_index_write_reset_descending ?? Object.values(graph.modules)[0];
        const arrayReg = mod.nodes.find(
          (n) => n.id === 'reg:array_multi_index_write_reset_descending:storage',
        );

        expect(arrayReg).toBeDefined();
        expect(
          arrayReg?.ports.some((p) => p.name === 'reset' && p.connectedSignal === 'reset'),
        ).toBe(true);
        expect(arrayReg?.ports.some((p) => p.name === 'RV')).toBe(false);

        const addressMuxes = mod.nodes.filter((n) =>
          n.id.startsWith('mux:array_multi_index_write_reset_descending:storage_addr'),
        );
        expect(addressMuxes).toHaveLength(1);
        const finalMux = mod.nodes.find(
          (n) => n.id === 'mux:array_multi_index_write_reset_descending:storage_addr',
        );
        expect(finalMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('address');
        expect(mod.nodes.some((n) => n.kind === 'mux' && n.label === 'if reset')).toBe(false);
        expect(
          mod.edges.some((e) => e.signal === 'reset' && e.target === arrayReg?.id && e.isStacked),
        ).toBe(true);
      },
    );

    it(
      'folds a full-range reset loop into the stacked array register reset ' +
        'even when the loop bound is a parameterized expression',
      async () => {
        // Regression for #237: `(1<<ADDR_WIDTH)` doesn't constant-fold via UHDM's
        // vpi_get_value from this loop-scoped use site the way a literal bound
        // does, so the reset write was previously misdetected as an ordinary
        // variable-index write keyed on the loop variable `a` — which has no
        // driver — leaving the final write-address mux's selector unwired.
        const graph = await runParser(
          backend,
          'array_multi_index_write_reset_parameterized_bound.sv',
          fixture('array_multi_index_write_reset_parameterized_bound.sv'),
        );
        const mod =
          graph.modules.array_multi_index_write_reset_parameterized_bound ??
          Object.values(graph.modules)[0];
        const arrayReg = mod.nodes.find(
          (n) => n.id === 'reg:array_multi_index_write_reset_parameterized_bound:storage',
        );
        expect(arrayReg).toBeDefined();
        expect(
          arrayReg?.ports.some((p) => p.name === 'reset' && p.connectedSignal === 'reset'),
        ).toBe(true);
        expect(arrayReg?.ports.some((p) => p.name === 'RV')).toBe(false);

        const addressMuxes = mod.nodes.filter((n) =>
          n.id.startsWith('mux:array_multi_index_write_reset_parameterized_bound:storage_addr'),
        );
        expect(addressMuxes).toHaveLength(1);
        const finalMux = mod.nodes.find(
          (n) => n.id === 'mux:array_multi_index_write_reset_parameterized_bound:storage_addr',
        );
        expect(finalMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('address');
        expect(
          mod.edges.some(
            (e) => e.signal === 'address' && e.target === finalMux?.id && e.targetPort === 'sel',
          ),
        ).toBe(true);
      },
    );

    it(
      'promotes write_en mux to stacked and chains it upstream of the ' +
        'addr mux for conditional array writes',
      async () => {
        const graph = await runParser(
          backend,
          'array_address_write_enable_register.sv',
          fixture('array_address_write_enable_register.sv'),
        );
        const mod =
          graph.modules.array_address_write_enable_register ?? Object.values(graph.modules)[0];
        const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'storage');
        expect(arrayReg).toBeDefined();
        expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);

        // Exactly two muxes: write_en (stacked) and addr (stacked). No spurious base-signal or
        // read muxes from intermediate signal names like 'storage[address]_next'.
        expect(mod.nodes.filter((n) => n.kind === 'mux')).toHaveLength(2);

        // write_en mux must be stacked (promoted because it drives an array-indexed write)
        const writeEnMux = mod.nodes.find(
          (n) =>
            n.kind === 'mux' &&
            (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
            n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'write_en'),
        );
        expect(writeEnMux).toBeDefined();
        // true input carries the write data; false input holds the whole-array value when disabled
        expect(writeEnMux?.ports.find((p) => p.name === 'true')?.connectedSignal).toBe('in_data');
        expect(writeEnMux?.ports.find((p) => p.name === 'false')?.connectedSignal).toBe('storage');

        // addr mux must be stacked, fed by the write_en mux output
        const addrMux = mod.nodes.find(
          (n) =>
            n.kind === 'mux' &&
            (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
            n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'address'),
        );
        expect(addrMux).toBeDefined();
        expect(addrMux?.ports.find((p) => p.label === 'default')?.connectedSignal).toBe('storage');

        // write_en mux output feeds the addr mux's addressed-write input
        const writeEnOut = writeEnMux?.ports.find((p) => p.direction === 'output')?.connectedSignal;
        expect(
          addrMux?.ports.find((p) => p.direction === 'input' && p.connectedSignal === writeEnOut),
        ).toBeDefined();

        // addr mux output feeds the array register
        expect(mod.edges.some((e) => e.source === addrMux?.id && e.target === arrayReg?.id)).toBe(
          true,
        );

        // scalar write_en promoted to stacked when entering the stacked write_en mux
        expect(
          mod.edges.some(
            (e) => e.signal === 'write_en' && e.target === writeEnMux?.id && e.isStacked,
          ),
        ).toBe(true);
        // in_data promoted to stacked (feeds stacked write_en mux)
        expect(
          mod.edges.some(
            (e) => e.signal === 'in_data' && e.target === writeEnMux?.id && e.isStacked,
          ),
        ).toBe(true);
        // storage Q (stacked array) feeds write_en mux false input
        expect(
          mod.edges.some(
            (e) =>
              e.source === arrayReg?.id &&
              e.target === writeEnMux?.id &&
              e.signal === 'storage' &&
              e.isStacked,
          ),
        ).toBe(true);
        // write_en mux to addr mux is stacked
        expect(
          mod.edges.some(
            (e) => e.source === writeEnMux?.id && e.target === addrMux?.id && e.isStacked,
          ),
        ).toBe(true);
        // addr mux to storage register is stacked
        expect(
          mod.edges.some(
            (e) => e.source === addrMux?.id && e.target === arrayReg?.id && e.isStacked,
          ),
        ).toBe(true);
      },
    );

    it('emits a non-stacked read mux for variable-index array reads', async () => {
      const graph = await runParser(backend, 'array_register.sv', fixture('array_register.sv'));
      const mod = graph.modules.array_register;
      const readMux = mod.nodes.find((n) => n.kind === 'mux' && n.label === 'read');
      expect(readMux).toBeDefined();
      // Read mux is NOT stacked — it converts stacked array to a scalar output
      expect(readMux?.isArrayNode ?? readMux?.metadata?.isArrayNode).toBeFalsy();
      expect(mod.edges.some((e) => e.source === readMux?.id && e.signal === 'read_data')).toBe(
        true,
      );
    });

    it('emits a scalar read mux that consumes a stacked array port', async () => {
      const graph = await runParser(
        backend,
        'array_address_read.sv',
        fixture('array_address_read.sv'),
      );
      const mod = graph.modules.array_address_read;
      expect(mod).toBeDefined();

      const arrayPort = mod.nodes.find((n) => n.id === 'port:array_address_read:M');
      const addressPort = mod.nodes.find((n) => n.id === 'port:array_address_read:address');
      const outputPort = mod.nodes.find((n) => n.id === 'port:array_address_read:read_data');
      const readMux = mod.nodes.find((n) => n.kind === 'mux' && n.label === 'read');

      expect(arrayPort?.isArrayNode ?? arrayPort?.metadata?.isArrayNode).toBe(true);
      expect(addressPort?.isArrayNode ?? addressPort?.metadata?.isArrayNode).toBeFalsy();
      expect(outputPort?.isArrayNode ?? outputPort?.metadata?.isArrayNode).toBeFalsy();
      expect(readMux).toBeDefined();
      expect(readMux?.isArrayNode ?? readMux?.metadata?.isArrayNode).toBeFalsy();
      expect(mod.nodes.some((n) => n.kind === 'select' && n.label === 'M[address]')).toBe(false);
      expect(readMux?.ports.find((p) => p.name === 'in')?.connectedSignal).toBe('M');
      expect(readMux?.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('address');
      expect(readMux?.ports.find((p) => p.name === 'out')?.connectedSignal).toBe('read_data');

      const arrayReadEdge = mod.edges.find(
        (e) => e.source === arrayPort?.id && e.target === readMux?.id && e.signal === 'M',
      );
      const selectorEdge = mod.edges.find(
        (e) => e.source === addressPort?.id && e.target === readMux?.id && e.targetPort === 'sel',
      );
      const outputEdge = mod.edges.find(
        (e) => e.source === readMux?.id && e.target === outputPort?.id && e.signal === 'read_data',
      );

      expect(arrayReadEdge).toBeDefined();
      expect(arrayReadEdge?.isStacked).toBe(true);
      expect(selectorEdge).toBeDefined();
      expect(selectorEdge?.isStacked).toBeFalsy();
      expect(outputEdge).toBeDefined();
      expect(outputEdge?.isStacked).toBeFalsy();
    });

    // eslint-disable-next-line max-len -- descriptive test name
    it('emits a single read path for a continuous variable-index read of a locally written memory', async () => {
      const graph = await runParser(
        backend,
        'array_local_read_write.sv',
        fixture('array_local_read_write.sv'),
      );
      const mod = graph.modules.array_local_read_write;
      expect(mod).toBeDefined();

      // One scalar read mux, and no parallel select node duplicating the same read.
      const readMuxes = mod.nodes.filter((n) => n.kind === 'mux' && n.label === 'read');
      expect(readMuxes).toHaveLength(1);
      expect(mod.nodes.some((n) => n.kind === 'select')).toBe(false);

      const readMux = readMuxes[0];
      expect(readMux.isArrayNode ?? readMux.metadata?.isArrayNode).toBeFalsy();
      expect(readMux.ports.find((p) => p.name === 'in')?.connectedSignal).toBe('ram');
      expect(readMux.ports.find((p) => p.name === 'sel')?.connectedSignal).toBe('addr');
      expect(readMux.ports.find((p) => p.name === 'out')?.connectedSignal).toBe('read_data');

      // The read mux is the only driver of the output port.
      const outputPort = mod.nodes.find((n) => n.id === 'port:array_local_read_write:read_data');
      const outputDrivers = mod.edges.filter((e) => e.target === outputPort?.id);
      expect(outputDrivers).toHaveLength(1);
      expect(outputDrivers[0].source).toBe(readMux.id);
    });

    // eslint-disable-next-line max-len -- descriptive test name
    it('dedupes a late-pass read mux against processAssign when the index needs sanitizing', async () => {
      const graph = await runParser(
        backend,
        'array_local_read_write_sanitized_index.sv',
        fixture('array_local_read_write_sanitized_index.sv'),
      );
      const mod = graph.modules.array_local_read_write_sanitized_index;
      expect(mod).toBeDefined();

      // The continuous `read_data` assignment (lowered by processAssign) and the
      // `u_reader` instance port (lowered by the late-pass array-read synthesis)
      // both read `ram[\addr#sel ]`. Without sanitizing the late-pass mux id the
      // same way processAssign does, the `#` produces a second, differently-ID'd
      // mux for the identical read.
      const readMuxes = mod.nodes.filter((n) => n.kind === 'mux' && n.label === 'read');
      expect(readMuxes).toHaveLength(1);
    });

    it('marks edges between stacked nodes as isStacked', async () => {
      const graph = await arrayRegisterGraph();
      const mod = graph.modules.array_register ?? Object.values(graph.modules)[0];

      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'M');
      const writeEnMux = mod.nodes.find(
        (n) =>
          n.kind === 'mux' &&
          (n.isArrayNode === true || n.metadata?.isArrayNode === true) &&
          n.ports.some((p) => p.name === 'sel' && p.connectedSignal === 'write_en'),
      );

      // Edge from stacked register M.Q to write_en mux should be stacked
      const stackedEdge = mod.edges.find(
        (e) => e.source === arrayReg?.id && e.target === writeEnMux?.id,
      );
      expect(stackedEdge).toBeDefined();
      expect(stackedEdge?.isStacked).toBe(true);

      // Promoted edge: scalar write_en into stacked mux should also be stacked
      const promotedEdge = mod.edges.find(
        (e) => e.signal === 'write_en' && e.target === writeEnMux?.id,
      );
      expect(promotedEdge).toBeDefined();
      expect(promotedEdge?.isStacked).toBe(true);
    });

    it('edge from stacked array output to non-stacked read mux is marked isStacked', async () => {
      const graph = await arrayRegisterGraph();
      const mod = graph.modules.array_register ?? Object.values(graph.modules)[0];

      const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'M');
      const readMux = mod.nodes.find((n) => n.kind === 'mux' && n.label === 'read');

      const stackedReadEdge = mod.edges.find(
        (e) => e.source === arrayReg?.id && e.target === readMux?.id,
      );
      expect(stackedReadEdge).toBeDefined();
      expect(stackedReadEdge?.isStacked).toBe(true);

      // Output edge from read mux to read_data is NOT stacked
      const scalarOutEdge = mod.edges.find(
        (e) => e.source === readMux?.id && e.signal === 'read_data',
      );
      expect(scalarOutEdge).toBeDefined();
      expect(scalarOutEdge?.isStacked).toBeFalsy();
    });

    it(
      'renders whole-array input through an array register to an array ' +
        'output without scalar alias nodes',
      async () => {
        const graph = await runParser(
          backend,
          'array_port_register.sv',
          fixture('array_port_register.sv'),
        );
        const mod = graph.modules.array_port_register;
        expect(mod).toBeDefined();

        const inputPort = mod.nodes.find((n) => n.kind === 'port' && n.label === 'in_data');
        const outputPort = mod.nodes.find((n) => n.kind === 'port' && n.label === 'out_data');
        const arrayReg = mod.nodes.find((n) => n.kind === 'register' && n.label === 'storage');
        expect(inputPort?.isArrayNode ?? inputPort?.metadata?.isArrayNode).toBe(true);
        expect(outputPort?.isArrayNode ?? outputPort?.metadata?.isArrayNode).toBe(true);
        expect(arrayReg?.isArrayNode ?? arrayReg?.metadata?.isArrayNode).toBe(true);
        expect(arrayReg?.ports.find((p) => p.name === 'D')?.connectedSignal).toBe('in_data');
        expect(arrayReg?.ports.find((p) => p.name === 'Q')?.connectedSignal).toBe('storage');

        expect(
          mod.nodes.some(
            (n) => n.kind === 'comb' && n.ports.some((p) => p.connectedSignal === 'out_data'),
          ),
        ).toBe(false);

        const inputEdge = mod.edges.find(
          (e) => e.source === inputPort?.id && e.target === arrayReg?.id && e.signal === 'in_data',
        );
        expect(inputEdge).toBeDefined();
        expect(inputEdge?.isStacked).toBe(true);

        const clockEdge = mod.edges.find(
          (e) =>
            e.source === 'port:array_port_register:clk' &&
            e.target === arrayReg?.id &&
            e.signal === 'clk',
        );
        expect(clockEdge).toBeDefined();
        expect(clockEdge?.isStacked).toBe(true);

        const outputEdge = mod.edges.find(
          (e) =>
            e.source === arrayReg?.id && e.target === outputPort?.id && e.signal === 'out_data',
        );
        expect(outputEdge).toBeDefined();
        expect(outputEdge?.isStacked).toBe(true);
      },
    );
  });
});
