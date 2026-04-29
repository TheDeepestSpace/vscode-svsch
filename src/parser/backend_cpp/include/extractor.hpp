#pragma once

#include <string>
#include <vector>
#include <map>
#include <uhdm/uhdm.h>
#include "json.hpp"

using json = nlohmann::json;

namespace svsch {

struct Port {
    std::string name;
    std::string direction; // input, output, inout
    int left = 0;
    int right = 0;
    bool is_array = false;
};

struct NodePort {
    std::string name;
    std::string direction;
    std::string signal;
};

struct Node {
    std::string id;
    std::string kind;
    std::string label;
    std::vector<NodePort> ports;
    struct {
        std::string file;
        int line = 0;
        int col = 0;
    } source;
};

struct Edge {
    std::string source;
    std::string target;
    std::string sourcePort;
    std::string targetPort;
    std::string signal;
};

struct Module {
    std::string name;
    std::vector<Port> ports;
    std::vector<Node> nodes;
    std::vector<Edge> edges;
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
    void buildEdges(Module& mod);
    
    std::string getSignalName(vpiHandle handle);
    std::string getFile(vpiHandle handle);
    int getLine(vpiHandle handle);

    vpiHandle design_;
    std::vector<Module> modules_;
    int node_id_counter_ = 0;
    
    std::string nextId() {
        return "n" + std::to_string(node_id_counter_++);
    }
};

} // namespace svsch
