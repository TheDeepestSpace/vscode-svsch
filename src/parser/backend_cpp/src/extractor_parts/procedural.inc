bool containsEdgeEvent(vpiHandle handle) {
    if (!handle) return false;
    if (vpi_get(vpiType, handle) == vpiOperation) {
        int op_type = vpi_get(vpiOpType, handle);
        if (op_type == vpiPosedgeOp || op_type == vpiNegedgeOp) return true;
    }

    vpiHandle operand_itr = vpi_iterate(vpiOperand, handle);
    if (operand_itr) {
        while (vpiHandle operand = vpi_scan(operand_itr)) {
            if (containsEdgeEvent(operand)) {
                vpi_release_handle(operand_itr);
                return true;
            }
        }
        vpi_release_handle(operand_itr);
    }
    return false;
}

bool isEdgeTriggeredAlways(vpiHandle process_handle) {
    vpiHandle stmt = vpi_handle(vpiStmt, process_handle);
    if (!stmt || vpi_get(vpiType, stmt) != vpiEventControl) return false;
    return containsEdgeEvent(vpi_handle(vpiCondition, stmt));
}

void DesignExtractor::processProcess(vpiHandle process_handle, Module& mod) {
    int type = vpi_get(vpiType, process_handle);
    vpiHandle stmt = vpi_handle(vpiStmt, process_handle);

    if (type == vpiAlways) {
        int always_type = vpi_get(vpiAlwaysType, process_handle);

        if (always_type == 3 || isEdgeTriggeredAlways(process_handle)) { // always_ff or plain edge-triggered always
            processAlwaysFf(process_handle, mod);
            return;
        } else if (always_type == 2 || always_type == 1) { // always_comb or always
            if (stmt) {
                processStatement(stmt, mod, process_handle);
                return;
            }
        }
    }

    Node n;
    n.id = "unknown:" + mod.name + ":" + std::to_string(getLine(process_handle));
    n.kind = "unknown";
    int p_type = vpi_get(vpiType, process_handle);
    n.label = (p_type == vpiAlways) ? "always" : ((p_type == vpiInitial) ? "initial" : "process");
    n.source.file = getFile(process_handle);
    n.source.line = getLine(process_handle);
    n.source.col = getCol(process_handle);
    n.source.endLine = getEndLine(process_handle);
    n.source.endCol = getEndCol(process_handle);
    mod.nodes.push_back(n);
}

void DesignExtractor::processStatement(vpiHandle stmt, Module& mod, vpiHandle process_handle) {
    if (!stmt) return;
    int type = vpi_get(vpiType, stmt);

    if (containsIf(stmt) || findFirstCase(stmt) || type == vpiFor || type == vpiRepeat || type == vpiForever || type == vpiWhile) {
        std::set<std::string> targets;
        collectAssignmentTargets(stmt, targets);
        if (!targets.empty()) {
            std::map<std::string, std::string> desired_outputs;
            for (const auto& target : targets) {
                desired_outputs[target] = target;
                size_t bracket = target.find('[');
                if (bracket != std::string::npos) {
                    std::string base = target.substr(0, bracket);
                    desired_outputs[base] = base;
                }
            }
            lowerStatement(stmt, mod, false, desired_outputs, process_handle);
            return;
        }
    }

    if (type == vpiBegin || type == vpiNamedBegin || type == vpiFork || type == vpiNamedFork) {
        vpiHandle itr = vpi_iterate(vpiStmt, stmt);
        if (itr) {
            while (vpiHandle s = vpi_scan(itr)) processStatement(s, mod, process_handle);
        }
    } else if (type == vpiCase) {
        processMux(stmt, mod, process_handle);
    } else if (type == vpiAssignment || type == 84 || type == 85) { // vpiAssignment, vpiBlockingAssignment, vpiNonBlockingAssignment
        // A task/function body is already a purely-combinational IR scope, so
        // don't introduce the procedural "_next" lowering used by module
        // always blocks. processCallableDeclaration passes a null process.
        processAssign(stmt, mod, process_handle != nullptr);
    } else if (type == vpiTaskCall) {
        processTaskCall(stmt, mod, process_handle != nullptr);
    } else if (type == vpiIf || type == vpiIfElse) {
        std::vector<vpiHandle> assigns;
        findAssignments(stmt, assigns);
        for (auto a : assigns) processAssign(a, mod, true);
    } else if (type == vpiEventControl) {
        processStatement(vpi_handle(vpiStmt, stmt), mod, process_handle);
    } else {
        // Fallback for other statement types
        std::vector<vpiHandle> assigns;
        findAssignments(stmt, assigns);
        for (auto a : assigns) processAssign(a, mod, true);
    }
}

bool DesignExtractor::isNonZeroResetValue(vpiHandle handle) {
    if (!handle) return false;
    vpiHandle actual = unwrapRef(handle);
    if (!actual) return false;
    int type = vpi_get(vpiType, actual);

    if (type == vpiOperation) {
        int opType = vpi_get(vpiOpType, actual);
        if (opType == 75 || opType == vpiConcatOp) { // assignment pattern or concatenation
            vpiHandle operand_itr = vpi_iterate(vpiOperand, actual);
            if (operand_itr) {
                bool all_zero = true;
                bool found_any = false;
                while (vpiHandle operand = vpi_scan(operand_itr)) {
                    found_any = true;
                    if (isNonZeroResetValue(operand)) {
                        all_zero = false;
                    }
                }
                vpi_release_handle(operand_itr);
                if (found_any && all_zero) return false;
            }
        }
    }

    if (type == 668) { // vpiTaggedPattern in UHDM
        vpiHandle pattern = vpi_handle(vpiPattern, actual);
        if (pattern) {
            return isNonZeroResetValue(pattern);
        }
    }

    if (type != vpiConstant) return true; // Complex logic is non-zero

    const char* val = vpi_get_str(vpiDecompile, actual);
    if (!val) return true;
    std::string s = val;
    // Remove underscores and size prefix
    size_t tick = s.find('\'');
    if (tick != std::string::npos) {
        if (tick + 2 < s.size()) {
            s = s.substr(tick + 2); // skip 'b, 'h, etc.
        } else {
            s = "";
        }
    }
    for (char c : s) {
        if (c != '0' && c != '_' && std::isalnum((unsigned char)c)) return true;
    }
    return false;
}

bool DesignExtractor::isCanonicalFullArrayResetLoop(
    vpiHandle assignment_handle,
    const Module& mod,
    const std::string& array_name,
    const std::string& index_expr
) {
    if (!assignment_handle || index_expr.empty()) return false;

    auto dim_it = mod.arrayDimensions.find(array_name);
    auto size_it = mod.arraySizes.find(array_name);
    if (dim_it == mod.arrayDimensions.end() || size_it == mod.arraySizes.end() || size_it->second <= 0) return false;

    // Only arrays whose declared addresses are exactly 0..N-1 can use this canonical form.
    // Other ranges still need a representation that preserves the loop bounds explicitly.
    std::smatch dim_match;
    if (!std::regex_match(dim_it->second, dim_match, std::regex(R"(\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\])"))) return false;
    int dim_left = std::stoi(dim_match[1].str());
    int dim_right = std::stoi(dim_match[2].str());
    int array_size = size_it->second;
    if (std::min(dim_left, dim_right) != 0 || std::max(dim_left, dim_right) != array_size - 1) return false;

    vpiHandle loop = assignment_handle;
    while (loop && vpi_get(vpiType, loop) != vpiFor) {
        vpiHandle parent = vpi_handle(vpiParent, loop);
        if (!parent || parent == loop) return false;
        int parent_type = vpi_get(vpiType, parent);
        if (parent_type == vpiIf || parent_type == vpiIfElse || parent_type == vpiCase
            || parent_type == vpiWhile || parent_type == vpiRepeat || parent_type == vpiForever) return false;
        loop = parent;
    }
    if (!loop) return false;

    auto loop_control = [&](int relation) {
        vpiHandle control = vpi_handle(relation, loop);
        if (control) return control;
        vpiHandle itr = vpi_iterate(relation, loop);
        if (!itr) return static_cast<vpiHandle>(nullptr);
        control = vpi_scan(itr);
        vpi_release_handle(itr);
        return control;
    };

    // UHDM's constant-value evaluator (getConstantInt/isLiteralExpr) reliably
    // folds a plain literal, but a parameterized loop bound like
    // `(1<<ADDR_WIDTH)` comes back as an unresolved vpiOperation, and neither
    // it nor its parameter-reference operand carries decompiled source text
    // or resolves through vpiActual from this local (loop-scoped) use site.
    // Walk the operand tree ourselves: recurse through binary/unary
    // arithmetic operations, and for a leaf that isn't itself a literal,
    // resolve its bare identifier name against the module's own already-known
    // parameter defaults (the same defaults generateParameterValues() feeds
    // to the generate-region and replication-width constant folders).
    std::function<std::optional<int>(vpiHandle)> constExprValue = [&](vpiHandle expr) -> std::optional<int> {
        if (!expr) return std::nullopt;
        vpiHandle actual = unwrapRef(expr);
        if (!actual) actual = expr;
        if (isLiteralExpr(actual)) return getConstantInt(actual);
        if (vpi_get(vpiType, actual) == vpiOperation) {
            int op_type = vpi_get(vpiOpType, actual);
            vpiHandle op_itr = vpi_iterate(vpiOperand, actual);
            if (!op_itr) return std::nullopt;
            std::vector<vpiHandle> operands;
            while (vpiHandle op = vpi_scan(op_itr)) operands.push_back(op);
            if (operands.size() == 1) {
                auto v = constExprValue(operands[0]);
                if (!v) return std::nullopt;
                if (op_type == vpiMinusOp) return -*v;
                if (op_type == vpiPlusOp) return *v;
                return std::nullopt;
            }
            if (operands.size() == 2) {
                auto l = constExprValue(operands[0]);
                auto r = constExprValue(operands[1]);
                if (!l || !r) return std::nullopt;
                switch (op_type) {
                    case vpiAddOp: return *l + *r;
                    case vpiSubOp: return *l - *r;
                    case vpiMultOp: return *l * *r;
                    case vpiDivOp: return *r != 0 ? std::optional<int>(*l / *r) : std::nullopt;
                    case vpiLShiftOp:
                    case vpiArithLShiftOp: return *l << *r;
                    case vpiRShiftOp:
                    case vpiArithRShiftOp: return *l >> *r;
                    default: return std::nullopt;
                }
            }
            return std::nullopt;
        }
        std::string name = getSignalName(expr);
        if (name.empty()) return std::nullopt;
        auto params = generateParameterValues(mod);
        auto it = params.find(name);
        return it != params.end() ? std::optional<int>(it->second) : std::nullopt;
    };

    // The loop body must do exactly one thing: assign one uniform value to array[index].
    std::vector<vpiHandle> loop_assignments;
    findAssignments(loop, loop_assignments);
    if (loop_assignments.size() != 1 || !isSameObject(loop_assignments.front(), assignment_handle)) return false;

    vpiHandle init = loop_control(vpiForInitStmt);
    vpiHandle init_lhs = init ? vpi_handle(vpiLhs, init) : nullptr;
    vpiHandle init_rhs = init ? vpi_handle(vpiRhs, init) : nullptr;
    std::string loop_var = getSignalName(init_lhs);
    auto init_bound = init_rhs ? constExprValue(init_rhs) : std::nullopt;
    if (loop_var.empty() || loop_var != index_expr || !init_bound) return false;

    // A loop that visits every address 0..N-1 covers the full array regardless of direction:
    // ascending (init 0, counts up) or descending (init N-1, counts down). Either is canonical.
    int init_value = *init_bound;
    bool descending;
    if (init_value == 0) {
        descending = false;
    } else if (init_value == array_size - 1) {
        descending = true;
    } else {
        return false;
    }

    // RV represents one value broadcast to the full stack, so reject per-address values.
    std::vector<vpiHandle> reset_value_identifiers;
    collectIdentifierHandlesRecursive(vpi_handle(vpiRhs, assignment_handle), reset_value_identifiers);
    if (std::any_of(reset_value_identifiers.begin(), reset_value_identifiers.end(),
        [&](vpiHandle identifier) { return getSignalName(identifier) == loop_var; })) return false;

    vpiHandle condition = vpi_handle(vpiCondition, loop);
    if (!condition || vpi_get(vpiType, condition) != vpiOperation) return false;
    int condition_op = vpi_get(vpiOpType, condition);
    if (descending) {
        if (condition_op != vpiGeOp) return false;
    } else {
        if (condition_op != vpiLtOp && condition_op != vpiLeOp) return false;
    }
    vpiHandle condition_operands = vpi_iterate(vpiOperand, condition);
    if (!condition_operands) return false;
    vpiHandle condition_lhs = vpi_scan(condition_operands);
    vpiHandle condition_rhs = vpi_scan(condition_operands);
    bool condition_has_extra_operand = vpi_scan(condition_operands) != nullptr;
    vpi_release_handle(condition_operands);
    if (!condition_lhs || !condition_rhs || condition_has_extra_operand || getSignalName(condition_lhs) != loop_var) return false;
    auto condition_bound = constExprValue(condition_rhs);
    if (!condition_bound) return false;
    int expected_bound = descending ? 0 : (condition_op == vpiLtOp ? array_size : array_size - 1);
    if (*condition_bound != expected_bound) return false;

    vpiHandle increment = loop_control(vpiForIncStmt);
    if (!increment) return false;
    int increment_type = vpi_get(vpiType, increment);
    if (increment_type == vpiOperation) {
        int increment_op = vpi_get(vpiOpType, increment);
        if (descending) {
            if (increment_op != vpiPostDecOp && increment_op != vpiPreDecOp) return false;
        } else {
            if (increment_op != vpiPostIncOp && increment_op != vpiPreIncOp) return false;
        }
        vpiHandle operands = vpi_iterate(vpiOperand, increment);
        if (!operands) return false;
        vpiHandle operand = vpi_scan(operands);
        bool has_extra_operand = vpi_scan(operands) != nullptr;
        vpi_release_handle(operands);
        return operand && !has_extra_operand && getSignalName(operand) == loop_var;
    }

    vpiHandle increment_lhs = vpi_handle(vpiLhs, increment);
    vpiHandle increment_rhs = vpi_handle(vpiRhs, increment);
    int expected_step_op = descending ? vpiSubOp : vpiAddOp;
    if (!increment_lhs || getSignalName(increment_lhs) != loop_var || !increment_rhs || vpi_get(vpiType, increment_rhs) != vpiOperation || vpi_get(vpiOpType, increment_rhs) != expected_step_op) return false;
    vpiHandle increment_operands = vpi_iterate(vpiOperand, increment_rhs);
    if (!increment_operands) return false;
    vpiHandle add_lhs = vpi_scan(increment_operands);
    vpiHandle add_rhs = vpi_scan(increment_operands);
    bool increment_has_extra_operand = vpi_scan(increment_operands) != nullptr;
    vpi_release_handle(increment_operands);
    return add_lhs && add_rhs && !increment_has_extra_operand
        && getSignalName(add_lhs) == loop_var
        && isLiteralExpr(add_rhs)
        && getConstantInt(add_rhs) == 1;
}

