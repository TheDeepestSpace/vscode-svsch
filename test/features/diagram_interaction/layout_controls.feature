Feature: Diagram Interaction
  As a hardware designer
  I want to interact with the block diagram
  So that I can customize the layout to my preference

  Scenario: Resetting the layout
    Given I have a file "top.sv" in my workspace:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I move the port node "a"
    And I reset the layout
    Then the port node "a" should be at its original position

  Scenario: Resetting the layout also resets a resized block's size
    Given I have a file "top.sv" in my workspace:
      """
      module top(input logic clk, input logic d, output logic q);
        always_ff @(posedge clk) begin
          q <= d;
        end
      endmodule
      """
    When I open the "top" module in SVSCH
    And I resize the "q" block on the right side by 3 grid cells
    Then the "q" block should have grown on the right side
    When I reset the layout
    Then the "q" block should be at its canonical size

  Scenario: Revert Size resets every resized block in the selection
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, input logic b, output logic x, output logic y);
        leaf u1(.a(a), .y(x));
        leaf u2(.a(b), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I resize the "u1" block on the right side by 3 grid cells
    And I resize the "u2" block on the right side by 3 grid cells
    And click and drag the mouse to select the blocks "u1" and "u2"
    Then the "Revert Size" button should be visible
    When I click the "Revert Size" button
    Then the "u1" block should be at its canonical size
    And the "u2" block should be at its canonical size

  Scenario: Auto Layout All re-places every block using current positions as hints
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, input logic b, output logic x, output logic y);
        leaf u1(.a(a), .y(x));
        leaf u2(.a(b), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I move the block "u1" by (2, 0) grid cells
    And I move the block "u2" by (3, 5) grid cells
    And I note the position of the block "u1"
    And I note the position of the block "u2"
    And I click "Auto Layout All" in the diagram toolbar
    Then the block "u1" should be re-placed and fixed in the saved layout
    And the block "u1" should stay near its pre-auto-layout position
    And the block "u2" should be re-placed and fixed in the saved layout
    And the block "u2" should stay near its pre-auto-layout position

  Scenario Outline: Resizing a <block_kind> block
    Given I have a file "top.sv" in my workspace:
      """
      <system_verilog>
      """
    When I open the "top" module in SVSCH
    And I resize the "<block_label>" block on the right side by 3 grid cells
    Then the "<block_label>" block should have grown on the right side

    Examples:
      | block_kind       | block_label | system_verilog                                                                                                                                                                             |
      | register          | y           | module top(input logic clk, input logic a, output logic y); always_ff @(posedge clk) y <= a; endmodule                                                                                     |
      | instance          | u_leaf      | module leaf(input logic a, output logic y); assign y = a; endmodule module top(input logic a, output logic y); leaf u_leaf(.a(a), .y(y)); endmodule                                         |
      | stacked register  | y           | module top(input logic clk, input logic a [1:0], output logic y [1:0]); always_ff @(posedge clk) y <= a; endmodule                                                                          |
      | stacked instance  | u_mux       | module leaf(input logic a, output logic y); assign y = a; endmodule module top(input logic a [1:0], output logic y [1:0]); leaf u_mux [1:0] (.a(a), .y(y)); endmodule                        |

  Scenario: The Auto Layout control only appears once multiple blocks are selected
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, input logic b, output logic x, output logic y);
        leaf u1(.a(a), .y(x));
        leaf u2(.a(b), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    Then the "Auto Layout" button should not be visible
    When click and drag the mouse to select the blocks "u1" and "u2"
    Then the "Auto Layout" button should be visible
