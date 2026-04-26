export const diagramGrid = {
  size: 24,
  nodeWidthUnits: 8,
  muxWidthUnits: 4,
  nodeHeightUnits: 4,
  nodeHeaderUnits: 1.5,
  portWidthUnits: 5,
  portHeightUnits: 2,
  portSkinHeightUnits: 1,
  portNoseLengthUnits: 0.5,
  muxRightSideHeightUnits: 2,
  edgeLeadUnits: 3,
  minNodeSeparationUnits: 7,
  sameLayerNodeSeparationUnits: 1,
  columnGapUnits: 11,
  rowGapUnits: 6
} as const;

export const diagramSizing = {
  gridSize: diagramGrid.size,
  nodeWidth: diagramGrid.size * diagramGrid.nodeWidthUnits,
  muxWidth: diagramGrid.size * diagramGrid.muxWidthUnits,
  nodeHeight: diagramGrid.size * diagramGrid.nodeHeightUnits,
  nodeHeaderHeight: diagramGrid.size * diagramGrid.nodeHeaderUnits,
  portWidth: diagramGrid.size * diagramGrid.portWidthUnits,
  portHeight: diagramGrid.size * diagramGrid.portHeightUnits,
  portSkinHeight: diagramGrid.size * diagramGrid.portSkinHeightUnits,
  portNoseLength: diagramGrid.size * diagramGrid.portNoseLengthUnits,
  muxRightSideHeight: diagramGrid.size * diagramGrid.muxRightSideHeightUnits,
  edgeLeadLength: diagramGrid.size * diagramGrid.edgeLeadUnits,
  minNodeSeparation: diagramGrid.size * diagramGrid.minNodeSeparationUnits,
  sameLayerNodeSeparation: diagramGrid.size * diagramGrid.sameLayerNodeSeparationUnits,
  columnGap: diagramGrid.size * diagramGrid.columnGapUnits,
  rowGap: diagramGrid.size * diagramGrid.rowGapUnits
} as const;

export function nodeHeightForPortRows(portRows: number): number {
  return Math.max(diagramSizing.nodeHeight, snapUpToGrid(diagramSizing.nodeHeaderHeight + diagramGrid.size * Math.max(1, portRows)));
}

export function muxHeightForPortRows(portRows: number): number {
  const height = nodeHeightForPortRows(portRows);
  const units = Math.ceil(height / diagramGrid.size);
  const evenUnits = units % 2 === 0 ? units : units + 1;
  return evenUnits * diagramGrid.size;
}

export function nodePortCenterOffset(rowIndex: number): number {
  return diagramSizing.nodeHeaderHeight + diagramGrid.size * rowIndex + diagramGrid.size / 2;
}

export function ioPortCenterOffset(): number {
  return diagramSizing.portHeight / 2;
}

function snapUpToGrid(value: number): number {
  return Math.ceil(value / diagramGrid.size) * diagramGrid.size;
}
