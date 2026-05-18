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

struct ParameterRef {
    std::string name;
    SourceInfo source;
    SourceInfo declarationSource;
};

struct ParameterDecl {
    std::string name;
    std::string kind; // parameter, localparam
    std::string defaultValue;
    std::string width;
    SourceInfo source;
    SourceInfo valueSource;
};

struct InstanceParameter {
    std::string name;
    std::string value;
    bool isOverride = false;
    SourceInfo source;
    SourceInfo valueSource;
    std::vector<ParameterRef> parameterRefs;
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
    std::string modportName;
    SourceInfo modportSource;
    std::string preferredSide;
    std::string widthExpression;
    std::vector<ParameterRef> parameterRefs;
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
    std::string modportName;
    SourceInfo modportSource;
    std::string preferredSide;
    std::string widthExpression;
    std::vector<ParameterRef> parameterRefs;
};

struct StructField {
    std::string name;
    std::string width;
    std::string bitRange;
    std::string typeName;
    std::string direction;
    SourceInfo source;
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

struct InterfaceModport {
    std::string name;
    SourceInfo source;
    std::vector<StructField> fields;
    std::string preferredSide; // "left", "right", or empty
};

struct InterfaceType {
    std::string name;
    SourceInfo source;
    std::vector<StructField> fields;
    std::map<std::string, InterfaceModport> modports;
};

struct InterfaceSignal {
    std::string name;
    std::string typeName;
    std::string modportName;
    SourceInfo source;
    bool isPort = false;
    std::map<std::string, std::string> portConnections;
};
struct Node {
    std::string id;
    std::string kind;
    std::string label;
    std::string instanceOf; // For instances
    std::string moduleName; // For instances (target module for navigation)
    struct {
        std::string expression;
        std::string operation;
        std::string resetKind; // "async", "sync"
        bool resetActiveLow = false;
        std::string clockSignal;
        std::string resetSignal;
        bool isProcedural = false;
        bool inferred = false;
        std::string reason;
        std::string role;
        int repeatCount = 0;
        std::string repeatExpression;
        std::string typeName;
        SourceInfo typeSource;
        std::string modportName;
        SourceInfo modportSource;
        bool packed = false;
        std::vector<ParameterRef> parameterRefs;
        std::vector<InstanceParameter> instanceParameters;
        std::vector<StructField> fields;
        std::string aggregateKind;
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
    std::string aggregateKind;
};

struct PendingStructAssign {
    std::string targetSignal;
    std::string baseSignal;
    SourceInfo source;
};

struct Module {
    std::string name;
    std::vector<ParameterDecl> parameters;
    std::vector<Port> ports;
    std::vector<Node> nodes;
    std::vector<Edge> edges;
    SourceInfo source;
    std::map<std::string, StructSignal> structSignals;
    std::map<std::string, InterfaceSignal> interfaceSignals;
    std::set<std::string> internalSignals;
    std::vector<PendingStructAssign> pendingStructAssigns;
};

struct LoweredValue {
    bool assigned = false;
    std::string signal;
    std::string width;
};

struct AggregateSegment {
    vpiHandle handle = nullptr;
    std::string signal;
    std::string width;
    std::string label;
    std::string baseSignal;
    std::string structField;
    int size = 1;
    int high = 0;
    int low = 0;
};

class DesignExtractor {
public:
    DesignExtractor(vpiHandle design);
    json extract(const std::string& targetModule = "");

private:
    void processModule(vpiHandle module_handle);
    void collectModuleParameters(vpiHandle module_handle, Module& mod);
    std::vector<InstanceParameter> collectInstanceParameters(vpiHandle inst_handle, const Module& mod);
    void collectInterfaceTypesFromDesign();
    void processModuleInterfaces(vpiHandle module_handle, Module& mod);
    void collectInterfacePortsFromSource(Module& mod);
    void synthesizeInterfaceHarnesses(Module& mod);
    std::optional<InterfaceSignal> interfacePortInfoForModule(const std::string& moduleName, const std::string& portName) const;
    SourceInfo getSourceInfo(const UHDM::BaseClass* object);
    std::string getWidth(const UHDM::BaseClass* object);
    std::string directionString(int direction) const;
    void processNet(vpiHandle net_handle, Module& mod);
    void processAssign(vpiHandle assign_handle, Module& mod, bool is_procedural = false);
    void processProcess(vpiHandle process_handle, Module& mod);
    void processStatement(vpiHandle stmt, Module& mod, vpiHandle process_handle);
    void processAlwaysFf(vpiHandle always_handle, Module& mod);
    void processMux(vpiHandle case_handle, Module& mod, vpiHandle always_handle);
    std::map<std::string, LoweredValue> processLoop(vpiHandle loop_handle, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle process_handle, const std::map<std::string, LoweredValue>& current_drivers);
    vpiHandle findFirstCase(vpiHandle stmt);
    bool containsIf(vpiHandle stmt);
    void collectAssignmentTargets(vpiHandle stmt, std::set<std::string>& targets);
    std::map<std::string, LoweredValue> lowerStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers = {});
    std::map<std::string, LoweredValue> lowerIfStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    std::map<std::string, LoweredValue> lowerCaseStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    LoweredValue lowerAssignment(vpiHandle assign_handle, Module& mod, const std::string& preferred_signal, bool is_clocked, const std::map<std::string, LoweredValue>& current_drivers = {});
    std::map<std::string, LoweredValue> lowerAggregateAssignment(vpiHandle assign_handle, Module& mod, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers = {}, const std::string& output_suffix = "");
    void ensureInferredLatch(Module& mod, const std::string& target, const std::string& input_signal, const std::string& width, vpiHandle source_handle);
    std::string processBusSelect(vpiHandle select_handle, Module& mod);
    std::optional<StructType> getStructType(vpiHandle handle);
    std::optional<StructType> getStructTypeFromTypespec(vpiHandle typespec);
    void collectStructSignal(vpiHandle handle, const std::string& name, Module& mod, const SourceInfo& source);
    std::optional<std::pair<std::string, std::string>> getStructFieldRef(vpiHandle handle, const Module& mod);
    std::string ensureStructBreakout(Module& mod, const std::string& base, const std::string& field, SourceInfo source);
    std::string ensureStructBreakoutAlias(Module& mod, const std::string& base, const std::string& field, const std::string& output_signal, SourceInfo source);
    void ensureStructFieldCompositionInput(Module& mod, const std::string& base, const std::string& field, const std::string& input_signal, SourceInfo source);
    void ensureBusSliceCompositionInput(Module& mod, const std::string& base, const std::string& slice, const std::string& input_signal, SourceInfo source);
    std::string ensureStructComposition(Module& mod, const std::string& base);
    void synthesizePendingStructCompositions(Module& mod);
    std::string fieldWidth(const StructType& type, const std::string& field) const;
    std::string fieldBitRange(const StructType& type, const std::string& field) const;
    bool hasStructFieldDriver(const Module& mod, const std::string& signal) const;
    void findAssignments(vpiHandle stmt, std::vector<vpiHandle>& assigns);
    void collectIdentifiers(vpiHandle handle, std::vector<std::string>& ids);
    void collectIdentifiers(vpiHandle handle, std::set<std::string>& ids);
    void collectIdentifiersRecursive(vpiHandle handle, std::set<std::string>& ids);
    void collectIdentifierHandlesRecursive(vpiHandle handle, std::vector<vpiHandle>& h);
    void collectIdentifierHandles(vpiHandle handle, std::vector<vpiHandle>& h);
    std::vector<ParameterRef> collectParameterRefs(vpiHandle handle, const Module& mod);
    std::string getRangeExpression(vpiHandle handle);
    bool isParameterHandle(vpiHandle handle);
    std::string normalizedParameterName(vpiHandle handle);
    SourceInfo getParameterDeclarationSource(vpiHandle handle);
    void buildEdges(Module& mod);
    
