module compound_event_unmatched(input logic a, input logic b, input logic c, input logic d, output logic q);
  always_ff @(posedge a or posedge b or negedge c) begin
    q <= d;
  end
endmodule
