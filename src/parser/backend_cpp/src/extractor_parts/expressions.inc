std::string DesignExtractor::ensureLiteralNode(vpiHandle handle, Module& mod, const std::string& output_signal, const std::string& width, vpiHandle source_handle, const std::string& label_override) {
    std::string label = label_override.empty() ? getLiteralLabel(handle) : label_override;
    std::string signal = output_signal.empty() ? label : output_signal;
    
    if (label.empty() || signal.empty()) return "";

    for (auto& n : mod.nodes) {
        if (n.kind != "literal") continue;
        if (n.label == label) {
            bool port_exists = false;
            for (const auto& p : n.ports) {
                if (p.direction == "output" && p.signal == signal) {
                    port_exists = true; break;
                }
            }
            if (!port_exists) {
                n.ports.push_back({signal, "output", signal, width});
            }
            return signal;
        }
    }

    Node n;
    n.id = sanitizeId("literal:" + mod.name + ":" + signal + ":" + label);
    n.kind = "literal";
    n.label = label;
    n.source = getSourceInfo(source_handle ? source_handle : handle);
    n.ports.push_back({signal, "output", signal, width});
    mod.nodes.push_back(n);
    return signal;
}

bool DesignExtractor::isAluOperation(vpiHandle expr) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation) return false;
    int op = vpi_get(vpiOpType, expr);
    return op == vpiAddOp || op == vpiSubOp;
}

std::string DesignExtractor::aluOperationSymbol(vpiHandle expr) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation) return "";
    int op = vpi_get(vpiOpType, expr);
    if (op == vpiAddOp) return "+";
    if (op == vpiSubOp) return "-";
    return "";
}

bool DesignExtractor::isReplicationOperation(vpiHandle expr) {
    return expr && vpi_get(vpiType, expr) == vpiOperation && vpi_get(vpiOpType, expr) == 34; // vpiMultiConcatOp
}

bool DesignExtractor::isConcatOperation(vpiHandle expr) {
    return expr && vpi_get(vpiType, expr) == vpiOperation && vpi_get(vpiOpType, expr) == 33; // vpiConcatOp
}

std::vector<vpiHandle> DesignExtractor::concatOperands(vpiHandle expr) {
    std::vector<vpiHandle> operands;
    if (!isConcatOperation(expr)) return operands;

    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    return operands;
}

void DesignExtractor::collectAggregateTargetNames(vpiHandle lhs, std::set<std::string>& targets) {
    if (!lhs) return;
    if (isConcatOperation(lhs)) {
        for (vpiHandle operand : concatOperands(lhs)) collectAggregateTargetNames(operand, targets);
        return;
    }

    std::string target = getSignalName(lhs);
    if (!target.empty()) targets.insert(target);
    std::string base = getBaseSignalName(lhs);
    if (!base.empty() && base != target) targets.insert(base);
}

