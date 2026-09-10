import React from 'react';
import { createPortal } from 'react-dom';
import { type EdgeProps, useEdges, useNodes, useReactFlow, useStore } from '@xyflow/react';
import {
  HdlPosition,
  type RouteChange,
  type RouteChangeHandler,
  type SerializableOrthogonalRoute,
} from './types';
import type { DiagramEdge, DiagramPort, PositionedNode } from '../../ir/types';
import { edgeNetKey } from '../../ir/edgeNet';
import { diagramSizing } from '../../diagram/constants';
import { pathFromPoints, type OrthogonalPoint } from '../../core/pathUtils';
import {
  moveRouteSegment,
  normalizeRoutePoints,
  makeOrthogonal,
  segmentOrientation,
  dominantOrientation,
  midpoint,
  pointNearPathStart,
  avoidFeedbackObstacles,
  clampPointsToRect,
  type NodeObstacle,
} from './logic';
import { findNetJunctions, moveSharedNetSegments } from './netGeometry';
import {
  useEdgeOverlapHints,
  useLineJumpRender,
  useOptionalLineJumpContext,
  buildLineJumpRender,
} from '../react-flow-line-jumps';
import { InteractionContext } from '../nodes/shared/context';
import { nodeIsArrayNode } from '../../ir/nodeMetadata';
import { edgeIsThick, nodeStackIsWide } from '../../ir/edgeStyle';
import { arrayStackLayersFor, type ArrayStackLayerId } from '../arrayStackGeometry';
import { diagramNodeDimensions } from '../../diagram/nodeSizing';
import { isInputSidePort } from '../../diagram/portDirection';
import { isExpandNamespacedId, type ExpandContentInsets } from '../expand/splice';
import {
  computeStackedEdgeLayerPoints,
  convergingStackPath,
  extendTargetIntoGate,
  promotedStackFanoutPath,
  stableFragmentId,
  stackedLayerEdgeClass,
  stackedLayerGradientStopClass,
  type ConvergingStackPath,
} from './stackedEdgeGeometry';

interface OrthogonalEdgeData extends SerializableOrthogonalRoute {
  onRouteChange?: RouteChangeHandler;
  edge?: DiagramEdge;
  moduleName?: string;
  isNetLeader?: boolean;
  netEdgeIds?: string[];
  /**
   * Set on edges spliced in by "Expand instance in place" (issue #232): the
   * flow id of the expanded instance's own node, whose live rect is the
   * frame this wire must stay inside (see the clampPointsToRect pass on
   * officialPoints below).
   */
  containerNodeId?: string;
  /**
   * Set together with containerNodeId: the frame's border-ring widths (see
   * ExpandContentInsets in expand/splice.ts). The clamp keeps this wire's
   * derived route inside the ring's inner boundary, so no wire ever runs
   * under the ring's grab bands (where it couldn't be hovered/selected).
   */
  contentInsets?: ExpandContentInsets;
}

import { getVscodeApi } from '../vscodeApi';
import { Tooltip } from '../Tooltip';

const vscode = getVscodeApi();

export { moveRouteSegment, normalizeRoutePoints };

