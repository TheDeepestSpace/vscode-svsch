SourceInfo DesignExtractor::getSourceInfo(const UHDM::BaseClass* object) {
    SourceInfo src;
    if (!object) return src;
    src.file = std::string(object->VpiFile());
    src.line = static_cast<int>(object->VpiLineNo());
    src.col = static_cast<int>(object->VpiColumnNo());
    src.endLine = static_cast<int>(object->VpiEndLineNo());
    src.endCol = static_cast<int>(object->VpiEndColumnNo());
    return src;
}

std::string DesignExtractor::directionString(int direction) const {
    if (direction == vpiInput) return "input";
    if (direction == vpiOutput) return "output";
    if (direction == vpiInout) return "inout";
    return "unknown";
}

std::string DesignExtractor::getWidth(const UHDM::BaseClass* object) {
    if (!object) return "";
    auto size_value = object->GetVpiPropertyValue(vpiSize);
    int size = 0;
    if (auto* int_value = std::get_if<int64_t>(&size_value)) size = static_cast<int>(*int_value);
    if (size > 1 && size < 1000000) return "[" + std::to_string(size - 1) + ":0]";
    auto left_value = object->GetVpiPropertyValue(vpiLeftRange);
    auto right_value = object->GetVpiPropertyValue(vpiRightRange);
    int left = vpiUndefined;
    int right = vpiUndefined;
    if (auto* int_value = std::get_if<int64_t>(&left_value)) left = static_cast<int>(*int_value);
    if (auto* int_value = std::get_if<int64_t>(&right_value)) right = static_cast<int>(*int_value);
    if (left != vpiUndefined && right != vpiUndefined && (left != 0 || right != 0)) {
        return "[" + std::to_string(left) + ":" + std::to_string(right) + "]";
    }
    return "[0:0]";
}

static std::string cleanWorkName(std::string value) {
    if (value.rfind("work@", 0) == 0) return value.substr(5);
    return value;
}

static std::string viewString(std::string_view view) {
    return cleanWorkName(std::string(view));
}

static std::string fieldNameFromIoDecl(const UHDM::io_decl* io) {
    if (!io) return "";
    std::string name = viewString(io->VpiName());
    if (!name.empty()) return name;
    if (auto* expr = io->Expr()) {
        name = viewString(expr->VpiName());
        if (!name.empty()) return name;
    }
    return name;
}

static std::string fallbackDeclaredTypeName(const SourceInfo& source, const std::string& name) {
    if (source.file.empty() || source.line <= 0 || name.empty()) return "";
    std::ifstream file(source.file);
    if (!file.is_open()) return "";

    std::string line;
    for (int i = 1; i <= source.line && std::getline(file, line); ++i) {
        if (i != source.line) continue;
        std::smatch match;
        std::string pattern = "\\b([A-Za-z_$][\\w$]*)\\s+(?:\\[[^\\]]+\\]\\s*)?" + name + "\\b";
        if (!std::regex_search(line, match, std::regex(pattern))) return "";
        std::string type_name = match[1].str();
        if (type_name == "logic" || type_name == "wire" || type_name == "reg" || type_name == "bit") return "";
        return type_name;
    }
    return "";
}

static SourceInfo fallbackDeclarationSource(const SourceInfo& source, const std::string& keyword, const std::string& name) {
    if (source.file.empty() || name.empty()) return source;
    std::ifstream file(source.file);
    if (!file.is_open()) return source;

    std::string line;
    std::regex pattern("\\b" + keyword + "\\s+" + name + "\\b");
    for (int line_no = 1; std::getline(file, line); ++line_no) {
        std::smatch match;
        if (!std::regex_search(line, match, pattern)) continue;
        SourceInfo fixed = source;
        fixed.line = line_no;
        fixed.col = static_cast<int>(match.position()) + 1;
        fixed.endLine = line_no;
        fixed.endCol = static_cast<int>(line.size()) + 1;
        return fixed;
    }
    return source;
}

std::string getModportPositionFromComment(const SourceInfo& src) {
    if (src.file.empty() || src.line <= 0) return "";
    std::ifstream file(src.file);
    if (!file.is_open()) return "";
    std::string line;
    std::string prev_line;
    for (int i = 1; i <= src.line; ++i) {
        prev_line = line;
        if (!std::getline(file, line)) break;
    }
    if (line.find("svsch:modport:pos=left") != std::string::npos || prev_line.find("svsch:modport:pos=left") != std::string::npos) return "left";
    if (line.find("svsch:modport:pos=right") != std::string::npos || prev_line.find("svsch:modport:pos=right") != std::string::npos) return "right";
    return "";
}