std::vector<AggregateSegment> DesignExtractor::flattenAggregateSegments(
    vpiHandle expr,
    Module& mod,
    bool is_lhs,
    bool is_procedural,
    const std::string& preferred_prefix,
    const std::map<std::string, LoweredValue>& current_drivers,
    int max_depth
) {
    std::vector<AggregateSegment> segments;
    if (!expr || max_depth <= 0) return segments;

    if (is_lhs && isConcatOperation(expr)) {
        int index = 0;
        for (vpiHandle operand : concatOperands(expr)) {
            auto child = flattenAggregateSegments(operand, mod, is_lhs, is_procedural, preferred_prefix + "_lhs" + std::to_string(index), current_drivers, max_depth - 1);
            segments.insert(segments.end(), child.begin(), child.end());
            index++;
        }
        return segments;
    }

    if (!is_lhs && isConcatOperation(expr)) {
        int index = 0;
        for (vpiHandle operand : concatOperands(expr)) {
            AggregateSegment seg;
            seg.handle = operand;
            seg.signal = getOrPromoteExpr(operand, mod, preferred_prefix + "_agg_in" + std::to_string(index), is_procedural, current_drivers);
            seg.width = getWidth(operand);
            std::string declared_width = getDeclaredSignalWidth(mod, seg.signal);
            if (bitSizeFromWidth(declared_width) > bitSizeFromWidth(seg.width)) seg.width = declared_width;
            if (seg.width.empty()) {
                int inferred = expressionBitSize(operand);
                seg.width = inferred > 1 ? "[" + std::to_string(inferred - 1) + ":0]" : "[0:0]";
            }
            seg.size = std::max(1, bitSizeFromWidth(seg.width));
            segments.push_back(seg);
            index++;
        }
        return segments;
    }

    AggregateSegment seg;
    seg.handle = expr;
    seg.signal = is_lhs ? getSignalName(expr) : getOrPromoteExpr(expr, mod, preferred_prefix, is_procedural, current_drivers);
    seg.width = getWidth(expr);
    if (!is_lhs) {
        std::string declared_width = getDeclaredSignalWidth(mod, seg.signal);
        if (bitSizeFromWidth(declared_width) > bitSizeFromWidth(seg.width)) seg.width = declared_width;
    }

    if (auto field = getStructFieldRef(expr, mod)) {
        seg.baseSignal = field->first;
        seg.structField = field->second;
        seg.width = fieldWidth(mod.structSignals[field->first].type, field->second);
    }

    if (is_lhs) {
        std::string base = getBaseSignalName(expr);
        if (!base.empty() && base != seg.signal && seg.signal.find('[') != std::string::npos) {
            seg.baseSignal = base;
        }
        if (seg.width.empty()) {
            std::string declared_width = getDeclaredSignalWidth(mod, seg.signal);
            if (!declared_width.empty()) seg.width = declared_width;
        }
    }

    if (seg.width.empty()) {
        int inferred = expressionBitSize(expr);
        seg.width = inferred > 1 ? "[" + std::to_string(inferred - 1) + ":0]" : "[0:0]";
    }
    seg.size = std::max(1, bitSizeFromWidth(seg.width));
    segments.push_back(seg);
    return segments;
}

