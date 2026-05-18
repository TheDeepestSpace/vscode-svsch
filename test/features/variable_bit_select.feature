Feature: Variable Bit Select
  As a hardware engineer
  I want to see variable bit selects as specialized blocks
  So that I can understand how dynamic indexing is used in my design

  Scenario: Viewing a variable bit select
    Given a SystemVerilog file "var_bit_select.sv" with:
      """
      module top(
          input logic [31:0] bus,
          input logic [4:0] sel,
          output logic bit_out
      );
          assign bit_out = bus[sel];
      endmodule
      """
    When I open the diagram for module "top"
    Then I should see a "select" block for "bus[sel]"
    And the "select" block should have an input "sel" on the top
    And the "select" block should have an input "in" from "bus"
    And the "select" block should have an output "out" to "bit_out"
