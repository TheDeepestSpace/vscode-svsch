export type DiagramNodeKind = 'module' | 'instance' | 'mux' | 'select' | 'register' | 'port' | 'comb' | 'alu' | 'bus' | 'struct' | 'interface' | 'literal' | 'latch' | 'loop' | 'replicate' | 'unknown';

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
}

export interface BaseDiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  moduleName?: string;
  parentModule?: string;
  instanceOf?: string;
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

  /** Legacy backend payload. Prefer the typed fields above for new code. */
  metadata?: DiagramNodeMetadata;
}

export interface RegisterDiagramNode extends BaseDiagramNode { kind: 'register'; }
export interface LatchDiagramNode extends BaseDiagramNode { kind: 'latch'; }
export interface AluDiagramNode extends BaseDiagramNode { kind: 'alu'; }
export interface CombDiagramNode extends BaseDiagramNode { kind: 'comb'; }
export interface MuxDiagramNode extends BaseDiagramNode { kind: 'mux'; }
export interface SelectDiagramNode extends BaseDiagramNode { kind: 'select'; }
export interface BusDiagramNode extends BaseDiagramNode { kind: 'bus'; }
export interface StructDiagramNode extends BaseDiagramNode { kind: 'struct'; }
export interface InterfaceDiagramNode extends BaseDiagramNode { kind: 'interface'; }
export interface LiteralDiagramNode extends BaseDiagramNode { kind: 'literal'; }
export interface ReplicateDiagramNode extends BaseDiagramNode { kind: 'replicate'; }
export interface InstanceDiagramNode extends BaseDiagramNode { kind: 'instance'; }
export interface PortDiagramNode extends BaseDiagramNode { kind: 'port'; }
export interface LoopDiagramNode extends BaseDiagramNode { kind: 'loop'; }
export interface UnknownDiagramNode extends BaseDiagramNode { kind: 'unknown'; }
export interface ModuleDiagramNode extends BaseDiagramNode { kind: 'module'; }

export type DiagramNode =
  | RegisterDiagramNode
  | LatchDiagramNode
  | AluDiagramNode
  | CombDiagramNode
  | MuxDiagramNode
  | SelectDiagramNode
  | BusDiagramNode
  | StructDiagramNode
  | InterfaceDiagramNode
  | LiteralDiagramNode
  | ReplicateDiagramNode
  | InstanceDiagramNode
  | PortDiagramNode
  | LoopDiagramNode
  | UnknownDiagramNode
  | ModuleDiagramNode;

export interface DiagramEdgeMetadata {
  aggregate?: 'struct' | 'interface' | string;
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

export interface DesignModule {
  name: string;
  file: string;
  parameters?: ParameterDecl[];
  ports: DiagramPort[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DesignDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  source?: SourceRange;
}

export interface DesignGraph {
  rootModules: string[];
  modules: Record<string, DesignModule>;
  diagnostics: DesignDiagnostic[];
  generatedAt: string;
}

export type PositionedNode = DiagramNode & {
  position: {
    x: number;
    y: number;
  };
  fixed?: boolean;
};

export interface DiagramViewModel {
  moduleName: string;
  parameters?: ParameterDecl[];
  nodes: PositionedNode[];
  edges: DiagramEdge[];
  diagnostics: DesignDiagnostic[];
  debugInfo?: unknown;
}
