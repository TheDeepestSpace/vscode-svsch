import React from 'react';
import {
  buildLineJumpPath,
  buildLineJumpRender,
  defaultLineJumpOptions,
  getEdgeOverlapHints
} from './geometry';
import type { LineJumpOptions, LineJumpRender, OverlapHint, PolylineEdgeGeometry } from './types';

interface LineJumpContextValue {
  geometries: PolylineEdgeGeometry[];
  getRegisteredGeometry: (edgeId: string) => PolylineEdgeGeometry | undefined;
  registerGeometry: (geometry: PolylineEdgeGeometry) => void;
  unregisterGeometry: (edgeId: string) => void;
  options: LineJumpOptions;
}

const LineJumpContext = React.createContext<LineJumpContextValue | null>(null);

function geometrySignature(geometry: PolylineEdgeGeometry): string {
  return JSON.stringify({
    edgeId: geometry.edgeId,
    sourceId: geometry.sourceId,
    targetId: geometry.targetId,
    points: geometry.points
  });
}

export function LineJumpProvider({
  children,
  options
}: {
  children: React.ReactNode;
  options?: LineJumpOptions;
}): React.ReactElement {
  const [geometryMap, setGeometryMap] = React.useState<Map<string, PolylineEdgeGeometry>>(() => new Map());
  const signaturesRef = React.useRef<Map<string, string>>(new Map());

  const registerGeometry = React.useCallback((geometry: PolylineEdgeGeometry) => {
    const signature = geometrySignature(geometry);

    if (signaturesRef.current.get(geometry.edgeId) === signature) {
      return;
    }

    signaturesRef.current.set(geometry.edgeId, signature);
    setGeometryMap((current) => {
      const next = new Map(current);
      next.set(geometry.edgeId, {
        ...geometry,
        points: geometry.points.map((point) => ({ ...point }))
      });
      return next;
    });
  }, []);

  const unregisterGeometry = React.useCallback((edgeId: string) => {
    signaturesRef.current.delete(edgeId);
    setGeometryMap((current) => {
      if (!current.has(edgeId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(edgeId);
      return next;
    });
  }, []);

  const getRegisteredGeometry = React.useCallback((edgeId: string) => geometryMap.get(edgeId), [geometryMap]);

  const value = React.useMemo<LineJumpContextValue>(() => ({
    geometries: Array.from(geometryMap.values()),
    getRegisteredGeometry,
    registerGeometry,
    unregisterGeometry,
    options: {
      ...defaultLineJumpOptions,
      ...options
    }
  }), [geometryMap, getRegisteredGeometry, options, registerGeometry, unregisterGeometry]);

  return <LineJumpContext.Provider value={value}>{children}</LineJumpContext.Provider>;
}

function useOptionalLineJumpContext(): LineJumpContextValue | null {
  return React.useContext(LineJumpContext);
}

function useRegisterGeometry(geometry: PolylineEdgeGeometry): LineJumpContextValue | null {
  const context = useOptionalLineJumpContext();
  const registerGeometry = context?.registerGeometry;
  const unregisterGeometry = context?.unregisterGeometry;
  const signature = geometrySignature(geometry);

  React.useEffect(() => {
    if (!registerGeometry || !unregisterGeometry) {
      return undefined;
    }

    registerGeometry(geometry);
    return () => unregisterGeometry(geometry.edgeId);
  }, [geometry.edgeId, registerGeometry, signature, unregisterGeometry]);

  return context;
}

export function useLineJumpPath(
  geometry: PolylineEdgeGeometry,
  options?: LineJumpOptions
): string {
  return useLineJumpRender(geometry, options).path;
}

export function useLineJumpRender(
  geometry: PolylineEdgeGeometry,
  options?: LineJumpOptions
): LineJumpRender {
  const context = useRegisterGeometry(geometry);
  const registeredGeometry = context?.getRegisteredGeometry(geometry.edgeId);
  const renderGeometry = registeredGeometry ?? geometry;
  const mergedOptions = {
    ...(context?.options ?? defaultLineJumpOptions),
    ...options
  };
  const geometries = context?.geometries ?? [geometry];

  return React.useMemo(
    () => buildLineJumpRender(renderGeometry, geometries, mergedOptions),
    [geometrySignature(renderGeometry), geometries, JSON.stringify(mergedOptions)]
  );
}

export function useEdgeOverlapHints(
  geometry: PolylineEdgeGeometry,
  options?: LineJumpOptions
): OverlapHint[] {
  const context = useRegisterGeometry(geometry);
  const registeredGeometry = context?.getRegisteredGeometry(geometry.edgeId);
  const renderGeometry = registeredGeometry ?? geometry;
  const mergedOptions = {
    ...(context?.options ?? defaultLineJumpOptions),
    ...options
  };
  const geometries = context?.geometries ?? [geometry];

  return React.useMemo(
    () => getEdgeOverlapHints(renderGeometry, geometries, mergedOptions),
    [geometrySignature(renderGeometry), geometries, JSON.stringify(mergedOptions)]
  );
}
