std::string DesignExtractor::processBusSelect(vpiHandle select_handle, Module& mod) {
    vpiHandle base = vpi_handle(vpiParent, select_handle);
    if (!base) base = vpi_handle(vpiExpr, select_handle);

    std::string select_str = getSignalName(select_handle);
    std::string base_name;
    if (base) {
        base_name = getSignalName(base);
    }
    
    if (base_name.empty()) {
        size_t bracket = select_str.find('[');
        if (bracket != std::string::npos) {
            base_name = select_str.substr(0, bracket);
        }
    }

    if (base_name.empty()) return select_str;

    std::string tap_label = "";
    size_t pos = select_str.find('[');
    if (pos != std::string::npos) {
        tap_label = select_str.substr(pos);
    }

    std::string bus_node_id = "bus:" + mod.name + ":" + base_name;

    Node* bus_node = nullptr;
    for (auto& n : mod.nodes) {
        if (n.id == bus_node_id) {
            bus_node = &n;
            break;
        }
    }

    if (!bus_node) {
        Node n;
        n.id = bus_node_id;
        n.kind = "bus";
        n.label = base_name;
        n.source = getSourceInfo(base ? base : select_handle);
        n.metadata.expression = base_name;
        n.ports.push_back({base_name, "input", base_name, base ? getWidth(base) : ""});
        mod.nodes.push_back(n);
        bus_node = &mod.nodes.back();
    }

    bool port_exists = false;
    for (const auto& p : bus_node->ports) {
        if (p.name == tap_label) {
            port_exists = true;
            break;
        }
    }

    if (!port_exists) {
        bus_node->ports.push_back({tap_label, "output", select_str, getWidth(select_handle), tap_label});
    }

    return select_str;
}

std::optional<StructType> DesignExtractor::getStructType(vpiHandle handle) {
    if (!handle) return std::nullopt;

    vpiHandle ts = vpi_handle(vpiTypespec, handle);
    if (!ts) ts = vpi_handle(vpiTypedef, handle);
    if (auto type = getStructTypeFromTypespec(ts)) return type;

    if (vpi_get(vpiType, handle) == 608) {
        vpiHandle actual = vpi_handle(vpiActual, handle);
        if (actual && actual != handle) return getStructType(actual);
    }

    vpiHandle actual = vpi_handle(vpiActual, handle);
    if (actual && actual != handle) {
        if (auto type = getStructType(actual)) return type;
    }

    return std::nullopt;
}

std::optional<StructType> DesignExtractor::getStructTypeFromTypespec(vpiHandle typespec) {
    if (!typespec) return std::nullopt;

    int type = vpi_get(vpiType, typespec);
    if (type == 608 || type == vpiRefTypespec) {
        vpiHandle actual = vpi_handle(vpiActual, typespec);
        if (actual && actual != typespec) {
            if (auto resolved = getStructTypeFromTypespec(actual)) return resolved;
        }
    }

    if (type != vpiStructTypespec) {
        vpiHandle nested = vpi_handle(vpiTypespec, typespec);
        if (nested && nested != typespec) return getStructTypeFromTypespec(nested);
        return std::nullopt;
    }

    StructType info;
    const char* name = vpi_get_str(vpiName, typespec);
    info.name = (name && strlen(name) > 0) ? name : "struct";
    if (info.name.rfind("work@", 0) == 0) info.name = info.name.substr(5);
    info.packed = vpi_get(vpiPacked, typespec) != 0;
    info.source = getSourceInfo(typespec);

    int total_bits = 0;
    vpiHandle member_itr = vpi_iterate(vpiTypespecMember, typespec);
    if (!member_itr) member_itr = vpi_iterate(vpiMember, typespec);
    if (member_itr) {
        while (vpiHandle member = vpi_scan(member_itr)) {
            StructField field;
            const char* member_name = vpi_get_str(vpiName, member);
            field.name = member_name ? member_name : "";
            field.width = getWidth(member);
            if (field.width.empty() || field.width == "[0:0]") {
                vpiHandle member_ts = vpi_handle(vpiTypespec, member);
                std::string ts_width = getWidth(member_ts);
                vpiHandle actual_ts = member_ts ? vpi_handle(vpiActual, member_ts) : nullptr;
                std::string logic_width = explicitTypespecRange(actual_ts);
                std::string actual_width = getWidth(actual_ts);
                if (!logic_width.empty()) field.width = logic_width;
                else if (!actual_width.empty()) field.width = actual_width;
                else if (!ts_width.empty()) field.width = ts_width;
            }
            total_bits += rangeWidthInBits(field.width);
            if (!field.name.empty()) info.fields.push_back(field);
        }
    }

    if (info.packed && total_bits > 1) {
        info.width = "[" + std::to_string(total_bits - 1) + ":0]";
        int next_msb = total_bits - 1;
        for (auto& field : info.fields) {
            int bits = rangeWidthInBits(field.width);
            int lsb = next_msb - bits + 1;
            field.bitRange = bits == 1
                ? "[" + std::to_string(next_msb) + "]"
                : "[" + std::to_string(next_msb) + ":" + std::to_string(lsb) + "]";
            next_msb = lsb - 1;
        }
    }

    return info.fields.empty() ? std::nullopt : std::optional<StructType>(info);
}

