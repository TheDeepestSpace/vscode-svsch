json DesignExtractor::extract() {
    collectInterfaceTypesFromDesign();

    const int uhdmtopModules = 2377;
    vpiHandle mod_itr = vpi_iterate(uhdmtopModules, design_);
    if (mod_itr) {
        while (vpiHandle mod_handle = vpi_scan(mod_itr)) {
            processModule(mod_handle);
        }
    }

    const int uhdmallModules = 2008;
    vpiHandle all_mod_itr = vpi_iterate(uhdmallModules, design_);
    if (all_mod_itr) {
        while (vpiHandle mod_handle = vpi_scan(all_mod_itr)) {
            const char* def_name = vpi_get_str(vpiDefName, mod_handle);
            if (def_name) {
                bool already_processed = false;
                for (const auto& m : modules_) {
                    if (m.name == def_name) {
                        already_processed = true;
                        break;
                    }
                }
                if (!already_processed) {
                    processModule(mod_handle);
                }
            }
        }
    }

    // Identify root modules
    std::set<std::string> instantiated;
    for (const auto& mod : modules_) {
        for (const auto& n : mod.nodes) {
            if (n.kind == "instance" && !n.instanceOf.empty()) {
                instantiated.insert(n.instanceOf);
            }
        }
    }

    std::vector<std::string> roots;
    for (const auto& mod : modules_) {
        if (instantiated.find(mod.name) == instantiated.end()) {
            roots.push_back(mod.name);
        }
    }

    // Sort roots: 'top' first, then alphabetical
    std::sort(roots.begin(), roots.end(), [](const std::string& a, const std::string& b) {
        bool aTop = a.find("top") != std::string::npos || a.find("TOP") != std::string::npos;
        bool bTop = b.find("top") != std::string::npos || b.find("TOP") != std::string::npos;
        if (aTop && !bTop) return true;
        if (!aTop && bTop) return false;
        return a < b;
    });

    json j_modules = json::array();
    for (auto& mod : modules_) {
        buildEdges(mod);

        json j_mod;
        j_mod["name"] = mod.name;
        j_mod["file"] = mod.source.file;

        j_mod["ports"] = json::array();
        for (const auto& p : mod.ports) {
            json j_port = {
                {"name", p.name},
                {"direction", p.direction},
                {"width", p.width},
                {"source", {
                    {"file", p.source.file},
                    {"line", p.source.line},
                    {"col", p.source.col},
                    {"endLine", p.source.endLine},
                    {"endCol", p.source.endCol}
                }}
            };
            if (!p.typeName.empty()) {
                j_port["typeName"] = p.typeName;
                j_port["typeSource"] = {
                    {"file", p.typeSource.file},
                    {"line", p.typeSource.line},
                    {"col", p.typeSource.col},
                    {"endLine", p.typeSource.endLine},
                    {"endCol", p.typeSource.endCol}
                };
            }
            if (!p.modportName.empty()) {
                j_port["modportName"] = p.modportName;
                j_port["modportSource"] = {
                    {"file", p.modportSource.file},
                    {"line", p.modportSource.line},
                    {"col", p.modportSource.col},
                    {"endLine", p.modportSource.endLine},
                    {"endCol", p.modportSource.endCol}
                };
            }
            if (!p.preferredSide.empty()) j_port["preferredSide"] = p.preferredSide;
            j_mod["ports"].push_back(j_port);
        }

        j_mod["nodes"] = json::array();
        for (const auto& n : mod.nodes) {
            json j_ports = json::array();
            for (const auto& np : n.ports) {
                json j_port = {
                    {"name", np.name},
                    {"direction", np.direction},
                    {"signal", np.signal},
                    {"width", np.width}
                };
                if (!np.typeName.empty()) {
                    j_port["typeName"] = np.typeName;
                    j_port["typeSource"] = {
                        {"file", np.typeSource.file},
                        {"line", np.typeSource.line},
                        {"col", np.typeSource.col},
                        {"endLine", np.typeSource.endLine},
                        {"endCol", np.typeSource.endCol}
                    };
                }
                if (!np.modportName.empty()) {
                    j_port["modportName"] = np.modportName;
                    j_port["modportSource"] = {
                        {"file", np.modportSource.file},
                        {"line", np.modportSource.line},
                        {"col", np.modportSource.col},
                        {"endLine", np.modportSource.endLine},
                        {"endCol", np.modportSource.endCol}
                    };
                }
                if (!np.label.empty()) j_port["label"] = np.label;
                if (!np.preferredSide.empty()) j_port["preferredSide"] = np.preferredSide;
                if (!np.source.file.empty()) {
                    j_port["source"] = {
                        {"file", np.source.file},
                        {"line", np.source.line},
                        {"col", np.source.col},
                        {"endLine", np.source.endLine},
                        {"endCol", np.source.endCol}
                    };
                }
                j_ports.push_back(j_port);
            }
            json j_node = {
                {"id", n.id}, {"kind", n.kind}, {"label", n.label}, {"ports", j_ports},
                {"source", {
                    {"file", n.source.file},
                    {"line", n.source.line},
                    {"col", n.source.col},
                    {"endLine", n.source.endLine},
                    {"endCol", n.source.endCol}
                }}
            };
            if (!n.instanceOf.empty()) j_node["instanceOf"] = n.instanceOf;
            if (!n.moduleName.empty()) j_node["moduleName"] = n.moduleName;

            json j_meta = json::object();
            if (!n.metadata.expression.empty()) j_meta["expression"] = n.metadata.expression;
            if (!n.metadata.operation.empty()) j_meta["operation"] = n.metadata.operation;
            if (!n.metadata.resetKind.empty()) j_meta["resetKind"] = n.metadata.resetKind;
            if (!n.metadata.resetKind.empty()) j_meta["resetActiveLow"] = n.metadata.resetActiveLow;
            if (!n.metadata.clockSignal.empty()) j_meta["clockSignal"] = n.metadata.clockSignal;
            if (!n.metadata.resetSignal.empty()) j_meta["resetSignal"] = n.metadata.resetSignal;
            if (n.metadata.isProcedural) j_meta["isProcedural"] = true;
            if (n.metadata.inferred) j_meta["inferred"] = true;
            if (!n.metadata.reason.empty()) j_meta["reason"] = n.metadata.reason;
            if (!n.metadata.role.empty()) j_meta["role"] = n.metadata.role;
            if (n.metadata.repeatCount > 0) j_meta["repeatCount"] = n.metadata.repeatCount;
            if (!n.metadata.repeatExpression.empty()) j_meta["repeatExpression"] = n.metadata.repeatExpression;
            if (!n.metadata.typeName.empty()) {
                j_meta["typeName"] = n.metadata.typeName;
                j_meta["typeSource"] = {
                    {"file", n.metadata.typeSource.file},
                    {"line", n.metadata.typeSource.line},
                    {"col", n.metadata.typeSource.col},
                    {"endLine", n.metadata.typeSource.endLine},
                    {"endCol", n.metadata.typeSource.endCol}
                };
            }
            if (!n.metadata.modportName.empty()) {
                j_meta["modportName"] = n.metadata.modportName;
                j_meta["modportSource"] = {
                    {"file", n.metadata.modportSource.file},
                    {"line", n.metadata.modportSource.line},
                    {"col", n.metadata.modportSource.col},
                    {"endLine", n.metadata.modportSource.endLine},
                    {"endCol", n.metadata.modportSource.endCol}
                };
            }
            if (!n.metadata.aggregateKind.empty()) j_meta["aggregateKind"] = n.metadata.aggregateKind;
            if (n.metadata.packed || !n.metadata.role.empty() || !n.metadata.fields.empty()) {
                j_meta["packed"] = n.metadata.packed;
            }
            if (!n.metadata.fields.empty()) {
                json fields = json::array();
                for (const auto& field : n.metadata.fields) {
                    json j_field;
                    j_field["name"] = field.name;
                    if (!field.width.empty()) j_field["width"] = field.width;
                    if (!field.typeName.empty()) j_field["typeName"] = field.typeName;
                    if (!field.bitRange.empty()) j_field["bitRange"] = field.bitRange;
                    if (!field.direction.empty()) j_field["direction"] = field.direction;
                    if (!field.source.file.empty()) {
                        j_field["source"] = {
                            {"file", field.source.file},
                            {"line", field.source.line},
                            {"col", field.source.col},
                            {"endLine", field.source.endLine},
                            {"endCol", field.source.endCol}
                        };
                    }
                    fields.push_back(j_field);
                }
                j_meta["fields"] = fields;
            }
            if (!j_meta.empty()) {
                j_node.update(j_meta);
                j_node["metadata"] = j_meta;
            }

            j_mod["nodes"].push_back(j_node);
        }
        j_mod["edges"] = json::array();
        for (const auto& e : mod.edges) {
            json j_edge = {
                {"source", e.source}, {"target", e.target},
                {"sourcePort", e.sourcePort}, {"targetPort", e.targetPort},
                {"signal", e.signal}
            };
            if (!e.width.empty()) j_edge["width"] = e.width;
            if (!e.sourceInfo.file.empty()) {
                j_edge["sourceRange"] = {
                    {"file", e.sourceInfo.file},
                    {"line", e.sourceInfo.line},
                    {"col", e.sourceInfo.col},
                    {"endLine", e.sourceInfo.endLine},
                    {"endCol", e.sourceInfo.endCol}
                };
            }
            if (!e.aggregateKind.empty()) {
                j_edge["metadata"] = {{"aggregate", e.aggregateKind}};
            }
            j_mod["edges"].push_back(j_edge);
        }
        j_modules.push_back(j_mod);
    }

    std::map<std::string, StructType> exported_struct_types;
    for (const auto& mod : modules_) {
        for (const auto& entry : mod.structSignals) {
            exported_struct_types[entry.second.type.name] = entry.second.type;
        }
    }
    for (const auto& entry : exported_struct_types) {
        const StructType& type = entry.second;
        json j_ports = json::array();
        for (const auto& field : type.fields) {
            json j_port = {
                {"name", field.name},
                {"direction", "output"},
                {"signal", field.name},
                {"width", field.width},
                {"label", field.name}
            };
            j_ports.push_back(j_port);
        }

        json fields = json::array();
        for (const auto& field : type.fields) {
            json j_field;
            j_field["name"] = field.name;
            if (!field.width.empty()) j_field["width"] = field.width;
            if (!field.bitRange.empty()) j_field["bitRange"] = field.bitRange;
            fields.push_back(j_field);
        }

        json j_mod;
        j_mod["name"] = "struct " + type.name;
        j_mod["file"] = type.source.file;
        j_mod["ports"] = json::array();
        j_mod["nodes"] = json::array({
            {
                {"id", "struct_type:" + type.name},
                {"kind", "struct"},
                {"label", type.name},
                {"ports", j_ports},
                {"role", "type"},
                {"typeName", type.name},
                {"packed", type.packed},
                {"width", type.width},
                {"fields", fields},
                {"metadata", {
                    {"role", "type"},
                    {"typeName", type.name},
                    {"packed", type.packed},
                    {"width", type.width},
                    {"fields", fields}
                }},
                {"source", {
                    {"file", type.source.file},
                    {"line", type.source.line},
                    {"col", type.source.col},
                    {"endLine", type.source.endLine},
                    {"endCol", type.source.endCol}
                }}
            }
        });
        j_mod["edges"] = json::array();
        j_modules.push_back(j_mod);
    }

    for (const auto& entry : interfaceTypes_) {
        const InterfaceType& type = entry.second;
        json j_nodes = json::array();
        json j_edges = json::array();

        if (type.modports.empty()) {
            json j_ports = json::array();
            for (const auto& field : type.fields) {
                json j_port = {
                    {"name", field.name},
                    {"direction", field.direction.empty() ? "output" : field.direction},
                    {"signal", field.name},
                    {"width", field.width},
                    {"label", field.name}
                };
                if (!field.typeName.empty()) j_port["typeName"] = field.typeName;
                if (!field.source.file.empty()) {
                    j_port["source"] = {
                        {"file", field.source.file},
                        {"line", field.source.line},
                        {"col", field.source.col},
                        {"endLine", field.source.endLine},
                        {"endCol", field.source.endCol}
                    };
                }
                j_ports.push_back(j_port);
            }
            j_nodes.push_back({
                {"id", "interface_type:" + type.name},
                {"kind", "interface"},
                {"label", type.name},
                {"ports", j_ports},
                {"role", "type"},
                {"typeName", type.name},
                {"aggregateKind", "interface"},
                {"fields", json::array()},
                {"metadata", {
                    {"role", "type"},
                    {"typeName", type.name},
                    {"aggregateKind", "interface"}
                }},
                {"source", {
                    {"file", type.source.file},
                    {"line", type.source.line},
                    {"col", type.source.col},
                    {"endLine", type.source.endLine},
                    {"endCol", type.source.endCol}
                }}
            });
        } else {
            for (const auto& field : type.fields) {
                if (field.direction != "input" && field.direction != "output") continue;

                json j_port = {
                    {"name", field.name},
                    {"direction", field.direction},
                    {"signal", field.name},
                    {"width", field.width},
                    {"label", field.name}
                };
                if (!field.typeName.empty()) j_port["typeName"] = field.typeName;
                if (!field.source.file.empty()) {
                    j_port["source"] = {
                        {"file", field.source.file},
                        {"line", field.source.line},
                        {"col", field.source.col},
                        {"endLine", field.source.endLine},
                        {"endCol", field.source.endCol}
                    };
                }

                const std::string port_node_id = "port:interface_" + type.name + ":" + field.name;
                j_nodes.push_back({
                    {"id", port_node_id},
                    {"kind", "port"},
                    {"label", field.name},
                    {"ports", json::array({j_port})},
                    {"source", {
                        {"file", field.source.file.empty() ? type.source.file : field.source.file},
                        {"line", field.source.line > 0 ? field.source.line : type.source.line},
                        {"col", field.source.col},
                        {"endLine", field.source.endLine},
                        {"endCol", field.source.endCol}
                    }}
                });

                for (const auto& modport_entry : type.modports) {
                    const InterfaceModport& modport = modport_entry.second;
                    auto modport_field = std::find_if(modport.fields.begin(), modport.fields.end(), [&](const StructField& candidate) {
                        return candidate.name == field.name;
                    });
                    if (modport_field == modport.fields.end()) continue;

                    const std::string modport_node_id = "interface_modport:" + type.name + ":" + modport.name;
                    const std::string modport_direction = modport_field->direction.empty() ? "unknown" : modport_field->direction;
                    if (modport_direction == "output") {
                        j_edges.push_back({
                            {"source", modport_node_id},
                            {"sourcePort", field.name},
                            {"target", port_node_id},
                            {"targetPort", field.name},
                            {"signal", field.name},
                            {"width", field.width}
                        });
                    } else {
                        j_edges.push_back({
                            {"source", port_node_id},
                            {"sourcePort", field.name},
                            {"target", modport_node_id},
                            {"targetPort", field.name},
                            {"signal", field.name},
                            {"width", field.width}
                        });
                    }
                }
            }

            for (const auto& modport_entry : type.modports) {
                const InterfaceModport& modport = modport_entry.second;
                json j_ports = json::array();
                for (const auto& field : modport.fields) {
                    json j_port = {
                        {"name", field.name},
                        {"direction", field.direction.empty() ? "unknown" : field.direction},
                        {"signal", field.name},
                        {"width", field.width},
                        {"label", field.name}
                };
                if (!field.typeName.empty()) j_port["typeName"] = field.typeName;
                if (!field.source.file.empty()) {
                        j_port["source"] = {
                            {"file", field.source.file},
                            {"line", field.source.line},
                            {"col", field.source.col},
                            {"endLine", field.source.endLine},
                            {"endCol", field.source.endCol}
                        };
                    }
                    j_ports.push_back(j_port);
                }
                json fields = json::array();
                for (const auto& field : modport.fields) {
                    json j_field;
                    j_field["name"] = field.name;
                    if (!field.width.empty()) j_field["width"] = field.width;
                    if (!field.typeName.empty()) j_field["typeName"] = field.typeName;
                    if (!field.direction.empty()) j_field["direction"] = field.direction;
                    fields.push_back(j_field);
                }
                j_nodes.push_back({
                    {"id", "interface_modport:" + type.name + ":" + modport.name},
                    {"kind", "interface"},
                    {"label", type.name},
                    {"ports", j_ports},
                    {"role", "modport"},
                    {"typeName", type.name},
                    {"modportName", modport.name},
                    {"preferredSide", modport.preferredSide},
                    {"aggregateKind", "interface"},
                    {"fields", fields},
                    {"metadata", {
                        {"role", "modport"},
                        {"typeName", type.name},
                        {"modportName", modport.name},
                        {"preferredSide", modport.preferredSide},
                        {"aggregateKind", "interface"},
                        {"fields", fields},
                        {"modportSource", {
                            {"file", modport.source.file},
                            {"line", modport.source.line},
                            {"col", modport.source.col},
                            {"endLine", modport.source.endLine},
                            {"endCol", modport.source.endCol}
                        }}
                    }},
                    {"source", {
                        {"file", modport.source.file.empty() ? type.source.file : modport.source.file},
                        {"line", modport.source.line > 0 ? modport.source.line : type.source.line},
                        {"col", modport.source.col},
                        {"endLine", modport.source.endLine},
                        {"endCol", modport.source.endCol}
                    }}
                });
            }
        }

        json j_mod;
        j_mod["name"] = "interface " + type.name;
        j_mod["file"] = type.source.file;
        j_mod["ports"] = json::array();
        j_mod["nodes"] = j_nodes;
        j_mod["edges"] = j_edges;
        j_modules.push_back(j_mod);
    }

    json result = {{"modules", j_modules}};
    result["rootModules"] = roots;
    return result;
}
