void DesignExtractor::buildEdges(Module& mod) {
    std::map<std::string, std::vector<std::pair<std::string, std::string>>> signal_map;
    for (const auto& n : mod.nodes) {
        for (const auto& p : n.ports) {
            if (!p.signal.empty()) signal_map[p.signal].push_back({n.id, p.name});
        }
    }
    for (auto const& [signal, ports] : signal_map) {
        if (mod.interfaceSignals.count(signal)) continue;
        std::vector<std::pair<std::string, std::string>> drivers, loads;
        for (const auto& n : mod.nodes) {
            for (const auto& p : n.ports) {
                if (p.signal == signal) {
                    if (p.direction == "output") drivers.push_back({n.id, p.name});
                    else if (p.direction == "input") loads.push_back({n.id, p.name});
                    else if (p.direction == "inout") {
                        drivers.push_back({n.id, p.name});
                        loads.push_back({n.id, p.name});
                    }
                }
            }
        }
        for (const auto& p : mod.ports) {
            if (p.name == signal) {
                if (p.direction == "input") drivers.push_back({"self", p.name});
                else if (p.direction == "output") loads.push_back({"self", p.name});
                else if (p.direction == "inout") {
                    drivers.push_back({"self", p.name});
                    loads.push_back({"self", p.name});
                }
            }
        }
        
        for (const auto& d : drivers) {
            std::string edge_width = "";
            if (d.first == "self") {
                for (const auto& p : mod.ports) if (p.name == d.second) {
                    edge_width = p.width;
                    break;
                }
            } else {
                for (const auto& n : mod.nodes) if (n.id == d.first) {
                    for (const auto& p : n.ports) if (p.name == d.second) {
                        edge_width = p.width;
                        break;
                    }
                    break;
                }
            }

            for (const auto& l : loads) {
                if (d.first == l.first && d.second == l.second) continue;
                Edge e; e.source = d.first; e.sourcePort = d.second; e.target = l.first; e.targetPort = l.second; e.signal = signal;
                e.width = edge_width;
                if (mod.interfaceSignals.count(signal)) {
                    e.aggregateKind = "interface";
                }
                bool duplicate = false;
                for (const auto& existing : mod.edges) {
                    if (existing.source == e.source && existing.target == e.target &&
                        existing.sourcePort == e.sourcePort && existing.targetPort == e.targetPort) { duplicate = true; break; }
                }
                bool is_bus_selection_signal = (signal.find('[') != std::string::npos && signal.find(']') != std::string::npos);

                if (!duplicate) {
                    if (d.first == "self" && l.first == "self" && is_bus_selection_signal) {
                        // Skip creating edge for direct port-to-port connection if it's a bus selection signal
                        // This prevents extraneous direct connections as per test expectations.
                    } else {
                        mod.edges.push_back(e);
                    }
                }
            }
        }
    }
}

std::string DesignExtractor::getSignalName(vpiHandle handle, const std::map<std::string, LoweredValue>& current_drivers) {
    std::string base_name = getSignalName(handle);
    if (current_drivers.count(base_name)) {
        return current_drivers.at(base_name).signal;
    }
    // Check if it's a part select/bit select and the base has a current driver
    std::string base = getBaseSignalName(handle);
    if (!base.empty() && base != base_name && current_drivers.count(base)) {
        return current_drivers.at(base).signal;
    }
    return base_name;
}

