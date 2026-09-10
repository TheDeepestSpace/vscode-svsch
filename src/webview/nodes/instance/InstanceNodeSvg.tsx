import React from 'react';
import type { NodeSvgProps } from '../shared/NodeSvgProps';
import { diagramSizing, nodePortCenterOffset } from '../../../diagram/constants';
import { instanceParameterRows } from '../../../diagram/nodeSizing';
import { nodeArrayDimension, nodeIsArrayNode } from '../../../ir/nodeMetadata';
import { nodeStackIsWide } from '../../../ir/edgeStyle';
import { arrayStackLayersFor, arrayStackSkinLayersFor } from '../../arrayStackGeometry';
import { SvgArrayStackLeads } from '../shared/SvgArrayStackLeads';
import { ArrayStackSkinRect } from '../shared/ArrayStackSkinRect';
import {
  SvgParameterizedText,
  SvgParameterizedTextUnderlines,
  SvgPortLabel,
} from '../shared/labels';
import {
  hasArrayConnection as sharedHasArrayConnection,
  arrayConnectionThick as sharedArrayConnectionThick,
} from '../shared/arrayConnections';
import type { DiagramPort, InstanceParameter } from '../../../ir/types';
import { isInputSidePort } from '../../../diagram/portDirection';

export function InstanceNodeSvg({
  node,
  width,
  height,
  arrayConnections,
  onNavigateToSource,
}: NodeSvgProps): React.ReactElement {
  const isArray = nodeIsArrayNode(node);
  const stackWide = isArray && nodeStackIsWide(node);
  const stackLayers = arrayStackLayersFor(stackWide);
  const skinLayers = arrayStackSkinLayersFor(stackWide);
  const arrayDim = nodeArrayDimension(node);
  const hasArrayConnection = (portId: string | undefined, role: 'source' | 'target'): boolean =>
    sharedHasArrayConnection(arrayConnections, portId, role);
  const arrayConnectionThick = (portId: string | undefined, role: 'source' | 'target'): boolean =>
    sharedArrayConnectionThick(arrayConnections, portId, role);
  const g = diagramSizing.gridSize;
  const inputs: DiagramPort[] = node.ports.filter(isInputSidePort);
  const outputs: DiagramPort[] = node.ports.filter((p: DiagramPort) => p.direction === 'output');

  const instanceParameters: InstanceParameter[] =
    node.kind === 'instance'
      ? (node.instanceParameters ?? node.metadata?.instanceParameters ?? [])
      : [];
  const paramRows = instanceParameterRows(node);

  // Module name shown as kind label, instance label as title
  const kindLabel =
    node.kind === 'instance' && node.instanceOf
      ? node.instanceOf
      : node.kind === 'funcCall'
        ? 'FUNCTION'
        : node.kind === 'taskCall'
          ? 'TASK'
          : node.label;
  const contentShiftX = isArray ? stackLayers.front.dx : 0;
  const contentShiftY = isArray ? stackLayers.front.dy : 0;
  const shapeTransform = isArray
    ? `translate(${stackLayers.front.dx}, ${stackLayers.front.dy})`
    : undefined;
  const monoTextWidth = (text: string, fontSize: number, weight: 'normal' | 'bold' = 'normal') =>
    text.length * fontSize * (weight === 'bold' ? 0.68 : 0.62);
  const paramFontSize = 10;
  const chipHeight = 16;
  const chipGap = 2;
  const chipPaddingX = 4;
  const chipStackHeight =
    instanceParameters.length > 0
      ? instanceParameters.length * chipHeight +
        Math.max(0, instanceParameters.length - 1) * chipGap
      : 0;
  const chipStackTop = 16 + Math.max(0, (paramRows * g - chipStackHeight) / 2);
  const chipTextY = (index: number) =>
    Math.round(chipStackTop + index * (chipHeight + chipGap) + chipHeight / 2 + contentShiftY);
  const chipY = (index: number) => chipTextY(index) - chipHeight / 2;
  const chipX = 12 + contentShiftX;
  const titleY = Math.round(
    paramRows > 0
      ? 16 + g * paramRows + (diagramSizing.nodeHeaderHeight - 16) / 2 + contentShiftY
      : 26 + contentShiftY,
  );

  const targetStackLeads = (
    <>
      {isArray &&
        inputs.map((port: DiagramPort, i: number) =>
          hasArrayConnection(port.id, 'target') ? (
            <SvgArrayStackLeads
              wide={stackWide}
              thick={arrayConnectionThick(port.id, 'target')}
              key={`lead-${port.id}`}
              side="left"
              width={width}
              y={nodePortCenterOffset(i + paramRows)}
              trimSink
            />
          ) : null,
        )}
    </>
  );

  return (
    <>
      {targetStackLeads}
      <ArrayStackSkinRect
        isArray={isArray}
        skinLayers={skinLayers}
        shapeTransform={shapeTransform}
        width={width}
        height={height}
      />
      <text
        className="svsch-node-kind"
        x={12 + contentShiftX}
        y={14 + contentShiftY}
        textAnchor="start"
        dominantBaseline="middle"
      >
        {kindLabel}
      </text>
      {isArray && arrayDim && (
        <text className="svsch-node-kind svsch-array-badge" x={width + 3} y={-4} textAnchor="start">
          {arrayDim}
        </text>
      )}

      {instanceParameters.map((param: InstanceParameter, i: number) => {
        const name = param.name ?? '';
        const value = param.value ?? '';
        const nameWidth = monoTextWidth(name, paramFontSize, 'bold');
        const equalsWidth = value ? monoTextWidth('=', paramFontSize) : 0;
        const valueWidth = value ? monoTextWidth(value, paramFontSize) : 0;
        const chipWidth = chipPaddingX * 2 + nameWidth + equalsWidth + valueWidth;
        return (
          <g key={param.name ?? i} className="svsch-instance-param-chip">
            <rect
              className="svsch-instance-param-chip-bg"
              x={chipX}
              y={chipY(i)}
              width={chipWidth}
              height={chipHeight}
              rx={4}
            />
            <text
              className="svsch-instance-param"
              x={chipX + chipPaddingX}
              y={chipTextY(i)}
              dominantBaseline="middle"
              fontSize={paramFontSize}
            >
              <tspan className="svsch-instance-param-name">{name}</tspan>
              {value && (
                <>
                  <tspan className="svsch-instance-param-equals">=</tspan>
                  <tspan className="svsch-instance-param-value">
                    <SvgParameterizedText
                      text={value}
                      refs={param.parameterRefs}
                      onNavigateToSource={onNavigateToSource}
                    />
                  </tspan>
                </>
              )}
            </text>
            {value && (
              <SvgParameterizedTextUnderlines
                text={value}
                refs={param.parameterRefs}
                x={chipX + chipPaddingX + nameWidth + equalsWidth}
                y={chipTextY(i)}
                fontSize={paramFontSize}
                textWidth={(part) => monoTextWidth(part, paramFontSize)}
                className="svsch-instance-param-link-underline"
              />
            )}
          </g>
        );
      })}

      <text
        className="svsch-node-title"
        x={12 + contentShiftX}
        y={titleY}
        textAnchor="start"
        dominantBaseline="middle"
      >
        {node.label}
        {isArray && <tspan className="svsch-svg-array-index"> [0]</tspan>}
      </text>

      {inputs.map((port: DiagramPort, i: number) => (
        <text
          key={port.id}
          className="svsch-port-label"
          x={12 + contentShiftX}
          y={nodePortCenterOffset(i + paramRows) + contentShiftY}
          dominantBaseline="middle"
        >
          <SvgPortLabel port={port} showWidth collapseWidth />
        </text>
      ))}

      {outputs.map((port: DiagramPort, i: number) => (
        <text
          key={port.id}
          className="svsch-port-label"
          x={width - 12 + contentShiftX}
          y={nodePortCenterOffset(i + paramRows) + contentShiftY}
          textAnchor="end"
          dominantBaseline="middle"
        >
          <SvgPortLabel port={port} showWidth collapseWidth />
        </text>
      ))}

      {/* Array stack leads (source/right side; target/left side painted before
          the stack layers) */}
      {isArray &&
        outputs.map((port: DiagramPort, i: number) =>
          hasArrayConnection(port.id, 'source') ? (
            <SvgArrayStackLeads
              wide={stackWide}
              thick={arrayConnectionThick(port.id, 'source')}
              key={`lead-${port.id}`}
              side="right"
              width={width}
              y={nodePortCenterOffset(i + paramRows)}
            />
          ) : null,
        )}
    </>
  );
}
