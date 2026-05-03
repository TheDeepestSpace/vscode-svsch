import { describe, it, expect } from 'vitest';
import { runParser } from '../helper';

describe('Parser Typing Support', () => {
  it('extracts enum type names for ports and registers', async () => {
    const code = `
      typedef enum logic [1:0] { IDLE, READY } state_t;
      module top (
        input state_t in_state,
        output state_t out_state
      );
        state_t current_state;
        always_ff @(posedge clk) current_state <= in_state;
        assign out_state = current_state;
      endmodule
    `;
    const graph = await runParser('uhdm', 'enum_test.sv', code);
    const mod = graph.modules['top'];

    // Check module ports
    const inStatePort = mod.ports.find(p => p.name === 'in_state');
    expect(inStatePort?.typeName).toBe('state_t');
    expect(inStatePort?.typeSource).toMatchObject({ file: 'enum_test.sv', startLine: 2 });

    const outStatePort = mod.ports.find(p => p.name === 'out_state');
    expect(outStatePort?.typeName).toBe('state_t');

    // Check register node
    const regNode = mod.nodes.find(n => n.kind === 'register');
    expect(regNode?.metadata?.typeName).toBe('state_t');
    expect(regNode?.metadata?.typeSource).toMatchObject({ file: 'enum_test.sv', startLine: 2 });
  });

  it('extracts struct type names for ports and registers without relabeling connections', async () => {
    const code = `
      typedef struct packed {
        logic [7:0] data;
        logic valid;
      } packet_t;
      module top (
        input packet_t in_p,
        output packet_t out_p
      );
        packet_t current_packet;
        always_ff @(posedge clk) current_packet <= in_p;
        assign out_p = in_p;
      endmodule
    `;
    const graph = await runParser('uhdm', 'struct_test.sv', code);
    const mod = graph.modules['top'];

    const inPacketPort = mod.ports.find(p => p.name === 'in_p');
    expect(inPacketPort?.typeName).toBe('packet_t');

    const outPacketPort = mod.ports.find(p => p.name === 'out_p');
    expect(outPacketPort?.typeName).toBe('packet_t');

    const regNode = mod.nodes.find(n => n.kind === 'register');
    expect(regNode?.metadata?.typeName).toBe('packet_t');

    const edge = mod.edges.find(e => e.signal === 'in_p');
    expect(edge?.label).not.toBe('packet_t');
    expect((edge as any)?.typeName).toBeUndefined();
  });
});
