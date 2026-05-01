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
  type MiniMapNodeProps,
  useReactFlow,
  useEdgesState,
  useNodesState,
  useNodes
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { diagramSizing, normalizeWidth } from '../diagram/constants';
import { diagramNodeDimensions } from '../diagram/nodeSizing';
import { OrthogonalEdge, type OrthogonalPoint } from './orthogonal';
import type { 
  DiagramNodeKind, 
  DiagramNode, 
  PositionedNode, 
  DiagramViewModel, 
  DiagramPort,
  DiagramEdge
} from '../ir/types';

interface HdlNodeData {
  [key: string]: unknown;
  node: PositionedNode;
}

type HdlFlowNode = Node<HdlNodeData>;

interface GraphMessage {
  type: 'graph';
  view: DiagramViewModel;
  modules: string[];
}

interface StatusMessage {
  type: 'status';
  status: 'idle' | 'rebuilding';
}

import { getVscodeApi } from './vscodeApi';

const vscode = getVscodeApi();

function InputPortSkin({ title, width }: { title: string; width: number }): React.ReactElement {
  return <PortSkin title={title} direction="input" width={width} />;
}

function OutputPortSkin({ title, width }: { title: string; width: number }): React.ReactElement {
  return <PortSkin title={title} direction="output" width={width} />;
}

function PortSkin({ title, direction, width }: { title: string; direction: 'input' | 'output'; width: number }): React.ReactElement {
  const height = diagramSizing.portHeight;
  const skinHeight = diagramSizing.portSkinHeight;
  const noseLength = diagramSizing.portNoseLength;
  const top = (height - skinHeight) / 2;
  const midY = height / 2;
  const bottom = top + skinHeight;
  const path = direction === 'input'
    ? `M 0 ${top} H ${width - noseLength} L ${width} ${midY} L ${width - noseLength} ${bottom} H 0 Z`
    : `M ${noseLength} ${top} H ${width} V ${bottom} H ${noseLength} L 0 ${midY} Z`;

  return (
    <>
      <svg
        className={`port-skin port-skin-${direction}`}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        focusable="false"
      >
        <path className="port-skin-body" d={path} />
        <path className="port-skin-selection" d={path} />
      </svg>
      <div className="port-skin-label">{title}</div>
    </>
  );
}

function MuxSkin({ width, height }: { width: number; height: number }): React.ReactElement {
  const rightSideHeight = Math.min(height, diagramSizing.muxRightSideHeight);
  const rightTop = (height - rightSideHeight) / 2;
  const rightBottom = rightTop + rightSideHeight;
  const path = `M 0 0 L ${width} ${rightTop} V ${rightBottom} L 0 ${height} Z`;

  return (
    <svg
      className="node-skin mux-skin"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <path className="node-skin-body" d={path} />
      <path className="node-skin-selection" d={path} />
    </svg>
  );
}

function muxInputPortCenterY(index: number, count: number, height: number): number {
  const grid = diagramSizing.gridSize;
  const heightUnits = Math.max(1, Math.round(height / grid));
  const startUnit = Math.max(1, Math.ceil((heightUnits - count + 1) / 2));
  return grid * (startUnit + index);
}

function busTapPortCenterY(index: number): number {
  return diagramSizing.gridSize * (index * 2 + 1);
}

function displayPortLabel(port: { name: string; label?: string; width?: string }, showWidth: boolean): string {
  const width = normalizeWidth(port.width);
  const label = normalizeWidth(port.label ?? port.name) === undefined && (port.label ?? port.name).startsWith('[') ? '' : (port.label ?? port.name);
  if (label === '' && !showWidth) {
    // If it was just a bit index like [0], we might still want to show it.
    // But the user said "dont show [0:0]".
    // Let's keep it for now unless it's specifically [0:0].
    const rawLabel = port.label ?? port.name;
    if (rawLabel === '[0:0]') return '';
    return rawLabel;
  }
  return showWidth && width ? `${label} ${width}` : label;
}

