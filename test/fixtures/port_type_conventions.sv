interface my_if;
  logic clk;
  modport master(input clk);
endinterface

typedef struct packed {logic [7:0] data;} my_struct_t;

module child_port_type_convensions (
    input a,
    input [7:0] b,
    input my_struct_t c,
    my_if.master d
);
endmodule

module top_port_type_convensions (
    input a,
    input [7:0] b,
    input my_struct_t c,
    my_if.master d
);
  child_port_type_convensions u_child (
      .a(a),
      .b(b),
      .c(c),
      .d(d)
  );
endmodule
