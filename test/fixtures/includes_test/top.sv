`include "params.svh"
module include_test (
  input logic [`MY_BITNESS-1:0] a,
  output logic [`MY_BITNESS-1:0] y
);
  assign y = a;
endmodule
