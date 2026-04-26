import type { DiagramNode } from '../ir/types';
import {
  diagramSizing,
  muxHeightForPortRows,
  nodeHeightForPortRows,
  snapUpToEvenGrid,
  snapUpToGrid
} from './constants';

export interface DiagramNodeDimensions {
  width: number;
  height: number;
}

export function diagramNodeDimensions(node: DiagramNode): DiagramNodeDimensions {
  const inputs = node.ports.filter((port) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown');
  const outputs = node.ports.filter((port) => port.direction === 'output');
  const sideInputs = node.kind === 'mux' ? inputs.slice(1) : inputs;
  const portRows = Math.max(sideInputs.length, outputs.length);
  const height = nodeHeightForKind(node, inputs.length, outputs.length, portRows);

  return {
    width: nodeWidthForKind(node, sideInputs, outputs),
    height
  };
}

function nodeHeightForKind(node: DiagramNode, inputsCount: number, outputsCount: number, portRows: number): number {
  if (node.kind === 'port') {
    return diagramSizing.portHeight;
  }

  if (node.kind === 'bus') {
    return Math.max(
      nodeHeightForPortRows(Math.max(inputsCount, outputsCount)),
      diagramSizing.gridSize * Math.max(2, outputsCount * 2)
    );
  }

  if (node.kind === 'mux') {
    return muxHeightForPortRows(portRows);
  }

  if (node.kind === 'register') {
    return nodeHeightForPortRows(Math.max(2, outputsCount));
  }

  return nodeHeightForPortRows(portRows);
}

function nodeWidthForKind(
  node: DiagramNode,
  sideInputs: DiagramNode['ports'],
  outputs: DiagramNode['ports']
): number {
  const title = nodeTitle(node);
  const portLabels = visiblePortLabels(node, sideInputs, outputs);
  const longestPortLabel = Math.max(0, ...portLabels.map(measureText));
  const titleWidth = measureText(title);

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

  if (node.kind === 'register') {
    return snappedWidth(
      diagramSizing.registerWidth,
      Math.max(titleWidth, measureText('D') + measureText('Q') + diagramSizing.gridSize) + diagramSizing.nodeHorizontalPadding * 2
    );
  }

  if (node.kind === 'comb') {
    return snappedWidth(
      diagramSizing.nodeWidth,
      Math.max(titleWidth, sideLabelWidth(outputs)) + diagramSizing.nodeHorizontalPadding * 2
    );
  }

  if (node.kind === 'bus') {
    return snappedWidth(
      diagramSizing.nodeWidth,
      Math.max(longestPortLabel + diagramSizing.gridSize * 3, titleWidth) + diagramSizing.nodeHorizontalPadding
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
  if (node.kind === 'comb') {
    return outputs.map((port) => portLabel(port, true));
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

  return [...sideInputs, ...outputs].map((port) => portLabel(port, true));
}

function nodeTitle(node: DiagramNode): string {
  const width = typeof node.metadata?.width === 'string' ? node.metadata.width : undefined;
  const base = node.kind === 'instance' && node.instanceOf ? `${node.label} : ${node.instanceOf}` : node.label;
  return width && node.kind !== 'comb' && node.kind !== 'bus' ? `${base} ${width}` : base;
}

function portNodeLabel(node: DiagramNode): string {
  const port = node.ports[0];
  if (!port) {
    return nodeTitle(node);
  }
  return port.width ? `${nodeTitle(node)} ${port.width}` : nodeTitle(node);
}

function portLabel(port: DiagramNode['ports'][number], showWidth: boolean): string {
  const label = port.label ?? port.name;
  return showWidth && port.width ? `${label} ${port.width}` : label;
}

function measureText(text: string): number {
  return text.length * diagramSizing.textWidth;
}

function snappedWidth(minWidth: number, neededWidth: number, snap = snapUpToGrid): number {
  return Math.max(minWidth, snap(neededWidth));
}