bool DesignExtractor::isSameObject(vpiHandle h1, vpiHandle h2) {
    if (h1 == h2) return true;
    if (!h1 || !h2) return false;
    if (vpi_get(vpiType, h1) != vpi_get(vpiType, h2)) return false;
    
    // Check line and column as a proxy for object identity
    int l1 = vpi_get(vpiLineNo, h1);
    int l2 = vpi_get(vpiLineNo, h2);
    if (l1 != l2) return false;
    
    int c1 = vpi_get(vpiColumnNo, h1);
    int c2 = vpi_get(vpiColumnNo, h2);
    if (c1 != c2) return false;

    return true;
}

bool DesignExtractor::isAncestor(vpiHandle ancestor, vpiHandle descendant) {
    if (!ancestor || !descendant) return false;
    vpiHandle curr = descendant;
    while (curr) {
        if (isSameObject(ancestor, curr)) return true;
        int type = vpi_get(vpiType, curr);
        if (type == vpiAlways || type == vpiModule) break;
        vpiHandle parent = vpi_handle(vpiParent, curr);
        if (!parent || parent == curr) break;
        curr = parent;
    }
    return false;
}

void DesignExtractor::processAlwaysFf(vpiHandle always_handle, Module& mod) {
    vpiHandle stmt = vpi_handle(vpiStmt, always_handle);
    if (!stmt) return;

    std::vector<vpiHandle> assignments;
    findAssignments(stmt, assignments);

    bool statement_has_case = findFirstCase(stmt) != nullptr;
    bool has_lowerable_aggregate_assignments = false;
    std::vector<vpiHandle> aggregate_assignments;
    std::map<std::string, std::vector<vpiHandle>> reg_assigns;
    std::map<std::string, vpiHandle> reg_lhs_handles;
    std::vector<std::string> reg_first_seen_order;
    std::set<std::string> concat_derived_regs;
    for (vpiHandle a : assignments) {
        vpiHandle lhs = vpi_handle(vpiLhs, a);
        if (lhs) {
            if (isConcatOperation(lhs)) {
                // Case statements still use the legacy aggregate path below. All other
                // concat LHS assignments participate in lowerStatement so branch priority
                // and register creation are shared with scalar assignments.
                if (statement_has_case) {
                    aggregate_assignments.push_back(a);
                    continue;
                }

                has_lowerable_aggregate_assignments = true;
                auto segments = flattenAggregateSegments(lhs, mod, true, true, "", {});
                for (const auto& segment : segments) {
                    if (segment.signal.empty()) continue;
                    if (!reg_assigns.count(segment.signal)) reg_first_seen_order.push_back(segment.signal);
                    reg_assigns[segment.signal].push_back(a);
                    if (!reg_lhs_handles.count(segment.signal)) reg_lhs_handles[segment.signal] = segment.handle;
                    concat_derived_regs.insert(segment.signal);
                }
                continue;
            }
            std::string sig_name = getSignalName(lhs);
            if (!reg_assigns.count(sig_name)) reg_first_seen_order.push_back(sig_name);
            reg_assigns[sig_name].push_back(a);
            if (!reg_lhs_handles.count(sig_name)) reg_lhs_handles[sig_name] = lhs;
        }
    }

    std::string clk_signal = "";
    std::string rst_signal = "";
    std::string reset_kind = "";
    bool reset_active_low = false;

    // Async reset inference
    vpiHandle event_control = vpi_handle(vpiStmt, always_handle);
    if (event_control && vpi_get(vpiType, event_control) == vpiEventControl) {
        vpiHandle cond = vpi_handle(vpiCondition, event_control);
        if (cond) {
             std::vector<vpiHandle> cond_ids;
             collectIdentifierHandles(cond, cond_ids);
             if (!cond_ids.empty()) clk_signal = getSignalName(cond_ids[0]);
             if (cond_ids.size() > 1) {
                 rst_signal = getSignalName(cond_ids[1]);
                 reset_kind = "async";
                 if (vpi_get(vpiType, cond) == vpiOperation) {
                     vpiHandle op_itr = vpi_iterate(vpiOperand, cond);
                     vpi_scan(op_itr);
                     vpiHandle rst_op = vpi_scan(op_itr);
                     if (rst_op && vpi_get(vpiOpType, rst_op) == 40) reset_active_low = true; // negedge
                     vpi_release_handle(op_itr);
                 }
             }
        }
    }

    // Sync reset inference
    if (rst_signal.empty()) {
        vpiHandle body = vpi_handle(vpiStmt, always_handle);
        if (body && vpi_get(vpiType, body) == vpiEventControl) body = vpi_handle(vpiStmt, body);
        if (body && vpi_get(vpiType, body) == vpiBegin) {
             vpiHandle itr = vpi_iterate(vpiStmt, body);
             if (itr) { body = vpi_scan(itr); vpi_release_handle(itr); }
        }
        if (body && (vpi_get(vpiType, body) == vpiIf || vpi_get(vpiType, body) == vpiIfElse) && vpi_handle(vpiElseStmt, body)) {
            vpiHandle cond = vpi_handle(vpiCondition, body);
            std::vector<vpiHandle> cond_ids;
            collectIdentifierHandles(cond, cond_ids);
            if (!cond_ids.empty() && looksResetSignal(getSignalName(cond_ids[0]))) {
                rst_signal = getSignalName(cond_ids[0]);
                reset_kind = "sync";
                if (vpi_get(vpiType, cond) == vpiOperation && vpi_get(vpiOpType, cond) == 43) reset_active_low = true;
            }
        }
    }

    bool is_reset_condition = false;
    vpiHandle reset_branch_stmt = nullptr;
    vpiHandle else_branch_stmt = nullptr;

    if (!rst_signal.empty()) {
        vpiHandle body = vpi_handle(vpiStmt, always_handle);
        if (body && vpi_get(vpiType, body) == vpiEventControl) body = vpi_handle(vpiStmt, body);
        if (body && vpi_get(vpiType, body) == vpiBegin) {
            vpiHandle itr = vpi_iterate(vpiStmt, body);
            if (itr) { body = vpi_scan(itr); vpi_release_handle(itr); }
        }
        if (body && (vpi_get(vpiType, body) == vpiIf || vpi_get(vpiType, body) == vpiIfElse)) {
            std::vector<vpiHandle> cond_ids;
            collectIdentifierHandles(vpi_handle(vpiCondition, body), cond_ids);
            for (vpiHandle cond_id : cond_ids) {
                if (getSignalName(cond_id) == rst_signal) {
                    is_reset_condition = true;
                    reset_branch_stmt = vpi_handle(vpiStmt, body);
                    else_branch_stmt = vpi_handle(vpiElseStmt, body);
                    break;
                }
            }
        }
    }

    std::map<std::string, LoweredValue> lowered_values;
    if (!is_reset_condition && containsIf(stmt) && !statement_has_case) {
        std::set<std::string> targets;
        collectAssignmentTargets(stmt, targets);
        std::map<std::string, std::string> desired_outputs;
        for (const auto& target : targets) desired_outputs[target] = target + "_next";
        lowered_values = lowerStatement(stmt, mod, true, desired_outputs, always_handle);
    } else if (is_reset_condition && else_branch_stmt && containsIf(else_branch_stmt) && !findFirstCase(else_branch_stmt)) {
        std::set<std::string> targets;
        collectAssignmentTargets(else_branch_stmt, targets);
        std::map<std::string, std::string> desired_outputs;
        for (const auto& target : targets) desired_outputs[target] = target + "_next";
        lowered_values = lowerStatement(else_branch_stmt, mod, true, desired_outputs, always_handle);
    } else if (has_lowerable_aggregate_assignments && !statement_has_case) {
        vpiHandle lowered_stmt = is_reset_condition && else_branch_stmt ? else_branch_stmt : stmt;
        std::set<std::string> targets;
        collectAssignmentTargets(lowered_stmt, targets);
        std::map<std::string, std::string> desired_outputs;
        for (const auto& target : targets) desired_outputs[target] = target + "_next";
        lowered_values = lowerStatement(lowered_stmt, mod, true, desired_outputs, always_handle);
    }

    // A non-zero aggregate reset needs the same bit breakout as a data assignment so
    // each register's RV port receives only its own slice. Zero resets remain implicit.
    std::map<std::string, LoweredValue> aggregate_reset_values;
    if (is_reset_condition && reset_branch_stmt && has_lowerable_aggregate_assignments) {
        bool has_nonzero_aggregate_reset = false;
        for (vpiHandle assignment : assignments) {
            vpiHandle lhs = vpi_handle(vpiLhs, assignment);
            if (isConcatOperation(lhs) && isAncestor(reset_branch_stmt, assignment)
                && isNonZeroResetValue(vpi_handle(vpiRhs, assignment))) {
                has_nonzero_aggregate_reset = true;
                break;
            }
        }
        if (has_nonzero_aggregate_reset) {
            std::set<std::string> reset_targets;
            collectAssignmentTargets(reset_branch_stmt, reset_targets);
            std::map<std::string, std::string> reset_outputs;
            for (const auto& target : reset_targets) reset_outputs[target] = target + "_reset_val";
            aggregate_reset_values = lowerStatement(
                reset_branch_stmt, mod, true, reset_outputs, always_handle);
        }
    }

    for (vpiHandle aggregate_assign : aggregate_assignments) {
        auto aggregate_values = lowerAggregateAssignment(aggregate_assign, mod, true, {}, "_next");
        for (const auto& [reg_name, value] : aggregate_values) {
            if (!value.assigned || reg_name.empty()) continue;

            Node n;
            n.id = "reg:" + mod.name + ":" + reg_name;
            n.kind = "register";
            n.label = reg_name;
            n.source.file = getFile(always_handle);
            n.source.line = getLine(always_handle);
            n.source.col = getCol(always_handle);
            n.source.endLine = getEndLine(always_handle);
            n.source.endCol = getEndCol(always_handle);
            n.metadata.clockSignal = clk_signal;
            n.metadata.isProcedural = true;

            std::string reg_base = reg_name;
            size_t bracket = reg_base.find('[');
            if (bracket != std::string::npos) reg_base = reg_base.substr(0, bracket);
            std::string reg_width = value.width;
            if (reg_width.empty()) reg_width = getDeclaredSignalWidth(mod, reg_name);
            if (reg_width.empty()) reg_width = "[0:0]";

            n.ports.push_back({"D", "input", value.signal, reg_width});
            n.ports.push_back({"Q", "output", reg_name, reg_width});
            if (!clk_signal.empty()) n.ports.push_back({clk_signal, "input", clk_signal, ""});
            mod.nodes.push_back(n);

            if (reg_name.find('[') != std::string::npos) {
                size_t slice = reg_name.find('[');
                ensureBusSliceCompositionInput(mod, reg_base, reg_name.substr(slice), reg_name, getSourceInfo(aggregate_assign));
            }
        }
    }

    // Preserve procedural source order for normal writes, then put reset-only writes last so
    // they retain reset priority if they cannot be folded into the canonical register reset.
    std::vector<std::string> reg_name_order;
    {
        std::vector<std::string> normal_first;
        std::vector<std::string> reset_sole_last;
        for (const auto& reg_name : reg_first_seen_order) {
            const auto& reg_assigns_vec = reg_assigns.at(reg_name);
            // Only indexed writes (bracketed LHS) go through the addr-mux collision/demotion
            // logic below, so only those need reordering. A bracket-less whole-array write
            // (e.g. `M <= '{default: ...}'`) must keep its original relative position — it
            // seeds the canonical "reg:<mod>:<base>" node that a sibling indexed write's
            // array_reg_exists check expects to already be there.
            bool sole_reset_assign = is_reset_condition && reset_branch_stmt &&
                reg_name.find('[') != std::string::npos &&
                std::all_of(reg_assigns_vec.begin(), reg_assigns_vec.end(),
                    [&](vpiHandle ra) { return isAncestor(reset_branch_stmt, ra); });
            (sole_reset_assign ? reset_sole_last : normal_first).push_back(reg_name);
        }
        reg_name_order = std::move(normal_first);
        reg_name_order.insert(reg_name_order.end(), reset_sole_last.begin(), reset_sole_last.end());
    }

    for (auto const& reg_name : reg_name_order) {
        auto const& reg_assigns_vec = reg_assigns.at(reg_name);
        vpiHandle lhs_first = reg_lhs_handles.count(reg_name)
            ? reg_lhs_handles.at(reg_name)
            : vpi_handle(vpiLhs, reg_assigns_vec[0]);
        std::string reg_base = getBaseSignalName(lhs_first);
        ensureDeclaredArray(mod, reg_base);

        // Detect variable-index array write: bracket with non-constant index -> stacked address mux
        // We check independently of mod.arrayDimensions since UHDM may store unpacked dims differently.
        bool is_array_reg = mod.arrayDimensions.count(reg_base) > 0;
        bool is_variable_index = false;
        std::string index_expr;
        vpiHandle index_handle = nullptr;
        {
            size_t bracket = reg_name.find('[');
            if (bracket != std::string::npos) {
                std::string candidate = reg_name.substr(bracket + 1);
                if (!candidate.empty() && candidate.back() == ']') candidate.pop_back();
                // Strip any trailing ]+:... for indexed part-selects
                auto plus_colon = candidate.find("+:");
                if (plus_colon != std::string::npos) candidate = candidate.substr(0, plus_colon);
                // A constant index contains only digits, ':', and optionally '-' (e.g., "0", "3:2", "7:4")
                bool is_constant = !candidate.empty() &&
                    std::all_of(candidate.begin(), candidate.end(), [](char c){ return std::isdigit((unsigned char)c) || c == ':' || c == '-'; });
                if (!is_constant && !candidate.empty() && candidate != "?" && candidate != "idx" && candidate != "bit") {
                    is_variable_index = true;
                    index_expr = candidate;

                    vpiHandle lhs_unwrapped = unwrapRef(lhs_first);
                    int lhs_type = vpi_get(vpiType, lhs_unwrapped);
                    if (lhs_type == vpiBitSelect) {
                        index_handle = vpi_handle(vpiIndex, lhs_unwrapped);
                    } else if (lhs_type == 606 || lhs_type == 607 || lhs_type == 130) {
                        index_handle = vpi_handle(vpiBaseExpr, lhs_unwrapped);
                    }

                    // Ensure base is a known declared signal (not a struct field or bus slice)
                    if (mod.internalSignals.find(reg_base) == mod.internalSignals.end()) {
                        is_variable_index = false;
                    }
                }
            }
        }

        // If array dimensions weren't found by the module scanner (UHDM doesn't expose them via VPI
        // ranges for logic arrays), fall back to source-text regex extraction.
        if (is_variable_index && !mod.arrayDimensions.count(reg_base)) {
            ensureDeclaredArray(mod, reg_base);
            is_array_reg = mod.arrayDimensions.count(reg_base) > 0;
        }

        Node n;
        n.id = "reg:" + mod.name + ":" + reg_name;
        n.kind = "register";
        n.label = reg_name;
        n.source.file = getFile(always_handle);
        n.source.line = getLine(always_handle);
        n.source.col = getCol(always_handle);
        n.source.endLine = getEndLine(always_handle);
        n.source.endCol = getEndCol(always_handle);

        n.metadata.resetKind = reset_kind;
        n.metadata.resetActiveLow = reset_active_low;
        n.metadata.clockSignal = clk_signal;
        n.metadata.isProcedural = true;
        n.metadata.resetSignal = rst_signal;
        n.metadata.typeName = getTypeName(lhs_first);
        if (!n.metadata.typeName.empty()) n.metadata.typeSource = getTypeSource(lhs_first);
        // For constant part/bit selects (r[3:2], r[0], etc.) the register name
        // already encodes the bit range — don't use the base signal's declared width
        // (which would be the full bus width) as the cell width. Compute the real
        // slice width from the range itself (e.g. "[3:2]" -> 2 bits) rather than
        // hardcoding 1 bit, which under-reported the width of multi-bit part-selects
        // to every downstream consumer (D/Q port thickness, bus-composition wiring).
        std::string reg_width = "";
        {
            size_t bracket = reg_name.find('[');
            if (bracket != std::string::npos) {
                std::string sel = reg_name.substr(bracket + 1);
                if (!sel.empty() && sel.back() == ']') sel.pop_back();
                bool is_const = !sel.empty() && std::all_of(sel.begin(), sel.end(),
                    [](char c){ return std::isdigit((unsigned char)c) || c == ':' || c == '-'; });
                if (is_const) {
                    size_t colon = sel.find(':');
                    if (colon == std::string::npos) {
                        reg_width = "[0:0]";
                    } else {
                        try {
                            int msb = std::stoi(sel.substr(0, colon));
                            int lsb = std::stoi(sel.substr(colon + 1));
                            int bits = std::abs(msb - lsb) + 1;
                            reg_width = bits > 1 ? "[" + std::to_string(bits - 1) + ":0]" : "[0:0]";
                        } catch (...) {
                            reg_width = "[0:0]";
                        }
                    }
                }
            }
        }
        if (reg_width.empty()) reg_width = getDeclaredSignalWidth(mod, reg_base);
        if (reg_width.empty()) reg_width = getWidth(lhs_first);
        auto lhs_field = getStructFieldRef(lhs_first, mod);
        if (lhs_field) {
            std::string fw = fieldWidth(mod.structSignals[lhs_field->first].type, lhs_field->second);
            if (!fw.empty()) reg_width = fw;
        }

        vpiHandle data_rhs = nullptr;
        vpiHandle reset_rhs = nullptr;
        vpiHandle reset_assign_handle = nullptr;
        // True when every assignment to this exact LHS text lives inside the reset branch —
        // i.e. there is no separate non-reset write to protect via a downstream rst mux
        // (e.g. a reset-only loop write `storage[i] <= 0`, as opposed to a genuine partial
        // reset where the same indexed target `M[addr]` is written in both branches).
        bool reset_is_sole_assign = false;

        if (is_reset_condition && reset_branch_stmt) {
            for (vpiHandle ra : reg_assigns_vec) {
                if (isAncestor(reset_branch_stmt, ra)) {
                    reset_rhs = vpi_handle(vpiRhs, ra);
                    reset_assign_handle = ra;
                    break;
                }
            }
            if (reset_rhs) {
                reset_is_sole_assign = std::all_of(reg_assigns_vec.begin(), reg_assigns_vec.end(),
                    [&](vpiHandle ra) { return isAncestor(reset_branch_stmt, ra); });
            }
        }

        bool canonical_full_array_reset = is_array_reg
            && reset_is_sole_assign
            && reset_assign_handle
            && isCanonicalFullArrayResetLoop(reset_assign_handle, mod, reg_base, index_expr);
        if (canonical_full_array_reset) {
            std::string array_reg_id = "reg:" + mod.name + ":" + reg_base;
            Node* array_reg = nullptr;
            for (auto& existing : mod.nodes) {
                if (existing.id == array_reg_id) {
                    array_reg = &existing;
                    break;
                }
            }
            if (!array_reg) {
                Node arr_reg;
                arr_reg.id = array_reg_id;
                arr_reg.kind = "register";
                arr_reg.label = reg_base;
                arr_reg.source = n.source;
                arr_reg.metadata.clockSignal = clk_signal;
                arr_reg.metadata.isProcedural = true;
                arr_reg.metadata.isArrayNode = true;
                arr_reg.metadata.arrayDimension = mod.arrayDimensions[reg_base];
                arr_reg.metadata.arraySize = mod.arraySizes[reg_base];
                arr_reg.ports.push_back({"D", "input", reg_base, reg_width});
                arr_reg.ports.push_back({"Q", "output", reg_base, reg_width});
                if (!clk_signal.empty()) arr_reg.ports.push_back({clk_signal, "input", clk_signal, ""});
                mod.nodes.push_back(arr_reg);
                array_reg = &mod.nodes.back();
            }

            array_reg->metadata.resetSignal = rst_signal;
            array_reg->metadata.resetKind = reset_kind;
            array_reg->metadata.resetActiveLow = reset_active_low;
            if (!rst_signal.empty() && std::none_of(array_reg->ports.begin(), array_reg->ports.end(),
                [&](const NodePort& port) { return port.name == rst_signal; })) {
                array_reg->ports.push_back({rst_signal, "input", rst_signal, ""});
            }

            if (isNonZeroResetValue(reset_rhs)
                && std::none_of(array_reg->ports.begin(), array_reg->ports.end(),
                    [](const NodePort& port) { return port.name == "RV"; })) {
                std::string rv_signal;
                if (isLiteralExpr(reset_rhs)) {
                    rv_signal = getLiteralLabel(reset_rhs);
                    ensureLiteralNode(reset_rhs, mod, rv_signal, reg_width, reset_assign_handle, getAssignmentRhsText(reset_assign_handle));
                } else {
                    rv_signal = getOrPromoteExpr(reset_rhs, mod, reg_base + "_reset_val", true);
                }
                // Literal/expression promotion can grow mod.nodes and invalidate array_reg.
                auto refreshed_array_reg = std::find_if(mod.nodes.begin(), mod.nodes.end(),
                    [&](const Node& node) { return node.id == array_reg_id; });
                if (refreshed_array_reg != mod.nodes.end()) {
                    refreshed_array_reg->ports.push_back({"RV", "input", rv_signal, reg_width, "RV"});
                }
            }

            // A proven full-range reset is represented by the stacked register's R/RV ports;
            // it does not need a per-address reset mux stage.
            continue;
        }

        std::vector<std::string> literal_inputs;
        for (vpiHandle a : reg_assigns_vec) {
            // Normally the reset assign is handled separately (RV port / rst mux) and excluded
            // here so it isn't double-counted as a data input. But when it's the *only*
            // assignment to this LHS (reset_is_sole_assign), there is no other assign to supply
            // data_rhs — the reset value IS the write's data, so let it flow through normally.
            if (reset_assign_handle && isSameObject(a, reset_assign_handle) && !reset_is_sole_assign) continue;
            vpiHandle rhs = vpi_handle(vpiRhs, a);
            if (rhs && isLiteralExpr(rhs)) {
                std::string literal_signal = getLiteralLabel(rhs);
                if (!literal_signal.empty() && looksNamedLiteral(literal_signal)) {
                    std::string literal_width = getDeclaredLiteralWidth(mod, literal_signal);
                    if (literal_width.empty()) literal_width = reg_width.empty() ? getWidth(rhs) : reg_width;
                    ensureLiteralNode(rhs, mod, literal_signal, literal_width, a, getAssignmentRhsText(a));
                    if (std::find(literal_inputs.begin(), literal_inputs.end(), literal_signal) == literal_inputs.end()) {
                        literal_inputs.push_back(literal_signal);
                    }
                }
            }
            if (rhs && !isLiteralExpr(rhs)) { data_rhs = rhs; break; }
            if (!data_rhs) data_rhs = rhs;
        }

        std::string d_signal = lowered_values.count(reg_name) && lowered_values[reg_name].assigned
            ? lowered_values[reg_name].signal
            : getOrPromoteExpr(data_rhs, mod, reg_base + "_next", true);
        std::string d_width = getWidth(data_rhs);
        if (!reg_width.empty()) d_width = reg_width;
        n.ports.push_back({"D", "input", d_signal, d_width});

        if (reset_rhs && isNonZeroResetValue(reset_rhs)) {
            std::string rv_signal;
            if (isConcatOperation(vpi_handle(vpiLhs, reset_assign_handle))
                && aggregate_reset_values.count(reg_name)) {
                rv_signal = aggregate_reset_values.at(reg_name).signal;
            } else if (isLiteralExpr(reset_rhs)) {
                rv_signal = getLiteralLabel(reset_rhs);
                ensureLiteralNode(reset_rhs, mod, rv_signal, reg_width, reset_assign_handle, getAssignmentRhsText(reset_assign_handle));
            } else {
                rv_signal = getOrPromoteExpr(reset_rhs, mod, reg_base + "_reset_val", true);
            }
            n.ports.push_back({"RV", "input", rv_signal, reg_width, "RV"});
        }

        for (const auto& literal_signal : literal_inputs) {
            n.ports.push_back({literal_signal, "input", literal_signal, reg_width, literal_signal});
        }
        n.ports.push_back({"Q", "output", reg_name, reg_width});
        if (!clk_signal.empty()) n.ports.push_back({clk_signal, "input", clk_signal, ""});
        if (!rst_signal.empty()) n.ports.push_back({rst_signal, "input", rst_signal, ""});

        // Array handling: stacked mux for variable-index writes; tag array registers
        if (is_variable_index) {
            int arr_size = mod.arraySizes.count(reg_base) ? mod.arraySizes.at(reg_base) : 1;

            // Ensure the whole-array register node exists first
            std::string array_reg_id = "reg:" + mod.name + ":" + reg_base;
            bool array_reg_exists = false;
            for (const auto& existing : mod.nodes) {
                if (existing.id == array_reg_id) { array_reg_exists = true; break; }
            }
            if (!array_reg_exists) {
                Node arr_reg;
                arr_reg.id = array_reg_id;
                arr_reg.kind = "register";
                arr_reg.label = reg_base;
                arr_reg.source = n.source;
                arr_reg.metadata.clockSignal = clk_signal;
                arr_reg.metadata.resetSignal = rst_signal;
                arr_reg.metadata.resetKind = reset_kind;
                arr_reg.metadata.resetActiveLow = reset_active_low;
                arr_reg.metadata.isProcedural = true;
                arr_reg.metadata.isArrayNode = true;
                arr_reg.metadata.arrayDimension = mod.arrayDimensions[reg_base];
                arr_reg.metadata.arraySize = arr_size;
                arr_reg.ports.push_back({"D", "input", reg_base + "_next", reg_width});
                arr_reg.ports.push_back({"Q", "output", reg_base, reg_width});
                if (!clk_signal.empty()) arr_reg.ports.push_back({clk_signal, "input", clk_signal, ""});
                // When reset is per-index (variable-index write), rst belongs in the mux chain,
                // not as a direct R pin that would imply whole-array reset.
                if (!rst_signal.empty() && !is_reset_condition) arr_reg.ports.push_back({rst_signal, "input", rst_signal, ""});
                mod.nodes.push_back(arr_reg);
            }

            // Convert any lowered scalar muxes for this element write into stacked muxes (write_en mux).
            // Use sanitized comparison since IDs are sanitized (e.g. M[address] → M_address_).
            std::string sanitized_reg_prefix = sanitizeId("mux:" + mod.name + ":" + reg_name + ":");
            for (auto& n_tmp : mod.nodes) {
                if (n_tmp.kind == "mux" && n_tmp.id.find(sanitized_reg_prefix) != std::string::npos) {
                    n_tmp.metadata.isArrayNode = true;
                    n_tmp.metadata.arrayDimension = mod.arrayDimensions[reg_base];
                    n_tmp.metadata.arraySize = arr_size;
                    for (auto& p : n_tmp.ports) {
                        if (p.direction == "input" && p.signal == reg_name) {
                            p.signal = reg_base; // Retain old array value when write disabled
                        }
                    }
                }
            }

            std::string d_signal_for_addr = d_signal;

            // For partial-reset array writes (rst only affects M[address], not the whole array),
            // insert a rst mux between the write candidate and the addr mux.
            // Chain: write_en_mux → rst_mux → addr_mux → register D
            //
            // A reset-only indexed write (e.g. a reset-loop `storage[i] <= 0`, where
            // reset_is_sole_assign is true) also needs this gate: without it, the addr-mux
            // stage would present the reset value whenever the index matches, even while rst
            // is inactive. Its "false" side has no non-reset D signal to fall back to, so it
            // holds the current array value instead — independent of whether this write ends
            // up the canonical chain stage or an upstream one.
            if (is_reset_condition && !rst_signal.empty() && reset_rhs) {
                std::string reset_val_signal;
                if (isLiteralExpr(reset_rhs)) {
                    reset_val_signal = getLiteralLabel(reset_rhs);
                    ensureLiteralNode(reset_rhs, mod, reset_val_signal, reg_width, reset_assign_handle, reset_val_signal);
                } else {
                    reset_val_signal = getOrPromoteExpr(reset_rhs, mod, reg_base + "_reset_val", true);
                }
                std::string rst_false_signal = reset_is_sole_assign ? reg_base : d_signal_for_addr;
                std::string rst_candidate = reg_base + "_rst_candidate";
                Node rst_mux;
                rst_mux.id = sanitizeId("mux:" + mod.name + ":" + reg_name + ":" + rst_signal + ":" + rst_candidate);
                rst_mux.kind = "mux";
                rst_mux.label = "if " + rst_signal;
                rst_mux.source = n.source;
                rst_mux.metadata.isArrayNode = true;
                rst_mux.metadata.arrayDimension = mod.arrayDimensions[reg_base];
                rst_mux.metadata.arraySize = arr_size;
                rst_mux.metadata.isProcedural = true;
                std::string rst_sel_width = getDeclaredSignalWidth(mod, rst_signal);
                rst_mux.ports.push_back({"sel", "input", rst_signal, rst_sel_width});
                rst_mux.ports.push_back({"true", "input", reset_val_signal, reg_width, "true"});
                rst_mux.ports.push_back({"false", "input", rst_false_signal, reg_width, "false"});
                rst_mux.ports.push_back({"out", "output", rst_candidate, reg_width});
                mod.nodes.push_back(rst_mux);
                d_signal_for_addr = rst_candidate;
            }

            std::string index_width = getDeclaredSignalWidth(mod, index_expr);
            int index_bits = bitSizeFromWidth(index_width);
            int min_index_bits = 1;
            while ((1 << min_index_bits) < arr_size) min_index_bits++;
            if (index_bits < min_index_bits) {
                index_bits = min_index_bits;
                index_width = "[" + std::to_string(index_bits - 1) + ":0]";
            }
            std::string zero_match_label = std::to_string(index_bits) + "'b0";

            Node addr_mux;
            addr_mux.id = "mux:" + mod.name + ":" + reg_base + "_addr";
            addr_mux.kind = "mux";
            addr_mux.label = "write address";
            if (index_handle) {
                addr_mux.source = getSourceInfo(index_handle);
                // Try to include the closing bracket by taking the end position from the LHS select handle
                vpiHandle lhs_unwrapped = unwrapRef(lhs_first);
                SourceInfo lhs_src = getSourceInfo(lhs_unwrapped);
                if (lhs_src.line == addr_mux.source.line && lhs_src.endLine == addr_mux.source.line) {
                    addr_mux.source.endCol = lhs_src.endCol;
                }
            } else {
                addr_mux.source = n.source;
            }
            addr_mux.metadata.isArrayNode = true;
            addr_mux.metadata.arrayDimension = mod.arrayDimensions[reg_base];
            addr_mux.metadata.arraySize = arr_size;
            addr_mux.metadata.arrayIndexSignal = "0";
            std::string sel_label = index_bits > 1 ? "s[]" : "s";
            addr_mux.ports.push_back({"sel", "input", index_expr, index_width, sel_label});
            addr_mux.ports.push_back({zero_match_label, "input", d_signal_for_addr, reg_width, zero_match_label});
            addr_mux.ports.push_back({"default", "input", reg_base, reg_width, "default"});
            addr_mux.ports.push_back({"out", "output", reg_base + "_next", reg_width});

            // Another distinct index expression may already write this same array (e.g. a
            // reset loop `storage[i] <= 0` alongside `storage[address] <= in_data`). Rather
            // than dropping this write when the canonical mux id is taken, demote the
            // existing mux to an upstream chain stage and let this write take its place —
            // its "default" falls back to the previous stage's output instead of the raw
            // array value, so both writes stay represented and connected.
            Node* existing_addr_mux = nullptr;
            for (auto& existing : mod.nodes) {
                if (existing.id == addr_mux.id) { existing_addr_mux = &existing; break; }
            }
            if (!existing_addr_mux) {
                mod.nodes.push_back(addr_mux);
            } else {
                std::string prior_index;
                for (const auto& p : existing_addr_mux->ports) {
                    if (p.name == "sel") { prior_index = p.signal; break; }
                }
                std::string stage_signal = sanitizeId(reg_base + "_" + prior_index + "_stage");
                existing_addr_mux->id = sanitizeId("mux:" + mod.name + ":" + reg_base + "_addr:" + prior_index);
                for (auto& p : existing_addr_mux->ports) {
                    if (p.direction == "output") p.signal = stage_signal;
                }
                for (auto& p : addr_mux.ports) {
                    if (p.name == "default") { p.signal = stage_signal; break; }
                }
                mod.nodes.push_back(addr_mux);
            }
            // Skip pushing the per-element register node — represented by the array register
            continue;
        }

        if (is_array_reg) {
            n.metadata.isArrayNode = true;
            n.metadata.arrayDimension = mod.arrayDimensions[reg_base];
            n.metadata.arraySize = mod.arraySizes[reg_base];
        }

        mod.nodes.push_back(n);

        // A concat-LHS target (e.g. `registered[2]`) produced its own register above;
        // wire its Q output into the base signal's bus composition node so downstream
        // readers (including the module output port) see the registered value instead
        // of being left disconnected. Plain (non-concat) partial-bit-select writes are
        // left to synthesizeBusCompositionNodes, which coalesces adjacent slices.
        if (!is_array_reg && !is_variable_index && concat_derived_regs.count(reg_name)
            && reg_name.find('[') != std::string::npos) {
            size_t bracket = reg_name.find('[');
            ensureBusSliceCompositionInput(
                mod, reg_base, reg_name.substr(bracket), reg_name, getSourceInfo(lhs_first));
        }
    }
}

