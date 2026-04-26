module bus_three_taps(
  input logic [31:0] instr,
  output logic [6:0] opcode,
  output logic [4:0] rd,
  output logic [5:0] overlap
);
  assign opcode = instr[6:0];
  assign rd = instr[11:7];
  assign overlap = instr[10:5];
endmodule
