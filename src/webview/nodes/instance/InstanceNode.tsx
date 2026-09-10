import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { diagramSizing, nodePortCenterOffset } from '../../../diagram/constants';
import { resolvedNodeDimensions, instanceParameterRows } from '../../../diagram/nodeSizing';
import { nodeIsArrayNode } from '../../../ir/nodeMetadata';
import { nodeStackIsWide } from '../../../ir/edgeStyle';
import type { DiagramPort, PositionedNode } from '../../../ir/types';
import { ArrayStackSelection } from '../shared/skins';
import { InstanceParameterList } from '../shared/labels';
import { HdlNodeBase } from '../shared/HdlNodeBase';
import { NodeWarningIcon } from '../shared/NodeWarningIcon';
import { InputPortHandles } from '../shared/InputPortHandles';
import { NodeResizeControls } from '../shared/NodeResizeControls';
import { ExpandGrabBands } from '../shared/ExpandGrabBands';
import { handleNodeDoubleClick, navigateToSource } from '../shared/navigation';
import type { HdlNodeData } from '../types';
import { InstanceNodeSvg } from './InstanceNodeSvg';

/** Catch-all: instance nodes and any unrecognized kind. */
export function InstanceNode({ id, data }: { id: string; data: HdlNodeData }): React.ReactElement {
  const node = data.node as PositionedNode;
  const arrayConnections = data.arrayConnections ?? [];
  const isArray = nodeIsArrayNode(node);
  // Instance blocks can render larger than their canonical auto-fit box when
  // a manual resize override is saved; the resolved size drives the actual
  // render/edge-anchoring, matching the register kind's resize handling.
  const { width: nodeWidth, height: nodeHeight } = resolvedNodeDimensions(node);
  const nodeStyle = {
    '--svsch-node-width': `${nodeWidth}px`,
    '--svsch-node-height': `${nodeHeight}px`,
    '--svsch-port-width': `${diagramSizing.portWidth}px`,
  } as React.CSSProperties;

  const instanceParameters =
    node.kind === 'instance'
      ? (node.instanceParameters ?? node.metadata?.instanceParameters ?? [])
      : [];
  const parameterRows = instanceParameterRows(node);
  const sideInputs = node.ports.filter(
    (port: DiagramPort) =>
      port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown',
  );
  const outputs = node.ports.filter((port: DiagramPort) => port.direction === 'output');

  return (
    <HdlNodeBase
      node={node}
      width={nodeWidth}
      height={nodeHeight}
      style={nodeStyle}
      className={`hdl-node hdl-node-${node.kind}${instanceParameters.length > 0 ? ' hdl-node-has-params' : ''}${isArray ? ` hdl-node-array${nodeStackIsWide(node) ? ' hdl-node-array-wide' : ''}` : ''}`}
      title={
        node.source
          ? `${node.source.file}${node.source.startLine ? `:${node.source.startLine}` : ''}`
          : node.kind
      }
      // A function/task call's own body has no standalone module to navigate
      // to (issue #335) — until it does, double-click is a no-op for these
      // kinds; Expand (toolbar button, see NodeSelectionToolbar) is the only
      // way to unfold its logic in place, same trigger an instance's Expand
      // uses (an instance's own double-click still navigates, via
      // handleNodeDoubleClick below).
      onDoubleClick={() => {
        if (node.kind === 'funcCall' || node.kind === 'taskCall') return;
        handleNodeDoubleClick(node);
      }}
      svg={
        <InstanceNodeSvg
          node={node}
          width={nodeWidth}
          height={nodeHeight}
          arrayConnections={arrayConnections}
          onNavigateToSource={navigateToSource}
        />
      }
      extraContent={
        // HTML instance parameter chips — needed for test ".instance-parameter-chip" selectors
        instanceParameters.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: `${16 + Math.max(0, (parameterRows * diagramSizing.gridSize - (instanceParameters.length * 16 + Math.max(0, instanceParameters.length - 1) * 2)) / 2)}px`,
              left: 0,
              right: 0,
            }}
          >
            <InstanceParameterList parameters={instanceParameters} />
          </div>
        )
      }
      handles={
        <>
          {sideInputs.map((port: DiagramPort, i: number) => (
            <InputPortHandles
              key={port.id}
              port={port}
              position={Position.Left}
              style={{ top: nodePortCenterOffset(i + parameterRows) }}
            />
          ))}
          {outputs.map((port: DiagramPort, i: number) => (
            <Handle
              key={port.id}
              type="source"
              id={port.id}
              position={Position.Right}
              style={{ top: nodePortCenterOffset(i + parameterRows) }}
            />
          ))}
        </>
      }
      selection={
        isArray ? (
          <ArrayStackSelection
            kind="rect"
            width={nodeWidth}
            height={nodeHeight}
            wide={nodeStackIsWide(node)}
          />
        ) : (
          <div className="hdl-node-selection-rect" aria-hidden="true" />
        )
      }
      resizeControls={
        <>
          {data.expandContentInsets && <ExpandGrabBands insets={data.expandContentInsets} />}
          {/* An expanded instance's frame (data.expandContentInsets set — see
              expandOverlay's dimAsExpandGhost) offers no resize handles at all:
              its size is always derived fresh from the child module's own
              current layout (see splice.ts's expandedFrameSize), never a manual
              override (see the product decision in issue #232's PR review). */}
          {node.kind === 'instance' && !data.expandContentInsets && (
            <NodeResizeControls nodeId={id} />
          )}
        </>
      }
      warningIcon={<NodeWarningIcon node={node} width={nodeWidth} height={nodeHeight} />}
    />
  );
}