// Strips the "work@" scope prefix that UHDM sometimes emits in decompiled strings.
static std::string stripWorkPrefix(const std::string& s) {
    if (s.rfind("work@", 0) == 0) return s.substr(5);
    return s;
}

// Extracts a human-readable label from a VPI expression handle.
// Preferred path: vpiDecompile.  Fallback for vpiOperation: reconstruct from operands
// so that concatenation patterns like {BYTE, 2'd0} are preserved rather than "expr".
static std::string decompileExprLabel(vpiHandle e) {
    if (!e) return "expr";
    const char* d = vpi_get_str(vpiDecompile, e);
    if (d && strlen(d) > 0) return stripWorkPrefix(d);

    int type = vpi_get(vpiType, e);
    if (type == vpiOperation) {
        int op_type = vpi_get(vpiOpType, e);
        if (op_type == vpiConcatOp || op_type == vpiMultiConcatOp) {
            vpiHandle op_itr = vpi_iterate(vpiOperand, e);
            if (op_itr) {
                std::string result = "{";
                bool first = true;
                while (vpiHandle op = vpi_scan(op_itr)) {
                    if (!first) result += ", ";
                    first = false;
                    const char* od = vpi_get_str(vpiDecompile, op);
                    if (od && strlen(od) > 0) {
                        result += stripWorkPrefix(od);
                    } else {
                        const char* name = vpi_get_str(vpiName, op);
                        result += (name ? stripWorkPrefix(name) : "?");
                    }
                    vpi_release_handle(op);
                }
                vpi_release_handle(op_itr);
                result += "}";
                return result;
            }
        }
    }
    // For non-operation expressions (references, enum values, etc.) try vpiName.
    const char* name = vpi_get_str(vpiName, e);
    if (name && strlen(name) > 0) return stripWorkPrefix(name);
    return "expr";
}

