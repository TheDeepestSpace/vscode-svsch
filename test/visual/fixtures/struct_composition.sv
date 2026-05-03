module top(
  input logic clk,
  input logic [3:0] opcode_i,
  input logic valid_i,
  output logic [4:0] flat
);
  typedef struct packed {
    logic [3:0] opcode;
    logic valid;
  } packet_t;

  packet_t pkt;

  always_ff @(posedge clk) begin
    pkt.opcode <= opcode_i;
    pkt.valid <= valid_i;
  end

  assign flat = pkt;
endmodule