std::map<std::string, LoweredValue> DesignExtractor::lowerAggregateAssignment(
    vpiHandle assign_handle,
    Module& mod,
    bool is_procedural,
    const std::map<std::string, LoweredValue>& current_drivers,
    const std::string& output_suffix
) {
    std::map<std::string, LoweredValue> result = current_drivers;
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (!lhs || !rhs || !isConcatOperation(lhs)) return result;

    std::string tag = "aggregate_assign:" + std::to_string(getLine(assign_handle)) + ":" + std::to_string(getCol(assign_handle)) + ":" + nextId();
    std::string aggregate_signal = sanitize("aggregate_assign_" + tag.substr(tag.rfind(':') + 1));

    auto lhs_segments = flattenAggregateSegments(lhs, mod, true, is_procedural, tag, current_drivers);
    auto rhs_segments = flattenAggregateSegments(rhs, mod, false, is_procedural, tag, current_drivers);
    if (lhs_segments.empty() || rhs_segments.empty()) return result;

    int lhs_size = 0;
    for (auto& seg : lhs_segments) lhs_size += std::max(1, seg.size);
    int rhs_size = 0;
    for (auto& seg : rhs_segments) rhs_size += std::max(1, seg.size);
    int aggregate_size = std::max(lhs_size, rhs_size);
    std::string aggregate_width = aggregate_size > 1 ? "[" + std::to_string(aggregate_size - 1) + ":0]" : "[0:0]";

    Node compose;
    compose.id = sanitizeId("bus:" + mod.name + ":" + tag + ":compose");
    compose.kind = "bus";
    compose.label = "compose";
    compose.source = getSourceInfo(assign_handle);
    compose.metadata.expression = "[aggregate-compose]";
    compose.metadata.isProcedural = is_procedural;
    if (rhs_size < lhs_size) compose.metadata.reason = "rhs padded to lhs width";
    compose.ports.push_back({"out", "output", aggregate_signal, aggregate_width, "out"});

    if (rhs_size < lhs_size) {
        int pad_size = lhs_size - rhs_size;
        std::string pad_width = pad_size > 1 ? "[" + std::to_string(pad_size - 1) + ":0]" : "[0:0]";
        ensureLiteralNode(rhs, mod, "1'b0", pad_width, assign_handle, "1'b0");
        compose.ports.push_back({"rhs_pad", "input", "1'b0", pad_width, "[" + std::to_string(aggregate_size - 1) + ":" + std::to_string(rhs_size) + "]"});
    }

    int current_bit = rhs_size >= lhs_size ? rhs_size - 1 : rhs_size - 1;
    for (size_t i = 0; i < rhs_segments.size(); ++i) {
        const auto& seg = rhs_segments[i];
        int size = std::max(1, seg.size);
        std::string label = size > 1
            ? "[" + std::to_string(current_bit) + ":" + std::to_string(current_bit - size + 1) + "]"
            : "[" + std::to_string(current_bit) + "]";
        compose.ports.push_back({"rhs" + std::to_string(i), "input", seg.signal, seg.width, label});
        current_bit -= size;
    }
    mod.nodes.push_back(compose);

    Node breakout;
    breakout.id = sanitizeId("bus:" + mod.name + ":" + tag + ":breakout");
    breakout.kind = "bus";
    breakout.label = "breakout";
    breakout.source = getSourceInfo(assign_handle);
    breakout.metadata.expression = "[aggregate-breakout]";
    breakout.metadata.isProcedural = is_procedural;
    breakout.ports.push_back({"in", "input", aggregate_signal, aggregate_width, "in"});

    current_bit = lhs_size - 1;
    for (size_t i = 0; i < lhs_segments.size(); ++i) {
        auto seg = lhs_segments[i];
        if (seg.signal.empty()) continue;
        std::string target_signal = seg.signal;
        if (is_procedural && !output_suffix.empty()) seg.signal += output_suffix;
        int size = std::max(1, seg.size);
        std::string label = size > 1
            ? "[" + std::to_string(current_bit) + ":" + std::to_string(current_bit - size + 1) + "]"
            : "[" + std::to_string(current_bit) + "]";
        breakout.ports.push_back({"lhs" + std::to_string(i), "output", seg.signal, seg.width, label});

        if (output_suffix.empty() && !seg.structField.empty()) {
            ensureStructFieldCompositionInput(mod, seg.baseSignal, seg.structField, seg.signal, getSourceInfo(seg.handle));
        } else if (output_suffix.empty() && seg.signal.find('[') != std::string::npos) {
            std::string base = seg.baseSignal.empty() ? getBaseSignalName(seg.handle) : seg.baseSignal;
            if (!base.empty()) {
                size_t bracket = seg.signal.find('[');
                ensureBusSliceCompositionInput(mod, base, seg.signal.substr(bracket), seg.signal, getSourceInfo(seg.handle));
            }
        }

        result[target_signal] = {true, seg.signal, seg.width};
        current_bit -= size;
    }
    mod.nodes.push_back(breakout);
    return result;
}

int DesignExtractor::getConstantInt(vpiHandle handle) {
    if (!handle) return 0;
    vpiHandle actual = unwrapRef(handle);
    if (!actual) actual = handle;

    s_vpi_value value;
    value.format = vpiIntVal;
    vpi_get_value(actual, &value);
    if (value.format != vpiSuppressVal) {
        return value.value.integer;
    }

    std::string text = getSignalName(handle);
    try {
        return std::stoi(text);
    } catch (...) {
        return 0;
    }
}

int DesignExtractor::bitSizeFromWidth(const std::string& width) {
    if (width.empty()) return 0;
    std::smatch match;
    if (std::regex_search(width, match, std::regex(R"(\[(-?\d+)(?::(-?\d+))?\])"))) {
        int left = std::stoi(match[1].str());
        int right = match[2].matched ? std::stoi(match[2].str()) : left;
        return std::abs(left - right) + 1;
    }
    return 0;
}

int DesignExtractor::expressionBitSize(vpiHandle handle) {
    if (!handle) return 0;
    int size = vpi_get(vpiSize, handle);
    if (size > 0 && size < 1000000) return size;
    int width_size = bitSizeFromWidth(getWidth(handle));
    return width_size > 0 ? width_size : 1;
}

