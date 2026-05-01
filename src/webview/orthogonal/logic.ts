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
  targetHandleId?: string | null,
  simplify = true
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

  // saved points start with the old sourceLead and end with the old targetLead.
  // We want to keep everything BETWEEN them.
  const internal = saved.slice(1, -1).map(snapPoint).map((point) => {
    if (!simplify) {
      return point;
    }

    let clamped = clampToLead(point, sourceX, sourceY, sourcePosition, sourceLeadLen);
    clamped = clampToLead(clamped, targetX, targetY, targetPosition, targetLeadLen);
    return clamped;
  });

  const combined = [sourceLead, ...internal, targetLead];
  return makeOrthogonal(combined, simplify);
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

export function leadLengthForHandle(position: HdlPosition, handleId?: string | null, maxLead?: number): number {
  let length = diagramSizing.edgeLeadLength;
  if (position === HdlPosition.Top || position === HdlPosition.Bottom) {
    if (handleId === 'reset') {
      length = diagramSizing.gridSize;
    } else {
      length = diagramSizing.gridSize * 2;
    }
  }

  if (maxLead !== undefined) {
    return Math.min(length, maxLead);
  }
  return length;
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

export function makeOrthogonal(points: OrthogonalPoint[], simplify = true): OrthogonalPoint[] {
  if (points.length < 2) {
    return points;
  }

  const orthogonal: OrthogonalPoint[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = orthogonal[orthogonal.length - 1];
    const current = points[index];
    if (Math.abs(previous.x - current.x) < 0.5 && Math.abs(previous.y - current.y) < 0.5) {
      if (!simplify) {
        // Even if points are the same, we keep them to maintain point count during drag
        orthogonal.push({ ...current });
      }
      continue;
    }
    if (Math.abs(previous.x - current.x) < 0.5 || Math.abs(previous.y - current.y) < 0.5) {
      orthogonal.push({ ...current });
    } else {
      orthogonal.push({ x: current.x, y: previous.y }, { ...current });
    }
  }

  return simplify ? removeRedundantPoints(orthogonal) : orthogonal;
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

  if (orientation === 'horizontal') {
    // If we're moving a horizontal segment, we change its Y coordinate.
    // The segments before and after it are vertical, so we only need to update 
    // the points at segmentIndex and segmentIndex + 1.
    // We don't update the very first or very last point of the WHOLE route 
    // (points[0] and points[last]) because those are tied to handles.
    if (segmentIndex > 0) {
      next[segmentIndex].y = snappedPointer.y;
    }
    if (segmentIndex + 1 < next.length - 1) {
      next[segmentIndex + 1].y = snappedPointer.y;
    }
  } else if (orientation === 'vertical') {
    // Same for vertical segments and X coordinate.
    if (segmentIndex > 0) {
      next[segmentIndex].x = snappedPointer.x;
    }
    if (segmentIndex + 1 < next.length - 1) {
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
