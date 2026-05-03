typedef enum logic [1:0] {
    IDLE = 2'b00,
    READY = 2'b01,
    BUSY = 2'b10,
    ERROR = 2'b11
} state_t;

module top (
    input  logic clk,
    input  logic rst_n,
    input  state_t in_state,
    output state_t out_state
);

    state_t current_state;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            current_state <= IDLE;
        end else begin
            current_state <= in_state;
        end
    end

    assign out_state = current_state;

endmodule
