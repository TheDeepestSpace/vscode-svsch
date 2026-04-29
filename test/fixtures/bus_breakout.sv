module bus_breakout(input [3:0] bus_in, output a, output b);
  assign a = bus_in[0];
  assign b = bus_in[1];
endmodule
