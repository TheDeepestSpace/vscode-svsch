module loop_logic (
    input  logic [7:0] data_in,
    input  logic [2:0] shift_amt,
    output logic [7:0] data_out,
    output logic [7:0] parity_bits
);

    // For loop for shifting
    always_comb begin
        data_out = 8'b0;
        for (int i = 0; i < 8; i++) begin
            if (i < shift_amt)
                data_out[i] = data_in[i];
        end
    end

    // Repeat loop for some arbitrary logic
    always_comb begin
        parity_bits = 8'b0;
        repeat (4) begin
            parity_bits = parity_bits ^ data_in;
        end
    end

endmodule
