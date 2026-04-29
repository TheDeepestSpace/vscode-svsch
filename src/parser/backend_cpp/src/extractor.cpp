#include "extractor.hpp"
#include <uhdm/uhdm.h>
#include <uhdm/vpi_uhdm.h>
#include <iostream>
#include <map>
#include <set>

namespace svsch {

DesignExtractor::DesignExtractor(vpiHandle design) : design_(design) {}

json DesignExtractor::extract() {
    // Starting from top modules
    const int uhdmtopModules = 2377;
    vpiHandle mod_itr = vpi_iterate(uhdmtopModules, design_);
    if (mod_itr) {
        while (vpiHandle mod_handle = vpi_scan(mod_itr)) {
            processModule(mod_handle);
        }
    }

    // Also process all other modules that might not be under top
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

    json j_modules = json::array();
    for (auto& mod : modules_) {
        // Generate edges within the module based on signal connections
        buildEdges(mod);

        json j_mod;
        j_mod["name"] = mod.name;
        j_mod["ports"] = json::array();
        for (const auto& p : mod.ports) {
            j_mod["ports"].push_back({{"name", p.name}, {"direction", p.direction}});
        }
        j_mod["nodes"] = json::array();
        for (const auto& n : mod.nodes) {
            json j_ports = json::array();
            for (const auto& np : n.ports) {
                j_ports.push_back({{"name", np.name}, {"direction", np.direction}, {"signal", np.signal}});
            }
            j_mod["nodes"].push_back({
                {"id", n.id}, {"kind", n.kind}, {"label", n.label}, {"ports", j_ports},
                {"source", {{"file", n.source.file}, {"line", n.source.line}}}
            });
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
    return {{"modules", j_modules}};
}

void DesignExtractor::processModule(vpiHandle mod_handle) {
    const char* def_name = vpi_get_str(vpiDefName, mod_handle);
    const char* full_name = vpi_get_str(vpiFullName, mod_handle);
    std::string mod_name = def_name ? def_name : (full_name ? full_name : "unnamed");

    // Avoid duplicate processing of same definition
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
    
    // Submodules (Instances)
    vpiHandle inst_itr = vpi_iterate(vpiModule, mod_handle);
    if (inst_itr) {
        while (vpiHandle inst_handle = vpi_scan(inst_itr)) {
            Node n;
            n.id = nextId();
            n.kind = "instance";
            const char* i_name = vpi_get_str(vpiName, inst_handle);
            const char* d_name = vpi_get_str(vpiDefName, inst_handle);
            n.label = i_name ? i_name : (d_name ? d_name : "instance");
            n.source.file = getFile(inst_handle);
            n.source.line = getLine(inst_handle);
            vpiHandle inst_port_itr = vpi_iterate(vpiPort, inst_handle);
            if (inst_port_itr) {
                while (vpiHandle p_handle = vpi_scan(inst_port_itr)) {
                    NodePort np;
                    const char* pn = vpi_get_str(vpiName, p_handle);
                    np.name = pn ? pn : "unnamed";
                    int dir = vpi_get(vpiDirection, p_handle);
                    np.direction = (dir == vpiInput) ? "input" : (dir == vpiOutput ? "output" : "inout");
                    np.signal = getSignalName(vpi_handle(vpiHighConn, p_handle));
                    n.ports.push_back(np);
                }
            }
            mod.nodes.push_back(n);
        }
    }
    modules_.push_back(mod);
}

void DesignExtractor::processAssign(vpiHandle assign_handle, Module& mod) {
    Node n;
    n.id = nextId();
    n.kind = "comb";
    n.label = "assign";
    n.source.file = getFile(assign_handle);
    n.source.line = getLine(assign_handle);
    vpiHandle lhs = vpi_handle(vpiLhs, assign_handle);
    vpiHandle rhs = vpi_handle(vpiRhs, assign_handle);
    if (lhs) n.ports.push_back({"out", "output", getSignalName(lhs)});
    if (rhs) n.ports.push_back({"in", "input", getSignalName(rhs)});
    mod.nodes.push_back(n);
}

void DesignExtractor::processProcess(vpiHandle process_handle, Module& mod) {
    Node n;
    n.id = nextId();
    n.kind = "unknown";
    int type = vpi_get(vpiType, process_handle);
    n.label = (type == vpiAlways) ? "always" : ((type == vpiInitial) ? "initial" : "process");
    n.source.file = getFile(process_handle);
    n.source.line = getLine(process_handle);
    mod.nodes.push_back(n);
}

void DesignExtractor::buildEdges(Module& mod) {
    // Map signal names to ports
    std::map<std::string, std::vector<std::pair<std::string, std::string>>> signal_map;

    for (const auto& n : mod.nodes) {
        for (const auto& p : n.ports) {
            if (!p.signal.empty() && p.signal != "expr") {
                signal_map[p.signal].push_back({n.id, p.name});
            }
        }
    }

    // For each signal, connect all outputs to all inputs
    for (auto const& [signal, ports] : signal_map) {
        std::vector<std::pair<std::string, std::string>> drivers;
        std::vector<std::pair<std::string, std::string>> loads;

        for (const auto& port : ports) {
            // We need to know the direction of the port of the node
            // For now, we'll just assume based on common names if not explicitly known
            // Actually, we HAVE the direction in NodePort
        }

        // Re-iterate to find drivers and loads correctly
        for (const auto& n : mod.nodes) {
            for (const auto& p : n.ports) {
                if (p.signal == signal) {
                    if (p.direction == "output") drivers.push_back({n.id, p.name});
                    else if (p.direction == "input") loads.push_back({n.id, p.name});
                }
            }
        }
        
        // Also consider module ports as drivers/loads
        for (const auto& p : mod.ports) {
            if (p.name == signal) {
                if (p.direction == "input") drivers.push_back({"self", p.name});
                else if (p.direction == "output") loads.push_back({"self", p.name});
            }
        }

        for (const auto& d : drivers) {
            for (const auto& l : loads) {
                Edge e;
                e.source = d.first;
                e.sourcePort = d.second;
                e.target = l.first;
                e.targetPort = l.second;
                e.signal = signal;
                mod.edges.push_back(e);
            }
        }
    }
}

std::string DesignExtractor::getSignalName(vpiHandle handle) {
    if (!handle) return "";
    const char* name = vpi_get_str(vpiName, handle);
    if (name) return name;
    int type = vpi_get(vpiType, handle);
    if (type == vpiBitSelect) return getSignalName(vpi_handle(vpiParent, handle));
    if (type == vpiOperation) return "expr";
    return "";
}

std::string DesignExtractor::getFile(vpiHandle handle) {
    const char* file = vpi_get_str(vpiFile, handle);
    return file ? file : "";
}

int DesignExtractor::getLine(vpiHandle handle) {
    return vpi_get(vpiLineNo, handle);
}

} // namespace svsch
