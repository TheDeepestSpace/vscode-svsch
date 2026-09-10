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

    // Enrich source location and metadata based on the actual UHDM object type.
    vpiHandle actual = unwrapRef(handle);
    int actual_type = actual ? vpi_get(vpiType, actual) : 0;

    if (actual_type == vpiEnumConst) {
        // For enum members use the declaration source (inside the typedef).
        SourceInfo decl_src = getSourceInfo(actual);
        n.source = (!decl_src.file.empty() && decl_src.line > 0)
            ? decl_src
            : getSourceInfo(source_handle ? source_handle : handle);
        // Attach enum type info from the pre-built module enum map.
        auto it = mod.enumMemberTypes.find(label);
        if (it != mod.enumMemberTypes.end()) {
            n.metadata.typeName = it->second.typeName;
            n.metadata.typeSource = it->second.typeSource;
        }
    } else if (actual_type == vpiParameter || (actual && vpi_get(vpiLocalParam, actual))) {
        // For parameters use the declaration location, not the usage site.
        n.source = getParameterDeclarationSource(actual ? actual : handle);
    } else {
        n.source = getSourceInfo(source_handle ? source_handle : handle);
    }

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
            // A literal RHS segment (e.g. the `1'b0` in `{data_reg, 1'b0}`) resolves to
            // its text as a signal name, but no node actually drives that signal unless
            // one is synthesized here — leaving the bus-composition port dangling.
            if (isLiteralExpr(operand)) {
                ensureLiteralNode(operand, mod, seg.signal, seg.width, operand, seg.signal);
            }
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

LoweredAggregate DesignExtractor::lowerAggregateValue(
    vpiHandle assign_handle,
    Module& mod,
    bool is_procedural,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    LoweredAggregate aggregate;
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (!lhs || !rhs || !isConcatOperation(lhs)) return aggregate;

    std::string tag = "aggregate_assign:" + std::to_string(getLine(assign_handle)) + ":" + std::to_string(getCol(assign_handle)) + ":" + nextId();
    std::string aggregate_signal = sanitize("aggregate_assign_" + tag.substr(tag.rfind(':') + 1));

    auto lhs_segments = flattenAggregateSegments(lhs, mod, true, is_procedural, tag, current_drivers);
    auto rhs_segments = flattenAggregateSegments(rhs, mod, false, is_procedural, tag, current_drivers);
    if (lhs_segments.empty() || rhs_segments.empty()) return aggregate;

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

    aggregate.assigned = true;
    aggregate.value = {true, aggregate_signal, aggregate_width};
    aggregate.tag = tag;
    aggregate.source = getSourceInfo(assign_handle);
    aggregate.lhsSegments = std::move(lhs_segments);
    aggregate.lhsSize = lhs_size;
    return aggregate;
}

