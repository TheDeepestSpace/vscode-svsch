typedef struct packed {
  logic [3:0] opcode1;
  logic [3:0] opcode2;
  logic valid;
} packet_t;

module internal_wire_instance(
    input packet_t pkt,
    input logic [1:0] sel,
    input logic [3:0] fallback,
    output logic [3:0] y,
    output packet_t pkt_recomb
);
  logic [3:0] opcode_w;

  always_comb begin
    if (sel == 2'b11) begin
      y = pkt.opcode1;
    end else if (sel == 2'b10) begin
      y = pkt.opcode2;
    end else begin
      y = fallback;
    end
  end

  assign pkt_recomb.opcode1 = pkt.opcode2;
  assign pkt_recomb.opcode2 = pkt.opcode1;
  assign pkt_recomb.valid = pkt.valid;
endmodule
