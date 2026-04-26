module mux_only(
  input logic sel,
  input logic a,
  input logic b,
  output logic y
);
  always_comb begin
    case (sel)
      1'b0: y = a;
      default: y = b;
    endcase
  end
endmodule
