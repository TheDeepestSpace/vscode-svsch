import { describe, expect, it } from 'vitest';
import { diagramSizing } from '../../src/diagram/constants';
import {
  distributedInterfaceSideCenters,
  interfaceTopHatBounds,
  interfaceTopHatHeight,
  interfaceTopHatTop,
  interfaceTopPortX,
  orderedInterfaceSidePorts
} from '../../src/diagram/interfaceGeometry';
import type { DiagramPort } from '../../src/ir/types';

describe('interface instance geometry', () => {
  it('orders side modports by source line while preserving preferred side', () => {
    const ports = [
      port('monitor', 'right', 30),
      port('controller', 'left', 40),
      port('producer', 'left', 10),
      port('consumer', 'right', 20)
    ];

    const ordered = orderedInterfaceSidePorts(ports);

    expect(ordered.left.map((p) => p.name)).toEqual(['producer', 'controller']);
    expect(ordered.right.map((p) => p.name)).toEqual(['consumer', 'monitor']);
  });

  it('distributes top ports along the top-hat and keeps side sockets one grid tall', () => {
    const width = diagramSizing.gridSize * 8;
    const topHat = interfaceTopHatBounds(width, 2);
    const topXs = [interfaceTopPortX(width, 2, 0), interfaceTopPortX(width, 2, 1)];
    const sideCenters = distributedInterfaceSideCenters(2, diagramSizing.gridSize * 8, interfaceTopHatHeight(true));

    expect(topHat.width).toBeGreaterThanOrEqual(diagramSizing.gridSize * 4);
    expect(topXs[0]).toBeGreaterThan(topHat.left);
    expect(topXs[1]).toBeLessThan(topHat.right);
    expect(topXs[1] - topXs[0]).toBeGreaterThanOrEqual(diagramSizing.gridSize);
    expect(sideCenters[1] - sideCenters[0]).toBe(diagramSizing.gridSize * 2);
    expect(sideCenters.every((center) => center % (diagramSizing.gridSize / 2) === 0)).toBe(true);
    expect(interfaceTopHatTop(sideCenters, interfaceTopHatHeight(true))).toBe(sideCenters[0] - diagramSizing.gridSize * 1.5);
  });

  it('aligns interface top-hat with shifted side centers', () => {
    const grid = diagramSizing.gridSize;
    const shiftY = grid; // 24px
    const rawCenters = [84, 132];
    const shiftedCenters = rawCenters.map(c => c + shiftY);
    const topHatHeight = grid;
    const topHatTop = interfaceTopHatTop(shiftedCenters, topHatHeight);

    // sideTop = min(shiftedCenters) - grid / 2 = 108 - 12 = 96
    // topHatTop = sideTop - topHatHeight = 96 - 24 = 72
    expect(topHatTop).toBe(72);
    expect(topHatTop % (grid / 2)).toBe(0);
  });
});

function port(name: string, preferredSide: 'left' | 'right', startLine: number): DiagramPort {
  return {
    id: name,
    name,
    direction: preferredSide === 'left' ? 'input' : 'output',
    width: 'interface',
    preferredSide,
    modportSource: { file: 'fixture.sv', startLine }
  };
}
