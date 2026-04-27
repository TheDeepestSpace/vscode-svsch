module comb_connected (
  input logic a,
  input logic b,
  output logic decoded
);
  assign decoded = a & b;
endmodule