void DesignExtractor::collectStructSignal(vpiHandle handle, const std::string& name, Module& mod, const SourceInfo& source) {
    if (!handle || name.empty() || name == "expr" || name.find('.') != std::string::npos) return;
    if (mod.structSignals.find(name) != mod.structSignals.end()) return;
    auto type = getStructType(handle);
    if (!type) return;
    mod.structSignals[name] = StructSignal{name, *type, source};
}

std::optional<std::pair<std::string, std::string>> DesignExtractor::getStructFieldRef(vpiHandle handle, const Module& mod) {
    if (!handle) return std::nullopt;

    std::string text = getSignalName(handle);
    if (text.empty() || text == "expr") {
        const char* decompile = vpi_get_str(vpiDecompile, handle);
        if (decompile && strlen(decompile) > 0) text = decompile;
    }
    if (text.rfind("work@", 0) == 0) text = text.substr(5);

    size_t dot = text.find('.');
    if (dot == std::string::npos) return std::nullopt;
    std::string base = text.substr(0, dot);
    std::string field = text.substr(dot + 1);
    size_t stop = field.find_first_of(" [({+-*/&|^~!=?:;,\t\r\n");
    if (stop != std::string::npos) field = field.substr(0, stop);

    auto it = mod.structSignals.find(base);
    if (it == mod.structSignals.end()) return std::nullopt;
    for (const auto& candidate : it->second.type.fields) {
        if (candidate.name == field) return std::make_pair(base, field);
    }

    return std::nullopt;
}

std::string DesignExtractor::ensureStructBreakout(Module& mod, const std::string& base, const std::string& field, SourceInfo source) {
    auto signal_it = mod.structSignals.find(base);
    if (signal_it == mod.structSignals.end()) return base + "." + field;

    const StructSignal& signal = signal_it->second;
    std::string node_id = "struct:" + mod.name + ":" + base;
    Node* node = nullptr;
    for (auto& candidate : mod.nodes) {
        if (candidate.id == node_id) {
            node = &candidate;
            break;
        }
    }

    if (!node) {
        Node n;
        n.id = node_id;
        n.kind = "struct";
        n.label = base;
        n.source = signal.source;
        n.metadata.role = "breakout";
        n.metadata.typeName = signal.type.name;
        n.metadata.packed = signal.type.packed;
        n.metadata.fields = signal.type.fields;
        n.metadata.expression = base;
        n.ports.push_back({base, "input", base, signal.type.width, "", signal.source});
        mod.nodes.push_back(n);
        node = &mod.nodes.back();

        Edge e;
        e.source = "self";
        e.sourcePort = base;
        e.target = node_id;
        e.targetPort = base;
        e.signal = base;
        e.width = signal.type.width;
        e.sourceInfo = signal.source;
        e.aggregateStruct = true;
        mod.edges.push_back(e);
    }

    std::string field_signal = base + "." + field;
    for (const auto& port : node->ports) {
        if (port.name == field_signal) return field_signal;
    }

    node->ports.push_back({field_signal, "output", field_signal, fieldWidth(signal.type, field), field, source});
    return field_signal;
}

