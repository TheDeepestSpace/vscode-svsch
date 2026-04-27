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
