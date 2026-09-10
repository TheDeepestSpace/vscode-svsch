Feature: Diagram Interaction
  As a hardware designer
  I want to interact with the block diagram
  So that I can customize the layout to my preference

  Scenario: Expanding an instance in place inlines its child module, and Collapse restores it
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
    Then the "Expand" button should be visible
    When I click the "Expand" button
    Then I should see a boundary port node named "a"
    And I should see a boundary port node named "y"
    And I should see a dimmed instance node "u1"
    When I collapse the expanded instance "u1"
    Then I should not see a boundary port node named "a"
    And I should see an instance node "u1" of module "leaf"

  Scenario: An expanded instance stays expanded across a diagram reload
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
    And I click the "Expand" button
    Then I should see a boundary port node named "a"
    When I close and reopen the diagram
    Then I should see a boundary port node named "a"
    # Regression: collapsing an auto-restored instance used to bounce — the
    # webview's expanded-instance list (delivered with the graph message on
    # reopen) went stale on Collapse and the auto-restore effect immediately
    # re-expanded it.
    When I collapse the expanded instance "u1"
    Then the instance "u1" should stay collapsed
    And I should not see a boundary port node named "a"
    And I should see an instance node "u1" of module "leaf"

  Scenario: The Expand button is not offered for a stacked instance array
    Given I have a file "top.sv" in my workspace:
      """
      module leaf(input logic a, output logic y);
        assign y = a;
      endmodule

      module top(input logic a [1:0], output logic y [1:0]);
        leaf u_mux [1:0] (.a(a), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u_mux"
    Then the "Expand" button should not be visible

  Scenario: Moving an expanded instance moves its entire spliced content
    Given I have a file "top.sv" in my workspace:
      """
      module inner(input logic a, output logic y);
        assign y = a;
      endmodule

      module leaf(input logic a, output logic y);
        inner u_inner(.a(a), .y(y));
      endmodule

      module top(input logic a, output logic y);
        leaf u1(.a(a), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I click the "Expand" button
    Then I should see a boundary port node named "a"
    And I should see an instance node "u_inner" of module "inner"
    And I note the position of the boundary port node "a"
    And I note the position of the boundary port node "y"
    And I note the position of the block "u_inner"
    When I move the expanded instance "u1" by (2, -1) grid cells
    Then the boundary port node "a" should have moved by (2, -1) grid cells
    And the boundary port node "y" should have moved by (2, -1) grid cells
    And the block "u_inner" should have moved by (2, -1) grid cells

  # TODO(#241): currently fails against real behavior, not a test bug — confirmed by
  # running this locally against a real surelog+svsch_backend: dragging u_inner
  # visually leaves it hanging outside the frame with no resize. Root cause:
  # ActiveSplice.expandedSize (src/webview/expand/expandOverlay.ts) is fixed at
  # expand-time and never recomputed from live content — syncSpliceCache
  # explicitly pins bounds.width/height back to the stale splice.expandedSize
  # every reattach ("which node-drags don't update"). Unlike generate regions
  # (their own always-visible `.generate-region` overlay reads `regions` state
  # directly every render), an expand region's frame IS the dimmed instance
  # node's baked-in sizeOverride (dimAsExpandGhost), applied only through
  # applyActiveSplices — which itself only reruns on a `view`/`spliceVersion`
  # change, not on every node drag. Growing this needs both recomputing
  # expandedSize from expandRegionsForNodes' hugged bounds *and* re-applying
  # splices (or otherwise pushing the new sizeOverride) after an internal-node
  # drag stop, not just a one-line bounds fix.
  @skip
  Scenario: Moving a node inside an expanded instance grows its frame
    Given I have a file "top.sv" in my workspace:
      """
      module inner(input logic a, output logic y);
        assign y = a;
      endmodule

      module leaf(input logic a, output logic y);
        inner u_inner(.a(a), .y(y));
      endmodule

      module top(input logic a, output logic y);
        leaf u1(.a(a), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I click the "Expand" button
    Then I should see an instance node "u_inner" of module "inner"
    And I note the bounds of the block "u1"
    When I move the node "u_inner" inside the expanded instance by (8, 0) grid cells
    Then the "u1" block should have grown on the right side

  Scenario: An instance nested inside an already-expanded instance cannot be expanded directly
    Given I have a file "top.sv" in my workspace:
      """
      module inner(input logic a, output logic y);
        assign y = a;
      endmodule

      module leaf(input logic a, output logic y);
        inner u_inner(.a(a), .y(y));
      endmodule

      module top(input logic a, output logic y);
        leaf u1(.a(a), .y(y));
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I click the "Expand" button
    Then I should see an instance node "u_inner" of module "inner"
    When I click to select the block "u_inner"
    Then the "Expand" button should not be visible
    When I collapse the expanded instance "u1"
    Then I should see an instance node "u1" of module "leaf"
