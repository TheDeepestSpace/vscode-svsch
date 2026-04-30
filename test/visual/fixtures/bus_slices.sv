module bus_slices(
  input logic clk,
  input logic [31:0] instr,
  input logic [7:0] a,
  input logic [7:0] b,
  output logic [7:0] y
);
  logic [2:0] funct3_q;
  logic [7:0] decoded;

  always_ff @(posedge clk) begin
    funct3_q <= instr[14:12];
  end

  assign decoded = instr[6:0] & a;

  always_comb begin
    case (instr[30])
      1'b0: y = decoded;
      default: y = b;
    endcase
  end
endmodule
