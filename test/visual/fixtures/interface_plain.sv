interface packet_if;
  logic [7:0] data;
  logic valid;
endinterface

module top;
  packet_if pkt();
endmodule