void DesignExtractor::processMux(vpiHandle case_handle, Module& mod, vpiHandle always_handle) {
    vpiHandle cond = vpi_handle(vpiCondition, case_handle);

    std::string out_signal = "";
    vpiHandle item_itr_tmp = vpi_iterate(vpiCaseItem, case_handle);
    if (item_itr_tmp) {
        while (vpiHandle item = vpi_scan(item_itr_tmp)) {
            vpiHandle item_stmt = vpi_handle(vpiStmt, item);
            if (item_stmt) {
                std::vector<vpiHandle> assigns;
                findAssignments(item_stmt, assigns);
                if (!assigns.empty()) {
                    vpiHandle lhs = vpi_handle(vpiLhs, assigns[0]);
                    if (lhs) out_signal = getSignalName(lhs);
                    break;
                }
            }
        }
        vpi_release_handle(item_itr_tmp);
    }

    std::string sel_name = getOrPromoteExpr(cond, mod, out_signal + "_sel");
    std::string out_width = getDeclaredSignalWidth(mod, out_signal);

    vpiHandle item_itr = vpi_iterate(vpiCaseItem, case_handle);
    struct CaseInput { std::string name; std::string label; std::string signal; std::string width; };
    std::vector<CaseInput> case_inputs;
    if (item_itr) {
        while (vpiHandle item = vpi_scan(item_itr)) {
            vpiHandle item_stmt = vpi_handle(vpiStmt, item);
            if (item_stmt) {
                std::vector<vpiHandle> assigns;
                findAssignments(item_stmt, assigns);
                for (vpiHandle a : assigns) {
                    vpiHandle rhs = vpi_handle(vpiRhs, a);
                    if (rhs) {
                        vpiHandle expr_itr = vpi_iterate(vpiExpr, item);
                        std::string label = "default";
                        if (expr_itr) {
                            vpiHandle e = vpi_scan(expr_itr);
                            if (e) {
                                label = decompileExprLabel(e);
                            }
                            vpi_release_handle(expr_itr);
                        }
                        std::string branch_name = out_signal + "_" + sanitize(label);
                        std::string branch_signal = getOrPromoteExpr(rhs, mod, branch_name);
                        std::string branch_port_name = branch_signal;
                        std::string branch_width = out_width.empty() ? getWidth(rhs) : out_width;
                        if (isLiteralExpr(rhs)) {
                            branch_signal = getLiteralLabel(rhs);
                            branch_port_name = branch_name;
                            std::string literal_width = getDeclaredLiteralWidth(mod, branch_signal);
                            if (!literal_width.empty()) branch_width = literal_width;
                            ensureLiteralNode(rhs, mod, branch_signal, branch_width, a, getAssignmentRhsText(a));
                        }
                        case_inputs.push_back({branch_port_name, label, branch_signal, branch_width});
                    }
                }
            }
        }
    }

    Node n;
    n.id = "mux:" + mod.name + ":" + (out_signal.empty() ? "unnamed" : out_signal) + ":" + sel_name;
    n.kind = "mux";
    n.label = "case " + sel_name;
    n.source = getSourceInfo(always_handle);

    const char* sel_expr = vpi_get_str(vpiDecompile, cond);
    if (sel_expr) n.metadata.expression = sel_expr;

    std::string sel_width = getDeclaredSignalWidth(mod, sel_name);
    if (sel_width.empty()) sel_width = getWidth(cond);
    n.ports.push_back({"sel", "input", sel_name, sel_width});
    for (const auto& input : case_inputs) {
        NodePort np;
        np.name = input.name;
        np.direction = "input";
        np.signal = input.signal;
        np.width = input.width;
        np.label = input.label;
        n.ports.push_back(np);
    }
    if (!out_signal.empty()) n.ports.push_back({"out", "output", out_signal, out_width});

    mod.nodes.push_back(n);
}

