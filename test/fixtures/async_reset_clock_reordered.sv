module async_reset_clock_reordered(input logic clr_n, input logic tck, input logic d, output logic q);
  always_ff @(negedge clr_n or posedge tck) begin
    if (!clr_n) q <= 1'b0;
    else q <= d;
  end
endmodule