std::map<std::string, LoweredValue> DesignExtractor::lowerAggregateBreakout(
    const LoweredAggregate& aggregate,
    Module& mod,
    bool is_procedural,
    const std::map<std::string, LoweredValue>& current_drivers,
    const std::string& output_suffix,
    const std::map<std::string, std::string>& desired_outputs
) {
    std::map<std::string, LoweredValue> result = current_drivers;
    if (!aggregate.assigned || !aggregate.value.assigned || aggregate.lhsSegments.empty()) return result;

    Node breakout;
    breakout.id = sanitizeId("bus:" + mod.name + ":" + aggregate.tag + ":breakout");
    breakout.kind = "bus";
    breakout.label = "breakout";
    breakout.source = aggregate.source;
    breakout.metadata.expression = "[aggregate-breakout]";
    breakout.metadata.isProcedural = is_procedural;
    breakout.ports.push_back({"in", "input", aggregate.value.signal, aggregate.value.width, "in"});

    int current_bit = aggregate.lhsSize - 1;
    for (size_t i = 0; i < aggregate.lhsSegments.size(); ++i) {
        auto seg = aggregate.lhsSegments[i];
        if (seg.signal.empty()) continue;
        std::string target_signal = seg.signal;
        auto desired_output = desired_outputs.find(target_signal);
        bool renamed = false;
        if (is_procedural && desired_output != desired_outputs.end()) {
            seg.signal = desired_output->second;
            renamed = true;
        } else if (is_procedural && !output_suffix.empty()) {
            seg.signal += output_suffix;
            renamed = true;
        }
        int size = std::max(1, seg.size);
        std::string label = size > 1
            ? "[" + std::to_string(current_bit) + ":" + std::to_string(current_bit - size + 1) + "]"
            : "[" + std::to_string(current_bit) + "]";
        breakout.ports.push_back({"lhs" + std::to_string(i), "output", seg.signal, seg.width, label});

        // Only wire the bus/struct composition input when seg.signal is still the real
        // target signal name. A rename (branch/"_next" suffix, or a desired_outputs
        // remap) means this breakout produces an intermediate driver value, not the
        // final signal — composing that into the merge node would bypass whatever
        // produces the actual signal (e.g. a register) and starve it of its real input.
        if (!renamed && !seg.structField.empty()) {
            ensureStructFieldCompositionInput(mod, seg.baseSignal, seg.structField, seg.signal, getSourceInfo(seg.handle));
        } else if (!renamed && seg.signal.find('[') != std::string::npos) {
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

std::map<std::string, LoweredValue> DesignExtractor::lowerAggregateAssignment(
    vpiHandle assign_handle,
    Module& mod,
    bool is_procedural,
    const std::map<std::string, LoweredValue>& current_drivers,
    const std::string& output_suffix,
    const std::map<std::string, std::string>& desired_outputs
) {
    auto aggregate = lowerAggregateValue(assign_handle, mod, is_procedural, current_drivers);
    return lowerAggregateBreakout(
        aggregate, mod, is_procedural, current_drivers, output_suffix, desired_outputs);
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

    // UHDM doesn't always fold a parameterized repeat-count expression (e.g.
    // "DATA_WIDTH-4") to a constant when the replication is nested inside a
    // procedural concatenation operand. Resolve it ourselves from already-known
    // parameter values now (width math only — repeat_label/id_label above keep
    // showing the symbolic expression), rather than leaving it to the later
    // repairAggregateReplicationWidths pass: callers such as lowerCaseStatement
    // read this node's output width immediately (to decide whether a zext is
    // needed) and would otherwise see a stale 1-bit width and insert a spurious
    // zext that a later width repair can't retract.
    int width_repeat_count = repeat_count;
    if (width_repeat_count <= 0 && !repeat_expr.empty()) {
        if (auto resolved = evalReplicationCountExpr(repeat_expr, generateParameterValues(mod))) {
            if (*resolved > 0) width_repeat_count = *resolved;
        }
    }

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
    int total_size = body_size * std::max(1, width_repeat_count);
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
    if (symbolic_count) {
        // Look up the declaration source from mod.parameters (which has declaration-site info).
        for (const auto& param : mod.parameters) {
            if (param.name == repeat_expr && !param.source.file.empty() && param.source.line > 0) {
                n.metadata.repeatExpressionSource = param.source;
                break;
            }
        }
        // Fallback to VPI if not found in module params (e.g., package-level parameter).
        if (n.metadata.repeatExpressionSource.file.empty()) {
            n.metadata.repeatExpressionSource = getParameterDeclarationSource(repeat_handle);
        }
    }
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
    propagateStruct(mod, preferred_name, out_signal);
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

    std::string lhs_signal;
    if (isLiteralExpr(operands[0])) {
        lhs_signal = getLiteralLabel(operands[0]);
        ensureLiteralNode(operands[0], mod, lhs_signal, getWidth(operands[0]), expr, lhs_signal);
    } else {
        lhs_signal = getOrPromoteExpr(operands[0], mod, out_signal + "_lhs", is_procedural, current_drivers);
    }

    std::string rhs_signal;
    if (isLiteralExpr(operands[1])) {
        rhs_signal = getLiteralLabel(operands[1]);
        ensureLiteralNode(operands[1], mod, rhs_signal, getWidth(operands[1]), expr, rhs_signal);
    } else {
        rhs_signal = getOrPromoteExpr(operands[1], mod, out_signal + "_rhs", is_procedural, current_drivers);
    }

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
    propagateStruct(mod, preferred_name, out_signal);
    return out_signal;
}

bool DesignExtractor::isComparatorOperation(vpiHandle expr) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation) return false;
    switch (vpi_get(vpiOpType, expr)) {
        case vpiLtOp:
        case vpiLeOp:
        case vpiGtOp:
        case vpiGeOp:
        case vpiEqOp:
        case vpiNeqOp:
        case vpiCaseEqOp:
        case vpiCaseNeqOp:
            return true;
        default:
            return false;
    }
}

std::string DesignExtractor::comparatorOperationSymbol(vpiHandle expr) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation) return "";
    switch (vpi_get(vpiOpType, expr)) {
        case vpiLtOp: return "<";
        case vpiLeOp: return "<=";
        case vpiGtOp: return ">";
        case vpiGeOp: return ">=";
        case vpiEqOp: return "==";
        case vpiNeqOp: return "!=";
        case vpiCaseEqOp: return "===";
        case vpiCaseNeqOp: return "!==";
        default: return "";
    }
}

