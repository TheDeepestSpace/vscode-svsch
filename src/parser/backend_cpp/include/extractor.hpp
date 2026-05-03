#pragma once

#include <string>
#include <vector>
#include <map>
#include <set>
#include <optional>
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
    std::string typeName;
    SourceInfo typeSource;
};

struct NodePort {
    std::string name;
    std::string direction;
    std::string signal;
    std::string width;
    std::string label;
    SourceInfo source;
    std::string typeName;
    SourceInfo typeSource;
};

struct StructField {
    std::string name;
    std::string width;
    std::string bitRange;
    std::string typeName;
};

struct StructType {
    std::string name;
    bool packed = false;
    std::string width;
    std::vector<StructField> fields;
    SourceInfo source;
};

struct StructSignal {
    std::string name;
    StructType type;
    SourceInfo source;
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
        bool isProcedural = false;
        bool inferred = false;
        std::string reason;
        std::string role;
        std::string typeName;
        SourceInfo typeSource;
        bool packed = false;
        std::vector<StructField> fields;
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
    SourceInfo sourceInfo;
    bool aggregateStruct = false;
};

struct PendingStructAssign {
    std::string targetSignal;
    std::string baseSignal;
    SourceInfo source;
};

struct Module {
    std::string name;
    std::vector<Port> ports;
    std::vector<Node> nodes;
    std::vector<Edge> edges;
    SourceInfo source;
    std::map<std::string, StructSignal> structSignals;
    std::vector<PendingStructAssign> pendingStructAssigns;
};

struct LoweredValue {
    bool assigned = false;
    std::string signal;
    std::string width;
};

class DesignExtractor {
public:
    DesignExtractor(vpiHandle design);
    json extract();

private:
    void processModule(vpiHandle module_handle);
    void processNet(vpiHandle net_handle, Module& mod);
    void processAssign(vpiHandle assign_handle, Module& mod, bool is_procedural = false);
    void processProcess(vpiHandle process_handle, Module& mod);
    void processStatement(vpiHandle stmt, Module& mod, vpiHandle process_handle);
    void processAlwaysFf(vpiHandle always_handle, Module& mod);
    void processMux(vpiHandle case_handle, Module& mod, vpiHandle always_handle);
    vpiHandle findFirstCase(vpiHandle stmt);
    bool containsIf(vpiHandle stmt);
    void collectAssignmentTargets(vpiHandle stmt, std::set<std::string>& targets);
    std::map<std::string, LoweredValue> lowerStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers = {});
    std::map<std::string, LoweredValue> lowerIfStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    std::map<std::string, LoweredValue> lowerCaseStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    LoweredValue lowerAssignment(vpiHandle assign_handle, Module& mod, const std::string& preferred_signal, bool is_clocked);
    void ensureInferredLatch(Module& mod, const std::string& target, const std::string& input_signal, const std::string& width, vpiHandle source_handle);
    std::string processBusSelect(vpiHandle select_handle, Module& mod);
    std::optional<StructType> getStructType(vpiHandle handle);
    std::optional<StructType> getStructTypeFromTypespec(vpiHandle typespec);
    void collectStructSignal(vpiHandle handle, const std::string& name, Module& mod, const SourceInfo& source);
    std::optional<std::pair<std::string, std::string>> getStructFieldRef(vpiHandle handle, const Module& mod);
    std::string ensureStructBreakout(Module& mod, const std::string& base, const std::string& field, SourceInfo source);
    std::string ensureStructComposition(Module& mod, const std::string& base);
    void synthesizePendingStructCompositions(Module& mod);
    std::string fieldWidth(const StructType& type, const std::string& field) const;
    std::string fieldBitRange(const StructType& type, const std::string& field) const;
    bool hasStructFieldDriver(const Module& mod, const std::string& signal) const;
    void findAssignments(vpiHandle stmt, std::vector<vpiHandle>& assigns);
    void collectIdentifiers(vpiHandle handle, std::vector<std::string>& ids);
    void collectIdentifierHandles(vpiHandle handle, std::vector<vpiHandle>& h);
    void buildEdges(Module& mod);
    
    std::string getOrPromoteExpr(vpiHandle expr, Module& mod, const std::string& preferred_name = "", bool is_procedural = false);
    vpiHandle unwrapRef(vpiHandle handle);
    bool isLiteralExpr(vpiHandle handle);
    std::string getLiteralLabel(vpiHandle handle);
    std::string getAssignmentRhsText(vpiHandle assignment_handle);
    std::string ensureLiteralNode(vpiHandle handle, Module& mod, const std::string& output_signal, const std::string& width, vpiHandle source_handle, const std::string& label_override = "");
    std::string getDeclaredSignalWidth(const Module& mod, const std::string& signal);
    std::string getDeclaredLiteralWidth(const Module& mod, const std::string& literal);
    bool isNonZeroResetValue(vpiHandle handle);
    bool isAncestor(vpiHandle ancestor, vpiHandle descendant);
    bool isSameObject(vpiHandle h1, vpiHandle h2);
    SourceInfo getSourceInfo(vpiHandle handle);
    std::string sanitize(const std::string& name);

    std::string getSignalName(vpiHandle handle);
    std::string getBaseSignalName(vpiHandle handle);
    std::string getWidth(vpiHandle handle);
    std::string getTypeName(vpiHandle handle);
    SourceInfo getTypeSource(vpiHandle handle);
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
