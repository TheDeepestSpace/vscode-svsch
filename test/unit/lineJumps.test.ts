import { describe, expect, it } from 'vitest';
import {
  buildLineJumpPath,
  buildLineJumpRender,
  defaultLineJumpOptions,
  getEdgeOverlapHints,
  type PolylineEdgeGeometry
} from '../../src/webview/react-flow-line-jumps';

function edge(
  edgeId: string,
  points: Array<{ x: number; y: number }>,
  sourceId?: string,
  targetId?: string
): PolylineEdgeGeometry {
  return { edgeId, points, sourceId, targetId };
}

describe('react-flow-line-jumps crossings', () => {
  it('adds an arc jump for a perpendicular crossing', () => {
    const lower = edge('a', [{ x: 0, y: 50 }, { x: 100, y: 50 }], 'src-a');
    const upper = edge('b', [{ x: 50, y: 0 }, { x: 50, y: 100 }], 'src-b');

    const path = buildLineJumpPath(upper, [lower, upper]);

    expect(path).toContain('Q');
    expect(path).toBe('M 50 0 L 50 43 Q 57 50 50 57 L 50 100');
  });

  it('returns isolated jump arc paths for jump halos', () => {
    const lower = edge('a', [{ x: 0, y: 50 }, { x: 100, y: 50 }], 'src-a');
    const upper = edge('b', [{ x: 50, y: 0 }, { x: 50, y: 100 }], 'src-b');

    const render = buildLineJumpRender(upper, [lower, upper]);

    expect(render.path).toContain('Q');
    expect(render.jumpPaths).toEqual(['M 50 43 Q 57 50 50 57']);
  });

  it('uses deterministic edge ordering so only one crossing edge jumps', () => {
    const lower = edge('a', [{ x: 0, y: 50 }, { x: 100, y: 50 }], 'src-a');
    const upper = edge('b', [{ x: 50, y: 0 }, { x: 50, y: 100 }], 'src-b');

    expect(buildLineJumpPath(lower, [lower, upper])).not.toContain('Q');
    expect(buildLineJumpPath(upper, [lower, upper])).toContain('Q');
  });

  it('still adds a jump when same-source edges cross after their shared trunk', () => {
    const first = edge('a', [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 120 }], 'src');
    const second = edge('b', [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 60 }, { x: 40, y: 60 }], 'src');

    const path = buildLineJumpPath(second, [first, second]);

    expect(path).toContain('Q');
    expect(path).toContain('Q 80 53 73 60');
  });

  it('ignores endpoint-near crossings', () => {
    const lower = edge('a', [{ x: 0, y: 50 }, { x: 100, y: 50 }], 'src-a');
    const upper = edge('b', [{ x: 5, y: 0 }, { x: 5, y: 100 }], 'src-b');

    expect(buildLineJumpPath(upper, [lower, upper])).toBe('M 5 0 L 5 100');
  });

  it('sorts multiple crossings along a segment', () => {
    const first = edge('a', [{ x: 30, y: 0 }, { x: 30, y: 100 }], 'src-a');
    const second = edge('b', [{ x: 70, y: 0 }, { x: 70, y: 100 }], 'src-b');
    const crossingEdge = edge('c', [{ x: 0, y: 50 }, { x: 100, y: 50 }], 'src-c');

    const path = buildLineJumpPath(crossingEdge, [first, second, crossingEdge]);

    expect(path.indexOf('Q 30 43 37 50')).toBeLessThan(path.indexOf('Q 70 43 77 50'));
  });
});

describe('react-flow-line-jumps overlap hints', () => {
  it('adds an overlap hint for same-direction collinear unrelated sources', () => {
    const first = edge('a', [{ x: 0, y: 20 }, { x: 100, y: 20 }], 'src-a');
    const second = edge('b', [{ x: 40, y: 20 }, { x: 140, y: 20 }], 'src-b');

    expect(getEdgeOverlapHints(second, [first, second])).toEqual([
      {
        id: 'b-overlap-0-a-0',
        path: 'M 50 20 L 90 20'
      }
    ]);
  });

  it('adds an overlap hint for opposite-direction collinear unrelated sources', () => {
    const first = edge('a', [{ x: 0, y: 20 }, { x: 100, y: 20 }], 'src-a');
    const second = edge('b', [{ x: 140, y: 20 }, { x: 40, y: 20 }], 'src-b');

    expect(getEdgeOverlapHints(second, [first, second])[0].path).toBe('M 50 20 L 90 20');
  });

  it('suppresses same-source shared trunk overlap hints', () => {
    const first = edge('a', [{ x: 0, y: 20 }, { x: 100, y: 20 }], 'src');
    const second = edge('b', [{ x: 0, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 80 }], 'src');

    expect(getEdgeOverlapHints(second, [first, second])).toEqual([]);
  });

  it('trims partial overlaps to the shared interior span', () => {
    const first = edge('a', [{ x: 0, y: 20 }, { x: 100, y: 20 }], 'src-a');
    const second = edge('b', [{ x: 50, y: 20 }, { x: 160, y: 20 }], 'src-b');

    expect(getEdgeOverlapHints(second, [first, second])[0].path).toBe('M 60 20 L 90 20');
  });

  it('ignores endpoint-near or tiny overlaps', () => {
    const first = edge('a', [{ x: 0, y: 20 }, { x: 100, y: 20 }], 'src-a');
    const tiny = edge('b', [{ x: 91, y: 20 }, { x: 130, y: 20 }], 'src-b');

    expect(getEdgeOverlapHints(tiny, [first, tiny])).toEqual([]);
  });

  it('does not create jump arcs for pure overlaps', () => {
    const first = edge('a', [{ x: 0, y: 20 }, { x: 100, y: 20 }], 'src-a');
    const second = edge('b', [{ x: 40, y: 20 }, { x: 140, y: 20 }], 'src-b');

    expect(buildLineJumpPath(second, [first, second])).not.toContain('Q');
  });

  it('exports stable defaults through the public entrypoint', () => {
    expect(defaultLineJumpOptions).toEqual({
      jumpSize: 7,
      endpointPadding: 10,
      minOverlapLength: 16
    });
  });
});
