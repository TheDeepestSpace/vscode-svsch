namespace {

std::string stripCallableWorkPrefix(std::string name) {
    if (name.rfind("work@", 0) == 0) name = name.substr(5);
    return name;
}

std::string callableName(vpiHandle handle) {
    const char* name = handle ? vpi_get_str(vpiName, handle) : nullptr;
    return stripCallableWorkPrefix(name ? name : "unnamed");
}

std::string callableId(const std::string& module_name, const std::string& name) {
    return module_name + "." + name;
}

std::string portDirection(int direction) {
    if (direction == vpiInput) return "input";
    if (direction == vpiOutput) return "output";
    if (direction == vpiInout) return "inout";
    return "unknown";
}

} // namespace

std::string DesignExtractor::getCallableWidth(vpiHandle handle) {
    if (!handle) return "";
    std::string width = getWidth(handle);
    if (!width.empty() && width != "[0:0]") return width;
    // Surelog hangs an ANSI task/function argument's declared typespec off
    // vpiTypedef -> vpiActual, rather than vpiTypespec on the io_decl itself.
    vpiHandle ref_typespec = vpi_handle(vpiTypedef, handle);
    vpiHandle actual_typespec = ref_typespec ? vpi_handle(vpiActual, ref_typespec) : nullptr;
    std::string declared = getWidth(actual_typespec);
    if (!declared.empty() && declared != "[0:0]") return declared;

    // Some serialized UHDM builds preserve the typespec's source span but
    // not its range relation. Recover the declaration text as a last resort.
    SourceInfo source = getSourceInfo(handle);
    std::string line = sourceLineText(source);
    std::smatch match;
    if (std::regex_search(line, match, std::regex(R"(\[[^\]]+\])"))) {
        return match[0].str();
    }
    return declared.empty() ? width : declared;
}

void DesignExtractor::collectTaskFunctions(vpiHandle module_handle, const std::string& module_name) {
    vpiHandle itr = vpi_iterate(vpiTaskFunc, module_handle);
    if (!itr) return;
    while (vpiHandle callable = vpi_scan(itr)) {
        const int type = vpi_get(vpiType, callable);
        if (type == vpiFunction || type == vpiTask) {
            processCallableDeclaration(callable, module_name);
        }
    }
    vpi_release_handle(itr);
}

