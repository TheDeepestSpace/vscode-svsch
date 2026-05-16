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
