module multi_init_loop (
    input  logic [7:0] data_in,
    output logic [7:0] data_out
);

    always_comb begin
        // Stage 1: Initial constant
        data_out = 8'h01;
        
        // Stage 2: Procedural update before loop
        data_out = data_out + data_in;
        
        // Stage 3: Loop transformation
        for (int i = 0; i < 4; i++) begin
            data_out = data_out ^ 8'hFF;
        end
    end

endmodule
