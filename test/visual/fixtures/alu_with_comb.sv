module alu_with_comb (
  input logic a,
  input logic b,
  input logic c,
  output logic y
);
  assign y = a + (b | c);
endmodule
