import { describe, expect, it } from 'vitest';
import { diagramSizing } from '../../src/diagram/constants';
import type { DiagramNode } from '../../src/ir/types';
import { routingObstacleMargins } from '../../src/layout/routingObstacleGeometry';

function terminal(direction: 'input' | 'output'): DiagramNode {
  return {
    id: direction,
    kind: 'port',
    label: direction,
    ports: [{ id: direction, name: direction, direction }],
  };
}

describe('routing obstacle geometry', () => {
  it('reserves vertical snapping room and a trailing-side corridor for input terminals', () => {
    expect(routingObstacleMargins(terminal('input'), ['EAST'])).toEqual({
      left: diagramSizing.gridSize,
      right: 0,
      top: diagramSizing.gridSize / 2,
      bottom: diagramSizing.gridSize / 2,
    });
  });

  it('mirrors the trailing-side corridor for output terminals', () => {
    expect(routingObstacleMargins(terminal('output'), ['WEST'])).toEqual({
      left: 0,
      right: diagramSizing.gridSize,
      top: diagramSizing.gridSize / 2,
      bottom: diagramSizing.gridSize / 2,
    });
  });

  it('keeps a left-side and half-grid vertical corridor around literals', () => {
    const literal: DiagramNode = {
      id: 'literal',
      kind: 'literal',
      label: '1',
      ports: [{ id: 'out', name: 'out', direction: 'output' }],
    };

    expect(routingObstacleMargins(literal, ['EAST'])).toEqual({
      left: diagramSizing.gridSize,
      right: 0,
      top: diagramSizing.gridSize / 2,
      bottom: diagramSizing.gridSize / 2,
    });
  });

  it("uses the lead instead of extra obstacle padding on a cut source end's connected side", () => {
    const cutEnd: DiagramNode = {
      id: 'cut-label:clk:source',
      kind: 'netLabel',
      label: 'clk',
      ports: [{ id: 'cut', name: 'cut', direction: 'input' }],
      metadata: { cutNet: { netKey: 'clk', role: 'source', align: 'end', handleSide: 'left' } },
    };

    expect(routingObstacleMargins(cutEnd, ['WEST'])).toEqual({
      left: 0,
      right: diagramSizing.gridSize,
      top: diagramSizing.gridSize,
      bottom: diagramSizing.gridSize,
    });
  });

  it('mirrors cut-end clearance for a sink end with a right-side lead', () => {
    const cutEnd: DiagramNode = {
      id: 'cut-label:clk:sink',
      kind: 'netLabel',
      label: 'clk',
      ports: [{ id: 'cut', name: 'cut', direction: 'output' }],
      metadata: { cutNet: { netKey: 'clk', role: 'sink', align: 'start', handleSide: 'right' } },
    };

    expect(routingObstacleMargins(cutEnd, ['EAST'])).toEqual({
      left: diagramSizing.gridSize,
      right: 0,
      top: diagramSizing.gridSize,
      bottom: diagramSizing.gridSize,
    });
  });

  it('gives an expanded module instance a full-grid clearance on every side', () => {
    const expandedInstance: DiagramNode = {
      id: 'u_instr_mem',
      kind: 'instance',
      label: 'u_instr_mem',
      ports: [
        { id: 'addr', name: 'addr', direction: 'input' },
        { id: 'instr', name: 'instr', direction: 'output' },
      ],
      sizeOverride: { width: 20, height: 16 },
      metadata: { expandGhost: { insets: { top: 24, left: 24, right: 24, bottom: 24 } } },
    };

    expect(routingObstacleMargins(expandedInstance, ['WEST', 'EAST'])).toEqual({
      left: diagramSizing.gridSize,
      right: diagramSizing.gridSize,
      top: diagramSizing.gridSize,
      bottom: diagramSizing.gridSize,
    });
  });

  it('leaves a plain, unexpanded instance without left/right obstacle clearance', () => {
    const instance: DiagramNode = {
      id: 'u_plain',
      kind: 'instance',
      label: 'u_plain',
      ports: [{ id: 'addr', name: 'addr', direction: 'input' }],
    };

    expect(routingObstacleMargins(instance, ['WEST'])).toEqual({
      left: 0,
      right: 0,
      top: diagramSizing.gridSize / 2,
      bottom: diagramSizing.gridSize / 2,
    });
  });
});
