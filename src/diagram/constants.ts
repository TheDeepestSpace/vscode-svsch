export const diagramGrid = {
  size: 24,
  nodeWidthUnits: 8,
  muxWidthUnits: 4,
  registerWidthUnits: 4,
  nodeHeightUnits: 4,
  combMinHeightUnits: 2,
  literalMinWidthUnits: 2,
  literalMinHeightUnits: 2,
  nodeHeaderUnits: 1.5,
  portWidthUnits: 5,
  portHeightUnits: 2,
  portSkinHeightUnits: 1,
  portNoseLengthUnits: 0.5,
  muxRightSideHeightUnits: 2,
  edgeLeadUnits: 1,
  nodeHorizontalPaddingUnits: 1,
  muxHorizontalPaddingUnits: 1,
  portHorizontalPaddingUnits: 1,
  textWidthUnits: 0.28,
  minNodeSeparationUnits: 7,
  sameLayerNodeSeparationUnits: 1,
  columnGapUnits: 11,
  rowGapUnits: 6
} as const;

export const diagramSizing = {
  gridSize: diagramGrid.size,
  nodeWidth: diagramGrid.size * diagramGrid.nodeWidthUnits,
  muxWidth: diagramGrid.size * diagramGrid.muxWidthUnits,
  registerWidth: diagramGrid.size * diagramGrid.registerWidthUnits,
  nodeHeight: diagramGrid.size * diagramGrid.nodeHeightUnits,
  combMinHeight: diagramGrid.size * diagramGrid.combMinHeightUnits,
  literalMinWidth: diagramGrid.size * diagramGrid.literalMinWidthUnits,
  literalMinHeight: diagramGrid.size * diagramGrid.literalMinHeightUnits,
  nodeHeaderHeight: diagramGrid.size * diagramGrid.nodeHeaderUnits,
  portWidth: diagramGrid.size * diagramGrid.portWidthUnits,
  portHeight: diagramGrid.size * diagramGrid.portHeightUnits,
  portSkinHeight: diagramGrid.size * diagramGrid.portSkinHeightUnits,
  portNoseLength: diagramGrid.size * diagramGrid.portNoseLengthUnits,
  muxRightSideHeight: diagramGrid.size * diagramGrid.muxRightSideHeightUnits,
  edgeLeadLength: diagramGrid.size * diagramGrid.edgeLeadUnits,
  nodeHorizontalPadding: diagramGrid.size * diagramGrid.nodeHorizontalPaddingUnits,
  muxHorizontalPadding: diagramGrid.size * diagramGrid.muxHorizontalPaddingUnits,
  portHorizontalPadding: diagramGrid.size * diagramGrid.portHorizontalPaddingUnits,
  textWidth: diagramGrid.size * diagramGrid.textWidthUnits,
  minNodeSeparation: diagramGrid.size * diagramGrid.minNodeSeparationUnits,
  sameLayerNodeSeparation: diagramGrid.size * diagramGrid.sameLayerNodeSeparationUnits,
  columnGap: diagramGrid.size * diagramGrid.columnGapUnits,
  rowGap: diagramGrid.size * diagramGrid.rowGapUnits
} as const;

export function snapUpToGrid(value: number): number {
  return Math.ceil(value / diagramGrid.size) * diagramGrid.size;
}

export function snapUpToEvenGrid(value: number): number {
  const units = Math.ceil(value / diagramGrid.size);
  const evenUnits = units % 2 === 0 ? units : units + 1;
  return evenUnits * diagramGrid.size;
}

export function nodeHeightForPortRows(portRows: number): number {
  return Math.max(diagramSizing.nodeHeight, snapUpToGrid(diagramSizing.nodeHeaderHeight + diagramGrid.size * Math.max(1, portRows)));
}

export function muxHeightForPortRows(portRows: number): number {
  return snapUpToEvenGrid(nodeHeightForPortRows(portRows));
}

export function combHeightForPortRows(portRows: number): number {
  return Math.max(
    diagramSizing.combMinHeight,
    snapUpToGrid(diagramSizing.nodeHeaderHeight + diagramGrid.size * Math.max(1, portRows))
  );
}

export function literalHeightForPortRows(portRows: number): number {
  return Math.max(
    diagramSizing.literalMinHeight,
    snapUpToEvenGrid(diagramGrid.size * Math.max(1, portRows))
  );
}

export function nodePortCenterOffset(rowIndex: number): number {
  return diagramSizing.nodeHeaderHeight + diagramGrid.size * rowIndex + diagramGrid.size / 2;
}

export function ioPortCenterOffset(): number {
  return diagramSizing.portHeight / 2;
}

export function normalizeWidth(width: string | undefined): string | undefined {
  if (!width) {
    return undefined;
  }
  const trimmed = width.replace(/\s+/g, '');
  if (trimmed === '[0:0]' || trimmed === '[0]') {
    return undefined;
  }
  const rangeMatch = trimmed.match(/^\[(\d+):(\d+)\]$/);
  if (rangeMatch && rangeMatch[1] === rangeMatch[2]) {
    return undefined;
  }
  return width;
}
