#pragma once

#include <string>
#include <vector>
#include <map>
#include <uhdm/uhdm.h>
#include "json.hpp"

using json = nlohmann::json;

namespace svsch {

struct SourceInfo {
    std::string file;
    int line = 0;
    int col = 0;
    int endLine = 0;
    int endCol = 0;
};

struct Port {
    std::string name;
    std::string direction; // input, output, inout
    std::string width;
    int left = 0;
    int right = 0;
    bool is_array = false;
    SourceInfo source;
};

struct NodePort {
    std::string name;
    std::string direction;
    std::string signal;
    std::string width;
    std::string label;
};

struct Node {
    std::string id;
    std::string kind;
    std::string label;
    std::string instanceOf; // For instances
    std::string moduleName; // For instances (target module for navigation)
    struct {
        std::string expression;
        std::string resetKind; // "async", "sync"
        bool resetActiveLow = false;
        std::string clockSignal;
        std::string resetSignal;
    } metadata;
    std::vector<NodePort> ports;
    SourceInfo source;
};

struct Edge {
    std::string source;
    std::string target;
    std::string sourcePort;
    std::string targetPort;
    std::string signal;
    std::string width;
};

struct Module {
    std::string name;
    std::vector<Port> ports;
    std::vector<Node> nodes;
    std::vector<Edge> edges;
    SourceInfo source;
};

class DesignExtractor {
public:
    DesignExtractor(vpiHandle design);
    json extract();

private:
    void processModule(vpiHandle module_handle);
    void processNet(vpiHandle net_handle, Module& mod);
    void processAssign(vpiHandle assign_handle, Module& mod);
    void processProcess(vpiHandle process_handle, Module& mod);
    void processAlwaysFf(vpiHandle always_handle, Module& mod);
    void processMux(vpiHandle case_handle, Module& mod, vpiHandle always_handle);
    vpiHandle findFirstCase(vpiHandle stmt);
    std::string processBusSelect(vpiHandle select_handle, Module& mod);
    void findAssignments(vpiHandle stmt, std::vector<vpiHandle>& assigns);
    void collectIdentifiers(vpiHandle handle, std::vector<std::string>& ids);
    void collectIdentifierHandles(vpiHandle handle, std::vector<vpiHandle>& h);
    void buildEdges(Module& mod);
    
    std::string getOrPromoteExpr(vpiHandle expr, Module& mod, const std::string& preferred_name = "");
    vpiHandle unwrapRef(vpiHandle handle);
    bool isLiteralExpr(vpiHandle handle);
    std::string getLiteralLabel(vpiHandle handle);
    std::string getAssignmentRhsText(vpiHandle assignment_handle);
    std::string ensureLiteralNode(vpiHandle handle, Module& mod, const std::string& output_signal, const std::string& width, vpiHandle source_handle, const std::string& label_override = "");
    std::string getDeclaredSignalWidth(const Module& mod, const std::string& signal);
    std::string getDeclaredLiteralWidth(const Module& mod, const std::string& literal);
    SourceInfo getSourceInfo(vpiHandle handle);
    std::string sanitize(const std::string& name);

    std::string getSignalName(vpiHandle handle);
    std::string getWidth(vpiHandle handle);
    std::string getFile(vpiHandle handle);
    int getLine(vpiHandle handle);
    int getCol(vpiHandle handle);
    int getEndLine(vpiHandle handle);
    int getEndCol(vpiHandle handle);

    int width_depth_ = 0;
    int source_depth_ = 0;
    vpiHandle design_;
    std::vector<Module> modules_;
    int node_id_counter_ = 0;
    
    std::string nextId() {
        return "n" + std::to_string(node_id_counter_++);
    }
};

} // namespace svsch
