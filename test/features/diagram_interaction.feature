Feature: Diagram Interaction
  As a hardware designer
  I want to interact with the block diagram
  So that I can customize the layout to my preference

  Scenario: Moving a single block
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I move the port node "a" by (100, 100)
    Then the port node "a" should have moved

  Scenario: Manual positions are preserved across diagram reloads
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I move the port node "a" to (120, 120)
    And I close and reopen the diagram
    Then the port node "a" should be at (120, 120)

  Scenario: Manual positions are remembered even if the node is temporarily removed
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I move the port node "a" to (120, 120)
    And I update the code to remove node "a":
      """
      module top(output y);
        assign y = 1'b0;
      endmodule
      """
    And I update the code to bring back node "a":
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    Then the port node "a" should be at (120, 120)

  Scenario: Resetting the layout
    Given a SystemVerilog module:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    And I note the position of port node "a"
    When I move the port node "a" to (120, 120)
    And I reset the layout
    Then the port node "a" should not have moved
