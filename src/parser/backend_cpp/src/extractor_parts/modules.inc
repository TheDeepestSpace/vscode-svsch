void DesignExtractor::processModule(vpiHandle mod_handle) {
    const char* def_name = vpi_get_str(vpiDefName, mod_handle);
    const char* full_name = vpi_get_str(vpiFullName, mod_handle);
    std::string mod_name = def_name ? def_name : (full_name ? full_name : "unnamed");
    if (mod_name.rfind("work@", 0) == 0) mod_name = mod_name.substr(5);

    for (const auto& m : modules_) if (m.name == mod_name) return;
    if (processing_modules_.find(mod_name) != processing_modules_.end()) return;
    processing_modules_.insert(mod_name);

    Module mod;
    mod.name = mod_name;
    mod.source = getSourceInfo(mod_handle);

    // Ports
    vpiHandle port_itr = vpi_iterate(vpiPort, mod_handle);
    if (port_itr) {
        while (vpiHandle port_handle = vpi_scan(port_itr)) {
            Port p;
            const char* pn = vpi_get_str(vpiName, port_handle);
            p.name = pn ? pn : "unnamed";
            p.source = getSourceInfo(port_handle);
            
            vpiHandle low = vpi_handle(vpiLowConn, port_handle);
            p.source = getSourceInfo(low ? low : port_handle);
            p.width = getWidth(low ? low : port_handle);
            p.typeName = getTypeName(low ? low : port_handle);
            if (!p.typeName.empty()) p.typeSource = getTypeSource(low ? low : port_handle);
            int dir = vpi_get(vpiDirection, port_handle);
            p.direction = (dir == vpiInput) ? "input" : (dir == vpiOutput ? "output" : (dir == vpiInout ? "inout" : "unknown"));
            collectStructSignal(port_handle, p.name, mod, p.source);
            if (mod.structSignals.find(p.name) == mod.structSignals.end()) {
                collectStructSignal(low ? low : port_handle, p.name, mod, p.source);
            }
            auto struct_it = mod.structSignals.find(p.name);
            if (struct_it != mod.structSignals.end() && struct_it->second.type.packed && !struct_it->second.type.width.empty()) {
                p.width = struct_it->second.type.width;
            }
            mod.ports.push_back(p);
            mod.internalSignals.insert(p.name);
        }
    }
    collectInterfacePortsFromSource(mod);
    processModuleInterfaces(mod_handle, mod);

    for (int var_type : {vpiNet, vpiReg, vpiVariables, vpiStructVar, vpiStructNet, vpiIODecl}) {
        vpiHandle var_itr = vpi_iterate(var_type, mod_handle);
        if (var_itr) {
            while (vpiHandle var_handle = vpi_scan(var_itr)) {
                std::string name = getSignalName(var_handle);
                if (!name.empty()) {
                    mod.internalSignals.insert(name);
                    collectStructSignal(var_handle, name, mod, getSourceInfo(var_handle));
                }
            }
        }
    }

    // Assignments
    vpiHandle assign_itr = vpi_iterate(vpiContAssign, mod_handle);
    if (assign_itr) {
        while (vpiHandle assign_handle = vpi_scan(assign_itr)) {
            processAssign(assign_handle, mod);
        }
    }

    // Processes
    vpiHandle process_itr = vpi_iterate(vpiProcess, mod_handle);
    if (process_itr) {
        while (vpiHandle process_handle = vpi_scan(process_itr)) {
            processProcess(process_handle, mod);
        }
    }

    synthesizePendingStructCompositions(mod);

    // Generate blocks
    for (int type : {vpiGenStmt, 2154, 5013, 5014, 5015, 5016}) { // GenStmt, GenRegion, GenIf, GenIfElse, GenFor, GenCase
        vpiHandle gen_itr = vpi_iterate(type, mod_handle);
        if (gen_itr) {
            while (vpiHandle gen_handle = vpi_scan(gen_itr)) {
                 Node n;
                 n.id = "unknown:" + mod.name + ":generate:" + std::to_string(getLine(gen_handle));
                 n.kind = "unknown";
                 n.label = "generate";
                 n.source = getSourceInfo(gen_handle);
                 mod.nodes.push_back(n);
            }
        }
    }

    // Submodules (Instances)
    for (int it_type : {32, 33}) {
        vpiHandle inst_itr = vpi_iterate(it_type, mod_handle);
        if (inst_itr) {
            while (vpiHandle inst_handle = vpi_scan(inst_itr)) {
                const char* i_name = vpi_get_str(vpiName, inst_handle);
                const char* d_name = vpi_get_str(vpiDefName, inst_handle);
                std::string label = i_name ? i_name : (d_name ? d_name : "instance");

                if (mod.interfaceSignals.count(label)) continue;

                Node n;
                n.id = "instance:" + mod.name + ":" + label;
                n.kind = "instance";
                n.label = label;
                if (d_name) {
                    std::string dn = d_name;
                    if (dn.rfind("work@", 0) == 0) dn = dn.substr(5);
                    n.instanceOf = dn;
                    n.moduleName = dn;
                }
                n.source = getSourceInfo(inst_handle);
                if (vpi_get(vpiType, inst_handle) == vpiModule && !n.instanceOf.empty()) {
                    processModule(inst_handle);
                }

                vpiHandle inst_port_itr = vpi_iterate(vpiPort, inst_handle);
                if (inst_port_itr) {
                    while (vpiHandle p_handle = vpi_scan(inst_port_itr)) {
                        NodePort np;
                        const char* pn = vpi_get_str(vpiName, p_handle);
                        np.name = pn ? pn : "unnamed";
                        int dir = vpi_get(vpiDirection, p_handle);
                        np.direction = (dir == vpiInput) ? "input" : (dir == vpiOutput ? "output" : (dir == vpiInout ? "inout" : "unknown"));
                        vpiHandle high = vpi_handle(vpiHighConn, p_handle);
                        vpiHandle low = vpi_handle(vpiLowConn, p_handle);
                        np.signal = getSignalName(high);
                        np.width = getWidth(low);
                        if (np.width.empty()) np.width = getWidth(p_handle);
                        if (auto field = getStructFieldRef(high, mod)) {
                            const std::string field_signal = field->first + "." + field->second;
                            if (np.direction == "input") {
                                np.signal = ensureStructBreakout(mod, field->first, field->second, getSourceInfo(high));
                            } else if (np.direction == "output") {
                                np.signal = field_signal;
                                ensureStructFieldCompositionInput(mod, field->first, field->second, field_signal, getSourceInfo(high));
                            }
                            np.width = fieldWidth(mod.structSignals[field->first].type, field->second);
                        }
                        np.typeName = getTypeName(low);
                        if (np.typeName.empty()) np.typeName = getTypeName(p_handle);
                        if (auto iface = interfacePortInfoForModule(n.moduleName, np.name)) {
                            np.typeName = iface->typeName;
                            np.modportName = iface->modportName;
                            auto type_it = interfaceTypes_.find(np.typeName);
                            if (type_it != interfaceTypes_.end()) {
                                np.typeSource = type_it->second.source;
                                if (!np.modportName.empty()) {
                                    auto mp_it = type_it->second.modports.find(np.modportName);
                                    if (mp_it != type_it->second.modports.end()) {
                                        np.modportSource = mp_it->second.source;
                                        np.preferredSide = mp_it->second.preferredSide;
                                        if (np.preferredSide == "left") {
                                            np.direction = "output";
                                        } else if (np.preferredSide == "right") {
                                            np.direction = "input";
                                        }
                                    }
                                }
                            }
                        }
                        if (!np.typeName.empty()) {
                            if (np.typeSource.file.empty()) np.typeSource = getTypeSource(low);
                            if (np.typeSource.file.empty()) np.typeSource = getTypeSource(p_handle);
                        }
                        n.ports.push_back(np);
                    }
                }
                mod.nodes.push_back(n);
            }
        }
    }
    synthesizeInterfaceHarnesses(mod);
    modules_.push_back(mod);
    processing_modules_.erase(mod_name);
}

