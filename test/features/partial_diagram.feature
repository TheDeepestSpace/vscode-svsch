Feature: Partial diagram
  As a hardware design engineer
  I want to be able to observe and traverse a subset of the diagram nodes
  So that I can more easily comprehend complex hierarchies by looking at their controlled, reduced subset

  Scenario: Add to Partial opens a partial diagram with the node's wires cut
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    Then the "Add to Partial" button should be visible
    When I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    Then I should see an instance node "u1" of module "leaf"
    And I should see 1 cut net labels named "a"
    And I should see 1 cut net labels named "mid"
    And I should not see an instance node "u2"

  Scenario: Extending a cut net pulls in the far node and keeps existing nodes in place
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    Then the extend arrow should be visible on the cut net "mid"
    When I note the position of the block "u1"
    And I click the extend arrow on the cut net "mid"
    Then I should see an instance node "u2" of module "leaf"
    And there should be a connection between "u1" and "u2"
    And I should not see cut net labels named "mid"
    And the block "u1" should not have moved

  Scenario: A second Add to Partial reuses the already-open pane
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the main diagram panel
    And I click to select the block "u2"
    And I add the selected block to the partial diagram
    Then there should be exactly one partial diagram panel
    When I switch to the partial diagram panel
    Then I should see an instance node "u1" of module "leaf"
    And I should see an instance node "u2" of module "leaf"
    And I should see 2 cut net labels named "mid"
    And there should not be a connection between "u1" and "u2"

  Scenario: Selecting multiple blocks and clicking Add to Partial adds them all at once
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the block "u2" to the selection
    Then the "Add to Partial" button should be visible
    When I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    Then I should see an instance node "u1" of module "leaf"
    And I should see an instance node "u2" of module "leaf"
    And I should see 1 cut net labels named "a"
    And I should see 2 cut net labels named "mid"
    And I should see 1 cut net labels named "u2.y"
    And there should not be a connection between "u1" and "u2"

  Scenario: Closing the partial panel discards its state
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    And I click the extend arrow on the cut net "mid"
    Then I should see an instance node "u2" of module "leaf"
    When I close the partial diagram panel
    And I click to select the block "u2"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    Then I should see an instance node "u2" of module "leaf"
    And I should not see an instance node "u1"
    And I should see 1 cut net labels named "mid"

  Scenario: Extending a fanout wire in the partial diagram reveals every node it feeds
    Given I have a file "top.sv" in my workspace:
      """
      module top(
        input logic sel_a,
        input logic sel_b,
        input logic dflt,
        output logic out_a,
        output logic out_b
      );
        always_comb begin
          case (sel_a)
            1'b1: out_a = 1'b1;
            default: out_a = dflt;
          endcase
        end
        always_comb begin
          case (sel_b)
            1'b1: out_b = 1'b1;
            default: out_b = dflt;
          endcase
        end
      endmodule
      """
    When I open the "top" module in SVSCH
    Then I should see a mux node "case sel_a"
    And I should see a mux node "case sel_b"
    And there should be a connection between "dflt" and the mux node "case sel_a"
    And there should be a connection between "dflt" and the mux node "case sel_b"
    When I click to select the block "case sel_a"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    Then I should see a mux node "case sel_a"
    And I should not see a mux node "case sel_b"
    And I should see 1 cut net labels named "dflt"
    When I click the extend arrow on the cut net "dflt"
    Then I should see a port node "dflt"
    And there should be a connection between "dflt" and the mux node "case sel_a"
    # A net is either fully cut or fully tied — there's no partially-cut-net
    # mechanic — so extending "dflt" brings in every node it fanouts to in one
    # step, not just the branch that was clicked.
    And I should see a mux node "case sel_b"
    And there should be a connection between "dflt" and the mux node "case sel_b"
    # The muxes' own other nets (selects, outputs, literal feeds) stay cut:
    # extending one net never silently pulls in the rest of the module.
    And I should not see cut net labels named "dflt"

  Scenario: Rebuilding a whole FSM inside the partial by extending every wire, then auto-laying it out
    Given I have a file "top.sv" in my workspace:
      """
      module top(input clk, input rst_n, input logic next_state_en, output logic [1:0] state);
        typedef enum logic [1:0] {IDLE=0, START=1, BUSY=2, DONE=3} state_t;
        state_t r, next_r;
        always_ff @(posedge clk or negedge rst_n) if(!rst_n) r <= IDLE; else r <= next_r;
        always_comb begin
          if (next_state_en) begin
            case (r)
              IDLE:    next_r = START;
              START:   next_r = BUSY;
              BUSY:    next_r = DONE;
              DONE:    next_r = IDLE;
              default: next_r = IDLE;
            endcase
          end
        end
        assign state = r;
      endmodule
      """
    When I open the "top" module in SVSCH
    Then I should see a register node "r"
    And I should see a mux node "case r"
    And I should see a mux node "if next_state_en"
    And I should see a latch node "next_r"
    And I should see a literal node "IDLE"
    When I click to select the block "r"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    And I extend every cut net in the partial diagram
    Then I should not see any cut net labels in the partial diagram
    And I should see a register node "r"
    And I should see a mux node "case r"
    And I should see a mux node "if next_state_en"
    And I should see a latch node "next_r"
    And I should see a literal node "IDLE"
    And I should see a literal node "START"
    And I should see a literal node "BUSY"
    And I should see a literal node "DONE"
    And there should be a connection between "r" and the mux node "case r"
    And there should be a connection between "case r" and the mux node "if next_state_en"
    And there should be a connection between the mux node "if next_state_en" and the latch node "next_r"
    When I click "Auto Layout All" in the partial diagram toolbar
    Then I should not see any cut net labels in the partial diagram
    And I should see a register node "r"
    And I should see a mux node "case r"
    And I should see a mux node "if next_state_en"
    And I should see a latch node "next_r"
    And there should be a connection between "r" and the mux node "case r"
    And there should be a connection between the mux node "if next_state_en" and the latch node "next_r"

  Scenario: Exporting the partial diagram as SVG
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    Then I should see an instance node "u1" of module "leaf"

    When I click the Export SVG button
    Then I see the file save dialog with "<workspace folder>/top_partial.svg" as the filename

    When I click "OK"
    Then a file named "top_partial.svg" should exist in the workspace
    # The included instance and its cut ends (unlike the main diagram, a
    # partial's every unresolved edge is a cut, not just some) both need to
    # make it into the exported markup.
    And the workspace file "top_partial.svg" should contain "leaf"
    And the workspace file "top_partial.svg" should contain "hdl-net-label"
    And the workspace file "top_partial.svg" should match the exported SVG snapshot

  Scenario Outline: Removing a block drops its own cut ends and cuts nets it was tied to
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a, output logic y);
        logic mid;
        leaf u1(.a(a), .y(mid));
        leaf u2(.a(mid), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the partial diagram panel
    And I click the extend arrow on the cut net "mid"
    Then I should see an instance node "u2" of module "leaf"
    And there should be a connection between "u1" and "u2"
    And I should see 1 cut net labels named "u2.y"
    When I click to select the block "u2"
    Then the "Remove" button should be visible
    When I <remove trigger>
    Then I should not see an instance node "u2"
    And I should see an instance node "u1" of module "leaf"
    # The "mid" net was a real, tied wire between u1 and u2 — removing u2
    # naturally cuts it again on u1's remaining side.
    And I should see 1 cut net labels named "mid"
    And I should see 1 cut net labels named "a"
    # u2's own "u2.y" cut end (never expanded) is gone along with u2 itself.
    And I should not see cut net labels named "u2.y"

    Examples:
      | remove trigger                               |
      | click the Remove button                      |
      | press Backspace to remove the selected block |
      | press Delete to remove the selected block    |