function formatNodeKind(node: DiagramNode): string {
  if (node.kind === 'comb') return 'COMBINATIONAL';
  if (node.kind === 'instance' && node.instanceOf) return node.instanceOf;
  return node.kind;
}

function RegisterClockGlyph(): React.ReactElement {

  return (
    <svg className="register-clock-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M 1 1.5 L 9 6 L 1 10.5" />
    </svg>
  );
}

function HdlNode({ data }: NodeProps<HdlFlowNode>): React.ReactElement {
  const node = data.node;
  const width = normalizeWidth(typeof node.metadata?.width === 'string' ? node.metadata.width : undefined);
  const titleBase = node.label;
  const title = width && node.kind !== 'comb' && node.kind !== 'bus' ? `${titleBase} ${width}` : titleBase;
  const inputs = node.ports.filter((port: DiagramPort) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown');
  const outputs = node.ports.filter((port: DiagramPort) => port.direction === 'output');
  const muxSelectPort = node.kind === 'mux' ? inputs[0] : undefined;
  const sideInputs = muxSelectPort ? inputs.filter((port: DiagramPort) => port.id !== muxSelectPort.id) : inputs;
  const portDirection = node.kind === 'port' ? node.ports[0]?.direction ?? 'unknown' : undefined;
  const { width: nodeWidth, height: nodeHeight } = diagramNodeDimensions(node);
  const nodeStyle = {
    '--svsch-node-width': `${nodeWidth}px`,
    '--svsch-node-height': `${nodeHeight}px`,
    '--svsch-port-width': `${node.kind === 'port' ? nodeWidth : diagramSizing.portWidth}px`
  } as React.CSSProperties;

  const handleDoubleClick = () => {
    let msg: any = null;
    if (node.kind === 'instance' && node.moduleName) {
      msg = { type: 'openModule', moduleName: node.moduleName };
    } else if (node.source) {
      msg = { type: 'navigateToSource', source: node.source };
    }
    if (msg) {
      console.log('NAVIGATE:', JSON.stringify(msg));
      vscode.postMessage(msg);
    }
  };

  if (node.kind === 'port') {
    const isOutput = portDirection === 'output';
    const isInput = portDirection === 'input';
    const isSkinnedPort = isInput || isOutput;
    const portWidth = normalizeWidth(node.ports[0]?.width);
    return (
      <button
        className={`hdl-node hdl-node-port hdl-port-${portDirection}${isSkinnedPort ? ' hdl-port-skinned' : ''}`}
        data-node-id={node.id}
        data-node-kind={node.kind}
        style={nodeStyle}
        title={node.source ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}` : 'port'}
        onDoubleClick={handleDoubleClick}
      >
        {isOutput && <Handle type="target" id={node.ports[0]?.id} position={Position.Left} />}
        {isOutput && <Handle type="source" id={node.ports[0]?.id} position={Position.Left} />}
        {isInput ? (
          <InputPortSkin title={portWidth ? `${title} ${portWidth}` : title} width={nodeWidth} />
        ) : isOutput ? (
          <OutputPortSkin title={portWidth ? `${title} ${portWidth}` : title} width={nodeWidth} />
        ) : (
          <>
            <div className="port-direction">{portDirection}</div>
            <div className="port-title">{title}</div>
          </>
        )}
        {!isOutput && <Handle type="source" id={node.ports[0]?.id} position={Position.Right} />}
      </button>
    );
  }

  if (node.kind === 'bus') {
    const tapCenters = outputs.map((_: DiagramPort, index: number) => busTapPortCenterY(index));
    const firstTapCenter = tapCenters[0] ?? nodeHeight / 2;
    const lastTapCenter = tapCenters[tapCenters.length - 1] ?? nodeHeight / 2;
    const busStyle = {
      ...nodeStyle,
      '--svsch-bus-input-y': `${firstTapCenter}px`
    } as React.CSSProperties;
    return (
      <button
        className="hdl-bus-node"
        data-node-id={node.id}
        data-node-kind={node.kind}
        style={busStyle}
        title={node.source ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}` : node.kind}
        onDoubleClick={handleDoubleClick}
      >
        <Handle type="target" id={inputs[0]?.id} position={Position.Left} />
        <div
          className="bus-pipe"
          style={{
            top: `${firstTapCenter - diagramSizing.gridSize / 2}px`,
            bottom: `${nodeHeight - lastTapCenter - diagramSizing.gridSize / 2}px`
          }}
        />
        <div className="bus-taps">
          {outputs.map((port: DiagramPort, index: number) => (
            <div className="bus-tap" key={port.id} style={{ top: `${tapCenters[index] - diagramSizing.gridSize / 2}px` }}>
              <span>{displayPortLabel(port, false)}</span>
              <Handle type="source" id={port.id} position={Position.Right} />
            </div>
          ))}
        </div>
      </button>
    );
  }

  if (node.kind === 'register') {
    const registerClockSignal = typeof node.metadata?.clockSignal === 'string' ? node.metadata.clockSignal : undefined;
    const registerResetSignal = typeof node.metadata?.resetSignal === 'string' ? node.metadata.resetSignal : undefined;
    const resetActiveLow = typeof node.metadata?.resetActiveLow === 'boolean' ? node.metadata.resetActiveLow : false;
    const hasReset = Boolean(registerResetSignal);
    const dPort = inputs.find((port: DiagramPort) => port.name === 'D') ?? inputs[0];
    const qPort = outputs.find((port: DiagramPort) => port.name === 'Q') ?? outputs[0];
    const clockPort = inputs.find((port: DiagramPort) => port.name === registerClockSignal)
      ?? inputs.find((port: DiagramPort) => port.name !== 'D' && port.name !== registerResetSignal);
    const resetPort = registerResetSignal
      ? inputs.find((port: DiagramPort) => port.name === registerResetSignal)
      : undefined;

    return (
      <button
        className="hdl-node hdl-node-register hdl-register-node"
        data-node-id={node.id}
        data-node-kind={node.kind}
        style={{
          ...nodeStyle,
          '--svsch-register-d-top': `${registerPortTop('d', nodeHeight, hasReset)}px`,
          '--svsch-register-q-top': `${registerPortTop('q', nodeHeight, hasReset)}px`,
          '--svsch-register-clock-top': `${registerPortTop('clock', nodeHeight, hasReset)}px`,
          '--svsch-register-reset-top': `${registerPortTop('reset', nodeHeight, hasReset)}px`
        } as React.CSSProperties}
        title={node.source ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}` : node.kind}
        onDoubleClick={handleDoubleClick}
      >
        <div className="node-kind">REGISTER</div>
        <div className="node-title">{title}</div>
        <div className="register-port-layer">
          {dPort && (
            <div className="register-port register-port-d">
              <Handle type="target" id={dPort.id} position={Position.Left} />
              <span>{displayPortLabel(dPort, false)}</span>
            </div>
          )}
          {qPort && (
            <div className="register-port register-port-q">
              <span>{displayPortLabel(qPort, false)}</span>
              <Handle type="source" id={qPort.id} position={Position.Right} />
            </div>
          )}
          {clockPort && (
            <div className="register-port register-clock-port">
              <Handle type="target" id={clockPort.id} position={Position.Left} />
              <RegisterClockGlyph />
            </div>
          )}
          {resetPort && (
            <div className="register-port register-reset-port">
              <span className="register-reset-label">{resetActiveLow ? 'R\u0305' : 'R'}</span>
              <Handle type="target" id={resetPort.id} position={Position.Bottom} />
            </div>
          )}
        </div>
      </button>
    );
  }

  return (
    <button
      className={`hdl-node hdl-node-${node.kind}`}
      data-node-id={node.id}
      data-node-kind={node.kind}
      style={nodeStyle}
      title={node.source ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}` : node.kind}
      onDoubleClick={handleDoubleClick}
    >
      {node.kind === 'mux' && <MuxSkin width={nodeWidth} height={nodeHeight} />}
      {muxSelectPort && (
        <div className="mux-select-port">
          <Handle type="target" id={muxSelectPort.id} position={Position.Top} />
          <span>s</span>
        </div>
      )}
      <div className="node-kind">{formatNodeKind(node)}</div>
      {node.kind !== 'comb' && <div className="node-title">{title}</div>}
      {node.kind === 'mux' ? (
        <div className="mux-port-layer">
          {sideInputs.map((port: DiagramPort, index: number) => (
            <div
              className="mux-side-port"
              key={port.id}
              style={{ top: `${muxInputPortCenterY(index, sideInputs.length, nodeHeight) - diagramSizing.gridSize / 2}px` }}
            >
              <Handle type="target" id={port.id} position={Position.Left} />
              <span>{displayPortLabel(port, node.kind === 'mux')}</span>
            </div>
          ))}
          {outputs.slice(0, 1).map((port: DiagramPort) => (
            <div
              className="mux-output-port"
              key={port.id}
              style={{ top: `${nodeHeight / 2 - diagramSizing.gridSize / 2}px` }}
            >
              <span>{port.label ?? port.name}</span>
              <Handle type="source" id={port.id} position={Position.Right} />
            </div>
          ))}
        </div>
      ) : (
        <div className="node-ports">
          <div>
            {sideInputs.map((port: DiagramPort) => (
              <div className="node-port" key={port.id}>
                <Handle type="target" id={port.id} position={Position.Left} />
                {node.kind === 'comb' ? '' : displayPortLabel(port, true)}
              </div>
            ))}
          </div>
          <div>
            {outputs.map((port: DiagramPort) => (
              <div className="node-port node-port-out" key={port.id}>
                {displayPortLabel(port, true)}
                <Handle type="source" id={port.id} position={Position.Right} />
              </div>
            ))}
          </div>
        </div>
      )}
    </button>
  );
}

