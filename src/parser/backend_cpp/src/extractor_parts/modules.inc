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
    collectModuleParameters(mod_handle, mod);

    auto fill_parameter_refs_from_width_text = [&](const std::string& text, const SourceInfo& usage, std::vector<ParameterRef>& refs) {
        if (text.empty() || mod.parameters.empty()) return;
        std::set<std::string> existing;
        for (const auto& ref : refs) existing.insert(ref.name);
        for (const auto& param : mod.parameters) {
            if (existing.count(param.name)) continue;
            std::regex name_re(std::string(R"((^|[^A-Za-z0-9_$]))") + param.name + R"(([^A-Za-z0-9_$]|$))");
            if (!std::regex_search(text, name_re)) continue;
            ParameterRef ref;
            ref.name = param.name;
            ref.source = usage;
            ref.declarationSource = param.source;
            refs.push_back(ref);
        }
    };

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
            p.widthExpression = getRangeExpression(low ? low : port_handle);
            if (p.widthExpression.empty() && std::regex_search(p.width, std::regex(R"([A-Za-z_$])"))) {
                p.widthExpression = p.width;
            }
            p.parameterRefs = collectParameterRefs(low ? low : port_handle, mod);
            fill_parameter_refs_from_width_text(p.widthExpression, p.source, p.parameterRefs);
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
                n.metadata.instanceParameters = collectInstanceParameters(inst_handle, mod);
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
                        np.widthExpression = getRangeExpression(low ? low : p_handle);
                        if (np.widthExpression.empty() && std::regex_search(np.width, std::regex(R"([A-Za-z_$])"))) {
                            np.widthExpression = np.width;
                        }
                        np.parameterRefs = collectParameterRefs(low ? low : p_handle, mod);
                        fill_parameter_refs_from_width_text(np.widthExpression, getSourceInfo(low ? low : p_handle), np.parameterRefs);
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

std::string sourceSnippet(const SourceInfo& source);

std::string sourceLineText(const SourceInfo& source) {
    if (source.file.empty() || source.line <= 0) return "";

    std::ifstream file(source.file);
    if (!file.is_open()) return "";

    std::string line;
    int line_no = 1;
    while (std::getline(file, line)) {
        if (line_no == source.line) return line;
        line_no++;
    }
    return "";
}

std::string parameterDefaultFromSourceText(const std::string& text, const std::string& name) {
    if (text.empty() || name.empty()) return "";

    std::regex name_re(std::string(R"((^|[^A-Za-z0-9_$]))") + name + R"(([^A-Za-z0-9_$]|$))");
    std::smatch match;
    std::string remaining = text;
    size_t base = 0;
    while (std::regex_search(remaining, match, name_re)) {
        size_t name_start = base + static_cast<size_t>(match.position()) + match[1].str().size();
        size_t name_end = name_start + name.size();
        size_t equals = text.find('=', name_end);
        if (equals == std::string::npos) return "";

        std::string between = text.substr(name_end, equals - name_end);
        if (between.find(';') != std::string::npos || between.find(')') != std::string::npos) {
            base = name_end;
            remaining = text.substr(base);
            continue;
        }

        size_t value_start = equals + 1;
        int paren_depth = 0;
        size_t value_end = text.size();
        for (size_t i = value_start; i < text.size(); ++i) {
            char ch = text[i];
            if (ch == '(') {
                paren_depth++;
            } else if (ch == ')') {
                if (paren_depth == 0) {
                    value_end = i;
                    break;
                }
                paren_depth--;
            } else if ((ch == ',' || ch == ';') && paren_depth == 0) {
                value_end = i;
                break;
            }
        }
        return trimCopy(text.substr(value_start, value_end - value_start));
    }

    return "";
}

void DesignExtractor::collectModuleParameters(vpiHandle module_handle, Module& mod) {
    std::set<std::string> seen;
    std::string module_text = sourceSnippet(getSourceInfo(module_handle));

    for (int iter_type : {vpiParameter}) {
        vpiHandle param_itr = vpi_iterate(iter_type, module_handle);
        if (!param_itr) continue;

        while (vpiHandle param_handle = vpi_scan(param_itr)) {
            const char* raw_name = vpi_get_str(vpiName, param_handle);
            if (!raw_name || strlen(raw_name) == 0) continue;

            std::string name = raw_name;
            if (name.rfind("work@", 0) == 0) name = name.substr(5);
            size_t dot = name.rfind('.');
            if (dot != std::string::npos && dot + 1 < name.size()) name = name.substr(dot + 1);
            if (name.empty() || seen.count(name)) continue;
            seen.insert(name);

            ParameterDecl decl;
            decl.name = name;
            decl.kind = vpi_get(vpiLocalParam, param_handle) ? "localparam" : "parameter";
            decl.width = getWidth(param_handle);
            if (decl.width.empty()) decl.width = getRangeExpression(param_handle);
            decl.source = getSourceInfo(param_handle);

            vpiHandle expr = vpi_handle(vpiExpr, param_handle);
            if (!expr) expr = vpi_handle(vpiRhs, param_handle);
            if (expr) {
                decl.defaultValue = getExprText(expr);
                decl.valueSource = getSourceInfo(expr);
            }
            if (decl.defaultValue.empty()) {
                const char* value = vpi_get_str(vpiDecompile, param_handle);
                if (value && strlen(value) > 0) decl.defaultValue = value;
            }
            if (decl.defaultValue.empty()) {
                decl.defaultValue = parameterDefaultFromSourceText(sourceLineText(decl.source), decl.name);
            }
            if (decl.defaultValue.empty()) {
                decl.defaultValue = parameterDefaultFromSourceText(module_text, decl.name);
            }

            mod.parameters.push_back(decl);
        }
        vpi_release_handle(param_itr);
    }
}

