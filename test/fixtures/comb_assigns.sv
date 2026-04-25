module assign_wire(input logic a, output logic y);
  assign y = a;
endmodule

module assign_and(input logic a, input logic b, output logic y);
  assign y = a & b;
endmodule

module assign_const_expr(input logic a, output logic y);
  assign y = a | '0;
endmodule

module assign_comb_chain(input logic a, input logic b, input logic c, output logic y);
  logic mid;

  assign mid = a & b;
  assign y = mid | a & c;
endmodule
