void DesignExtractor::processProcess(vpiHandle process_handle, Module& mod) {
    int type = vpi_get(vpiType, process_handle);
    vpiHandle stmt = vpi_handle(vpiStmt, process_handle);

    if (type == vpiAlways) {
        int always_type = vpi_get(vpiAlwaysType, process_handle);

        if (always_type == 3) { // always_ff
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
        processAssign(stmt, mod, true);
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

    std::vector<vpiHandle> aggregate_assignments;
    std::map<std::string, std::vector<vpiHandle>> reg_assigns;
    for (vpiHandle a : assignments) {
        vpiHandle lhs = vpi_handle(vpiLhs, a);
        if (lhs) {
            if (isConcatOperation(lhs)) {
                aggregate_assignments.push_back(a);
                continue;
            }
            std::string sig_name = getSignalName(lhs);
            reg_assigns[sig_name].push_back(a);
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
                    break;
                }
            }
        }
    }

    std::map<std::string, LoweredValue> lowered_values;
    if (!is_reset_condition && containsIf(stmt) && !findFirstCase(stmt)) {
        std::set<std::string> targets;
        collectAssignmentTargets(stmt, targets);
        std::map<std::string, std::string> desired_outputs;
        for (const auto& target : targets) desired_outputs[target] = target + "_next";
        lowered_values = lowerStatement(stmt, mod, true, desired_outputs, always_handle);
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

    for (auto const& [reg_name, reg_assigns_vec] : reg_assigns) {
        vpiHandle lhs_first = vpi_handle(vpiLhs, reg_assigns_vec[0]);
        std::string reg_base = getBaseSignalName(lhs_first);

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
        std::string reg_width = getDeclaredSignalWidth(mod, reg_base);
        if (reg_width.empty()) reg_width = getWidth(lhs_first);
        auto lhs_field = getStructFieldRef(lhs_first, mod);
        if (lhs_field) {
            std::string fw = fieldWidth(mod.structSignals[lhs_field->first].type, lhs_field->second);
            if (!fw.empty()) reg_width = fw;
        }

        vpiHandle data_rhs = nullptr;
        vpiHandle reset_rhs = nullptr;
        vpiHandle reset_assign_handle = nullptr;

        if (is_reset_condition && reset_branch_stmt) {
            for (vpiHandle ra : reg_assigns_vec) {
                if (isAncestor(reset_branch_stmt, ra)) {
                    reset_rhs = vpi_handle(vpiRhs, ra);
                    reset_assign_handle = ra;
                    break;
                }
            }
        }

        std::vector<std::string> literal_inputs;
        for (vpiHandle a : reg_assigns_vec) {
            if (reset_assign_handle && isSameObject(a, reset_assign_handle)) continue;
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
            if (isLiteralExpr(reset_rhs)) {
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


        mod.nodes.push_back(n);
    }
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
                                const char* d = vpi_get_str(vpiDecompile, e);
                                if (d) label = d; else label = getSignalName(e);
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
        std::string target = getSignalName(lhs);
        if (!target.empty()) {
            std::string branch_pref = desired_outputs.count(target) ? desired_outputs.at(target) : target + "_branch_" + nextId();
            result[target] = lowerAssignment(stmt, mod, branch_pref, is_clocked, result);
        }
    } else if (type == vpiEventControl) {
        result = lowerStatement(vpi_handle(vpiStmt, stmt), mod, is_clocked, desired_outputs, source_handle, result);
    } else {
        std::vector<vpiHandle> assigns;
        findAssignments(stmt, assigns);
        for (vpiHandle assign : assigns) {
            vpiHandle lhs = vpi_handle(vpiLhs, assign);
            std::string target = getSignalName(lhs);
            if (!target.empty()) {
                std::string branch_pref = desired_outputs.count(target) ? desired_outputs.at(target) : target + "_branch_" + nextId();
                result[target] = lowerAssignment(assign, mod, branch_pref, is_clocked, result);
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
        true_outputs[target] = target + "_if_true";
        false_outputs[target] = target + "_if_false";
    }

    auto tvs = lowerStatement(true_stmt, mod, is_clocked, true_outputs, source_handle, current_drivers);
    auto fvs = lowerStatement(false_stmt, mod, is_clocked, false_outputs, source_handle, current_drivers);

    std::string sel_signal = getOrPromoteExpr(cond, mod, "if_sel_" + nextId(), is_clocked);
    std::string sel_width = getDeclaredSignalWidth(mod, sel_signal);
    if (sel_width.empty()) sel_width = getWidth(cond);

    for (const auto& target : targets) {
        bool has_true = tvs.count(target) && tvs.at(target).assigned;
        bool has_false = fvs.count(target) && fvs.at(target).assigned;
        
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
        mux.id = sanitizeId("mux:" + mod.name + ":" + target + ":" + sel_signal);
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

        if (!is_clocked && missing_branch && final_output && !current_drivers.count(target)) {
            ensureInferredLatch(mod, target, output_signal, target_width, source_handle ? source_handle : stmt);
            result[target] = {true, target, target_width};
        } else {
            result[target] = {true, output_signal, target_width};
        }
    }

    return result;
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
    std::map<vpiHandle, std::string> item_labels;

    for (vpiHandle item : items) {
        vpiHandle expr_itr = vpi_iterate(vpiExpr, item);
        std::string label = "default";
        if (expr_itr) {
            vpiHandle e = vpi_scan(expr_itr);
            if (e) {
                const char* d = vpi_get_str(vpiDecompile, e);
                if (d) label = d; else label = getSignalName(e);
            }
            vpi_release_handle(expr_itr);
        }
        item_labels[item] = label;

        std::map<std::string, std::string> branch_outputs;
        for (const auto& target : targets) branch_outputs[target] = target + "_" + sanitize(label);
        item_results[item] = lowerStatement(vpi_handle(vpiStmt, item), mod, is_clocked, branch_outputs, source_handle, current_drivers);
    }

    std::string sel_pref = "";
    if (!targets.empty()) sel_pref = *targets.begin() + "_sel";
    std::string sel_signal = getOrPromoteExpr(cond, mod, sel_pref, is_clocked);
    std::string sel_width = getDeclaredSignalWidth(mod, sel_signal);
    if (sel_width.empty()) sel_width = getWidth(cond);

    for (const auto& target : targets) {
        std::string target_width = getDeclaredSignalWidth(mod, target);
        
        Node mux;
        mux.id = sanitizeId("mux:" + mod.name + ":" + target + ":" + sel_signal);
        mux.kind = "mux";
        mux.label = "case " + sel_signal;
        mux.source = getSourceInfo(stmt);
        const char* sel_expr = vpi_get_str(vpiDecompile, cond);
        if (sel_expr) mux.metadata.expression = sel_expr;
        mux.metadata.isProcedural = true;
        mux.ports.push_back({"sel", "input", sel_signal, sel_width});

        for (vpiHandle item : items) {
            std::string label = item_labels[item];
            auto const& branch_values = item_results[item];
            LoweredValue branch_val = branch_values.count(target) ? branch_values.at(target) : (current_drivers.count(target) ? current_drivers.at(target) : LoweredValue{true, target, target_width});
            
            if (target_width.empty() && !branch_val.width.empty()) target_width = branch_val.width;
            if (branch_val.width.empty()) branch_val.width = target_width;

            mux.ports.push_back({label, "input", branch_val.signal, branch_val.width, label});
        }

        if (!has_default && current_drivers.count(target)) {
             LoweredValue def_val = current_drivers.at(target);
             mux.ports.push_back({"default", "input", def_val.signal, def_val.width, "default"});
             has_default = true;
        }

        bool final_output = desired_outputs.count(target) > 0;
        std::string output_signal = final_output ? desired_outputs.at(target) : target + "_case_" + nextId();
        
        if (!is_clocked && !has_default && final_output && !current_drivers.count(target)) {
             output_signal = target + "_latch_d";
        }

        mux.ports.push_back({"out", "output", output_signal, target_width});
        mod.nodes.push_back(mux);

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
