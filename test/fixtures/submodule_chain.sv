module sub_a(input logic in_a, output logic out_a);
  assign out_a = ~in_a;
endmodule

module sub_b(input logic in_b, output logic out_b);
  assign out_b = in_b;
endmodule

module top_chain(input logic top_in, output logic top_out);
  logic mid;

  sub_a u_sub_a (
    .in_a(top_in),
    .out_a(mid)
  );

  sub_b u_sub_b (
    .in_b(mid),
    .out_b(top_out)
  );
endmodule