std::string DesignExtractor::getSignalName(vpiHandle handle) {
    if (!handle) return "";
    int type = vpi_get(vpiType, handle);

    if (type == 608) { // vpiRefObj
        vpiHandle actual = vpi_handle(vpiActual, handle);
        if (actual && actual != handle) return getSignalName(actual);
    }
    if (type == vpiOperation) {
        int op_type = vpi_get(vpiOpType, handle);
        if (op_type == 39 || op_type == 40) {
             vpiHandle operand_itr = vpi_iterate(vpiOperand, handle);
             if (operand_itr) {
                 vpiHandle op = vpi_scan(operand_itr);
                 std::string name = getSignalName(op);
                 vpi_release_handle(operand_itr);
                 return name;
             }
        }
        return "expr";
    }
    if (type == vpiBitSelect || type == vpiPartSelect || type == 606 || type == 607 || type == 130) {
        const char* d = vpi_get_str(vpiDecompile, handle);
        if (d && strlen(d) > 0 && strchr(d, '[')) {
            std::string s = d;
            if (s.rfind("work@", 0) == 0) s = s.substr(5);
            return s;
        }

        std::string base = getBaseSignalName(handle);

        if (!base.empty()) {
            vpiHandle left_h = vpi_handle(vpiLeftRange, handle);
            vpiHandle right_h = vpi_handle(vpiRightRange, handle);
            if (!left_h && (type == vpiBitSelect || type == 606 || type == 607 || type == 130)) left_h = vpi_handle(vpiIndex, handle);
            if (!left_h && (type == 606 || type == 607 || type == 130)) left_h = vpi_handle(vpiBaseExpr, handle);

            std::string l = left_h ? getExprText(left_h) : "";
            std::string r = right_h ? getExprText(right_h) : "";

            if (l.empty() || l == "const" || l == "?") {
                if (type == vpiBitSelect) {
                    int idx = vpi_get(vpiIndex, handle);
                    if (idx != vpiUndefined) l = std::to_string(idx);
                } else {
                    int lv = vpi_get(vpiLeftRange, handle);
                    if (lv != vpiUndefined) l = std::to_string(lv);
                }
            }
            if (r.empty() || r == "const" || r == "?") {
                if (type == 606 || type == 607 || type == 130) {
                    vpiHandle width_h = vpi_handle(vpiWidthExpr, handle);
                    if (width_h) r = getExprText(width_h);
                } else {
                    int rv = vpi_get(vpiRightRange, handle);
                    if (rv != vpiUndefined) r = std::to_string(rv);
                }
            }

            if (type == vpiBitSelect) {
                return base + "[" + (l.empty() || l == "?" ? "bit" : l) + "]";
            } else if (type == 606 || type == 607 || type == 130) {
                // Approximate representation if decompile fails
                return base + "[" + (l.empty() || l == "?" ? "idx" : l) + "+:" + (r.empty() || r == "?" ? "width" : r) + "]";
            } else {
                return base + "[" + (l.empty() || l == "?" ? "0" : l) + ":" + (r.empty() || r == "?" ? "0" : r) + "]";
            }
        } else {
            std::string name = vpi_get_str(vpiName, handle);
            if (name.empty()) name = vpi_get_str(vpiFullName, handle);
            if (name.empty()) name = "bus";
            return name;
        }
    }

    const char* name = vpi_get_str(vpiName, handle);
    const char* def_name = vpi_get_str(vpiDefName, handle);
    const char* full_name = vpi_get_str(vpiFullName, handle);

    if (!name || strlen(name) == 0) name = def_name;

    if (name && strlen(name) > 0) {
        std::string s = name;
        if (s.rfind("work@", 0) == 0) s = s.substr(5);
        return s;
    }

    if (type == vpiConstant) {
        const char* val = vpi_get_str(vpiDecompile, handle);
        if (val) return val;

        s_vpi_value value;
        value.format = vpiDecStrVal;
        vpi_get_value(handle, &value);
        if (value.format != vpiSuppressVal && value.value.str) {
            return value.value.str;
        }

        return "const";
    }
    return "";
}

