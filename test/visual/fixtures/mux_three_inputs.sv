module mux_three_inputs(
  input logic sel,
  input logic a,
  input logic b,
  input logic c,
  output logic y
);
  always_comb begin
    case (sel)
      2'd0: y = a;
      2'd1: y = b;
      default: y = c;
    endcase
  end
endmodule
