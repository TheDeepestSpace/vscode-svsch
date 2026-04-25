module child(input logic a, output logic y);
  assign y = a;
endmodule

module top(input logic clk, input logic rst_n, input logic sel, input logic a, input logic b, output logic y);
  logic q;

  child u_child (
    .a(a),
    .y(y)
  );

  always_ff @(posedge clk) begin
    q <= a;
  end

  always_comb begin
    case (sel)
      1'b0: y = a;
      default: y = b;
    endcase
  end
endmodule
