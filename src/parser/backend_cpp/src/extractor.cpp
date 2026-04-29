#include "extractor.hpp"
#include <uhdm/uhdm.h>
#include <uhdm/vpi_uhdm.h>
#include <iostream>
#include <map>
#include <set>
#include <algorithm>

namespace svsch {

DesignExtractor::DesignExtractor(vpiHandle design) : design_(design) {}

json DesignExtractor::extract() {
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
        
        j_mod["ports"] = json::array();
        for (const auto& p : mod.ports) {
            j_mod["ports"].push_back({
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
            });
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
                if (!np.label.empty()) j_port["label"] = np.label;
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
            if (!n.metadata.resetKind.empty()) j_meta["resetKind"] = n.metadata.resetKind;
            if (!n.metadata.resetKind.empty()) j_meta["resetActiveLow"] = n.metadata.resetActiveLow;
            if (!j_meta.empty()) j_node["metadata"] = j_meta;

            j_mod["nodes"].push_back(j_node);
        }
        j_mod["edges"] = json::array();
        for (const auto& e : mod.edges) {
            j_mod["edges"].push_back({
                {"source", e.source}, {"target", e.target},
                {"sourcePort", e.sourcePort}, {"targetPort", e.targetPort},
                {"signal", e.signal}
            });
        }
        j_modules.push_back(j_mod);
    }
    
    json result = {{"modules", j_modules}};
    result["rootModules"] = roots;
    return result;
}

