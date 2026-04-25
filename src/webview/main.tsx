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
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  useReactFlow,
  useEdgesState,
  useNodesState
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';

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
}>;
  diagnostics: Array<{ severity: string; message: string }>;
}

interface GraphMessage {
  type: 'graph';
  view: DiagramViewModel;
  modules: string[];
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();

function DiagramEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data
}: EdgeProps): React.ReactElement {
  const reactFlow = useReactFlow();
  const edgeData = data as {
    waypoint?: { x: number; y: number };
    onWaypointChange?: (edgeId: string, waypoint: { x: number; y: number }, commit: boolean) => void;
  } | undefined;
  const waypoint = edgeData?.waypoint;
  const [edgePath, labelX, labelY] = waypoint
    ? routedWaypointPath(sourceX, sourceY, targetX, targetY, waypoint)
    : getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 10
    });
  const handle = waypoint ?? { x: labelX, y: labelY };

  const moveWaypoint = (event: React.PointerEvent, commit: boolean) => {
    edgeData?.onWaypointChange?.(
      id,
      reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      commit
    );
  };

  return (
    <>
      <path className="svsch-edge-bridge" d={edgePath} />
      <path className="svsch-edge" d={edgePath} />
      <circle
        className="svsch-edge-waypoint"
        cx={handle.x}
        cy={handle.y}
        r={6}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          moveWaypoint(event, false);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            moveWaypoint(event, false);
          }
        }}
        onPointerUp={(event) => {
          moveWaypoint(event, true);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      {label && (
        <foreignObject width={48} height={22} x={labelX - 24} y={labelY - 11} className="svsch-edge-label">
          <div>{label}</div>
        </foreignObject>
      )}
    </>
  );
}

function routedWaypointPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  waypoint: { x: number; y: number }
): [string, number, number] {
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${waypoint.x} ${sourceY}`,
    `L ${waypoint.x} ${waypoint.y}`,
    `L ${targetX} ${waypoint.y}`,
    `L ${targetX} ${targetY}`
  ].join(' ');
  return [path, waypoint.x, waypoint.y];
}

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
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PositionedNode>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const reactFlow = useReactFlow();
  const [hasFitInitialView, setHasFitInitialView] = useState(false);
  const handleWaypointChange = useCallback((edgeId: string, waypoint: { x: number; y: number }, commit: boolean) => {
    setEdges((currentEdges) => currentEdges.map((edge) => (
      edge.id === edgeId
        ? { ...edge, data: { ...edge.data, waypoint } }
        : edge
    )));

    if (commit && view) {
      vscode.postMessage({
        type: 'edgeLayoutChanged',
        moduleName: view.moduleName,
        edgeId,
        waypoint
      });
    }
  }, [setEdges, view]);

  useEffect(() => {
    const listener = (event: MessageEvent<GraphMessage>) => {
      if (event.data.type === 'graph') {
        setView(event.data.view);
        setModules(event.data.modules);
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
        onWaypointChange: handleWaypointChange
      }
    })));
  }, [handleWaypointChange, setEdges, setNodes, view]);

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
  const edgeTypes = useMemo(() => ({ svsch: DiagramEdge }), []);

  if (!view) {
    return <div className="empty">Building diagram...</div>;
  }

  return (
    <div className="shell">
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