std::string DesignExtractor::ensureStructBreakoutAlias(Module& mod, const std::string& base, const std::string& field, const std::string& output_signal, SourceInfo source) {
    if (output_signal.empty()) return "";
    auto signal_it = mod.structSignals.find(base);
    if (signal_it == mod.structSignals.end()) return output_signal;

    const StructSignal& signal = signal_it->second;
    std::string node_id = "struct:" + mod.name + ":" + base;
    for (auto& node : mod.nodes) {
        if (node.id == node_id) {
            for (const auto& port : node.ports) {
                if (port.direction == "output" && port.signal == output_signal) return output_signal;
            }

            node.ports.push_back({output_signal, "output", output_signal, fieldWidth(signal.type, field), field, source});
            return output_signal;
        }
    }

    Node n;
    n.id = node_id;
    n.kind = "struct";
    n.label = base;
    n.source = signal.source;
    n.metadata.role = "breakout";
    n.metadata.typeName = signal.type.name;
    n.metadata.packed = signal.type.packed;
    n.metadata.fields = signal.type.fields;
    n.metadata.expression = base;
    n.ports.push_back({base, "input", base, signal.type.width, "", signal.source});
    n.ports.push_back({output_signal, "output", output_signal, fieldWidth(signal.type, field), field, source});
    mod.nodes.push_back(n);

    Edge e;
    e.source = "self";
    e.sourcePort = base;
    e.target = node_id;
    e.targetPort = base;
    e.signal = base;
    e.width = signal.type.width;
    e.sourceInfo = signal.source;
    e.aggregateStruct = true;
    mod.edges.push_back(e);

    return output_signal;
}

void DesignExtractor::ensureStructFieldCompositionInput(Module& mod, const std::string& base, const std::string& field, const std::string& input_signal, SourceInfo source) {
    if (base.empty() || field.empty() || input_signal.empty()) return;

    auto signal_it = mod.structSignals.find(base);
    if (signal_it == mod.structSignals.end()) return;
    const StructSignal& signal = signal_it->second;

    std::string node_id = "struct_comp:" + mod.name + ":" + base;
    Node* node = nullptr;
    for (auto& candidate : mod.nodes) {
        if (candidate.id == node_id) {
            node = &candidate;
            break;
        }
    }

    if (!node) {
        Node n;
        n.id = node_id;
        n.kind = "struct";
        n.label = base;
        n.source = signal.source;
        n.metadata.role = "composition";
        n.metadata.typeName = signal.type.name;
        n.metadata.packed = signal.type.packed;
        n.metadata.fields = signal.type.fields;
        n.metadata.expression = base;
        n.ports.push_back({base, "output", base, signal.type.width, "", signal.source});
        mod.nodes.push_back(n);
        node = &mod.nodes.back();
    }

    std::string field_port = base + "." + field;
    for (auto& port : node->ports) {
        if (port.name == field_port) {
            port.signal = input_signal;
            if (port.width.empty()) port.width = fieldWidth(signal.type, field);
            if (port.label.empty()) port.label = field;
            return;
        }
    }

    node->ports.push_back({field_port, "input", input_signal, fieldWidth(signal.type, field), field, source});

    bool target_is_module_output = false;
    for (const auto& port : mod.ports) {
        if (port.name == base && port.direction == "output") {
            target_is_module_output = true;
            break;
        }
    }
    if (!target_is_module_output) return;

    for (const auto& edge : mod.edges) {
        if (edge.source == node_id && edge.target == "self" && edge.targetPort == base) return;
    }

    Edge e;
    e.source = node_id;
    e.sourcePort = base;
    e.target = "self";
    e.targetPort = base;
    e.signal = base;
    e.width = signal.type.width;
    e.sourceInfo = source;
    e.aggregateStruct = true;
    mod.edges.push_back(e);
}

