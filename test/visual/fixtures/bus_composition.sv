module bus_composition(
    input clk,
    input a,
    input b,
    input [1:0] sub,
    output logic [3:0] r
);

    always_ff @(posedge clk) begin
        r[0]   <= a;
        r[1]   <= b;
        r[3:2] <= sub;
    end

endmodule
