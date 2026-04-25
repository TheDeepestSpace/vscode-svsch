import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { moveRouteSegment, normalizeRoutePoints } from '../../src/webview/orthogonal';

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
      200,
      40,
      400,
      160,
      Position.Right,
      Position.Left
    );

    expect(route[0]).toEqual({ x: 248, y: 40 });
    expect(route[route.length - 1]).toEqual({ x: 352, y: 160 });
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
    expect(moved[2].x).toBe(201);
    expect(moved[3].x).toBe(201);
    expect(moved[2].y).toBe(moved[1].y);
    expect(moved[3].y).toBe(moved[4].y);
  });
});
