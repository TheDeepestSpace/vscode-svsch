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

export interface DiagramNodeDimensions {
  width: number;
  height: number;
}

export function diagramNodeDimensions(node: DiagramNode): DiagramNodeDimensions {
  const isInterfaceInstance = node.kind === 'interface' && structRole(node) !== 'modport';
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
  const sideInputs = node.kind === 'mux' ? inputs.slice(1) : inputs;
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

  if (node.kind === 'bus' || node.kind === 'struct' || node.kind === 'interface') {
    const role = structRole(node);
    if (node.kind === 'interface' && role === 'port') {
      return diagramSizing.gridSize;
    }
    if (node.kind === 'interface' && role === 'modport') {
      return diagramSizing.gridSize * Math.max(4, (inputsCount + outputsCount) * 2 + 2);
    }
    const isInstance = node.kind === 'interface' && role !== 'modport';
    const minHeightUnits = isInstance ? 4 : 2;
    return Math.max(
      nodeHeightForPortRows(Math.max(inputsCount, outputsCount)),
      diagramSizing.gridSize * Math.max(minHeightUnits, node.kind === 'interface' ? (inputsCount + outputsCount) * 2 : outputsCount * 2)
    );
  }

  if (node.kind === 'mux') {
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

  return nodeHeightForPortRows(portRows);
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
  const portLabels = visiblePortLabels(node, sideInputs, outputs);
  const longestPortLabel = Math.max(0, ...portLabels.map(measureText));
  const titleWidth = measureText(title);

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

  if (node.kind === 'mux') {
    const inputLabelWidth = Math.max(0, ...sideInputs.map((port) => measureText(portLabel(port, true))));
    const outputLabelWidth = Math.max(0, ...outputs.slice(0, 1).map((port) => measureText(port.label ?? port.name)));
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
    const isCenteredInterfaceInstance = node.kind === 'interface' && structRole(node) !== 'modport';
    const isModport = node.kind === 'interface' && structRole(node) === 'modport';
    return snappedWidth(
      diagramSizing.nodeWidth,
      Math.max(tbWidth, longestPortLabel + diagramSizing.gridSize * 3 + diagramSizing.nodeHorizontalPadding),
      (isCenteredInterfaceInstance || isModport) ? snapUpToEvenGrid : snapUpToGrid
    );
  }

  return snappedWidth(
    diagramSizing.nodeWidth,
    Math.max(titleWidth, sideLabelWidth(sideInputs) + sideLabelWidth(outputs)) + diagramSizing.nodeHorizontalPadding * 2
  );
}

function sideLabelWidth(ports: DiagramNode['ports']): number {
  return Math.max(0, ...ports.map((port) => measureText(portLabel(port, true))));
}

function visiblePortLabels(
  node: DiagramNode,
  sideInputs: DiagramNode['ports'],
  outputs: DiagramNode['ports']
): string[] {
  if (node.kind === 'comb' || node.kind === 'alu') {
    return outputs.map((port) => portLabel(port, true));
  }

  if (node.kind === 'replicate') {
    return [];
  }

  if (node.kind === 'mux') {
    return [
      ...sideInputs.map((port) => portLabel(port, true)),
      ...outputs.slice(0, 1).map((port) => port.label ?? port.name)
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
    return taps.map((port) => portLabel(port, false));
  }

  return [...sideInputs, ...outputs].map((port) => portLabel(port, true));
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
  const width = normalizeWidth(port.width);
  const typeName = port.typeName;
  const suffix = typeName || width;
  return suffix ? `${node.label} ${suffix}` : node.label;
}

function portLabel(port: DiagramNode['ports'][number], showWidth: boolean): string {
  const label = port.label ?? port.name;
  const width = normalizeWidth(port.width);
  const typeName = port.typeName;
  const suffix = typeName || (showWidth ? width : undefined);
  return suffix ? `${label} ${suffix}` : label;
}

function measureText(text: string): number {
  return text.length * diagramSizing.textWidth;
}

function snappedWidth(minWidth: number, neededWidth: number, snap = snapUpToGrid): number {
  return Math.max(minWidth, snap(neededWidth));
}