std::string DesignExtractor::getBaseSignalName(vpiHandle handle) {
    if (!handle) return "";
    int type = vpi_get(vpiType, handle);

    if (type == vpiBitSelect || type == vpiPartSelect) {
        const char* name = vpi_get_str(vpiName, handle);
        if (name && strlen(name) > 0) {
            std::string s = name;
            if (s.rfind("work@", 0) == 0) s = s.substr(5);
            return s;
        }

        vpiHandle expr = vpi_handle(vpiExpr, handle);
        if (expr) return getBaseSignalName(expr);

        vpiHandle parent = vpi_handle(vpiParent, handle);
        if (parent && parent != handle && vpi_get(vpiType, parent) != vpiAssignment && vpi_get(vpiType, parent) != 84 && vpi_get(vpiType, parent) != 85 && vpi_get(vpiType, parent) != vpiModule && vpi_get(vpiType, parent) != vpiContAssign) {
            return getBaseSignalName(parent);
        }

        vpiHandle op_itr = vpi_iterate(vpiOperand, handle);
        if (op_itr) {
            vpiHandle op = vpi_scan(op_itr);
            vpi_release_handle(op_itr);
            if (op) return getBaseSignalName(op);
        }
    }

    if (type == 608) { // vpiRefObj
        vpiHandle actual = vpi_handle(vpiActual, handle);
        if (actual && actual != handle) return getBaseSignalName(actual);
    }

    const char* name = vpi_get_str(vpiName, handle);
    if (name && strlen(name) > 0) {
        std::string s = name;
        if (s.rfind("work@", 0) == 0) s = s.substr(5);
        return s;
    }
    return "";
}
std::string DesignExtractor::getWidth(vpiHandle handle) {
    if (!handle || width_depth_ > 10) return "";
    width_depth_++;
    int type = vpi_get(vpiType, handle);
    // std::cerr << "[DEBUG] getWidth type=" << type << " name=" << (vpi_get_str(vpiName, handle) ? vpi_get_str(vpiName, handle) : "?") << std::endl;

    if (type == 608) { // vpiRefObj
        vpiHandle actual = vpi_handle(vpiActual, handle);
        if (actual && actual != handle) {
            std::string res = getWidth(actual);
            if (!res.empty()) {
                width_depth_--;
                return res;
            }
        }
    }

    auto try_extract_range = [&](vpiHandle h) -> std::string {
        vpiHandle range_itr = vpi_iterate(vpiRange, h);
        if (range_itr) {
            vpiHandle r = vpi_scan(range_itr);
            vpi_release_handle(range_itr);
            if (r) {
                int left = vpi_get(vpiLeftRange, r);
                int right = vpi_get(vpiRightRange, r);
                if (left != vpiUndefined && right != vpiUndefined) {
                    return "[" + std::to_string(left) + ":" + std::to_string(right) + "]";
                }
            }
        }

        int left = vpi_get(vpiLeftRange, h);
        int right = vpi_get(vpiRightRange, h);
        if (left != vpiUndefined && right != vpiUndefined) {
            if (left == 0 && right == 0) {
                int s = vpi_get(vpiSize, h);
                if (s > 1) return "[" + std::to_string(s - 1) + ":0]";
            }
            return "[" + std::to_string(left) + ":" + std::to_string(right) + "]";
        }
        vpiHandle ts = vpi_handle(vpiTypespec, h);
        if (ts) {
            vpiHandle ts_range_itr = vpi_iterate(vpiRange, ts);
            if (ts_range_itr) {
                vpiHandle r = vpi_scan(ts_range_itr);
                vpi_release_handle(ts_range_itr);
                if (r) {
                    int left = vpi_get(vpiLeftRange, r);
                    int right = vpi_get(vpiRightRange, r);
                    if (left != vpiUndefined && right != vpiUndefined) {
                        return "[" + std::to_string(left) + ":" + std::to_string(right) + "]";
                    }
                }
            }

            int ts_left = vpi_get(vpiLeftRange, ts);
            int ts_right = vpi_get(vpiRightRange, ts);
            if (ts_left != vpiUndefined && ts_right != vpiUndefined) {
                return "[" + std::to_string(ts_left) + ":" + std::to_string(ts_right) + "]";
            }
            int ts_size = vpi_get(vpiSize, ts);
            if (ts_size > 1) {
                return "[" + std::to_string(ts_size - 1) + ":0]";
            }
        }
        return "";
    };

    std::string range = try_extract_range(handle);
    if (!range.empty()) {
        width_depth_--;
        return range;
    }

    int size = vpi_get(vpiSize, handle);
    if (size > 1) {
        width_depth_--;
        return "[" + std::to_string(size - 1) + ":0]";
    }

    if (type == vpiBitSelect) {
        int idx = vpi_get(vpiIndex, handle);
        if (idx != vpiUndefined) {
            width_depth_--;
            return "[" + std::to_string(idx) + ":" + std::to_string(idx) + "]";
        }
    }

    // Try parent for selects
    if (type == vpiBitSelect || type == vpiPartSelect) {
        vpiHandle parent = vpi_handle(vpiParent, handle);
        if (parent && parent != handle && vpi_get(vpiType, parent) != vpiModule && vpi_get(vpiType, parent) != vpiContAssign) {
            std::string w = getWidth(parent);
            if (!w.empty()) {
                width_depth_--;
                return w;
            }
        }
    }

    // Try operands
    vpiHandle op_itr = vpi_iterate(vpiOperand, handle);
    if (op_itr) {
        vpiHandle op = vpi_scan(op_itr);
        if (op) {
            std::string w = getWidth(op);
            vpi_release_handle(op_itr);
            if (!w.empty()) {
                width_depth_--;
                return w;
            }
        } else {
            vpi_release_handle(op_itr);
        }
    }

    // Try Ranges
    vpiHandle range_itr = vpi_iterate(vpiRange, handle);
    if (range_itr) {
        vpiHandle range = vpi_scan(range_itr);
        if (range) {
             int l = vpi_get(vpiLeftRange, range);
             int r = vpi_get(vpiRightRange, range);
             vpi_release_handle(range_itr);
             if (l != vpiUndefined && r != vpiUndefined) {
                 width_depth_--;
                 return "[" + std::to_string(l) + ":" + std::to_string(r) + "]";
             }
        } else {
            vpi_release_handle(range_itr);
        }
    }

    // Try Typespec
    vpiHandle ts = vpi_handle(vpiTypespec, handle);
    if (ts) {
        int ts_size = vpi_get(vpiSize, ts);
        if (ts_size > 1) {
            width_depth_--;
            return "[" + std::to_string(ts_size-1) + ":0]";
        }
        
        int ts_left = vpi_get(vpiLeftRange, ts);
        int ts_right = vpi_get(vpiRightRange, ts);
        if (ts_left != vpiUndefined && ts_right != vpiUndefined && (ts_left != 0 || ts_right != 0)) {
            width_depth_--;
            return "[" + std::to_string(ts_left) + ":" + std::to_string(ts_right) + "]";
        }
    }

    // Fallback to decompile for cases where size might be reported as 0 or 1 but it's a slice
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == vpiBitSelect || type == vpiPartSelect || type == 44) {
        const char* d = vpi_get_str(vpiDecompile, handle);
        if (d) {
             std::string s = d; size_t pos = s.find('[');
             if (pos != std::string::npos) {
                 std::string range = s.substr(pos);
                 if (range.find(':') != std::string::npos || (range.find(']') != std::string::npos && range.size() > 2)) {
                     width_depth_--;
                     return range;
                 }
             }
        }
    }

    width_depth_--;
    return "";
}

