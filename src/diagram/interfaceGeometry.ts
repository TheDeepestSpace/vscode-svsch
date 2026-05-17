import type { DiagramPort } from '../ir/types';
import { diagramSizing } from './constants';

export function modportSourceOrder(a: DiagramPort, b: DiagramPort): number {
  return (a.modportSource?.startLine ?? a.source?.startLine ?? 0) - (b.modportSource?.startLine ?? b.source?.startLine ?? 0);
}

export function orderedInterfaceSidePorts(sidePorts: DiagramPort[]): { left: DiagramPort[]; right: DiagramPort[] } {
  return {
    left: sidePorts.filter((port) => port.preferredSide === 'left').sort(modportSourceOrder),
    right: sidePorts.filter((port) => port.preferredSide !== 'left').sort(modportSourceOrder)
  };
}

export function interfaceTopHatHeight(hasTopPorts: boolean): number {
  return hasTopPorts ? diagramSizing.gridSize : 0;
}

export function interfaceTopHatBounds(width: number, topPortCount: number): { left: number; right: number; width: number } {
  if (topPortCount <= 0) {
    return { left: width / 2, right: width / 2, width: 0 };
  }

  const noseLength = diagramSizing.portNoseLength;
  const neededWidth = Math.max(diagramSizing.gridSize * 4, topPortCount * diagramSizing.gridSize * 3);
  const hatWidth = Math.min(width - noseLength * 3, neededWidth);
  const left = (width - hatWidth) / 2;
  return {
    left,
    right: left + hatWidth,
    width: hatWidth
  };
}

export function interfaceTopPortX(width: number, topPortCount: number, index: number): number {
  if (topPortCount <= 0) return width / 2;
  const bounds = interfaceTopHatBounds(width, topPortCount);
  return bounds.left + (bounds.width / (topPortCount + 1)) * (index + 1);
}

export function distributedInterfaceSideCenters(count: number, height: number, topOffset: number): number[] {
  if (count <= 0) return [];
  const grid = diagramSizing.gridSize;
  const usableHeight = Math.max(grid, height - topOffset);
  const rowSpacing = grid;
  const start = topOffset + Math.max(grid, (usableHeight - rowSpacing * (count - 1)) / 2);
  return Array.from({ length: count }, (_, index) => {
    return Math.round((start + rowSpacing * index) / grid) * grid;
  });
}

export function interfaceSidePortCenters(sidePorts: DiagramPort[], height: number, topOffset: number): Map<string, number> {
  const ordered = orderedInterfaceSidePorts(sidePorts);
  const centers = new Map<string, number>();
  distributedInterfaceSideCenters(ordered.left.length, height, topOffset)
    .forEach((center, index) => centers.set(ordered.left[index].id, center));
  distributedInterfaceSideCenters(ordered.right.length, height, topOffset)
    .forEach((center, index) => centers.set(ordered.right[index].id, center));
  return centers;
}
