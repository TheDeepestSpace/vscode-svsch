import { moveRouteSegment, segmentOrientation } from './logic';
import type { OrthogonalPoint } from './types';
import type { PolylineEdgeGeometry } from '../react-flow-line-jumps';

const EPSILON = 0.5;

interface Segment {
  edgeId: string;
  netKey?: string;
  index: number;
  start: OrthogonalPoint;
  end: OrthogonalPoint;
  orientation: 'horizontal' | 'vertical';
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface NetJunction {
  id: string;
  x: number;
  y: number;
}

export interface SharedRouteMove {
  edgeId: string;
  points: OrthogonalPoint[];
}

function pointsEqual(a: OrthogonalPoint, b: OrthogonalPoint): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function pointKey(point: OrthogonalPoint): string {
  return `${Math.round(point.x)}:${Math.round(point.y)}`;
}

function directionKey(from: OrthogonalPoint, to: OrthogonalPoint): string | undefined {
  if (Math.abs(from.x - to.x) > EPSILON) {
    return to.x > from.x ? 'right' : 'left';
  }
  if (Math.abs(from.y - to.y) > EPSILON) {
    return to.y > from.y ? 'down' : 'up';
  }
  return undefined;
}

function segmentsFor(geometry: PolylineEdgeGeometry): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index < geometry.points.length - 1; index += 1) {
    const start = geometry.points[index];
    const end = geometry.points[index + 1];
    const orientation = segmentOrientation(start, end);
    if (!orientation || pointsEqual(start, end)) {
      continue;
    }
    segments.push({
      edgeId: geometry.edgeId,
      netKey: geometry.netKey,
      index,
      start,
      end,
      orientation,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y)
    });
  }
  return segments;
}

function pointOnSegmentInterior(point: OrthogonalPoint, segment: Segment): boolean {
  if (segment.orientation === 'horizontal') {
    return Math.abs(point.y - segment.start.y) <= EPSILON
      && point.x > segment.minX + EPSILON
      && point.x < segment.maxX - EPSILON;
  }
  return Math.abs(point.x - segment.start.x) <= EPSILON
    && point.y > segment.minY + EPSILON
    && point.y < segment.maxY - EPSILON;
}

function overlaps(a: Segment, b: Segment): boolean {
  if (a.netKey !== b.netKey || a.orientation !== b.orientation) {
    return false;
  }
  if (a.orientation === 'horizontal') {
    return Math.abs(a.start.y - b.start.y) <= EPSILON
      && Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > EPSILON;
  }
  return Math.abs(a.start.x - b.start.x) <= EPSILON
    && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > EPSILON;
}

function isEditableSegment(segment: Segment, geometry: PolylineEdgeGeometry): boolean {
  return segment.index > 0 && segment.index < geometry.points.length - 2;
}

