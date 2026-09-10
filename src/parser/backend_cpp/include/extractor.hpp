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
    std::string arrayDimension;
    int arraySize = 0;
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
    // True when this port carries a whole array (e.g. the "in" port of a
    // dynamic array-read mux) rather than a plain bus — drives the
    // collapsed-width label suffix ("[[]]" vs "[]") in the webview.
    bool isArrayNode = false;
    std::string arrayDimension;
    int arraySize = 0;
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
    std::string functionName; // For function call-sites
    std::string functionId; // Qualified function body key (<module>.<function>)
    std::string taskName; // For task call-sites
    std::string taskId; // Qualified task body key (<module>.<task>)
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
        SourceInfo repeatExpressionSource;
        std::string typeName;
        SourceInfo typeSource;
        std::string modportName;
        SourceInfo modportSource;
        bool packed = false;
        std::vector<ParameterRef> parameterRefs;
        std::vector<InstanceParameter> instanceParameters;
        std::vector<StructField> fields;
        std::string aggregateKind;
        bool isArrayNode = false;
        std::string arrayDimension;
        int arraySize = 0;
        std::string arrayIndexSignal;
        std::string generateRegionId;
        std::string generateActiveState;
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
    bool isStacked = false;
    std::string generateRegionId;
    std::string generateActiveState;
    // Other declared wire names collapsed into this edge by collapseAliasCombNodes
    // (e.g. a chain of `assign a = b; assign b = c; ...`), in declaration order.
    // Populated independently of `signal` (which keeps its own long-standing
    // "closest to the sink" convention, unrelated to declaration order, so
    // that changing this never disturbs edge identity/matching elsewhere).
    std::vector<std::string> aliasNames;
    // The net's name as actually declared in the SV source (a port or a
    // wire/reg/var) — as opposed to a tool-synthesized name (e.g. "foo_next",
    // "expr") — when known. For an edge produced by collapseAliasCombNodes this
    // is the earliest-declared name among every alias the chain passed through
    // (which may differ from `signal`); otherwise it's `signal` itself, when
    // `signal` is itself a declared name. Empty when no declared name is known.
    std::string declaredNetName;
    // This edge closes a purely combinational cycle (e.g. the cross-coupled
    // wires of a structural NAND SR latch) — a loop through comb/gate drivers
    // with no register or latch breaking it. Clocked feedback stays false.
    bool combFeedback = false;
};

struct GenerateRegion {
    std::string id;
    std::string kind; // if, else-if, else, case, case-default
    std::string label;
    std::string condition;
    std::string selector;
    std::string caseValue;
    std::string blockLabel;
    std::string fullBlockLabel;
    std::string parentRegionId;
    std::string siblingGroupId;
    std::string activeState = "unknown"; // active, inactive, unknown
    int armIndex = 0;
    SourceInfo source;
    SourceInfo bodySource;
    // Span of the whole generate statement this arm belongs to (the full if/else
    // chain or case..endcase) — used by the synthesized generate-block wrapper.
    SourceInfo groupSource;
    std::vector<std::string> nodeIds;
    std::vector<std::string> edgeIds;
    std::vector<std::string> warnings;
};

struct PendingStructAssign {
    std::string targetSignal;
    std::string baseSignal;
    SourceInfo source;
};

struct PendingArrayAlias {
    std::string targetSignal;
    std::string sourceSignal;
    SourceInfo source;
};

struct EnumMemberInfo {
    std::string typeName;
    SourceInfo typeSource;
    std::string width;
};

