import type {
  DesignGraph,
  DesignModule,
  DiagramEdge,
  DiagramPort,
  PositionedGenerateRegion,
  PositionedNode,
} from '../ir/types';
import type { SavedLayout } from '../storage/layoutStore';
import { resolvedNodeDimensions } from '../diagram/nodeSizing';
import {
  boundaryColumnPad,
  buildBoundaryColumns,
  expandTopPad,
  expandedFrameSize,
  makeExpandPortLabel,
  placeBoundaryEntries,
  unionBounds,
  type ExpandSpliceLayout,
} from '../webview/expand/splice';
import {
  buildViewModel,
  cutLabelEdgeStyle,
  elkSideToHandleSide,
  renderedLeadPoint,
} from './mergeLayout';
import { applyExpandedInstances } from './expandSpliceView';
import { edgeNetKey } from '../ir/edgeNet';

/**
 * Builds the frame-local layout for "Expand instance in place" (issue #232)
 * the way a reader would draw it by hand (see the review discussion on PR
 * #233): take the child module's *normal standalone* place-and-route result —
 * the exact `buildViewModel` pipeline `openModule` renders with, ELK
 * placement plus libavoid routing plus any saved standalone arrangement the
 * user already made — then replace its port nodes in place with cut net ends
 * (netLabel nodes anchored exactly where each port's handle sat) and
 * translate the design into the expanded node's body. The boundary-port
 * labels on the frame border deliberately get *no* routed wire into the
 * content: the signal reads through the matching cut net end, so the child's
 * own standalone routes are kept verbatim instead of being bent toward
 * whatever row the frame's port labels happen to occupy.
 *
 * A net the user had already cut at a port collapses to a no-op: the
 * port-side stub and its dangling label vanish with the port, and the cut
 * ends on the content side were already there.
 *
 * The standalone view is taken *with* the child module's own expanded
 * instances applied (see applyExpandedInstances) — the spliced sub-diagram is
 * a read-only mirror of the child's own diagram, so an instance the user
 * expanded there stays expanded here too, recursively. `ancestorModules`
 * carries the module names already being expanded up the chain; a child
 * module that appears among its own ancestors (a recursive instantiation) is
 * left collapsed instead of recursing forever.
 *
 * Everything returned is in frame-local coordinates (the expanded node's
 * top-left corner is (0, 0)) with child-module-local ids — the webview's
 * spliceExpandedInstance translates to canvas space and namespaces the ids
 * (see ExpandSpliceLayout in webview/expand/splice.ts).
 *
 * Returns undefined when the child module has no diagram at all — the
 * webview then falls back to its own ELK-only placement.
 */
