typedef enum logic [1:0] {
  STATE_IDLE,
  STATE_BUSY,
  STATE_DONE
} state_t;

typedef struct packed {
  logic [7:0] data;
  logic       valid;
} packet_t;

module typed_instance_child(
  input  packet_t pkt_i,
  input  state_t  state_i,
  output packet_t pkt_o
);
  assign pkt_o = pkt_i;
endmodule

module typed_instance_ports(
  input  packet_t pkt_i,
  input  state_t  state_i,
  output packet_t pkt_o
);
  typed_instance_child u_child(
    .pkt_i(pkt_i),
    .state_i(state_i),
    .pkt_o(pkt_o)
  );
endmodule
