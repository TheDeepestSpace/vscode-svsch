module complex(input logic clk, output logic y);
  generate
    if (1) begin : gen_block
      assign y = clk;
    end
  endgenerate

  initial begin
    $display("simulation-only");
  end
endmodule
