module register_preset (
    input clk,
    input rst,
    input [3:0] d,
    output reg [3:0] q
);

    always_ff @(posedge clk or posedge rst) begin
        if (rst) begin
            q <= 4'hA;
        end else begin
            q <= d;
        end
    end

endmodule
