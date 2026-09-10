export type DiagramNodeKind =
  | 'module'
  | 'instance'
  | 'funcCall'
  | 'taskCall'
  | 'mux'
  | 'select'
  | 'register'
  | 'port'
  | 'comb'
  | 'alu'
  | 'inverter'
  | 'gate'
  | 'comparator'
  | 'zext'
  | 'bus'
  | 'struct'
  | 'interface'
  | 'literal'
  | 'latch'
  | 'loop'
  | 'replicate'
  | 'unknown'
  | 'netLabel'
  | 'boundaryPort';

/** Boolean gate node operation — drives which glyph GateNodeSvg draws. */
export type GateOperation = 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'xnor';

export interface SourceRange {
  file: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ParameterRef {
  name: string;
  source?: SourceRange;
  declarationSource?: SourceRange;
}

export interface ParameterDecl {
  name: string;
  kind: 'parameter' | 'localparam';
  defaultValue?: string;
  width?: string;
  source?: SourceRange;
  valueSource?: SourceRange;
}

export interface InstanceParameter {
  name: string;
  value?: string;
  isOverride?: boolean;
  source?: SourceRange;
  valueSource?: SourceRange;
  parameterRefs?: ParameterRef[];
}

export interface DiagramPort {
  id: string;
  name: string;
  label?: string;
  direction: 'input' | 'output' | 'inout' | 'unknown';
  side?: 'north' | 'south' | 'east' | 'west';
  width?: string;
  widthExpression?: string;
  parameterRefs?: ParameterRef[];
  typeName?: string;
  typeSource?: SourceRange;
  modportName?: string;
  modportSource?: SourceRange;
  preferredSide?: 'left' | 'right' | string;
  isArrayNode?: boolean;
  arrayDimension?: string;
  arraySize?: number;
  connectedSignal?: string;
  position?: number;
  source?: SourceRange;
}

export interface StructField {
  name: string;
  width?: string;
  bitRange?: string;
  typeName?: string;
  direction?: 'input' | 'output' | 'inout' | 'unknown';
  source?: SourceRange;
}

export interface DiagramNodeMetadata {
  expression?: string;
  operation?: string;
  resetKind?: 'async' | 'sync' | string;
  resetActiveLow?: boolean;
  clockSignal?: string;
  resetSignal?: string;
  isProcedural?: boolean;
  inferred?: boolean;
  reason?: string;
  role?: 'breakout' | 'composition' | 'type' | string;
  repeatCount?: number;
  repeatExpression?: string;
  repeatExpressionSource?: SourceRange;
  typeName?: string;
  typeSource?: SourceRange;
  modportName?: string;
  modportSource?: SourceRange;
  preferredSide?: 'left' | 'right' | string;
  packed?: boolean;
  width?: string;
  parameterRefs?: ParameterRef[];
  instanceParameters?: InstanceParameter[];
  fields?: StructField[];
  aggregateKind?: 'struct' | 'interface' | string;
  isArrayNode?: boolean;
  arrayDimension?: string;
  arraySize?: number;
  arrayIndexSignal?: string;
  /** Stamped by annotateWireStyles: array node whose stack spreads with the wide offset. */
  stackWide?: boolean;
  generateRegionId?: string;
  generateActiveState?: string;
  handlePosition?: 'left' | 'top' | 'right' | 'bottom' | string;
  /**
   * Present only on `kind: 'boundaryPort'` nodes synthesized client-side when
   * splicing an expanded instance's child module in place (see "Expand" in
   * NodeSelectionToolbar / webview/expand). `outerSide` is which side of the
   * node faces away from the expanded region's interior (where the parent's
   * pre-existing wire keeps landing, unchanged); the opposite side faces the
   * spliced-in internal nodes.
   */
  boundaryPort?: {
    instanceId: string;
    childModuleName: string;
    childPortId: string;
    outerSide: 'left' | 'right';
    /**
     * Wire style of the net passing through this port, mirrored from the
     * child module's own annotated edges (see annotateWireStyles) so the
     * node's drawn lead stub matches the struct/interface/multi-bit style of
     * the wire it continues — same idea as cutNet.edgeStyle on netLabel
     * nodes.
     */
    edgeStyle?: {
      aggregate?: 'struct' | 'interface' | string;
      thick?: boolean;
    };
  };
  /**
   * Present only on an expanded instance's own node once
   * `applyExpandedInstances`/`applyActiveSplices` has dimmed it into a
   * backdrop for its spliced-in child diagram (see webview/expand). `insets`
   * is the frame's reserved border ring (ExpandContentInsets in
   * webview/expand/splice.ts) — the only part of the node's body that isn't
   * covered by spliced content.
   */
  expandGhost?: {
    insets: { top: number; left: number; right: number; bottom: number };
  };
  cutNet?: {
    netKey: string;
    role: 'source' | 'sink';
    align: 'start' | 'end';
    originalEdgeId?: string;
    handleSide: 'left' | 'right' | 'top' | 'bottom';
    edgeStyle?: {
      aggregate?: 'struct' | 'interface' | string;
      isStacked?: boolean;
      thick?: boolean;
    };
    isSourceStacked?: boolean;
    /** 'declared' locks the label from renaming (it's the net's real SV source
     * name); 'synthetic' is tool-invented and freely renameable. */
    origin?: 'declared' | 'synthetic';
    /** True once the label has been edited away from its default (the text it
     * had right when the net was cut) — drives italic styling, independent of
     * `origin`. */
    isRenamed?: boolean;
    /** Other declared wire names this net's chain of `assign` aliases
     * collapsed together, for the hover popover. */
    aliasNames?: string[];
  };
}

export interface BaseDiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  moduleName?: string;
  parentModule?: string;
  instanceOf?: string;
  /** Qualified key into DesignGraph.functions for a function call-site. */
  functionId?: string;
  functionName?: string;
  /** Qualified key into DesignGraph.tasks for a task call-site. */
  taskId?: string;
  taskName?: string;
  ports: DiagramPort[];
  source?: SourceRange;

