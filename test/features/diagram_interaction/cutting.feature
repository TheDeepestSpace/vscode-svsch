Feature: Diagram Interaction
  As a hardware designer
  I want to interact with the block diagram
  So that I can customize the layout to my preference

  Scenario: Declared nets are automatically cut on first open
    Given I have a file "top.sv" in my workspace:
      """
      module top(input a, output x, output y);
        wire chip_select;
        assign chip_select = a;
        assign x = chip_select;
        assign y = chip_select;
      endmodule
      """
    When I open the "top" module in SVSCH
    Then I should see 3 cut net labels named "chip_select"
    And the original connection between "a" and "x" should be hidden
    And the original connection between "a" and "y" should be hidden

  Scenario: Register clock and reset nets are automatically cut on first open
    Given I have a file "top.sv" in my workspace:
      """
      module top(input logic clk, input logic rst_n, input logic d, output logic q);
        always_ff @(posedge clk or negedge rst_n) begin
          if (!rst_n) q <= 1'b0;
          else q <= d;
        end
      endmodule
      """
    When I open the "top" module in SVSCH
    Then I should see 2 cut net labels named "clk"
    And I should see 2 cut net labels named "rst_n"

  Scenario: Register clock and reset automatic cuts can be disabled
    Given I disable clock and reset cuts using this setting:
      """
      "svsch.autocut-clk-reset": false
      """
    And I have a file "top.sv" in my workspace:
      """
      module top(input logic clk, input logic rst_n, input logic d, output logic q);
        always_ff @(posedge clk or negedge rst_n) begin
          if (!rst_n) q <= 1'b0;
          else q <= d;
        end
      endmodule
      """
    When I open the "top" module in SVSCH
    Then I should not see cut net labels named "clk"
    And I should not see cut net labels named "rst_n"

  Scenario Outline: Resetting the layout reapplies both automatic cut heuristics
    Given I have a file "top.sv" in my workspace:
      """
      module top(
        input logic clk,
        input logic rst_n,
        input logic d,
        input logic a,
        output logic q,
        output logic x,
        output logic y
      );
        wire chip_select;
        assign chip_select = a;
        assign x = chip_select;
        assign y = chip_select;
        always_ff @(posedge clk or negedge rst_n) begin
          if (!rst_n) q <= 1'b0;
          else q <= d;
        end
      endmodule
      """
    When I open the "top" module in SVSCH
    And I tie back the cut net "chip_select" <tie trigger>
    And I tie back the cut net "clk" <tie trigger>
    And I tie back the cut net "rst_n" <tie trigger>
    Then I should not see cut net labels named "chip_select"
    And I should not see cut net labels named "clk"
    And I should not see cut net labels named "rst_n"
    When I reset the layout
    Then I should see 3 cut net labels named "chip_select"
    And I should see 2 cut net labels named "clk"
    And I should see 2 cut net labels named "rst_n"

    Examples:
      | tie trigger                  |
      | by clicking its Tie control  |
      | by pressing T                |

  Scenario: An automatically cut fanout net keeps its declared source name
    Given I have a file "top.sv" in my workspace:
      """
      module top(input a, output x, output y);
        wire chip_select;
        assign chip_select = a;
        assign x = chip_select;
        assign y = chip_select;
      endmodule
      """
    When I open the "top" module in SVSCH
    Then I should see 3 cut net labels named "chip_select"
    And the original connection between "a" and "x" should be hidden
    And the original connection between "a" and "y" should be hidden
    # "chip_select" is an explicitly declared wire from the source, not a
    # tool-invented guess, so it renders in regular type and can't be edited
    # into a different name.
    And the cut net "chip_select" should be shown in regular type
    When I double-click the cut net "chip_select"
    Then the cut net "chip_select" should not become editable
    And I should see 3 cut net labels named "chip_select"

  Scenario Outline: Renaming a cut net that has no declared name of its own (implicit wiring)
    Given I have a file "top.sv" in my workspace:
      """
      module top(input a, output x, output y);
        assign x = a;
        assign y = a;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I move the port node "a"
    When I hover the connection between "a" and "x" and <cut trigger>
    Then I should see 3 cut net labels named "a"
    # "a" is only ever the port's own name here — there is no wire declared
    # for this net, so its cut label is a tool-invented guess and stays
    # freely renameable, unlike a net with a real wire declaration. Right
    # after the cut it's still the net's legitimate current name, though, so
    # it renders in regular type — only diverging from it earns italics.
    And the cut net "a" should be shown in regular type
    When I rename the cut net "a" to "chip_select"
    Then I should see 3 cut net labels named "chip_select"
    And the cut net "chip_select" should be shown in italics
    When I click the Revert label control on the cut net "chip_select"
    Then I should see 3 cut net labels named "a"
    And the cut net "a" should be shown in regular type

    Examples:
      | cut trigger           |
      | click its Cut control |
      | press C to cut it     |

  Scenario Outline: Cutting one wire in a multi-wire selection cuts every selected wire
    Given I have a file "top.sv" in my workspace:
      """
      module top(input a, input b, output x, output y);
        assign x = a;
        assign y = b;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I note the position of port node "x"
    And I note the position of port node "y"
    And click and drag the mouse to select "a" and "b" together
    And I hover the connection between "a" and "x" and <cut trigger>
    Then I should see 2 cut net labels named "a"
    And I should see 2 cut net labels named "b"
    And the original connection between "a" and "x" should be hidden
    And the original connection between "b" and "y" should be hidden
    And the port node "a" should not have moved
    And the port node "b" should not have moved
    And the port node "x" should not have moved
    And the port node "y" should not have moved

    Examples:
      | cut trigger           |
      | click its Cut control |
      | press C to cut it     |

  Scenario Outline: Cutting out a single selected block cuts every wire connected to it
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, input logic b, output logic y);
        assign y = a & b;
      endmodule

      module top(input logic a, input logic b, output logic y);
        leaf u1(.a(a), .b(b), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    Then the "Auto Layout" button should not be visible
    When I <cut out trigger>
    Then I should see 2 cut net labels named "a"
    And I should see 2 cut net labels named "b"
    And I should see 2 cut net labels named "u1.y"
    And the original connection between "a" and "u1" should be hidden
    And the original connection between "b" and "u1" should be hidden
    And the original connection between "u1" and "y" should be hidden

    Examples:
      | cut out trigger                        |
      | click the "Cut out" button              |
      | press C to cut out the selected blocks  |

  Scenario Outline: Cutting out one block in a multi-block selection cuts every selected block's wires
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, input logic b, input logic c, output logic x, output logic y, output logic z);
        leaf u1(.a(a), .y(x));
        leaf u2(.a(b), .y(y));
        leaf u3(.a(c), .y(z));
      endmodule
      """
    When I open the "top" module in SVSCH
    And click and drag the mouse to select the blocks "u1" and "u2"
    And I <cut out trigger>
    Then I should see 2 cut net labels named "a"
    And I should see 2 cut net labels named "u1.y"
    And I should see 2 cut net labels named "b"
    And I should see 2 cut net labels named "u2.y"
    And the original connection between "a" and "u1" should be hidden
    And the original connection between "u1" and "x" should be hidden
    And the original connection between "b" and "u2" should be hidden
    And the original connection between "u2" and "y" should be hidden
    And I should not see cut net labels named "c"
    And the original connection between "c" and "u3" should be restored

    Examples:
      | cut out trigger                        |
      | click the "Cut out" button              |
      | press C to cut out the selected blocks  |

  Scenario: Clicking "Cut out" in a mixed block-and-wire selection leaves an unrelated selected wire alone
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, input logic p, input logic b, input logic c, output logic x, output logic q, output logic y, output logic z);
        leaf u1(.a(a), .y(x));
        assign q = p;
        leaf u2(.a(b), .y(y));
        leaf u3(.a(c), .y(z));
      endmodule
      """
    When I open the "top" module in SVSCH
    And click and drag the mouse to select the blocks "u2" and "u3"
    And I add the connection between "p" and "q" to the selection
    Then the connection between "p" and "q" should be shown as selected
    When I click the "Cut out" button
    Then I should see 2 cut net labels named "b"
    And I should see 2 cut net labels named "u2.y"
    And I should see 2 cut net labels named "c"
    And I should see 2 cut net labels named "u3.y"
    And the original connection between "b" and "u2" should be hidden
    And the original connection between "u2" and "y" should be hidden
    And the original connection between "c" and "u3" should be hidden
    And the original connection between "u3" and "z" should be hidden
    But I should not see cut net labels named "p"
    And the original connection between "p" and "q" should be restored

  Scenario: Pressing C in a mixed block-and-wire selection also cuts an unrelated selected wire
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, input logic p, input logic b, input logic c, output logic x, output logic q, output logic y, output logic z);
        leaf u1(.a(a), .y(x));
        assign q = p;
        leaf u2(.a(b), .y(y));
        leaf u3(.a(c), .y(z));
      endmodule
      """
    When I open the "top" module in SVSCH
    And click and drag the mouse to select the blocks "u2" and "u3"
    And I add the connection between "p" and "q" to the selection
    Then the connection between "p" and "q" should be shown as selected
    When I press C to cut out the selected blocks
    Then I should see 2 cut net labels named "b"
    And I should see 2 cut net labels named "u2.y"
    And I should see 2 cut net labels named "c"
    And I should see 2 cut net labels named "u3.y"
    And the original connection between "b" and "u2" should be hidden
    And the original connection between "u2" and "y" should be hidden
    And the original connection between "c" and "u3" should be hidden
    And the original connection between "u3" and "z" should be hidden
    But I should see 2 cut net labels named "p"
    And the original connection between "p" and "q" should be hidden

  Scenario: The Cut out button is hidden for a block that's already fully cut out
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        leaf u1(.a(a), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I click the "Cut out" button
    Then the "Cut out" button should not be visible

  Scenario: Auto-laying out one connection's blocks anchors the result, leaves the other connection untouched, and carries cut net ends along
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
    And I hover the connection between "u1" and "x" and click its Cut control
    And I hover the connection between "b" and "u2" and click its Cut control
    And I move the port node "a"
    And I move the block "u1" by (2, 0) grid cells
    And I note the position of the block "u1"
    # u1's dangling end is not part of the upcoming selection at all — this is
    # the baseline for proving it's left alone.
    And I note the position of the cut net label attached to "u1"
    And I move the port node "b" by (0, 72)
    And I move the block "u2" by (3, 5) grid cells
    # Note u2's dangling end before the upcoming lasso. It sits above the
    # rectangle spanning b/u2/y, so it remains unselected but follows u2 when
    # the selected nodes are laid out.
    And I note the position of the cut net label attached to "u2"
    And I move the port node "y" by (0, 72)
    And click and drag the mouse to select "b", "u2", and "y" together
    Then the cut net label attached to "u2" should not be highlighted
    When I click the "Auto Layout" button
    Then the block "u2" should be re-placed and fixed in the saved layout
    And the block "u2" should stay near its pre-auto-layout position
    And the block "u2" should remain selected
    And the block "u1" should not have moved
    And the port node "a" should still be fixed in the saved layout
    And the cut net label attached to "u2" should have moved
    And the cut net label attached to "u2" should not overlap the block "u1"
    And the cut net label attached to "u1" should not have moved

  Scenario: Rerouting a cut net's dangling end resets it to its canonical position
    Given I have a file "top.sv" in my workspace:
      """
      module top(input logic x, output logic y);
        assign y = x;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I move the port node "y" by (0, 96)
    And I hover the connection between "x" and "y" and click its Cut control
    And I note the position of the cut net label attached to "x"
    And I move the cut net label attached to "x" by (-3, -3) grid cells
    And I hover the cut net label attached to "x"
    And I click the Reroute control on the cut net label attached to "x"
    Then the cut net label attached to "x" should be at its noted position
