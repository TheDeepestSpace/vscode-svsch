import type React from 'react';

export interface Point {
  x: number;
  y: number;
}

export interface PolylineEdgeGeometry {
  edgeId: string;
  points: Point[];
  sourceId?: string;
  targetId?: string;
}

export interface LineJumpOptions {
  jumpSize?: number;
  endpointPadding?: number;
  minOverlapLength?: number;
}

export interface OverlapHint {
  id: string;
  path: string;
  style?: React.CSSProperties;
}

export interface LineJumpRender {
  path: string;
  jumpPaths: string[];
}

export interface ResolvedLineJumpOptions {
  jumpSize: number;
  endpointPadding: number;
  minOverlapLength: number;
}