std::string DesignExtractor::promoteComparatorExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!expr || !isComparatorOperation(expr)) return "";

    std::vector<vpiHandle> operands;
    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    if (operands.size() != 2) {
        return "";
    }

    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string node_id = "comparator:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":expr";
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    bool lhs_is_literal = isLiteralExpr(operands[0]);
    std::string lhs_signal = lhs_is_literal
        ? getLiteralLabel(operands[0])
        : getOrPromoteExpr(operands[0], mod, out_signal + "_lhs", is_procedural, current_drivers);

    bool rhs_is_literal = isLiteralExpr(operands[1]);
    std::string rhs_signal = rhs_is_literal
        ? getLiteralLabel(operands[1])
        : getOrPromoteExpr(operands[1], mod, out_signal + "_rhs", is_procedural, current_drivers);

    // An unsized literal (e.g. '0, '1) has no self-determined width, so when
    // it's compared against an operand with a known width, adopt that width
    // instead of leaving it empty (which would render the connecting wire as
    // 1-bit thin regardless of the comparator's actual operand width).
    std::string lhs_width = getDeclaredSignalWidth(mod, lhs_signal);
    if (lhs_width.empty()) lhs_width = getWidth(operands[0]);
    std::string rhs_width = getDeclaredSignalWidth(mod, rhs_signal);
    if (rhs_width.empty()) rhs_width = getWidth(operands[1]);
    if (lhs_width.empty() && lhs_is_literal && !rhs_width.empty()) {
        lhs_width = rhs_width;
    }
    if (rhs_width.empty() && rhs_is_literal && !lhs_width.empty()) {
        rhs_width = lhs_width;
    }

    if (lhs_is_literal) {
        ensureLiteralNode(operands[0], mod, lhs_signal, lhs_width, expr, lhs_signal);
    }
    if (rhs_is_literal) {
        ensureLiteralNode(operands[1], mod, rhs_signal, rhs_width, expr, rhs_signal);
    }

    std::string expr_str = getExprText(expr);

    Node n;
    n.id = node_id;
    n.kind = "comparator";
    n.label = "";
    n.source = getSourceInfo(expr);
    refineSourceInfo(n.source, expr);
    n.metadata.expression = expr_str;
    n.metadata.operation = comparatorOperationSymbol(expr);
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);
    n.ports.push_back({"lhs", "input", lhs_signal, lhs_width, "lhs"});
    n.ports.push_back({"rhs", "input", rhs_signal, rhs_width, "rhs"});

    // A comparison always yields a single bit, regardless of operand width.
    // Use an explicit "[0:0]" (rather than an empty string) so downstream
    // width checks can tell "known to be 1 bit" apart from "unknown".
    std::string display_label = out_signal;
    if (display_label.size() >= 5 && display_label.compare(display_label.size() - 5, 5, "_next") == 0) {
        display_label = display_label.substr(0, display_label.size() - 5);
    }
    n.ports.push_back({out_signal, "output", out_signal, "[0:0]", display_label});
    mod.nodes.push_back(n);
    propagateStruct(mod, preferred_name, out_signal);
    return out_signal;
}

