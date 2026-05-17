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

export function interfaceTopHatTop(sideCenters: number[], topHatHeight: number): number {
  if (topHatHeight <= 0 || sideCenters.length === 0) return 0;
  const grid = diagramSizing.gridSize;
  const sideTop = Math.min(...sideCenters) - grid / 2;
  return Math.max(0, sideTop - topHatHeight);
}

export function interfaceTopHatBounds(width: number, topPortCount: number, capPortCount = topPortCount): { left: number; right: number; width: number } {
  if (topPortCount <= 0 && capPortCount <= 0) {
    return { left: width / 2, right: width / 2, width: 0 };
  }

  const noseLength = diagramSizing.portNoseLength;
  const neededWidth = Math.max(diagramSizing.gridSize * 4, capPortCount * diagramSizing.gridSize * 3);
  const hatWidth = Math.min(width - noseLength * 3, neededWidth);
  const left = (width - hatWidth) / 2;
  return {
    left,
    right: left + hatWidth,
    width: hatWidth
  };
}

export function interfaceTopPortX(width: number, topPortCount: number, index: number, capPortCount = topPortCount): number {
  if (topPortCount <= 0) return width / 2;
  const bounds = interfaceTopHatBounds(width, topPortCount, capPortCount);
  return bounds.left + (bounds.width / (topPortCount + 1)) * (index + 1);
}

export function distributedInterfaceSideCenters(count: number, height: number, topOffset: number, bottomOffset = 0): number[] {
  if (count <= 0) return [];
  const grid = diagramSizing.gridSize;
  const rowSpacing = grid * 2;
  const requiredHeight = rowSpacing * (count - 1) + grid;
  const usableHeight = Math.max(requiredHeight, height - topOffset - bottomOffset);
  const start = count === 1 && bottomOffset > 0
    ? topOffset + usableHeight - grid / 2
    : topOffset + grid / 2 + (usableHeight - requiredHeight) / 2;
  return Array.from({ length: count }, (_, index) => {
    const snap = grid / 2;
    return Math.round((start + rowSpacing * index) / snap) * snap;
  });
}

export function interfaceSidePortCenters(sidePorts: DiagramPort[], height: number, topOffset: number, bottomOffset = 0): Map<string, number> {
  const ordered = orderedInterfaceSidePorts(sidePorts);
  const centers = new Map<string, number>();
  distributedInterfaceSideCenters(ordered.left.length, height, topOffset, bottomOffset)
    .forEach((center, index) => centers.set(ordered.left[index].id, center));
  distributedInterfaceSideCenters(ordered.right.length, height, topOffset, bottomOffset)
    .forEach((center, index) => centers.set(ordered.right[index].id, center));
  return centers;
}

export function portSkinPath(direction: 'input' | 'output' | 'harness', width: number, height: number, skinHeight: number, noseLength: number): string {
  const top = (height - skinHeight) / 2;
  const midY = height / 2;
  const bottom = top + skinHeight;
  if (direction === 'input') {
    return `M 0 ${top} H ${width - noseLength} L ${width} ${midY} L ${width - noseLength} ${bottom} H 0 Z`;
  } else if (direction === 'output') {
    return `M ${noseLength} ${top} H ${width} V ${bottom} H ${noseLength} L 0 ${midY} Z`;
  } else {
    // Harness: chevrons on both sides
    return `M ${noseLength} ${top} H ${width - noseLength} L ${width} ${midY} L ${width - noseLength} ${bottom} H ${noseLength} L 0 ${midY} Z`;
  }
}

