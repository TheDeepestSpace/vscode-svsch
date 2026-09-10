import type { Edge } from '@xyflow/react';
import { diagramSizing } from '../../diagram/constants';
import type {
  DiagramEdge,
  DiagramPort,
  PositionedGenerateRegion,
  PositionedNode,
} from '../../ir/types';
import type { HdlFlowNode } from '../nodes/types';
import type { RouteChange } from '../orthogonal';
import { isExpandNamespacedId, type ExpandContentInsets, type SpliceResult } from './splice';

export { isExpandNamespacedId };

// Spliced boundary/internal nodes render above edges (matching every other
// block node's zIndex in main.tsx's BLOCK_NODE_Z_INDEX) so an edge routed
// through a boundary port's handle passes visually *underneath* its label
// rather than striking through it — mirrors how any ordinary node's ports
// already occlude the wires terminating on them. The dimmed instance "ghost"
// (see applyActiveSplices) sits below edges instead, purely as a translucent
// backdrop that never competes with real content for paint order.
const SPLICE_NODE_Z_INDEX = 2;
const EXPAND_GHOST_Z_INDEX = 0;
// Same layer as main.tsx's EDGE_Z_INDEX for ordinary wires. Without an
// explicit zIndex a spliced edge defaults to 0 — the ghost node's own layer —
// and nodes win over edges within a layer, so the ghost's (frame-sized!) body
// would swallow every pointer event aimed at an inner wire: hover, segment
// dragging, selection. At 1 the wires sit above the ghost backdrop and below
// the spliced nodes, exactly like top-level wires relative to their blocks.
const SPLICE_EDGE_Z_INDEX = 1;

/**
 * CSS class marking an expanded instance's own node as a dimmed backdrop —
 * see applyActiveSplices.
 */
export const EXPAND_GHOST_CLASS = 'hdl-node-expand-ghost';

/**
 * One currently-expanded instance's live overlay state, cached independently
 * of the server-driven `view` so it survives unrelated view refreshes (see
 * main.tsx's spliceMapRef).
 */
export interface ActiveSplice extends SpliceResult {
  /** Absent on legacy/test fixtures and treated as an instance expansion. */
  expansionKind?: 'instance' | 'funcCall' | 'taskCall';
  namespace: string;
  /**
   * Id this splice's instance node has *in the current flow `nodes` array* —
   * the plain instance id at the top level, or the enclosing splice's
   * namespaced id for a nested Expand.
   */
  flowInstanceId: string;
  parentModuleName: string;
  instanceId: string;
  childModuleName: string;
  topLevel: boolean;
  /**
   * The instance's position at the moment this splice's node positions were
   * computed — diffed against its current position on every reattachment to
   * rigidly translate the whole splice if the instance has since moved.
   */
  anchorInstancePosition: { x: number; y: number };
  /**
   * The instance node's own `sizeOverride` (usually undefined) as it arrived
   * in the last server view, captured by applyActiveSplices right before the
   * expanded size is written over it — persistence paths restore this so the
   * expanded size never leaks into the host's saved layout as a manual
   * resize (see main.tsx's stripExpandSplices).
   */
  baseSizeOverride?: { width: number; height: number };
}

function toFlowNode(node: PositionedNode, moduleName: string): HdlFlowNode {
  // A nested expand inside the spliced child arrives pre-flattened from the
  // host (see buildExpandSpliceLayout's recursion): its instance node comes
  // through as ordinary content, already grown and stamped with
  // `metadata.expandGhost` by applyExpandedInstances. Give it the same dimmed
  // backdrop treatment dimAsExpandGhost gives a live top-level frame so it
  // reads (and layers) like one — just read-only, like everything spliced.
  const nestedGhost = node.metadata?.expandGhost;
  return {
    id: node.id,
    type: 'hdl',
    position: node.position,
    zIndex: nestedGhost ? EXPAND_GHOST_Z_INDEX : SPLICE_NODE_Z_INDEX,
    className: nestedGhost ? EXPAND_GHOST_CLASS : undefined,
    // Every spliced node — boundary port or internal content — is
    // non-draggable: the only place a child module's own layout may be
    // edited is that module's own standalone view (see the product decision
    // in issue #232's PR review). Programmatic carries (dragging the frame
    // moves the whole splice) still apply, since those go through
    // onNodesChange position changes, not a drag started on the node itself.
    draggable: false,
    data: {
      node,
      moduleName,
      arrayConnections: [],
      ...(nestedGhost ? { expandContentInsets: nestedGhost.insets } : {}),
    },
  };
}

