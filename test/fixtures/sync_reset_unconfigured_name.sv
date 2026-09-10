module sync_reset_unconfigured_name(input logic clk, input logic clr_n, input logic d, output logic q);
  always_ff @(posedge clk) begin
    if (!clr_n) q <= 1'b0;
    else q <= d;
  end
endmodule
