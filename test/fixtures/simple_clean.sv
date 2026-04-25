module child_sink(input logic a, input logic y);
endmodule

module top_clean(input logic clk, input logic rst_n, input logic sel, input logic a, input logic b, input logic ccc, output logic y);
  logic q, c_q;

  child_sink u_child (
    .a(a),
    .y(y)
  );

  always_ff @(posedge clk) begin
    q <= a;
  end

  always_ff @(posedge clk)
    c_q <= ccc;

  always_comb begin
    case (sel)
      1'b0: y = a;
      default: y = b;
    endcase
  end
endmodule
