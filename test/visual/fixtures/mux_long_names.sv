module mux_long_names(
  input logic select_between_pipeline_values,
  input logic somewhat_long_input_name_a,
  input logic another_long_input_name_b,
  input logic fallback_path_with_extra_words,
  output logic output_value_with_long_name
);
  always_comb begin
    case (select_between_pipeline_values)
      2'd0: output_value_with_long_name = somewhat_long_input_name_a;
      2'd1: output_value_with_long_name = another_long_input_name_b;
      default: output_value_with_long_name = fallback_path_with_extra_words;
    endcase
  end
endmodule
