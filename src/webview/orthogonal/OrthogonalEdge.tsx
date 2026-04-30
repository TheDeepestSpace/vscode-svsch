import React from 'react';
import {
  Position,
  type EdgeProps,
  useReactFlow
} from '@xyflow/react';
import { HdlPosition, type OrthogonalPoint, type RouteChangeHandler, type SerializableOrthogonalRoute } from './types';
import type { DiagramEdge } from '../../ir/types';
import {
  moveRouteSegment,
  normalizeRoutePoints,
  makeOrthogonal,
  pointsToPath,
  segmentOrientation,
  midpoint
} from './logic';

interface OrthogonalEdgeData extends SerializableOrthogonalRoute {
  onRouteChange?: RouteChangeHandler;
  edge?: DiagramEdge;
}

import { getVscodeApi } from '../vscodeApi';

const vscode = getVscodeApi();

export { moveRouteSegment, normalizeRoutePoints };

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
    sourcePosition as unknown as HdlPosition,
    targetPosition as unknown as HdlPosition,
    sourceHandleId,
    targetHandleId
  );
  // Force an orthogonal path even when endpoint coordinates drift off-grid.
  const points = makeOrthogonal([{ x: sourceX, y: sourceY }, ...routePoints, { x: targetX, y: targetY }]);
  const edgePath = pointsToPath(points);
  const labelPoint = points[Math.floor(points.length / 2)] ?? midpoint({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });

  const moveSegment = (event: React.PointerEvent, segmentIndex: number, commit: boolean) => {
    const flowPoint = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nextRoute = moveRouteSegment(points, segmentIndex, flowPoint).slice(1, -1);
    edgeData?.onRouteChange?.(id, nextRoute, commit);
  };

  return (
    <>
      <path className="svsch-edge-bridge react-flow__edge-interaction" d={edgePath} />
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
