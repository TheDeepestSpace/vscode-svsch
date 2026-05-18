import type { DiagramNode } from '../ir/types';
import { nodeTypeName, nodeWidth, registerClockSignal, registerResetSignal, structRole } from '../ir/nodeMetadata';
import {
  combHeightForPortRows,
  diagramSizing,
  literalHeightForPortRows,
  muxHeightForPortRows,
  nodeHeightForPortRows,
  normalizeWidth,
  snapUpToEvenGrid,
  snapUpToGrid
} from './constants';
import { selectPortLabel } from './selectLabels';

export interface DiagramNodeDimensions {
  width: number;
  height: number;
}

export function diagramNodeDimensions(node: DiagramNode): DiagramNodeDimensions {
  const role = structRole(node);
  const isInterfaceInstance = node.kind === 'interface' && role !== 'modport' && role !== 'port';
  const visiblePorts = node.kind === 'interface'
    ? node.ports.filter((port) => port.width !== 'interface' || port.preferredSide || port.id.endsWith(':left') || port.id.endsWith(':right'))
    : node.ports;

  const topPorts = isInterfaceInstance ? visiblePorts.filter(p => p.direction === 'input' && p.width !== 'interface') : [];
  const bottomPorts = isInterfaceInstance ? visiblePorts.filter(p => p.direction === 'output' && p.width !== 'interface') : [];
  const sidePorts = isInterfaceInstance
    ? visiblePorts.filter(p => p.width === 'interface' || (p.direction !== 'input' && p.direction !== 'output'))
    : visiblePorts;

  const inputs = sidePorts.filter((port) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown');
  const outputs = sidePorts.filter((port) => port.direction === 'output');
  const topInputCount = node.kind === 'mux'
    ? 1
    : node.kind === 'select'
      ? inputs.filter((port, index) => index === 0 || port.name === 'width').length
      : 0;
  const sideInputs = topInputCount > 0 ? inputs.slice(topInputCount) : inputs;
  const portRows = Math.max(sideInputs.length, outputs.length);

  let height = nodeHeightForKind(node, inputs.length, outputs.length, portRows);
  return {
    width: nodeWidthForKind(node, sideInputs, outputs, topPorts, bottomPorts),
    height
  };
}

function nodeHeightForKind(node: DiagramNode, inputsCount: number, outputsCount: number, portRows: number): number {
  if (node.kind === 'port') {
    return diagramSizing.portHeight;
  }

  if (node.kind === 'interface' || node.kind === 'bus' || node.kind === 'struct') {
    const role = structRole(node);
    if (node.kind === 'interface' && role === 'port') {
      return diagramSizing.portHeight;
    }

    const isInterfaceInstance = node.kind === 'interface' && role !== 'modport';
    const height = (node.kind === 'interface' && role === 'port')
      ? diagramSizing.gridSize
      : (node.kind === 'interface' && role === 'modport')
        ? diagramSizing.gridSize * Math.max(4, (inputsCount + outputsCount) * 2 + 2)
        : Math.max(
          nodeHeightForPortRows(Math.max(inputsCount, outputsCount)),
          diagramSizing.gridSize * Math.max(node.kind === 'interface' ? 4 : 2, node.kind === 'interface' ? (inputsCount + outputsCount) * 2 : outputsCount * 2)
        );
    return height + (isInterfaceInstance ? diagramSizing.gridSize * 3 + diagramSizing.gridSize / 2 : 0);
  }

  if (node.kind === 'mux' || node.kind === 'select') {
    return muxHeightForPortRows(portRows);
  }

  if (node.kind === 'alu') {
    return muxHeightForPortRows(2);
  }

  if (node.kind === 'register') {
    return nodeHeightForPortRows(Math.max(2, outputsCount, registerVisibleInputRows(node)));
  }

  if (node.kind === 'comb') {
    return combHeightForPortRows(portRows);
  }

  if (node.kind === 'replicate') {
    return diagramSizing.gridSize * 2;
  }

  if (node.kind === 'literal') {
    return literalHeightForPortRows(portRows);
  }

  const baseHeight = nodeHeightForPortRows(portRows);
  const parameterRows = instanceParameterRows(node);
  if (parameterRows > 0) {
    return baseHeight + diagramSizing.gridSize * parameterRows;
  }
  return baseHeight;
}

export function instanceParameterRows(node: DiagramNode): number {
  if (node.kind !== 'instance') return 0;
  return node.instanceParameters?.length ?? node.metadata?.instanceParameters?.length ?? 0;
}

function registerVisibleInputRows(node: DiagramNode): number {
  const clockSignal = registerClockSignal(node);
  const resetSignal = registerResetSignal(node);
  const inputs = node.ports.filter((port) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown');
  const dPort = inputs.find((port) => port.name === 'D') ?? inputs[0];
  const clockPort = inputs.find((port) => port.name === clockSignal)
    ?? inputs.find((port) => port.name !== 'D' && port.name !== resetSignal);
  const resetPort = resetSignal
    ? inputs.find((port) => port.name === resetSignal)
    : undefined;
  const rvPort = inputs.find((port) => port.name === 'RV');
  const reservedPortIds = new Set([dPort?.id, clockPort?.id, resetPort?.id, rvPort?.id].filter(Boolean));
  const extraInputs = inputs.filter((port) => !reservedPortIds.has(port.id));
  return Math.max(2, extraInputs.length + (rvPort ? 3 : 2));
}

function nodeWidthForKind(
  node: DiagramNode,
  sideInputs: DiagramNode['ports'],
  outputs: DiagramNode['ports'],
  topPorts: DiagramNode['ports'] = [],
  bottomPorts: DiagramNode['ports'] = []
): number {
  const title = nodeTitle(node);
  const showPortTypes = node.kind !== 'instance';
  const portLabels = visiblePortLabels(node, sideInputs, outputs, showPortTypes);
  const longestPortLabel = Math.max(0, ...portLabels.map(measureText));
  const titleWidth = measureText(title);
  const instanceParameterWidth = node.kind === 'instance'
    ? Math.max(0, ...((node.instanceParameters ?? node.metadata?.instanceParameters ?? []).map((param) => measureText(`${param.name}=${param.value ?? ''}`))))
    : 0;

  const topLabelWidth = topPorts.length > 0
    ? (topPorts.length * 2 - 1) * diagramSizing.gridSize + Math.max(...topPorts.map(p => measureText(p.label ?? p.name)))
    : 0;
  const bottomLabelWidth = bottomPorts.length > 0
    ? (bottomPorts.length * 2 - 1) * diagramSizing.gridSize + Math.max(...bottomPorts.map(p => measureText(p.label ?? p.name)))
    : 0;
  const tbWidth = Math.max(topLabelWidth, bottomLabelWidth) + diagramSizing.nodeHorizontalPadding * 2;

  if (node.kind === 'port') {
    return snappedWidth(
      diagramSizing.portWidth,
      measureText(portNodeLabel(node)) + diagramSizing.portNoseLength + diagramSizing.portHorizontalPadding
    );
  }

  if (node.kind === 'mux' || node.kind === 'select') {
    const isSelect = node.kind === 'select';
    const inputLabelWidth = Math.max(0, ...sideInputs.map((port) => measureText(isSelect ? selectPortLabel(node, port.label ?? port.name) : portLabel(port, true, showPortTypes))));
    const outputLabelWidth = Math.max(0, ...outputs.slice(0, 1).map((port) => measureText(isSelect ? selectPortLabel(node, port.label ?? port.name) : port.label ?? port.name)));
    return snappedWidth(
      diagramSizing.muxWidth,
      inputLabelWidth + outputLabelWidth + diagramSizing.muxHorizontalPadding,
      snapUpToEvenGrid
    );
  }

  if (node.kind === 'alu') {
    return snappedWidth(
      diagramSizing.muxWidth,
      diagramSizing.gridSize * 3,
      snapUpToEvenGrid
    );
  }

  if (node.kind === 'register') {
    return snappedWidth(
      diagramSizing.registerWidth,
      Math.max(titleWidth, measureText('D') + measureText('Q') + diagramSizing.gridSize) + diagramSizing.nodeHorizontalPadding * 2,
      snapUpToEvenGrid
    );
  }

  if (node.kind === 'comb') {
    return diagramSizing.nodeWidth;
  }

  if (node.kind === 'replicate') {
    return snappedWidth(
      diagramSizing.gridSize * 2,
      titleWidth + 8
    );
  }

  if (node.kind === 'literal') {
    return snappedWidth(
      diagramSizing.literalMinWidth,
      titleWidth + 8
    );
  }

  if (node.kind === 'bus' || node.kind === 'struct' || node.kind === 'interface') {
    const role = structRole(node);
    if (node.kind === 'interface' && role === 'port') {
      return snappedWidth(
        diagramSizing.portWidth,
        measureText(portNodeLabel(node)) + diagramSizing.portNoseLength * 2 + diagramSizing.portHorizontalPadding
      );
    }

    const isCenteredInterfaceInstance = node.kind === 'interface' && role !== 'modport';
    const isModport = node.kind === 'interface' && role === 'modport';
    
    let interfaceInstanceTitleWidth = 0;
    if (isCenteredInterfaceInstance) {
      const typeName = nodeTypeName(node);
      interfaceInstanceTitleWidth = measureText(node.label + (typeName ? ` ${typeName}` : ''));
    }

    const capPortCount = Math.max(topPorts.length, bottomPorts.length);
    const tbPortNeededWidth = capPortCount > 0 
      ? Math.max(diagramSizing.gridSize * 4, capPortCount * diagramSizing.gridSize * 3)
      : 0;
    
    // Ensure at least 2 grid widths of clearance on each side of the hat/labels
    const tbClearance = capPortCount > 0 ? diagramSizing.gridSize * 4 : 0;
    const tbWidthNeeded = Math.max(tbPortNeededWidth, topLabelWidth, bottomLabelWidth) + tbClearance;

    return snappedWidth(
      diagramSizing.nodeWidth,
      Math.max(
        tbWidthNeeded,
        interfaceInstanceTitleWidth + diagramSizing.nodeHorizontalPadding * 2,
        longestPortLabel + diagramSizing.gridSize * 3 + diagramSizing.nodeHorizontalPadding
      ),
      (isCenteredInterfaceInstance || isModport) ? snapUpToEvenGrid : snapUpToGrid
    );
  }

  return snappedWidth(
    diagramSizing.nodeWidth,
    Math.max(titleWidth, instanceParameterWidth, sideLabelWidth(node, sideInputs) + sideLabelWidth(node, outputs)) + diagramSizing.nodeHorizontalPadding * 2
  );
}

function sideLabelWidth(node: DiagramNode, ports: DiagramNode['ports']): number {
  const showPortTypes = node.kind !== 'instance';
  return Math.max(0, ...ports.map((port) => measureText(portLabel(port, true, showPortTypes, node.kind === 'instance'))));
}

function visiblePortLabels(
  node: DiagramNode,
  sideInputs: DiagramNode['ports'],
  outputs: DiagramNode['ports'],
  showPortTypes: boolean
): string[] {
  if (node.kind === 'comb' || node.kind === 'loop') {
    return [];
  }

  if (node.kind === 'alu') {
    return outputs.map((port) => portLabel(port, true, showPortTypes));
  }

  if (node.kind === 'replicate') {
    return [];
  }

  if (node.kind === 'mux' || node.kind === 'select') {
    const isSelect = node.kind === 'select';
    return [
      ...sideInputs.map((port) => isSelect ? `${port.label ?? port.name}[]` : portLabel(port, true, showPortTypes)),
      ...outputs.slice(0, 1).map((port) => isSelect ? `${port.label ?? port.name}[]` : port.label ?? port.name)
    ];
  }

  if (node.kind === 'register') {
    return ['D', 'Q', 'R'];
  }

  if (node.kind === 'bus' || node.kind === 'struct' || node.kind === 'interface') {
    const role = structRole(node);
    const taps = node.kind === 'interface' && role === 'modport'
      ? node.ports
      : node.kind === 'struct'
      ? (role === 'composition' ? sideInputs : outputs)
      : node.kind === 'interface'
        ? [...sideInputs, ...outputs]
        : (sideInputs.length > 1 ? sideInputs : outputs);
    return taps.map((port) => portLabel(port, false, showPortTypes));
  }

  return [...sideInputs, ...outputs].map((port) => portLabel(port, true, showPortTypes, node.kind === 'instance'));
}

function nodeTitle(node: DiagramNode): string {
  const metadataWidth = normalizeWidth(nodeWidth(node));
  const outputWidth = node.kind === 'register' || node.kind === 'latch' || node.kind === 'literal'
    ? normalizeWidth(node.ports.find((port) => port.direction === 'output')?.width)
    : undefined;
  const width = metadataWidth ?? outputWidth;
  const typeName = nodeTypeName(node);
  const base = node.label;
  const suffix = typeName || width;
  return suffix && node.kind !== 'comb' && node.kind !== 'alu' && node.kind !== 'bus' && node.kind !== 'struct' && node.kind !== 'interface' && node.kind !== 'replicate' ? `${base} ${suffix}` : base;
}

function portNodeLabel(node: DiagramNode): string {
  const port = node.ports[0];
  if (!port) {
    return nodeTitle(node);
  }
  const width = normalizeWidth(port.widthExpression ?? port.width);
  const typeName = port.typeName;
  const suffix = typeName && port.modportName ? `${typeName}.${port.modportName}` : typeName || width;
  return suffix ? `${node.label} ${suffix}` : node.label;
}

function portLabel(port: DiagramNode['ports'][number], showWidth: boolean, showType: boolean = true, collapseWidth: boolean = false): string {
  const label = port.label ?? port.name;
  const width = normalizeWidth(port.widthExpression ?? port.width);
  const displayWidth = collapseWidth && width ? '[]' : width;
  const isInterface = width === 'interface' || port.modportName !== undefined;
  const isStruct = !isInterface && port.typeName !== undefined;
  const typeName = showType ? port.typeName : undefined;

  let suffix = '';
  if (isInterface || isStruct) {
    suffix = '{}';
  } else if (collapseWidth && showWidth && displayWidth) {
    suffix = displayWidth;
  } else {
    const typeOrWidth = typeName || (showWidth ? displayWidth : undefined);
    if (typeOrWidth) {
      suffix = ` ${typeOrWidth}`;
    }
  }

  return `${label}${suffix}`;
}

function measureText(text: string): number {
  return text.length * diagramSizing.textWidth;
}

function snappedWidth(minWidth: number, neededWidth: number, snap = snapUpToGrid): number {
  return Math.max(minWidth, snap(neededWidth));
}
