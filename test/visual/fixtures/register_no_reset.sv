module register_no_reset(
  input logic c_main,
  input logic [2:0] d,
  output logic [2:0] q
);
  always_ff @(posedge c_main) begin
    q <= d;
  end
endmodule