void DesignExtractor::processModule(vpiHandle mod_handle) {
    const char* def_name = vpi_get_str(vpiDefName, mod_handle);
    const char* full_name = vpi_get_str(vpiFullName, mod_handle);
    std::string mod_name = def_name ? def_name : (full_name ? full_name : "unnamed");
    if (mod_name.rfind("work@", 0) == 0) mod_name = mod_name.substr(5);

    for (const auto& m : modules_) if (m.name == mod_name) return;

    Module mod;
    mod.name = mod_name;

    // Ports
    vpiHandle port_itr = vpi_iterate(vpiPort, mod_handle);
    if (port_itr) {
        while (vpiHandle port_handle = vpi_scan(port_itr)) {
            Port p;
            const char* pn = vpi_get_str(vpiName, port_handle);
            p.name = pn ? pn : "unnamed";
            p.source.file = getFile(port_handle);
            p.source.line = getLine(port_handle);
            p.source.col = getCol(port_handle);
            p.source.endLine = getEndLine(port_handle);
            p.source.endCol = getEndCol(port_handle);
            p.width = getWidth(port_handle);
            int dir = vpi_get(vpiDirection, port_handle);
            p.direction = (dir == vpiInput) ? "input" : (dir == vpiOutput ? "output" : (dir == vpiInout ? "inout" : "unknown"));
            mod.ports.push_back(p);
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

    // Generate blocks
    for (int type : {vpiGenStmt, 2154, 5013, 5014, 5015, 5016}) { // GenStmt, GenRegion, GenIf, GenIfElse, GenFor, GenCase
        vpiHandle gen_itr = vpi_iterate(type, mod_handle);
        if (gen_itr) {
            while (vpiHandle gen_handle = vpi_scan(gen_itr)) {
                 Node n;
                 n.id = "unknown:" + mod.name + ":generate:" + std::to_string(getLine(gen_handle));
                 n.kind = "unknown";
                 n.label = "generate";
                 n.source.file = getFile(gen_handle);
                 n.source.line = getLine(gen_handle);
                 n.source.col = getCol(gen_handle);
                 n.source.endLine = getEndLine(gen_handle);
                 n.source.endCol = getEndCol(gen_handle);
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
                n.source.file = getFile(inst_handle);
                n.source.line = getLine(inst_handle);
                n.source.col = getCol(inst_handle);
                n.source.endLine = getEndLine(inst_handle);
                n.source.endCol = getEndCol(inst_handle);

                vpiHandle inst_port_itr = vpi_iterate(vpiPort, inst_handle);
                if (inst_port_itr) {
                    while (vpiHandle p_handle = vpi_scan(inst_port_itr)) {
                        NodePort np;
                        const char* pn = vpi_get_str(vpiName, p_handle);
                        np.name = pn ? pn : "unnamed";
                        int dir = vpi_get(vpiDirection, p_handle);
                        np.direction = (dir == vpiInput) ? "input" : (dir == vpiOutput ? "output" : (dir == vpiInout ? "inout" : "unknown"));
                        np.signal = getSignalName(vpi_handle(vpiHighConn, p_handle));
                        np.width = getWidth(vpi_handle(vpiLowConn, p_handle));
                        if (np.width.empty()) np.width = getWidth(p_handle);
                        n.ports.push_back(np);
                    }
                }
                mod.nodes.push_back(n);
            }
        }
    }
    modules_.push_back(mod);
}

void DesignExtractor::processAssign(vpiHandle assign_handle, Module& mod) {
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (!lhs) return;

    std::string out_signal = getSignalName(lhs);
    
    // Check if it's a simple wire assignment
    int rhs_type = vpi_get(vpiType, rhs);
    if (rhs_type == vpiNet || rhs_type == vpiReg || rhs_type == vpiPort || rhs_type == 608) {
        return;
    }

    Node n;
    n.id = "comb:" + mod.name + ":" + out_signal;
    n.kind = "comb";
    n.label = ""; 
    n.source.file = getFile(assign_handle);
    n.source.line = getLine(assign_handle);
    n.source.col = getCol(assign_handle);
    n.source.endLine = getEndLine(assign_handle);
    n.source.endCol = getEndCol(assign_handle);

    const char* expr = vpi_get_str(vpiDecompile, rhs);
    if (expr) n.metadata.expression = expr;

    n.ports.push_back({out_signal, "output", out_signal, getWidth(lhs)});
    
    std::vector<vpiHandle> input_handles;
    collectIdentifierHandles(rhs, input_handles);
    for (const auto& in : input_handles) {
        std::string sig = getSignalName(in);
        n.ports.push_back({sig, "input", sig, getWidth(in)});
    }

    mod.nodes.push_back(n);
}

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
                vpiHandle inner = stmt;
                if (vpi_get(vpiType, stmt) == vpiBegin) {
                    vpiHandle inner_itr = vpi_iterate(vpiStmt, stmt);
                    if (inner_itr) {
                        inner = vpi_scan(inner_itr);
                        vpi_release_handle(inner_itr);
                    }
                }
                
                if (inner && vpi_get(vpiType, inner) == vpiCase) {
                    processMux(inner, mod, process_handle);
                    return;
                }
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

void DesignExtractor::processAlwaysFf(vpiHandle always_handle, Module& mod) {
    vpiHandle stmt = vpi_handle(vpiStmt, always_handle);
    if (!stmt) return;

    std::vector<vpiHandle> assignments;
    findAssignments(stmt, assignments);

    std::map<std::string, std::vector<vpiHandle>> reg_assigns;
    for (vpiHandle a : assignments) {
        vpiHandle lhs = vpi_handle(vpiLhs, a);
        if (lhs) reg_assigns[getSignalName(lhs)].push_back(a);
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
        if (body && (vpi_get(vpiType, body) == vpiIf || vpi_get(vpiType, body) == vpiIfElse)) {
            vpiHandle cond = vpi_handle(vpiCondition, body);
            std::vector<vpiHandle> cond_ids;
            collectIdentifierHandles(cond, cond_ids);
            if (!cond_ids.empty()) {
                rst_signal = getSignalName(cond_ids[0]);
                reset_kind = "sync";
                if (vpi_get(vpiType, cond) == vpiOperation && vpi_get(vpiOpType, cond) == 43) reset_active_low = true;
            }
        }
    }

    for (auto const& [reg_name, assigns] : reg_assigns) {
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

        n.ports.push_back({"D", "input", "", ""});
        n.ports.push_back({"Q", "output", reg_name, getWidth(vpi_handle(vpiLhs, assigns[0]))});
        if (!clk_signal.empty()) n.ports.push_back({clk_signal, "input", clk_signal, ""});
        if (!rst_signal.empty()) n.ports.push_back({rst_signal, "input", rst_signal, ""});

        vpiHandle data_rhs = nullptr;
        for (vpiHandle a : assigns) {
            vpiHandle rhs = vpi_handle(vpiRhs, a);
            if (rhs && vpi_get(vpiType, rhs) != vpiConstant) { data_rhs = rhs; break; }
            if (!data_rhs) data_rhs = rhs;
        }

        if (data_rhs) {
            std::vector<vpiHandle> input_handles;
            collectIdentifierHandles(data_rhs, input_handles);
            if (!input_handles.empty()) {
                n.ports[0].signal = getSignalName(input_handles[0]);
                n.ports[0].width = getWidth(input_handles[0]);
            }
        }
        mod.nodes.push_back(n);
    }
}

void DesignExtractor::processMux(vpiHandle case_handle, Module& mod, vpiHandle always_handle) {
    vpiHandle cond = vpi_handle(vpiCondition, case_handle);
    std::string sel_name = getSignalName(cond);
    
    std::string out_signal = "";
    vpiHandle item_itr = vpi_iterate(vpiCaseItem, case_handle);
    struct CaseInput { std::string label; vpiHandle handle; };
    std::vector<CaseInput> case_inputs;
    if (item_itr) {
        while (vpiHandle item = vpi_scan(item_itr)) {
            vpiHandle item_stmt = vpi_handle(vpiStmt, item);
            if (item_stmt) {
                std::vector<vpiHandle> assigns;
                findAssignments(item_stmt, assigns);
                for (vpiHandle a : assigns) {
                    vpiHandle lhs = vpi_handle(vpiLhs, a);
                    vpiHandle rhs = vpi_handle(vpiRhs, a);
                    if (lhs) out_signal = getSignalName(lhs);
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
                        case_inputs.push_back({label, rhs});
                    }
                }
            }
        }
    }

    Node n;
    n.id = "mux:" + mod.name + ":" + (out_signal.empty() ? "unnamed" : out_signal) + ":" + sel_name;
    n.kind = "mux";
    n.label = "case " + sel_name;
    n.source.file = getFile(always_handle);
    n.source.line = getLine(always_handle);
    n.source.col = getCol(always_handle);
    n.source.endLine = getEndLine(always_handle);
    n.source.endCol = getEndCol(always_handle);

    const char* sel_expr = vpi_get_str(vpiDecompile, cond);
    if (sel_expr) n.metadata.expression = sel_expr;

    // Promotion of complex selector to combinational block
    if (vpi_get(vpiType, cond) == vpiOperation) {
        Node sn;
        sn.id = "comb:" + mod.name + ":sel:" + sel_name;
        sn.kind = "comb";
        sn.label = "";
        sn.source = n.source;
        sn.metadata.expression = sel_expr ? sel_expr : "";
        sn.ports.push_back({sel_name, "output", sel_name, getWidth(cond)});
        std::vector<vpiHandle> inputs;
        collectIdentifierHandles(cond, inputs);
        for (const auto& in : inputs) {
            std::string sig = getSignalName(in);
            sn.ports.push_back({sig, "input", sig, getWidth(in)});
        }
        mod.nodes.push_back(sn);
    }

    n.ports.push_back({"sel", "input", sel_name, getWidth(cond)});
    for (const auto& input : case_inputs) {
        std::vector<vpiHandle> ids;
        collectIdentifierHandles(input.handle, ids);
        NodePort np;
        // Match backend.test.ts: port name is signal name
        np.name = ids.empty() ? "in" : getSignalName(ids[0]);
        np.direction = "input";
        np.signal = np.name;
        np.width = getWidth(input.handle);
        np.label = input.label;
        n.ports.push_back(np);
    }
    if (!out_signal.empty()) n.ports.push_back({"out", "output", out_signal, ""});

    mod.nodes.push_back(n);
}

void DesignExtractor::findAssignments(vpiHandle stmt, std::vector<vpiHandle>& assigns) {
    if (!stmt) return;
    int type = vpi_get(vpiType, stmt);
    if (type == vpiAssignment) {
        assigns.push_back(stmt);
    } else if (type == vpiBegin || type == vpiNamedBegin || type == vpiFork || type == vpiNamedFork) {
        vpiHandle itr = vpi_iterate(vpiStmt, stmt);
        if (itr) { while (vpiHandle s = vpi_scan(itr)) findAssignments(s, assigns); }
    } else if (type == vpiIf || type == vpiIfElse) {
        findAssignments(vpi_handle(vpiStmt, stmt), assigns);
        findAssignments(vpi_handle(vpiElseStmt, stmt), assigns);
    } else if (type == vpiCase) {
        vpiHandle itr = vpi_iterate(vpiCaseItem, stmt);
        if (itr) { while (vpiHandle item = vpi_scan(itr)) findAssignments(vpi_handle(vpiStmt, item), assigns); }
    } else if (type == vpiEventControl) {
        findAssignments(vpi_handle(vpiStmt, stmt), assigns);
    }
}

void DesignExtractor::collectIdentifiers(vpiHandle handle, std::vector<std::string>& ids) {
    std::vector<vpiHandle> h; collectIdentifierHandles(handle, h);
    for (auto val : h) ids.push_back(getSignalName(val));
}

void DesignExtractor::collectIdentifierHandles(vpiHandle handle, std::vector<vpiHandle>& h) {
    if (!handle) return;
    int type = vpi_get(vpiType, handle);
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == 608) {
        h.push_back(handle);
        if (type == 608) {
            vpiHandle actual = vpi_handle(vpiActual, handle);
            if (actual && actual != handle) {
                int a_type = vpi_get(vpiType, actual);
                if (a_type == vpiBitSelect || a_type == vpiPartSelect) {
                    vpiHandle parent = vpi_handle(vpiParent, actual);
                    if (parent && parent != actual) h.push_back(parent);
                }
            }
        }
    } else if (type == vpiOperation) {
        vpiHandle operand_itr = vpi_iterate(vpiOperand, handle);
        if (operand_itr) { while (vpiHandle op = vpi_scan(operand_itr)) collectIdentifierHandles(op, h); }
    } else if (type == vpiBitSelect || type == vpiPartSelect) {
        vpiHandle base = handle;
        while (base && (vpi_get(vpiType, base) == vpiBitSelect || vpi_get(vpiType, base) == vpiPartSelect)) {
            vpiHandle parent = vpi_handle(vpiParent, base);
            if (!parent || parent == base) break;
            base = parent;
        }
        if (base) h.push_back(base);
    }
}