export function findNetJunctions(geometries: PolylineEdgeGeometry[]): NetJunction[] {
  const byNet = new Map<string, PolylineEdgeGeometry[]>();
  for (const geometry of geometries) {
    if (!geometry.netKey) {
      continue;
    }
    const net = byNet.get(geometry.netKey) ?? [];
    net.push(geometry);
    byNet.set(geometry.netKey, net);
  }

  const junctions = new Map<string, NetJunction>();
  for (const [netKey, netGeometries] of byNet) {
    if (netGeometries.length < 2) {
      continue;
    }
    const segments = netGeometries.flatMap(segmentsFor);
    const endpoints = new Map<string, { point: OrthogonalPoint; edgeIds: Set<string>; directions: Set<string> }>();

    for (const geometry of netGeometries) {
      geometry.points.forEach((point, index) => {
        const key = pointKey(point);
        const existing = endpoints.get(key) ?? { point, edgeIds: new Set<string>(), directions: new Set<string>() };
        existing.edgeIds.add(geometry.edgeId);
        const previous = geometry.points[index - 1];
        const next = geometry.points[index + 1];
        const previousDirection = previous ? directionKey(point, previous) : undefined;
        const nextDirection = next ? directionKey(point, next) : undefined;
        if (previousDirection) {
          existing.directions.add(previousDirection);
        }
        if (nextDirection) {
          existing.directions.add(nextDirection);
        }
        endpoints.set(key, existing);
      });
    }

    // Also consider intersections of segments as potential junction points
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i];
        const b = segments[j];
        if (a.edgeId === b.edgeId || a.orientation === b.orientation) {
          continue;
        }
        const h = a.orientation === 'horizontal' ? a : b;
        const v = a.orientation === 'vertical' ? a : b;
        if (v.start.x > h.minX + EPSILON && v.start.x < h.maxX - EPSILON
            && h.start.y > v.minY + EPSILON && h.start.y < v.maxY - EPSILON) {
          const point = { x: v.start.x, y: h.start.y };
          const key = pointKey(point);
          if (!endpoints.has(key)) {
            endpoints.set(key, { point, edgeIds: new Set<string>(), directions: new Set<string>(['left', 'right', 'up', 'down']) });
          }
        }
      }
    }

    for (const { point, edgeIds, directions } of endpoints.values()) {
      const interiorCarriers = segments.filter((segment) => !edgeIds.has(segment.edgeId) && pointOnSegmentInterior(point, segment));
      for (const carrier of interiorCarriers) {
        if (carrier.orientation === 'horizontal') {
          directions.add('left');
          directions.add('right');
        } else {
          directions.add('up');
          directions.add('down');
        }
      }

      if ((edgeIds.size >= 2 || interiorCarriers.length > 0) && directions.size >= 3) {
        junctions.set(`${netKey}:${pointKey(point)}`, {
          id: `${netKey}:${pointKey(point)}`,
          x: point.x,
          y: point.y
        });
      }
    }
  }

  return Array.from(junctions.values());
}

export function moveSharedNetSegments(
  geometries: PolylineEdgeGeometry[],
  draggedEdgeId: string,
  segmentIndex: number,
  pointer: OrthogonalPoint
): SharedRouteMove[] {
  const dragged = geometries.find((geometry) => geometry.edgeId === draggedEdgeId);
  if (!dragged) {
    return [];
  }
  const draggedSegment = segmentsFor(dragged).find((segment) => segment.index === segmentIndex);
  if (!draggedSegment || !isEditableSegment(draggedSegment, dragged)) {
    return [];
  }

  const moves: SharedRouteMove[] = [];
  for (const geometry of geometries) {
    const sharedSegments = segmentsFor(geometry).filter((segment) => {
      if (!isEditableSegment(segment, geometry)) return false;

      // Same net shared trunk (partial or full overlap)
      if (geometry.netKey && geometry.netKey === dragged.netKey) {
        return overlaps(draggedSegment, segment);
      }

      // Different net: only if FULL overlap
      if (segment.orientation === draggedSegment.orientation) {
        const startMatch = pointsEqual(segment.start, draggedSegment.start) || pointsEqual(segment.start, draggedSegment.end);
        const endMatch = pointsEqual(segment.end, draggedSegment.start) || pointsEqual(segment.end, draggedSegment.end);
        return startMatch && endMatch;
      }

      return false;
    });

    if (sharedSegments.length === 0 && geometry.edgeId !== draggedEdgeId) {
      continue;
    }

    // Always move the dragged edge's segment, even if it has no netKey
    const segmentsToMove = geometry.edgeId === draggedEdgeId 
      ? Array.from(new Set([...sharedSegments, draggedSegment]))
      : sharedSegments;

    if (segmentsToMove.length === 0) continue;

    let points = geometry.points.map((point) => ({ ...point }));
    for (const segment of segmentsToMove) {
      points = moveRouteSegment(points, segment.index, pointer);
    }
    moves.push({ edgeId: geometry.edgeId, points });
  }

  return moves;
}
