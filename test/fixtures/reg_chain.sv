module reg_chain(input logic clk, input logic a, input logic c, input logic d, output logic y);
  logic a_q;
  logic b_q;

  always_ff @(posedge clk) begin
    a_q <= a;
    b_q <= a_q & c & d;
  end

  assign y = b_q;
endmodule