bool DesignExtractor::isConditionalOperation(vpiHandle expr) {
    return expr
        && vpi_get(vpiType, expr) == vpiOperation
        && vpi_get(vpiOpType, expr) == vpiConditionOp;
}

std::string DesignExtractor::promoteMuxExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!isConditionalOperation(expr)) return "";

    std::vector<vpiHandle> operands;
    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    if (operands.size() != 3) return "";

    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string node_id = sanitizeId("mux:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":ternary");
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    auto promote_operand = [&](vpiHandle operand, const std::string& suffix) {
        if (!isLiteralExpr(operand)) {
            return getOrPromoteExpr(operand, mod, out_signal + suffix, is_procedural, current_drivers);
        }

        std::string literal_signal = getLiteralLabel(operand);
        ensureLiteralNode(operand, mod, literal_signal, getWidth(operand), expr, literal_signal);
        return literal_signal;
    };

    std::string sel_signal = promote_operand(operands[0], "_sel");
    std::string true_signal = promote_operand(operands[1], "_true");
    std::string false_signal = promote_operand(operands[2], "_false");

    std::string sel_width = getDeclaredSignalWidth(mod, sel_signal);
    if (sel_width.empty()) sel_width = getWidth(operands[0]);

    std::string true_width = getDeclaredSignalWidth(mod, true_signal);
    if (true_width.empty()) true_width = getWidth(operands[1]);

    std::string false_width = getDeclaredSignalWidth(mod, false_signal);
    if (false_width.empty()) false_width = getWidth(operands[2]);

    std::string width = getDeclaredSignalWidth(mod, out_signal);
    if (width.empty()) width = getWidth(expr);
    if (width.empty()) width = !true_width.empty() ? true_width : false_width;

    Node n;
    n.id = node_id;
    n.kind = "mux";
    n.label = "";
    n.source = getSourceInfo(expr);
    refineSourceInfo(n.source, expr);
    n.metadata.expression = getExprText(expr);
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);

    // A conditional over whole arrays represents one mux per unpacked array
    // element. Prefer the result shape, then fall back to either data arm so
    // nested ternaries keep the same stacked representation.
    auto inherit_array_shape = [&](const std::string& signal) {
        ensureDeclaredArray(mod, signal);
        auto dimension = mod.arrayDimensions.find(signal);
        if (dimension != mod.arrayDimensions.end()) {
            n.metadata.isArrayNode = true;
            n.metadata.arrayDimension = dimension->second;
            auto size = mod.arraySizes.find(signal);
            if (size != mod.arraySizes.end()) n.metadata.arraySize = size->second;
            return true;
        }

        for (const auto& source_node : mod.nodes) {
            if (!source_node.metadata.isArrayNode) continue;
            for (const auto& port : source_node.ports) {
                if (port.direction != "output" || port.signal != signal) continue;
                n.metadata.isArrayNode = true;
                n.metadata.arrayDimension = source_node.metadata.arrayDimension;
                n.metadata.arraySize = source_node.metadata.arraySize;
                return true;
            }
        }
        return false;
    };
    if (!inherit_array_shape(out_signal) && !inherit_array_shape(true_signal)) {
        inherit_array_shape(false_signal);
    }

    n.ports.push_back({"sel", "input", sel_signal, sel_width, "s"});
    n.ports.push_back({"true", "input", true_signal, true_width, "1'b1"});
    n.ports.push_back({"false", "input", false_signal, false_width, "1'b0"});

    n.ports.push_back({"out", "output", out_signal, width});
    mod.nodes.push_back(n);
    propagateStruct(mod, preferred_name, out_signal);
    return out_signal;
}

