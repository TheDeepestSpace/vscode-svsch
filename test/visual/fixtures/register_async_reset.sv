module register_async_reset(
  input logic c_main,
  input logic rst,
  input logic [2:0] d,
  output logic [2:0] q
);
  always_ff @(posedge c_main or posedge rst) begin
    if (rst)
      q <= '0;
    else
      q <= d;
  end
endmodule
