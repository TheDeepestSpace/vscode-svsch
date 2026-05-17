import { describe, expect, it } from 'vitest';
import { runParser } from '../helper';

describe('parser: interfaces and modports', () => {
  it('extracts interface modport formals, harness nodes, and field edges', async () => {
    const graph = await runParser('uhdm', 'interface_modport.sv', `
      interface simple_if(input logic clk);
        logic valid;
        logic ready;
        modport master(input clk, output valid, input ready);
        modport slave(input clk, input valid, output ready);
      endinterface

      module child(simple_if.slave bus, output logic y);
        assign bus.ready = bus.valid;
        assign y = bus.clk;
      endmodule

      module top(input logic clk);
        simple_if if0(clk);
        child u_child(.bus(if0), .y());
      endmodule
    `);

    const child = graph.modules.child;
    const busPort = child.ports.find((port) => port.name === 'bus');
    expect(busPort).toMatchObject({
      typeName: 'simple_if',
      modportName: 'slave'
    });
    expect(busPort?.typeSource).toMatchObject({ file: 'interface_modport.sv', startLine: 2 });
    expect(busPort?.modportSource).toMatchObject({ file: 'interface_modport.sv', startLine: 6 });

    const interfacePort = child.nodes.find((node) => node.id === 'interface:child:bus');
    expect(interfacePort).toBeDefined();
    expect(interfacePort?.metadata).toMatchObject({
      aggregateKind: 'interface',
      role: 'port',
      typeName: 'simple_if',
      modportName: 'slave'
    });
    expect(interfacePort?.ports.filter((port) => port.width === 'interface')).toEqual([
      expect.objectContaining({ name: 'slave', preferredSide: 'right' })
    ]);

    const harness = child.nodes.find((node) => node.id === 'interface_modport:child:bus');
    expect(harness).toBeDefined();
    expect(harness?.metadata).toMatchObject({
      aggregateKind: 'interface',
      role: 'modport',
      typeName: 'simple_if',
      modportName: 'slave'
    });
    // Module-declaration modports are flipped to the module perspective:
    // interface inputs feed the module from the right; interface outputs leave on the left.
    expect(harness?.ports.filter((port) => port.width !== 'interface').map((port) => [port.name, port.direction])).toEqual([
      ['clk', 'output'],
      ['valid', 'output'],
      ['ready', 'input']
    ]);

    expect(child.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'interface_modport:child:bus',
        sourcePort: 'out:valid',
        target: 'interface_modport:child:bus',
        targetPort: 'in:ready',
        signal: 'bus.valid',
      })
    ]));

    const top = graph.modules.top;
    const instancePort = top.nodes.find((node) => node.kind === 'instance' && node.label === 'u_child')?.ports.find((port) => port.name === 'bus');
    expect(instancePort).toMatchObject({ typeName: 'simple_if', modportName: 'slave' });
    
    // Interface instance nodes are synthesized
    expect(top.nodes.find((node) => node.kind === 'interface' && node.label === 'if0')).toBeDefined();

    const interfaceView = graph.modules['interface simple_if'];
    expect(interfaceView).toBeDefined();
    expect(interfaceView.nodes.find((node) => node.kind === 'interface' && node.metadata?.modportName === 'master')).toBeDefined();
    expect(interfaceView.nodes.find((node) => node.kind === 'interface' && node.metadata?.modportName === 'slave')).toBeDefined();
    expect(interfaceView.nodes.find((node) => node.kind === 'port' && node.label === 'clk')).toBeDefined();
    expect(interfaceView.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'port:interface_simple_if:clk',
        target: 'interface_modport:simple_if:master',
        targetPort: 'in:clk'
      }),
      expect.objectContaining({
        source: 'port:interface_simple_if:clk',
        target: 'interface_modport:simple_if:slave',
        targetPort: 'in:clk'
      })
    ]));
  });

  it('connects producer and consumer modules through a shared interface instance', async () => {
    const graph = await runParser('uhdm', 'interface_shared.sv', `
      interface simple_if(input logic clk);
        logic [7:0] data;
        logic valid;
        logic ready;
        modport master(input clk, output data, output valid, input ready);
        modport slave(input clk, input data, input valid, output ready);
      endinterface

      module producer(simple_if.master bus);
        assign bus.data = 8'h42;
        assign bus.valid = 1'b1;
      endmodule

      module consumer(simple_if.slave bus, output logic [7:0] observed);
        assign bus.ready = bus.valid;
        assign observed = bus.data;
      endmodule

      module top(input logic clk, output logic [7:0] observed);
        simple_if link(clk);
        producer u_producer(.bus(link));
        consumer u_consumer(.bus(link), .observed(observed));
      endmodule
    `);

    const top = graph.modules.top;
    // Hub node is now present
    const link = top.nodes.find((node) => node.kind === 'interface' && node.label === 'link');
    expect(link).toBeDefined();
    const linkInterfacePorts = link?.ports.filter((port) => port.width === 'interface') ?? [];
    expect(linkInterfacePorts.map((port) => port.label ?? port.name).sort()).toEqual(['master', 'slave']);
    expect(linkInterfacePorts.find((port) => port.name === 'master')).toMatchObject({ preferredSide: 'left' });
    expect(linkInterfacePorts.find((port) => port.name === 'slave')).toMatchObject({ preferredSide: 'right' });
    expect(linkInterfacePorts.every((port) => port.label !== 'link simple_if' && port.name !== 'link')).toBe(true);
    expect(link?.ports.find((port) => port.name === 'clk')).toMatchObject({
      direction: 'input',
      connectedSignal: 'link.clk'
    });

    const producerBus = top.nodes.find((node) => node.kind === 'instance' && node.label === 'u_producer')?.ports.find((port) => port.name === 'bus');
    const consumerBus = top.nodes.find((node) => node.kind === 'instance' && node.label === 'u_consumer')?.ports.find((port) => port.name === 'bus');
    expect(producerBus).toMatchObject({ typeName: 'simple_if', modportName: 'master', direction: 'output' });
    expect(consumerBus).toMatchObject({ typeName: 'simple_if', modportName: 'slave', direction: 'input' });
    
    // Edges go through the link hub
    expect(top.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'instance:top:u_producer',
        sourcePort: 'port:bus',
        target: 'interface:top:link',
        targetPort: 'in:master',
        signal: 'link',
        metadata: expect.objectContaining({ aggregate: 'interface' })
      }),
      expect.objectContaining({
        source: 'interface:top:link',
        sourcePort: 'out:slave',
        target: 'instance:top:u_consumer',
        targetPort: 'port:bus',
        signal: 'link',
        metadata: expect.objectContaining({ aggregate: 'interface' })
      })
    ]));

    const interfaceView = graph.modules['interface simple_if'];
    const master = interfaceView.nodes.find((node) => node.kind === 'interface' && node.metadata?.modportName === 'master');
    expect(master?.ports.map((port) => port.name)).toEqual(['clk', 'data', 'valid', 'ready']);
  });

  it('splits module interface ports from flipped modport field harnesses', async () => {
    const graph = await runParser('uhdm', 'interface_consumer.sv', `
      interface simple_if(input logic clk);
        logic [7:0] data;
        logic valid;
        logic ready;
        modport slave(input clk, input data, input valid, output ready);
      endinterface

      module consumer(simple_if.slave bus, output logic observed);
        assign bus.ready = bus.valid;
        assign observed = bus.data[0];
      endmodule
    `);

    const consumer = graph.modules.consumer;
    const interfacePort = consumer.nodes.find((node) => node.id === 'interface:consumer:bus');
    const modport = consumer.nodes.find((node) => node.id === 'interface_modport:consumer:bus');

    expect(interfacePort?.metadata).toMatchObject({ role: 'port', typeName: 'simple_if', modportName: 'slave' });
    expect(interfacePort?.ports.filter((port) => port.width === 'interface')).toEqual([
      expect.objectContaining({ name: 'slave', preferredSide: 'right' })
    ]);

    expect(modport?.metadata).toMatchObject({ role: 'modport', typeName: 'simple_if', modportName: 'slave' });
    expect(modport?.ports.filter((port) => port.width !== 'interface').map((port) => [port.name, port.direction])).toEqual([
      ['clk', 'output'],
      ['data', 'output'],
      ['valid', 'output'],
      ['ready', 'input']
    ]);
    expect(consumer.nodes.find((node) => node.id === 'comb:consumer:bus.ready:expr')).toBeUndefined();

    const validToReady = consumer.edges.find((edge) => (
      edge.source === 'interface_modport:consumer:bus'
      && edge.sourcePort === 'out:valid'
      && edge.target === 'interface_modport:consumer:bus'
      && edge.targetPort === 'in:ready'
    ));
    expect(validToReady).toMatchObject({ signal: 'bus.valid' });
    expect(validToReady?.metadata?.aggregate).toBeUndefined();

    const dataToBreakout = consumer.edges.find((edge) => (
      edge.source === 'interface_modport:consumer:bus'
      && edge.sourcePort === 'out:data'
      && edge.target === 'bus:consumer:data'
      && edge.targetPort === 'in:data'
    ));
    expect(dataToBreakout).toMatchObject({ signal: 'bus.data' });
    expect(dataToBreakout?.metadata?.aggregate).toBeUndefined();

    expect(consumer.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'bus:consumer:data',
        target: 'port:consumer:observed',
        targetPort: 'port:observed',
        signal: 'bus.data[0]'
      })
    ]));
  });

  it('extracts interfaces without modports as interface type views', async () => {
    const graph = await runParser('uhdm', 'interface_plain.sv', `
      interface packet_if;
        logic [7:0] data;
        logic valid;
      endinterface

      module top;
        packet_if pkt();
      endmodule
    `);

    const top = graph.modules.top;
    // synthesized node does not exist because there is no activity or ports
    expect(top.nodes.find((node) => node.kind === 'interface' && node.label === 'pkt')).toBeUndefined();

    const interfaceView = graph.modules['interface packet_if'];
    const typeNode = interfaceView.nodes.find((node) => node.kind === 'interface');
    expect(typeNode).toBeDefined();
    expect(typeNode?.ports.map((port) => port.name)).toEqual(expect.arrayContaining(['data', 'valid']));
  });

  it('preserves packed struct member type labels inside interfaces', async () => {
    const graph = await runParser('uhdm', 'interface_struct_member.sv', `
      typedef struct packed {
        logic [3:0] opcode;
        logic valid;
      } packet_t;

      interface packet_if;
        packet_t payload;
        logic ready;
      endinterface

      module consumer(packet_if bus, output logic valid);
        assign valid = bus.payload.valid & bus.ready;
      endmodule
    `);

    const consumer = graph.modules.consumer;
    const bus = consumer.nodes.find((node) => node.kind === 'interface' && node.label === 'bus');
    expect(bus).toBeDefined();
    expect(bus?.metadata?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'payload', typeName: 'packet_t' }),
      expect.objectContaining({ name: 'ready' })
    ]));
    expect(bus?.ports.find((port) => port.name === 'payload')).toMatchObject({ typeName: 'packet_t' });

    const interfaceView = graph.modules['interface packet_if'];
    const typeNode = interfaceView.nodes.find((node) => node.kind === 'interface');
    expect(typeNode?.ports.find((port) => port.name === 'payload')).toMatchObject({ typeName: 'packet_t' });
  });

  it('calculates modport positioning and respects svsch:modport:pos comments', async () => {
    const graph = await runParser('uhdm', 'interface_pos.sv', `
      interface pos_if;
        logic a, b, c, d;
        // svsch:modport:pos=left
        modport manual_left(input a, input b);
        
        modport producer(output a, output b);
        modport consumer(input a, input b, input c);
      endinterface

      module top;
        pos_if if0();
      endmodule
    `);

    const interfaceView = graph.modules['interface pos_if'];
    
    const manualLeft = interfaceView.nodes.find(n => n.metadata?.modportName === 'manual_left');
    expect(manualLeft?.metadata?.preferredSide).toBe('left');

    const producer = interfaceView.nodes.find(n => n.metadata?.modportName === 'producer');
    expect(producer?.metadata?.preferredSide).toBe('left');

    const consumer = interfaceView.nodes.find(n => n.metadata?.modportName === 'consumer');
    expect(consumer?.metadata?.preferredSide).toBe('right');
  });
});
