namespace {
bool isBusSelectExprType(int vpi_type) {
    return vpi_type == vpiBitSelect || vpi_type == vpiPartSelect || vpi_type == 606 || vpi_type == 607 || vpi_type == 130;
}
}  // namespace

void DesignExtractor::processModule(vpiHandle mod_handle) {
    const char* def_name = vpi_get_str(vpiDefName, mod_handle);
    const char* full_name = vpi_get_str(vpiFullName, mod_handle);
    std::string mod_name = def_name ? def_name : (full_name ? full_name : "unnamed");
    if (mod_name.rfind("work@", 0) == 0) mod_name = mod_name.substr(5);

    for (auto& m : modules_) {
        if (m.name == mod_name) {
            if (m.generateRegions.empty()) {
                processGenerateRegions(mod_handle, m);
            }
            return;
        }
    }
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
            // lowConn (ref_obj) doesn't carry typespec range info; fall back to
            // the port handle directly where the UHDM object API surfaces it.
            if ((p.width.empty() || p.width == "[0:0]") && low) {
                std::string ts_w = getWidth(port_handle);
                if (!ts_w.empty() && ts_w != "[0:0]") p.width = ts_w;
            }
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
            ensureDeclaredArray(mod, p.name);
            auto array_it = mod.arrayDimensions.find(p.name);
            if (array_it != mod.arrayDimensions.end()) {
                p.arrayDimension = array_it->second;
                p.arraySize = mod.arraySizes[p.name];
            }
            mod.ports.push_back(p);
            mod.internalSignals.insert(p.name);
            if (!mod.declarationOrder.count(p.name)) {
                mod.declarationOrder[p.name] = static_cast<int>(mod.declarationOrder.size());
            }
        }
    }
    // Build enum member → typedef name/source/width map for literal node enrichment.
    {
        vpiHandle ti = vpi_iterate(vpiTypedef, mod_handle);
        if (ti) {
            while (vpiHandle td = vpi_scan(ti)) {
                const char* nm = vpi_get_str(vpiName, td);
                if (!nm || strlen(nm) == 0) continue;
                std::string type_name = nm;
                if (type_name.rfind("work@", 0) == 0) type_name = type_name.substr(5);
                SourceInfo type_src = getSourceInfo(td);
                std::string enum_width = getWidth(td);
                vpiHandle mi2 = vpi_iterate(vpiEnumConst, td);
                if (!mi2) continue;
                while (vpiHandle ec = vpi_scan(mi2)) {
                    const char* mnm = vpi_get_str(vpiName, ec);
                    if (!mnm) continue;
                    std::string member = mnm;
                    if (member.rfind("work@", 0) == 0) member = member.substr(5);
                    mod.enumMemberTypes[member] = {type_name, type_src, enum_width};
                }
            }
        }
    }

    collectInterfacePortsFromSource(mod);
    processModuleInterfaces(mod_handle, mod);
    collectTaskFunctions(mod_handle, mod.name);

    for (int var_type : {vpiNet, vpiReg, vpiVariables, vpiStructVar, vpiStructNet, vpiIODecl}) {
        vpiHandle var_itr = vpi_iterate(var_type, mod_handle);
        if (var_itr) {
            while (vpiHandle var_handle = vpi_scan(var_itr)) {
                std::string name = getSignalName(var_handle);
                if (!name.empty()) {
                    mod.internalSignals.insert(name);
                    if (!mod.declarationOrder.count(name)) {
                        mod.declarationOrder[name] = static_cast<int>(mod.declarationOrder.size());
                    }
                    collectStructSignal(var_handle, name, mod, getSourceInfo(var_handle));
                }
            }
        }
    }

    // Scan array-typed variables for unpacked dimensions.
    // logic arrays come in as vpiVariables in Surelog UHDM; reg arrays use vpiRegArray.
    // We check for an unpacked range on any variable to detect arrays.
    // Helper: record array dimensions from a variable handle.
    // For dedicated array types (vpiRegArray, vpiArrayVar), take first range as unpacked extent.
    // For general variables (vpiVariables), require 2+ ranges (packed + unpacked) and take last.
    auto recordArrayDim = [&](vpiHandle arr_handle, bool requires_two_ranges) {
        const char* arr_name_c = vpi_get_str(vpiName, arr_handle);
        if (!arr_name_c || strlen(arr_name_c) == 0) return;
        std::string arr_name = arr_name_c;
        if (mod.arrayDimensions.count(arr_name)) return; // already found

        vpiHandle range_itr = vpi_iterate(vpiRange, arr_handle);
        if (!range_itr) return;
        int lft_first = vpiUndefined, rgt_first = vpiUndefined;
        int lft_last = vpiUndefined, rgt_last = vpiUndefined;
        int range_count = 0;
        while (vpiHandle r = vpi_scan(range_itr)) {
            // The int properties only carry literal bounds; a parameterized extent like
            // [0:(1<<ADDR_WIDTH)-1] reports 0/0 there even though Surelog has elaborated
            // it — the resolved constants live behind the expression handles.
            int l = vpiUndefined, ri = vpiUndefined;
            vpiHandle l_h = vpi_handle(vpiLeftRange, r);
            vpiHandle r_h = vpi_handle(vpiRightRange, r);
            if (l_h && r_h) {
                l = getConstantInt(l_h);
                ri = getConstantInt(r_h);
            } else {
                l = vpi_get(vpiLeftRange, r);
                ri = vpi_get(vpiRightRange, r);
            }
            if (l != vpiUndefined && ri != vpiUndefined) {
                if (range_count == 0) { lft_first = l; rgt_first = ri; }
                lft_last = l; rgt_last = ri;
            }
            range_count++;
        }
        if (requires_two_ranges) {
            // For vpiVariables: need packed + unpacked → use last range as unpacked extent
            if (range_count >= 2 && lft_last != vpiUndefined) {
                mod.arrayDimensions[arr_name] = "[" + std::to_string(lft_last) + ":" + std::to_string(rgt_last) + "]";
                mod.arraySizes[arr_name] = std::abs(lft_last - rgt_last) + 1;
                mod.internalSignals.insert(arr_name);
            }
        } else {
            // For dedicated array types: first range is the unpacked extent
            if (range_count >= 1 && lft_first != vpiUndefined) {
                mod.arrayDimensions[arr_name] = "[" + std::to_string(lft_first) + ":" + std::to_string(rgt_first) + "]";
                mod.arraySizes[arr_name] = std::abs(lft_first - rgt_first) + 1;
                mod.internalSignals.insert(arr_name);
            }
        }
    };

    for (int arr_type : {vpiRegArray, 3010 /* vpiArrayVar */, vpiVariables}) {
        vpiHandle arr_itr = vpi_iterate(arr_type, mod_handle);
        if (!arr_itr) continue;
        bool need_two = (arr_type == vpiVariables);
        while (vpiHandle arr_handle = vpi_scan(arr_itr)) {
            // Surelog surfaces array vars through the generic vpiVariables iterator too
            // (the dedicated 3010 iteration can come back empty); an array-var handle
            // carries only its unpacked range, so the packed+unpacked requirement would
            // wrongly skip it.
            bool is_array_var = vpi_get(vpiType, arr_handle) == 3010 /* vpiArrayVar */;
            recordArrayDim(arr_handle, need_two && !is_array_var);
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

    // Generate block regions. The source-side UHDM generate tree carries all if/case
    // arms, including inactive arms, so expose it separately from the active schematic.
    processGenerateRegions(mod_handle, mod);

    // Multi-instance instantiation (SV LRM 23.2 implicit instance arrays):
    // `leaf u_leaf [MSB:LSB] (...)`. UHDM elaborates this into N flat vpiModule siblings
    // (u_leaf[0], u_leaf[1], ...) *and* a dedicated vpiModuleArray container sitting
    // alongside them on the parent scope, holding the declared vpiRange plus vpiModule
    // children pointing at those same N elaborated objects. Collapse each array container
    // into a single stacked "instance" node here (mirroring recordArrayDim's pattern for
    // reg/wire arrays above) instead of letting the flat loop below emit N separate nodes
    // and re-walk the submodule body N times. Verified against a real compiled fixture:
    // uhdm-dump / direct vpi_iterate(112 /* vpiModuleArray */, ...) both show this shape.
    std::set<std::string> instance_array_bases;

    // vpi_get(vpiLeftRange/vpiRightRange) on a vpiModuleArray's range does not resolve
    // through UHDM's constant-expr wrapper the way it does for vpiRegArray/vpiArrayVar
    // (empirically returns 0/0), so read the bound expression's decompiled text instead.
    auto rangeBoundText = [&](vpiHandle range_handle, int prop) -> std::string {
        vpiHandle bound = vpi_handle(prop, range_handle);
        if (!bound) return "";
        const char* dec = vpi_get_str(vpiDecompile, bound);
        return dec ? dec : "";
    };

    // Per port, gather the connected signal name for every array element so we can tell
    // whether the actual is broadcast to all elements or connects element-wise to a
    // matching-size unpacked array (SV LRM 23.2 port-connection rule).
    auto portHighConnSignal = [&](vpiHandle inst, const std::string& port_name) -> std::string {
        vpiHandle p_itr = vpi_iterate(vpiPort, inst);
        if (!p_itr) return "";
        while (vpiHandle p = vpi_scan(p_itr)) {
            const char* pn = vpi_get_str(vpiName, p);
            if (pn && port_name == pn) {
                vpiHandle high = vpi_handle(vpiHighConn, p);
                std::string sig = getSignalName(high);
                vpi_release_handle(p_itr);
                return sig;
            }
        }
        return "";
    };

    // Shared port-enrichment logic for both the collapsed array-instance loop below and
    // the flat submodule loop further down: width fallbacks, widthExpression/parameterRefs,
    // literal/bus-select synthesis, struct-field breakout, and interface/modport resolution.
    auto buildInstancePort = [&](vpiHandle p_handle, const std::string& module_name, bool skip_breakout_synthesis = false) -> NodePort {
        NodePort np;
        const char* pn = vpi_get_str(vpiName, p_handle);
        np.name = pn ? pn : "unnamed";
        int dir = vpi_get(vpiDirection, p_handle);
        np.direction = (dir == vpiInput) ? "input" : (dir == vpiOutput ? "output" : (dir == vpiInout ? "inout" : "unknown"));
        vpiHandle high = vpi_handle(vpiHighConn, p_handle);
        vpiHandle low = vpi_handle(vpiLowConn, p_handle);
        np.signal = getSignalName(high);
        np.width = getWidth(low);
        if (np.width.empty() || np.width == "[0:0]") {
            std::string w = getWidth(p_handle);
            if (!w.empty() && w != "[0:0]") np.width = w;
        }
        if (np.width.empty() || np.width == "[0:0]") {
            std::string w = getDeclaredSignalWidth(mod, np.signal.empty() ? np.name : np.signal);
            if (!w.empty()) np.width = w;
        }
        if (np.width.empty()) np.width = "[0:0]";

        np.widthExpression = getRangeExpression(low ? low : p_handle);
        if (np.widthExpression.empty() && std::regex_search(np.width, std::regex(R"([A-Za-z_$])"))) {
            np.widthExpression = np.width;
        }
        np.parameterRefs = collectParameterRefs(low ? low : p_handle, mod);
        fill_parameter_refs_from_width_text(np.widthExpression, getSourceInfo(low ? low : p_handle), np.parameterRefs);

        if (high && !skip_breakout_synthesis && (np.direction == "input" || np.direction == "inout")) {
            // A bit-select/literal used directly in the port list (e.g. `.opcode(instr[7:4])`,
            // `.b(8'd1)`) has no other driver in the design producing that exact signal string,
            // so buildEdges would never find a source for it. Synthesize the same breakout/literal
            // node processAssign already synthesizes for the equivalent `assign` RHS.
            if (isLiteralExpr(high)) {
                ensureLiteralNode(high, mod, np.signal, np.width, high, np.signal);
            } else {
                int high_type = vpi_get(vpiType, high);
                if (isBusSelectExprType(high_type)) {
                    processBusSelect(high, mod);
                }
            }
        }
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
        if (auto iface = interfacePortInfoForModule(module_name, np.name)) {
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
        return np;
    };

    {
        vpiHandle arr_itr = vpi_iterate(vpiModuleArray, mod_handle);
        if (arr_itr) {
            while (vpiHandle arr_handle = vpi_scan(arr_itr)) {
                const char* base_name_c = vpi_get_str(vpiName, arr_handle);
                if (!base_name_c || strlen(base_name_c) == 0) continue;
                std::string label = base_name_c;
                if (mod.interfaceSignals.count(label)) continue;

                std::vector<vpiHandle> elements;
                vpiHandle elem_itr = vpi_iterate(vpiModule, arr_handle);
                if (elem_itr) {
                    while (vpiHandle e = vpi_scan(elem_itr)) elements.push_back(e);
                }
                if (elements.empty()) continue;

                instance_array_bases.insert(label);
                vpiHandle rep = elements.front();
                const char* d_name = vpi_get_str(vpiDefName, rep);

                std::string dim_str;
                int array_size = static_cast<int>(elements.size());
                vpiHandle range_itr = vpi_iterate(vpiRange, arr_handle);
                if (range_itr) {
                    if (vpiHandle r = vpi_scan(range_itr)) {
                        std::string lft = rangeBoundText(r, vpiLeftRange);
                        std::string rgt = rangeBoundText(r, vpiRightRange);
                        if (!lft.empty() && !rgt.empty()) {
                            dim_str = "[" + lft + ":" + rgt + "]";
                            try {
                                array_size = std::abs(std::stoi(lft) - std::stoi(rgt)) + 1;
                            } catch (...) {}
                        }
                        vpi_release_handle(range_itr);
                    }
                }

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
                n.source = getSourceInfo(arr_handle);
                n.metadata.instanceParameters = collectInstanceParameters(rep, mod);
                n.metadata.isArrayNode = true;
                n.metadata.arraySize = array_size;
                if (!dim_str.empty()) n.metadata.arrayDimension = dim_str;

                // Elaborate the submodule body once, from a single representative element,
                // instead of once per array element.
                if (vpi_get(vpiType, rep) == vpiModule && !n.instanceOf.empty()) {
                    processModule(rep);
                }

                vpiHandle rep_port_itr = vpi_iterate(vpiPort, rep);
                if (rep_port_itr) {
                    while (vpiHandle p_handle = vpi_scan(rep_port_itr)) {
                        const char* pn = vpi_get_str(vpiName, p_handle);
                        std::string port_name = pn ? pn : "unnamed";
                        std::string raw_signal = getSignalName(vpi_handle(vpiHighConn, p_handle));

                        // SV LRM 23.2: a port connection expression is evaluated once and
                        // broadcast to every element, UNLESS the actual is itself an unpacked
                        // array of matching size, in which case elaboration connects
                        // element-wise (element i <-> actual[i]). Compare the connected signal
                        // across every elaborated element to tell which case applies. This must
                        // run before buildInstancePort: when the representative's connection is
                        // itself an indexed select (e.g. `a_arr[0]`), buildInstancePort would
                        // otherwise synthesize a bus-breakout tap for that one element, which
                        // ends up with no consumer once the port is repointed at the array base.
                        bool all_same = true;
                        std::string common_base;
                        bool matches_index_pattern = !raw_signal.empty();
                        for (vpiHandle elem : elements) {
                            std::string sig = (elem == rep) ? raw_signal : portHighConnSignal(elem, port_name);
                            if (sig != raw_signal) all_same = false;
                            size_t br = sig.find('[');
                            if (br == std::string::npos || sig.empty() || sig.back() != ']') {
                                matches_index_pattern = false;
                                continue;
                            }
                            std::string b = sig.substr(0, br);
                            if (common_base.empty()) common_base = b;
                            else if (common_base != b) matches_index_pattern = false;
                        }
                        auto array_size_it = mod.arraySizes.find(common_base);
                        bool is_elementwise_array = !all_same && matches_index_pattern && !common_base.empty()
                            && mod.arrayDimensions.count(common_base)
                            && array_size_it != mod.arraySizes.end()
                            && array_size_it->second == static_cast<int>(elements.size());

                        NodePort np = buildInstancePort(p_handle, n.moduleName, is_elementwise_array);

                        if (is_elementwise_array) {
                            // Element-wise connection to a matching-size unpacked array: point
                            // the port at the array's base name so it participates in the same
                            // stacked-edge machinery already used for array reg/mux nodes.
                            np.signal = common_base;
                            std::string element_width = getDeclaredSignalWidth(mod, common_base);
                            if (!element_width.empty()) np.width = element_width;
                        }
                        // Otherwise (all_same, i.e. broadcast — or a shape we don't recognize):
                        // keep the representative element's own connection as-is.

                        n.ports.push_back(np);
                    }
                }
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

                // Already collapsed into a single stacked node above.
                size_t array_bracket = label.find('[');
                if (array_bracket != std::string::npos && instance_array_bases.count(label.substr(0, array_bracket))) {
                    continue;
                }

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
                        n.ports.push_back(buildInstancePort(p_handle, n.moduleName));
                    }
                }
                mod.nodes.push_back(n);
            }
        }
    }
    synthesizeInterfaceHarnesses(mod);

    // Synthesize array read nodes
    std::set<std::string> array_read_signals;
    for (const auto& n : mod.nodes) {
        for (const auto& p : n.ports) {
            if (p.direction == "input") {
                size_t bracket = p.signal.find('[');
                if (bracket != std::string::npos) {
                    std::string base = p.signal.substr(0, bracket);
                    if (mod.arrayDimensions.count(base)) {
                        array_read_signals.insert(p.signal);
                    }
                }
            }
        }
    }

    for (const auto& sig : array_read_signals) {
        // Skip internal lowering artifacts like 'storage[address]_next': a real array-read
        // expression ends with ']', anything after that is a suffix added by lowering passes.
        if (sig.empty() || sig.back() != ']') continue;

        size_t bracket = sig.find('[');
        std::string base = sig.substr(0, bracket);
        std::string index = sig.substr(bracket + 1);
        if (!index.empty() && index.back() == ']') index.pop_back();

        auto plus_colon = index.find("+:");
        if (plus_colon != std::string::npos) index = index.substr(0, plus_colon);

        bool is_constant = !index.empty() && std::all_of(index.begin(), index.end(), [](char c){ return std::isdigit((unsigned char)c) || c == ':' || c == '-'; });
        if (!is_constant && !index.empty() && index != "?" && index != "idx" && index != "bit") {
            // processAssign lowers a continuous `out = base[index]` to this same mux id;
            // don't emit a second copy of it here.
            std::string read_mux_id = sanitizeId("mux:" + mod.name + ":" + base + "_read_" + index);
            bool already_lowered = false;
            for (const auto& n : mod.nodes) {
                if (n.id == read_mux_id) { already_lowered = true; break; }
            }
            if (already_lowered) continue;

            Node read_mux;
            read_mux.id = read_mux_id;
            read_mux.kind = "mux";
            read_mux.label = "read";
            // Read mux is NOT stacked: it consumes the stacked array input but outputs a scalar.
            NodePort read_mux_in{"in", "input", base, mod.arrayDimensions[base], "in"};
            read_mux_in.isArrayNode = true;
            read_mux_in.arrayDimension = mod.arrayDimensions[base];
            read_mux_in.arraySize = mod.arraySizes.count(base) ? mod.arraySizes[base] : 0;
            read_mux.ports.push_back(read_mux_in);
            std::string index_width = getDeclaredSignalWidth(mod, index);
            int index_bits = bitSizeFromWidth(index_width);
            std::string sel_label = index_bits > 1 ? "s[]" : "s";
            read_mux.ports.push_back({"sel", "input", index, index_width, sel_label});
            read_mux.ports.push_back({"out", "output", sig, ""});
            mod.nodes.push_back(read_mux);
        }
    }

    // Synthesize a source node for a declared memory that is read (its base
    // name feeds an array-typed "in" port above) but never itself driven —
    // e.g. a continuous read `assign instr = mem[addr];` from a
    // declaration-only `logic mem [0:N-1];` with no procedural write.
    // Without this, buildEdges finds no producer for the array's base name
    // and the read mux's "in" port is left silently dangling.
    {
        std::set<std::string> driven_array_bases;
        for (const auto& n : mod.nodes) {
            for (const auto& p : n.ports) {
                if (p.direction != "output" && p.direction != "inout") continue;
                if (mod.arrayDimensions.count(p.signal)) driven_array_bases.insert(p.signal);
            }
        }
        for (const auto& p : mod.ports) {
            if ((p.direction == "input" || p.direction == "inout") && mod.arrayDimensions.count(p.name)) {
                driven_array_bases.insert(p.name);
            }
        }
        for (const auto& alias : mod.pendingArrayAliases) {
            driven_array_bases.insert(alias.targetSignal);
        }

        // Collect one representative (source, width) per undriven array base first —
        // pushing new nodes while iterating mod.nodes would invalidate this loop.
        std::map<std::string, std::pair<SourceInfo, std::string>> undriven_bases;
        for (const auto& n : mod.nodes) {
            for (const auto& p : n.ports) {
                if (p.direction != "input" || !p.isArrayNode) continue;
                const std::string& base = p.signal;
                if (base.empty() || !mod.arrayDimensions.count(base)) continue;
                if (driven_array_bases.count(base)) continue;
                undriven_bases.emplace(base, std::make_pair(n.source, p.width));
            }
        }

        for (const auto& [base, source_and_width] : undriven_bases) {
            std::string mem_node_id = "reg:" + mod.name + ":" + base;
            bool exists = false;
            for (const auto& existing : mod.nodes) {
                if (existing.id == mem_node_id) { exists = true; break; }
            }
            if (exists) continue;

            Node mem_node;
            mem_node.id = mem_node_id;
            mem_node.kind = "register";
            mem_node.label = base;
            mem_node.source = source_and_width.first;
            mem_node.metadata.isArrayNode = true;
            mem_node.metadata.arrayDimension = mod.arrayDimensions[base];
            mem_node.metadata.arraySize = mod.arraySizes.count(base) ? mod.arraySizes[base] : 0;
            mem_node.metadata.inferred = true;
            mem_node.metadata.reason = "'" + base + "' is declared but never written — its "
                "contents are undriven/uninitialized";
            std::string elem_width = source_and_width.second;
            if (elem_width.empty()) elem_width = getDeclaredSignalWidth(mod, base);
            mem_node.ports.push_back({"Q", "output", base, elem_width});
            mod.nodes.push_back(mem_node);
        }
    }

    modules_.push_back(mod);
    processing_modules_.erase(mod_name);
}