std::string DesignExtractor::getRangeExpression(vpiHandle handle) {
    if (!handle) return "";

    auto range_from = [&](vpiHandle h) -> std::string {
        if (!h) return "";

        vpiHandle range_itr = vpi_iterate(vpiRange, h);
        if (range_itr) {
            vpiHandle r = vpi_scan(range_itr);
            vpi_release_handle(range_itr);
            if (r) {
                vpiHandle left_expr = vpi_handle(vpiLeftRange, r);
                vpiHandle right_expr = vpi_handle(vpiRightRange, r);
                std::string left = getExprText(left_expr);
                std::string right = getExprText(right_expr);
                if (left.empty()) {
                    int value = vpi_get(vpiLeftRange, r);
                    if (value != vpiUndefined) left = std::to_string(value);
                }
                if (right.empty()) {
                    int value = vpi_get(vpiRightRange, r);
                    if (value != vpiUndefined) right = std::to_string(value);
                }
                if (!left.empty() && !right.empty() && (left != "0" || right != "0")) {
                    return "[" + trimCopy(left) + ":" + trimCopy(right) + "]";
                }
            }
        }

        vpiHandle left_expr = vpi_handle(vpiLeftRange, h);
        vpiHandle right_expr = vpi_handle(vpiRightRange, h);
        std::string left = getExprText(left_expr);
        std::string right = getExprText(right_expr);
        if (!left.empty() && !right.empty() && (left != "0" || right != "0")) {
            return "[" + trimCopy(left) + ":" + trimCopy(right) + "]";
        }
        return "";
    };

    std::string range = range_from(handle);
    if (!range.empty()) return range;

    vpiHandle ts = vpi_handle(vpiTypespec, handle);
    if (ts) {
        range = range_from(ts);
        if (!range.empty()) return range;

        int ts_type = vpi_get(vpiType, ts);
        if (ts_type == 608 || ts_type == vpiRefTypespec) {
            vpiHandle actual = vpi_handle(vpiActual, ts);
            range = range_from(actual);
            if (!range.empty()) return range;
        }
    }

    const char* decompile = vpi_get_str(vpiDecompile, handle);
    if (decompile) {
        std::string text = decompile;
        size_t open = text.find('[');
        size_t close = text.find(']', open == std::string::npos ? 0 : open);
        if (open != std::string::npos && close != std::string::npos && close > open) {
            return text.substr(open, close - open + 1);
        }
    }

    return "";
}