void DesignExtractor::processAssign(vpiHandle assign_handle, Module& mod, bool is_procedural) {
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (!lhs) return;

    if (isConcatOperation(lhs)) {
        lowerAggregateAssignment(assign_handle, mod, is_procedural);
        return;
    }

    std::string out_signal = getSignalName(lhs);
    std::string out_base = getBaseSignalName(lhs);

    auto interfaceFieldRef = [&](const std::string& signal) -> std::optional<std::pair<std::string, std::string>> {
        size_t dot = signal.find('.');
        if (dot == std::string::npos || signal.find('[') != std::string::npos) return std::nullopt;
        std::string base = signal.substr(0, dot);
        std::string field = signal.substr(dot + 1);
        if (base.empty() || field.empty()) return std::nullopt;
        if (!mod.interfaceSignals.count(base)) return std::nullopt;
        return std::make_pair(base, field);
    };

    std::string rhs_signal = getSignalName(rhs);
    auto lhs_interface_field = interfaceFieldRef(out_signal);
    auto rhs_interface_field = interfaceFieldRef(rhs_signal);
    if (lhs_interface_field && rhs_interface_field && lhs_interface_field->first == rhs_interface_field->first) {
        const std::string node_id = "interface_modport:" + mod.name + ":" + lhs_interface_field->first;
        Edge e;
        e.source = node_id;
        e.sourcePort = rhs_interface_field->second;
        e.target = node_id;
        e.targetPort = lhs_interface_field->second;
        e.signal = rhs_signal;
        e.width = getWidth(rhs);
        e.sourceInfo = getSourceInfo(assign_handle);
        mod.edges.push_back(e);
        return;
    }

    collectStructSignal(lhs, out_base.empty() ? out_signal : out_base, mod, getSourceInfo(lhs));
    collectStructSignal(rhs, getBaseSignalName(rhs), mod, getSourceInfo(rhs));

    auto lhs_field = getStructFieldRef(lhs, mod);
    auto rhs_field = getStructFieldRef(rhs, mod);
    if (lhs_field && !out_signal.empty()) {
        std::string input_signal;
        if (rhs_field) {
            input_signal = ensureStructBreakout(mod, rhs_field->first, rhs_field->second, getSourceInfo(rhs));
        } else if (isLiteralExpr(rhs)) {
            input_signal = getLiteralLabel(rhs);
            ensureLiteralNode(rhs, mod, input_signal, fieldWidth(mod.structSignals[lhs_field->first].type, lhs_field->second), assign_handle, getAssignmentRhsText(assign_handle));
        } else {
            input_signal = getOrPromoteExpr(rhs, mod, out_signal + "_src", is_procedural);
        }

        ensureStructFieldCompositionInput(mod, lhs_field->first, lhs_field->second, input_signal, getSourceInfo(lhs));
        return;
    }

    if (rhs_field && !out_signal.empty()) {
        const std::string field_signal = rhs_field->first + "." + rhs_field->second;
        bool target_is_module_port = false;
        for (const auto& port : mod.ports) {
            if (port.name == out_signal) {
                target_is_module_port = true;
                break;
            }
        }

        if (target_is_module_port) {
            const std::string struct_port = ensureStructBreakout(mod, rhs_field->first, rhs_field->second, getSourceInfo(rhs));
            Edge e;
            e.source = "struct:" + mod.name + ":" + rhs_field->first;
            e.sourcePort = struct_port;
            e.target = "self";
            e.targetPort = out_signal;
            e.signal = field_signal;
            e.width = fieldWidth(mod.structSignals[rhs_field->first].type, rhs_field->second);
            e.sourceInfo = getSourceInfo(rhs);
            mod.edges.push_back(e);
        } else {
            ensureStructBreakoutAlias(mod, rhs_field->first, rhs_field->second, out_signal, getSourceInfo(rhs));
        }
        return;
    }

    if (mod.structSignals.find(out_base) != mod.structSignals.end()) {
        if (lhs_field) {
            collectStructSignal(lhs, lhs_field->first, mod, getSourceInfo(lhs));
        }
    }

    if (mod.structSignals.find(getSignalName(rhs)) != mod.structSignals.end() && !out_signal.empty()) {
        mod.pendingStructAssigns.push_back({out_signal, getSignalName(rhs), getSourceInfo(assign_handle)});
        return;
    }

    std::string rhs_text = getAssignmentRhsText(assign_handle);
    std::smatch text_rep_match;
    if (isLiteralExpr(rhs) && std::regex_match(rhs_text, text_rep_match, std::regex(R"(^\{\s*([A-Za-z_$][\w$]*|\d+)\s*\{\s*([^{}]+?)\s*\}\s*\}$)"))) {
        std::string count_text = text_rep_match[1].str();
        std::string body_text = trimCopy(text_rep_match[2].str());
        int repeat_count = 0;
        try {
            repeat_count = std::stoi(count_text);
        } catch (...) {
            SourceInfo src = getSourceInfo(assign_handle);
            std::ifstream file(src.file);
            if (file.is_open()) {
                std::stringstream buffer;
                buffer << file.rdbuf();
                std::string source_text = buffer.str();
                std::regex param_re(std::string(R"(\b(?:localparam|parameter)\b[^;=]*\b)") + count_text + R"(\b\s*=\s*(\d+))");
                std::smatch param_match;
                if (std::regex_search(source_text, param_match, param_re)) {
                    repeat_count = std::stoi(param_match[1].str());
                }
            }
        }

        if (repeat_count > 0) {
            std::string lhs_width = getWidth(lhs);
            std::string declared_lhs_width = getDeclaredSignalWidth(mod, out_base);
            if (bitSizeFromWidth(declared_lhs_width) > bitSizeFromWidth(lhs_width)) {
                lhs_width = declared_lhs_width;
            }

            ensureLiteralNode(rhs, mod, body_text, "[0:0]", assign_handle, body_text);

            bool symbolic_count = std::regex_match(count_text, std::regex(R"([A-Za-z_$][\w$]*)"));
            std::string repeat_label = symbolic_count ? "x " + count_text : "x" + std::to_string(repeat_count);
            std::string id_label = symbolic_count ? count_text : std::to_string(repeat_count);

            Node n;
            n.id = sanitizeId("replicate:" + mod.name + ":" + out_base + (is_procedural ? ":" + nextId() : "") + ":x" + id_label);
            n.kind = "replicate";
            n.label = repeat_label;
            n.source = getSourceInfo(assign_handle);
            if (!rhs_text.empty() && !n.source.file.empty() && n.source.line > 0) {
                std::ifstream source_file(n.source.file);
                std::string source_line;
                for (int line_no = 1; std::getline(source_file, source_line); ++line_no) {
                    if (line_no != n.source.line) continue;
                    size_t rhs_pos = source_line.find(rhs_text);
                    if (rhs_pos != std::string::npos) {
                        n.source.col = static_cast<int>(rhs_pos);
                        n.source.endLine = n.source.line;
                        n.source.endCol = static_cast<int>(rhs_pos + rhs_text.size());
                    }
                    break;
                }
            }
            n.metadata.expression = rhs_text;
            n.metadata.repeatCount = repeat_count;
            n.metadata.repeatExpression = count_text;
            n.metadata.isProcedural = is_procedural;
            n.ports.push_back({"in", "input", body_text, "[0:0]", "in"});
            n.ports.push_back({out_signal, "output", out_signal, lhs_width, out_signal});
            mod.nodes.push_back(n);
            return;
        }
    }

    // Check if RHS is a simple expression that doesn't need promotion.
    int rhs_type = vpi_get(vpiType, rhs);
    bool is_constant = isLiteralExpr(rhs);
    bool is_simple_rhs = (rhs_type == vpiNet || rhs_type == vpiReg || rhs_type == vpiPort || rhs_type == 608 || is_constant || rhs_type == vpiBitSelect || rhs_type == vpiPartSelect);
    std::string in_signal = getOrPromoteExpr(rhs, mod, out_base + (is_procedural ? "_next" : ""), is_procedural);
    if (isReplicationOperation(rhs)) {
        std::string lhs_width = getWidth(lhs);
        std::string declared_lhs_width = getDeclaredSignalWidth(mod, out_base);
        if (bitSizeFromWidth(declared_lhs_width) > bitSizeFromWidth(lhs_width)) {
            lhs_width = declared_lhs_width;
        }
        if (!lhs_width.empty()) {
            for (auto& node : mod.nodes) {
                if (node.kind != "replicate") continue;
                for (auto& port : node.ports) {
                    if (port.direction == "output" && port.signal == in_signal) {
                        port.width = lhs_width;
                    }
                }
            }
        }
    }

    if (in_signal != out_signal && !in_signal.empty()) {
        if (!is_simple_rhs) {
            bool already_driven = false;
            if (!is_procedural) {
                for (const auto& n : mod.nodes) {
                    for (const auto& p : n.ports) {
                        if (p.direction == "output" && p.signal == out_signal) {
                            already_driven = true; break;
                        }
                    }
                    if (already_driven) break;
                }
            }

            if (!already_driven) {
                Node n;
                n.id = "comb:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":comb";
                n.kind = "comb";
                n.label = "";
                n.source = getSourceInfo(assign_handle);
                n.metadata.expression = in_signal; // This is the promoted signal name
                n.metadata.isProcedural = is_procedural;
                n.ports.push_back({out_signal, "output", out_signal, getWidth(lhs)});
                n.ports.push_back({in_signal, "input", in_signal, getWidth(rhs)});
                mod.nodes.push_back(n);
            }
        } else if (is_constant) {
            ensureLiteralNode(rhs, mod, out_signal, getWidth(lhs), assign_handle, getAssignmentRhsText(assign_handle));
        } else {
            bool already_driven = false;
            if (!is_procedural) {
                for (const auto& n : mod.nodes) {
                    for (const auto& p : n.ports) {
                        if (p.direction == "output" && p.signal == out_signal) {
                            already_driven = true; break;
                        }
                    }
                    if (already_driven) break;
                }
            }

            if (!already_driven) {
                Node n;
                n.id = "comb:" + mod.name + ":" + out_signal + (is_procedural ? ":" + nextId() : "") + ":alias";
                n.kind = "comb";
                n.label = "";
                n.source = getSourceInfo(assign_handle);
                n.metadata.expression = "[alias]";
                n.metadata.isProcedural = is_procedural;
                n.ports.push_back({out_signal, "output", out_signal, getWidth(lhs)});
                
                std::string in_name = in_signal;
                std::string in_label = "";
                size_t bracket = in_signal.find('[');
                if (bracket != std::string::npos) {
                    in_name = in_signal.substr(0, bracket);
                    in_label = in_signal.substr(bracket);
                }
                n.ports.push_back({in_name, "input", in_signal, getWidth(rhs), in_label});
                mod.nodes.push_back(n);
            }
        }
    }
}
