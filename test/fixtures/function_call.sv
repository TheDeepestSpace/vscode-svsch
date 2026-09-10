module function_call (
    input  logic [7:0] a,
    input  logic [7:0] b,
    output logic [7:0] y
);
    function automatic [7:0] foo(
        input [7:0] lhs,
        input [7:0] rhs
    );
        foo = lhs + rhs;
    endfunction

    assign y = foo(a, b);
endmodule
