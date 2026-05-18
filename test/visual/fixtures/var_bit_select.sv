module var_bit_select(
    input logic [31:0] bus,
    input logic [4:0] sel,
    output logic bit_out,
    input logic [3:0] sel_wide,
    output logic [7:0] byte_out
);
    // Variable bit select
    assign bit_out = bus[sel];

    // Variable indexed part select (plus-range)
    assign byte_out = bus[sel_wide*8 +: 8];
endmodule