  expression?: string;
  operation?: string;
  resetKind?: 'async' | 'sync' | string;
  resetActiveLow?: boolean;
  clockSignal?: string;
  resetSignal?: string;
  isProcedural?: boolean;
  inferred?: boolean;
  reason?: string;
  role?: 'breakout' | 'composition' | 'type' | string;
  repeatCount?: number;
  repeatExpression?: string;
  repeatExpressionSource?: SourceRange;
  typeName?: string;
  typeSource?: SourceRange;
  modportName?: string;
  modportSource?: SourceRange;
  preferredSide?: 'left' | 'right' | string;
  packed?: boolean;
  width?: string;
  parameterRefs?: ParameterRef[];
  instanceParameters?: InstanceParameter[];
  fields?: StructField[];
  aggregateKind?: 'struct' | 'interface' | string;
  isArrayNode?: boolean;
  arrayDimension?: string;
  arraySize?: number;
  arrayIndexSignal?: string;
  handlePosition?: 'left' | 'top' | 'right' | 'bottom' | string;
  /**
   * Manual grow-only resize override, in grid units (not px — see
   * resolvedNodeDimensions). Rendered/effective size is always
   * max(canonical auto-fit size, this override) per axis, so a later
   * increase in canonical size (more ports, etc.) is never clamped down by
   * a stale override. Only ever set on `instance`/`register` nodes today.
   */
  sizeOverride?: { width: number; height: number };

  /** Legacy backend payload. Prefer the typed fields above for new code. */
  metadata?: DiagramNodeMetadata;
}