std::string DesignExtractor::getTypeName(vpiHandle handle) {
    if (!handle) return "";
    int type = vpi_get(vpiType, handle);

    if (type == vpiEnumTypespec || type == vpiStructTypespec) {
         const char* name = vpi_get_str(vpiName, handle);
         if (name && strlen(name) > 0) {
             std::string s = name;
             if (s.rfind("work@", 0) == 0) s = s.substr(5);
             if (s != "enum" && s != "struct") return s;
         }
    }

    vpiHandle ts = vpi_handle(vpiTypespec, handle);
    if (!ts) ts = vpi_handle(vpiTypedef, handle);
    if (!ts) {
        if (type == 608) { // vpiRefObj
             vpiHandle actual = vpi_handle(vpiActual, handle);
             if (actual && actual != handle) return getTypeName(actual);
        }
        return "";
    }

    int ts_type = vpi_get(vpiType, ts);

    // Follow ref typespecs
    if (ts_type == 608 || ts_type == vpiRefTypespec) {
        vpiHandle actual = vpi_handle(vpiActual, ts);
        if (actual && actual != ts) {
            std::string name = getTypeName(actual);
            if (!name.empty()) return name;
        }
    }

    const char* name = vpi_get_str(vpiName, ts);
    if (name && strlen(name) > 0) {
        std::string s = name;
        if (s.rfind("work@", 0) == 0) s = s.substr(5);
        if (s != "logic" && s != "reg" && s != "wire" && s != "struct" && s != "enum" && s != "int" && s != "integer" && s != "bit") {
            return s;
        }
    }

    // Try to get name from the typedef if it's a typespec
    vpiHandle td = vpi_handle(vpiTypedef, ts);
    if (!td) td = vpi_handle(vpiParent, ts);
    if (td && vpi_get(vpiType, td) == vpiTypedef) {
        const char* td_name = vpi_get_str(vpiName, td);
        if (td_name && strlen(td_name) > 0) {
            std::string s = td_name;
            if (s.rfind("work@", 0) == 0) s = s.substr(5);
            return s;
        }
    }

    return "";
}

SourceInfo DesignExtractor::getTypeSource(vpiHandle handle) {
    if (!handle) return {};
    int type = vpi_get(vpiType, handle);

    if (type == vpiEnumTypespec || type == vpiStructTypespec) {
         SourceInfo src = getSourceInfo(handle);
         if (!src.file.empty() && src.line > 0) return src;
    }

    vpiHandle ts = vpi_handle(vpiTypespec, handle);
    if (!ts) ts = vpi_handle(vpiTypedef, handle);
    if (!ts) {
        if (type == 608) { // vpiRefObj
             vpiHandle actual = vpi_handle(vpiActual, handle);
             if (actual && actual != handle) return getTypeSource(actual);
        }
        return {};
    }

    // Try to get source from the typedef if it's a typespec
    vpiHandle td = vpi_handle(vpiTypedef, ts);
    if (!td) td = vpi_handle(vpiParent, ts);
    if (td && vpi_get(vpiType, td) == vpiTypedef) {
        SourceInfo src = getSourceInfo(td);
        if (!src.file.empty() && src.line > 0) return src;
    }

    // Follow ref typespecs
    int ts_type = vpi_get(vpiType, ts);
    if (ts_type == 608 || ts_type == vpiRefTypespec) {
        vpiHandle actual = vpi_handle(vpiActual, ts);
        if (actual && actual != ts) {
            SourceInfo src = getTypeSource(actual);
            if (!src.file.empty()) return src;
        }
    }

    return getSourceInfo(ts);
}