export async function buildExpandSpliceLayout(input: {
  graph: DesignGraph;
  layout: SavedLayout;
  childModuleName: string;
  instanceId: string;
  instancePorts: DiagramPort[];
  instanceSize: { width: number; height: number };
  instanceParamRows: number;
  ancestorModules?: ReadonlySet<string>;
  /** Direct callable body; module expansion resolves from graph.modules. */
  childModule?: DesignModule;
}): Promise<ExpandSpliceLayout | undefined> {
  const { graph, layout, childModuleName, instanceId, instancePorts } = input;
  const childModule = input.childModule ?? graph.modules[childModuleName];
  if (!childModule) return undefined;
  const ancestorModules = input.ancestorModules ?? new Set<string>();
  if (ancestorModules.has(childModuleName)) return undefined;

  // 1. The child's own standalone place-and-route — including synthetic
  //    standalone-view content the raw IR doesn't carry (cut-net labels and
  //    their stub edges), so the unfolded diagram reads exactly like the
  //    module opened on its own — with the child's *own* expanded instances
  //    spliced in on top: the sub-diagram mirrors the child's diagram
  //    exactly, expansions included.
  const layoutGraph = graph.modules[childModuleName]
    ? graph
    : { ...graph, modules: { ...graph.modules, [childModuleName]: childModule } };
  let childView = await buildViewModel(layoutGraph, childModuleName, layout);
  if (childView.nodes.length === 0) return undefined;
  childView = await applyExpandedInstances({
    graph: layoutGraph,
    layout,
    view: childView,
    ancestorModules: new Set([...ancestorModules, childModuleName]),
  });

  const portNodeIds = new Set(
    childView.nodes.filter((node) => node.kind === 'port').map((node) => node.id),
  );
  const nodesById = new Map(childView.nodes.map((node) => [node.id, node]));
  const nodePositions = new Map(childView.nodes.map((node) => [node.id, node.position]));

  // 2. Replace the ports with cut net ends, in standalone coordinates. Each
  //    port-touching wire keeps its standalone route and simply ends in a
  //    netLabel whose 'cut' handle sits exactly where the port's own handle
  //    sat — and a port whose net was already cut (its only edge is a cut
  //    stub to a dangling label) collapses to a no-op instead: stub, label
  //    and port all vanish together.
  const droppedLabelIds = new Set<string>();
  const labelByPortNodeId = new Map<string, PositionedNode>();

  const labelForPort = (
    portNodeId: string,
    edge: DiagramEdge,
    portIsSource: boolean,
  ): PositionedNode => {
    const existing = labelByPortNodeId.get(portNodeId);
    if (existing) return existing;
    const portNode = nodesById.get(portNodeId)!;
    const lead = renderedLeadPoint(
      portNodeId,
      portIsSource ? edge.sourcePort : edge.targetPort,
      nodesById,
      nodePositions,
      false,
      portIsSource ? 'source' : 'target',
    );
    const size = resolvedNodeDimensions(portNode);
    const position = nodePositions.get(portNodeId)!;
    const label = makeExpandPortLabel({
      portNode,
      moduleName: childModule.name,
      portIsSource,
      netKey: edgeNetKey(edge),
      originalEdgeId: edge.id,
      handleSide: lead ? elkSideToHandleSide(lead.side) : portIsSource ? 'right' : 'left',
      handlePoint: lead?.point ?? {
        x: portIsSource ? position.x + size.width : position.x,
        y: position.y + size.height / 2,
      },
      edgeStyle: cutLabelEdgeStyle(edge, nodesById),
    });
    labelByPortNodeId.set(portNodeId, label);
    return label;
  };

  const contentEdges: DiagramEdge[] = [];
  // Deterministic label metadata for a fanout port: the same (sorted-first)
  // edge always seeds the label, regardless of IR edge order.
  const sortedEdges = [...childView.edges].sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of sortedEdges) {
    const sourceIsPort = portNodeIds.has(edge.source);
    const targetIsPort = portNodeIds.has(edge.target);
    if (!sourceIsPort && !targetIsPort) {
      contentEdges.push(edge);
      continue;
    }
    if (edge.metadata?.cutStub) {
      // Already cut at the port — the port-side stub and its dangling label
      // collapse with the port.
      const labelEndId = sourceIsPort ? edge.target : edge.source;
      if (nodesById.get(labelEndId)?.kind === 'netLabel') {
        droppedLabelIds.add(labelEndId);
      }
      continue;
    }
    let { source, sourcePort, target, targetPort } = edge;
    if (sourceIsPort) {
      source = labelForPort(edge.source, edge, true).id;
      sourcePort = 'cut';
    }
    if (targetIsPort) {
      target = labelForPort(edge.target, edge, false).id;
      targetPort = 'cut';
    }
    contentEdges.push({ ...edge, source, sourcePort, target, targetPort });
  }

  const contentNodes = [
    ...childView.nodes.filter((node) => !portNodeIds.has(node.id) && !droppedLabelIds.has(node.id)),
    ...labelByPortNodeId.values(),
  ];

  // 3. Translate the standalone content so its bounding box (nodes — cut net
  //    ends included — plus every kept route, so no wire detour pokes past
  //    the frame padding) lands one label column in from the left border and
  //    just below the header/parameter rows.
  const { inputColumn, outputColumn } = buildBoundaryColumns(
    childModule,
    instancePorts,
    instanceId,
  );
  const padLeft = boundaryColumnPad(inputColumn);
  const padRight = boundaryColumnPad(outputColumn);
  const padTop = expandTopPad(input.instanceParamRows);

  const contentRects = [
    ...contentNodes.map((node) => {
      const size = resolvedNodeDimensions(node);
      return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
    }),
    ...contentEdges.flatMap(
      (edge) =>
        edge.routePoints?.map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 })) ?? [],
    ),
  ];
  const standaloneBounds = unionBounds(contentRects) ?? { x: 0, y: 0, width: 0, height: 0 };
  const dx = padLeft - standaloneBounds.x;
  const dy = padTop - standaloneBounds.y;
  const translatePoint = (point: { x: number; y: number }) => ({
    x: point.x + dx,
    y: point.y + dy,
  });

  const placedContentNodes: PositionedNode[] = contentNodes.map((node) => ({
    ...node,
    position: translatePoint(node.position),
  }));
  const placedContentEdges: DiagramEdge[] = contentEdges.map((edge) => ({
    ...edge,
    waypoint: edge.waypoint ? translatePoint(edge.waypoint) : undefined,
    routePoints: edge.routePoints?.map(translatePoint),
  }));

  // The child's own generate-block regions and, recursively, any of its own
  // already-expanded instances (see applyExpandedInstances, which is what
  // populates childView.generateRegions with the latter) — translated the
  // same as content so a nested "Expand" keeps its own minimap outline once
  // it's spliced into this frame (see ExpandSpliceLayout.nestedRegions).
  const nestedRegions: PositionedGenerateRegion[] = (childView.generateRegions ?? []).map(
    (region) => ({
      ...region,
      bounds: { ...region.bounds, ...translatePoint(region.bounds) },
    }),
  );

  // 4. Place the design into the outer node: the frame grows around the
  //    translated content (grow-only against the instance's pre-expand
  //    size), and the boundary-port labels land on its border at the
  //    instance's own port rows — pure labels, with no routed wire into the
  //    content.
  const expandedSize = expandedFrameSize({
    instanceSize: input.instanceSize,
    padLeft,
    padRight,
    content: {
      x: padLeft,
      y: padTop,
      width: standaloneBounds.width,
      height: standaloneBounds.height,
    },
  });

  const placedBoundary = placeBoundaryEntries(
    [...inputColumn, ...outputColumn],
    { x: 0, y: 0 },
    expandedSize.width,
    input.instanceParamRows,
  );
  const boundaryNodes: PositionedNode[] = placedBoundary.map(({ entry, position }) => ({
    ...entry.node,
    position,
  }));

  return {
    nodes: [...boundaryNodes, ...placedContentNodes],
    edges: placedContentEdges,
    expandedSize,
    nestedRegions,
  };
}
