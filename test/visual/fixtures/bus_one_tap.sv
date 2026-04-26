module bus_one_tap(
  input logic [31:0] instr,
  output logic [6:0] opcode
);
  assign opcode = instr[6:0];
endmodule
