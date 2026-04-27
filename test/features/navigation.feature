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