function registerPortTop(role: 'd' | 'q' | 'clock' | 'reset', nodeHeight: number, _hasReset: boolean): number {
  const grid = diagramSizing.gridSize;
  if (role === 'd' || role === 'q') {
    return diagramSizing.nodeHeaderHeight;
  }
  if (role === 'clock') {
    return diagramSizing.nodeHeaderHeight + grid;
  }
  return nodeHeight - grid;
}

function MiniMapNode({ id, x, y, width, height, className }: MiniMapNodeProps): React.ReactElement {
  const nodes = useNodes<HdlFlowNode>();
  const flowNode = nodes.find((n: HdlFlowNode) => n.id === id);
  const node = flowNode?.data.node;

  if (!node) {
    return <rect x={x} y={y} width={width} height={height} className={className} fill="var(--vscode-editor-foreground)" />;
  }

  const noseLength = node.kind === 'port' ? (diagramSizing.portNoseLength / diagramSizing.portWidth) * width : 0;
  const midY = y + height / 2;

  let path = `M ${x} ${y} h ${width} v ${height} h ${-width} Z`;

  if (node.kind === 'port') {
    const portDirection = node.ports[0]?.direction ?? 'unknown';
    if (portDirection === 'input') {
      path = `M ${x} ${y} H ${x + width - noseLength} L ${x + width} ${midY} L ${x + width - noseLength} ${y + height} H ${x} Z`;
    } else if (portDirection === 'output') {
      path = `M ${x + noseLength} ${y} H ${x + width} V ${y + height} H ${x + noseLength} L ${x} ${midY} Z`;
    }
  } else if (node.kind === 'mux') {
    const totalHeight = diagramNodeDimensions(node).height;
    const muxRightSideRatio = diagramSizing.muxRightSideHeight / totalHeight;
    const rightSideHeight = height * muxRightSideRatio;
    const rightTop = y + (height - rightSideHeight) / 2;
    const rightBottom = rightTop + rightSideHeight;
    path = `M ${x} ${y} L ${x + width} ${rightTop} V ${rightBottom} L ${x} ${y + height} Z`;
  }

  return (
    <path
      d={path}
      className={className}
      fill="var(--vscode-editor-foreground)"
      stroke="var(--vscode-editor-foreground)"
      strokeOpacity={0.4}
    />
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
  const [nodes, setNodes, onNodesChange] = useNodesState<HdlFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const reactFlow = useReactFlow();
  const [hasFitInitialView, setHasFitInitialView] = useState(false);
  const handleRouteChange = useCallback((edgeId: string, routePoints: OrthogonalPoint[], commit: boolean) => {
    setEdges((currentEdges: Edge[]) => currentEdges.map((edge: Edge) => (
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
      data: { node }
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
        onRouteChange: handleRouteChange,
        edge
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
    (_: React.MouseEvent, dragged: HdlFlowNode, allNodes: HdlFlowNode[]) => {
      if (!view) {
        return;
      }
      const positioned = allNodes.map((node) => ({
        ...node.data.node,
        position: node.id === dragged.id ? dragged.position : node.position,
        fixed: node.data.node.fixed || node.id === dragged.id
      }));
      vscode.postMessage({ type: 'layoutChanged', moduleName: view.moduleName, nodes: positioned });
    },
    [view]
  );

  const nodeTypes = useMemo(() => ({ hdl: HdlNode }), []);
  const edgeTypes = useMemo(() => ({ svsch: OrthogonalEdge }), []);
  const diagramStyle = useMemo(() => ({
    '--svsch-grid': `${diagramSizing.gridSize}px`,
    '--svsch-node-width': `${diagramSizing.nodeWidth}px`,
    '--svsch-node-height': `${diagramSizing.nodeHeight}px`,
    '--svsch-node-header-height': `${diagramSizing.nodeHeaderHeight}px`,
    '--svsch-port-width': `${diagramSizing.portWidth}px`,
    '--svsch-port-height': `${diagramSizing.portHeight}px`,
    '--svsch-port-skin-height': `${diagramSizing.portSkinHeight}px`,
    '--svsch-port-nose-length': `${diagramSizing.portNoseLength}px`,
    '--svsch-handle-offset': '-7px'
  }) as React.CSSProperties, []);

  if (!view) {
    return <div className="empty">Building diagram...</div>;
  }

  return (
    <div className="shell" style={diagramStyle}>
        {status === 'rebuilding' && (
          <div className="busy-indicator" role="status" aria-live="polite">
            <span />
            Updating
          </div>
        )}
        <header className="toolbar">
          <select
            className="vscode-control vscode-select"
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
          <button className="vscode-control vscode-button" onClick={() => vscode.postMessage({ type: 'resetLayout', moduleName: view.moduleName })}>Reset Layout</button>
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
        <main className="canvas" key={view.moduleName}>
          <ReactFlow<HdlFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onEdgeDoubleClick={(event: React.MouseEvent, edge: Edge) => {
              if (edge.data?.edge) {
                const msg = { type: 'navigateToSignal', edge: edge.data.edge };
                console.log('NAVIGATE:', JSON.stringify(msg));
                vscode.postMessage(msg);
              }
            }}
            onInit={(instance: any) => {
              (window as any).reactFlowInstance = instance;
            }}
            nodesConnectable={false}
            deleteKeyCode={null}
            snapToGrid
            snapGrid={[diagramSizing.gridSize, diagramSizing.gridSize]}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={diagramSizing.gridSize} />
            <MiniMap
              pannable
              zoomable
              className="svsch-minimap"
              nodeComponent={MiniMapNode}
            />
            <Controls />
          </ReactFlow>
        </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
