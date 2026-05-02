module if_comb(
    input logic sel,
    input logic a,
    input logic b,
    output logic y
);
    always_comb begin
        if (sel) y = a;
        else y = b;
    end
endmodule

module if_else_chain(
    input logic a_sel,
    input logic b_sel,
    input logic a,
    input logic b,
    input logic c,
    output logic y
);
    always_comb begin
        if (a_sel) y = a;
        else if (b_sel) y = b;
        else y = c;
    end
endmodule

module if_nested_true(
    input logic outer,
    input logic inner,
    input logic a,
    input logic b,
    input logic c,
    output logic y
);
    always_comb begin
        if (outer) begin
            if (inner) y = a;
            else y = b;
        end else begin
            y = c;
        end
    end
endmodule

module if_nested_false(
    input logic outer,
    input logic inner,
    input logic a,
    input logic b,
    input logic c,
    output logic y
);
    always_comb begin
        if (outer) begin
            y = a;
        end else begin
            if (inner) y = b;
            else y = c;
        end
    end
endmodule

module if_complex_condition(
    input logic sel,
    input logic valid,
    input logic force_i,
    input logic a,
    input logic b,
    output logic y
);
    always_comb begin
        if ((sel & valid) || force_i) y = a;
        else y = b;
    end
endmodule

module if_clock_enable(
    input logic clk,
    input logic en,
    input logic d,
    output logic q
);
    always_ff @(posedge clk) begin
        if (en) q <= d;
    end
endmodule

module if_two_registers(
    input logic clk,
    input logic sel,
    input logic x,
    input logic y,
    output logic a,
    output logic b
);
    always_ff @(posedge clk) begin
        if (sel) a <= x;
        else b <= y;
    end
endmodule

module if_inferred_latch(
    input logic sel,
    input logic a,
    output logic y
);
    always_comb begin
        if (sel) y = a;
    end
endmodule
