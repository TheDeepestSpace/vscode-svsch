# React Flow Line Jumps

This folder is intentionally structured like a small portable React Flow
extension. It provides visual-only helpers for orthogonal polyline edges:

- draw.io-style arc jumps for true perpendicular crossings
- dashed overlap hints for unrelated edges that travel on top of each other

## Public API

- `LineJumpProvider`
- `useLineJumpPath({ edgeId, points, sourceId, targetId })`
- `useLineJumpRender({ edgeId, points, sourceId, targetId })`
- `useEdgeOverlapHints({ edgeId, points, sourceId, targetId })`
- `buildLineJumpPath(...)`, `buildLineJumpRender(...)`, and `getEdgeOverlapHints(...)` for pure unit tests
- generic `Point`, `PolylineEdgeGeometry`, `LineJumpOptions`, and `OverlapHint` types

## Dependency Rules

This extension must stay independent from the host application. Do not import
SVSCH backend, parser, IR, storage, layout, VS Code APIs, or project-specific
types from this folder.

Allowed dependencies are React and generic TypeScript/SVG geometry.

## Limitations

The first version supports orthogonal polylines only. Curved or arbitrary SVG
paths should be converted to points before using this extension.
