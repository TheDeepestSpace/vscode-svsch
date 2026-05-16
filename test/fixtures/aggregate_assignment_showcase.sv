typedef struct packed {
  logic [3:0] opcode;
  logic       valid;
  logic [1:0] lane;
} packet_t;

module aggregate_assignment_showcase(
  input  logic       clk,
  input  logic [1:0] d,
  input  logic       e,
  input  logic [1:0] opcode_hi,
  input  logic [1:0] opcode_lo,
  input  logic       valid_i,
  input  logic [1:0] lane_i,
  input  packet_t    pkt_i,
  output logic       a,
  output logic       b,
  output logic       c,
  output logic [3:0] mixed,
  output logic [7:0] mirrored,
  output logic [6:0] flat_from_struct,
  output logic [2:0] registered,
  output packet_t    pkt_o
);
  assign {a, b, c} = {d, e};

  assign {pkt_o.opcode, pkt_o.valid, pkt_o.lane} = {
    {opcode_hi, opcode_lo},
    valid_i,
    lane_i
  };

  assign {mixed[3:2], mixed[1], mixed[0]} = {
    opcode_hi,
    valid_i,
    e
  };

  assign {mirrored[7:4], mirrored[3:0]} = {
    {2{d}},
    {opcode_lo, opcode_hi}
  };

  assign {flat_from_struct[6:3], flat_from_struct[2], flat_from_struct[1:0]} = {
    pkt_i.opcode,
    pkt_i.valid,
    pkt_i.lane
  };

  always_ff @(posedge clk) begin
    {registered[2], registered[1:0]} <= {valid_i, lane_i};
  end
endmodule
