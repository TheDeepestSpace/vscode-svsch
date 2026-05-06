module bus_concat(
    input a,
    input b,
    output logic [1:0] y_comb,
    input clk,
    output logic [1:0] y_ff
);
    assign y_comb = {a, b};

    always_ff @(posedge clk) begin
        y_ff <= {b, a};
    end
endmodule

typedef struct packed {
    logic f_a;
    logic f_b;
} my_struct_t;

module struct_concat(
    input a,
    input b,
    output my_struct_t y
);
    assign y = {a, b};
endmodule

module struct_breakout(
    input my_struct_t u,
    output logic y_a,
    output logic y_b
);
    assign y_a = u.f_a;
    assign y_b = u.f_b;
endmodule
