interface stream_if(input logic clk, input logic rst_n);
  logic [7:0] data;
  logic valid;
  logic ready;
  logic sop;
  logic eop;
  logic error;
  logic flush;

  // svsch:modport:pos=left
  modport producer(
    input clk,
    input rst_n,
    input ready,
    input flush,
    output data,
    output valid,
    output sop,
    output eop,
    output error
  );

  modport consumer(
    input clk,
    input rst_n,
    input data,
    input valid,
    input sop,
    input eop,
    input error,
    input flush,
    output ready
  );

  modport monitor(
    input clk,
    input rst_n,
    input data,
    input valid,
    input ready,
    input sop,
    input eop,
    input error,
    input flush
  );

  // svsch:modport:pos=left
  modport controller(
    input clk,
    input rst_n,
    input valid,
    input ready,
    input error,
    output flush
  );
endinterface

module packet_source(stream_if.producer bus);
  assign bus.data = 8'h5a;
  assign bus.valid = bus.rst_n & ~bus.flush;
  assign bus.sop = bus.valid & bus.ready;
  assign bus.eop = bus.valid & bus.ready;
  assign bus.error = 1'b0;
endmodule

module packet_sink(stream_if.consumer bus);
  assign bus.ready = bus.rst_n & ~bus.flush;
endmodule

module packet_monitor(stream_if.monitor bus, output logic transfer_seen);
  assign transfer_seen = bus.valid & bus.ready & bus.sop & bus.eop;
endmodule

module packet_controller(stream_if.controller bus);
  assign bus.flush = bus.error & bus.valid & bus.ready;
endmodule

module interface_multi_modport(
  input logic clk,
  input logic rst_n,
  output logic transfer_seen
);
  stream_if stream(clk, rst_n);

  packet_source u_source(.bus(stream));
  packet_sink u_sink(.bus(stream));
  packet_monitor u_monitor(.bus(stream), .transfer_seen(transfer_seen));
  packet_controller u_controller(.bus(stream));
endmodule
