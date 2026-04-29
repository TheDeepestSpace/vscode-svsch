module complex_process(
    input logic clk,
    input logic a,
    input logic b,
    input logic sel,
    input logic sidekick,
    output logic [1:0] y,
    output logic [1:0] z
);

    // Complex selector
    always_comb begin
        case (sel & sidekick)
            1'b0: y = {a, b};
            1'b1: y = {b, a};
        endcase
    end

    // Complex RHS in case branch
    always_comb begin
        case (sel)
            1'b0: z = {a & b, b | a};
            default: z = 2'b00;
        endcase
    end

    // Complex RHS in register
    logic [1:0] r;
    always_ff @(posedge clk) begin
        r <= {a ^ b, a & sidekick};
    end

endmodule
