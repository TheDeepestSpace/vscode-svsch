import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { moveRouteSegment, normalizeRoutePoints } from '../../src/webview/orthogonal';
import { diagramSizing } from '../../src/diagram/constants';

describe('orthogonal edge routing', () => {
  it('recomputes protected lead points when connected nodes move', () => {
    const route = normalizeRoutePoints(
      {
        routePoints: [
          { x: 148, y: 10 },
          { x: 240, y: 10 },
          { x: 240, y: 90 },
          { x: 352, y: 90 }
        ]
      },
      192,
      48,
      408,
      168,
      Position.Right,
      Position.Left
    );

    expect(route[0]).toEqual({ x: 192 + diagramSizing.edgeLeadLength, y: 48 });
    expect(route[route.length - 1]).toEqual({ x: 408 - diagramSizing.edgeLeadLength, y: 168 });
  });

  it('uses grid-aligned lead lengths from the shared diagram sizing', () => {
    const route = normalizeRoutePoints(undefined, 96, 48, 408, 48, Position.Right, Position.Left);

    expect(route[0].x - 96).toBe(diagramSizing.edgeLeadLength);
    expect(408 - route[route.length - 1].x).toBe(diagramSizing.edgeLeadLength);
    expect(diagramSizing.edgeLeadLength % diagramSizing.gridSize).toBe(0);
  });

  it('keeps every route segment orthogonal after stale points are normalized', () => {
    const route = normalizeRoutePoints(
      {
        routePoints: [
          { x: 148, y: 10 },
          { x: 240, y: 10 },
          { x: 260, y: 130 },
          { x: 352, y: 90 }
        ]
      },
      200,
      40,
      400,
      160,
      Position.Right,
      Position.Left
    );

    for (let index = 0; index < route.length - 1; index += 1) {
      const current = route[index];
      const next = route[index + 1];
      expect(current.x === next.x || current.y === next.y).toBe(true);
    }
  });

  it('keeps the dragged segment editable after a tiny pointer movement', () => {
    const points = [
      { x: 100, y: 100 },
      { x: 148, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 352, y: 200 },
      { x: 400, y: 200 }
    ];

    const moved = moveRouteSegment(points, 2, { x: 201, y: 130 });

    expect(moved.length).toBe(points.length);
    expect(moved[2].x).toBe(192);
    expect(moved[3].x).toBe(192);
    expect(moved[2].y).toBe(moved[1].y);
    expect(moved[3].y).toBe(moved[4].y);
  });

  it('normalizes routes to grid-aligned editable segments after connected nodes move', () => {
    const route = normalizeRoutePoints(
      {
        routePoints: [
          { x: 369, y: 94 },
          { x: 474, y: 94 },
          { x: 474, y: 143 },
          { x: 553, y: 143 }
        ]
      },
      288,
      96,
      625,
      168,
      Position.Right,
      Position.Left
    );
    const points = [{ x: 288, y: 96 }, ...route, { x: 625, y: 168 }];
    const editableSegments = points.slice(0, -1).filter((point, index) => {
      const next = points[index + 1];
      const isEditable = index > 0 && index < points.length - 2;
      return isEditable && (point.x === next.x || point.y === next.y);
    });

    expect(route.every((point) => point.x % diagramSizing.gridSize === 0 && point.y % diagramSizing.gridSize === 0)).toBe(true);
    expect(editableSegments.length).toBeGreaterThan(0);
  });

  it('snaps moved segment coordinates to the grid', () => {
    const points = [
      { x: 96, y: 96 },
      { x: 168, y: 96 },
      { x: 240, y: 96 },
      { x: 240, y: 192 },
      { x: 336, y: 192 },
      { x: 408, y: 192 }
    ];

    const moved = moveRouteSegment(points, 2, { x: 251, y: 130 });

    expect(moved[2].x % diagramSizing.gridSize).toBe(0);
    expect(moved[3].x % diagramSizing.gridSize).toBe(0);
  });

  it('lands top mux selector leads back on the grid', () => {
    const route = normalizeRoutePoints(
      undefined,
      96,
      48,
      288,
      103,
      Position.Right,
      Position.Top
    );
    const targetLead = route[route.length - 1];

    expect(targetLead.x).toBe(288);
    expect(targetLead.y % diagramSizing.gridSize).toBe(0);
    expect(targetLead.y).toBeLessThan(103);
  });
});