std::string DesignExtractor::getFile(vpiHandle handle) {
    const char* file = vpi_get_str(vpiFile, handle);
    if (!file || strlen(file) == 0) file = vpi_get_str(vpiDefFile, handle);
    return file ? file : "";
}

int DesignExtractor::getLine(vpiHandle handle) {
    int line = vpi_get(vpiLineNo, handle);
    if (line > 0) return line;
    
    // Try parent
    vpiHandle parent = vpi_handle(vpiParent, handle);
    if (parent && parent != handle) {
        return getLine(parent);
    }
    return 0;
}

int DesignExtractor::getCol(vpiHandle handle) {
    int col = vpi_get(vpiColumnNo, handle);
    return col > 0 ? col - 1 : 0;
}

int DesignExtractor::getEndLine(vpiHandle handle) { return vpi_get(vpiEndLineNo, handle); }

int DesignExtractor::getEndCol(vpiHandle handle) {
    int col = vpi_get(vpiEndColumnNo, handle);
    return col > 0 ? col - 1 : 0;
}

SourceInfo DesignExtractor::getSourceInfo(vpiHandle handle) {
    if (!handle || source_depth_ > 10) return SourceInfo();
    source_depth_++;
    
    // NOTE: Do not follow vpiActual for vpiRefObj here, 
    // as vpiRefObj has the source info of the USAGE, 
    // while vpiActual has the source info of the DECLARATION.

    SourceInfo s;
    s.file = getFile(handle);
    s.line = getLine(handle);
    s.col = getCol(handle);
    s.endLine = getEndLine(handle);
    s.endCol = getEndCol(handle);
    
    source_depth_--;
    return s;
}

void DesignExtractor::refineSourceInfo(SourceInfo& src, vpiHandle handle) {
    if (!handle || vpi_get(vpiType, handle) != vpiOperation) return;

    vpiHandle op_itr = vpi_iterate(vpiOperand, handle);
    if (!op_itr) return;

    int min_l = 0, min_c = 0, max_el = 0, max_ec = 0;
    bool first = true;
    while (vpiHandle op = vpi_scan(op_itr)) {
        SourceInfo op_src = getSourceInfo(op);
        
        // If child is an operation, it might have an inherited range.
        // Try to refine it before using it in our hull.
        if (vpi_get(vpiType, op) == vpiOperation) {
            refineSourceInfo(op_src, op);
        }

        // HEURISTIC: If child range is identical to parent's, it's likely inherited.
        // Ignore it for refinement if we have other choices.
        if (op_src.line == src.line && op_src.col == src.col && 
            op_src.endLine == src.endLine && op_src.endCol == src.endCol) {
            continue;
        }

        if (op_src.line > 0) {
            if (first || op_src.line < min_l || (op_src.line == min_l && op_src.col < min_c)) {
                min_l = op_src.line;
                min_c = op_src.col;
            }
            if (first || op_src.endLine > max_el || (op_src.endLine == max_el && op_src.endCol > max_ec)) {
                max_el = op_src.endLine;
                max_ec = op_src.endCol;
            }
            first = false;
        }
    }
    vpi_release_handle(op_itr);

    if (!first) {
        // Refine start if hull starts later
        if (min_l > src.line || (min_l == src.line && min_c > src.col)) {
            src.line = min_l;
            src.col = min_c;
        }
        // Refine end if hull ends earlier
        if (max_el > 0 && (src.endLine == 0 || max_el < src.endLine || (max_el == src.endLine && max_ec < src.endCol))) {
            src.endLine = max_el;
            src.endCol = max_ec;
        }
    }
}

