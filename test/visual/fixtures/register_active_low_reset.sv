module register_active_low_reset(
  input logic c_main,
  input logic rst_n,
  input logic [2:0] d,
  output logic [2:0] q
);
  always_ff @(posedge c_main or negedge rst_n) begin
    if (!rst_n)
      q <= '0;
    else
      q <= d;
  end
endmodule
