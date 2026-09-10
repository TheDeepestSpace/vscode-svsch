module sync_reset_nested_negation(input logic clk, input logic enable, input logic custom_clr_n, input logic d, output logic q);
  always_ff @(posedge clk) begin
    if (enable && !custom_clr_n) q <= 1'b0;
    else q <= d;
  end
endmodule