std::string DesignExtractor::promoteConcatExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation || vpi_get(vpiOpType, expr) != 33) return "";

    std::vector<vpiHandle> operands;
    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    if (operands.empty()) return "";

    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string node_id = sanitizeId("bus:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":concat");
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    int total_size = 0;
    std::vector<std::string> signals;
    std::vector<std::string> widths;
    for (size_t i = 0; i < operands.size(); ++i) {
        vpiHandle operand = operands[i];
        std::string signal;
        if (isLiteralExpr(operand)) {
            std::string literal_label = getLiteralLabel(operand);
            signal = literal_label;
            ensureLiteralNode(operand, mod, signal, getWidth(operand), expr, literal_label);
        } else {
            signal = getOrPromoteExpr(operand, mod, out_signal + "_concat_in" + std::to_string(i), is_procedural, current_drivers);
        }

        std::string width = getWidth(operand);
        std::string declared_width = getDeclaredSignalWidth(mod, signal);
        if (bitSizeFromWidth(declared_width) > bitSizeFromWidth(width)) width = declared_width;
        int inferred_size = expressionBitSize(operand);
        if (inferred_size > bitSizeFromWidth(width)) {
            width = inferred_size > 1 ? "[" + std::to_string(inferred_size - 1) + ":0]" : "[0:0]";
        }
        if (width.empty()) {
            if (inferred_size > 1) width = "[" + std::to_string(inferred_size - 1) + ":0]";
        }

        signals.push_back(signal);
        widths.push_back(width);
        int width_size = bitSizeFromWidth(width);
        total_size += width_size > 0 ? width_size : expressionBitSize(operand);
    }

    std::string width = getWidth(expr);
    if (total_size > bitSizeFromWidth(width)) {
        width = total_size > 1 ? "[" + std::to_string(total_size - 1) + ":0]" : "[0:0]";
    }

    Node n;
    n.id = node_id;
    n.kind = "bus";
    n.label = out_signal;
    n.source = getSourceInfo(expr);
    refineSourceInfo(n.source, expr);
    if (n.source.col > 0) n.source.col--;
    n.source.endCol++;
    n.metadata.expression = getExprText(expr);
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);
    n.ports.push_back({out_signal, "output", out_signal, width, out_signal});

    int current_bit = std::max(0, total_size - 1);
    for (size_t i = 0; i < operands.size(); ++i) {
        int size = bitSizeFromWidth(widths[i]);
        if (size <= 0) size = expressionBitSize(operands[i]);
        std::string port_name = size > 1
            ? "[" + std::to_string(current_bit) + ":" + std::to_string(current_bit - size + 1) + "]"
            : "[" + std::to_string(current_bit) + "]";
        n.ports.push_back({port_name, "input", signals[i], widths[i], port_name});
        current_bit -= size;
    }

    mod.nodes.push_back(n);
    return out_signal;
}

