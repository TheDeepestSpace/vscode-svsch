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
  midpoint,
  snapToGrid
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
  
  // localPoints represents the "structured" path during a drag
  const [localPoints, setLocalPoints] = React.useState<OrthogonalPoint[] | null>(null);
  const dragOffsetRef = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const isDragging = localPoints !== null;

  // Calculate the "official" points from props (used when NOT dragging)
  const officialPoints = normalizeRoutePoints(
    edgeData,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition as unknown as HdlPosition,
    targetPosition as unknown as HdlPosition,
    sourceHandleId,
    targetHandleId,
    !isDragging
  );

  // Use localPoints if we are dragging, otherwise use officialPoints.
  // We MUST prepend and append the actual handle coordinates to officialPoints 
  // because normalizeRoutePoints only returns the path between leads.
  const points = localPoints ?? [
    { x: sourceX, y: sourceY },
    ...officialPoints,
    { x: targetX, y: targetY }
  ];
  const edgePath = pointsToPath(points);

  const labelPoint = points[Math.floor(points.length / 2)] ?? midpoint({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });

  const moveSegment = (event: React.PointerEvent, segmentIndex: number, commit: boolean) => {
    const flowPoint = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });

    let currentStructuredPoints = localPoints ?? [
      { x: sourceX, y: sourceY },
      ...officialPoints,
      { x: targetX, y: targetY }
    ];

    // On drag start, capture offset and lock the structure
    if (!localPoints) {
      const initialPoint = currentStructuredPoints[segmentIndex];
      dragOffsetRef.current = {
        x: initialPoint.x - flowPoint.x,
        y: initialPoint.y - flowPoint.y
      };
    }

    const adjustedPoint = {
      x: flowPoint.x + dragOffsetRef.current.x,
      y: flowPoint.y + dragOffsetRef.current.y
    };

    const nextPoints = moveRouteSegment(currentStructuredPoints, segmentIndex, adjustedPoint);
    
    if (commit) {
      setLocalPoints(null);
      // Ensure we have a stable structure to save.
      // We want to save exactly what the user sees, including the leads.
      // Disable simplification to ensure the structure is preserved.
      const finalPoints = makeOrthogonal(nextPoints, false);
      edgeData?.onRouteChange?.(id, finalPoints, true);
    } else {
      setLocalPoints(nextPoints);
    }
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