function toFlowEdge(
  edge: DiagramEdge,
  moduleName: string,
  containerNodeId: string,
  contentInsets: ExpandContentInsets,
): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort,
    targetHandle: edge.targetPort,
    label: edge.label,
    type: 'svsch',
    zIndex: SPLICE_EDGE_Z_INDEX,
    data: {
      waypoint: edge.waypoint,
      routePoints: edge.routePoints,
      // No onRouteChange: a spliced wire's routing, like its nodes'
      // positions, comes from the child module's own standalone layout —
      // OrthogonalEdge doesn't offer segment-drag handles for a
      // namespace-prefixed edge id at all (see isExpandSplicedEdge there),
      // so there is nothing left to wire this up to.
      edge,
      moduleName,
      isNetLeader: true,
      netEdgeIds: [edge.id],
      // The expanded instance's own node is the frame the spliced content
      // lives in — OrthogonalEdge clamps this edge's derived route inside
      // that node's live rect, minus the frame's border ring, so an internal
      // wire can never escape the expanded module's boundary nor run under
      // the ring's grab bands (see clampPointsToRect).
      containerNodeId,
      contentInsets,
    },
  } as Edge;
}

// Turns an expanded instance's own flow node into the expanded frame itself:
// grown (via a grow-only sizeOverride, in grid units) to the splice's
// computed expandedSize so its body fully contains the unfolded child
// diagram, and dimmed — still the real node (parameters, port labels,
// outline and all) and still draggable/selectable (dragging it carries the
// spliced content with it — see main.tsx's onNodesChange — and selecting it
// is what surfaces the "Collapse" control in NodeSelectionToolbar). There is
// no separate region outline: the node's own border is the boundary of the
// expanded content.
//
// expandContentInsets confines those pointer interactions to the frame's
// border ring: the ghost wrapper itself is pointer-transparent (see the
// .hdl-node-expand-ghost rules in diagram.css) and HdlNode re-enables the
// pointer only on grab bands covering the ring, so the sub-diagram area
// inside behaves like ordinary canvas — middle-drag pans, clicks fall
// through to the pane — while the spliced nodes/wires on top keep their own
// interactions.
function dimAsExpandGhost(node: HdlFlowNode, splice: ActiveSplice): HdlFlowNode {
  const grid = diagramSizing.gridSize;
  return {
    ...node,
    zIndex: EXPAND_GHOST_Z_INDEX,
    className: [node.className, EXPAND_GHOST_CLASS].filter(Boolean).join(' '),
    data: {
      ...node.data,
      expandContentInsets: splice.contentInsets,
      node: {
        ...node.data.node,
        sizeOverride: {
          width: Math.ceil(splice.expandedSize.width / grid),
          height: Math.ceil(splice.expandedSize.height / grid),
        },
      },
    },
  };
}

function portNameById(ports: DiagramPort[]): Map<string, string> {
  return new Map(ports.map((port) => [port.id, port.name]));
}

/**
 * Merges every active "Expand" splice on top of an already-built base
 * nodes/edges/regions set: dims each expanded instance's own node into a
 * translucent backdrop (still its full self — parameters, port labels,
 * outline — just faded and pushed behind everything else, see
 * EXPAND_GHOST_CLASS/EXPAND_GHOST_Z_INDEX), splices in its boundary+internal
 * nodes/edges, rewires whichever base edges used to terminate on the
 * instance so they land on the matching boundary node instead (retaining
 * the host's obstacle-aware route: once the host knows the expanded frame
 * sizes, its route endpoints already coincide with these boundary handles),
 * and appends the splice's region (reusing the exact same `regions`
 * array/overlay/drag-sync GenerateRegionOverlay already provides — see
 * PositionedGenerateRegion.expandedInstance in ir/types.ts for why).
 *
 * Applied both (a) every time a fresh server `view` rebuilds the base
 * arrays, so already-expanded instances stay expanded across unrelated
 * round-trips, and (b) once immediately when a new splice first arrives.
 */
