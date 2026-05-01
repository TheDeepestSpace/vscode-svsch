Feature: Literals and Constants
  As a hardware designer
  I want to see literals and constants explicitly in the diagram
  So that I can easily identify fixed values and configuration parameters

  Scenario: Observing literal assignments
    Given a SystemVerilog module:
      """
      module top(output logic [7:0] y);
        assign y = 8'h42;
      endmodule
      """
    Then I should see a literal node "8'h42"
    And there should be a connection between "8'h42" and "y"

  Scenario: Observing named constants
    Given a SystemVerilog module:
      """
      module top(output logic [3:0] y);
        localparam logic [3:0] VERSION = 4'd5;
        assign y = VERSION;
      endmodule
      """
    Then I should see a literal node "VERSION"
    And there should be a connection between "VERSION" and "y"

  Scenario: Observing literal 42
    Given a SystemVerilog module:
      """
      module top(output logic [7:0] y);
        assign y = 8'd42;
      endmodule
      """
    Then I should see a literal node "8'd42"
    And there should be a connection between "8'd42" and "y"

  Scenario: Observing FSM with states
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(input clk, input rst_n, input logic next_state_en, output logic [1:0] state); \n typedef enum logic [1:0] {IDLE=0, START=1, BUSY=2, DONE=3} state_t; \n state_t r, next_r; \n always_ff @(posedge clk or negedge rst_n) if(!rst_n) r <= IDLE; else r <= next_r; \n always_comb begin next_r = r; if (next_state_en) begin case (r) IDLE: next_r = START; START: next_r = BUSY; BUSY: next_r = DONE; DONE: next_r = IDLE; default: next_r = IDLE; endcase end end \n assign state = r; \n endmodule |
    Then I should see a register node "r"
    And I should see a literal node "IDLE"
    And I should see a literal node "START"
    And I should see a literal node "BUSY"
    And I should see a literal node "DONE"
    And there should be a connection between "IDLE" and "r"
