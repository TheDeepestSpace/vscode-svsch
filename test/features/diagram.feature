Feature: Diagram Manipulation
  As a hardware designer
  I want to see my SystemVerilog code reflected in a block diagram
  So that I can understand and verify my design visually

  Scenario: Simple assignment from input to output
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    Then I should see a port node "a"
    And I should see a port node "y"
    And there should be a connection between "a" and "y"

  Scenario: Combinational block appears
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

  Scenario: Register appears
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

  Scenario: Moving a block on the diagram
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I move the port node "a" by (50, 50)
    Then the port node "a" should have moved
