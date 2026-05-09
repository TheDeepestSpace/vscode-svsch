import { describe, expect, it } from 'vitest';
import { projectElkRoutes } from '../../src/layout/mergeLayout';
import { findNetJunctions, moveSharedNetSegments } from '../../src/webview/orthogonal/netGeometry';
import type { DiagramEdge } from '../../src/ir/types';
import type { PolylineEdgeGeometry } from '../../src/webview/react-flow-line-jumps';

function edge(id: string, target: string): DiagramEdge {
  return {
    id,
    source: 'source:a',
    sourcePort: 'p',
    target,
    targetPort: 'p'
  };
}

function geometry(edgeId: string, points: Array<{ x: number; y: number }>, netKey = 'source:a:p'): PolylineEdgeGeometry {
  return {
    edgeId,
    points,
    sourceId: netKey,
    netKey
  };
}

describe('ELK branched route projection', () => {
  it('projects a hyperedge section tree into per-target edge routes', () => {
    const routes = projectElkRoutes([
      {
        id: 'net:source:a:p',
        sections: [
          {
            id: 'root',
            incomingShape: 'source:a:p',
            incomingSections: [],
            outgoingSections: ['x', 'y'],
            startPoint: { x: 24, y: 48 },
            bendPoints: [{ x: 120, y: 48 }],
            endPoint: { x: 120, y: 96 }
          },
          {
            id: 'x',
            incomingSections: ['root'],
            outgoingShape: 'target:x:p',
            startPoint: { x: 120, y: 96 },
            endPoint: { x: 240, y: 96 }
          },
          {
            id: 'y',
            incomingSections: ['root'],
            outgoingShape: 'target:y:p',
            startPoint: { x: 120, y: 96 },
            bendPoints: [{ x: 120, y: 168 }],
            endPoint: { x: 240, y: 168 }
          }
        ]
      }
    ], [
      edge('edge-a-to-x', 'target:x'),
      edge('edge-a-to-y', 'target:y')
    ]);

    expect(routes.get('edge-a-to-x')).toEqual([
      { x: 24, y: 48 },
      { x: 120, y: 48 },
      { x: 120, y: 96 },
      { x: 240, y: 96 }
    ]);
    expect(routes.get('edge-a-to-y')).toEqual([
      { x: 24, y: 48 },
      { x: 120, y: 48 },
      { x: 120, y: 96 },
      { x: 120, y: 168 },
      { x: 240, y: 168 }
    ]);
  });
});

describe('same-net junctions and shared dragging', () => {
  it('detects visual junction points where same-net branches split', () => {
    const junctions = findNetJunctions([
      geometry('edge-a-to-x', [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 96 }, { x: 240, y: 96 }]),
      geometry('edge-a-to-y', [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 168 }, { x: 240, y: 168 }])
    ]);

    expect(junctions).toEqual([
      { id: 'source:a:p:120:96', x: 120, y: 96 }
    ]);
  });

  it('moves only same-net overlapping editable segments together', () => {
    const moves = moveSharedNetSegments([
      geometry('edge-a-to-x', [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 96 }, { x: 240, y: 96 }]),
      geometry('edge-a-to-y', [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 168 }, { x: 240, y: 168 }]),
      geometry('edge-b-to-z', [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 240 }], 'source:b:p')
    ], 'edge-a-to-x', 1, { x: 60, y: 48 });

    expect(moves.map((move) => move.edgeId).sort()).toEqual(['edge-a-to-x', 'edge-a-to-y', 'edge-b-to-z']);
    expect(moves.find((move) => move.edgeId === 'edge-a-to-x')?.points[1].y).toBe(48);
    expect(moves.find((move) => move.edgeId === 'edge-a-to-y')?.points[1].y).toBe(48);
    expect(moves.find((move) => move.edgeId === 'edge-b-to-z')?.points[1].y).toBe(48);
  });
});