function jumpHaloPathsFromPath(path: string): string[] {
  const halos: string[] = [];
  const pattern =
    /L (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Q (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g;
  let match = pattern.exec(path);

  while (match) {
    halos.push(`M ${match[1]} ${match[2]} Q ${match[3]} ${match[4]} ${match[5]} ${match[6]}`);
    match = pattern.exec(path);
  }

  return halos;
}

function pointsAlmostEqual(a: OrthogonalPoint, b: OrthogonalPoint): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

function routePointsWithAnchoredLeads(
  points: OrthogonalPoint[],
  officialPoints: OrthogonalPoint[],
): OrthogonalPoint[] {
  const routePoints = points.slice(1, -1);
  const sourceLead = officialPoints[0];
  const targetLead = officialPoints[officialPoints.length - 1];

  if (!sourceLead || !targetLead || routePoints.length === 0) {
    return routePoints;
  }

  const anchored = [...routePoints];
  if (!pointsAlmostEqual(anchored[0], sourceLead)) {
    anchored.unshift(sourceLead);
  }
  if (!pointsAlmostEqual(anchored[anchored.length - 1], targetLead)) {
    anchored.push(targetLead);
  }

  return anchored;
}

function routePointsFromFullPoints(points: OrthogonalPoint[]): OrthogonalPoint[] {
  return points.slice(1, -1).map((point) => ({ ...point }));
}

function routeControlPoint(points: OrthogonalPoint[]): OrthogonalPoint {
  if (points.length < 2) {
    return points[0] ?? { x: 0, y: 0 };
  }

  let bestStart = points[0];
  let bestEnd = points[1];
  let bestLength = -1;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (length > bestLength) {
      bestLength = length;
      bestStart = start;
      bestEnd = end;
    }
  }

  return midpoint(bestStart, bestEnd);
}

function nodeObstacle(node: any): NodeObstacle | undefined {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  const position = node.positionAbsolute ?? node.position;
  if (typeof width !== 'number' || typeof height !== 'number' || !position) {
    return undefined;
  }
  return {
    id: node.id,
    x: position.x,
    y: position.y,
    width,
    height,
  };
}

function positionedNodesFromFlowNodes(flowNodes: any[]): PositionedNode[] {
  return flowNodes
    .map((node): PositionedNode | undefined => {
      const diagramNode = node.data?.node as PositionedNode | undefined;
      if (!diagramNode || !node.position) {
        return undefined;
      }
      // Spliced-in "Expand instance in place" content (issue #232, ids
      // prefixed `expand:`) isn't part of the extension host's module IR —
      // never send it back in a nodes payload (main.tsx's stripExpandSplices
      // does the same at its own message-sending sites).
      if (isExpandNamespacedId(diagramNode.id)) {
        return undefined;
      }
      return {
        ...diagramNode,
        position: node.position,
        // Cutting/rerouting freezes the rest of the diagram in place — but a
        // net-cut label that's still tracking its port dynamically must not
        // be forced fixed just because it happened to be on screen; only
        // honor an actual existing pin.
        fixed: diagramNode.kind === 'netLabel' ? diagramNode.fixed : true,
      };
    })
    .filter((node): node is PositionedNode => node !== undefined);
}

export function OrthogonalEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  targetHandleId,
  label,
  selected,
  data,
}: EdgeProps): React.ReactElement {
  const reactFlow = useReactFlow();
  // Both the foreignObject wire controls and the overlayPortalNode cut-stub
  // reset button live inside a zoom-scaled ancestor — subscribe (rather than
  // reactFlow.getZoom()) so their counter-scale updates live as the user
  // zooms, not just on the next unrelated re-render.
  const zoom = useStore((state) => state.transform[2]);
  const counterScale = 1 / Math.max(zoom || 1, 0.01);
  const flowNodes = useNodes();
  const flowEdges = useEdges();
  const context = useOptionalLineJumpContext();
  const {
    hoveredNetKey,
    setHovered,
    setHoveredEdgeId,
    selectionHoverActive,
    setSelectionHoverActive,
    pendingSelectionAction,
    setPendingSelectionAction,
    overlayPortalNode,
    partialDiagram,
  } = React.useContext(InteractionContext);

  const edgeData = data as OrthogonalEdgeData | undefined;
  const diagramEdge = edgeData?.edge;
  const netKey = diagramEdge ? edgeNetKey(diagramEdge) : undefined;

  const isStructAggregate = diagramEdge?.metadata?.aggregate === 'struct';
  const isInterfaceAggregate = diagramEdge?.metadata?.aggregate === 'interface';
  const isStacked = diagramEdge?.isStacked === true;
  const sourceFlowNode = flowNodes.find((node) => node.id === source);
  const targetFlowNode = flowNodes.find((node) => node.id === target);
  const sourceNode = sourceFlowNode?.data?.node;
  const sourceInputs = sourceNode?.ports.filter(isInputSidePort) ?? [];
  const sourceAggregateInputs = sourceInputs.filter((p: DiagramPort) => p.width !== 'interface');
  const sourceIsComposition = sourceAggregateInputs.length > 1;
  const sourceIsArray = sourceNode
    ? nodeIsArrayNode(sourceNode) ||
      (sourceNode.kind === 'netLabel' && sourceNode.metadata?.cutNet?.isSourceStacked)
    : false;
  const sourceIsArrayComposition =
    sourceNode?.kind === 'bus' &&
    sourceIsComposition &&
    sourceNode.metadata?.aggregateKind === 'array';

  const targetNode = targetFlowNode?.data?.node;
  const targetInputs = targetNode?.ports.filter(isInputSidePort) ?? [];
  const targetAggregateInputs = targetInputs.filter((p: DiagramPort) => p.width !== 'interface');
  const targetIsComposition = targetAggregateInputs.length > 1;
  const targetIsArray = targetNode
    ? nodeIsArrayNode(targetNode) ||
      (targetNode.kind === 'netLabel' && targetNode.metadata?.cutNet?.isSourceStacked)
    : false;
  const targetIsArrayBreakout =
    targetNode?.kind === 'bus' &&
    !targetIsComposition &&
    targetNode.metadata?.aggregateKind === 'array';

  const isPromotedStack = isStacked && targetIsArray && !sourceIsArray;
  const isConvergingStack = isStacked && sourceIsArray && !targetIsArray;
  const isMuxSelectorPromotion = targetNode?.kind === 'mux' && targetHandleId === 'sel';
  const isThickWire = edgeIsThick(diagramEdge, sourceNode, targetNode);
  // The fork/fanout geometry must spread at the array-stacked endpoint's own
  // lane offset (matching its card layers), independent of whether this
  // particular scalar control wire (e.g. clk/rst into a wide data register)
  // is itself thick — see nodeStackIsWide's doc comment.
  const promotedStackWide = targetNode ? nodeStackIsWide(targetNode) : false;
  const convergingStackWide = sourceNode ? nodeStackIsWide(sourceNode) : false;

  const isNetHovered = netKey !== undefined && hoveredNetKey === netKey;
  const isLeaderInNet = edgeData?.isNetLeader === true;
  const isGroupSelected = sourceFlowNode?.selected === true && targetFlowNode?.selected === true;

  // Every other cuttable/reroutable wire that's part of the same multi-selection
  // as this one, so hovering or acting on any one of them can target them all.
  const selectedCuttableEdges = React.useMemo(
    () =>
      flowEdges.filter(
        (edge) =>
          edge.selected === true &&
          edge.data?.edge !== undefined &&
          edge.data.edge.metadata?.cutStub === undefined &&
          !isExpandNamespacedId(edge.id),
      ),
    [flowEdges],
  );
  const isMultiSelected = selected === true && selectedCuttableEdges.length > 1;
  const isPendingCutTarget = isMultiSelected && pendingSelectionAction === 'cut';
  const isPendingRerouteTarget = isMultiSelected && pendingSelectionAction === 'reroute';

  const [hoveredSegmentIndex, setHoveredSegmentIndex] = React.useState<number | null>(null);
  const [isEdgeHovered, setIsEdgeHovered] = React.useState(false);
  // localPoints represents the "structured" path during a drag
  const [localPoints, setLocalPoints] = React.useState<OrthogonalPoint[] | null>(null);
  const dragOffsetRef = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const activeSegmentIndexRef = React.useRef<number>(0);
  const hoverClearTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isDragging = localPoints !== null;

  // Calculate the "official" points from props (used when NOT dragging)
  const normalizedOfficialPoints = normalizeRoutePoints(
    edgeData,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition as unknown as HdlPosition,
    targetPosition as unknown as HdlPosition,
    sourceHandleId,
    targetHandleId,
    !isDragging,
    sourceNode,
    targetNode,
  );
  const obstacles = React.useMemo(
    () =>
      flowNodes
        .map(nodeObstacle)
        .filter((obstacle): obstacle is NodeObstacle => obstacle !== undefined),
    [flowNodes],
  );
  const routedOfficialPoints = React.useMemo(() => {
    if (
      diagramEdge?.metadata?.forceStraight === true ||
      (diagramEdge?.routePoints && diagramEdge.routePoints.length > 0)
    ) {
      return normalizedOfficialPoints;
    }
    return avoidFeedbackObstacles(
      normalizedOfficialPoints,
      obstacles,
      sourcePosition as unknown as HdlPosition,
      targetPosition as unknown as HdlPosition,
    );
  }, [normalizedOfficialPoints, obstacles, sourcePosition, targetPosition, diagramEdge]);

  // A wire spliced inside an expanded instance must never escape that
  // instance's own border (the node IS the frame — see webview/expand):
  // clamp the whole derived route (feedback loops, obstacle detours, saved
  // drags alike) into the container node's live rect minus its border ring
  // (edgeData.contentInsets), so no wire runs under the ring's grab bands
  // where it couldn't be hovered or selected. Skipped while either handle
  // itself sits outside the frame (an internal node dragged beyond the
  // not-yet-growing border — clamping only the route would break
  // orthogonality against the un-clamped handle endpoints). A boundary
  // port's inner handle sits half a grid inside the ring's inner boundary
  // (see EXPAND_RING_PULLBACK), so its stub clamps without distortion.
  const containerFlowNode = edgeData?.containerNodeId
    ? flowNodes.find((node) => node.id === edgeData.containerNodeId)
    : undefined;
  const containerInsets = edgeData?.contentInsets;
  const officialPoints = React.useMemo(() => {
    const containerRect = containerFlowNode ? nodeObstacle(containerFlowNode) : undefined;
    if (!containerRect) return routedOfficialPoints;
    const handlesInside = [
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
    ].every(
      (handle) =>
        handle.x >= containerRect.x &&
        handle.x <= containerRect.x + containerRect.width &&
        handle.y >= containerRect.y &&
        handle.y <= containerRect.y + containerRect.height,
    );
    if (!handlesInside) return routedOfficialPoints;
    const inset = diagramSizing.gridSize / 4;
    return clampPointsToRect(
      routedOfficialPoints,
      containerRect,
      containerInsets ?? {
        top: diagramSizing.nodeHeaderHeight,
        right: inset,
        bottom: inset,
        left: inset,
      },
    );
  }, [
    routedOfficialPoints,
    containerFlowNode,
    containerInsets,
    sourceX,
    sourceY,
    targetX,
    targetY,
  ]);

  const forceStraight = diagramEdge?.metadata?.forceStraight === true;
  const isVertical = Math.abs(sourceX - targetX) < 1;
  const targetHdlPosition =
    forceStraight && isVertical ? HdlPosition.Top : (targetPosition as unknown as HdlPosition);
  const sourceHdlPosition =
    forceStraight && isVertical ? HdlPosition.Bottom : (sourcePosition as unknown as HdlPosition);

  // Use localPoints if we are dragging, otherwise use officialPoints.
  // We MUST prepend and append the actual handle coordinates to officialPoints
  // because normalizeRoutePoints only returns the path between leads.
  // The handle coordinates can intentionally live on half-grid shape boundaries
  // such as the one-grid interface top hat. Snapping them here makes the visible
  // wire miss the rendered node edge by half a grid.
  // extendTargetIntoGate then pushes the last point past a curved-left gate's (OR/NOR/
  // XOR/XNOR) concave edge, so it disappears under the node's fill instead of stopping
  // short of the visible curve — see gateLeftEdgeWireReach for why this is safe.
  const points = extendTargetIntoGate(
    localPoints ?? [{ x: sourceX, y: sourceY }, ...officialPoints, { x: targetX, y: targetY }],
    targetNode,
    targetHdlPosition,
  );
  const rawEdgePath = pathFromPoints(points);
  const {
    back: backStackPoints,
    middle: middleStackPoints,
    front: frontStackPoints,
  } = computeStackedEdgeLayerPoints({
    points,
    sourceHdlPosition,
    targetHdlPosition,
    sourceIsArray,
    sourceIsArrayComposition,
    sourceNode,
    targetIsArray,
    targetIsArrayBreakout,
    targetNode,
    isThickWire,
  });

  const edgeGeometry = React.useMemo(
    () => ({
      edgeId: id,
      points,
      sourceId: netKey ?? source,
      targetId: `${target}:${targetHandleId ?? ''}`,
      netKey,
      sourceHandlePoint: { x: sourceX, y: sourceY },
      targetHandlePoint: { x: targetX, y: targetY },
      isStruct: isStructAggregate,
      isInterface: isInterfaceAggregate,
      isThick: isThickWire,
      isStacked: isStacked && !isPromotedStack && !isConvergingStack,
    }),
    [
      id,
      points,
      source,
      target,
      targetHandleId,
      netKey,
      sourceX,
      sourceY,
      targetX,
      targetY,
      isStructAggregate,
      isInterfaceAggregate,
      isThickWire,
      isStacked,
      isPromotedStack,
      isConvergingStack,
    ],
  );

  const edgeRender = useLineJumpRender(edgeGeometry);
  const overlapHints = useEdgeOverlapHints(edgeGeometry);

  const backRender = React.useMemo(() => {
    if (!isStacked || isPromotedStack || isConvergingStack) return null;
    const geom = {
      ...edgeGeometry,
      points: backStackPoints,
      isStacked: false,
      isStruct: isStructAggregate,
      isInterface: isInterfaceAggregate,
    };
    return context
      ? buildLineJumpRender(geom, context.geometries, context.options)
      : { path: pathFromPoints(backStackPoints), jumpPaths: [], jumpHalos: [] };
  }, [
    edgeGeometry,
    backStackPoints,
    isStacked,
    isPromotedStack,
    isConvergingStack,
    isStructAggregate,
    isInterfaceAggregate,
    context,
  ]);

  const middleRender = React.useMemo(() => {
    if (!isStacked || isPromotedStack || isConvergingStack) return null;
    const geom = {
      ...edgeGeometry,
      points: middleStackPoints,
      isStacked: false,
      isStruct: isStructAggregate,
      isInterface: isInterfaceAggregate,
    };
    return context
      ? buildLineJumpRender(geom, context.geometries, context.options)
      : { path: pathFromPoints(middleStackPoints), jumpPaths: [], jumpHalos: [] };
  }, [
    edgeGeometry,
    middleStackPoints,
    isStacked,
    isPromotedStack,
    isConvergingStack,
    isStructAggregate,
    isInterfaceAggregate,
    context,
  ]);

  const frontRender = React.useMemo(() => {
    if (!isStacked || isPromotedStack || isConvergingStack) return null;
    const geom = {
      ...edgeGeometry,
      points: frontStackPoints,
      isStacked: false,
      isStruct: isStructAggregate,
      isInterface: isInterfaceAggregate,
    };
    return context
      ? buildLineJumpRender(geom, context.geometries, context.options)
      : { path: pathFromPoints(frontStackPoints), jumpPaths: [], jumpHalos: [] };
  }, [
    edgeGeometry,
    frontStackPoints,
    isStacked,
    isPromotedStack,
    isConvergingStack,
    isStructAggregate,
    isInterfaceAggregate,
    context,
  ]);

  const backStackPath = backRender ? backRender.path : pathFromPoints(backStackPoints);
  const middleStackPath = middleRender ? middleRender.path : pathFromPoints(middleStackPoints);
  const frontStackPath = frontRender ? frontRender.path : pathFromPoints(frontStackPoints);

  const jumpHalos = React.useMemo(() => {
    if (isStacked && !isPromotedStack && !isConvergingStack) {
      return [
        ...(backRender?.jumpHalos ?? []),
        ...(middleRender?.jumpHalos ?? []),
        ...(frontRender?.jumpHalos ?? []),
      ];
    }
    if (edgeRender.jumpHalos && edgeRender.jumpHalos.length > 0) {
      return edgeRender.jumpHalos;
    }
    const paths =
      edgeRender.jumpPaths.length > 0
        ? edgeRender.jumpPaths
        : jumpHaloPathsFromPath(edgeRender.path);

    return paths.map((p) => ({ path: p, strokeWidth: 12 }));
  }, [
    isStacked,
    isPromotedStack,
    isConvergingStack,
    backRender,
    middleRender,
    frontRender,
    edgeRender,
    isInterfaceAggregate,
    isStructAggregate,
  ]);
  const promotedFanout = isPromotedStack
    ? promotedStackFanoutPath(
        points,
        targetPosition as unknown as HdlPosition,
        diagramSizing.gridSize * (isMuxSelectorPromotion ? 2 : 1),
        promotedStackWide,
      )
    : undefined;
  const promotedFanoutGradientId = `svsch-stack-fanout-gradient-${stableFragmentId(id)}`;
  const convergingStackPaths = isConvergingStack
    ? (['back', 'middle', 'front'] as ArrayStackLayerId[])
        .map((layerId) =>
          convergingStackPath(
            points,
            layerId,
            sourceHdlPosition,
            targetHdlPosition,
            convergingStackWide,
          ),
        )
        .filter((stackPath): stackPath is ConvergingStackPath => stackPath !== undefined)
    : [];
  const convergingStackGradientId = (layerId: ArrayStackLayerId) =>
    `svsch-stack-converge-gradient-${layerId}-${stableFragmentId(id)}`;

  const labelPoint =
    pointNearPathStart(points) ?? midpoint({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const cutButtonPoint = routeControlPoint(points);
  const isCutStub = diagramEdge?.metadata?.cutStub !== undefined;
  // One end of a cut stub is always the synthetic `netLabel` node — whichever
  // of source/target carries the `cut-label:` id — used by the stub's own
  // solo "Reroute" control to reset just that dangling end's position.
  const cutLabelNodeId = isCutStub
    ? diagramEdge?.source.startsWith('cut-label:')
      ? diagramEdge.source
      : diagramEdge?.target
    : undefined;
  // The stub's own midpoint sits right next to the port it's attached to —
  // routinely underneath the connected block's handle, which always wins
  // pointer-event hit-testing over floating edge UI. Anchor the reset button
  // just below the label itself instead: by construction it's offset clear
  // of the block, so the control lands somewhere actually clickable.
  const cutLabelFlowNode = cutLabelNodeId
    ? flowNodes.find((node) => node.id === cutLabelNodeId)
    : undefined;
  const cutLabelButtonAnchor = cutLabelFlowNode
    ? {
        x:
          cutLabelFlowNode.position.x + diagramNodeDimensions(cutLabelFlowNode.data.node).width / 2,
        y: cutLabelFlowNode.position.y + diagramNodeDimensions(cutLabelFlowNode.data.node).height,
      }
    : cutButtonPoint;
  // A wire's own controls normally only appear while it's directly hovered. When
  // it's part of a multi-wire selection, hovering ANY selected wire reveals every
  // selected wire's controls, so the user can see (and act on) the whole batch.
  // Cut stubs are excluded from multi-select batching (they can't be cut again),
  // so they only ever show their own solo Reroute control on direct hover.
  // Edges spliced in by "Expand instance in place" (issue #232, ids prefixed
  // `expand:` — see webview/expand/splice.ts) aren't part of the extension
  // host's module IR at all; Reroute/Cut aren't supported on them in v1, so
  // don't even offer the controls (see also positionedNodesFromFlowNodes's
  // filter below, which protects the node payload the same way).
  const isExpandSplicedEdge = diagramEdge !== undefined && isExpandNamespacedId(diagramEdge.id);
  const showCutButton =
    diagramEdge !== undefined &&
    edgeData?.moduleName !== undefined &&
    !isCutStub &&
    !isExpandSplicedEdge &&
    (isEdgeHovered || (isMultiSelected && selectionHoverActive));
  const showCutStubResetButton =
    isCutStub &&
    diagramEdge !== undefined &&
    edgeData?.moduleName !== undefined &&
    cutLabelNodeId !== undefined &&
    !isExpandSplicedEdge &&
    isEdgeHovered;
  const netGeometries =
    context && edgeData?.netEdgeIds
      ? context.geometries.filter((geometry) => edgeData.netEdgeIds?.includes(geometry.edgeId))
      : [];
  const netJunctions =
    (isLeaderInNet || isInterfaceAggregate || isStructAggregate) && context
      ? findNetJunctions(netGeometries)
      : [];
  const useStackedJunctionDots =
    sourceIsArray && isLeaderInNet && !isInterfaceAggregate && !isStructAggregate;

  const keepEdgeHover = React.useCallback(() => {
    if (hoverClearTimeoutRef.current) {
      clearTimeout(hoverClearTimeoutRef.current);
      hoverClearTimeoutRef.current = undefined;
    }
    setIsEdgeHovered(true);
    setHovered(netKey);
    setHoveredEdgeId(id);
    if (isMultiSelected) {
      setSelectionHoverActive(true);
    }
  }, [id, netKey, setHovered, setHoveredEdgeId, isMultiSelected, setSelectionHoverActive]);

  const releaseEdgeHover = React.useCallback(() => {
    if (hoverClearTimeoutRef.current) {
      clearTimeout(hoverClearTimeoutRef.current);
    }
    setHovered(undefined);
    hoverClearTimeoutRef.current = setTimeout(() => {
      setIsEdgeHovered(false);
      setSelectionHoverActive(false);
      // Only clear the shared hovered-edge id if it's still ours — the pointer
      // may have already moved onto (and claimed it for) a different edge
      // during this grace period.
      setHoveredEdgeId((current?: string) => (current === id ? undefined : current));
      hoverClearTimeoutRef.current = undefined;
    }, 500);
  }, [id, setHovered, setSelectionHoverActive, setHoveredEdgeId]);

  React.useEffect(
    () => () => {
      if (hoverClearTimeoutRef.current) {
        clearTimeout(hoverClearTimeoutRef.current);
      }
    },
    [],
  );

  const moveSegment = (event: React.PointerEvent, segmentIndex: number, commit: boolean) => {
    const flowPoint = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });

    const currentStructuredPoints = localPoints ?? [
      { x: sourceX, y: sourceY },
      ...officialPoints,
      { x: targetX, y: targetY },
    ];

    // On drag start, capture offset and lock the structure
    if (!localPoints) {
      const initialPoint = currentStructuredPoints[segmentIndex];
      dragOffsetRef.current = {
        x: initialPoint.x - flowPoint.x,
        y: initialPoint.y - flowPoint.y,
      };
      activeSegmentIndexRef.current = segmentIndex;
    }

    const currentSegmentIndex = activeSegmentIndexRef.current;
    const adjustedPoint = {
      x: flowPoint.x + dragOffsetRef.current.x,
      y: flowPoint.y + dragOffsetRef.current.y,
    };

    const availableGeometries = context?.geometries ?? [edgeGeometry];
    const dragGeometries = availableGeometries.map((geometry) =>
      geometry.edgeId === id ? { ...edgeGeometry, points: currentStructuredPoints } : geometry,
    );
    const { moves: sharedMoves, newDraggedIndex } = moveSharedNetSegments(
      dragGeometries,
      id,
      currentSegmentIndex,
      adjustedPoint,
    );
    activeSegmentIndexRef.current = newDraggedIndex;

    const ownMove = sharedMoves.find((move) => move.edgeId === id);
    const nextPoints =
      ownMove?.points ??
      moveRouteSegment(currentStructuredPoints, currentSegmentIndex, adjustedPoint).points;

    if (commit) {
      setLocalPoints(null);
      // Ensure we have a stable structure to save.
      // We want to save exactly what the user sees between the protected leads.
      // Disable simplification to ensure the structure is preserved.
      const finalPoints = makeOrthogonal(nextPoints, false);
      const mainChange: RouteChange = {
        edgeId: id,
        routePoints: routePointsWithAnchoredLeads(finalPoints, officialPoints),
      };

      const otherChanges: RouteChange[] = sharedMoves
        .filter((move) => move.edgeId !== id)
        .map((move) => ({
          edgeId: move.edgeId,
          routePoints: routePointsFromFullPoints(makeOrthogonal(move.points, false)),
        }));

      edgeData?.onRouteChange?.([mainChange, ...otherChanges], true);
    } else {
      setLocalPoints(nextPoints);
      const changes: RouteChange[] = sharedMoves
        .filter((move) => move.edgeId !== id)
        .map((move) => ({
          edgeId: move.edgeId,
          routePoints: routePointsFromFullPoints(move.points),
        }));

      if (changes.length > 0) {
        edgeData?.onRouteChange?.(changes, false);
      }
    }
  };

  return (
    <g onMouseEnter={keepEdgeHover} onMouseLeave={releaseEdgeHover}>
      {isInterfaceAggregate && (
        <defs>
          <pattern
            id="svsch-interface-stripes"
            patternUnits="userSpaceOnUse"
            width="10"
            height="10"
            patternTransform="rotate(45)"
          >
            {/* Centered in the tile: pattern content is clipped to the 10px tile, so a
                line at x=0 would lose half its stroke width. */}
            <line className="svsch-interface-stripe" x1="5" y1="0" x2="5" y2="10" />
          </pattern>
        </defs>
      )}
      {isStructAggregate && (
        <defs>
          <pattern
            id="svsch-struct-stripes"
            patternUnits="userSpaceOnUse"
            width="10"
            height="10"
            patternTransform="rotate(45)"
          >
            <line className="svsch-struct-stripe" x1="5" y1="0" x2="5" y2="10" />
          </pattern>
        </defs>
      )}
      {jumpHalos.map((halo, index) => (
        <path
          key={`${id}-jump-halo-${index}`}
          className="svsch-edge-jump-halo"
          d={halo.path}
          style={{ strokeWidth: halo.strokeWidth }}
        />
      ))}
      {isNetHovered && isLeaderInNet && context && (
        <g className="svsch-edge-net-highlight-group">
          {(() => {
            const netEdgeIds = new Set(edgeData?.netEdgeIds || []);
            const edgePaths = context.geometries
              .filter((g) => netEdgeIds.has(g.edgeId))
              .map((g) => {
                const render = buildLineJumpRender(g, context.geometries, context.options);
                return (
                  <path
                    key={`halo-${g.edgeId}`}
                    className="svsch-edge-net-highlight"
                    d={render.path}
                  />
                );
              });

            // Collect the internal wire segments of any netLabel nodes in this net
            // and place them in the same <g> so the group buffer composites everything
            // at full opacity before the single group opacity is applied — preventing
            // additive brightness where the stub halo and label wire halo would otherwise
            // overlap at the handle point.
            const labelPaths: React.ReactElement[] = [];
            for (const fn of flowNodes) {
              const dn = fn.data?.node;
              if (dn?.kind !== 'netLabel' || dn.metadata?.cutNet?.netKey !== netKey) {
                continue;
              }
              // A spliced (expand-namespaced) label's netKey is child-local —
              // it only belongs to this net's halo if this edge is spliced
              // too, not when a parent net happens to share the same key.
              if (isExpandNamespacedId(fn.id) !== isExpandSplicedEdge) {
                continue;
              }
              const pos = (fn as any).positionAbsolute ?? fn.position;
              if (!pos) continue;
              const { width: lw, height: lh } = diagramNodeDimensions(dn);
              const handleSide = dn.metadata?.cutNet?.handleSide ?? 'left';
              const align = dn.metadata?.cutNet?.align ?? 'start';
              const mx = pos.x;
              const my = pos.y;
              const midY = my + lh / 2;
              const midX = mx + lw / 2;

              let hPath: string;
              let vPath = '';
              if (handleSide === 'top' || handleSide === 'bottom') {
                hPath =
                  align === 'end' ? `M ${midX} ${midY} H ${mx + lw}` : `M ${mx} ${midY} H ${midX}`;
                vPath =
                  handleSide === 'top'
                    ? `M ${midX} ${midY} V ${my}`
                    : `M ${midX} ${midY} V ${my + lh}`;
              } else {
                hPath = `M ${mx} ${midY} H ${mx + lw}`;
              }

              labelPaths.push(
                <path
                  key={`halo-label-${dn.id}`}
                  className="svsch-edge-net-highlight"
                  d={hPath + (vPath ? ' ' + vPath : '')}
                />,
              );
            }

            return [...edgePaths, ...labelPaths];
          })()}
        </g>
      )}
      {/* Selection and pending batch-action preview reuse the exact same halo
          used when hovering a net (svsch-edge-net-highlight), so every "this
          wire matters right now" state reads as one consistent style instead
          of introducing new ones. Covers: React Flow flagging the edge itself
          (selected — marquee, single click), both endpoint nodes selected
          without the edge itself being flagged (isGroupSelected — e.g.
          shift/ctrl-click on each node), and hovering the Cut/Reroute control
          of a multi-wire selection. */}
      {(selected ||
        (isGroupSelected && (isLeaderInNet || isCutStub)) ||
        isPendingCutTarget ||
        isPendingRerouteTarget) && (
        <g className="svsch-edge-net-highlight-group">
          <path className="svsch-edge-net-highlight" d={edgeRender.path} />
        </g>
      )}
      {isStacked && (sourceIsArray || targetIsArray) ? (
        <>
          {isInterfaceAggregate && (
            <path className="svsch-edge svsch-edge-interface-bg" d={edgeRender.path} />
          )}
          {isStructAggregate && (
            <path className="svsch-edge svsch-edge-struct-bg" d={edgeRender.path} />
          )}
          {!isPromotedStack && !isConvergingStack && (
            <path
              className={`svsch-edge svsch-edge-stacked-back${isThickWire ? ' svsch-edge-thick' : ''}`}
              d={backStackPath}
            />
          )}
          {promotedFanout ? (
            <>
              <defs>
                <linearGradient
                  id={promotedFanoutGradientId}
                  gradientUnits="userSpaceOnUse"
                  x1={promotedFanout.barStart.x}
                  y1={promotedFanout.barStart.y}
                  x2={promotedFanout.barEnd.x}
                  y2={promotedFanout.barEnd.y}
                >
                  <stop offset="0%" className="svsch-stack-gradient-front-stop" />
                  <stop offset="50%" className="svsch-stack-gradient-middle-stop" />
                  <stop offset="100%" className="svsch-stack-gradient-back-stop" />
                </linearGradient>
              </defs>
              <path
                className={`svsch-edge${isStructAggregate ? ' svsch-edge-struct' : ''}${isInterfaceAggregate ? ' svsch-edge-interface' : ''}${isThickWire ? ' svsch-edge-thick' : ''}`}
                d={promotedFanout.trunk}
              />
              <path
                className="svsch-edge svsch-edge-stacked-breakout"
                d={promotedFanout.bar}
                style={{ stroke: `url(#${promotedFanoutGradientId})` }}
              />
              {promotedFanout.branches.map((branch, index) => (
                <path
                  key={`${id}-stack-branch-${index}`}
                  className={`svsch-edge svsch-edge-stacked-side svsch-edge-stacked-side-${branch.layerId} ${stackedLayerEdgeClass(branch.layerId)}${isThickWire ? ' svsch-edge-thick' : ''}`}
                  d={branch.path}
                />
              ))}
            </>
          ) : isConvergingStack && convergingStackPaths.length > 0 ? (
            <>
              <defs>
                {convergingStackPaths.map((stackPath) => (
                  <linearGradient
                    key={`${id}-stack-converge-gradient-${stackPath.layerId}`}
                    id={convergingStackGradientId(stackPath.layerId)}
                    gradientUnits="userSpaceOnUse"
                    x1={stackPath.start.x}
                    y1={stackPath.start.y}
                    x2={stackPath.end.x}
                    y2={stackPath.end.y}
                  >
                    <stop
                      offset="0%"
                      className={stackedLayerGradientStopClass(stackPath.layerId)}
                    />
                    <stop offset="78%" className="svsch-stack-gradient-regular-stop" />
                    <stop offset="100%" className="svsch-stack-gradient-regular-stop" />
                  </linearGradient>
                ))}
              </defs>
              {convergingStackPaths.map((stackPath) => (
                <path
                  key={`${id}-stack-converge-${stackPath.layerId}`}
                  className={`svsch-edge svsch-edge-stacked-converge ${stackedLayerEdgeClass(stackPath.layerId)}${isStructAggregate ? ' svsch-edge-struct' : ''}${isInterfaceAggregate ? ' svsch-edge-interface' : ''}${isThickWire ? ' svsch-edge-thick' : ''}`}
                  d={stackPath.path}
                  style={{ stroke: `url(#${convergingStackGradientId(stackPath.layerId)})` }}
                />
              ))}
            </>
          ) : (
            <path
              className={`svsch-edge${isStacked ? ' svsch-edge-stacked' : ''}${isStructAggregate ? ' svsch-edge-struct' : ''}${isInterfaceAggregate ? ' svsch-edge-interface' : ''}${isThickWire ? ' svsch-edge-thick' : ''}`}
              d={isStacked ? middleStackPath : edgeRender.path}
            />
          )}
          {!isPromotedStack && !isConvergingStack && (
            <path
              className={`svsch-edge svsch-edge-stacked-front${isThickWire ? ' svsch-edge-thick' : ''}`}
              d={frontStackPath}
            />
          )}
        </>
      ) : (
        <>
          {isInterfaceAggregate && (
            <path className="svsch-edge svsch-edge-interface-bg" d={edgeRender.path} />
          )}
          {isStructAggregate && (
            <path className="svsch-edge svsch-edge-struct-bg" d={edgeRender.path} />
          )}
          <path
            className={`svsch-edge${isStructAggregate ? ' svsch-edge-struct' : ''}${isInterfaceAggregate ? ' svsch-edge-interface' : ''}${isThickWire ? ' svsch-edge-thick' : ''}`}
            d={edgeRender.path}
          />
        </>
      )}
      <path
        className={`svsch-edge-bridge react-flow__edge-interaction${isStructAggregate ? ' svsch-edge-bridge-struct' : ''}${isInterfaceAggregate ? ' svsch-edge-bridge-interface' : ''}${isThickWire ? ' svsch-edge-bridge-thick' : ''}`}
        d={rawEdgePath}
      />
      {overlapHints.map((hint) => (
        <path key={hint.id} className="svsch-edge-overlap-hint" d={hint.path} style={hint.style} />
      ))}
      {netJunctions.map((junction) =>
        useStackedJunctionDots ? (
          <g key={`${id}-junction-${junction.id}`} className="svsch-edge-junction-stacked">
            {(() => {
              const junctionLayers = arrayStackLayersFor(isThickWire);
              return [
                { layer: junctionLayers.front, opacity: 1 },
                { layer: junctionLayers.middle, opacity: 0.75 },
                { layer: junctionLayers.back, opacity: 0.5 },
              ];
            })().map(({ layer, opacity }, index) => (
              <circle
                key={`${id}-junction-${junction.id}-${index}`}
                className="svsch-edge-junction svsch-edge-junction-stacked-dot"
                cx={junction.x + layer.dx}
                cy={junction.y + layer.dy}
                r={2.15}
                style={{ opacity }}
              />
            ))}
          </g>
        ) : (
          <circle
            key={`${id}-junction-${junction.id}`}
            className={`svsch-edge-junction${isInterfaceAggregate ? ' svsch-edge-junction-interface' : ''}${isStructAggregate ? ' svsch-edge-junction-struct' : ''}`}
            cx={junction.x}
            cy={junction.y}
            r={isInterfaceAggregate || isStructAggregate ? 6.5 : 4.75}
          />
        ),
      )}
      {/* A spliced edge's route comes from the child module's own standalone
          layout, like its nodes' positions — no segment-drag handles are
          offered for one (isExpandSplicedEdge), mirroring how its nodes are
          non-draggable (see expandOverlay's toFlowNode). */}
      {!isExpandSplicedEdge &&
        points.slice(0, -1).map((point, index) => {
          const next = points[index + 1];
          const orientation = segmentOrientation(point, next) ?? dominantOrientation(point, next);
          if (index === 0 || index === points.length - 2) {
            return null;
          }
          return (
            <React.Fragment key={`${id}-segment-${index}`}>
              {hoveredSegmentIndex === index && (
                <path
                  className="svsch-edge-segment-highlight"
                  d={`M ${point.x} ${point.y} L ${next.x} ${next.y}`}
                />
              )}
              <path
                key={`${id}-segment-${index}`}
                className={`svsch-edge-segment-handle svsch-edge-segment-${orientation}`}
                d={`M ${point.x} ${point.y} L ${next.x} ${next.y}`}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setHoveredSegmentIndex(index);
                  moveSegment(event, index, false);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    moveSegment(event, activeSegmentIndexRef.current, false);
                  }
                }}
                onPointerUp={(event) => {
                  moveSegment(event, activeSegmentIndexRef.current, true);
                  setHoveredSegmentIndex(null);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onMouseEnter={() => setHoveredSegmentIndex(index)}
                onMouseLeave={() => {
                  if (!isDragging) {
                    setHoveredSegmentIndex(null);
                  }
                }}
              />
            </React.Fragment>
          );
        })}
      {showCutButton && (
        <foreignObject
          width={110}
          height={24}
          x={cutButtonPoint.x - 55}
          y={cutButtonPoint.y - 34}
          className="svsch-edge-connection-controls"
          onMouseEnter={keepEdgeHover}
          onMouseLeave={releaseEdgeHover}
        >
          <div
            className="svsch-edge-connection-controls-scale"
            style={{ transform: `scale(${counterScale})` }}
          >
            <div className="svsch-edge-connection-controls-inner">
              <button
                type="button"
                className="svsch-edge-reroute-control"
                title={
                  isMultiSelected
                    ? `Reroute ${selectedCuttableEdges.length} selected connections`
                    : 'Reroute this connection'
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (!diagramEdge || !edgeData?.moduleName) {
                    return;
                  }
                  if (isMultiSelected) {
                    vscode.postMessage({
                      type: 'rerouteEdges',
                      moduleName: edgeData.moduleName,
                      edgeIds: selectedCuttableEdges.map((edge) => edge.id),
                      nodes: positionedNodesFromFlowNodes(flowNodes),
                    });
                    return;
                  }
                  vscode.postMessage({
                    type: 'rerouteEdge',
                    moduleName: edgeData.moduleName,
                    edgeId: diagramEdge.id,
                    nodes: positionedNodesFromFlowNodes(flowNodes),
                  });
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseEnter={() => setPendingSelectionAction('reroute')}
                onMouseLeave={() => setPendingSelectionAction(undefined)}
              >
                Reroute
                <kbd className="svsch-shortcut-glyph" aria-hidden="true">
                  <span className="svsch-shortcut-glyph-letter">R</span>
                </kbd>
              </button>
              {/* A partial pane's host (issue #403) keeps no netCuts state to
                  cut against — its cut ends come from the pane's own derived
                  view — so the Cut half of the pill is main-diagram-only. */}
              {!partialDiagram && (
                <button
                  type="button"
                  className="svsch-edge-cut-control"
                  title={
                    isMultiSelected
                      ? `Cut ${selectedCuttableEdges.length} selected nets`
                      : 'Cut net'
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!diagramEdge || !edgeData?.moduleName) {
                      return;
                    }
                    if (isMultiSelected) {
                      vscode.postMessage({
                        type: 'cutNets',
                        moduleName: edgeData.moduleName,
                        edges: selectedCuttableEdges
                          .map((edge) => edge.data?.edge)
                          .filter((edge): edge is DiagramEdge => edge !== undefined),
                        nodes: positionedNodesFromFlowNodes(flowNodes),
                      });
                      return;
                    }
                    vscode.postMessage({
                      type: 'cutNet',
                      moduleName: edgeData.moduleName,
                      edge: diagramEdge,
                      nodes: positionedNodesFromFlowNodes(flowNodes),
                    });
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseEnter={() => setPendingSelectionAction('cut')}
                  onMouseLeave={() => setPendingSelectionAction(undefined)}
                >
                  Cut
                  <kbd className="svsch-shortcut-glyph" aria-hidden="true">
                    <span className="svsch-shortcut-glyph-letter">C</span>
                  </kbd>
                </button>
              )}
            </div>
          </div>
        </foreignObject>
      )}
      {showCutStubResetButton &&
        overlayPortalNode &&
        // A cut stub is always short and hugs the node it's attached to, so
        // its own (deliberately low, non-covering) SVG edge layer sits behind
        // node handles — a foreignObject control here would be unclickable
        // wherever it lands near a port. Render it through the same
        // overlayPortalNode + elevated z-index mechanism the selection Auto
        // Layout toolbar uses to float above everything — not react-flow's
        // own ViewportPortal, which GenerateRegionOverlay needs to keep
        // beneath node bodies (see NodeSelectionToolbar for the full
        // rationale).
        createPortal(
          <div
            className="svsch-cut-stub-reset-layer"
            style={{ left: cutLabelButtonAnchor.x - 32, top: cutLabelButtonAnchor.y + 4 }}
            onMouseEnter={keepEdgeHover}
            onMouseLeave={releaseEdgeHover}
          >
            <div
              className="svsch-cut-stub-reset-scale"
              style={{ transform: `scale(${counterScale})` }}
            >
              <div className="svsch-edge-connection-controls-inner">
                <button
                  type="button"
                  className="svsch-edge-reroute-control svsch-edge-reroute-control-solo"
                  title="Reset this dangling end to its canonical position"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!edgeData?.moduleName || !cutLabelNodeId) {
                      return;
                    }
                    vscode.postMessage({
                      type: 'resetCutLabelPosition',
                      moduleName: edgeData.moduleName,
                      nodeId: cutLabelNodeId,
                    });
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  Reroute
                </button>
              </div>
            </div>
          </div>,
          overlayPortalNode,
        )}
      {label && (
        // Left-anchored at the lead point instead of centered on it — a
        // centered 120-wide box would extend 60px back toward the block the
        // wire just left, overlapping it on anything but a long lead.
        <foreignObject
          width={120}
          height={14}
          x={labelPoint.x}
          y={labelPoint.y - 17}
          className="svsch-edge-label"
        >
          <div>
            <span className="svsch-edge-label-text">{label}</span>
            {diagramEdge?.metadata?.aliasNames && diagramEdge.metadata.aliasNames.length > 0 && (
              <Tooltip
                content={`Also declared as: ${diagramEdge.metadata.aliasNames.join(', ')}`}
                tone="info"
              >
                {(trigger) => (
                  <sup
                    {...trigger}
                    className="hdl-net-label-alias-marker nodrag nopan"
                    role="img"
                    aria-label={`This net also has these declared aliases: ${diagramEdge.metadata!.aliasNames!.join(', ')}`}
                  >
                    *
                  </sup>
                )}
              </Tooltip>
            )}
          </div>
        </foreignObject>
      )}
    </g>
  );
}
