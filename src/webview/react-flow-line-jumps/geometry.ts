import type {
  LineJumpRender,
  LineJumpOptions,
  OverlapHint,
  Point,
  PolylineEdgeGeometry,
  ResolvedLineJumpOptions
} from './types';

const EPSILON = 0.5;

export const defaultLineJumpOptions: ResolvedLineJumpOptions = {
  jumpSize: 7,
  endpointPadding: 4,
  minOverlapLength: 4
};

type Orientation = 'horizontal' | 'vertical';

interface Segment {
  edgeId: string;
  sourceId?: string;
  targetId?: string;
  index: number;
  start: Point;
  end: Point;
  orientation: Orientation;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Crossing {
  segmentIndex: number;
  point: Point;
  distance: number;
}

function resolveOptions(options?: LineJumpOptions): ResolvedLineJumpOptions {
  return {
    ...defaultLineJumpOptions,
    ...options
  };
}

function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

function orientationFor(a: Point, b: Point): Orientation | undefined {
  if (Math.abs(a.y - b.y) < EPSILON && Math.abs(a.x - b.x) >= EPSILON) {
    return 'horizontal';
  }
  if (Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) >= EPSILON) {
    return 'vertical';
  }
  return undefined;
}

function segmentsFor(edge: PolylineEdgeGeometry): Segment[] {
  const segments: Segment[] = [];

  for (let index = 0; index < edge.points.length - 1; index += 1) {
    const start = edge.points[index];
    const end = edge.points[index + 1];
    const orientation = orientationFor(start, end);

    if (!orientation || pointsEqual(start, end)) {
      continue;
    }

    segments.push({
      edgeId: edge.edgeId,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
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

function between(value: number, min: number, max: number, padding: number): boolean {
  return value > min + padding + EPSILON && value < max - padding - EPSILON;
}

function segmentDistance(segment: Segment, point: Point): number {
  return segment.orientation === 'horizontal'
    ? Math.abs(point.x - segment.start.x)
    : Math.abs(point.y - segment.start.y);
}

function crossingBetween(a: Segment, b: Segment, padding: number): Point | undefined {
  if (a.orientation === b.orientation) {
    return undefined;
  }

  const horizontal = a.orientation === 'horizontal' ? a : b;
  const vertical = a.orientation === 'vertical' ? a : b;
  const point = { x: vertical.start.x, y: horizontal.start.y };

  if (
    !between(point.x, horizontal.minX, horizontal.maxX, padding)
    || !between(point.y, vertical.minY, vertical.maxY, padding)
  ) {
    return undefined;
  }

  return point;
}

function pathFromPoints(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function crossingKey(crossing: Crossing): string {
  return `${crossing.segmentIndex}:${crossing.point.x}:${crossing.point.y}`;
}

export function buildLineJumpPath(
  geometry: PolylineEdgeGeometry,
  allGeometries: PolylineEdgeGeometry[],
  options?: LineJumpOptions
): string {
  return buildLineJumpRender(geometry, allGeometries, options).path;
}

export function buildLineJumpRender(
  geometry: PolylineEdgeGeometry,
  allGeometries: PolylineEdgeGeometry[],
  options?: LineJumpOptions
): LineJumpRender {
  const resolved = resolveOptions(options);
  const ownSegments = segmentsFor(geometry);
  const crossings: Crossing[] = [];
  const seen = new Set<string>();

  for (const ownSegment of ownSegments) {
    for (const otherGeometry of allGeometries) {
      if (otherGeometry.edgeId === geometry.edgeId || geometry.edgeId < otherGeometry.edgeId) {
        continue;
      }

      for (const otherSegment of segmentsFor(otherGeometry)) {
        const point = crossingBetween(ownSegment, otherSegment, resolved.endpointPadding);

        if (!point) {
          continue;
        }

        const crossing = {
          segmentIndex: ownSegment.index,
          point,
          distance: segmentDistance(ownSegment, point)
        };
        const key = crossingKey(crossing);

        if (!seen.has(key)) {
          seen.add(key);
          crossings.push(crossing);
        }
      }
    }
  }

  if (crossings.length === 0) {
    return {
      path: pathFromPoints(geometry.points),
      jumpPaths: []
    };
  }

  const crossingsBySegment = new Map<number, Crossing[]>();
  for (const crossing of crossings) {
    const segmentCrossings = crossingsBySegment.get(crossing.segmentIndex) ?? [];
    segmentCrossings.push(crossing);
    crossingsBySegment.set(crossing.segmentIndex, segmentCrossings);
  }

  const commands: string[] = [];
  const jumpPaths: string[] = [];
  for (let index = 0; index < geometry.points.length - 1; index += 1) {
    const start = geometry.points[index];
    const end = geometry.points[index + 1];
    const orientation = orientationFor(start, end);

    if (index === 0) {
      commands.push(`M ${start.x} ${start.y}`);
    }

    if (!orientation) {
      commands.push(`L ${end.x} ${end.y}`);
      continue;
    }

    const segmentCrossings = (crossingsBySegment.get(index) ?? [])
      .sort((a, b) => a.distance - b.distance);
    const direction = orientation === 'horizontal'
      ? Math.sign(end.x - start.x)
      : Math.sign(end.y - start.y);

    for (const crossing of segmentCrossings) {
      if (orientation === 'horizontal') {
        const before = { x: crossing.point.x - direction * resolved.jumpSize, y: crossing.point.y };
        const after = { x: crossing.point.x + direction * resolved.jumpSize, y: crossing.point.y };
        const control = { x: crossing.point.x, y: crossing.point.y - resolved.jumpSize };
        commands.push(`L ${before.x} ${before.y}`);
        commands.push(`Q ${control.x} ${control.y} ${after.x} ${after.y}`);
        jumpPaths.push(`M ${before.x} ${before.y} Q ${control.x} ${control.y} ${after.x} ${after.y}`);
      } else {
        const before = { x: crossing.point.x, y: crossing.point.y - direction * resolved.jumpSize };
        const after = { x: crossing.point.x, y: crossing.point.y + direction * resolved.jumpSize };
        const control = { x: crossing.point.x + resolved.jumpSize, y: crossing.point.y };
        commands.push(`L ${before.x} ${before.y}`);
        commands.push(`Q ${control.x} ${control.y} ${after.x} ${after.y}`);
        jumpPaths.push(`M ${before.x} ${before.y} Q ${control.x} ${control.y} ${after.x} ${after.y}`);
      }
    }

    commands.push(`L ${end.x} ${end.y}`);
  }

  return {
    path: commands.join(' '),
    jumpPaths
  };
}

function sameSource(a: Segment, b: Segment): boolean {
  return Boolean(a.sourceId && b.sourceId && a.sourceId === b.sourceId);
}

function overlapInterval(a: Segment, b: Segment, options: ResolvedLineJumpOptions): [number, number] | undefined {
  if (a.orientation !== b.orientation || sameSource(a, b)) {
    return undefined;
  }

  if (a.orientation === 'horizontal') {
    if (Math.abs(a.start.y - b.start.y) >= EPSILON) {
      return undefined;
    }
    const start = Math.max(a.minX + options.endpointPadding, b.minX + options.endpointPadding);
    const end = Math.min(a.maxX - options.endpointPadding, b.maxX - options.endpointPadding);
    return end - start >= options.minOverlapLength ? [start, end] : undefined;
  }

  if (Math.abs(a.start.x - b.start.x) >= EPSILON) {
    return undefined;
  }

  const start = Math.max(a.minY + options.endpointPadding, b.minY + options.endpointPadding);
  const end = Math.min(a.maxY - options.endpointPadding, b.maxY - options.endpointPadding);
  return end - start >= options.minOverlapLength ? [start, end] : undefined;
}

export function getEdgeOverlapHints(
  geometry: PolylineEdgeGeometry,
  allGeometries: PolylineEdgeGeometry[],
  options?: LineJumpOptions
): OverlapHint[] {
  const resolved = resolveOptions(options);
  const hints: OverlapHint[] = [];

  for (const ownSegment of segmentsFor(geometry)) {
    for (const otherGeometry of allGeometries) {
      if (otherGeometry.edgeId === geometry.edgeId || geometry.edgeId < otherGeometry.edgeId) {
        continue;
      }

      for (const otherSegment of segmentsFor(otherGeometry)) {
        const interval = overlapInterval(ownSegment, otherSegment, resolved);

        if (!interval) {
          continue;
        }

        const [start, end] = interval;
        const path = ownSegment.orientation === 'horizontal'
          ? `M ${start} ${ownSegment.start.y} L ${end} ${ownSegment.start.y}`
          : `M ${ownSegment.start.x} ${start} L ${ownSegment.start.x} ${end}`;

        hints.push({
          id: `${geometry.edgeId}-overlap-${ownSegment.index}-${otherGeometry.edgeId}-${otherSegment.index}`,
          path
        });
      }
    }
  }

  return hints;
}
