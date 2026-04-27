Feature: Dynamic Updates
  As a hardware designer
  I want the diagram to update automatically when I change my code
  So that I always have an accurate visual representation

  Scenario: Adding a new combinational block
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I update the code to:
      """
      module top(input a, input b, output y);
        assign y = a & b;
      endmodule
      """
    Then I should see a combinational block
    And there should be a connection between "a" and the combinational block
    And there should be a connection between "b" and the combinational block
    And there should be a connection between the combinational block and "y"

  Scenario: Renaming a block
    Given a SystemVerilog module:
      """
      module top(input logic clk, input logic d, output logic q);
        always_ff @(posedge clk) begin
          q <= d;
        end
      endmodule
      """
    When I update the code to rename register "q" to "q_new":
      """
      module top(input logic clk, input logic d, output logic q_new);
        always_ff @(posedge clk) begin
          q_new <= d;
        end
      endmodule
      """
    Then I should see a register node "q_new"
    And I should not see a register node "q"
    And the register node "q_new" should be between port "d" and port "q_new"

  Scenario: Removing a block
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I update the code to remove the assignment:
      """
      module top(input a, output y);
      endmodule
      """
    Then I should see a port node "a"
    And I should see a port node "y"
    And there should not be a connection between "a" and "y"