void DesignExtractor::collectInterfaceTypesFromDesign() {
    auto* wrapped = reinterpret_cast<uhdm_handle*>(design_);
    if (!wrapped || !wrapped->object) return;
    auto* design = static_cast<const UHDM::design*>(wrapped->object);
    if (!design || !design->AllInterfaces()) return;

    for (const UHDM::interface_inst* iface : *design->AllInterfaces()) {
        if (!iface) continue;
        std::string type_name = viewString(iface->VpiDefName());
        if (type_name.empty()) type_name = viewString(iface->VpiName());
        if (type_name.empty()) continue;

        InterfaceType& info = interfaceTypes_[type_name];
        info.name = type_name;
        if (info.source.file.empty()) info.source = fallbackDeclarationSource(getSourceInfo(iface), "interface", type_name);

        std::map<std::string, StructField> fields_by_name;
        for (const auto& existing : info.fields) fields_by_name[existing.name] = existing;

        if (iface->Ports()) {
            for (const UHDM::port* port : *iface->Ports()) {
                if (!port) continue;
                std::string name = viewString(port->VpiName());
                if (name.empty()) continue;
                StructField field;
                field.name = name;
                field.direction = directionString(port->VpiDirection());
                field.width = getWidth(port);
                field.source = getSourceInfo(port);
                fields_by_name[name] = field;
            }
        }
        if (iface->Nets()) {
            for (const UHDM::net* net : *iface->Nets()) {
                if (!net) continue;
                std::string name = viewString(net->VpiName());
                if (name.empty()) continue;
                StructField field = fields_by_name.count(name) ? fields_by_name[name] : StructField{};
                field.name = name;
                if (field.direction.empty()) field.direction = "inout";
                field.width = getWidth(net);
                field.source = getSourceInfo(net);
                if (field.typeName.empty()) field.typeName = fallbackDeclaredTypeName(field.source, name);
                fields_by_name[name] = field;
            }
        }
        if (iface->Variables()) {
            for (const UHDM::variables* var : *iface->Variables()) {
                if (!var) continue;
                std::string name = viewString(var->VpiName());
                if (name.empty()) continue;
                StructField field = fields_by_name.count(name) ? fields_by_name[name] : StructField{};
                field.name = name;
                if (field.direction.empty()) field.direction = "inout";
                field.width = getWidth(var);
                if (auto struct_type = getStructTypeFromTypespec(reinterpret_cast<vpiHandle>(const_cast<UHDM::ref_typespec*>(var->Typespec())))) {
                    field.typeName = struct_type->name;
                    if (!struct_type->width.empty()) field.width = struct_type->width;
                }
                field.source = getSourceInfo(var);
                if (field.typeName.empty()) field.typeName = fallbackDeclaredTypeName(field.source, name);
                fields_by_name[name] = field;
            }
        }

        info.fields.clear();
        for (const auto& [_, field] : fields_by_name) info.fields.push_back(field);

        if (iface->Modports()) {
            for (const UHDM::modport* modport : *iface->Modports()) {
                if (!modport) continue;
                InterfaceModport mp;
                mp.name = viewString(modport->VpiName());
                if (mp.name.empty()) continue;
                mp.source = fallbackDeclarationSource(getSourceInfo(modport), "modport", mp.name);

                if (modport->Io_decls()) {
                    int inputs = 0;
                    int outputs = 0;
                    for (const UHDM::io_decl* io : *modport->Io_decls()) {
                        std::string field_name = fieldNameFromIoDecl(io);
                        if (field_name.empty()) continue;
                        StructField field = fields_by_name.count(field_name) ? fields_by_name[field_name] : StructField{};
                        field.name = field_name;
                        field.direction = directionString(io->VpiDirection());
                        if (field.direction == "input") inputs++;
                        else if (field.direction == "output") outputs++;
                        if (field.width.empty()) field.width = getWidth(io);
                        if (field.source.file.empty()) field.source = getSourceInfo(io);
                        mp.fields.push_back(field);
                    }
                    
                    if (outputs > inputs) mp.preferredSide = "left";
                    else if (inputs > outputs) mp.preferredSide = "right";
                    else if (mp.name.find("master") != std::string::npos) mp.preferredSide = "left";
                    else if (mp.name.find("slave") != std::string::npos) mp.preferredSide = "right";
                    else mp.preferredSide = "right";

                    std::string commentPos = getModportPositionFromComment(mp.source);
                    if (!commentPos.empty()) mp.preferredSide = commentPos;
                }

                info.modports[mp.name] = mp;
            }
        }
    }
}