    std::string getOrPromoteExpr(vpiHandle expr, Module& mod, const std::string& preferred_name = "", bool is_procedural = false, const std::map<std::string, LoweredValue>& current_drivers = {});
    bool isReplicationOperation(vpiHandle expr);
    bool isConcatOperation(vpiHandle expr);
    std::vector<vpiHandle> concatOperands(vpiHandle expr);
    void collectAggregateTargetNames(vpiHandle lhs, std::set<std::string>& targets);
    std::vector<AggregateSegment> flattenAggregateSegments(vpiHandle expr, Module& mod, bool is_lhs, bool is_procedural, const std::string& preferred_prefix, const std::map<std::string, LoweredValue>& current_drivers, int max_depth = 100);
    std::string promoteReplicationExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
    std::string promoteConcatExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
    int getConstantInt(vpiHandle handle);
    int bitSizeFromWidth(const std::string& width);
    int expressionBitSize(vpiHandle handle);
    bool isAluOperation(vpiHandle expr);
    std::string aluOperationSymbol(vpiHandle expr);
    std::string promoteAluExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
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
    void refineSourceInfo(SourceInfo& src, vpiHandle handle);
    std::string getExprText(vpiHandle expr);
    std::string sanitize(const std::string& name);

    std::string getSignalName(vpiHandle handle);
    std::string getSignalName(vpiHandle handle, const std::map<std::string, LoweredValue>& current_drivers);
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
    std::map<std::string, InterfaceType> interfaceTypes_;
    std::set<std::string> processing_modules_;
    int node_id_counter_ = 0;
    
    std::string nextId() {
        return "n" + std::to_string(node_id_counter_++);
    }
};

} // namespace svsch
