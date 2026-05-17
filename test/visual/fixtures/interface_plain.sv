interface packet_if;
  logic [7:0] data;
  logic valid;
endinterface

module interface_plain;
  packet_if pkt();
endmodule