bool DesignExtractor::isInverterOperation(vpiHandle expr) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation) return false;
    int op = vpi_get(vpiOpType, expr);
    if (op == vpiBitNegOp) return true;

    // `!` (vpiNotOp=3) is logical NOT: it reduces any operand to 1-bit.
    // Promote to inverter only when the operand is a simple 1-bit signal so
    // the semantics are identical to `~`.  Multi-bit operands stay as combs.
    if (op == vpiNotOp) {
        // Promote `!` to an inverter only when the operand is a simple signal
        // reference (not a compound expression).  The width check is deferred
        // to promoteInverterExpr where Module context is available for a
        // reliable declared-width lookup.
        vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
        if (!op_itr) return false;
        vpiHandle operand = vpi_scan(op_itr);
        bool more = operand && vpi_scan(op_itr) != nullptr;
        vpi_release_handle(op_itr);
        if (!operand || more) return false;

        int t = vpi_get(vpiType, operand);
        return (t == vpiNet || t == vpiReg || t == vpiPort || t == 608);
    }
    return false;
}

std::string DesignExtractor::promoteInverterExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!expr || !isInverterOperation(expr)) return "";

    std::vector<vpiHandle> operands;
    vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
    if (op_itr) {
        while (vpiHandle operand = vpi_scan(op_itr)) {
            operands.push_back(operand);
        }
        vpi_release_handle(op_itr);
    }
    if (operands.size() != 1) return "";

    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string node_id = sanitizeId("inverter:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":expr");
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    vpiHandle operand = operands[0];
    std::string input_signal;
    if (isLiteralExpr(operand)) {
        input_signal = getLiteralLabel(operand);
        ensureLiteralNode(operand, mod, input_signal, getWidth(operand), expr, input_signal);
    } else {
        input_signal = getOrPromoteExpr(operand, mod, out_signal + "_in", is_procedural, current_drivers);
    }

    std::string input_width = getWidth(operand);
    std::string declared_input_width = getDeclaredSignalWidth(mod, input_signal);
    if (bitSizeFromWidth(declared_input_width) > bitSizeFromWidth(input_width)) {
        input_width = declared_input_width;
    }
    if (input_width.empty()) {
        int inferred_input_size = expressionBitSize(operand);
        if (inferred_input_size > 1) input_width = "[" + std::to_string(inferred_input_size - 1) + ":0]";
    }


    std::string width = getWidth(expr);
    std::string declared_output_width = getDeclaredSignalWidth(mod, out_signal);
    if (declared_output_width.empty() && out_signal.size() > 5 && out_signal.compare(out_signal.size() - 5, 5, "_next") == 0) {
        declared_output_width = getDeclaredSignalWidth(mod, out_signal.substr(0, out_signal.size() - 5));
    }
    if (bitSizeFromWidth(declared_output_width) > bitSizeFromWidth(width)) {
        width = declared_output_width;
    }
    if (width.empty()) {
        int inferred_size = expressionBitSize(expr);
        if (inferred_size > 1) {
            width = "[" + std::to_string(inferred_size - 1) + ":0]";
        } else if (vpi_get(vpiOpType, expr) != vpiNotOp) {
            // Bitwise negation (~) preserves its operand's width, so inheriting
            // input_width here is a reasonable last resort. Logical NOT (!)
            // always reduces to a single bit regardless of operand width — for
            // that case leave width empty (scalar) rather than wrongly
            // inheriting a wide operand's width.
            width = input_width;
        }
    }

    Node n;
    n.id = node_id;
    n.kind = "inverter";
    n.label = "";
    n.source = getSourceInfo(expr);
    refineSourceInfo(n.source, expr);
    if (n.source.col > 0) n.source.col--;
    n.metadata.expression = getExprText(expr);
    n.metadata.operation = (vpi_get(vpiOpType, expr) == vpiNotOp) ? "!" : "~";
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);

    std::string input_name = input_signal;
    std::string input_label = "";
    size_t bracket = input_signal.find('[');
    if (bracket != std::string::npos) {
        input_name = input_signal.substr(0, bracket);
        input_label = input_signal.substr(bracket);
    }
    n.ports.push_back({input_name, "input", input_signal, input_width, input_label});

    std::string display_label = out_signal;
    if (display_label.size() >= 5 && display_label.compare(display_label.size() - 5, 5, "_next") == 0) {
        display_label = display_label.substr(0, display_label.size() - 5);
    }
    n.ports.push_back({out_signal, "output", out_signal, width, display_label});
    mod.nodes.push_back(n);
    propagateStruct(mod, preferred_name, out_signal);
    return out_signal;
}

