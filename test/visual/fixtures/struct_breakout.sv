typedef struct packed {
  logic [3:0] opcode;
  logic valid;
  logic [1:0] lane;
} packet_t;

module top(
  input packet_t pkt,
  output logic [3:0] opcode,
  output logic valid,
  output logic [1:0] lane
);
  assign opcode = pkt.opcode;
  assign valid = pkt.valid;
  assign lane = pkt.lane;
endmodule