std::string DesignExtractor::getExprText(vpiHandle expr) {
    if (!expr) return "";
    const char* decompile = vpi_get_str(vpiDecompile, expr);
    if (decompile) return decompile;

    int type = vpi_get(vpiType, expr);
    if (type == vpiOperation) {
        int op = vpi_get(vpiOpType, expr);
        std::string sym = "";
        bool unary = false;
        switch (op) {
            case vpiAddOp: sym = "+"; break;
            case vpiSubOp: sym = "-"; break;
            case vpiMultOp: sym = "*"; break;
            case vpiDivOp: sym = "/"; break;
            case vpiModOp: sym = "%"; break;
            case vpiBitAndOp: sym = "&"; break;
            case vpiBitOrOp: sym = "|"; break;
            case vpiBitXorOp: sym = "^"; break;
            case vpiBitNegOp: sym = "~"; unary = true; break;
            case vpiNotOp: sym = "!"; unary = true; break;
            case vpiLogAndOp: sym = "&&"; break;
            case vpiLogOrOp: sym = "||"; break;
            default: break;
        }
        if (!sym.empty()) {
            vpiHandle op_itr = vpi_iterate(vpiOperand, expr);
            if (op_itr) {
                std::vector<std::string> ops;
                while (vpiHandle o = vpi_scan(op_itr)) {
                    std::string ot = getExprText(o);
                    if (vpi_get(vpiType, o) == vpiOperation) ot = "(" + ot + ")";
                    ops.push_back(ot);
                }
                vpi_release_handle(op_itr);
                if (ops.size() == 2) return ops[0] + " " + sym + " " + ops[1];
                if (ops.size() == 1) return unary ? sym + ops[0] : ops[0];
            }
        }
    } else if (type == vpiConstant) {
        return getSignalName(expr);
    } else {
        const char* name = vpi_get_str(vpiName, expr);
        if (name) return name;
    }
    return getSignalName(expr);
}

std::string DesignExtractor::sanitize(const std::string& name) {
    std::string s = name;
    for (char &c : s) {
        if (!std::isalnum((unsigned char)c) && c != '_') {
            c = '_';
        }
    }
    // Remove consecutive underscores
    s.erase(std::unique(s.begin(), s.end(), [](char a, char b) {
        return a == '_' && b == '_';
    }), s.end());
    // Trim underscores from ends
    if (!s.empty() && s.front() == '_') s.erase(0, 1);
    if (!s.empty() && s.back() == '_') s.pop_back();
    return s.empty() ? "val" : s;
}

vpiHandle DesignExtractor::unwrapRef(vpiHandle handle) {
    if (!handle) return nullptr;
    int type = vpi_get(vpiType, handle);
    if (type == 608) { // vpiRefObj
        vpiHandle actual = vpi_handle(vpiActual, handle);
        if (actual && actual != handle) return unwrapRef(actual);
    }
    return handle;
}

bool DesignExtractor::isLiteralExpr(vpiHandle handle) {
    vpiHandle actual = unwrapRef(handle);
    if (!actual) return false;
    int type = vpi_get(vpiType, actual);
    return type == vpiConstant
        || type == vpiParameter
        || type == vpiEnumConst
        || vpi_get(vpiLocalParam, actual);
}

std::string DesignExtractor::getLiteralLabel(vpiHandle handle) {
    vpiHandle actual = unwrapRef(handle);
    if (!actual) return "";

    if (actual != handle) {
        const char* ref_decompile = vpi_get_str(vpiDecompile, handle);
        if (ref_decompile && strlen(ref_decompile) > 0) {
            std::string s = ref_decompile;
            if (s.rfind("work@", 0) == 0) s = s.substr(5);
            return s;
        }

        const char* ref_name = vpi_get_str(vpiName, handle);
        if (ref_name && strlen(ref_name) > 0) {
            std::string s = ref_name;
            if (s.rfind("work@", 0) == 0) s = s.substr(5);
            return s;
        }
    }

    int type = vpi_get(vpiType, actual);
    if (type == vpiParameter || type == vpiEnumConst || vpi_get(vpiLocalParam, actual)) {
        const char* name = vpi_get_str(vpiName, handle);
        if (!name || strlen(name) == 0) name = vpi_get_str(vpiName, actual);
        if (name && strlen(name) > 0) {
            std::string s = name;
            if (s.rfind("work@", 0) == 0) s = s.substr(5);
            return s;
        }
    }

    const char* decompile = vpi_get_str(vpiDecompile, actual);
    if (decompile && strlen(decompile) > 0) return decompile;

    std::string signal_name = getSignalName(actual);
    return signal_name.empty() ? "const" : signal_name;
}

