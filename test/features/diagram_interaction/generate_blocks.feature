Feature: Diagram Interaction
  As a hardware designer
  I want to interact with the block diagram
  So that I can customize the layout to my preference

  Scenario: Resizing an if/else generate arm clamps to inner content padding
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        input logic b,
        input logic c,
        output logic y
      );
        logic w;

        generate
          if (MODE == 0) begin : g_if_zero
            leaf u_if_zero(.a(a), .y(w));
          end else if (MODE == 1) begin : g_if_one
            leaf u_if_one(.a(b), .y(w));
          end else begin : g_if_other
            assign w = c;
          end
        endgenerate

        assign y = w;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I resize the "g_if_one" generate region on the right side by 3 grid cells
    Then the "g_if_one" generate region should have grown on the right side
    When I resize the "g_if_one" generate region on the right side by -30 grid cells
    Then the "g_if_one" generate region should keep 2 grid cells of padding on the right side

  Scenario: Moving the block within an arm expands its boundary appropriately
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        input logic b,
        output logic y
      );
        generate
          if (MODE == 1) begin : g_if_one
            leaf u_if_one(.a(a), .y(y));
          end else begin : g_if_other
            leaf u_other(.a(b), .y(y));
          end
        endgenerate
      endmodule
      """
    When I open the "top" module in SVSCH
    And I begin moving the block "g_if_one.u_if_one" in the "g_if_one" generate region by (8, 0) grid cells
    Then the "g_if_one" generate region should have expanded on the right side while dragging
    When I release the moving block
    Then the "g_if_one" generate region should keep 2 grid cells of padding on the right side

  Scenario: Moving a generate arm moves all blocks inside it
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        input logic b,
        input logic c,
        input logic sel,
        output logic y
      );
        generate
          if (MODE == 1) begin : g_if_one
            logic left_tap;
            logic right_tap;

            leaf u_path_a(.a(a), .y(left_tap));
            leaf u_path_b(.a(b), .y(right_tap));
            assign y = sel ? left_tap : right_tap;
          end else begin : g_if_other
            leaf u_other(.a(c), .y(y));
          end
        endgenerate
      endmodule
      """
    When I open the "top" module in SVSCH
    Then the "g_if_one" generate region should contain at least 3 blocks
    And there should be a connection between "g_if_one.u_path_a" and the mux block in the "g_if_one" generate region
    And there should be a connection between "g_if_one.u_path_b" and the mux block in the "g_if_one" generate region
    And there should be a connection between "sel" and the mux block in the "g_if_one" generate region
    And there should be a connection between the mux block in the "g_if_one" generate region and "y"
    And I note the route from "g_if_one.u_path_a" to the mux block in the "g_if_one" generate region
    When I move the "g_if_one" generate region by (2, -1) grid cells
    Then all blocks in the "g_if_one" generate region should have moved by (2, -1) grid cells
    And blocks outside the "g_if_one" generate region should not have moved
    And the route from "g_if_one.u_path_a" to the mux block in the "g_if_one" generate region should have shifted by (2, -1) grid cells

  Scenario: Moving a generate block moves every arm and block inside it
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        input logic b,
        input logic c,
        input logic sel,
        output logic y
      );
        generate
          if (MODE == 1) begin : g_if_one
            logic left_tap;
            logic right_tap;

            leaf u_path_a(.a(a), .y(left_tap));
            leaf u_path_b(.a(b), .y(right_tap));
            assign y = sel ? left_tap : right_tap;
          end else begin : g_if_other
            leaf u_other(.a(c), .y(y));
          end
        endgenerate
      endmodule
      """
    When I open the "top" module in SVSCH
    Then the diagram should contain a "generate if" generate block
    When I move the "generate if" generate region by (2, -1) grid cells
    Then all blocks in the "generate if" generate region should have moved by (2, -1) grid cells

  Scenario: Warning when generate arm blocks overlap
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        input logic b,
        input logic c,
        output logic y
      );
        logic w;

        generate
          if (MODE == 0) begin : g_if_zero
            leaf u_if_zero(.a(a), .y(w));
          end else if (MODE == 1) begin : g_if_one
            leaf u_if_one(.a(b), .y(w));
          end else begin : g_if_other
            assign w = c;
          end
        endgenerate

        assign y = w;
      endmodule
      """
    When I open the "top" module in SVSCH
    Then the diagram should contain exactly 3 generate regions
    And no generate region should be flagged as overlapping
    When I move the "g_if_one" generate region by (0, -3) grid cells
    Then the "g_if_zero" generate region should be flagged as overlapping
    And the "g_if_one" generate region should be flagged as overlapping
    And I should see a warning icon on the "g_if_zero" generate region
    And I should see a warning icon on the "g_if_one" generate region
    When I hover over the warning icon on the "g_if_one" generate region
    Then a tooltip should appear reading "arm blocks overlapping"
    When I move the "g_if_one" generate region by (0, 3) grid cells
    Then no generate region should be flagged as overlapping
    And I should not see any generate region warning icons

  Scenario: Warning when two generate blocks overlap
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        output logic z
      );
        logic w1;

        generate
          if (MODE == 1) begin : g_if_on
            leaf u_if(.a(a), .y(w1));
          end
        endgenerate

        // implicit generate: the generate/endgenerate keywords are optional
        case (MODE)
          default: begin : g_case_def
            leaf u_case_def(.a(w1), .y(z));
          end
        endcase
      endmodule
      """
    When I open the "top" module in SVSCH
    Then the diagram should contain a "generate if" generate block
    And the diagram should contain a "generate case (MODE)" generate block
    And no generate region should be flagged as overlapping
    When I move the "generate if" generate region by (-8, 0) grid cells
    Then the "generate if" generate region should be flagged as overlapping
    And the "generate case (MODE)" generate region should be flagged as overlapping
    And I should see a warning icon on the "generate if" generate region
    And I should see a warning icon on the "generate case (MODE)" generate region
    When I hover over the warning icon on the "generate if" generate region
    Then a tooltip should appear reading "generate blocks overlapping"
    When I move the "generate if" generate region by (8, 0) grid cells
    Then no generate region should be flagged as overlapping
    And I should not see any generate region warning icons

  Scenario: Warning when a block overlaps an unrelated generate arm
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top #(parameter MODE = 1) (
        input logic a,
        input logic b,
        output logic y,
        output logic z
      );
        logic w;

        leaf u_free(.a(a), .y(z));

        generate
          if (MODE == 1) begin : g_arm
            leaf u_arm(.a(b), .y(w));
          end
        endgenerate

        assign y = w;
      endmodule
      """
    When I open the "top" module in SVSCH
    Then no generate region should be flagged as overlapping
    And no block should be flagged as overlapping an arm
    When I move the "g_arm" generate region by (0, -3) grid cells
    Then the "g_arm" generate region should be flagged as containing an unrelated block
    And the "u_free" block should be flagged as overlapping an arm
    But the "g_arm.u_arm" block should not be flagged as overlapping an arm
    And I should see a warning icon on the "g_arm" generate region
    And I should see a warning icon on the "u_free" block
    When I hover over the warning icon on the "g_arm" generate region
    Then a tooltip should appear reading "node does not belong to arm block"
    When I hover over the warning icon on the "u_free" block
    Then a tooltip should appear reading "this block does not belong to a generate arm block"
    And the "generate if" generate block should be flagged as containing an unrelated block
    When I hover over the warning icon on the "generate if" generate region
    Then a tooltip should appear reading "block does not belong to this generate block"