void DesignExtractor::processCallableDeclaration(vpiHandle callable_handle, const std::string& module_name) {
    const int callable_type = vpi_get(vpiType, callable_handle);
    const std::string name = callableName(callable_handle);
    const std::string id = callableId(module_name, name);
    if (std::any_of(callables_.begin(), callables_.end(), [&](const Module& existing) {
        return existing.name == id;
    })) {
        return;
    }

    Module body;
    body.name = id;
    body.callableKind = callable_type == vpiFunction ? "function" : "task";
    body.callableName = name;
    body.parentModule = module_name;
    body.source = getSourceInfo(callable_handle);

    vpiHandle io_itr = vpi_iterate(vpiIODecl, callable_handle);
    if (io_itr) {
        while (vpiHandle io = vpi_scan(io_itr)) {
            Port port;
            port.name = callableName(io);
            port.direction = portDirection(vpi_get(vpiDirection, io));
            port.width = getCallableWidth(io);
            if (port.width.empty()) port.width = "[0:0]";
            port.widthExpression = getRangeExpression(io);
            port.source = getSourceInfo(io);
            port.typeName = getTypeName(io);
            if (!port.typeName.empty()) port.typeSource = getTypeSource(io);
            body.ports.push_back(port);
            body.internalSignals.insert(port.name);
            body.declarationOrder[port.name] = static_cast<int>(body.declarationOrder.size());
        }
        vpi_release_handle(io_itr);
    }

    if (callable_type == vpiFunction) {
        vpiHandle return_handle = vpi_handle(vpiReturn, callable_handle);
        Port result;
        // The return variable's HDL name is the function name. Keeping that
        // name at the body boundary lets the normal edge builder connect a
        // `foo = ...` assignment directly to the return port.
        result.name = name;
        result.direction = "output";
        result.width = getCallableWidth(return_handle ? return_handle : callable_handle);
        if (result.width.empty()) result.width = "[0:0]";
        result.source = getSourceInfo(return_handle ? return_handle : callable_handle);
        result.typeName = getTypeName(return_handle);
        if (!result.typeName.empty()) result.typeSource = getTypeSource(return_handle);
        body.ports.push_back(result);
        body.internalSignals.insert(result.name);
        body.declarationOrder[result.name] = static_cast<int>(body.declarationOrder.size());
    }

    // Include local variables so ordinary signal matching and width lookup
    // work inside non-trivial combinational functions/tasks too.
    for (int var_type : {vpiNet, vpiReg, vpiVariables, vpiIODecl}) {
        vpiHandle var_itr = vpi_iterate(var_type, callable_handle);
        if (!var_itr) continue;
        while (vpiHandle variable = vpi_scan(var_itr)) {
            std::string variable_name = getSignalName(variable);
            if (variable_name.empty()) variable_name = callableName(variable);
            if (variable_name.empty()) continue;
            body.internalSignals.insert(variable_name);
            if (!body.declarationOrder.count(variable_name)) {
                body.declarationOrder[variable_name] = static_cast<int>(body.declarationOrder.size());
            }
        }
        vpi_release_handle(var_itr);
    }

    vpiHandle stmt = vpi_handle(vpiStmt, callable_handle);
    if (stmt) {
        // Null marks a combinational callable scope; processStatement uses it
        // to avoid module-process `_next` artifacts for direct assignments.
        processStatement(stmt, body, nullptr);
    }
    // Expression lowering does not always retain the typespec on an operand
    // reference. Callable boundary declarations are authoritative, so carry
    // their widths onto internal node ports before buildEdges connects them.
    for (auto& node : body.nodes) {
        for (auto& node_port : node.ports) {
            if (!node_port.width.empty() && node_port.width != "[0:0]") continue;
            auto boundary = std::find_if(body.ports.begin(), body.ports.end(), [&](const Port& port) {
                return port.name == node_port.signal;
            });
            if (boundary != body.ports.end()) node_port.width = boundary->width;
        }
    }
    synthesizePendingStructCompositions(body);
    callables_.push_back(std::move(body));
}

std::string DesignExtractor::promoteFunctionCallExpr(
    vpiHandle call_handle,
    Module& mod,
    const std::string& preferred_name,
    bool is_procedural,
    const std::map<std::string, LoweredValue>& current_drivers
) {
    if (!call_handle) return "";
    vpiHandle declaration = vpi_handle(vpiFunction, call_handle);
    const std::string name = callableName(declaration ? declaration : call_handle);
    const std::string id = callableId(mod.parentModule.empty() ? mod.name : mod.parentModule, name);
    SourceInfo source = getSourceInfo(call_handle);
    std::string output_signal = preferred_name.empty()
        ? sanitizeId(name + "_call_" + std::to_string(source.line) + "_" + std::to_string(source.col))
        : preferred_name;
    const std::string node_id = sanitizeId(
        "funcCall:" + mod.name + ":" + name + ":" + std::to_string(source.line) + ":" + std::to_string(source.col)
    );
    for (const auto& existing : mod.nodes) {
        if (existing.id == node_id) return output_signal;
    }

    struct Formal {
        std::string name;
        std::string direction;
        std::string width;
        SourceInfo source;
    };
    std::vector<Formal> formals;
    vpiHandle formal_itr = declaration ? vpi_iterate(vpiIODecl, declaration) : nullptr;
    if (formal_itr) {
        while (vpiHandle formal = vpi_scan(formal_itr)) {
            std::string width = getCallableWidth(formal);
            if (width.empty()) width = "[0:0]";
            formals.push_back({
                callableName(formal),
                portDirection(vpi_get(vpiDirection, formal)),
                width,
                getSourceInfo(formal)
            });
        }
        vpi_release_handle(formal_itr);
    }

    Node node;
    node.id = node_id;
    node.kind = "funcCall";
    node.label = name;
    node.functionName = name;
    node.functionId = id;
    node.source = source;
    node.metadata.expression = getExprText(call_handle);
    node.metadata.isProcedural = is_procedural;

    vpiHandle arg_itr = vpi_iterate(vpiArgument, call_handle);
    size_t index = 0;
    if (arg_itr) {
        while (vpiHandle argument = vpi_scan(arg_itr)) {
            const Formal formal = index < formals.size()
                ? formals[index]
                : Formal{"arg" + std::to_string(index), "input", getWidth(argument), getSourceInfo(argument)};
            std::string signal;
            if (formal.direction == "output") {
                signal = getSignalName(argument, current_drivers);
            } else if (isLiteralExpr(argument)) {
                signal = getLiteralLabel(argument);
                ensureLiteralNode(argument, mod, signal, formal.width, call_handle, signal);
            } else {
                signal = getOrPromoteExpr(
                    argument,
                    mod,
                    output_signal + "_" + formal.name,
                    is_procedural,
                    current_drivers
                );
            }
            NodePort port{formal.name, formal.direction, signal, formal.width, formal.name};
            port.source = formal.source;
            node.ports.push_back(port);
            index++;
        }
        vpi_release_handle(arg_itr);
    }

    std::string return_width = getWidth(call_handle);
    if ((return_width.empty() || return_width == "[0:0]") && declaration) {
        vpiHandle return_handle = vpi_handle(vpiReturn, declaration);
        std::string declared_width = getCallableWidth(return_handle ? return_handle : declaration);
        if (!declared_width.empty()) return_width = declared_width;
    }
    if (return_width.empty()) return_width = "[0:0]";
    node.ports.push_back({name, "output", output_signal, return_width, "return"});
    mod.nodes.push_back(std::move(node));
    return output_signal;
}