void DesignExtractor::processModuleInterfaces(vpiHandle module_handle, Module& mod) {
    vpiHandle iface_itr = vpi_iterate(vpiInterface, module_handle);
    if (!iface_itr) return;

    while (vpiHandle iface_handle = vpi_scan(iface_itr)) {
        InterfaceSignal signal;
        const char* name = vpi_get_str(vpiName, iface_handle);
        const char* def_name = vpi_get_str(vpiDefName, iface_handle);
        signal.name = name ? viewString(name) : "";
        signal.typeName = def_name ? viewString(def_name) : "";
        signal.source = getSourceInfo(iface_handle);
        
        vpiHandle port_itr = vpi_iterate(vpiPort, iface_handle);
        if (port_itr) {
            while (vpiHandle p_handle = vpi_scan(port_itr)) {
                const char* pn = vpi_get_str(vpiName, p_handle);
                std::string port_name = pn ? viewString(pn) : "";
                vpiHandle high = vpi_handle(vpiHighConn, p_handle);
                std::string conn = getSignalName(high);
                if (!port_name.empty() && !conn.empty()) {
                    signal.portConnections[port_name] = conn;
                }
            }
        }

        if (!signal.name.empty() && !signal.typeName.empty()) {
            if (auto existing = mod.interfaceSignals.find(signal.name); existing != mod.interfaceSignals.end()) {
                if (existing->second.typeName == signal.typeName || existing->second.typeName.empty()) {
                    if (existing->second.source.file.empty()) existing->second.source = signal.source;
                    if (existing->second.typeName.empty()) existing->second.typeName = signal.typeName;
                    for (const auto& [pn, cn] : signal.portConnections) {
                        existing->second.portConnections[pn] = cn;
                    }
                    continue;
                }
            }
            mod.interfaceSignals[signal.name] = signal;
            mod.internalSignals.insert(signal.name);
        }
    }
}

void DesignExtractor::collectInterfacePortsFromSource(Module& mod) {
    if (mod.source.file.empty()) return;
    std::ifstream file(mod.source.file);
    if (!file.is_open()) return;
    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string text = buffer.str();
    std::string scoped_text = text;
    std::smatch module_match;
    std::string module_pattern = "\\bmodule\\s+" + mod.name + "\\b[\\s\\S]*?;";
    if (std::regex_search(text, module_match, std::regex(module_pattern))) {
        scoped_text = module_match.str();
    } else if (mod.source.line > 0 && mod.source.endLine >= mod.source.line) {
        std::stringstream scoped;
        std::istringstream lines(text);
        std::string line;
        for (int line_no = 1; std::getline(lines, line); ++line_no) {
            if (line_no >= mod.source.line && line_no <= mod.source.endLine) scoped << line << "\n";
        }
        scoped_text = scoped.str();
    }

    for (auto& port : mod.ports) {
        if (!port.typeName.empty() && interfaceTypes_.count(port.typeName)) continue;
        for (const auto& [type_name, type] : interfaceTypes_) {
            std::string pattern = "\\b" + type_name + "\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*))?\\s+" + port.name + "\\b";
            std::smatch match;
            if (!std::regex_search(scoped_text, match, std::regex(pattern))) continue;

            port.typeName = type_name;
            port.typeSource = type.source;
            if (match[1].matched) {
                port.modportName = match[1].str();
                auto mp_it = type.modports.find(port.modportName);
                if (mp_it != type.modports.end()) {
                    port.modportSource = mp_it->second.source;
                    port.preferredSide = mp_it->second.preferredSide;
                }
            }

            InterfaceSignal signal;
            signal.name = port.name;
            signal.typeName = port.typeName;
            signal.modportName = port.modportName;
            signal.source = port.source;
            signal.isPort = true;
            mod.interfaceSignals[signal.name] = signal;
            mod.internalSignals.insert(signal.name);
            break;
        }
    }
}