void DesignExtractor::ensureBusSliceCompositionInput(Module& mod, const std::string& base, const std::string& slice, const std::string& input_signal, SourceInfo source) {
    if (base.empty() || slice.empty() || input_signal.empty()) return;

    std::string node_id = "bus_comp:" + mod.name + ":" + base;
    Node* node = nullptr;
    for (auto& candidate : mod.nodes) {
        if (candidate.id == node_id) {
            node = &candidate;
            break;
        }
    }

    std::string output_width = getDeclaredSignalWidth(mod, base);
    if (!node) {
        Node n;
        n.id = node_id;
        n.kind = "bus";
        n.label = base;
        n.source = source;
        n.ports.push_back({base, "output", base, output_width, base, source});
        mod.nodes.push_back(n);
        node = &mod.nodes.back();
    }

    bool has_output = false;
    for (auto& port : node->ports) {
        if (port.direction == "output" && port.signal == base) {
            has_output = true;
            if (port.width.empty() && !output_width.empty()) port.width = output_width;
        }
    }
    if (!has_output) node->ports.push_back({base, "output", base, output_width, base, source});

    for (const auto& port : node->ports) {
        if (port.direction == "input" && port.signal == input_signal) return;
    }

    std::string slice_width = "";
    std::smatch match;
    if (std::regex_search(slice, match, std::regex(R"(\[(-?\d+)(?::(-?\d+))?\])"))) {
        int left = std::stoi(match[1].str());
        int right = match[2].matched ? std::stoi(match[2].str()) : left;
        int bits = std::abs(left - right) + 1;
        slice_width = bits > 1 ? "[" + std::to_string(bits - 1) + ":0]" : "[0:0]";
    }
    node->ports.push_back({slice, "input", input_signal, slice_width, slice, source});
}

std::string DesignExtractor::ensureStructComposition(Module& mod, const std::string& base) {
    auto signal_it = mod.structSignals.find(base);
    if (signal_it == mod.structSignals.end()) return "";
    const StructSignal& signal = signal_it->second;

    std::string node_id = "struct_comp:" + mod.name + ":" + base;
    Node* node = nullptr;
    for (auto& candidate : mod.nodes) {
        if (candidate.id == node_id) {
            node = &candidate;
            break;
        }
    }

    if (!node) {
        Node n;
        n.id = node_id;
        n.kind = "struct";
        n.label = base;
        n.source = signal.source;
        n.metadata.role = "composition";
        n.metadata.typeName = signal.type.name;
        n.metadata.packed = signal.type.packed;
        n.metadata.fields = signal.type.fields;
        n.metadata.expression = base;
        n.ports.push_back({base, "output", base, signal.type.width, "", signal.source});
        mod.nodes.push_back(n);
        node = &mod.nodes.back();
    }

    for (const auto& field : signal.type.fields) {
        std::string field_signal = base + "." + field.name;
        if (!hasStructFieldDriver(mod, field_signal)) continue;

        bool has_port = false;
        for (const auto& port : node->ports) {
            if (port.name == field_signal) {
                has_port = true;
                break;
            }
        }
        if (!has_port) {
            node->ports.push_back({field_signal, "input", field_signal, field.width, field.name, signal.source});
        }

        for (const auto& driver : mod.nodes) {
            for (const auto& port : driver.ports) {
                if (port.direction == "output" && port.signal == field_signal) {
                    Edge e;
                    e.source = driver.id;
                    e.sourcePort = port.name;
                    e.target = node_id;
                    e.targetPort = field_signal;
                    e.signal = field_signal;
                    e.width = field.width;
                    e.sourceInfo = port.source.file.empty() ? driver.source : port.source;
                    mod.edges.push_back(e);
                }
            }
        }
    }

    return base;
}

void DesignExtractor::synthesizePendingStructCompositions(Module& mod) {
    for (const auto& pending : mod.pendingStructAssigns) {
        std::string out_port = ensureStructComposition(mod, pending.baseSignal);
        if (out_port.empty()) continue;

        Edge e;
        e.source = "struct_comp:" + mod.name + ":" + pending.baseSignal;
        e.sourcePort = out_port;
        e.target = "self";
        e.targetPort = pending.targetSignal;
        e.signal = pending.baseSignal;
        e.width = mod.structSignals[pending.baseSignal].type.width;
        e.sourceInfo = pending.source;
        e.aggregateStruct = true;
        mod.edges.push_back(e);
    }
}

std::string DesignExtractor::fieldWidth(const StructType& type, const std::string& field) const {
    for (const auto& candidate : type.fields) {
        if (candidate.name == field) return candidate.width;
    }
    return "";
}

std::string DesignExtractor::fieldBitRange(const StructType& type, const std::string& field) const {
    for (const auto& candidate : type.fields) {
        if (candidate.name == field) return candidate.bitRange;
    }
    return "";
}

bool DesignExtractor::hasStructFieldDriver(const Module& mod, const std::string& signal) const {
    for (const auto& node : mod.nodes) {
        for (const auto& port : node.ports) {
            if (port.direction == "output" && port.signal == signal) return true;
        }
    }
    return false;
}