std::string DesignExtractor::promoteReplicationExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!isReplicationOperation(expr)) return "";

    std::vector<vpiHandle> operands;
    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    if (operands.size() < 2) return "";

    vpiHandle repeat_handle = operands[0];
    int repeat_count = getConstantInt(repeat_handle);
    std::string repeat_expr = getExprText(repeat_handle);
    if (repeat_expr.empty() || repeat_expr == "[operation]") repeat_expr = getSignalName(repeat_handle);
    bool symbolic_count = std::regex_match(repeat_expr, std::regex(R"([A-Za-z_$][\w$]*)"));
    std::string repeat_label = symbolic_count
        ? "x " + repeat_expr
        : "x" + (repeat_count > 0 ? std::to_string(repeat_count) : repeat_expr);
    std::string id_label = symbolic_count
        ? repeat_expr
        : (repeat_count > 0 ? std::to_string(repeat_count) : repeat_expr);

    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string node_id = sanitizeId("replicate:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":x" + id_label);
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    std::vector<std::string> body_signals;
    std::vector<std::string> body_widths;
    int body_size = 0;
    for (size_t i = 1; i < operands.size(); ++i) {
        vpiHandle body = operands[i];
        std::vector<vpiHandle> concat_operands;
        if (body && vpi_get(vpiType, body) == vpiOperation && vpi_get(vpiOpType, body) == 33) { // vpiConcatOp
            vpiHandle body_itr = vpi_iterate(vpiOperand, body);
            if (body_itr) {
                while (vpiHandle body_operand = vpi_scan(body_itr)) {
                    concat_operands.push_back(body_operand);
                }
                vpi_release_handle(body_itr);
            }
            if (concat_operands.size() == 1) {
                body = concat_operands[0];
            }
        }

        std::string signal;
        std::string body_width;
        if (concat_operands.size() > 1) {
            signal = promoteConcatExpr(body, mod, out_signal + "_rep_concat" + std::to_string(i - 1), is_procedural, current_drivers);
            body_width = getDeclaredSignalWidth(mod, signal);
            if (body_width.empty()) body_width = getWidth(body);
        } else {
            if (isLiteralExpr(body)) {
                std::string literal_label = getLiteralLabel(body);
                signal = literal_label;
                ensureLiteralNode(body, mod, signal, getWidth(body), expr, literal_label);
            } else {
                signal = getOrPromoteExpr(body, mod, out_signal + "_rep_in" + std::to_string(i - 1), is_procedural, current_drivers);
            }
            body_width = getWidth(body);
            std::string declared_width = getDeclaredSignalWidth(mod, signal);
            if (bitSizeFromWidth(declared_width) > bitSizeFromWidth(body_width)) {
                body_width = declared_width;
            }
        }
        if (body_width.empty()) {
            int inferred_size = expressionBitSize(body);
            if (inferred_size > 1) body_width = "[" + std::to_string(inferred_size - 1) + ":0]";
        }
        body_signals.push_back(signal);
        body_widths.push_back(body_width);
        int body_width_size = bitSizeFromWidth(body_width);
        body_size += body_width_size > 0 ? body_width_size : expressionBitSize(body);
    }
    int total_size = body_size * std::max(1, repeat_count);
    std::string width = getWidth(expr);
    if (total_size > bitSizeFromWidth(width)) {
        width = total_size > 1 ? "[" + std::to_string(total_size - 1) + ":0]" : "[0:0]";
    }
    std::string declared_output_width = getDeclaredSignalWidth(mod, out_signal);
    if (bitSizeFromWidth(declared_output_width) > bitSizeFromWidth(width)) {
        width = declared_output_width;
    }

    Node n;
    n.id = node_id;
    n.kind = "replicate";
    n.label = repeat_label;
    n.source = getSourceInfo(expr);
    refineSourceInfo(n.source, expr);
    if (n.source.col > 0) n.source.col--;
    n.source.endCol++;
    n.metadata.expression = getExprText(expr);
    n.metadata.repeatCount = repeat_count;
    n.metadata.repeatExpression = repeat_expr;
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(repeat_handle, mod);

    for (size_t i = 0; i < body_signals.size(); ++i) {
        std::string port_name = body_signals.size() == 1 ? "in" : "in" + std::to_string(i);
        n.ports.push_back({port_name, "input", body_signals[i], body_widths[i], port_name});
    }

    std::string display_label = out_signal;
    if (display_label.size() >= 5 && display_label.compare(display_label.size() - 5, 5, "_next") == 0) {
        display_label = display_label.substr(0, display_label.size() - 5);
    }
    n.ports.push_back({out_signal, "output", out_signal, width, display_label});
    mod.nodes.push_back(n);
    return out_signal;
}

std::string DesignExtractor::promoteAluExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!expr || !isAluOperation(expr)) return "";

    std::vector<vpiHandle> operands;
    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    if (operands.size() < 2) {
        return "";
    }

    // Only promote simple binary ALU operations.
    // If either operand is another ALU operation, fallback to a single COMB node for the whole chain.
    if (isAluOperation(operands[0]) || isAluOperation(operands[1])) {
        return "";
    }

    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string node_id = "alu:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":expr";
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    std::string lhs_signal = getOrPromoteExpr(operands[0], mod, out_signal + "_lhs", is_procedural, current_drivers);
    std::string rhs_signal = getOrPromoteExpr(operands[1], mod, out_signal + "_rhs", is_procedural, current_drivers);

    std::string expr_str = getExprText(expr);
    std::string width = getWidth(expr);

    Node n;
    n.id = node_id;
    n.kind = "alu";
    n.label = "";
    n.source = getSourceInfo(expr);
    refineSourceInfo(n.source, expr);
    n.metadata.expression = expr_str;
    n.metadata.operation = aluOperationSymbol(expr);
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);
    n.ports.push_back({"lhs", "input", lhs_signal, getWidth(operands[0]), "lhs"});
    n.ports.push_back({"rhs", "input", rhs_signal, getWidth(operands[1]), "rhs"});

    std::string display_label = out_signal;
    if (display_label.size() >= 5 && display_label.compare(display_label.size() - 5, 5, "_next") == 0) {
        display_label = display_label.substr(0, display_label.size() - 5);
    }
    n.ports.push_back({out_signal, "output", out_signal, width, display_label});
    mod.nodes.push_back(n);
    return out_signal;
}