std::map<std::string, LoweredValue> DesignExtractor::processLoop(vpiHandle loop_handle, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle process_handle, const std::map<std::string, LoweredValue>& current_drivers) {
    Node n;
    n.id = "loop:" + mod.name + ":" + std::to_string(getLine(loop_handle)) + ":" + nextId();
    n.kind = "loop";
    const char* decompile = vpi_get_str(vpiDecompile, loop_handle);
    n.label = decompile ? decompile : "loop";
    n.source = getSourceInfo(loop_handle);

    std::vector<vpiHandle> input_handles;
    collectIdentifierHandlesRecursive(loop_handle, input_handles);

    std::vector<vpiHandle> assigns;
    findAssignments(loop_handle, assigns);
    std::set<std::string> output_bases;

    for (auto a : assigns) {
        vpiHandle lhs = vpi_handle(vpiLhs, a);
        std::string base = getBaseSignalName(lhs);
        if (!base.empty()) output_bases.insert(base);
    }

    std::map<std::string, LoweredValue> result = current_drivers;

    for (auto h : input_handles) {
        std::string full = getSignalName(h);
        std::string base = getBaseSignalName(h);
        
        // If it's an output of this loop, it's NOT a pure input
        if (output_bases.find(base) != output_bases.end()) continue;

        // Skip if it's NOT a known module-level signal (port or internal net/reg)
        if (mod.internalSignals.find(base) == mod.internalSignals.end()) {
             // Heuristic: if it's hierarchical, it might be an instance port or similar, keep it
             if (base.find('.') == std::string::npos) continue;
        }

        // Resolve procedural driver if any
        std::string actual_signal = base; // Default to base for module port connectivity
        if (current_drivers.count(full)) {
            actual_signal = current_drivers.at(full).signal;
        } else if (current_drivers.count(base)) {
            actual_signal = current_drivers.at(base).signal;
        } else {
             for (const auto& [drv_name, drv_val] : current_drivers) {
                if ((full.size() > drv_name.size() && full.substr(full.size() - drv_name.size()) == drv_name && full[full.size() - drv_name.size() - 1] == '.') ||
                    (base.size() > drv_name.size() && base.substr(base.size() - drv_name.size()) == drv_name && base[base.size() - drv_name.size() - 1] == '.')) {
                    actual_signal = drv_val.signal; break;
                }
            }
        }

        // Avoid duplicate ports
        bool exists = false;
        for (const auto& p : n.ports) if (p.name == full || p.signal == actual_signal) { exists = true; break; }
        if (!exists) {
            n.ports.push_back({full, "input", actual_signal, ""});
        }
    }

    for (const auto& base : output_bases) {
        std::string target_width = getDeclaredSignalWidth(mod, base);
        if (target_width.empty()) {
            for (auto a : assigns) {
                vpiHandle lhs = vpi_handle(vpiLhs, a);
                if (getBaseSignalName(lhs) == base) {
                    target_width = getWidth(lhs);
                    break;
                }
            }
        }

        if (current_drivers.count(base)) {
            LoweredValue prev = current_drivers.at(base);
            n.ports.push_back({base + "_in", "input", prev.signal, prev.width, base});
        } else {
            // Suffix matching for sequential chain
            for (const auto& [drv_name, drv_val] : current_drivers) {
                if (base.size() > drv_name.size() && base.substr(base.size() - drv_name.size()) == drv_name && base[base.size() - drv_name.size() - 1] == '.') {
                    n.ports.push_back({base + "_in", "input", drv_val.signal, drv_val.width, base});
                    break;
                }
            }
        }

        bool final_output = desired_outputs.count(base) > 0;
        std::string output_signal = final_output ? desired_outputs.at(base) : base + "_loop_" + nextId();
        n.ports.push_back({base, "output", output_signal, target_width});
        result[base] = {true, output_signal, target_width};
    }

    mod.nodes.push_back(n);
    return result;
}

vpiHandle DesignExtractor::findFirstCase(vpiHandle stmt) {
    if (!stmt) return nullptr;
    int type = vpi_get(vpiType, stmt);
    if (type == vpiCase) return stmt;

    if (type == vpiBegin || type == vpiNamedBegin || type == vpiFork || type == vpiNamedFork || type == vpiFor || type == vpiWhile || type == vpiRepeat || type == vpiForever) {
        vpiHandle itr = vpi_iterate(vpiStmt, stmt);
        if (itr) {
            while (vpiHandle child = vpi_scan(itr)) {
                vpiHandle found = findFirstCase(child);
                if (found) {
                    vpi_release_handle(itr);
                    return found;
                }
            }
        }
    } else if (type == vpiIf || type == vpiIfElse) {
        vpiHandle found = findFirstCase(vpi_handle(vpiStmt, stmt));
        if (found) return found;
        return findFirstCase(vpi_handle(vpiElseStmt, stmt));
    } else if (type == vpiEventControl) {
        return findFirstCase(vpi_handle(vpiStmt, stmt));
    }

    return nullptr;
}

bool DesignExtractor::containsIf(vpiHandle stmt) {
    if (!stmt) return false;
    int type = vpi_get(vpiType, stmt);
    if (type == vpiIf || type == vpiIfElse || type == vpiCase || type == vpiFor || type == vpiWhile || type == vpiRepeat || type == vpiForever) return true;

    // Check body of loops or event controls
    vpiHandle body = vpi_handle(vpiStmt, stmt);
    if (body && body != stmt && containsIf(body)) return true;
    
    vpiHandle else_body = vpi_handle(vpiElseStmt, stmt);
    if (else_body && else_body != stmt && containsIf(else_body)) return true;

    // Check children of blocks
    vpiHandle itr = vpi_iterate(vpiStmt, stmt);
    if (itr) {
        while (vpiHandle child = vpi_scan(itr)) {
            if (child != stmt && containsIf(child)) {
                vpi_release_handle(itr);
                return true;
            }
        }
    }

    return false;
}