void DesignExtractor::buildEdges(Module& mod) {
    std::map<std::string, std::vector<std::pair<std::string, std::string>>> signal_map;
    for (const auto& n : mod.nodes) {
        for (const auto& p : n.ports) {
            if (!p.signal.empty()) signal_map[p.signal].push_back({n.id, p.name});
        }
    }
    for (auto const& [signal, ports] : signal_map) {
        std::vector<std::pair<std::string, std::string>> drivers, loads;
        for (const auto& n : mod.nodes) {
            for (const auto& p : n.ports) {
                if (p.signal == signal) {
                    if (p.direction == "output") drivers.push_back({n.id, p.name});
                    else if (p.direction == "input") loads.push_back({n.id, p.name});
                }
            }
        }
        for (const auto& p : mod.ports) {
            if (p.name == signal) {
                if (p.direction == "input") drivers.push_back({"self", p.name});
                else if (p.direction == "output") loads.push_back({"self", p.name});
            }
        }
        for (const auto& d : drivers) {
            for (const auto& l : loads) {
                if (d.first == l.first && d.second == l.second) continue;
                Edge e; e.source = d.first; e.sourcePort = d.second; e.target = l.first; e.targetPort = l.second; e.signal = signal;
                bool duplicate = false;
                for (const auto& existing : mod.edges) {
                    if (existing.source == e.source && existing.target == e.target &&
                        existing.sourcePort == e.sourcePort && existing.targetPort == e.targetPort) { duplicate = true; break; }
                }
                if (!duplicate) mod.edges.push_back(e);
            }
        }
    }
}