static bool hasInterfaceFieldActivity(const Module& mod, const std::string& base) {
    const std::string prefix = base + ".";
    for (const auto& node : mod.nodes) {
        if (node.metadata.expression.find(prefix) != std::string::npos) return true;
        for (const auto& port : node.ports) {
            if (port.signal.rfind(prefix, 0) == 0) return true;
        }
    }
    for (const auto& edge : mod.edges) {
        if (edge.signal.rfind(prefix, 0) == 0) return true;
    }
    return false;
}

static void addWholeInterfacePeerEdges(Module& mod, const std::string& base, const InterfaceSignal& signal) {
    struct Endpoint {
        std::string nodeId;
        std::string portName;
        SourceInfo source;
    };

    std::vector<Endpoint> endpoints;
    for (const auto& node : mod.nodes) {
        for (const auto& port : node.ports) {
            if (port.signal == base && (node.kind == "instance" || port.typeName == signal.typeName)) {
                endpoints.push_back({node.id, port.name, port.source});
            }
        }
    }
    if (endpoints.size() < 2) return;

    const Endpoint& source = endpoints.front();
    for (size_t i = 1; i < endpoints.size(); ++i) {
        const Endpoint& target = endpoints[i];
        bool duplicate = false;
        for (const auto& existing : mod.edges) {
            if (existing.source == source.nodeId && existing.target == target.nodeId &&
                existing.sourcePort == source.portName && existing.targetPort == target.portName) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) continue;

        Edge e;
        e.source = source.nodeId;
        e.sourcePort = source.portName;
        e.target = target.nodeId;
        e.targetPort = target.portName;
        e.signal = base;
        e.width = "interface";
        e.sourceInfo = target.source.file.empty() ? source.source : target.source;
        e.aggregateKind = "interface";
        mod.edges.push_back(e);
    }
}

std::optional<InterfaceSignal> DesignExtractor::interfacePortInfoForModule(const std::string& moduleName, const std::string& portName) const {
    for (const auto& module : modules_) {
        if (module.name != moduleName) continue;
        auto it = module.interfaceSignals.find(portName);
        if (it != module.interfaceSignals.end()) return it->second;
    }
    return std::nullopt;
}

static std::string flipInterfacePortDirection(const std::string& direction) {
    if (direction == "input") return "output";
    if (direction == "output") return "input";
    return direction.empty() ? "unknown" : direction;
}