void DesignExtractor::collectAssignmentTargets(vpiHandle stmt, std::set<std::string>& targets) {
    if (!stmt) return;
    std::vector<vpiHandle> assigns;
    findAssignments(stmt, assigns);
    for (auto a : assigns) {
        vpiHandle lhs = vpi_handle(vpiLhs, a);
        if (isConcatOperation(lhs)) {
            collectAggregateTargetNames(lhs, targets);
            continue;
        }
        std::string target = getSignalName(lhs);
        if (!target.empty()) {
            targets.insert(target);
            std::string base = getBaseSignalName(lhs);
            if (!base.empty() && base != target) targets.insert(base);
        }
    }
}

vpiHandle DesignExtractor::unwrapSingleStatement(vpiHandle stmt) {
    while (stmt) {
        int type = vpi_get(vpiType, stmt);
        if (type != vpiBegin && type != vpiNamedBegin && type != vpiFork && type != vpiNamedFork) {
            return stmt;
        }

        vpiHandle itr = vpi_iterate(vpiStmt, stmt);
        if (!itr) return nullptr;
        vpiHandle only = vpi_scan(itr);
        vpiHandle extra = vpi_scan(itr);
        vpi_release_handle(itr);
        if (!only || extra) return nullptr;
        stmt = only;
    }
    return nullptr;
}

void DesignExtractor::collectAggregateTargetOrder(vpiHandle lhs, std::vector<std::string>& targets) {
    if (!lhs) return;
    if (isConcatOperation(lhs)) {
        for (vpiHandle operand : concatOperands(lhs)) {
            collectAggregateTargetOrder(operand, targets);
        }
        return;
    }

    std::string target = getSignalName(lhs);
    if (!target.empty()) targets.push_back(target);
}

bool DesignExtractor::isUniformAggregateIfChain(
    vpiHandle stmt,
    std::vector<std::string>& targets,
    bool& needs_hold
) {
    stmt = unwrapSingleStatement(stmt);
    if (!stmt) return false;
    int type = vpi_get(vpiType, stmt);
    if (type != vpiIf && type != vpiIfElse) return false;

    auto matches_shape = [&](vpiHandle branch) {
        branch = unwrapSingleStatement(branch);
        if (!branch) return false;
        int branch_type = vpi_get(vpiType, branch);
        if (branch_type != vpiAssignment && branch_type != 84 && branch_type != 85) return false;

        vpiHandle lhs = vpi_handle(vpiLhs, branch);
        if (!isConcatOperation(lhs)) return false;
        std::vector<std::string> branch_targets;
        collectAggregateTargetOrder(lhs, branch_targets);
        if (branch_targets.size() < 2) return false;
        std::set<std::string> unique_targets(branch_targets.begin(), branch_targets.end());
        if (unique_targets.size() != branch_targets.size()) return false;

        if (targets.empty()) targets = branch_targets;
        return branch_targets == targets;
    };

    if (!matches_shape(vpi_handle(vpiStmt, stmt))) return false;

    vpiHandle false_stmt = vpi_handle(vpiElseStmt, stmt);
    if (!false_stmt) {
        needs_hold = true;
        return true;
    }

    vpiHandle normalized_false = unwrapSingleStatement(false_stmt);
    if (!normalized_false) return false;
    int false_type = vpi_get(vpiType, normalized_false);
    if (false_type == vpiIf || false_type == vpiIfElse) {
        return isUniformAggregateIfChain(normalized_false, targets, needs_hold);
    }
    return matches_shape(normalized_false);
}

LoweredValue DesignExtractor::composeAggregateHoldValue(
    vpiHandle stmt,
    Module& mod,
    const LoweredAggregate& shape,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    LoweredValue value;
    if (!shape.assigned || shape.lhsSegments.empty()) return value;

    std::string nid = nextId();
    std::string hold_signal = "aggregate_hold_" + nid;
    std::string tag = "aggregate_hold:" + std::to_string(getLine(stmt)) + ":" +
        std::to_string(getCol(stmt)) + ":" + nid;

    Node compose;
    compose.id = sanitizeId("bus:" + mod.name + ":" + tag + ":compose");
    compose.kind = "bus";
    compose.label = "compose";
    compose.source = getSourceInfo(stmt);
    compose.metadata.expression = "[aggregate-compose]";
    compose.metadata.reason = "implicit aggregate hold";
    compose.metadata.isProcedural = true;
    compose.ports.push_back({"out", "output", hold_signal, shape.value.width, "out"});

    int current_bit = shape.lhsSize - 1;
    for (size_t i = 0; i < shape.lhsSegments.size(); ++i) {
        const auto& segment = shape.lhsSegments[i];
        int size = std::max(1, segment.size);
        std::string label = size > 1
            ? "[" + std::to_string(current_bit) + ":" + std::to_string(current_bit - size + 1) + "]"
            : "[" + std::to_string(current_bit) + "]";
        std::string signal = segment.signal;
        auto current = current_drivers.find(segment.signal);
        if (current != current_drivers.end() && current->second.assigned) {
            signal = current->second.signal;
        }
        compose.ports.push_back({"hold" + std::to_string(i), "input", signal, segment.width, label});
        current_bit -= size;
    }
    mod.nodes.push_back(compose);
    return {true, hold_signal, shape.value.width};
}

LoweredValue DesignExtractor::lowerUniformAggregateIfTree(
    vpiHandle stmt,
    Module& mod,
    bool is_clocked,
    const LoweredValue& hold_value,
    const std::map<std::string, LoweredValue>& current_drivers,
    const std::string& aggregate_width,
    bool final_output
) {
    stmt = unwrapSingleStatement(stmt);
    if (!stmt) return {};

    vpiHandle cond = vpi_handle(vpiCondition, stmt);
    vpiHandle true_stmt = unwrapSingleStatement(vpi_handle(vpiStmt, stmt));
    vpiHandle false_stmt = vpi_handle(vpiElseStmt, stmt);

    auto true_aggregate = lowerAggregateValue(true_stmt, mod, is_clocked, current_drivers);
    if (!true_aggregate.assigned) return {};

    LoweredValue false_value = hold_value;
    if (false_stmt) {
        vpiHandle normalized_false = unwrapSingleStatement(false_stmt);
        int false_type = normalized_false ? vpi_get(vpiType, normalized_false) : 0;
        if (false_type == vpiIf || false_type == vpiIfElse) {
            false_value = lowerUniformAggregateIfTree(
                normalized_false, mod, is_clocked, hold_value, current_drivers,
                aggregate_width, false);
        } else {
            auto false_aggregate = lowerAggregateValue(
                normalized_false, mod, is_clocked, current_drivers);
            false_value = false_aggregate.value;
        }
    }
    if (!false_value.assigned) return {};

    std::string sel_signal = getOrPromoteExpr(
        cond, mod, "if_sel_" + nextId(), is_clocked, current_drivers);
    std::string sel_width = getDeclaredSignalWidth(mod, sel_signal);
    if (sel_width.empty()) sel_width = getWidth(cond);

    std::string nid = nextId();
    std::string output_signal = (final_output ? "aggregate_next_" : "aggregate_if_") + nid;
    Node mux;
    mux.id = sanitizeId("mux:" + mod.name + ":aggregate:" + sel_signal + ":" + output_signal);
    mux.kind = "mux";
    mux.label = "if " + sel_signal;
    mux.source = getSourceInfo(stmt);
    const char* sel_expr = vpi_get_str(vpiDecompile, cond);
    if (sel_expr) mux.metadata.expression = sel_expr;
    mux.metadata.isProcedural = true;
    mux.ports.push_back({"sel", "input", sel_signal, sel_width});
    mux.ports.push_back({"true", "input", true_aggregate.value.signal, true_aggregate.value.width, "true"});
    mux.ports.push_back({"false", "input", false_value.signal, false_value.width, "false"});
    mux.ports.push_back({"out", "output", output_signal, aggregate_width});
    mod.nodes.push_back(mux);
    return {true, output_signal, aggregate_width};
}

std::optional<std::map<std::string, LoweredValue>>
DesignExtractor::lowerUniformAggregateIfStatement(
    vpiHandle stmt,
    Module& mod,
    bool is_clocked,
    const std::map<std::string, std::string>& desired_outputs,
    vpiHandle source_handle,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    if (!is_clocked) return std::nullopt;

    std::vector<std::string> targets;
    bool needs_hold = false;
    if (!isUniformAggregateIfChain(stmt, targets, needs_hold)) return std::nullopt;

    vpiHandle root = unwrapSingleStatement(stmt);
    vpiHandle first_assignment = root
        ? unwrapSingleStatement(vpi_handle(vpiStmt, root))
        : nullptr;
    vpiHandle lhs = first_assignment ? vpi_handle(vpiLhs, first_assignment) : nullptr;
    auto lhs_segments = flattenAggregateSegments(
        lhs, mod, true, is_clocked, "aggregate_if_shape", current_drivers);
    if (lhs_segments.size() != targets.size()) return std::nullopt;

    int lhs_size = 0;
    for (const auto& segment : lhs_segments) lhs_size += std::max(1, segment.size);
    if (lhs_size <= 0) return std::nullopt;
    std::string aggregate_width = lhs_size > 1
        ? "[" + std::to_string(lhs_size - 1) + ":0]"
        : "[0:0]";

    std::string nid = nextId();
    LoweredAggregate shape;
    shape.assigned = true;
    shape.value = {true, "", aggregate_width};
    shape.tag = "aggregate_if:" + std::to_string(getLine(stmt)) + ":" +
        std::to_string(getCol(stmt)) + ":" + nid;
    shape.source = getSourceInfo(stmt ? stmt : source_handle);
    shape.lhsSegments = std::move(lhs_segments);
    shape.lhsSize = lhs_size;

    LoweredValue hold_value;
    if (needs_hold) {
        hold_value = composeAggregateHoldValue(stmt, mod, shape, current_drivers);
    }
    LoweredValue mux_value = lowerUniformAggregateIfTree(
        stmt, mod, is_clocked, hold_value, current_drivers, aggregate_width, true);
    if (!mux_value.assigned) return std::nullopt;
    shape.value = mux_value;

    std::map<std::string, std::string> aggregate_outputs = desired_outputs;
    for (const auto& target : targets) {
        if (!aggregate_outputs.count(target)) {
            aggregate_outputs[target] = target + "_branch_" + nextId();
        }
    }
    return lowerAggregateBreakout(
        shape, mod, is_clocked, current_drivers, "", aggregate_outputs);
}

LoweredValue DesignExtractor::lowerAssignment(vpiHandle assign_handle, Module& mod, const std::string& preferred_signal, bool is_clocked, const std::map<std::string, LoweredValue>& current_drivers) {
    LoweredValue value;
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (!lhs || !rhs) return value;

    std::string target = getSignalName(lhs);
    std::string width = getDeclaredSignalWidth(mod, target);
    if (width.empty()) width = getWidth(lhs);
    if (width.empty()) width = getWidth(rhs);

    if (isReplicationOperation(rhs)) {
        std::string signal = promoteReplicationExpr(rhs, mod, preferred_signal.empty() ? target : preferred_signal, is_clocked, current_drivers);
        if (!width.empty()) {
            for (auto& node : mod.nodes) {
                if (node.kind != "replicate") continue;
                for (auto& port : node.ports) {
                    if (port.direction == "output" && port.signal == signal) {
                        port.width = width;
                    }
                }
            }
        }
        value = {true, signal, width};
        return value;
    }

    if (isLiteralExpr(rhs)) {
        std::string literal_label = getLiteralLabel(rhs);
        std::string literal_signal = preferred_signal.empty() ? literal_label : preferred_signal;
        std::string literal_width = getDeclaredLiteralWidth(mod, literal_label);
        if (!literal_width.empty()) width = literal_width;
        ensureLiteralNode(rhs, mod, literal_signal, width, assign_handle, getAssignmentRhsText(assign_handle));
        value = {true, literal_signal, width};
        return value;
    }

    std::string signal = getOrPromoteExpr(rhs, mod, preferred_signal, is_clocked, current_drivers);
    value = {true, signal, width};
    return value;
}