void DesignExtractor::processTaskCall(vpiHandle call_handle, Module& mod, bool is_procedural) {
    if (!call_handle) return;
    vpiHandle declaration = vpi_handle(vpiTask, call_handle);
    const std::string name = callableName(declaration ? declaration : call_handle);
    const std::string id = callableId(mod.parentModule.empty() ? mod.name : mod.parentModule, name);
    SourceInfo source = getSourceInfo(call_handle);

    Node node;
    node.id = sanitizeId(
        "taskCall:" + mod.name + ":" + name + ":" + std::to_string(source.line) + ":" + std::to_string(source.col)
    );
    node.kind = "taskCall";
    node.label = name;
    node.taskName = name;
    node.taskId = id;
    node.source = source;
    node.metadata.expression = getExprText(call_handle);
    node.metadata.isProcedural = is_procedural;

    std::vector<vpiHandle> formals;
    vpiHandle formal_itr = declaration ? vpi_iterate(vpiIODecl, declaration) : nullptr;
    if (formal_itr) {
        while (vpiHandle formal = vpi_scan(formal_itr)) formals.push_back(formal);
        vpi_release_handle(formal_itr);
    }

    vpiHandle arg_itr = vpi_iterate(vpiArgument, call_handle);
    size_t index = 0;
    if (arg_itr) {
        while (vpiHandle argument = vpi_scan(arg_itr)) {
            vpiHandle formal = index < formals.size() ? formals[index] : nullptr;
            const std::string formal_name = formal ? callableName(formal) : "arg" + std::to_string(index);
            const std::string direction = formal ? portDirection(vpi_get(vpiDirection, formal)) : "input";
            std::string width = formal ? getCallableWidth(formal) : getWidth(argument);
            if (width.empty()) width = "[0:0]";
            std::string signal;
            if (direction == "output") {
                signal = getSignalName(argument);
            } else if (isLiteralExpr(argument)) {
                signal = getLiteralLabel(argument);
                ensureLiteralNode(argument, mod, signal, width, call_handle, signal);
            } else {
                signal = getOrPromoteExpr(argument, mod, name + "_" + formal_name, is_procedural);
            }
            node.ports.push_back({formal_name, direction, signal, width, formal_name});
            index++;
        }
        vpi_release_handle(arg_itr);
    }
    mod.nodes.push_back(std::move(node));
}
