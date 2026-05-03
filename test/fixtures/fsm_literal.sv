module fsm_literal (
    input logic clk,
    input logic rst_n,
    input logic next_state_en,
    output logic [1:0] state_out,
    output logic is_idle,
    output logic [3:0] version_out,
    output logic [7:0] const_val
);
  typedef enum logic [1:0] {
    IDLE  = 2'b00,
    START = 2'b01,
    BUSY  = 2'b10,
    DONE  = 2'b11
  } state_t;

  state_t state_reg, next_state;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) state_reg <= IDLE;
    else state_reg <= next_state;
  end

  always_comb begin
    if (next_state_en) begin
      case (state_reg)
        IDLE: next_state = START;
        START: next_state = BUSY;
        BUSY: next_state = DONE;
        DONE: next_state = IDLE;
        default: next_state = IDLE;
      endcase
    end else begin
      next_state = IDLE;
    end
  end

  assign state_out = state_reg;
  assign is_idle   = (state_reg == IDLE);

  // Some simple literal assignments to test explicit literal nodes
  assign const_val = 8'h2A;  // 42

  parameter logic [3:0] VERSION = 4'd5;
  assign version_out = VERSION;

endmodule
