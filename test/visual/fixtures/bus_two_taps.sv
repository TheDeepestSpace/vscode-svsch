module bus_two_taps(
  input logic [31:0] instr,
  output logic [6:0] opcode,
  output logic flag
);
  assign opcode = instr[6:0];
  assign flag = instr[30];
endmodule
