Feature: Navigation
  As a hardware designer
  I want to navigate between different modules in my design
  So that I can inspect different parts of the system

  Scenario: Switching between modules via dropdown
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input i, output o); A a_inst(i, o); endmodule |
      | a.sv   | module A(input i, output o); assign o = i; endmodule |
      | b.sv   | module B(input i, output o); assign o = ~i; endmodule |
    When I open the "top" module in SVSCH
    Then the module dropdown should contain "top", "A", "B" in that order
    And I should see an instance node "a_inst" of module "A"
    And I should see a port node "i"
    And I should see a port node "o"
    And I should not see a combinational block
    When I select module "B" from the dropdown
    Then I should see an inverter node
    And there should be a connection between "i" and the inverter node
    When I select module "A" from the dropdown
    Then I should not see an inverter node
    And there should be a connection between "i" and "o"

  Scenario: Navigating to a different module closes the partial diagram panel
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module leaf(input logic a, output logic y); assign y = a; endmodule\nmodule top(input logic a, output logic y); logic mid; leaf u1(.a(a), .y(mid)); leaf u2(.a(mid), .y(y)); endmodule |
      | b.sv   | module B(input logic i, output logic o); assign o = ~i; endmodule |
    When I open the "top" module in SVSCH
    And I click to select the block "u1"
    And I add the selected block to the partial diagram
    Then the SVSCH partial diagram panel opens
    When I switch to the main diagram panel
    And I select module "B" from the dropdown
    Then the SVSCH partial diagram panel is closed

  Scenario: Restricting compiled sources to a Surelog filelist skips files not listed
    Given I have the following files in my workspace:
      | file      | content |
      | top.sv    | module top(input i, output o); A a_inst(i, o); endmodule |
      | a.sv      | module A(input i, output o); assign o = i; endmodule |
      | unused.sv | module Unused(); endmodule |
    And I have a file "project.f" in my workspace:
      """
      top.sv
      a.sv
      """
    And svsch.fileList is set to "project.f"
    When I open the "top" module in SVSCH
    Then the module dropdown should contain "top", "A" in that order
    And the module dropdown should not contain "Unused"

  Scenario: When both svsch.fileList and svsch.projectFolder are set, the filelist takes priority
    Given I have the following files in my workspace:
      | file           | content |
      | listed/top.sv  | module top(input i, output o); A a_inst(i, o); endmodule |
      | listed/a.sv    | module A(input i, output o); assign o = i; endmodule |
      | other/rogue.sv | module Rogue(); endmodule |
    And I have a file "listed/project.f" in my workspace:
      """
      top.sv
      a.sv
      """
    And svsch.fileList is set to "listed/project.f"
    When I open the "top" module in SVSCH
    And svsch.projectFolder is set to "other"
    And I reload the diagram
    Then the module dropdown should contain "top", "A" in that order
    And the module dropdown should not contain "Rogue"

  Scenario: Navigating to IO port declarations
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(a, b, c);\n  input logic a;\n  output wire [3:0] b;\n  input c;\nendmodule |
    When I open the "top" module in SVSCH
    And I note the diagram zoom level
    And I double-click on the port node "a"
    Then the editor pane for "top.sv" is opened and focused
    Then the editor should highlight the text "input logic a"
    And the diagram zoom level should be unchanged

    When I go back to the SVSCH diagram pane
    And I double-click on the port node "b"
    Then the existing editor pane for "top.sv" is focused
    And the editor should highlight the text "output wire [3:0] b"

    When I go back to the SVSCH diagram pane
    And I double-click on the port node "c"
    Then the editor should highlight the text "input c"

  Scenario: Navigating to register blocks
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input clk, input d, output logic q);\n  always_ff @(posedge clk) begin\n    q <= d;\n  end\nendmodule |
    When I open the "top" module in SVSCH
    And I double-click on the register node "q"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "always_ff @(posedge clk) begin\n    q <= d;\n  end"

  Scenario: Navigating to combinational blocks
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input a, input c, output wire b);\n  assign b = a * c;\nendmodule |
    When I open the "top" module in SVSCH
    And I double-click on the combinational block for "b"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "assign b = a * c;"

  Scenario: Navigating to gate blocks
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input a, input c, output wire b);\n  assign b = a & c;\nendmodule |
    When I open the "top" module in SVSCH
    And I double-click on the gate block for "b"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "a & c"

  Scenario: Navigating to inverter nodes
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input a, output wire b);\n  assign b = ~a;\nendmodule |
    When I open the "top" module in SVSCH
    And I double-click on the inverter node for "b"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "assign b = ~a;"

  Scenario: Navigating to mux blocks
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input a, input b, input sel, output logic o);\n  always_comb begin\n    case (sel)\n      1'b0: o = a;\n      1'b1: o = b;\n      default: o = 1'b0;\n    endcase\n  end\nendmodule |
    When I open the "top" module in SVSCH
    And I double-click on the mux block for "o"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "case (sel)\n      1'b0: o = a;\n      1'b1: o = b;\n      default: o = 1'b0;\n    endcase"

  Scenario: Navigating to connection source
    Given I have the following files in my workspace:
      | file     | content                             |
      | top.sv   | module top(input a, output wire b);\n  wire w;\n  Child c1(.i(a), .o(w));\n  Child c2(.i(w), .o(b));\nendmodule |
      | child.sv | module Child(input i, output o); endmodule |
    When I open the "top" module in SVSCH
    And I double-click on the connection between the port node "a" and the instance node "c1"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "input a"

    When I go back to the SVSCH diagram pane
    And I double-click on the connection between the instance node "c1" and the instance node "c2"
    Then a warning notification should be shown with "This is an internal wire."

  Scenario: Navigating into module instances
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | module top(input i, output o);\n  Sub sub_inst(i, o);\nendmodule |
      | sub.sv | module Sub(input i, output o);\n  assign o = i;\nendmodule |
    When I open the "top" module in SVSCH
    And I double-click on the instance node "sub_inst"
    Then the diagram should display the module "Sub"
    And the module dropdown should have "Sub" selected

  Scenario: Navigating to type definitions
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | typedef enum logic [1:0] { IDLE, READY } state_t;\nmodule top(input state_t in_state, output state_t out_state);\n  state_t current_state;\n  always_ff @(posedge clk) current_state <= in_state;\n  assign out_state = current_state;\nendmodule |
    When I open the "top" module in SVSCH
    And I click on the type label "state_t" for the port node "in_state"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "typedef enum logic [1:0] { IDLE, READY } state_t;"

    When I go back to the SVSCH diagram pane
    When I click on the type label "state_t" for the register node "current_state"
    Then the editor should highlight the text "typedef enum logic [1:0] { IDLE, READY } state_t;"

  Scenario: Navigating to interface and modport definitions
    Given I have the following files in my workspace:
      | file   | content |
      | top.sv | interface simple_if(input logic clk);\n  logic [7:0] data;\n  logic valid;\n  logic ready;\n  modport master(input clk, output data, output valid, input ready);\n  modport slave(input clk, input data, input valid, output ready);\nendinterface\n\nmodule consumer(simple_if.slave bus, output logic observed);\n  assign bus.ready = bus.valid;\n  assign observed = bus.data[0];\nendmodule\n\nmodule top(input logic clk, output logic observed);\n  simple_if link(clk);\n  consumer u_consumer(.bus(link), .observed(observed));\nendmodule |
    When I open the "top" module in SVSCH
    And I select module "consumer" from the dropdown
    And I click on the type label "simple_if" for the interface node "bus"
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "interface simple_if(input logic clk);"

    When I go back to the SVSCH diagram pane
    When I click on the modport label "slave" for the interface node "bus"
    Then the existing editor pane for "top.sv" is focused
    And the editor should highlight the text "modport slave(input clk, input data, input valid, output ready);"

    When I go back to the SVSCH diagram pane
    And I double-click the interface member tap "valid" on interface node "bus"
    Then the existing editor pane for "top.sv" is focused
    And the editor should highlight the text "logic valid;"

    When I go back to the SVSCH diagram pane
    And I double-click on the interface node "bus"
    Then the diagram should display the module "interface simple_if"

    When I go back to the SVSCH diagram pane
    And I click on the modport header "master"
    Then the existing editor pane for "top.sv" is focused
    And the editor should highlight the text "modport master(input clk, output data, output valid, input ready);"

  Scenario: Navigating to generate if arms and their generate block
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
        logic w;

        generate
          if (MODE == 0) begin : g_zero
            leaf u_zero(.a(a), .y(w));
          end else begin : g_other
            leaf u_other(.a(b), .y(w));
          end
        endgenerate

        assign y = w;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I note the diagram zoom level
    And I double-click on the "g_zero" generate region
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "if (MODE == 0) begin : g_zero\n      leaf u_zero(.a(a), .y(w));\n    end"
    And the diagram zoom level should be unchanged

    When I go back to the SVSCH diagram pane
    And I double-click on the "g_other" generate region
    Then the existing editor pane for "top.sv" is focused
    And the editor should highlight the text "else begin : g_other\n      leaf u_other(.a(b), .y(w));\n    end"

    When I go back to the SVSCH diagram pane
    And I double-click on the "generate if" generate region
    Then the editor should highlight the text "if (MODE == 0) begin : g_zero\n      leaf u_zero(.a(a), .y(w));\n    end else begin : g_other\n      leaf u_other(.a(b), .y(w));\n    end"
    And the diagram zoom level should be unchanged

    When I go back to the SVSCH diagram pane
    And I double-click on an empty area of the canvas
    Then the diagram zoom level should have increased

  Scenario: Navigating to generate case arms and their generate block
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
        logic w;

        generate
          case (MODE)
            0: begin : g_case_zero
              leaf u_case_zero(.a(a), .y(w));
            end
            default: begin : g_case_def
              leaf u_case_def(.a(b), .y(w));
            end
          endcase
        endgenerate

        assign y = w;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I double-click on the "g_case_zero" generate region
    Then the editor pane for "top.sv" is opened and focused
    And the editor should highlight the text "0: begin : g_case_zero\n        leaf u_case_zero(.a(a), .y(w));\n      end"

    When I go back to the SVSCH diagram pane
    And I double-click on the "g_case_def" generate region
    Then the existing editor pane for "top.sv" is focused
    And the editor should highlight the text "default: begin : g_case_def\n        leaf u_case_def(.a(b), .y(w));\n      end"

    When I go back to the SVSCH diagram pane
    And I double-click on the "generate case (MODE)" generate region
    Then the editor should highlight the text "case (MODE)\n      0: begin : g_case_zero\n        leaf u_case_zero(.a(a), .y(w));\n      end\n      default: begin : g_case_def\n        leaf u_case_def(.a(b), .y(w));\n      end\n    endcase"

  Scenario: Exporting the diagram as SVG
    Given I have a file "top.sv" in my workspace:
      """
      module top(input a, output y);
        assign y = a;
      endmodule
      """
    When I open the "top" module in SVSCH
    And I click the Export SVG button
    Then I see the file save dialog with "<workspace folder>/top.svg" as the filename

    When I click "OK"
    Then a file named "top.svg" should exist in the workspace

  # Regression: the extension's Export SVG built its view straight from
  # buildViewModel, without applyExpandedInstances — an expanded instance
  # exported as its flat collapsed box with nothing inside, even though the
  # canvas (and `svsch render`, issue #248) showed the spliced sub-diagram.
  Scenario: Exporting a diagram with an expanded instance includes the spliced sub-diagram
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

    When I click the Export SVG button
    And I click "OK"
    Then a file named "top.svg" should exist in the workspace
    # The dimmed instance backdrop, its boundary ports, and the child module's
    # internal content must all be in the exported markup.
    And the workspace file "top.svg" should contain "hdl-node-expand-ghost"
    And the workspace file "top.svg" should contain "boundaryPort"
    And the workspace file "top.svg" should contain "expand:instance:top:u1:"