std::map<std::string, LoweredValue> DesignExtractor::lowerStatement(
    vpiHandle stmt,
    Module& mod,
    bool is_clocked,
    const std::map<std::string, std::string>& desired_outputs,
    vpiHandle source_handle,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    std::map<std::string, LoweredValue> result = current_drivers;
    if (!stmt) return result;

    int type = vpi_get(vpiType, stmt);
    if (type == vpiBegin || type == vpiNamedBegin || type == vpiFork || type == vpiNamedFork) {
        vpiHandle itr = vpi_iterate(vpiStmt, stmt);
        std::vector<vpiHandle> children;
        if (itr) {
            while (vpiHandle child = vpi_scan(itr)) children.push_back(child);
            vpi_release_handle(itr);
        }

        for (size_t i = 0; i < children.size(); ++i) {
            vpiHandle child = children[i];
            std::set<std::string> child_targets;
            collectAssignmentTargets(child, child_targets);

            std::map<std::string, std::string> child_desired;
            for (const auto& t : child_targets) {
                bool is_last = true;
                size_t bracket = t.find('[');
                std::string base = (bracket == std::string::npos) ? t : t.substr(0, bracket);

                for (size_t j = i + 1; j < children.size(); ++j) {
                    std::set<std::string> next_targets;
                    collectAssignmentTargets(children[j], next_targets);
                    for (const auto& nt : next_targets) {
                        size_t nbracket = nt.find('[');
                        std::string nbase = (nbracket == std::string::npos) ? nt : nt.substr(0, nbracket);
                        if (nt == t || nbase == base || nt == base || nbase == t) {
                            is_last = false; break;
                        }
                    }
                    if (!is_last) break;
                }

                if (is_last && desired_outputs.count(t)) child_desired[t] = desired_outputs.at(t);
                else if (is_last && desired_outputs.count(base)) child_desired[base] = desired_outputs.at(base);
            }

            auto child_result = lowerStatement(child, mod, is_clocked, child_desired, source_handle, result);
            for (const auto& [target, value] : child_result) {
                result[target] = value;
            }
        }
    } else if (type == vpiIf || type == vpiIfElse) {
        result = lowerIfStatement(stmt, mod, is_clocked, desired_outputs, source_handle, result);
    } else if (type == vpiCase) {
        result = lowerCaseStatement(stmt, mod, is_clocked, desired_outputs, source_handle, result);
    } else if (type == vpiFor || type == vpiRepeat || type == vpiForever || type == vpiWhile) {
        result = processLoop(stmt, mod, is_clocked, desired_outputs, source_handle, result);
    } else if (type == vpiAssignment || type == 84 || type == 85) {
        vpiHandle lhs = vpi_handle(vpiLhs, stmt);
        if (isConcatOperation(lhs)) {
            std::map<std::string, std::string> aggregate_outputs = desired_outputs;
            std::set<std::string> aggregate_targets;
            collectAggregateTargetNames(lhs, aggregate_targets);
            for (const auto& target : aggregate_targets) {
                if (!aggregate_outputs.count(target)) {
                    aggregate_outputs[target] = target + "_branch_" + nextId();
                }
            }
            auto aggregate_values = lowerAggregateAssignment(
                stmt, mod, is_clocked, result, "", aggregate_outputs);
            for (const auto& [target, value] : aggregate_values) result[target] = value;
        } else {
            std::string target = getSignalName(lhs);
            if (!target.empty()) {
                std::string branch_pref = desired_outputs.count(target) ? desired_outputs.at(target) : target + "_branch_" + nextId();
                result[target] = lowerAssignment(stmt, mod, branch_pref, is_clocked, result);
            }
        }
    }
 else if (type == vpiEventControl) {
        result = lowerStatement(vpi_handle(vpiStmt, stmt), mod, is_clocked, desired_outputs, source_handle, result);
    } else {
        std::vector<vpiHandle> assigns;
        findAssignments(stmt, assigns);
        for (vpiHandle assign : assigns) {
            vpiHandle lhs = vpi_handle(vpiLhs, assign);
            if (isConcatOperation(lhs)) {
                std::map<std::string, std::string> aggregate_outputs = desired_outputs;
                std::set<std::string> aggregate_targets;
                collectAggregateTargetNames(lhs, aggregate_targets);
                for (const auto& target : aggregate_targets) {
                    if (!aggregate_outputs.count(target)) {
                        aggregate_outputs[target] = target + "_branch_" + nextId();
                    }
                }
                auto aggregate_values = lowerAggregateAssignment(
                    assign, mod, is_clocked, result, "", aggregate_outputs);
                for (const auto& [target, value] : aggregate_values) result[target] = value;
            } else {
                std::string target = getSignalName(lhs);
                if (!target.empty()) {
                    std::string branch_pref = desired_outputs.count(target) ? desired_outputs.at(target) : target + "_branch_" + nextId();
                    result[target] = lowerAssignment(assign, mod, branch_pref, is_clocked, result);
                }
            }
        }
    }

    return result;
}


std::map<std::string, LoweredValue> DesignExtractor::lowerIfStatement(
    vpiHandle stmt,
    Module& mod,
    bool is_clocked,
    const std::map<std::string, std::string>& desired_outputs,
    vpiHandle source_handle,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    if (auto aggregate_result = lowerUniformAggregateIfStatement(
            stmt, mod, is_clocked, desired_outputs, source_handle, current_drivers)) {
        return *aggregate_result;
    }

    std::map<std::string, LoweredValue> result = current_drivers;
    vpiHandle cond = vpi_handle(vpiCondition, stmt);
    vpiHandle true_stmt = vpi_handle(vpiStmt, stmt);
    vpiHandle false_stmt = vpi_handle(vpiElseStmt, stmt);

    std::set<std::string> targets;
    collectAssignmentTargets(true_stmt, targets);
    collectAssignmentTargets(false_stmt, targets);
    if (targets.empty()) return result;

    std::map<std::string, std::string> true_outputs, false_outputs;
    for (const auto& target : targets) {
        std::string nid = nextId();
        true_outputs[target] = target + "_if_true_" + nid;
        false_outputs[target] = target + "_if_false_" + nid;
    }

    auto tvs = lowerStatement(true_stmt, mod, is_clocked, true_outputs, source_handle, current_drivers);
    auto fvs = lowerStatement(false_stmt, mod, is_clocked, false_outputs, source_handle, current_drivers);

    std::string sel_signal = getOrPromoteExpr(cond, mod, "if_sel_" + nextId(), is_clocked, current_drivers);
    std::string sel_width = getDeclaredSignalWidth(mod, sel_signal);
    if (sel_width.empty()) sel_width = getWidth(cond);

    for (const auto& target : targets) {
        bool has_true = tvs.count(target) && tvs.at(target).assigned;
        bool has_false = fvs.count(target) && fvs.at(target).assigned;

        // Neither branch assigns this target — happens when collectAssignmentTargets adds a base
        // signal (e.g. "storage") alongside an element assignment ("storage[address]"). Emitting
        // a mux whose both branches return the hold value is a no-op; skip it. Still record the
        // desired output name in result so same-base register D-signal inference can find it
        // (needed when a reset clause covers the base array while a write clause covers elements).
        if (!has_true && !has_false) {
            if (desired_outputs.count(target) > 0) {
                result[target] = {true, desired_outputs.at(target), getDeclaredSignalWidth(mod, target)};
            } else if (current_drivers.count(target)) {
                result[target] = current_drivers.at(target);
            }
            continue;
        }

        LoweredValue true_val = has_true ? tvs.at(target) : (current_drivers.count(target) ? current_drivers.at(target) : LoweredValue{true, target, getDeclaredSignalWidth(mod, target)});
        LoweredValue false_val = has_false ? fvs.at(target) : (current_drivers.count(target) ? current_drivers.at(target) : LoweredValue{true, target, getDeclaredSignalWidth(mod, target)});

        std::string target_width = getDeclaredSignalWidth(mod, target);
        if (target_width.empty()) target_width = !true_val.width.empty() ? true_val.width : false_val.width;

        bool missing_branch = !has_true || !has_false;
        bool final_output = desired_outputs.count(target) > 0;
        std::string output_signal;
        if (final_output) {
            output_signal = desired_outputs.at(target);
            if (!is_clocked && missing_branch && !current_drivers.count(target)) output_signal = target + "_latch_d";
        } else {
            output_signal = target + "_if_" + nextId();
        }

        Node mux;
        mux.id = sanitizeId("mux:" + mod.name + ":" + target + ":" + sel_signal + ":" + output_signal);
        mux.kind = "mux";
        mux.label = "if " + sel_signal;
        mux.source = getSourceInfo(stmt);
        const char* sel_expr = vpi_get_str(vpiDecompile, cond);
        if (sel_expr) mux.metadata.expression = sel_expr;
        mux.metadata.isProcedural = true;
        mux.ports.push_back({"sel", "input", sel_signal, sel_width});
        mux.ports.push_back({"true", "input", true_val.signal, true_val.width, "true"});
        mux.ports.push_back({"false", "input", false_val.signal, false_val.width, "false"});
        mux.ports.push_back({"out", "output", output_signal, target_width});
        mod.nodes.push_back(mux);
        propagateStruct(mod, target, output_signal);

        if (!is_clocked && missing_branch && final_output && !current_drivers.count(target)) {
            ensureInferredLatch(mod, target, output_signal, target_width, source_handle ? source_handle : stmt);
            result[target] = {true, target, target_width};
        } else {
            result[target] = {true, output_signal, target_width};
        }
    }

    return result;
}

std::string DesignExtractor::ensureZextNode(Module& mod, const std::string& input_signal, const std::string& input_width, const std::string& output_width, vpiHandle source_handle) {
    for (const auto& n : mod.nodes) {
        if (n.kind != "zext") continue;
        const NodePort* in_port = nullptr;
        const NodePort* out_port = nullptr;
        for (const auto& port : n.ports) {
            if (port.direction == "input") in_port = &port;
            else if (port.direction == "output") out_port = &port;
        }
        if (in_port && out_port && in_port->signal == input_signal && in_port->width == input_width && out_port->width == output_width) {
            return out_port->signal;
        }
    }

    std::string out_signal = input_signal + "_zext_" + nextId();
    std::string node_id = sanitizeId("zext:" + mod.name + ":" + input_signal + ":" + out_signal);

    Node n;
    n.id = node_id;
    n.kind = "zext";
    n.label = "";
    n.source = getSourceInfo(source_handle);
    n.metadata.isProcedural = true;
    n.ports.push_back({"in", "input", input_signal, input_width, "in"});
    n.ports.push_back({out_signal, "output", out_signal, output_width});
    mod.nodes.push_back(n);
    return out_signal;
}

