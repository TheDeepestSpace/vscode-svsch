import React from 'react';
import {
  Position,
  type EdgeProps,
  useReactFlow
} from '@xyflow/react';
import { diagramSizing } from '../../diagram/constants';
import type { OrthogonalPoint, RouteChangeHandler, SerializableOrthogonalRoute } from './types';

interface OrthogonalEdgeData extends SerializableOrthogonalRoute {
  onRouteChange?: RouteChangeHandler;
}

export function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  targetHandleId,
  label,
  data
}: EdgeProps): React.ReactElement {
  const reactFlow = useReactFlow();
  const edgeData = data as OrthogonalEdgeData | undefined;
  const routePoints = normalizeRoutePoints(
    edgeData,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    sourceHandleId,
    targetHandleId
  );
  const points = [{ x: sourceX, y: sourceY }, ...routePoints, { x: targetX, y: targetY }];
  const edgePath = pointsToPath(points);
  const labelPoint = routePoints[Math.floor(routePoints.length / 2)] ?? midpoint({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });

  const moveSegment = (event: React.PointerEvent, segmentIndex: number, commit: boolean) => {
    const flowPoint = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nextRoute = moveRouteSegment(points, segmentIndex, flowPoint).slice(1, -1);
    edgeData?.onRouteChange?.(id, nextRoute, commit);
  };

  return (
    <>
      <path className="svsch-edge-bridge" d={edgePath} />
      <path className="svsch-edge" d={edgePath} />
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1];
        const orientation = segmentOrientation(point, next);
        if (!orientation || index === 0 || index === points.length - 2) {
          return null;
        }
        return (
          <path
            key={`${id}-segment-${index}`}
            className={`svsch-edge-segment-handle svsch-edge-segment-${orientation}`}
            d={`M ${point.x} ${point.y} L ${next.x} ${next.y}`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              moveSegment(event, index, false);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                moveSegment(event, index, false);
              }
            }}
            onPointerUp={(event) => {
              moveSegment(event, index, true);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          />
        );
      })}
      {label && (
        <foreignObject width={48} height={22} x={labelPoint.x - 24} y={labelPoint.y - 11} className="svsch-edge-label">
          <div>{label}</div>
        </foreignObject>
      )}
    </>
  );
}

export function normalizeRoutePoints(
  route: SerializableOrthogonalRoute | undefined,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourcePosition: Position,
  targetPosition: Position,
  sourceHandleId?: string | null,
  targetHandleId?: string | null
): OrthogonalPoint[] {
  const sourceLead = snapPoint(leadPoint(sourceX, sourceY, sourcePosition, leadLengthForHandle(sourceHandleId)));
  const targetLead = snapPoint(leadPoint(targetX, targetY, targetPosition, leadLengthForHandle(targetHandleId)));
  const saved = route?.routePoints?.length
    ? route.routePoints
    : migrateRoutePoints(route?.waypoint, sourceLead, targetLead, sourceY, targetY);

  if (saved.length < 2) {
    return defaultRoute(sourceLead, targetLead);
  }

  const internal = saved.slice(1, -1).map(snapPoint);
  return makeOrthogonal([sourceLead, ...internal, targetLead]);
}

function leadLengthForHandle(handleId?: string | null): number {
  return handleId === 'reset' ? diagramSizing.gridSize : diagramSizing.edgeLeadLength;
}

function migrateRoutePoints(
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

function defaultRoute(sourceLead: OrthogonalPoint, targetLead: OrthogonalPoint): OrthogonalPoint[] {
  const midX = snapToGrid((sourceLead.x + targetLead.x) / 2);
  return [
    sourceLead,
    { x: midX, y: sourceLead.y },
    { x: midX, y: targetLead.y },
    targetLead
  ];
}

function makeOrthogonal(points: OrthogonalPoint[]): OrthogonalPoint[] {
  if (points.length < 2) {
    return points;
  }

  const orthogonal: OrthogonalPoint[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = orthogonal[orthogonal.length - 1];
    const current = points[index];
    if (Math.abs(previous.x - current.x) < 0.5 || Math.abs(previous.y - current.y) < 0.5) {
      orthogonal.push({ ...current });
    } else {
      orthogonal.push({ x: current.x, y: previous.y }, { ...current });
    }
  }

  return removeRedundantPoints(orthogonal);
}

function removeRedundantPoints(points: OrthogonalPoint[]): OrthogonalPoint[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) {
      return true;
    }
    const previous = points[index - 1];
    const next = points[index + 1];
    return !(segmentOrientation(previous, point) && segmentOrientation(point, next) && segmentOrientation(previous, point) === segmentOrientation(point, next));
  });
}

function leadPoint(x: number, y: number, position: Position, distance: number): OrthogonalPoint {
  if (position === Position.Left) {
    return { x: x - distance, y };
  }
  if (position === Position.Right) {
    return { x: x + distance, y };
  }
  if (position === Position.Top) {
    return { x, y: y - distance };
  }
  return { x, y: y + distance };
}

function pointsToPath(points: OrthogonalPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function segmentOrientation(a: OrthogonalPoint, b: OrthogonalPoint): 'horizontal' | 'vertical' | undefined {
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

function snapPoint(point: OrthogonalPoint): OrthogonalPoint {
  return {
    x: snapToGrid(point.x),
    y: snapToGrid(point.y)
  };
}

function snapToGrid(value: number): number {
  return Math.round(value / diagramSizing.gridSize) * diagramSizing.gridSize;
}

function midpoint(a: OrthogonalPoint, b: OrthogonalPoint): OrthogonalPoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}
