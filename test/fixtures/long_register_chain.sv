// A long horizontal chain of registers, wide enough that the diagram
// extends well past a normal viewport at 100% zoom. Used by the system test
// that zooms into one end of the chain and selects source text for a
// register at the other (off-screen) end, verifying the diagram pans/zooms
// to bring the newly highlighted node into view. See
// test/system/sourceSelectionHighlight.spec.ts.
module long_register_chain(
  input logic clk,
  input logic d,
  output logic q
);
  logic s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14;

  always_ff @(posedge clk) s1 <= d;
  always_ff @(posedge clk) s2 <= s1;
  always_ff @(posedge clk) s3 <= s2;
  always_ff @(posedge clk) s4 <= s3;
  always_ff @(posedge clk) s5 <= s4;
  always_ff @(posedge clk) s6 <= s5;
  always_ff @(posedge clk) s7 <= s6;
  always_ff @(posedge clk) s8 <= s7;
  always_ff @(posedge clk) s9 <= s8;
  always_ff @(posedge clk) s10 <= s9;
  always_ff @(posedge clk) s11 <= s10;
  always_ff @(posedge clk) s12 <= s11;
  always_ff @(posedge clk) s13 <= s12;
  always_ff @(posedge clk) s14 <= s13;
  always_ff @(posedge clk) q <= s14;
endmodule