export function interfaceSkinPath({
  width,
  height,
  leftCenters,
  rightCenters,
  topPortCount,
  bottomPortCount = 0,
  shiftY = 0
}: {
  width: number;
  height: number;
  leftCenters: number[];
  rightCenters: number[];
  topPortCount: number;
  bottomPortCount?: number;
  shiftY?: number;
}): { path: string; topHatTop: number; topHatHeight: number; bottomHatTop: number; bottomHatHeight: number } {
  const noseLength = diagramSizing.portNoseLength;
  const grid = diagramSizing.gridSize;
  const hasTopHat = topPortCount > 0;
  const hasBottomHat = bottomPortCount > 0;
  const capPortCount = Math.max(topPortCount, bottomPortCount);
  const topHatHeight = interfaceTopHatHeight(hasTopHat);
  const bottomHatHeight = interfaceTopHatHeight(hasBottomHat);
  const topHat = interfaceTopHatBounds(width, topPortCount, capPortCount);
  const bottomHat = interfaceTopHatBounds(width, bottomPortCount, capPortCount);
  const topHatLeft = topHat.left;
  const topHatRight = topHat.right;
  const bottomHatLeft = bottomHat.left;
  const bottomHatRight = bottomHat.right;
  const bottomHatTop = height - bottomHatHeight;
  const bodyBottom = bottomHatTop;
  const leftShoulder = noseLength;
  const rightShoulder = width - noseLength;
  const capLefts = [
    ...(hasTopHat ? [topHatLeft] : []),
    ...(hasBottomHat ? [bottomHatLeft] : [])
  ];
  const capRights = [
    ...(hasTopHat ? [topHatRight] : []),
    ...(hasBottomHat ? [bottomHatRight] : [])
  ];
  const leftInnerWall = capLefts.length > 0 ? Math.min(...capLefts) : leftShoulder;
  const rightInnerWall = capRights.length > 0 ? Math.max(...capRights) : rightShoulder;
  const notchHalfHeight = grid / 2;
  const bodyTopFallback = topHatHeight + shiftY;
  const hasLeftNotches = leftCenters.length > 0;
  const hasRightNotches = rightCenters.length > 0;
  const fallbackCenter = bodyTopFallback + (bodyBottom - bodyTopFallback) / 2;
  const usableLeftCenters = hasLeftNotches || hasRightNotches ? leftCenters : [fallbackCenter];
  const usableRightCenters = hasLeftNotches || hasRightNotches ? rightCenters : [fallbackCenter];
  const allCenters = [...usableLeftCenters, ...usableRightCenters];
  
  // Calculate unshiftedTopHatTop and then shift it
  const unshiftedSideCenters = allCenters.map(c => c - shiftY);
  const unshiftedTopHatTop = interfaceTopHatTop(unshiftedSideCenters, topHatHeight);
  const topHatTop = unshiftedTopHatTop + shiftY;
  const bodyTop = topHatTop + topHatHeight;

  const topEdgeY = Math.max(bodyTop, Math.min(...allCenters.map((center) => center - notchHalfHeight)));
  const bottomEdgeY = Math.min(bodyBottom, Math.max(...allCenters.map((center) => center + notchHalfHeight)));
  const clampY = (value: number) => Math.max(bodyTop, Math.min(bodyBottom, value));

  const rightNotches = usableRightCenters
    .flatMap((center) => [
      `L ${rightInnerWall} ${clampY(center - notchHalfHeight)}`,
      `H ${rightShoulder}`,
      `L ${width} ${clampY(center)}`,
      `L ${rightShoulder} ${clampY(center + notchHalfHeight)}`,
      `H ${rightInnerWall}`
    ])
    .join(' ');
  const leftNotches = [...usableLeftCenters].reverse()
    .flatMap((center) => [
      `L ${leftInnerWall} ${clampY(center + notchHalfHeight)}`,
      `H ${leftShoulder}`,
      `L 0 ${clampY(center)}`,
      `L ${leftShoulder} ${clampY(center - notchHalfHeight)}`,
      `H ${leftInnerWall}`
    ])
    .join(' ');

  const path = hasTopHat
    ? [
      `M ${topHatLeft} ${topHatTop}`,
      `H ${topHatRight}`,
      `V ${bodyTop}`,
      `H ${rightInnerWall}`,
      `V ${topEdgeY}`,
      hasRightNotches || !hasLeftNotches ? rightNotches : '',
      `L ${rightInnerWall} ${bottomEdgeY}`,
      hasBottomHat
        ? `L ${rightInnerWall} ${bodyBottom} H ${bottomHatRight} V ${height} H ${bottomHatLeft} V ${bodyBottom} H ${leftInnerWall}`
        : `H ${leftInnerWall}`,
      hasLeftNotches || !hasRightNotches ? leftNotches : '',
      `L ${leftInnerWall} ${topEdgeY}`,
      `V ${bodyTop}`,
      `H ${topHatLeft}`,
      'Z'
    ].join(' ')
    : [
      `M ${leftInnerWall} ${topEdgeY}`,
      `H ${rightInnerWall}`,
      hasRightNotches || !hasLeftNotches ? rightNotches : '',
      `L ${rightInnerWall} ${bottomEdgeY}`,
      hasBottomHat
        ? `L ${rightInnerWall} ${bodyBottom} H ${bottomHatRight} V ${height} H ${bottomHatLeft} V ${bodyBottom} H ${leftInnerWall}`
        : `H ${leftInnerWall}`,
      hasLeftNotches || !hasRightNotches ? leftNotches : '',
      'Z'
    ].join(' ');

  return { path, topHatTop, topHatHeight, bottomHatTop, bottomHatHeight };
}