export interface RegisterDiagramNode extends BaseDiagramNode {
  kind: 'register';
}
export interface LatchDiagramNode extends BaseDiagramNode {
  kind: 'latch';
}
export interface AluDiagramNode extends BaseDiagramNode {
  kind: 'alu';
}
export interface InverterDiagramNode extends BaseDiagramNode {
  kind: 'inverter';
}
export interface GateDiagramNode extends BaseDiagramNode {
  kind: 'gate';
  operation?: GateOperation | string;
}
export interface ComparatorDiagramNode extends BaseDiagramNode {
  kind: 'comparator';
}
export interface ZextDiagramNode extends BaseDiagramNode {
  kind: 'zext';
}
export interface CombDiagramNode extends BaseDiagramNode {
  kind: 'comb';
}
export interface MuxDiagramNode extends BaseDiagramNode {
  kind: 'mux';
}
export interface SelectDiagramNode extends BaseDiagramNode {
  kind: 'select';
}
export interface BusDiagramNode extends BaseDiagramNode {
  kind: 'bus';
}
export interface StructDiagramNode extends BaseDiagramNode {
  kind: 'struct';
}
export interface InterfaceDiagramNode extends BaseDiagramNode {
  kind: 'interface';
}
export interface LiteralDiagramNode extends BaseDiagramNode {
  kind: 'literal';
}
export interface ReplicateDiagramNode extends BaseDiagramNode {
  kind: 'replicate';
}
export interface InstanceDiagramNode extends BaseDiagramNode {
  kind: 'instance';
}
export interface FunctionCallDiagramNode extends BaseDiagramNode {
  kind: 'funcCall';
}
export interface TaskCallDiagramNode extends BaseDiagramNode {
  kind: 'taskCall';
}
export interface PortDiagramNode extends BaseDiagramNode {
  kind: 'port';
}
export interface LoopDiagramNode extends BaseDiagramNode {
  kind: 'loop';
}
export interface UnknownDiagramNode extends BaseDiagramNode {
  kind: 'unknown';
}
export interface ModuleDiagramNode extends BaseDiagramNode {
  kind: 'module';
}
export interface NetLabelDiagramNode extends BaseDiagramNode {
  kind: 'netLabel';
}
export interface BoundaryPortDiagramNode extends BaseDiagramNode {
  kind: 'boundaryPort';
}

export type DiagramNode =
  | RegisterDiagramNode
  | LatchDiagramNode
  | AluDiagramNode
  | InverterDiagramNode
  | GateDiagramNode
  | ComparatorDiagramNode
  | ZextDiagramNode
  | CombDiagramNode
  | MuxDiagramNode
  | SelectDiagramNode
  | BusDiagramNode
  | StructDiagramNode
  | InterfaceDiagramNode
  | LiteralDiagramNode
  | ReplicateDiagramNode
  | InstanceDiagramNode
  | FunctionCallDiagramNode
  | TaskCallDiagramNode
  | PortDiagramNode
  | LoopDiagramNode
  | UnknownDiagramNode
  | ModuleDiagramNode
  | NetLabelDiagramNode
  | BoundaryPortDiagramNode;

export interface DiagramEdgeMetadata {
  aggregate?: 'struct' | 'interface' | string;
  /** Stamped by annotateWireStyles: wire is (or can be) wider than one bit. */
  thick?: boolean;
  generateRegionId?: string;
  generateActiveState?: string;
  forceStraight?: boolean;
  cutStub?: {
    netKey: string;
    role: 'source' | 'sink';
    originalEdgeId?: string;
  };
  /**
   * `signal` is a name genuinely declared in the SV source (a port, or a
   * wire/reg/var), not a tool-synthesized temp. Holds that declared name.
   */
  declaredNetName?: string;
  /**
   * Other declared wire names collapsed into this edge by a chain of simple
   * `assign` aliases (e.g. `assign a = b; assign b = c; ...`). `signal` holds
   * whichever name was declared first in source; these are the rest, in
   * declaration order.
   */
  aliasNames?: string[];
  /**
   * This edge closes a purely combinational cycle (e.g. the cross-coupled
   * wires of a structural NAND SR latch) — a loop through comb/gate drivers
   * with no register or latch breaking it. Clocked feedback is never flagged.
   */
  combFeedback?: boolean;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  label?: string;
  signal?: string;
  width?: string;
  isStacked?: boolean;
  waypoint?: {
    x: number;
    y: number;
  };
  routePoints?: Array<{
    x: number;
    y: number;
  }>;
  sourceRange?: SourceRange;
  metadata?: DiagramEdgeMetadata;
}

