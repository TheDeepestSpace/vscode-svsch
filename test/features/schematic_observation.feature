Feature: Schematic Observation
  As a hardware designer
  I want to see my SystemVerilog code reflected in a block diagram
  So that I can understand and verify my design visually

  Scenario: Observing input and output ports
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    Then I should see a port node "a"
    And I should see a port node "y"
    And there should be a connection between "a" and "y"

  Scenario: Observing combinational logic
    Given a SystemVerilog module:
      """
      module top(input a, input b, output y);
        assign y = a & b;
      endmodule
      """
    Then I should see a combinational block
    And there should be a connection between "a" and the combinational block
    And there should be a connection between "b" and the combinational block
    And there should be a connection between the combinational block and "y"

  Scenario: Observing registers
    Given a SystemVerilog module:
      """
      module top(input logic clk, input logic d, output logic q);
        always_ff @(posedge clk) begin
          q <= d;
        end
      endmodule
      """
    Then I should see a register node "q"
    And there should be a connection between "d" and the register node "q"
    And there should be a connection between "clk" and the register node "q"

  Scenario: Observing bus breakouts
    Given a SystemVerilog module:
      """
      module top(input [3:0] bus_in, output a, output b);
        assign a = bus_in[0];
        assign b = bus_in[1];
      endmodule
      """
    Then I should see a bus node "bus_in"
    And there should be a connection between the bus node "bus_in" and "a"
    And there should be a connection between the bus node "bus_in" and "b"

  Scenario: Observing bus composition
    Given the following SystemVerilog files:
      | file        | content |
      | bus_comp.sv | module bus_composition(input clk, input a, input b, input [1:0] sub, output logic [3:0] r);\n  always_ff @(posedge clk) begin\n    r[0]   <= a;\n    r[1]   <= b;\n    r[3:2] <= sub;\n  end\nendmodule |
    Then the diagram should contain exactly 3 nodes of type "register"
    And the diagram should contain exactly 1 node of type "bus"
    And there should be a connection from "reg:bus_composition:r[0]" port "Q" to "bus_comp:bus_composition:r" port "[0]"
    And there should be a connection from "reg:bus_composition:r[1]" port "Q" to "bus_comp:bus_composition:r" port "[1]"
    And there should be a connection from "reg:bus_composition:r[3:2]" port "Q" to "bus_comp:bus_composition:r" port "[3:2]"
    And there should be a connection from "bus_comp:bus_composition:r" port "r" to "port:bus_composition:r" port "r"

  Scenario: Observing module instances
    Given a SystemVerilog module:
      """
      module child(input a, output y);
        assign y = a;
      endmodule

      module top(input in, output out);
        child u_child(.a(in), .y(out));
      endmodule
      """
    Then I should see an instance node "u_child" of module "child"
    And there should be a connection between "in" and "u_child"
    And there should be a connection between "u_child" and "out"

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
