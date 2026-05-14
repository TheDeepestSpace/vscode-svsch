module replication_expr (
  input  logic        some_wire,
  input  logic [1:0]  pair,
  input  logic        head,
  input  logic        tail,
  output logic [19:0] repeated,
  output logic [23:0] concat_repeated,
  output logic [7:0]  repeated_pair,
  output logic [5:0]  nested_concat,
  output logic [3:0]  fill_ones
);
  localparam int FILL = 4;

  assign repeated = {20{some_wire}};
  assign concat_repeated = {head, {22{some_wire}}, tail};
  assign repeated_pair = {4{pair}};
  assign nested_concat = {2{head, pair}};
  assign fill_ones = {FILL{1'b1}};
endmodule
