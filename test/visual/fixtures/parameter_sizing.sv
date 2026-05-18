module param_child #(
  parameter WIDTH = 8,
  parameter DEPTH = 4,
  localparam TOTAL = WIDTH + DEPTH
) (
  input logic [WIDTH-1:0] data_i,
  output logic [WIDTH-1:0] data_o
);
  assign data_o = data_i;
endmodule

module parameter_sizing_top #(
  parameter TOP_W = 12,
  localparam DEPTH_OVERRIDE = 2
) (
  input logic [7:0] default_i,
  input logic [TOP_W-1:0] override_i,
  output logic [7:0] default_o,
  output logic [TOP_W-1:0] override_o
);
  param_child u_default(
    .data_i(default_i),
    .data_o(default_o)
  );

  param_child #(
    .WIDTH(TOP_W),
    .DEPTH(DEPTH_OVERRIDE)
  ) u_override(
    .data_i(override_i),
    .data_o(override_o)
  );
endmodule

module many_param_child #(
  parameter WIDTH = 8,
  parameter ADDR_W = 4,
  parameter DEPTH = (1 << ADDR_W),
  parameter MASK = (1 << WIDTH) - 1,
  parameter MODE = WIDTH + ADDR_W,
  localparam TOTAL_W = WIDTH + ADDR_W
) (
  input logic [WIDTH-1:0] data_i,
  output logic [WIDTH-1:0] data_o
);
  assign data_o = data_i;
endmodule

module many_parameter_top #(
  parameter TOP_W = 16,
  parameter TOP_ADDR = 5,
  localparam LOCAL_DEPTH = (1 << TOP_ADDR),
  localparam LOCAL_MASK = (1 << TOP_W) - 1
) (
  input logic [TOP_W-1:0] many_i,
  output logic [TOP_W-1:0] many_o
);
  many_param_child #(
    .WIDTH(TOP_W),
    .ADDR_W(TOP_ADDR),
    .DEPTH(LOCAL_DEPTH),
    .MASK(LOCAL_MASK),
    .MODE(TOP_W + TOP_ADDR)
  ) u_many(
    .data_i(many_i),
    .data_o(many_o)
  );
endmodule
