interface channel_if(input logic clk, input logic rst_n);
  logic [7:0] data;
  logic valid;
  logic ready;
  logic flush;

  // svsch:modport:pos=left
  modport producer(
    input clk,
    input rst_n,
    input ready,
    input flush,
    output data,
    output valid
  );

  modport consumer(
    input clk,
    input rst_n,
    input data,
    input valid,
    input flush,
    output ready
  );

  modport monitor(
    input clk,
    input rst_n,
    input data,
    input valid,
    input ready,
    input flush
  );

  // svsch:modport:pos=left
  modport controller(
    input clk,
    input rst_n,
    input valid,
    input ready,
    output flush
  );
endinterface

interface channel_uneven_if(input logic clk, input logic rst_n);
  logic [7:0] data;
  logic valid;
  logic ready;
  logic flush;

  // svsch:modport:pos=left
  modport producer(
    input clk,
    input rst_n,
    input ready,
    input flush,
    output data,
    output valid
  );

  modport consumer(
    input clk,
    input rst_n,
    input data,
    input valid,
    input flush,
    output ready
  );

  // svsch:modport:pos=left
  modport controller(
    input clk,
    input rst_n,
    input valid,
    input ready,
    output flush
  );
endinterface

interface left_only_if(input logic clk, input logic rst_n);
  logic grant;
  logic request;

  // svsch:modport:pos=left
  modport requester(input clk, input rst_n, input grant, output request);

  // svsch:modport:pos=left
  modport arbiter(input clk, input rst_n, input request, output grant);
endinterface

interface right_only_if(input logic clk, input logic rst_n);
  logic [3:0] data;
  logic valid;
  logic ready;

  // svsch:modport:pos=right
  modport sink(input clk, input rst_n, input data, input valid, output ready);

  // svsch:modport:pos=right
  modport observer(input clk, input rst_n, input data, input valid, input ready);
endinterface

interface bridge_pair_if(input logic clk, input logic rst_n);
  logic [7:0] data;
  logic valid;
  logic ready;

  // svsch:modport:pos=right
  modport master(input clk, input rst_n, input data, input valid, output ready);

  // svsch:modport:pos=left
  modport slave(input clk, input rst_n, input ready, output data, output valid);
endinterface

interface status_if(input logic clk, input logic rst_n, output logic done);
  logic valid;
  logic ready;

  assign done = valid & ready;

  // svsch:modport:pos=left
  modport producer(input clk, input rst_n, input ready, output valid);

  modport consumer(input clk, input rst_n, input valid, output ready);
endinterface

module channel_source(channel_if.producer bus);
  assign bus.data = 8'hc3;
  assign bus.valid = bus.rst_n & ~bus.flush;
endmodule

module channel_sink(channel_if.consumer bus);
  assign bus.ready = bus.rst_n & ~bus.flush;
endmodule

module channel_monitor(channel_if.monitor bus, output logic seen);
  assign seen = bus.valid & bus.ready;
endmodule

module channel_controller(channel_if.controller bus);
  assign bus.flush = bus.valid & ~bus.ready;
endmodule

module uneven_source(channel_uneven_if.producer bus);
  assign bus.data = 8'h3c;
  assign bus.valid = bus.rst_n & ~bus.flush;
endmodule

module uneven_sink(channel_uneven_if.consumer bus);
  assign bus.ready = bus.rst_n & ~bus.flush;
endmodule

module uneven_controller(channel_uneven_if.controller bus);
  assign bus.flush = bus.valid & ~bus.ready;
endmodule

module left_requester(left_only_if.requester bus);
  assign bus.request = bus.rst_n & ~bus.grant;
endmodule

module left_arbiter(left_only_if.arbiter bus);
  assign bus.grant = bus.request;
endmodule

module right_sink(right_only_if.sink bus);
  assign bus.ready = bus.rst_n & bus.valid;
endmodule

module right_observer(right_only_if.observer bus);
endmodule

module pair_source(bridge_pair_if.slave bus);
  assign bus.data = 8'ha5;
  assign bus.valid = bus.rst_n;
endmodule

module pair_sink(bridge_pair_if.master bus);
  assign bus.ready = bus.rst_n & bus.valid;
endmodule

module status_source(status_if.producer bus);
  assign bus.valid = bus.rst_n & bus.ready;
endmodule

module status_sink(status_if.consumer bus);
  assign bus.ready = bus.valid;
endmodule

module pair_bridge(
  bridge_pair_if.master upstream,
  bridge_pair_if.slave downstream
);
  assign downstream.data = upstream.data;
  assign downstream.valid = upstream.valid;
  assign upstream.ready = downstream.ready;
endmodule

module interface_uneven_modport(
  input logic clk,
  input logic rst_n
);
  channel_uneven_if link(clk, rst_n);

  uneven_source u_source(.bus(link));
  uneven_sink u_sink(.bus(link));
  uneven_controller u_controller(.bus(link));
endmodule

module interface_consumer_fanout(
  input logic clk,
  input logic rst_n
);
  channel_uneven_if link(clk, rst_n);

  uneven_source u_source(.bus(link));
  uneven_sink u_sink0(.bus(link));
  uneven_sink u_sink1(.bus(link));
  uneven_sink u_sink2(.bus(link));
  uneven_controller u_controller(.bus(link));
endmodule

module interface_all_left_modports(input logic clk, input logic rst_n);
  left_only_if request_bus(clk, rst_n);

  left_requester u_requester(.bus(request_bus));
  left_arbiter u_arbiter(.bus(request_bus));
endmodule

module interface_all_right_modports(input logic clk, input logic rst_n);
  right_only_if event_bus(clk, rst_n);

  right_sink u_sink(.bus(event_bus));
  right_observer u_observer(.bus(event_bus));
endmodule

module interface_dual_modport_bridge(
  input logic clk,
  input logic rst_n
);
  bridge_pair_if upstream(clk, rst_n);
  bridge_pair_if downstream(clk, rst_n);

  pair_bridge u_bridge(
    .upstream(upstream),
    .downstream(downstream)
  );
endmodule

module interface_output_wire(
  input logic clk,
  input logic rst_n,
  output logic done
);
  status_if status(clk, rst_n, done);

  status_source u_source(.bus(status));
  status_sink u_sink(.bus(status));
endmodule