std::string DesignExtractor::sourceLineText(const SourceInfo& source) const {
    if (source.file.empty() || source.line <= 0) return "";

    std::ifstream file = openSourceFile(source.file);
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

std::string DesignExtractor::sourceSnippet(const SourceInfo& source) const {
    if (source.file.empty() || source.line <= 0) return "";

    std::ifstream file = openSourceFile(source.file);
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

std::vector<std::string> splitArrayInitializerElements(const std::string& rhs_text) {
    std::vector<std::string> elements;
    std::string text = trimCopy(rhs_text);
    if (text.empty()) return elements;

    size_t open = text.find('{');
    if (open == std::string::npos) return elements;
    for (size_t i = 0; i < open; ++i) {
        if (!std::isspace(static_cast<unsigned char>(text[i])) && text[i] != '\'') {
            return elements;
        }
    }

    size_t close = std::string::npos;
    int brace_depth = 0;
    bool in_string = false;
    for (size_t i = open; i < text.size(); ++i) {
        char ch = text[i];
        if (ch == '"' && (i == 0 || text[i - 1] != '\\')) in_string = !in_string;
        if (in_string) continue;
        if (ch == '{') {
            brace_depth++;
        } else if (ch == '}') {
            brace_depth--;
            if (brace_depth == 0) {
                close = i;
                break;
            }
        }
    }
    if (close == std::string::npos || close <= open) return elements;

    std::string body = text.substr(open + 1, close - open - 1);
    int nested_braces = 0;
    int nested_parens = 0;
    int nested_brackets = 0;
    in_string = false;
    size_t start = 0;
    for (size_t i = 0; i <= body.size(); ++i) {
        char ch = i < body.size() ? body[i] : ',';
        if (i < body.size() && ch == '"' && (i == 0 || body[i - 1] != '\\')) in_string = !in_string;
        if (!in_string && i < body.size()) {
            if (ch == '{') nested_braces++;
            else if (ch == '}' && nested_braces > 0) nested_braces--;
            else if (ch == '(') nested_parens++;
            else if (ch == ')' && nested_parens > 0) nested_parens--;
            else if (ch == '[') nested_brackets++;
            else if (ch == ']' && nested_brackets > 0) nested_brackets--;
        }

        if ((i == body.size() || ch == ',') && !in_string && nested_braces == 0 && nested_parens == 0 && nested_brackets == 0) {
            std::string element = trimCopy(body.substr(start, i - start));
            if (!element.empty()) elements.push_back(element);
            start = i + 1;
        }
    }

    return elements;
}

std::optional<int> parseArrayIndexFromSignal(const std::string& signal, const std::string& base) {
    if (signal.size() <= base.size() + 2) return std::nullopt;
    if (signal.rfind(base + "[", 0) != 0 || signal.back() != ']') return std::nullopt;

    std::string index = trimCopy(signal.substr(base.size() + 1, signal.size() - base.size() - 2));
    if (index.empty()) return std::nullopt;
    size_t start = (index[0] == '-' || index[0] == '+') ? 1 : 0;
    if (start >= index.size()) return std::nullopt;
    if (!std::all_of(index.begin() + static_cast<std::ptrdiff_t>(start), index.end(), [](char c) {
        return std::isdigit(static_cast<unsigned char>(c));
    })) {
        return std::nullopt;
    }

    try {
        return std::stoi(index);
    } catch (...) {
        return std::nullopt;
    }
}

int topArrayIndexForLabels(const Module& mod, const std::string& base, int fallback_size) {
    auto dim_it = mod.arrayDimensions.find(base);
    if (dim_it == mod.arrayDimensions.end()) return std::max(0, fallback_size - 1);

    std::smatch match;
    if (std::regex_search(dim_it->second, match, std::regex(R"(\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\])"))) {
        int left = std::stoi(match[1].str());
        int right = std::stoi(match[2].str());
        return std::max(left, right);
    }
    return std::max(0, fallback_size - 1);
}

bool isLiteralTextValue(const std::string& text) {
    std::string value = trimCopy(text);
    return std::regex_match(value, std::regex(R"((?:\d+\s*)?'[sS]?[A-Za-z][A-Za-z0-9_xXzZ?]*|\d+)"));
}

bool isSimpleTextSignal(const std::string& text) {
    return std::regex_match(trimCopy(text), std::regex(R"([A-Za-z_$][A-Za-z0-9_$]*(?:\[[^\]]+\])?(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)"));
}

std::string literalTextWidth(const std::string& text) {
    std::smatch match;
    if (std::regex_search(text, match, std::regex(R"(^\s*(\d+)\s*')"))) {
        int bits = std::stoi(match[1].str());
        return bits > 1 ? "[" + std::to_string(bits - 1) + ":0]" : "[0:0]";
    }
    return "";
}

std::string DesignExtractor::declaredArrayElementWidthFromSource(const Module& mod, const std::string& signal) const {
    if (signal.empty()) return "";

    std::string source_file = mod.source.file;
    if (source_file.empty()) {
        for (const auto& port : mod.ports) {
            if (!port.source.file.empty()) {
                source_file = port.source.file;
                break;
            }
        }
    }
    if (source_file.empty()) return "";

    std::ifstream file = openSourceFile(source_file);
    if (!file.is_open()) return "";
    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string text = buffer.str();

    std::string escaped_signal;
    for (char c : signal) {
        if (std::string(R"(\.^$|()[]{}*+?)").find(c) != std::string::npos) escaped_signal.push_back('\\');
        escaped_signal.push_back(c);
    }

    std::regex array_decl_re(
        std::string(R"((?:^|[;,\(\n])\s*(?:(?:input|output|inout)\s+)?(?:logic|wire|reg)\s+(\[[^\]]+\])\s+[^;\)]*\b)")
        + escaped_signal
        + R"(\b\s*\[[^\]]+\])"
    );
    std::smatch match;
    if (std::regex_search(text, match, array_decl_re)) return match[1].str();
    return "";
}

std::string ensureTextLiteralNode(Module& mod, const std::string& literal, const std::string& width, SourceInfo source) {
    if (literal.empty()) return "";
    for (auto& n : mod.nodes) {
        if (n.kind != "literal" || n.label != literal) continue;
        for (const auto& port : n.ports) {
            if (port.direction == "output" && port.signal == literal) return literal;
        }
        n.ports.push_back({literal, "output", literal, width, "", source});
        return literal;
    }

    Node n;
    n.id = sanitizeId("literal:" + mod.name + ":" + literal + ":" + literal);
    n.kind = "literal";
    n.label = literal;
    n.source = source;
    n.ports.push_back({literal, "output", literal, width, "", source});
    mod.nodes.push_back(n);
    return literal;
}

std::string ensureTextExpressionNode(Module& mod, const std::string& base, int index, const std::string& expression, const std::string& width, SourceInfo source, bool is_procedural) {
    std::string output = sanitizeId(base + "_elem_" + std::to_string(index));
    std::string node_id = sanitizeId("comb:" + mod.name + ":" + output + (is_procedural ? ":proc" : "") + ":array_expr");
    for (const auto& n : mod.nodes) {
        if (n.id == node_id) return output;
    }

    Node n;
    n.id = node_id;
    n.kind = "comb";
    n.label = "";
    n.source = source;
    n.metadata.expression = expression;
    n.metadata.isProcedural = is_procedural;
    n.ports.push_back({output, "output", output, width, output, source});

    std::set<std::string> seen_inputs;
    std::regex id_re(R"([A-Za-z_$][A-Za-z0-9_$]*(?:\[[^\]]+\])?)");
    for (std::sregex_iterator it(expression.begin(), expression.end(), id_re), end; it != end; ++it) {
        std::string input = (*it).str();
        size_t pos = static_cast<size_t>(it->position());
        if (pos > 0 && expression[pos - 1] == '\'') continue;
        if (input == "default" || input == "signed" || input == "unsigned") continue;
        if (!seen_inputs.insert(input).second) continue;
        std::string port_name = "in" + std::to_string(seen_inputs.size() - 1);
        n.ports.push_back({port_name, "input", input, "", input, source});
    }

    mod.nodes.push_back(n);
    return output;
}

bool DesignExtractor::tryProcessArrayCompositionAssignment(vpiHandle assign_handle, Module& mod, bool is_procedural) {
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (!lhs || !rhs) return false;

    std::string out_signal = getSignalName(lhs);
    std::string out_base = getBaseSignalName(lhs);
    if (out_base.empty()) out_base = out_signal;
    ensureDeclaredArray(mod, out_base);
    if (out_base.empty() || !mod.arrayDimensions.count(out_base)) return false;

    std::string element_width = declaredArrayElementWidthFromSource(mod, out_base);
    if (element_width.empty()) element_width = getDeclaredSignalWidth(mod, out_base);
    if (element_width.empty()) element_width = getWidth(lhs);
    if (element_width.empty()) element_width = "[0:0]";

    SourceInfo source = getSourceInfo(assign_handle);

    if (out_signal == out_base) {
        std::vector<vpiHandle> operands = concatOperands(rhs);
        if (!operands.empty()) {
            int top_index = topArrayIndexForLabels(mod, out_base, static_cast<int>(operands.size()));
            for (size_t i = 0; i < operands.size(); ++i) {
                int index = top_index - static_cast<int>(i);
                vpiHandle operand = operands[i];
                std::string input_signal;
                std::string width = getWidth(operand);
                if (bitSizeFromWidth(element_width) > bitSizeFromWidth(width)) width = element_width;
                if (width.empty()) width = element_width;

                if (isLiteralExpr(operand)) {
                    input_signal = getLiteralLabel(operand);
                    ensureLiteralNode(operand, mod, input_signal, width, assign_handle, input_signal);
                } else {
                    input_signal = getOrPromoteExpr(operand, mod, out_base + "_elem_" + std::to_string(index), is_procedural);
                }
                ensureArrayCompositionInput(mod, out_base, "[" + std::to_string(index) + "]", input_signal, width, getSourceInfo(operand));
            }
            return true;
        }

        std::vector<std::string> elements = splitArrayInitializerElements(getAssignmentRhsText(assign_handle));
        if (elements.empty()) return false;

        int top_index = topArrayIndexForLabels(mod, out_base, static_cast<int>(elements.size()));
        for (size_t i = 0; i < elements.size(); ++i) {
            int index = top_index - static_cast<int>(i);
            std::string element = trimCopy(elements[i]);
            std::string width = literalTextWidth(element);
            if (bitSizeFromWidth(element_width) > bitSizeFromWidth(width)) width = element_width;
            if (width.empty()) width = element_width;

            std::string input_signal;
            if (isLiteralTextValue(element)) {
                input_signal = ensureTextLiteralNode(mod, element, width, source);
            } else if (isSimpleTextSignal(element)) {
                input_signal = element;
            } else {
                input_signal = ensureTextExpressionNode(mod, out_base, index, element, width, source, is_procedural);
            }

            ensureArrayCompositionInput(mod, out_base, "[" + std::to_string(index) + "]", input_signal, width, source);
        }
        return true;
    }

    std::optional<int> element_index = parseArrayIndexFromSignal(out_signal, out_base);
    if (!element_index) return false;

    std::string input_signal;
    if (isLiteralExpr(rhs)) {
        input_signal = getLiteralLabel(rhs);
        std::string label = getAssignmentRhsText(assign_handle);
        if (label.empty()) label = input_signal;
        ensureLiteralNode(rhs, mod, input_signal, element_width, assign_handle, label);
    } else {
        input_signal = getOrPromoteExpr(rhs, mod, out_base + "_elem_" + std::to_string(*element_index), is_procedural);
    }

    ensureArrayCompositionInput(mod, out_base, "[" + std::to_string(*element_index) + "]", input_signal, element_width, getSourceInfo(lhs));
    return true;
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
    ensureDeclaredArray(mod, out_base);
    if (tryProcessArrayCompositionAssignment(assign_handle, mod, is_procedural)) {
        return;
    }

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
    std::string rhs_base = getBaseSignalName(rhs);
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
    collectStructSignal(rhs, rhs_base, mod, getSourceInfo(rhs));

    ensureDeclaredArray(mod, out_base);
    ensureDeclaredArray(mod, rhs_base);
    if (!out_base.empty() && !rhs_base.empty()
        && out_signal == out_base
        && rhs_signal == rhs_base
        && mod.arrayDimensions.count(out_base)
        && mod.arrayDimensions.count(rhs_base)) {
        mod.pendingArrayAliases.push_back({out_base, rhs_base, getSourceInfo(assign_handle)});
        return;
    }

    int rhs_type = vpi_get(vpiType, rhs);
    bool is_select_rhs = isBusSelectExprType(rhs_type);
    if (is_select_rhs && !out_signal.empty() && out_signal == out_base && !rhs_base.empty() && mod.arrayDimensions.count(rhs_base)) {
        vpiHandle index_h = vpi_handle(vpiIndex, rhs);
        if (!index_h && (rhs_type == 606 || rhs_type == 607 || rhs_type == 130)) {
            index_h = vpi_handle(vpiBaseExpr, rhs);
        }

        bool is_constant_index = index_h ? isLiteralExpr(index_h) : false;
        std::string index_signal;
        if (index_h) {
            index_signal = getOrPromoteExpr(index_h, mod, rhs_signal + "_sel", is_procedural);
        } else {
            size_t bracket = rhs_signal.find('[');
            if (bracket != std::string::npos) {
                index_signal = rhs_signal.substr(bracket + 1);
                if (!index_signal.empty() && index_signal.back() == ']') index_signal.pop_back();
            }
            is_constant_index = !index_signal.empty() && std::all_of(index_signal.begin(), index_signal.end(), [](char c){ return std::isdigit((unsigned char)c) || c == ':' || c == '-'; });
        }

        if (!is_constant_index && !index_signal.empty()) {
            Node read_mux;
            read_mux.id = sanitizeId("mux:" + mod.name + ":" + rhs_base + "_read_" + index_signal);
            read_mux.kind = "mux";
            read_mux.label = "read";
            read_mux.source = getSourceInfo(rhs);
            std::string index_width = getDeclaredSignalWidth(mod, index_signal);
            int index_bits = bitSizeFromWidth(index_width);
            std::string sel_label = index_bits > 1 ? "s[]" : "s";
            std::string array_element_width = getDeclaredSignalWidth(mod, rhs_base);
            if (array_element_width.empty()) array_element_width = getWidth(rhs);
            read_mux.ports.push_back({"sel", "input", index_signal, index_width, sel_label});
            NodePort read_mux_in{"in", "input", rhs_base, array_element_width, "in"};
            read_mux_in.isArrayNode = true;
            read_mux_in.arrayDimension = mod.arrayDimensions.count(rhs_base) ? mod.arrayDimensions[rhs_base] : "";
            read_mux_in.arraySize = mod.arraySizes.count(rhs_base) ? mod.arraySizes[rhs_base] : 0;
            read_mux.ports.push_back(read_mux_in);
            read_mux.ports.push_back({"out", "output", out_signal, getWidth(lhs)});
            mod.nodes.push_back(read_mux);
            return;
        }
    }

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
            std::ifstream file = openSourceFile(src.file);
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
                std::ifstream source_file = openSourceFile(n.source.file);
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
    bool is_constant = isLiteralExpr(rhs);
    bool is_simple_rhs = (rhs_type == vpiNet || rhs_type == vpiReg || rhs_type == vpiPort || rhs_type == 608 || is_constant || is_select_rhs);
    // A concat/replication RHS is promoted to a self-sufficient bus/replicate node
    // (promoteConcatExpr/promoteReplicationExpr) that already fully drives the
    // output — same reasoning as the inverter case below. Naming that node's
    // output directly as out_base (instead of "<out_base>_next") skips the
    // otherwise-redundant wrapping "comb" alias node that processAssign would
    // synthesize for any non-simple RHS whose promoted signal differs from
    // out_signal.
    bool is_self_sufficient_rhs = isInverterOperation(rhs) || isConcatOperation(rhs) || isReplicationOperation(rhs);
    std::string preferred_output = out_base + (is_procedural && !is_self_sufficient_rhs ? "_next" : "");
    std::string in_signal = getOrPromoteExpr(rhs, mod, preferred_output, is_procedural);
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
        propagateStruct(mod, in_signal, out_signal);
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