bool DesignExtractor::isGateOperation(vpiHandle expr) {
    if (!expr || vpi_get(vpiType, expr) != vpiOperation) return false;
    int op = vpi_get(vpiOpType, expr);
    return op == vpiBitAndOp || op == vpiBitOrOp || op == vpiBitXorOp || op == vpiBitXNorOp || op == vpiLogAndOp || op == vpiLogOrOp;
}

// AND/OR/XOR keep their name; a negated output (fused from an enclosing `~(...)`,
// see getOrPromoteExpr) becomes NAND/NOR/XNOR. A source-level XNOR (`^~`/`~^`) is
// already negated by definition, so negateOutput is never applied to it — that
// would double-negate back to XOR, which callers must not request. Logical `&&`/
// `||` reuse the AND/OR names — same glyph, since the difference is only in how
// the output width is resolved (see promoteGateExpr's isLogical handling).
std::string DesignExtractor::gateOperationName(int opType, bool negateOutput) {
    switch (opType) {
        case vpiBitAndOp: return negateOutput ? "nand" : "and";
        case vpiBitOrOp: return negateOutput ? "nor" : "or";
        case vpiBitXorOp: return negateOutput ? "xnor" : "xor";
        case vpiBitXNorOp: return "xnor";
        case vpiLogAndOp: return negateOutput ? "nand" : "and";
        case vpiLogOrOp: return negateOutput ? "nor" : "or";
        default: return "";
    }
}

// Flattens a chain of the *same* binary operator into one leaf list, e.g.
// `a & b & c & d` (parsed as nested 2-input ANDs) becomes [a, b, c, d] for a
// single n-input AND gate. Never descends into a different operator. Bitwise
// operators also stop at a width boundary: a nested operand whose
// self-determined width differs from the parent's marks an implicit
// truncation/extension the flattened gate can't represent losslessly. Logical
// `&&`/`||` chains do not need that check because every operand is independently
// reduced to a one-bit truth value. XNOR is excluded entirely: unlike
// AND/OR/XOR it isn't associative under this fusion — `(a ^~ b) ^~ c` computes
// `a ^ b ^ c`, not the 3-input XNOR `~(a ^ b ^ c)` a naive flatten would
// produce — so callers never recurse into it (see promoteGateExpr).
void DesignExtractor::collectGateOperands(vpiHandle expr, int opType, const std::string& outputWidth, std::vector<vpiHandle>& leaves) {
    if (expr && vpi_get(vpiType, expr) == vpiOperation && vpi_get(vpiOpType, expr) == opType) {
        bool isLogical = (opType == vpiLogAndOp || opType == vpiLogOrOp);
        bool compatibleWidth = isLogical;
        if (!isLogical) {
            // Compare self-determined bit sizes rather than raw width strings:
            // an empty/scalar width must default to 1 bit on both sides so
            // ordinary 1-bit chains (the common case) still flatten, while a
            // genuinely resolved-but-different width (e.g. a 1-bit child
            // folding into a 4-bit parent) is never silently treated as a
            // match.
            int childSize = expressionBitSize(expr);
            int outputSize = bitSizeFromWidth(outputWidth);
            if (outputSize <= 0) outputSize = 1;
            compatibleWidth = (childSize == outputSize);
        }
        if (compatibleWidth) {
            std::vector<vpiHandle> operands;
            vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
            if (op_itr) {
                while (vpiHandle operand = vpi_scan(op_itr)) {
                    operands.push_back(operand);
                }
                vpi_release_handle(op_itr);
            }
            if (operands.size() >= 2) {
                for (auto operand : operands) collectGateOperands(operand, opType, outputWidth, leaves);
                return;
            }
        }
    }
    leaves.push_back(expr);
}

