Feature: Navigation
  As a hardware designer
  I want to navigate between different modules in my design
  So that I can inspect different parts of the system

  Scenario: Switching between modules via dropdown
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(input i, output o); A a_inst(i, o); endmodule |
      | a.sv   | module A(input i, output o); assign o = i; endmodule |
      | b.sv   | module B(input i, output o); assign o = ~i; endmodule |
    Then the module dropdown should contain "top", "A", "B" in that order
    And I should see an instance node "a_inst" of module "A"
    And I should see a port node "i"
    And I should see a port node "o"
    And I should not see a combinational block
    When I select module "B" from the dropdown
    Then I should see a combinational block
    And there should be a connection between "i" and the combinational block
    When I select module "A" from the dropdown
    Then I should not see a combinational block
    And there should be a connection between "i" and "o"

  Scenario: Navigating to IO port declarations
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(a, b, c);\n  input logic a;\n  output wire [3:0] b;\n  input c;\nendmodule |
    When I double-click on the port node "a"
    Then the editor should highlight the text "input logic a"
    When I double-click on the port node "b"
    Then the editor should highlight the text "output wire [3:0] b"
    When I double-click on the port node "c"
    Then the editor should highlight the text "input c"

  Scenario: Navigating to register blocks
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(input clk, input d, output logic q);\n  always_ff @(posedge clk) begin\n    q <= d;\n  end\nendmodule |
    When I double-click on the register node "q"
    Then the editor should highlight the text "always_ff @(posedge clk) begin\n    q <= d;\n  end"

  Scenario: Navigating to combinational blocks
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(input a, output wire b);\n  assign b = ~a;\nendmodule |
    When I double-click on the combinational block for "b"
    Then the editor should highlight the text "assign b = ~a;"

  Scenario: Navigating to mux blocks
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(input a, input b, input sel, output logic o);\n  always_comb begin\n    case (sel)\n      1'b0: o = a;\n      1'b1: o = b;\n    endcase\n  end\nendmodule |
    When I double-click on the mux block for "o"
    Then the editor should highlight the text "case (sel)\n      1'b0: o = a;\n      1'b1: o = b;\n    endcase"

  Scenario: Navigating to connection source
    Given the following SystemVerilog files:
      | file     | content                             |
      | top.sv   | module top(input a, output wire b);\n  wire w;\n  Child c1(.i(a), .o(w));\n  Child c2(.i(w), .o(b));\nendmodule |
      | child.sv | module Child(input i, output o); endmodule |
    When I double-click on the connection between the port node "a" and the instance node "c1"
    Then the editor should highlight the text "input a"
    When I double-click on the connection between the instance node "c1" and the instance node "c2"
    Then a warning notification should be shown with "This is an internal wire."

  Scenario: Navigating into module instances
    Given the following SystemVerilog files:
      | file   | content |
      | top.sv | module top(input i, output o);\n  Sub sub_inst(i, o);\nendmodule |
      | sub.sv | module Sub(input i, output o);\n  assign o = i;\nendmodule |
    When I double-click on the instance node "sub_inst"
    Then the diagram should display the module "Sub"
    And the module dropdown should have "Sub" selected
