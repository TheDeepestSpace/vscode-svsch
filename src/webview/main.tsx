import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  useReactFlow,
  useEdgesState,
  useNodesState
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { OrthogonalEdge, type OrthogonalPoint } from './orthogonal';

type DiagramNodeKind = 'module' | 'instance' | 'mux' | 'register' | 'port' | 'unknown';

interface PositionedNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  moduleName?: string;
  instanceOf?: string;
  ports: Array<{ id: string; name: string; direction: 'input' | 'output' | 'inout' | 'unknown' }>;
  position: { x: number; y: number };
  source?: { file: string; startLine?: number };
  metadata?: Record<string, unknown>;
}

interface DiagramViewModel {
  moduleName: string;
  nodes: PositionedNode[];
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourcePort?: string;
    targetPort?: string;
    label?: string;
    waypoint?: { x: number; y: number };
    routePoints?: OrthogonalPoint[];
  }>;
  diagnostics: Array<{ severity: string; message: string }>;
}

interface GraphMessage {
  type: 'graph';
  view: DiagramViewModel;
  modules: string[];
}

interface StatusMessage {
  type: 'status';
  status: 'idle' | 'rebuilding';
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();

function HdlNode({ data }: NodeProps<Node<PositionedNode>>): React.ReactElement {
  const node = data;
  const title = node.kind === 'instance' && node.instanceOf ? `${node.label} : ${node.instanceOf}` : node.label;
  const inputs = node.ports.filter((port) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown');
  const outputs = node.ports.filter((port) => port.direction === 'output');
  const portDirection = node.kind === 'port' ? node.ports[0]?.direction ?? 'unknown' : undefined;

  if (node.kind === 'port') {
    const isOutput = portDirection === 'output';
    return (
      <button
        className={`hdl-node hdl-node-port hdl-port-${portDirection}`}
        title={node.source ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}` : 'port'}
      >
        {isOutput && <Handle type="target" id={node.ports[0]?.id} position={Position.Left} />}
        <div className="port-direction">{portDirection}</div>
        <div className="port-title">{title}</div>
        {!isOutput && <Handle type="source" id={node.ports[0]?.id} position={Position.Right} />}
      </button>
    );
  }

  return (
    <button
      className={`hdl-node hdl-node-${node.kind}`}
      title={node.source ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}` : node.kind}
      onDoubleClick={() => {
        if (node.moduleName) {
          vscode.postMessage({ type: 'openModule', moduleName: node.moduleName });
        }
      }}
    >
      <div className="node-kind">{node.kind}</div>
      <div className="node-title">{title}</div>
      <div className="node-ports">
        <div>
          {inputs.map((port) => (
            <div className="node-port" key={port.id}>
              <Handle type="target" id={port.id} position={Position.Left} />
              {port.name}
            </div>
          ))}
        </div>
        <div>
          {outputs.map((port) => (
            <div className="node-port node-port-out" key={port.id}>
              {port.name}
              <Handle type="source" id={port.id} position={Position.Right} />
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}

function App(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <DiagramApp />
    </ReactFlowProvider>
  );
}

function DiagramApp(): React.ReactElement {
  const [view, setView] = useState<DiagramViewModel | undefined>();
  const [modules, setModules] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'rebuilding'>('idle');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PositionedNode>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const reactFlow = useReactFlow();
  const [hasFitInitialView, setHasFitInitialView] = useState(false);
  const handleRouteChange = useCallback((edgeId: string, routePoints: OrthogonalPoint[], commit: boolean) => {
    setEdges((currentEdges) => currentEdges.map((edge) => (
      edge.id === edgeId
        ? { ...edge, data: { ...edge.data, routePoints } }
        : edge
    )));

    if (commit && view) {
      vscode.postMessage({
        type: 'edgeRouteChanged',
        moduleName: view.moduleName,
        edgeId,
        routePoints
      });
    }
  }, [setEdges, view]);

  useEffect(() => {
    const listener = (event: MessageEvent<GraphMessage | StatusMessage>) => {
      if (event.data.type === 'graph') {
        setView(event.data.view);
        setModules(event.data.modules);
      } else if (event.data.type === 'status') {
        setStatus(event.data.status);
      }
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);

  useEffect(() => {
    setNodes((view?.nodes ?? []).map((node) => ({
      id: node.id,
      type: 'hdl',
      position: node.position,
      data: node
    })));

    setEdges((view?.edges ?? []).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      label: edge.label,
      type: 'svsch',
      data: {
        waypoint: edge.waypoint,
        routePoints: edge.routePoints,
        onRouteChange: handleRouteChange
      }
    })));
  }, [handleRouteChange, setEdges, setNodes, view]);

  useEffect(() => {
    if (!hasFitInitialView && nodes.length > 0) {
      window.setTimeout(() => {
        reactFlow.fitView({ padding: 0.2 });
        setHasFitInitialView(true);
      }, 0);
    }
  }, [hasFitInitialView, nodes.length, reactFlow]);

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, dragged: Node<PositionedNode>, allNodes: Node<PositionedNode>[]) => {
      if (!view) {
        return;
      }
      const positioned = allNodes.map((node) => ({
        ...node.data,
        position: node.id === dragged.id ? dragged.position : node.position
      }));
      vscode.postMessage({ type: 'layoutChanged', moduleName: view.moduleName, nodes: positioned });
    },
    [view]
  );

  const nodeTypes = useMemo(() => ({ hdl: HdlNode }), []);
  const edgeTypes = useMemo(() => ({ svsch: OrthogonalEdge }), []);

  if (!view) {
    return <div className="empty">Building diagram...</div>;
  }

  return (
    <div className="shell">
        {status === 'rebuilding' && (
          <div className="busy-indicator" role="status" aria-live="polite">
            <span />
            Updating
          </div>
        )}
        <header className="toolbar">
          <select
            aria-label="Module"
            value={view.moduleName}
            onChange={(event) => vscode.postMessage({ type: 'openModule', moduleName: event.target.value })}
          >
            {modules.map((moduleName) => (
              <option key={moduleName} value={moduleName}>
                {moduleName}
              </option>
            ))}
          </select>
          <button onClick={() => vscode.postMessage({ type: 'resetLayout', moduleName: view.moduleName })}>Reset Layout</button>
          <span>{view.nodes.length} blocks</span>
          <span>{view.edges.length} wires</span>
        </header>
        {view.diagnostics.length > 0 && (
          <aside className="diagnostics">
            {view.diagnostics.slice(0, 3).map((diagnostic, index) => (
              <div key={`${diagnostic.message}-${index}`} className={`diagnostic diagnostic-${diagnostic.severity}`}>
                {diagnostic.message}
              </div>
            ))}
          </aside>
        )}
        <main className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            nodesConnectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <MiniMap pannable zoomable className="svsch-minimap" />
            <Controls />
          </ReactFlow>
        </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
