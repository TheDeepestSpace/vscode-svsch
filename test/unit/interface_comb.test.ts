import { describe, expect, it } from 'vitest';
import { runParser } from '../helper';
import backend from '../../src/parser/backend';

describe('parser: interface slice assignment', () => {
  it('does not create redundant comb nodes for interface field slice assignments', async () => {
    const graph = await runParser(backend, [{ file: 'interface_comb.sv', text: `
      interface simple_if();
        logic [7:0] data;
        modport slave(input data);
      endinterface

      module consumer(simple_if.slave bus, output logic observed);
        assign observed = bus.data[0];
      endmodule
    ` }]);

    const consumer = graph.modules.consumer;
    expect(consumer).toBeDefined();
    
    // There should be no comb nodes if the assignment is direct.
    const combNodes = consumer.nodes.filter(n => n.kind === 'comb');
    expect(combNodes.length).toBe(0);
    
    // There should be a direct edge from the interface breakout to the port.
    const observedEdges = consumer.edges.filter(e => e.target === 'port:consumer:observed');
    expect(observedEdges.length).toBe(1);
    expect(observedEdges[0].source).toContain('bus');
    expect(observedEdges[0].signal).toBe('bus.data[0]');
  });
});