// `expr` is the AND/OR/XOR/XNOR expression itself; `display_expr` is what the
// user actually wrote (the same node for a plain gate, or the enclosing `~(...)`
// when this is a fused NAND/NOR/XNOR) — used for the hover expression text and
// source range so navigation still lands on the real source span.
std::string DesignExtractor::promoteGateExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers, bool negate_output, vpiHandle display_expr) {
    if (!isGateOperation(expr)) return "";
    int opType = vpi_get(vpiOpType, expr);
    std::string opName = gateOperationName(opType, negate_output);
    if (opName.empty()) return "";

    vpiHandle text_expr = display_expr ? display_expr : expr;
    std::string out_signal = preferred_name.empty() ? nextId() : preferred_name;
    std::string width = getWidth(expr);

    // `&&`/`||` reduce each operand to a boolean truth value first (unlike
    // bitwise `&`/`|`, which are per-bit and preserve operand width), so the
    // result is always a single bit regardless of operand width — same as a
    // comparator (see promoteComparatorExpr).
    bool isLogical = (opType == vpiLogAndOp || opType == vpiLogOrOp);
    if (isLogical) {
        width = "[0:0]";
    }

    std::vector<vpiHandle> leaf_operands;
    if (opType == vpiBitXNorOp) {
        // XNOR isn't associative under this fusion (see collectGateOperands).
        vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
        if (op_itr) {
            while (vpiHandle operand = vpi_scan(op_itr)) {
                leaf_operands.push_back(operand);
            }
            vpi_release_handle(op_itr);
        }
    } else {
        collectGateOperands(expr, opType, width, leaf_operands);
    }
    if (leaf_operands.size() < 2) return "";

    if (isLogical) {
        // Same-kind logical nodes have been flattened out above. Preserve the
        // existing fallback for all other nested gate/ALU expressions: a
        // condition like `(sel & valid) || force_i` should remain one opaque
        // comb node rather than a bitwise AND gate feeding a logical OR gate.
        for (auto operand : leaf_operands) {
            if (isGateOperation(operand) || isAluOperation(operand)) return "";
        }
    }

    std::string node_id = "gate:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":" + opName;
    if (!is_procedural) {
        for (const auto& n : mod.nodes) {
            if (n.id == node_id) return out_signal;
        }
    }

    Node n;
    n.id = node_id;
    n.kind = "gate";
    n.label = "";
    n.source = getSourceInfo(text_expr);
    // For a fused NAND/NOR/XNOR, text_expr is the enclosing `~(...)` and its own
    // reported range already covers that full span. Refining would replace it
    // with the inner AND/OR/XOR operand's hull, dropping the `~( )` wrapper we
    // deliberately kept text_expr for.
    if (!negate_output) {
        refineSourceInfo(n.source, text_expr);
    }
    n.metadata.expression = getExprText(text_expr);
    n.metadata.operation = opName;
    n.metadata.isProcedural = is_procedural;
    n.metadata.parameterRefs = collectParameterRefs(expr, mod);

    for (size_t i = 0; i < leaf_operands.size(); ++i) {
        vpiHandle operand = leaf_operands[i];
        std::string signal;
        if (isLiteralExpr(operand)) {
            signal = getLiteralLabel(operand);
            ensureLiteralNode(operand, mod, signal, getWidth(operand), expr, signal);
        } else {
            signal = getOrPromoteExpr(operand, mod, out_signal + "_in" + std::to_string(i), is_procedural, current_drivers);
        }

        std::string operand_width = getWidth(operand);
        std::string declared_width = getDeclaredSignalWidth(mod, signal);
        if (bitSizeFromWidth(declared_width) > bitSizeFromWidth(operand_width)) {
            operand_width = declared_width;
        }
        if (operand_width.empty()) {
            // A bit-select/part-select leaf (e.g. "instr[6:0]") encodes its own
            // width in the slice — more reliable here than VPI introspection,
            // which can come back empty for a select nested this deep.
            operand_width = widthFromSignalSlice(signal);
        }
        if (operand_width.empty()) {
            int inferred = expressionBitSize(operand);
            if (inferred > 1) operand_width = "[" + std::to_string(inferred - 1) + ":0]";
        }

        std::string port_name = "in" + std::to_string(i);
        // A bracket-select input (e.g. "instr[6:0]") shows its slice as the
        // label, matching how comb/inverter display bus-tap inputs; a plain
        // signal reference gets no label.
        size_t bracket = signal.find('[');
        std::string port_label = bracket != std::string::npos ? signal.substr(bracket) : "";
        n.ports.push_back({port_name, "input", signal, operand_width, port_label});
    }

    std::string display_label = out_signal;
    if (display_label.size() >= 5 && display_label.compare(display_label.size() - 5, 5, "_next") == 0) {
        display_label = display_label.substr(0, display_label.size() - 5);
    }
    n.ports.push_back({out_signal, "output", out_signal, width, display_label});
    mod.nodes.push_back(n);
    propagateStruct(mod, preferred_name, out_signal);
    return out_signal;
}

