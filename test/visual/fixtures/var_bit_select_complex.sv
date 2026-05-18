module var_bit_select_complex(
    input logic [31:0] bus,
    input logic sel_1bit,
    input logic [4:0] sel_multi,
    output logic bit_out_1,
    output logic bit_out_2,
    output logic [7:0] part_out_1,
    output logic [7:0] part_out_2
);
    // 1-bit selector, 1-bit output
    assign bit_out_1 = bus[sel_1bit];

    // multi-bit selector, 1-bit output
    assign bit_out_2 = bus[sel_multi];

    // 1-bit selector, multi-bit output (indexed part select)
    assign part_out_1 = bus[sel_1bit*8 +: 8];

    // multi-bit selector, multi-bit output (indexed part select)
    assign part_out_2 = bus[sel_multi*8 +: 8];
endmodule