export function applyActiveSplices(
  baseNodes: HdlFlowNode[],
  baseEdges: Edge[],
  baseRegions: PositionedGenerateRegion[],
  splices: Map<string, ActiveSplice>,
  moduleName: string,
): { nodes: HdlFlowNode[]; edges: Edge[]; regions: PositionedGenerateRegion[] } {
  if (splices.size === 0) {
    return { nodes: baseNodes, edges: baseEdges, regions: baseRegions };
  }

  // Shallowest first: a nested splice's own instance node only exists in
  // `nodes` once its parent splice's content has already been merged in.
  const ordered = [...splices.values()].sort(
    (a, b) => a.namespace.split('::').length - b.namespace.split('::').length,
  );

  let nodes = baseNodes;
  let edges = baseEdges;
  const extraRegions: PositionedGenerateRegion[] = [];

  for (const splice of ordered) {
    const instanceNode = nodes.find((node) => node.id === splice.flowInstanceId);
    if (!instanceNode) {
      // Instance no longer present in this view (e.g. the design changed
      // underneath it). Leave the splice cached in case it reappears rather
      // than silently discarding a user's expanded state.
      continue;
    }

    const dx = instanceNode.position.x - splice.anchorInstancePosition.x;
    const dy = instanceNode.position.y - splice.anchorInstancePosition.y;
    const translatedNodes =
      dx === 0 && dy === 0
        ? splice.nodes
        : splice.nodes.map((node) => ({
            ...node,
            position: { x: node.position.x + dx, y: node.position.y + dy },
          }));
    // User-dragged internal wire routes (see absorbSplicedEdgeRouteChanges)
    // are stored in absolute coordinates at the same anchor as the node
    // positions — translate them by the same delta so a moved instance's
    // wires reattach alongside its nodes instead of deforming.
    const translatedEdges =
      dx === 0 && dy === 0
        ? splice.edges
        : splice.edges.map((edge) =>
            edge.routePoints && edge.routePoints.length > 0
              ? {
                  ...edge,
                  routePoints: edge.routePoints.map((point) => ({
                    x: point.x + dx,
                    y: point.y + dy,
                  })),
                }
              : edge,
          );
    const region =
      dx === 0 && dy === 0
        ? splice.region
        : {
            ...splice.region,
            bounds: {
              ...splice.region.bounds,
              x: splice.region.bounds.x + dx,
              y: splice.region.bounds.y + dy,
            },
          };
    // Regions belonging to generate blocks / already-expanded instances
    // living inside this splice's own content (see SpliceResult.nestedRegions)
    // ride along with the same rigid translation as the region itself.
    const nestedRegions = splice.nestedRegions ?? [];
    const translatedNestedRegions =
      dx === 0 && dy === 0
        ? nestedRegions
        : nestedRegions.map((nested) => ({
            ...nested,
            bounds: { ...nested.bounds, x: nested.bounds.x + dx, y: nested.bounds.y + dy },
          }));

    const boundaryIdByPortName = splice.boundaryNodeIdByChildPortName;
    const instancePortNames = portNameById(instanceNode.data.node.ports);

    edges = edges.map((edge) => {
      const sourceMatches = edge.source === splice.flowInstanceId;
      const targetMatches = edge.target === splice.flowInstanceId;
      if (!sourceMatches && !targetMatches) return edge;
      const handleId = sourceMatches ? edge.sourceHandle : edge.targetHandle;
      const portName = handleId ? instancePortNames.get(handleId) : undefined;
      const boundaryId = portName ? boundaryIdByPortName.get(portName) : undefined;
      if (!boundaryId) return edge;
      return {
        ...edge,
        source: sourceMatches ? boundaryId : edge.source,
        target: targetMatches ? boundaryId : edge.target,
        sourceHandle: sourceMatches ? 'outer' : edge.sourceHandle,
        targetHandle: targetMatches ? 'outer' : edge.targetHandle,
      };
    });

    // The base node carries the instance's true persisted sizeOverride (if
    // any) — remember it before the expanded size is written over it, so
    // persistence paths can restore it (see ActiveSplice.baseSizeOverride).
    splice.baseSizeOverride = instanceNode.data.node.sizeOverride;
    nodes = [
      ...nodes.map((node) =>
        node.id === splice.flowInstanceId ? dimAsExpandGhost(node, splice) : node,
      ),
      ...translatedNodes.map((n) => toFlowNode(n, moduleName)),
    ];
    edges = [
      ...edges,
      ...translatedEdges.map((edge) =>
        toFlowEdge(edge, moduleName, splice.flowInstanceId, splice.contentInsets),
      ),
    ];
    extraRegions.push(region, ...translatedNestedRegions);
  }

  return { nodes, edges, regions: [...baseRegions, ...extraRegions] };
}