struct Module {
    std::string name;
    std::string callableKind; // Empty for modules; otherwise "function" or "task"
    std::string callableName;
    std::string parentModule;
    std::vector<ParameterDecl> parameters;
    std::vector<Port> ports;
    std::vector<Node> nodes;
    std::vector<Edge> edges;
    std::vector<GenerateRegion> generateRegions;
    SourceInfo source;
    std::map<std::string, StructSignal> structSignals;
    std::map<std::string, InterfaceSignal> interfaceSignals;
    std::set<std::string> internalSignals;
    // Source declaration order of ports and internal signals (lower index = declared
    // earlier). Used to pick a stable "first declared" primary name when multiple
    // wires collapse into one net (see collapseAliasCombNodes).
    std::map<std::string, int> declarationOrder;
    std::vector<PendingStructAssign> pendingStructAssigns;
    std::vector<PendingArrayAlias> pendingArrayAliases;
    std::map<std::string, std::string> arrayDimensions;
    std::map<std::string, int> arraySizes;
    std::map<std::string, EnumMemberInfo> enumMemberTypes; // enum member name → typedef info
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

struct LoweredAggregate {
    bool assigned = false;
    LoweredValue value;
    std::string tag;
    SourceInfo source;
    std::vector<AggregateSegment> lhsSegments;
    int lhsSize = 0;
};

class DesignExtractor {
public:
    DesignExtractor() = default;
    DesignExtractor(vpiHandle design);
    json extract(const std::string& targetModule = "");
    std::string workspace_root;

private:
    void processModule(vpiHandle module_handle);
    void collectTaskFunctions(vpiHandle module_handle, const std::string& module_name);
    void processCallableDeclaration(vpiHandle callable_handle, const std::string& module_name);
    std::string promoteFunctionCallExpr(vpiHandle call_handle, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
    void processTaskCall(vpiHandle call_handle, Module& mod, bool is_procedural = true);
    std::string getCallableWidth(vpiHandle handle);
    void collectModuleParameters(vpiHandle module_handle, Module& mod);
    void processGenerateRegions(vpiHandle module_handle, Module& mod);
    void walkGenerateRegionTree(vpiHandle handle, Module& mod, const std::string& parentRegionId, std::set<vpiHandle>& visited, int depth = 0);
    void collectGenerateIfRegions(vpiHandle gen_handle, Module& mod, const std::string& parentRegionId, std::set<vpiHandle>& visited, int depth);
    void collectGenerateIfArms(vpiHandle gen_handle, Module& mod, const std::string& siblingGroupId, const std::string& parentRegionId, int& armIndex, std::set<vpiHandle>& visited, int depth, bool isElseIf = false, const SourceInfo& groupSource = SourceInfo{});
    void collectGenerateCaseRegions(vpiHandle gen_handle, Module& mod, const std::string& parentRegionId, std::set<vpiHandle>& visited, int depth);
    void collectGenerateRegionBody(vpiHandle handle, Module& mod, GenerateRegion& region, std::set<vpiHandle>& visited, int depth);
    void processGenerateRegionInstance(vpiHandle inst_handle, Module& mod, GenerateRegion& region);
    void processGenerateRegionAssign(vpiHandle assign_handle, Module& mod, GenerateRegion& region);
    void tagGenerateRegionEdges(Module& mod);
    std::vector<InstanceParameter> collectInstanceParameters(vpiHandle inst_handle, const Module& mod);
    void collectInterfaceTypesFromDesign();
    void processModuleInterfaces(vpiHandle module_handle, Module& mod);
    void collectInterfacePortsFromSource(Module& mod);
    void synthesizeInterfaceHarnesses(Module& mod);
    std::string fallbackDeclaredTypeName(const SourceInfo& source, const std::string& name) const;
    SourceInfo fallbackDeclarationSource(const SourceInfo& source, const std::string& keyword, const std::string& name) const;
    std::string getModportPositionFromComment(const SourceInfo& src) const;
    std::optional<InterfaceSignal> interfacePortInfoForModule(const std::string& moduleName, const std::string& portName) const;
    std::string sourceLineText(const SourceInfo& source) const;
    std::string sourceSnippet(const SourceInfo& source) const;
    std::string declaredArrayElementWidthFromSource(const Module& mod, const std::string& signal) const;
    SourceInfo getSourceInfo(const UHDM::BaseClass* object);
    std::string getWidth(const UHDM::BaseClass* object);
    std::ifstream openSourceFile(const std::string& source_file) const;
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
    vpiHandle unwrapSingleStatement(vpiHandle stmt);
    void collectAggregateTargetOrder(vpiHandle lhs, std::vector<std::string>& targets);
    bool isUniformAggregateIfChain(vpiHandle stmt, std::vector<std::string>& targets, bool& needs_hold);
    LoweredValue composeAggregateHoldValue(vpiHandle stmt, Module& mod, const LoweredAggregate& shape, const std::map<std::string, LoweredValue>& current_drivers);
    LoweredValue lowerUniformAggregateIfTree(vpiHandle stmt, Module& mod, bool is_clocked, const LoweredValue& hold_value, const std::map<std::string, LoweredValue>& current_drivers, const std::string& aggregate_width, bool final_output);
    std::optional<std::map<std::string, LoweredValue>> lowerUniformAggregateIfStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    std::map<std::string, LoweredValue> lowerStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers = {});
    std::map<std::string, LoweredValue> lowerIfStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    std::map<std::string, LoweredValue> lowerCaseStatement(vpiHandle stmt, Module& mod, bool is_clocked, const std::map<std::string, std::string>& desired_outputs, vpiHandle source_handle, const std::map<std::string, LoweredValue>& current_drivers);
    LoweredValue lowerAssignment(vpiHandle assign_handle, Module& mod, const std::string& preferred_signal, bool is_clocked, const std::map<std::string, LoweredValue>& current_drivers = {});
    LoweredAggregate lowerAggregateValue(vpiHandle assign_handle, Module& mod, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers = {});
    std::map<std::string, LoweredValue> lowerAggregateBreakout(const LoweredAggregate& aggregate, Module& mod, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers = {}, const std::string& output_suffix = "", const std::map<std::string, std::string>& desired_outputs = {});
    std::map<std::string, LoweredValue> lowerAggregateAssignment(vpiHandle assign_handle, Module& mod, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers = {}, const std::string& output_suffix = "", const std::map<std::string, std::string>& desired_outputs = {});
    void ensureInferredLatch(Module& mod, const std::string& target, const std::string& input_signal, const std::string& width, vpiHandle source_handle);
    bool tryProcessArrayCompositionAssignment(vpiHandle assign_handle, Module& mod, bool is_procedural);
    std::string processBusSelect(vpiHandle select_handle, Module& mod);
    std::optional<StructType> getStructType(vpiHandle handle);
    std::optional<StructType> getStructTypeFromTypespec(vpiHandle typespec);
    void collectStructSignal(vpiHandle handle, const std::string& name, Module& mod, const SourceInfo& source);
    std::optional<std::pair<std::string, std::string>> getStructFieldRef(vpiHandle handle, const Module& mod);
    std::string ensureStructBreakout(Module& mod, const std::string& base, const std::string& field, SourceInfo source);
    std::string ensureStructBreakoutAlias(Module& mod, const std::string& base, const std::string& field, const std::string& output_signal, SourceInfo source);
    void propagateStruct(Module& mod, const std::string& from, const std::string& to);
    void ensureStructFieldCompositionInput(Module& mod, const std::string& base, const std::string& field, const std::string& input_signal, SourceInfo source);
    void ensureBusSliceCompositionInput(Module& mod, const std::string& base, const std::string& slice, const std::string& input_signal, SourceInfo source);
    void ensureArrayCompositionInput(Module& mod, const std::string& base, const std::string& index_label, const std::string& input_signal, const std::string& width, SourceInfo source);
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
    void removeUnconnectedLiteralNodes(Module& mod);
    void repairResolvedExplicitBusCompositions(Module& mod);
    void repairResolvedBusCompositionSlices(Module& mod);
    void repairAggregateReplicationWidths(Module& mod);
    void pruneDuplicateAggregateInputDrivers(Module& mod, Node& aggregate_node);
    void repairAggregateAssignmentBuses(Module& mod);
    void collapseAliasCombNodes(Module& mod);
    void repairInterfaceAssignmentsC(Module& mod);
    void synthesizeBusCompositionNodes(Module& mod);
    void unifyNetPropagation(Module& mod);
    void markDeclaredNetEdges(Module& mod);
    void markCombFeedbackEdges(Module& mod);
    std::string resolveSignalWidth(const Module& mod, const std::string& signal, const std::string& fallback_width);

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
    bool isComparatorOperation(vpiHandle expr);
    std::string comparatorOperationSymbol(vpiHandle expr);
    std::string promoteComparatorExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
    std::string ensureZextNode(Module& mod, const std::string& input_signal, const std::string& input_width, const std::string& output_width, vpiHandle source_handle);
    bool isConditionalOperation(vpiHandle expr);
    std::string promoteMuxExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
    bool isInverterOperation(vpiHandle expr);
    std::string promoteInverterExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers);
    bool isGateOperation(vpiHandle expr);
    std::string gateOperationName(int opType, bool negateOutput);
    void collectGateOperands(vpiHandle expr, int opType, const std::string& outputWidth, std::vector<vpiHandle>& leaves);
    std::string promoteGateExpr(vpiHandle expr, Module& mod, const std::string& preferred_name, bool is_procedural, const std::map<std::string, LoweredValue>& current_drivers, bool negate_output, vpiHandle display_expr);
    vpiHandle unwrapRef(vpiHandle handle);
    bool isLiteralExpr(vpiHandle handle);
    std::string getLiteralLabel(vpiHandle handle);
    std::string getAssignmentRhsText(vpiHandle assignment_handle);
    std::string ensureLiteralNode(vpiHandle handle, Module& mod, const std::string& output_signal, const std::string& width, vpiHandle source_handle, const std::string& label_override = "");
    std::string getDeclaredSignalWidth(const Module& mod, const std::string& signal);
    std::string getDeclaredArrayDimension(const Module& mod, const std::string& signal);
    void ensureDeclaredArray(Module& mod, const std::string& signal);
    std::string getDeclaredLiteralWidth(const Module& mod, const std::string& literal);
    bool isNonZeroResetValue(vpiHandle handle);
    bool isCanonicalFullArrayResetLoop(vpiHandle assignment_handle, const Module& mod, const std::string& array_name, const std::string& index_expr);
    bool isAncestor(vpiHandle ancestor, vpiHandle descendant);
    bool isSameObject(vpiHandle h1, vpiHandle h2);
    SourceInfo getSourceInfo(vpiHandle handle);
    SourceInfo generateStmtBodySource(vpiHandle stmt, int depth = 0);
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
    std::vector<Module> callables_;
    std::map<std::string, InterfaceType> interfaceTypes_;
    std::set<std::string> processing_modules_;
    int node_id_counter_ = 0;
    
    std::string nextId() {
        return "n" + std::to_string(node_id_counter_++);
    }
};

} // namespace svsch
