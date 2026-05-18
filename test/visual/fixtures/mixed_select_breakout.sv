module mixed_select_breakout #(
    parameter P_WIDTH = 8
)(
    input logic [31:0] data_i,
    input logic [4:0] sel_i,
    output logic [7:0] static_out,
    output logic [P_WIDTH-1:0] variable_out
);
    // Static breakout: read bits 7:0
    assign static_out = data_i[7:0];

    // Variable select: read P_WIDTH bits starting at sel_i
    assign variable_out = data_i[sel_i +: P_WIDTH];
endmodule