/**
 * Re-syncs every cached splice's `nodes`/`region`/`anchorInstancePosition`
 * from the live flow state after a drag/resize commit, so (a) a later
 * unrelated view refresh reattaches the user's manual adjustments instead of
 * quietly reverting to stale ELK-time positions, and (b) `applyActiveSplices`
 * doesn't re-translate an already-translated splice a second time — updating
 * `anchorInstancePosition` to the instance's current position here is what
 * makes the next reattachment's dx/dy come out zero for content that hasn't
 * moved relative to its instance since this sync. Mutates `splices` in place
 * (it's a ref, not React state).
 */
export function syncSpliceCache(
  splices: Map<string, ActiveSplice>,
  nodes: HdlFlowNode[],
  regions: PositionedGenerateRegion[],
  flowEdges?: Edge[],
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const flowEdgesById = flowEdges ? new Map(flowEdges.map((edge) => [edge.id, edge])) : undefined;
  for (const [namespace, splice] of splices) {
    const region = regionsById.get(splice.region.id);
    const instanceNode = nodesById.get(splice.flowInstanceId);
    if (!region || !instanceNode) continue;
    const updatedNodes: PositionedNode[] = [];
    for (const node of splice.nodes) {
      const flowNode = nodesById.get(node.id);
      if (!flowNode) continue;
      updatedNodes.push({ ...flowNode.data.node, position: flowNode.position });
    }
    // Wire routes live in the flow edges' data (kept current during drags by
    // handleRouteChange) — re-capture them at the same moment the anchor
    // position updates, so route coordinates and anchor stay consistent.
    const updatedEdges = flowEdgesById
      ? splice.edges.map((edge) => {
          const flowEdge = flowEdgesById.get(edge.id);
          if (!flowEdge) return edge;
          const routePoints = (flowEdge.data as any)?.routePoints as
            Array<{ x: number; y: number }> | undefined;
          if (routePoints === edge.routePoints) return edge;
          return { ...edge, routePoints: routePoints?.map((point) => ({ ...point })) };
        })
      : splice.edges;
    // Unlike the region above, a nested region's bounds have no fixed formula
    // relative to the instance — re-capture them from the live regions array
    // (already carrying whatever translation the last applyActiveSplices pass
    // applied), same as updatedNodes captures live node positions above.
    const updatedNestedRegions = (splice.nestedRegions ?? []).map((nested) => {
      const live = regionsById.get(nested.id);
      return live ? { ...nested, bounds: { ...live.bounds } } : nested;
    });
    splices.set(namespace, {
      ...splice,
      edges: updatedEdges,
      // Expand-region bounds are defined as exactly the expanded node's rect
      // (see splice.ts) — recompute from the instance's live position rather
      // than trusting the regions array, which node-drags don't update.
      region: {
        ...region,
        bounds: {
          x: instanceNode.position.x,
          y: instanceNode.position.y,
          width: splice.expandedSize.width,
          height: splice.expandedSize.height,
        },
      },
      nestedRegions: updatedNestedRegions,
      nodes: updatedNodes,
      anchorInstancePosition: { ...instanceNode.position },
    });
  }
}

/**
 * Splits a route-change batch into spliced-edge changes (absorbed into the
 * live splice cache, since the host knows nothing about spliced content) and
 * the remainder (returned, for the host's own edgeRoutesChanged handling).
 * Absorbing into `splices` is what lets a user-dragged internal wire survive
 * the next applyActiveSplices reattachment instead of resetting to the
 * default route. Mutates `splices` in place (it's a ref, not React state).
 */
export function absorbSplicedEdgeRouteChanges(
  splices: Map<string, ActiveSplice>,
  changes: RouteChange[],
): RouteChange[] {
  const remaining: RouteChange[] = [];
  for (const change of changes) {
    if (!isExpandNamespacedId(change.edgeId)) {
      remaining.push(change);
      continue;
    }
    for (const [namespace, splice] of splices) {
      const index = splice.edges.findIndex((edge) => edge.id === change.edgeId);
      if (index < 0) continue;
      const edges = [...splice.edges];
      edges[index] = {
        ...edges[index],
        waypoint: undefined,
        routePoints: change.routePoints.map((point) => ({ ...point })),
      };
      splices.set(namespace, { ...splice, edges });
      break;
    }
  }
  return remaining;
}

/**
 * Removes a splice and every splice nested inside it (namespace-prefix
 * match), returning the removed set's flow-instance ids so callers can e.g.
 * re-select the collapsed instance.
 */
export function removeSpliceAndDescendants(
  splices: Map<string, ActiveSplice>,
  namespace: string,
): void {
  for (const key of [...splices.keys()]) {
    if (key === namespace || key.startsWith(`${namespace}::`)) {
      splices.delete(key);
    }
  }
}
