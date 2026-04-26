module mux_selector_expr(
  input logic sel,
  input logic sidekick,
  input logic a,
  input logic b,
  output logic y
);
  always_comb begin
    case (sel & sidekick)
      1'b0: y = a;
      default: y = b;
    endcase
  end
endmodule