std::string DesignExtractor::getOrPromoteExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers) {
    if (!expr) return "";
    int type = vpi_get(vpiType, expr);

    if (type == vpiFuncCall) {
        return promoteFunctionCallExpr(expr, mod, preferred_name, is_procedural, current_drivers);
    }

    if (auto field = getStructFieldRef(expr, mod)) {
        return ensureStructBreakout(mod, field->first, field->second, getSourceInfo(expr));
    }

    if (isReplicationOperation(expr)) {
        std::string replicated_signal = promoteReplicationExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!replicated_signal.empty()) return replicated_signal;
    }

    if (isInverterOperation(expr)) {
        // `~(a & b & ...)` / `~(a | b | ...)` / `~(a ^ b ^ ...)` render as one
        // NAND/NOR/XNOR gate with a negated-output bubble, not a separate
        // inverter feeding a separate AND/OR/XOR node. (`~(a ~^ b)` is excluded:
        // its operand is already an XNOR, and re-negating it is a real XOR, not
        // a gate this fusion can represent — leave that as a plain inverter.)
        if (vpi_get(vpiOpType, expr) == vpiBitNegOp) {
            vpiHandle inv_itr = vpi_iterate(vpiOperand, expr);
            vpiHandle inv_operand = inv_itr ? vpi_scan(inv_itr) : nullptr;
            if (inv_itr) vpi_release_handle(inv_itr);
            if (inv_operand && isGateOperation(inv_operand)) {
                int inner_op = vpi_get(vpiOpType, inv_operand);
                if (inner_op == vpiBitAndOp || inner_op == vpiBitOrOp || inner_op == vpiBitXorOp) {
                    std::string gate_signal = promoteGateExpr(inv_operand, mod, preferred_name, is_procedural, current_drivers, true, expr);
                    if (!gate_signal.empty()) return gate_signal;
                }
            }
        }

        std::string inverted_signal = promoteInverterExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!inverted_signal.empty()) return inverted_signal;
    }

    if (isGateOperation(expr)) {
        std::string gate_signal = promoteGateExpr(expr, mod, preferred_name, is_procedural, current_drivers, false, expr);
        if (!gate_signal.empty()) return gate_signal;
    }

    if (isConditionalOperation(expr)) {
        std::string mux_signal = promoteMuxExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!mux_signal.empty()) return mux_signal;
    }

    // Simple types that don't need promotion. vpiHierPath (5000) is UHDM's node for a
    // dotted hierarchical reference like an interface/modport field access (`bus.ready`);
    // without this, such a reference falls through to the generic comb-node promotion
    // below, which can't find any identifier inside a hier_path (collectIdentifierHandlesRecursive
    // doesn't walk it either) and ends up naming its lone output port after the caller's
    // `preferred_name` — a synthetic label, not the real signal — leaving a node with no
    // real inputs standing in for a plain signal reference.
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == 608 || type == vpiHierPath || isLiteralExpr(expr)) {
        return getSignalName(expr, current_drivers);
    }

    if (type == vpiBitSelect || type == vpiPartSelect || type == 606 || type == 607 || type == 130) {
        return processBusSelect(expr, mod);
    }

    if (isAluOperation(expr)) {
        std::string alu_signal = promoteAluExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!alu_signal.empty()) return alu_signal;
    }

    if (isComparatorOperation(expr)) {
        std::string comparator_signal = promoteComparatorExpr(expr, mod, preferred_name, is_procedural, current_drivers);
        if (!comparator_signal.empty()) return comparator_signal;
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
            if (isLiteralExpr(in)) {
                ensureLiteralNode(in, mod, sig, getWidth(in), in, sig);
            }
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
