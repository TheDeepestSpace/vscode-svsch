module mux_wired(
  input logic sel,
  input logic a,
  input logic b,
  output logic y
);
  logic a_wire;
  logic b_wire;

  assign a_wire = a;
  assign b_wire = b;

  always_comb begin
    case (sel)
      1'b0: y = a_wire;
      default: y = b_wire;
    endcase
  end
endmodule