std::string DesignExtractor::getSignalName(vpiHandle handle) {
    if (!handle) return "";
    int type = vpi_get(vpiType, handle);
    if (type == 608) {
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
    if (type == vpiBitSelect || type == vpiPartSelect) {
        const char* d = vpi_get_str(vpiDecompile, handle);
        if (d) return d;
        vpiHandle parent = vpi_handle(vpiParent, handle);
        if (parent && parent != handle) return getSignalName(parent);
        return "";
    }
    const char* name = vpi_get_str(vpiName, handle);
    if (!name) name = vpi_get_str(vpiDefName, handle);
    if (name) return name;
    if (type == vpiConstant) {
        const char* val = vpi_get_str(vpiDecompile, handle);
        if (val) return val;
        return "const";
    }
    return "";
}

std::string DesignExtractor::getWidth(vpiHandle handle) {
    if (!handle) return "";
    int type = vpi_get(vpiType, handle);
    if (type == 608) {
        vpiHandle actual = vpi_handle(vpiActual, handle);
        if (actual && actual != handle) return getWidth(actual);
    }
    
    // Check if net/reg/port first
    if (type == vpiNet || type == vpiReg || type == vpiPort || type == vpiBitSelect || type == vpiPartSelect) {
        const char* d = vpi_get_str(vpiDecompile, handle);
        if (d) {
             std::string s = d; size_t pos = s.find('[');
             if (pos != std::string::npos) return s.substr(pos);
        }
        
        int size = vpi_get(vpiSize, handle);
        if (size > 1) return "[" + std::to_string(size-1) + ":0]";
    }

    vpiHandle typespec = vpi_handle(vpiTypespec, handle);
    if (typespec) {
        const char* d = vpi_get_str(vpiDecompile, typespec);
        if (d) {
            std::string s = d; size_t pos = s.find('[');
            if (pos != std::string::npos) return s.substr(pos);
        }
    }
    
    return "";
}

std::string DesignExtractor::getFile(vpiHandle handle) {
    const char* file = vpi_get_str(vpiFile, handle);
    return file ? file : "";
}

int DesignExtractor::getLine(vpiHandle handle) { return vpi_get(vpiLineNo, handle); }

int DesignExtractor::getCol(vpiHandle handle) {
    int col = vpi_get(vpiColumnNo, handle);
    return col > 0 ? col - 1 : 0; 
}

int DesignExtractor::getEndLine(vpiHandle handle) { return vpi_get(vpiEndLineNo, handle); }

int DesignExtractor::getEndCol(vpiHandle handle) {
    int col = vpi_get(vpiEndColumnNo, handle);
    return col > 0 ? col - 1 : 0;
}

} // namespace svsch
