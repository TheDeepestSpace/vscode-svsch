module task_call (
    input  logic [7:0] a,
    input  logic [7:0] b,
    output logic [7:0] y
);
    task automatic add_values(
        input  logic [7:0] lhs,
        input  logic [7:0] rhs,
        output logic [7:0] result
    );
        result = lhs + rhs;
    endtask

    always_comb begin
        add_values(a, b, y);
    end
endmodule
