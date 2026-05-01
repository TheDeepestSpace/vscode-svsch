module multiple_procedural_assigns(
    input clk,
    input a,
    input b,
    input c,
    input d,
    output logic x,
    output logic y,
    output logic z,
    output logic [1:0] r
);

    // Multiple assignments in always_comb to different signals
    always_comb begin
        x = a;
        y = b;
    end

    // Multiple assignments in always_comb to the SAME signal
    always_comb begin
        z = c;
        z = d;
    end

    // Multiple assignments in always_ff
    always_ff @(posedge clk) begin
        r[0] <= a;
        r[1] <= b;
    end

endmodule
