import { diagramSizing } from '../../diagram/constants';
import { HdlPosition, type OrthogonalPoint, type SerializableOrthogonalRoute } from './types';

export function normalizeRoutePoints(
  route: SerializableOrthogonalRoute | undefined,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourcePosition: HdlPosition,
  targetPosition: HdlPosition,
  sourceHandleId?: string | null,
  targetHandleId?: string | null
): OrthogonalPoint[] {
  const sourceLeadLen = leadLengthForHandle(sourcePosition, sourceHandleId);
  const targetLeadLen = leadLengthForHandle(targetPosition, targetHandleId);
  const sourceLead = snapPoint(leadPoint(sourceX, sourceY, sourcePosition, sourceLeadLen));
  const targetLead = snapPoint(leadPoint(targetX, targetY, targetPosition, targetLeadLen));
  const saved = route?.routePoints?.length
    ? route.routePoints
    : migrateRoutePoints(route?.waypoint, sourceLead, targetLead, sourceY, targetY);

  if (saved.length < 2) {
    return defaultRoute(sourceLead, targetLead);
  }

  // Clamp ALL internal points to stay outside the lead zones.
  const internal = saved.slice(1, -1).map(snapPoint).map((p) => {
    let np = clampToLead(p, sourceX, sourceY, sourcePosition, sourceLeadLen);
    np = clampToLead(np, targetX, targetY, targetPosition, targetLeadLen);
    return np;
  });

  const combined = [sourceLead, ...internal, targetLead];
  return makeOrthogonal(combined);
}

export function clampToLead(point: OrthogonalPoint, nodeX: number, nodeY: number, position: HdlPosition, distance: number): OrthogonalPoint {
  const next = { ...point };
  if (position === HdlPosition.Left) {
    next.x = Math.min(next.x, nodeX - distance);
  } else if (position === HdlPosition.Right) {
    next.x = Math.max(next.x, nodeX + distance);
  } else if (position === HdlPosition.Top) {
    next.y = Math.min(next.y, nodeY - distance);
  } else if (position === HdlPosition.Bottom) {
    next.y = Math.max(next.y, nodeY + distance);
  }
  return next;
}

export function leadLengthForHandle(position: HdlPosition, handleId?: string | null): number {
  if (position === HdlPosition.Top || position === HdlPosition.Bottom) {
    if (handleId === 'reset') {
      return diagramSizing.gridSize;
    }
    return diagramSizing.gridSize * 2;
  }
  return diagramSizing.edgeLeadLength;
}

export function migrateRoutePoints(
  waypoint: OrthogonalPoint | undefined,
  sourceLead: OrthogonalPoint,
  targetLead: OrthogonalPoint,
  sourceY: number,
  targetY: number
): OrthogonalPoint[] {
  if (waypoint) {
    return [
      sourceLead,
      { x: waypoint.x, y: sourceY },
      { x: waypoint.x, y: waypoint.y },
      { x: targetLead.x, y: waypoint.y },
      targetLead
    ];
  }

  return defaultRoute(sourceLead, targetLead);
}

export function defaultRoute(sourceLead: OrthogonalPoint, targetLead: OrthogonalPoint): OrthogonalPoint[] {
  const midX = snapToGrid((sourceLead.x + targetLead.x) / 2);
  return [
    sourceLead,
    { x: midX, y: sourceLead.y },
    { x: midX, y: targetLead.y },
    targetLead
  ];
}

export function makeOrthogonal(points: OrthogonalPoint[]): OrthogonalPoint[] {
  if (points.length < 2) {
    return points;
  }

  const orthogonal: OrthogonalPoint[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = orthogonal[orthogonal.length - 1];
    const current = points[index];
    if (Math.abs(previous.x - current.x) < 0.5 && Math.abs(previous.y - current.y) < 0.5) {
      continue;
    }
    if (Math.abs(previous.x - current.x) < 0.5 || Math.abs(previous.y - current.y) < 0.5) {
      orthogonal.push({ ...current });
    } else {
      orthogonal.push({ x: current.x, y: previous.y }, { ...current });
    }
  }

  return removeRedundantPoints(orthogonal);
}

export function removeRedundantPoints(points: OrthogonalPoint[]): OrthogonalPoint[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) {
      return true;
    }
    const previous = points[index - 1];
    const next = points[index + 1];

    const orientationPrev = segmentOrientation(previous, point);
    const orientationNext = segmentOrientation(point, next);

    if (orientationPrev && orientationNext && orientationPrev === orientationNext) {
      // Check if it's a 180 degree turn (double back).
      const dotProduct = (point.x - previous.x) * (next.x - point.x) + (point.y - previous.y) * (next.y - point.y);
      if (dotProduct < 0) {
        return true; // Keep it, it's a turn!
      }
      return false; // Remove it, it's a straight line (or duplicate).
    }
    return true;
  });
}

export function leadPoint(x: number, y: number, position: HdlPosition, distance: number): OrthogonalPoint {
  if (position === HdlPosition.Left) {
    return { x: x - distance, y };
  }
  if (position === HdlPosition.Right) {
    return { x: x + distance, y };
  }
  if (position === HdlPosition.Top) {
    return { x, y: y - distance };
  }
  return { x, y: y + distance };
}

export function pointsToPath(points: OrthogonalPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

export function segmentOrientation(a: OrthogonalPoint, b: OrthogonalPoint): 'horizontal' | 'vertical' | undefined {
  if (Math.abs(a.y - b.y) < 0.5) {
    return 'horizontal';
  }
  if (Math.abs(a.x - b.x) < 0.5) {
    return 'vertical';
  }
  return undefined;
}

export function moveRouteSegment(points: OrthogonalPoint[], segmentIndex: number, pointer: OrthogonalPoint): OrthogonalPoint[] {
  const next = points.map((point) => ({ ...point }));
  const orientation = segmentOrientation(next[segmentIndex], next[segmentIndex + 1]);
  const snappedPointer = snapPoint(pointer);
  const isFirstEditableSegment = segmentIndex === 1;
  const isLastEditableSegment = segmentIndex === points.length - 3;

  if (orientation === 'horizontal') {
    if (!isFirstEditableSegment) {
      next[segmentIndex].y = snappedPointer.y;
    }
    if (!isLastEditableSegment) {
      next[segmentIndex + 1].y = snappedPointer.y;
    }
  } else if (orientation === 'vertical') {
    if (!isFirstEditableSegment) {
      next[segmentIndex].x = snappedPointer.x;
    }
    if (!isLastEditableSegment) {
      next[segmentIndex + 1].x = snappedPointer.x;
    }
  }

  return next;
}

export function snapPoint(point: OrthogonalPoint): OrthogonalPoint {
  return {
    x: snapToGrid(point.x),
    y: snapToGrid(point.y)
  };
}

export function snapToGrid(value: number): number {
  return Math.round(value / diagramSizing.gridSize) * diagramSizing.gridSize;
}

export function midpoint(a: OrthogonalPoint, b: OrthogonalPoint): OrthogonalPoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}
