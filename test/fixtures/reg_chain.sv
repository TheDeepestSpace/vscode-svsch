module reg_chain(input logic clk, input logic a, output logic y);
  logic a_q;
  logic b_q;

  always_ff @(posedge clk) begin
    a_q <= a;
    b_q <= a_q;
  end

  assign y = b_q;
endmodule