std::string DesignExtractor::getAssignmentRhsText(vpiHandle assignment_handle) {
    if (!assignment_handle) return "";
    SourceInfo source = getSourceInfo(assignment_handle);
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
            if (buffer.tellp() > 0) buffer << "\n";
            buffer << line;
        }
        if (source.endLine > 0 && line_no > source.endLine) break;
        line_no++;
    }

    std::string text = buffer.str();
    size_t op = text.find("<=");
    size_t op_len = 2;
    if (op == std::string::npos) {
        op = text.find('=');
        op_len = 1;
    }
    if (op == std::string::npos) return "";

    std::string rhs = text.substr(op + op_len);
    size_t semicolon = rhs.find(';');
    if (semicolon != std::string::npos) rhs = rhs.substr(0, semicolon);
    size_t comment = rhs.find("//");
    if (comment != std::string::npos) rhs = rhs.substr(0, comment);
    return trimCopy(rhs);
}

std::string DesignExtractor::getDeclaredSignalWidth(const Module& mod, const std::string& signal) {
    if (signal.empty()) return "";

    for (const auto& port : mod.ports) {
        if (port.name == signal && !port.width.empty()) return port.width;
    }

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

    std::ifstream file(source_file);
    if (!file.is_open()) return "";

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string text = buffer.str();
    std::string escaped_signal;
    for (char c : signal) {
        if (std::string(R"(\.^$|()[]{}*+?)").find(c) != std::string::npos) escaped_signal.push_back('\\');
        escaped_signal.push_back(c);
    }

    std::regex signal_vector_re(
        std::string(R"((?:input|output|inout)?\s*(?:logic|wire|reg)\s+(\[[^\]]+\])\s+[^;\)]*\b)") + escaped_signal + R"(\b)"
    );
    std::smatch signal_match;
    if (std::regex_search(text, signal_match, signal_vector_re)) {
        return signal_match[1].str();
    }

    std::map<std::string, std::string> type_widths;
    std::regex enum_type_re(R"(typedef\s+enum\s+(?:\w+\s+)*(\[[^\]]+\])\s*\{[^}]*\}\s*(\w+)\s*;)");
    for (std::sregex_iterator it(text.begin(), text.end(), enum_type_re), end; it != end; ++it) {
        type_widths[(*it)[2].str()] = (*it)[1].str();
    }

    std::regex typed_decl_re(R"((?:^|[;\n])\s*(\w+)\s+([^;]+);)");
    for (std::sregex_iterator it(text.begin(), text.end(), typed_decl_re), end; it != end; ++it) {
        std::string type_name = (*it)[1].str();
        auto width_it = type_widths.find(type_name);
        if (width_it != type_widths.end() && declarationListContains((*it)[2].str(), signal)) {
            return width_it->second;
        }
    }

    std::regex vector_decl_re(R"((?:^|[;\n,])\s*(?:(?:input|output|inout)\s+)?(?:logic|wire|reg)\s+(\[[^\]]+\])\s+([^;,\)]+))");
    for (std::sregex_iterator it(text.begin(), text.end(), vector_decl_re), end; it != end; ++it) {
        if (declarationListContains((*it)[2].str(), signal)) {
            return (*it)[1].str();
        }
    }

    return "";
}

std::string DesignExtractor::getDeclaredLiteralWidth(const Module& mod, const std::string& literal) {
    if (literal.empty() || mod.source.file.empty()) return "";

    std::ifstream file(mod.source.file);
    if (!file.is_open()) return "";

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string text = buffer.str();

    std::regex enum_type_re(R"(typedef\s+enum\s+(?:\w+\s+)*(\[[^\]]+\])\s*\{([^}]*)\}\s*(\w+)\s*;)");
    for (std::sregex_iterator it(text.begin(), text.end(), enum_type_re), end; it != end; ++it) {
        std::string members = (*it)[2].str();
        if (declarationListContains(members, literal)) {
            return (*it)[1].str();
        }
    }

    return getDeclaredSignalWidth(mod, literal);
}