void DesignExtractor::synthesizeInterfaceHarnesses(Module& mod) {
    for (const auto& [base, signal] : mod.interfaceSignals) {
        auto type_it = interfaceTypes_.find(signal.typeName);
        if (type_it == interfaceTypes_.end()) continue;
        const InterfaceType& type = type_it->second;

        std::vector<StructField> fields = type.fields;
        SourceInfo modport_source;
        if (!signal.modportName.empty()) {
            auto mp_it = type.modports.find(signal.modportName);
            if (mp_it != type.modports.end()) {
                fields = mp_it->second.fields;
                modport_source = mp_it->second.source;
            }
        }

        bool typeHasPorts = false;
        for (const auto& f : type.fields) {
            if (f.direction == "input" || f.direction == "output") {
                typeHasPorts = true;
                break;
            }
        }

        if (!signal.isPort && !typeHasPorts && !hasInterfaceFieldActivity(mod, base)) {
            addWholeInterfacePeerEdges(mod, base, signal);
            continue;
        }

        const bool isModuleInterfacePort = signal.isPort && !signal.modportName.empty();
        const std::string interface_port_node_id = "interface:" + mod.name + ":" + base;
        const std::string node_id = isModuleInterfacePort ? "interface_modport:" + mod.name + ":" + base : interface_port_node_id;

        if (isModuleInterfacePort) {
            bool has_port_node = false;
            for (const auto& node : mod.nodes) {
                if (node.id == interface_port_node_id) {
                    has_port_node = true;
                    break;
                }
            }

            if (!has_port_node) {
                Node port_node;
                port_node.id = interface_port_node_id;
                port_node.kind = "interface";
                port_node.label = base;
                port_node.source = type.source;
                port_node.metadata.role = "port";
                port_node.metadata.aggregateKind = "interface";
                port_node.metadata.typeName = signal.typeName;
                port_node.metadata.typeSource = type.source;
                port_node.metadata.modportName = signal.modportName;
                port_node.metadata.modportSource = modport_source;
                port_node.metadata.fields = fields;

                std::string preferred_side = "right";
                auto mp_it = type.modports.find(signal.modportName);
                if (mp_it != type.modports.end()) preferred_side = mp_it->second.preferredSide;
                std::string direction = preferred_side == "left" ? "input" : "output";
                port_node.ports.push_back({signal.modportName, direction, base, "interface", signal.modportName, modport_source, signal.typeName, type.source, signal.modportName, modport_source, preferred_side});
                mod.nodes.push_back(port_node);
            }
        }

        Node* iface_node = nullptr;
        for (auto& node : mod.nodes) {
            if (node.id == node_id) {
                iface_node = &node;
                break;
            }
        }
        if (!iface_node) {
            Node n;
            n.id = node_id;
            n.kind = "interface";
            n.label = base;
            n.source = type.source;
            n.metadata.role = signal.modportName.empty() ? "breakout" : "modport";
            n.metadata.aggregateKind = "interface";
            n.metadata.typeName = signal.typeName;
            n.metadata.typeSource = type.source;
            n.metadata.modportName = signal.modportName;
            n.metadata.modportSource = modport_source;
            n.metadata.fields = fields;
            bool isInterfaceInstance = n.kind == "interface" && n.metadata.role != "modport";
            
            if (isInterfaceInstance) {
                if (type.modports.empty()) {
                    // Breakout mode: show all fields
                    for (const auto& field : fields) {
                         n.ports.push_back({field.name, field.direction.empty() ? "inout" : field.direction, base + "." + field.name, field.width, field.name, field.source, field.typeName, SourceInfo{}, "", SourceInfo{}, ""});
                    }
                } else {
                    // Hub mode: show only interface-level ports
                    for (const auto& field : fields) {
                        if (field.direction == "input" || field.direction == "output") {
                             n.ports.push_back({field.name, field.direction, base + "." + field.name, field.width, field.name, field.source, field.typeName, SourceInfo{}, "", SourceInfo{}, ""});
                        }
                    }
                }
            }

            if (!isModuleInterfacePort) {
                for (const auto& [mp_name, mp] : type.modports) {
                    std::string direction = mp.preferredSide == "left" ? "input" : "output";
                    n.ports.push_back({mp_name, direction, base, "interface", mp_name, mp.source, signal.typeName, type.source, mp_name, mp.source, mp.preferredSide});
                }
            }

            if (!isInterfaceInstance) {
                if (isModuleInterfacePort) {
                    std::string preferred_side = "right";
                    auto mp_it = type.modports.find(signal.modportName);
                    if (mp_it != type.modports.end()) preferred_side = mp_it->second.preferredSide;
                    std::string direction = preferred_side == "left" ? "output" : "input";
                    n.ports.push_back({signal.modportName, direction, base, "interface", signal.modportName, modport_source, signal.typeName, type.source, signal.modportName, modport_source, ""});
                }
                for (const auto& field : fields) {
                    std::string direction = isModuleInterfacePort ? flipInterfacePortDirection(field.direction) : (field.direction.empty() ? "inout" : field.direction);
                    n.ports.push_back({field.name, direction, base + "." + field.name, field.width, field.name, field.source, field.typeName, SourceInfo{}, "", SourceInfo{}, ""});
                }
            }
            mod.nodes.push_back(n);
            iface_node = &mod.nodes.back();
        }

        if (isModuleInterfacePort) {
            std::string preferred_side = "right";
            auto mp_it = type.modports.find(signal.modportName);
            if (mp_it != type.modports.end()) preferred_side = mp_it->second.preferredSide;

            Edge e;
            e.signal = base;
            e.width = "interface";
            e.sourceInfo = signal.source;
            e.aggregateKind = "interface";
            if (preferred_side == "left") {
                e.source = node_id;
                e.sourcePort = signal.modportName;
                e.target = interface_port_node_id;
                e.targetPort = signal.modportName;
            } else {
                e.source = interface_port_node_id;
                e.sourcePort = signal.modportName;
                e.target = node_id;
                e.targetPort = signal.modportName;
            }

            bool duplicate = false;
            for (const auto& existing : mod.edges) {
                if (existing.source == e.source && existing.target == e.target &&
                    existing.sourcePort == e.sourcePort && existing.targetPort == e.targetPort) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) mod.edges.push_back(e);
        }

        for (const auto& [port_name, conn] : signal.portConnections) {
            std::string dir = "unknown";
            std::string width = "";
            for (const auto& f : fields) {
                if (f.name == port_name) {
                    dir = f.direction;
                    width = f.width;
                    break;
                }
            }

            Edge e;
            e.signal = conn;
            e.width = width;
            if (dir == "output") {
                e.source = node_id;
                e.sourcePort = port_name;
                e.target = "self";
                e.targetPort = conn;
            } else {
                e.source = "self";
                e.sourcePort = conn;
                e.target = node_id;
                e.targetPort = port_name;
            }
            
            bool duplicate = false;
            for (const auto& existing : mod.edges) {
                if (existing.source == e.source && existing.target == e.target &&
                    existing.sourcePort == e.sourcePort && existing.targetPort == e.targetPort) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) mod.edges.push_back(e);
        }

        for (auto& node : mod.nodes) {
            if (node.id == node_id || node.id == interface_port_node_id) continue;
            if (!node.metadata.expression.empty()) {
                for (const auto& field : fields) {
                    std::string field_signal = base + "." + field.name;
                    if (node.metadata.expression.find(field_signal) == std::string::npos) continue;
                    bool has_port = false;
                    for (const auto& port : node.ports) {
                        if (port.signal == field_signal) {
                            has_port = true;
                            break;
                        }
                    }
                    if (!has_port) {
                        node.ports.push_back({field_signal, "input", field_signal, field.width, field.name, field.source, "", SourceInfo{}, "", SourceInfo{}, ""});
                    }
                }
            }

            for (auto& port : node.ports) {
                if (port.signal == base && (node.kind == "instance" || port.typeName == signal.typeName)) {
                    Edge e;
                    std::string mp_name = port.modportName.empty() ? base : port.modportName;
                    std::string pref = "right";
                    auto mp_it = type.modports.find(mp_name);
                    if (mp_it != type.modports.end()) pref = mp_it->second.preferredSide;

                    if (pref == "left") {
                        // Module -> Interface
                        e.source = node.id;
                        e.sourcePort = port.name;
                        e.target = node_id;
                        e.targetPort = mp_name;
                    } else {
                        // Interface -> Module
                        e.source = node_id;
                        e.sourcePort = mp_name;
                        e.target = node.id;
                        e.targetPort = port.name;
                    }
                    e.signal = base;
                    e.width = "interface";
                    e.sourceInfo = port.source;
                    e.aggregateKind = "interface";
                    
                    bool duplicate = false;
                    for (const auto& existing : mod.edges) {
                        if (existing.source == e.source && existing.target == e.target &&
                            existing.sourcePort == e.sourcePort && existing.targetPort == e.targetPort) {
                            duplicate = true;
                            break;
                        }
                    }
                    if (!duplicate) mod.edges.push_back(e);
                    continue;
                }

                if (port.signal.rfind(base + ".", 0) != 0) continue;
                std::string field = port.signal.substr(base.size() + 1);
                std::string dir = "inout";
                for (const auto& candidate : fields) {
                    if (candidate.name == field) {
                        dir = candidate.direction;
                        break;
                    }
                }

                Edge e;
                e.signal = port.signal;
                e.width = port.width;
                if (!isModuleInterfacePort) e.aggregateKind = "interface";
                if (dir == "output" || (dir == "inout" && port.direction == "output")) {
                    e.source = node.id;
                    e.sourcePort = port.name;
                    e.target = node_id;
                    e.targetPort = field;
                } else {
                    e.source = node_id;
                    e.sourcePort = field;
                    e.target = node.id;
                    e.targetPort = port.name;
                }

                bool duplicate = false;
                for (const auto& existing : mod.edges) {
                    if (existing.source == e.source && existing.target == e.target &&
                        existing.sourcePort == e.sourcePort && existing.targetPort == e.targetPort) {
                        duplicate = true;
                        break;
                    }
                }
                if (!duplicate) mod.edges.push_back(e);
            }
        }
    }
}