std::string DesignExtractor::getOrPromoteExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!expr) return "";
    int type = vpi_get(vpiType, expr);

    if (auto field = getStructFieldRef(expr, mod)) {
        return ensureStructBreakout(mod, field->first, field->second, getSourceInfo(expr));
    }

    if (isReplicationOperation(expr)) {
        std::string replicated_signal = promoteReplicationExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!replicated_signal.empty()) return replicated_signal;
    }

    // Simple types that don't need promotion
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == 608 || isLiteralExpr(expr)) {
        return getSignalName(expr, current_drivers);
    }

    if (type == vpiBitSelect || type == vpiPartSelect || type == 606 || type == 607 || type == 130) {
        return processBusSelect(expr, mod);
    }

    if (isAluOperation(expr)) {
        std::string alu_signal = promoteAluExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!alu_signal.empty()) return alu_signal;
    }

    // It's a complex expression, promote it to a comb node
    std::string expr_str = getExprText(expr);

    std::string out_signal = preferred_name;
    if (out_signal.empty()) {
        out_signal = nextId();
    }

    std::string node_id = "comb:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":expr";
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    int op = (type == 39) ? vpi_get(vpiOpType, expr) : 0;
    std::string width = getWidth(expr);

    Node n;
    n.id = node_id;
    n.kind = "comb";
    
    bool is_concat = (type == 39 && (op == 33 || op == 34));

    // Interpret concatenations as bus compositions
    if (type == 39) { // vpiOperation
        if (op == 33 || op == 34) { // vpiConcatOp, vpiMultiConcatOp
            n.kind = "bus";
            // Replace comb: prefix with bus: if present
            if (n.id.rfind("comb:", 0) == 0) {
                n.id = "bus" + n.id.substr(4);
            }

            // Identify if this is a struct composition
            if (!out_signal.empty()) {
                std::string base = out_signal;
                if (base.size() >= 5 && base.compare(base.size() - 5, 5, "_next") == 0) {
                    base = base.substr(0, base.size() - 5);
                }
                n.label = base; // Set label for all bus compositions

                if (mod.structSignals.count(base)) {
                    n.kind = "struct";
                    n.metadata.role = "composition";
                }
            }

            // If width was not detected, try to sum operands
            if (width.empty() || width == "[0:0]") {
                int total_size = 0;
                vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
                if (op_itr) {
                    while (vpiHandle o = vpi_scan(op_itr)) {
                        int s = expressionBitSize(o);
                        total_size += s;
                    }
                }
                if (total_size > 1) {
                    width = "[" + std::to_string(total_size - 1) + ":0]";
                } else if (total_size == 1) {
                    width = "[0:0]";
                }
            }
        }
    }

    SourceInfo s = getSourceInfo(expr);
    refineSourceInfo(s, expr);

    // Adjust for the enclosing braces '{' and '}' in concatenations
    if (is_concat) {
        if (s.col > 0) s.col--; 
        s.endCol++;
    }

    n.source = s;
    n.metadata.expression = expr_str;
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);

    // Use a display label for the output port that trims _next to ensure consistent sizing
    std::string display_label = out_signal;
    if (display_label.size() >= 5 && display_label.compare(display_label.size() - 5, 5, "_next") == 0) {
        display_label = display_label.substr(0, display_label.size() - 5);
    }
    n.ports.push_back({out_signal, "output", out_signal, width, display_label});

    std::vector<vpiHandle> input_handles;
    collectIdentifierHandlesRecursive(expr, input_handles);

    vpiHandle op_itr = is_concat ? vpi_iterate(vpiOperand, expr) : nullptr;
    if (is_concat && op_itr) {
        struct ConcatInput {
            vpiHandle handle;
            std::string signal;
            std::string width;
            int size;
        };
        std::vector<ConcatInput> concat_inputs;
        int total_size = 0;
        int scan_idx = 0;
        while (vpiHandle in = vpi_scan(op_itr)) {
            std::string sig = getOrPromoteExpr(
                in,
                mod,
                out_signal + "_concat_in" + std::to_string(scan_idx),
                is_procedural,
                current_drivers
            );
            std::string input_width = getWidth(in);
            std::string declared_width = getDeclaredSignalWidth(mod, sig);
            if (bitSizeFromWidth(declared_width) > bitSizeFromWidth(input_width)) {
                input_width = declared_width;
            }
            if (input_width.empty() || input_width == "[0:0]") {
                for (const auto& existing_node : mod.nodes) {
                    for (const auto& existing_port : existing_node.ports) {
                        if (existing_port.direction == "output" && existing_port.signal == sig && bitSizeFromWidth(existing_port.width) > bitSizeFromWidth(input_width)) {
                            input_width = existing_port.width;
                        }
                    }
                }
            }
            int input_size = bitSizeFromWidth(input_width);
            if (input_size <= 0) {
                input_size = expressionBitSize(in);
                if (input_size > 1) input_width = "[" + std::to_string(input_size - 1) + ":0]";
            }
            if (input_size <= 0) input_size = 1;
            concat_inputs.push_back({in, sig, input_width, input_size});
            total_size += input_size;
            scan_idx++;
        }
        vpi_release_handle(op_itr);
        if (total_size > bitSizeFromWidth(n.ports[0].width)) {
            n.ports[0].width = total_size > 1 ? "[" + std::to_string(total_size - 1) + ":0]" : "[0:0]";
        }
        int current_bit = total_size - 1;

        // Try to get struct information for the output signal
        std::optional<StructType> struct_type;
        if (!out_signal.empty()) {
            if (mod.structSignals.count(out_signal)) {
                struct_type = mod.structSignals[out_signal].type;
            } else {
                std::string base = out_signal;
                if (base.size() >= 5 && base.compare(base.size() - 5, 5, "_next") == 0) {
                    base = base.substr(0, base.size() - 5);
                }
                if (mod.structSignals.count(base)) {
                    struct_type = mod.structSignals[base].type;
                }
            }
        }

        int field_idx = 0;
        for (const auto& input : concat_inputs) {
            std::string port_name;
            if (struct_type && field_idx < struct_type->fields.size()) {
                port_name = struct_type->fields[field_idx].name;
                field_idx++;
            } else {
                if (input.size > 1) {
                    port_name = "[" + std::to_string(current_bit) + ":" + std::to_string(current_bit - input.size + 1) + "]";
                } else {
                    port_name = "[" + std::to_string(current_bit) + "]";
                }
            }
            
            n.ports.push_back({port_name, "input", input.signal, input.width, port_name});
            current_bit -= input.size;
        }
    } else {
    for (auto h : input_handles) {
        std::string full = getSignalName(h);
        std::string base = getBaseSignalName(h);
        std::string actual_signal = full;
        
        if (current_drivers.count(full)) {
            actual_signal = current_drivers.at(full).signal;
        } else if (current_drivers.count(base)) {
            actual_signal = current_drivers.at(base).signal;
        } else {
            // Suffix matching hierarchy resolver
            for (const auto& [drv_name, drv_val] : current_drivers) {
                if ((full.size() > drv_name.size() && full.substr(full.size() - drv_name.size()) == drv_name && full[full.size() - drv_name.size() - 1] == '.') ||
                    (base.size() > drv_name.size() && base.substr(base.size() - drv_name.size()) == drv_name && base[base.size() - drv_name.size() - 1] == '.')) {
                    actual_signal = drv_val.signal; break;
                }
            }
        }

        // Avoid duplicate ports
        bool exists = false;
        for (const auto& p : n.ports) if (p.signal == actual_signal) { exists = true; break; }
        if (!exists) {
            std::string label = "";
            size_t bracket = full.find('[');
            if (bracket != std::string::npos) label = full.substr(bracket);
            n.ports.push_back({full, "input", actual_signal, getWidth(h), label});
        }
    }
    }
    mod.nodes.push_back(n);
    return out_signal;
}