std::string sourceSnippet(const SourceInfo& source) {
    if (source.file.empty() || source.line <= 0) return "";

    std::ifstream file(source.file);
    if (!file.is_open()) return "";

    std::stringstream buffer;
    std::string line;
    int line_no = 1;
    while (std::getline(file, line)) {
        if (line_no >= source.line && (source.endLine <= 0 || line_no <= source.endLine)) {
            if (line_no == source.line && source.col > 0) {
                size_t start_col = static_cast<size_t>(std::max(0, source.col - 1));
                if (start_col < line.size()) line = line.substr(start_col);
            }
            if (line_no == source.endLine && source.endCol > 0) {
                size_t end_col = static_cast<size_t>(std::max(0, source.endCol - 1));
                if (end_col < line.size()) line = line.substr(0, end_col);
            }
            if (buffer.tellp() > 0) buffer << "\n";
            buffer << line;
        }
        if (source.endLine > 0 && line_no >= source.endLine) break;
        line_no++;
    }

    std::string text = buffer.str();
    size_t semicolon = text.find(';');
    if (semicolon != std::string::npos) text = text.substr(0, semicolon + 1);
    return text;
}

size_t findMatchingParen(const std::string& text, size_t open_pos) {
    if (open_pos == std::string::npos || open_pos >= text.size() || text[open_pos] != '(') return std::string::npos;
    int depth = 0;
    for (size_t i = open_pos; i < text.size(); ++i) {
        if (text[i] == '(') {
            depth++;
        } else if (text[i] == ')') {
            depth--;
            if (depth == 0) return i;
        }
    }
    return std::string::npos;
}

std::map<std::string, std::string> explicitInstanceParameterOverrides(const std::string& instance_text) {
    std::map<std::string, std::string> overrides;
    size_t hash = instance_text.find('#');
    if (hash == std::string::npos) return overrides;

    size_t open = instance_text.find('(', hash);
    size_t close = findMatchingParen(instance_text, open);
    if (open == std::string::npos || close == std::string::npos || close <= open) return overrides;

    std::string params_text = instance_text.substr(open + 1, close - open - 1);
    size_t cursor = 0;
    while (cursor < params_text.size()) {
        size_t dot = params_text.find('.', cursor);
        if (dot == std::string::npos) break;

        size_t name_start = dot + 1;
        while (name_start < params_text.size() && std::isspace(static_cast<unsigned char>(params_text[name_start]))) name_start++;
        size_t name_end = name_start;
        while (name_end < params_text.size()) {
            unsigned char ch = static_cast<unsigned char>(params_text[name_end]);
            if (!std::isalnum(ch) && params_text[name_end] != '_' && params_text[name_end] != '$') break;
            name_end++;
        }

        std::string name = params_text.substr(name_start, name_end - name_start);
        size_t value_open = params_text.find('(', name_end);
        if (name.empty() || value_open == std::string::npos) {
            cursor = name_end + 1;
            continue;
        }

        size_t value_close = findMatchingParen(params_text, value_open);
        if (value_close == std::string::npos) break;

        overrides[name] = trimCopy(params_text.substr(value_open + 1, value_close - value_open - 1));
        cursor = value_close + 1;
    }

    return overrides;
}

std::vector<InstanceParameter> DesignExtractor::collectInstanceParameters(vpiHandle inst_handle, const Module& mod) {
    std::vector<InstanceParameter> parameters;
    if (!inst_handle) return parameters;

    SourceInfo instance_source = getSourceInfo(inst_handle);
    std::map<std::string, std::string> explicit_overrides = explicitInstanceParameterOverrides(sourceSnippet(instance_source));

    vpiHandle param_itr = vpi_iterate(40, inst_handle); // vpiParamAssign
    if (param_itr) {
        std::set<std::string> seen;
        while (vpiHandle assign = vpi_scan(param_itr)) {
            vpiHandle lhs = vpi_handle(vpiLhs, assign);
            vpiHandle rhs = vpi_handle(vpiRhs, assign);
            if (lhs && vpi_get(vpiLocalParam, lhs)) continue;
            std::string name = normalizedParameterName(lhs);
            if (name.empty() || seen.count(name)) continue;
            seen.insert(name);

            InstanceParameter param;
            param.name = name;
            param.value = getExprText(rhs);
            auto explicit_it = explicit_overrides.find(name);
            if (explicit_it != explicit_overrides.end() && !explicit_it->second.empty()) {
                param.value = explicit_it->second;
                param.isOverride = true;
            }
            if (param.value.empty()) param.value = getExprText(assign);
            param.source = getSourceInfo(lhs ? lhs : assign);
            param.valueSource = getSourceInfo(rhs ? rhs : assign);
            param.parameterRefs = collectParameterRefs(rhs, mod);
            if (explicit_it != explicit_overrides.end() && !explicit_it->second.empty()) {
                std::set<std::string> existing_refs;
                for (const auto& ref : param.parameterRefs) existing_refs.insert(ref.name);
                for (const auto& decl : mod.parameters) {
                    if (existing_refs.count(decl.name)) continue;
                    std::regex name_re(std::string(R"((^|[^A-Za-z0-9_$]))") + decl.name + R"(([^A-Za-z0-9_$]|$))");
                    if (!std::regex_search(param.value, name_re)) continue;
                    ParameterRef ref;
                    ref.name = decl.name;
                    ref.source = instance_source;
                    ref.declarationSource = decl.source;
                    param.parameterRefs.push_back(ref);
                }
            }
            parameters.push_back(param);
        }
        vpi_release_handle(param_itr);
    }

    return parameters;
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