std::map<std::string, LoweredValue> DesignExtractor::lowerCaseStatement(
    vpiHandle stmt,
    Module& mod,
    bool is_clocked,
    const std::map<std::string, std::string>& desired_outputs,
    vpiHandle source_handle,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    std::map<std::string, LoweredValue> result = current_drivers;
    vpiHandle cond = vpi_handle(vpiCondition, stmt);
    if (!cond) return result;

    std::set<std::string> targets;
    vpiHandle item_itr_collect = vpi_iterate(vpiCaseItem, stmt);
    if (!item_itr_collect) return result;

    std::vector<vpiHandle> items;
    bool has_default = false;
    while (vpiHandle item = vpi_scan(item_itr_collect)) {
        items.push_back(item);
        collectAssignmentTargets(vpi_handle(vpiStmt, item), targets);
        vpiHandle expr_itr = vpi_iterate(vpiExpr, item);
        if (!expr_itr) has_default = true;
        else vpi_release_handle(expr_itr);
    }
    vpi_release_handle(item_itr_collect);

    if (targets.empty()) return result;

    std::map<vpiHandle, std::map<std::string, LoweredValue>> item_results;
    std::map<vpiHandle, std::vector<std::string>> item_labels;

    for (vpiHandle item : items) {
        vpiHandle expr_itr = vpi_iterate(vpiExpr, item);
        std::vector<std::string> labels;
        if (expr_itr) {
            while (vpiHandle e = vpi_scan(expr_itr)) {
                labels.push_back(decompileExprLabel(e));
            }
            vpi_release_handle(expr_itr);
        }
        if (labels.empty()) labels.push_back("default");
        item_labels[item] = labels;

        std::string label_ref = labels[0];
        std::map<std::string, std::string> branch_outputs;
        for (const auto& target : targets) {
            // Scope the branch name by the full nesting path (the caller's own desired
            // output for this target), not just this item's own label. Otherwise identical
            // case-item labels in unrelated sibling case statements (e.g. two nested
            // `case`s that both have a `2'b01` item) synthesize the same intermediate
            // signal name and collide - see issue #226.
            std::string path_prefix = desired_outputs.count(target) ? desired_outputs.at(target) : target;
            branch_outputs[target] = path_prefix + "_" + sanitize(label_ref);
        }
        item_results[item] = lowerStatement(vpi_handle(vpiStmt, item), mod, is_clocked, branch_outputs, source_handle, current_drivers);
    }

    std::string sel_pref = "";
    if (!targets.empty()) sel_pref = *targets.begin() + "_sel";
    std::string sel_signal = getOrPromoteExpr(cond, mod, sel_pref, is_clocked, current_drivers);
    std::string sel_width = getDeclaredSignalWidth(mod, sel_signal);
    if (sel_width.empty()) sel_width = getWidth(cond);

    // Output-signal -> natural width, used below to detect branches narrower
    // than the mux's resolved output width. Indexed once up front and
    // refreshed only after ensureZextNode appends a node, instead of
    // rescanning every node/port for every (target, item) pair.
    std::map<std::string, std::string> node_output_widths;
    size_t indexed_node_count = 0;
    auto refreshNodeOutputWidths = [&]() {
        for (; indexed_node_count < mod.nodes.size(); ++indexed_node_count) {
            for (const auto& port : mod.nodes[indexed_node_count].ports) {
                if (port.direction == "output") {
                    node_output_widths[port.signal] = port.width;
                }
            }
        }
    };
    refreshNodeOutputWidths();

    for (const auto& target : targets) {
        std::string target_width = getDeclaredSignalWidth(mod, target);

        // Resolve target_width across all case items up front so that the
        // zext decision below cannot depend on the order items happen to be
        // processed in.
        if (target_width.empty()) {
            for (vpiHandle item : items) {
                auto const& branch_values = item_results[item];
                if (!branch_values.count(target)) continue;
                const std::string& w = branch_values.at(target).width;
                if (!w.empty()) { target_width = w; break; }
            }
        }

        bool final_output = desired_outputs.count(target) > 0;
        std::string output_signal = final_output ? desired_outputs.at(target) : target + "_case_" + nextId();

        Node mux;
        mux.id = sanitizeId("mux:" + mod.name + ":" + target + ":" + sel_signal + ":" + output_signal);
        mux.kind = "mux";
        mux.label = "case " + sel_signal;
        mux.source = getSourceInfo(stmt);
        const char* sel_expr = vpi_get_str(vpiDecompile, cond);
        if (sel_expr) mux.metadata.expression = sel_expr;
        mux.metadata.isProcedural = true;
        mux.ports.push_back({"sel", "input", sel_signal, sel_width});

        for (vpiHandle item : items) {
            auto const& labels = item_labels[item];
            auto const& branch_values = item_results[item];
            LoweredValue branch_val = branch_values.count(target) ? branch_values.at(target) : (current_drivers.count(target) ? current_drivers.at(target) : LoweredValue{true, target, target_width});

            if (branch_val.width.empty()) branch_val.width = target_width;

            // A branch narrower than the mux's resolved output width (e.g. a
            // comparator's 1-bit result feeding a multi-bit ALU-style mux) needs
            // an explicit zero-extension node rather than silently implying a
            // same-width connection. lowerAssignment already coerces branch_val.width
            // to the target's declared width, so look up the branch's actual driving
            // node/signal width to detect a real mismatch.
            auto node_width_it = node_output_widths.find(branch_val.signal);
            std::string branch_natural_width = node_width_it != node_output_widths.end()
                ? node_width_it->second
                : getDeclaredSignalWidth(mod, branch_val.signal);

            // Only act when the branch's natural width is concretely known.
            // An empty width means "unknown" (e.g. an unsized expression) —
            // promoted 1-bit nodes (comparator, logical gate ops) encode
            // their width explicitly as "[0:0]" rather than "", so this
            // check does not need a special case for node outputs.
            bool branch_width_known = !branch_natural_width.empty();
            if (branch_width_known) {
                int branch_bits = std::max(1, bitSizeFromWidth(branch_natural_width));
                int target_bits = std::max(1, bitSizeFromWidth(target_width));
                if (target_bits > branch_bits) {
                    std::string zext_signal = ensureZextNode(mod, branch_val.signal, branch_natural_width, target_width, stmt);
                    refreshNodeOutputWidths();
                    branch_val.signal = zext_signal;
                    branch_val.width = target_width;
                }
            }

            for (const auto& label : labels) {
                mux.ports.push_back({label, "input", branch_val.signal, branch_val.width, label});
            }
        }

        if (!has_default && current_drivers.count(target)) {
             LoweredValue def_val = current_drivers.at(target);
             mux.ports.push_back({"default", "input", def_val.signal, def_val.width, "default"});
             has_default = true;
        }

        if (!is_clocked && !has_default && final_output && !current_drivers.count(target)) {
             output_signal = target + "_latch_d";
        }

        mux.ports.push_back({"out", "output", output_signal, target_width});
        mod.nodes.push_back(mux);
        propagateStruct(mod, target, output_signal);

        if (!is_clocked && !has_default && final_output && !current_drivers.count(target)) {
            ensureInferredLatch(mod, target, output_signal, target_width, source_handle ? source_handle : stmt);
            result[target] = {true, target, target_width};
        } else {
            result[target] = {true, output_signal, target_width};
        }
    }

    return result;
}

void DesignExtractor::ensureInferredLatch(Module& mod, const std::string& target, const std::string& input_signal, const std::string& width, vpiHandle source_handle) {
    std::string latch_id = "latch:" + mod.name + ":" + target;
    for (const auto& node : mod.nodes) {
        if (node.id == latch_id) return;
    }

    Node latch;
    latch.id = latch_id;
    latch.kind = "latch";
    latch.label = target;
    latch.source = getSourceInfo(source_handle);
    latch.metadata.inferred = true;
    latch.metadata.reason = "incomplete combinational assignment";
    latch.ports.push_back({"D", "input", input_signal, width});
    latch.ports.push_back({"Q", "output", target, width});
    mod.nodes.push_back(latch);
}

void DesignExtractor::findAssignments(vpiHandle handle, std::vector<vpiHandle>& assigns) {
    if (!handle) return;
    int type = vpi_get(vpiType, handle);
    if (type == vpiAssignment || type == 84 || type == 85) {
        assigns.push_back(handle);
        return;
    }

    // Common statement/body properties
    for (int prop : {vpiStmt, vpiElseStmt}) {
        vpiHandle h = vpi_handle(prop, handle);
        if (h && h != handle) findAssignments(h, assigns);
    }

    // Iterators for blocks and cases
    for (int iter_type : {vpiStmt, vpiCaseItem}) {
        vpiHandle itr = vpi_iterate(iter_type, handle);
        if (itr) {
            while (vpiHandle s = vpi_scan(itr)) {
                if (s != handle) findAssignments(s, assigns);
            }
            vpi_release_handle(itr);
        }
    }
}

void DesignExtractor::collectIdentifiers(vpiHandle handle, std::vector<std::string>& ids) {
    std::vector<vpiHandle> h; collectIdentifierHandles(handle, h);
    for (auto val : h) ids.push_back(getSignalName(val));
}

void DesignExtractor::collectIdentifiers(vpiHandle handle, std::set<std::string>& ids) {
    std::vector<vpiHandle> h; collectIdentifierHandles(handle, h);
    for (auto val : h) {
        std::string name = getSignalName(val);
        if (!name.empty()) ids.insert(name);
    }
}

void DesignExtractor::collectIdentifierHandlesRecursive(vpiHandle handle, std::vector<vpiHandle>& h) {
    if (!handle) return;
    int type = vpi_get(vpiType, handle);
    
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == 608 || type == 44 || type == vpiBitSelect || type == vpiPartSelect || type == vpiParameter || vpi_get(vpiLocalParam, handle)) {
        h.push_back(handle);
    }

    // Recurse into properties
    for (int prop : {vpiStmt, vpiElseStmt, vpiCondition, vpiRhs, vpiLhs, vpiIndex, vpiLeftRange, vpiRightRange, vpiArgument, vpiForInitStmt, vpiForIncStmt}) {
        vpiHandle p = vpi_handle(prop, handle);
        if (p && p != handle) collectIdentifierHandlesRecursive(p, h);
    }

    // Recurse into iterators
    for (int iter_type : {vpiOperand, vpiStmt, vpiCaseItem, vpiArgument}) {
        vpiHandle itr = vpi_iterate(iter_type, handle);
        if (itr) {
            while (vpiHandle s = vpi_scan(itr)) {
                if (s != handle) collectIdentifierHandlesRecursive(s, h);
            }
            vpi_release_handle(itr);
        }
    }
}

void DesignExtractor::collectIdentifierHandles(vpiHandle handle, std::vector<vpiHandle>& h) {
    if (!handle) return;
    int type = vpi_get(vpiType, handle);
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == 608 || type == 44 || type == vpiParameter || vpi_get(vpiLocalParam, handle)) {
        h.push_back(handle);
    } else if (type == vpiBitSelect || type == vpiPartSelect) {
        h.push_back(handle);
    } else if (type != vpiConstant) {
        vpiHandle operand_itr = vpi_iterate(vpiOperand, handle);
        if (operand_itr) {
            while (vpiHandle op = vpi_scan(operand_itr)) collectIdentifierHandles(op, h);
            vpi_release_handle(operand_itr);
        }
    }
}

bool DesignExtractor::isParameterHandle(vpiHandle handle) {
    if (!handle) return false;
    vpiHandle actual = unwrapRef(handle);
    if (!actual) actual = handle;
    int type = vpi_get(vpiType, actual);
    return type == vpiParameter || vpi_get(vpiLocalParam, actual);
}

std::string DesignExtractor::normalizedParameterName(vpiHandle handle) {
    if (!handle) return "";
    const char* name = vpi_get_str(vpiName, handle);
    if ((!name || strlen(name) == 0) && unwrapRef(handle)) {
        name = vpi_get_str(vpiName, unwrapRef(handle));
    }
    if (!name || strlen(name) == 0) return "";
    std::string s = name;
    if (s.rfind("work@", 0) == 0) s = s.substr(5);
    size_t dot = s.rfind('.');
    if (dot != std::string::npos && dot + 1 < s.size()) s = s.substr(dot + 1);
    return s;
}

SourceInfo DesignExtractor::getParameterDeclarationSource(vpiHandle handle) {
    if (!handle) return {};
    vpiHandle actual = unwrapRef(handle);
    if (actual && actual != handle) {
        SourceInfo src = getSourceInfo(actual);
        if (!src.file.empty() && src.line > 0) return src;
    }
    return getSourceInfo(handle);
}

std::vector<ParameterRef> DesignExtractor::collectParameterRefs(vpiHandle handle, const Module& mod) {
    std::vector<ParameterRef> refs;
    if (!handle) return refs;

    std::vector<vpiHandle> handles;
    collectIdentifierHandlesRecursive(handle, handles);
    std::set<std::string> seen;
    std::set<std::string> module_params;
    for (const auto& param : mod.parameters) module_params.insert(param.name);

    for (vpiHandle h : handles) {
        if (!isParameterHandle(h)) continue;
        std::string name = normalizedParameterName(h);
        if (name.empty()) continue;
        if (!module_params.empty() && module_params.find(name) == module_params.end()) continue;

        SourceInfo usage = getSourceInfo(h);
        std::string key = name + "@" + usage.file + ":" + std::to_string(usage.line) + ":" + std::to_string(usage.col);
        if (seen.count(key)) continue;
        seen.insert(key);

        ParameterRef ref;
        ref.name = name;
        ref.source = usage;
        ref.declarationSource = getParameterDeclarationSource(h);
        refs.push_back(ref);
    }
    return refs;
}
