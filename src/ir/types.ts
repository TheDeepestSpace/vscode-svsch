export type DiagramNodeKind = 'module' | 'instance' | 'mux' | 'register' | 'port' | 'comb' | 'bus' | 'unknown';

export interface SourceRange {
  file: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface DiagramPort {
  id: string;
  name: string;
  label?: string;
  direction: 'input' | 'output' | 'inout' | 'unknown';
  width?: string;
  connectedSignal?: string;
  source?: SourceRange;
}

export interface DiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  moduleName?: string;
  parentModule?: string;
  instanceOf?: string;
  ports: DiagramPort[];
  source?: SourceRange;
  metadata?: Record<string, unknown>;
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
}

export interface DesignModule {
  name: string;
  file: string;
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

export interface PositionedNode extends DiagramNode {
  position: {
    x: number;
    y: number;
  };
  fixed?: boolean;
}

export interface DiagramViewModel {
  moduleName: string;
  nodes: PositionedNode[];
  edges: DiagramEdge[];
  diagnostics: DesignDiagnostic[];
}
