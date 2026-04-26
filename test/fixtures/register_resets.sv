module reg_resets(
  input logic c_main,
  input logic rst_n,
  input logic rst,
  input logic [3:0] din,
  output logic [3:0] q_async_low,
  output logic [3:0] q_async_high,
  output logic [3:0] q_sync_high
);
  always_ff @(posedge c_main or negedge rst_n) begin
    if (!rst_n)
      q_async_low <= '0;
    else
      q_async_low <= din;
  end

  always_ff @(posedge c_main or posedge rst) begin
    if (rst)
      q_async_high <= '0;
    else
      q_async_high <= din;
  end

  always_ff @(posedge c_main) begin
    if (rst)
      q_sync_high <= '0;
    else
      q_sync_high <= din;
  end
endmodule