export type GenerateRegionKind = 'if' | 'else-if' | 'else' | 'case' | 'case-default' | string;
export type GenerateRegionActiveState = 'active' | 'inactive' | 'unknown' | string;

export interface GenerateRegion {
  id: string;
  kind: GenerateRegionKind;
  label: string;
  condition?: string;
  selector?: string;
  caseValue?: string;
  blockLabel?: string;
  fullBlockLabel?: string;
  parentRegionId?: string;
  siblingGroupId?: string;
  activeState?: GenerateRegionActiveState;
  armIndex?: number;
  source?: SourceRange;
  bodySource?: SourceRange;
  // Span of the whole generate statement the arm belongs to (full if/else chain or
  // case..endcase) — the synthesized generate-block wrapper navigates to this.
  groupSource?: SourceRange;
  nodeIds?: string[];
  edgeIds?: string[];
  warnings?: string[];
  // True for the synthesized wrapper region around a whole if/case expression's arms.
  isGenerateBlock?: boolean;
  /**
   * Client-only (`kind: 'expand'`): identifies this as a synthesized "expand
   * instance in place" region rather than a real SV generate region. Never
   * set by the extractor/server — the webview splices these into the same
   * `regions` array/overlay/drag-sync machinery as real generate regions
   * (see webview/expand) purely to reuse that already-working code, and
   * strips them back out before sending `regions` to the extension host.
   */
  expandedInstance?: {
    instanceId: string;
    childModuleName: string;
    parentModuleName: string;
  };
  /** Client-only expansion region for one source-stable function call-site. */
  expandedFunctionCall?: {
    callId: string;
    functionId: string;
    parentModuleName: string;
  };
  /** Client-only expansion region for one source-stable task call-site. */
  expandedTaskCall?: {
    callId: string;
    taskId: string;
    parentModuleName: string;
  };
}

export interface PositionedGenerateRegion extends GenerateRegion {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  nodeIds: string[];
  edgeIds?: string[];
  fixed?: boolean;
  stale?: boolean;
  invalid?: boolean;
  warningNote?: string;
}

export interface DesignModule {
  name: string;
  file: string;
  parameters?: ParameterDecl[];
  ports: DiagramPort[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  generateRegions?: GenerateRegion[];
}

/** A module-shaped combinational IR body extracted from an HDL function/task. */
export interface DesignCallable extends DesignModule {
  parentModule: string;
  callableName: string;
  callableKind: 'function' | 'task';
}

export interface DesignDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  source?: SourceRange;
}

export interface DesignGraph {
  rootModules: string[];
  modules: Record<string, DesignModule>;
  functions?: Record<string, DesignCallable>;
  tasks?: Record<string, DesignCallable>;
  diagnostics: DesignDiagnostic[];
  generatedAt: string;
}

export type PositionedNode = DiagramNode & {
  position: {
    x: number;
    y: number;
  };
  fixed?: boolean;
  // Set when the block overlaps a generate arm it does not belong to.
  invalid?: boolean;
  warningNote?: string;
};

export interface DiagramViewModel {
  moduleName: string;
  parameters?: ParameterDecl[];
  nodes: PositionedNode[];
  edges: DiagramEdge[];
  generateRegions?: PositionedGenerateRegion[];
  diagnostics: DesignDiagnostic[];
  debugInfo?: unknown;
}
