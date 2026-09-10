import type {
  DesignGraph,
  DesignModule,
  DiagramEdge,
  DiagramNode,
  DiagramViewModel,
  GenerateRegion,
  PositionedGenerateRegion,
  PositionedNode,
} from '../ir/types';
import {
  nodeIsArrayNode,
  registerClockSignal,
  registerResetSignal,
  structRole,
} from '../ir/nodeMetadata';
import { edgeNetKey, endpointKey } from '../ir/edgeNet';
import { edgeIsThick, nodeStackIsWide } from '../ir/edgeStyle';
import {
  ARRAY_STACK_LANE_OFFSET,
  ARRAY_STACK_WIDE_LANE_OFFSET,
} from '../webview/arrayStackGeometry';
import type { SavedLayout, SavedModuleLayout, SavedNetCut } from '../storage/layoutStore';
import { diagramSizing } from '../diagram/constants';
import {
  diagramNodeDimensions,
  instanceParameterRows,
  inverterGeometryWidth,
  resolvedNodeDimensions,
} from '../diagram/nodeSizing';
import { gateInputPortCenterY } from '../diagram/muxGeometry';
import {
  annotateGenerateRegionWarnings,
  findExternalBlockIds,
  GENERATE_REGION_EXTERNAL_BLOCK_WARNING,
} from './generateRegionValidation';
import {
  interfaceSidePortCenters,
  interfaceTopHatHeight,
  interfaceTopPortX,
} from '../diagram/interfaceGeometry';
import { routeDiagramWithLibavoid } from './libavoidRouter';
import { routingObstacleMargins } from './routingObstacleGeometry';
import { isInputSidePort } from '../diagram/portDirection';

interface AutoLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  routes: Map<string, Array<{ x: number; y: number }>>;
  regionBounds: Map<string, RegionBounds>;
}

export type ElkPortSide = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

export interface ElkDiagramNode {
  id: string;
  width: number;
  height: number;
  ports: Array<{
    id: string;
    width: number;
    height: number;
    x?: number;
    y?: number;
    layoutOptions: Record<string, string>;
    properties: Record<string, string>;
  }>;
  layoutOptions: Record<string, string>;
  properties: Record<string, string>;
  layoutOffset: { x: number; y: number };
}

interface ElkLayoutNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ports?: ElkDiagramNode['ports'];
  children?: ElkLayoutNode[];
  layoutOptions?: Record<string, string>;
  properties?: Record<string, string>;
}

export interface BuildViewModelOptions {
  /**
   * Transient, layout-only node size overrides in sizeOverride grid units —
   * used by the placement ELK pass, the net-cut projection, and the routing
   * pass (all of which must see each node's *rendered* box), never persisted
   * and never echoed back on the returned view's nodes. The one current use:
   * an "Expand instance in place" frame's expanded footprint during Auto
   * Layout (see relayoutSelection in diagramPanel.ts), which deliberately
   * isn't stored in the module's saved layout.
   */
  elkSizeOverrides?: Record<string, { width: number; height: number }>;
}

export async function buildViewModel(
  graph: DesignGraph,
  moduleName: string,
  layout: SavedLayout,
  options?: BuildViewModelOptions,
): Promise<DiagramViewModel> {
  const designModule = graph.modules[moduleName];
  if (!designModule) {
    return {
      moduleName,
      nodes: [],
      edges: [],
      generateRegions: [],
      diagnostics: graph.diagnostics,
    };
  }

  const moduleLayout = layout.modules[designModule.name] ?? { nodes: {} };
  const activeCuts = activeNetCuts(designModule, moduleLayout);
  const activeCutKeys = new Set(activeCuts.keys());
  const routedDesignEdges = designModule.edges.filter(
    (edge) => !activeCutKeys.has(edgeNetKey(edge)),
  );
  const generateRegions = designModule.generateRegions ?? [];
  // The generate-block wrappers are derived from their arms, so keep them out of the ELK /
  // packing layout (arms fall back to roots) and only add their bounds in positionGenerateRegions.
  const armRegions = generateRegions.filter((region) => !region.isGenerateBlock);
  const elkLayout = await autoLayoutMissingNodes(
    designModule.nodes,
    routedDesignEdges,
    moduleLayout,
    armRegions,
    netCutPortMargins(designModule, activeCuts),
    options?.elkSizeOverrides,
  );
  const initialPositioned = designModule.nodes.map((node, index): PositionedNode => {
    const saved = moduleLayout.nodes[node.id];
    const elk = elkLayout.positions.get(node.id);
    const fallback = defaultPosition(index, node.kind);

    const position = saved?.fixed
      ? { x: saved.x, y: saved.y }
      : (elk ?? (saved ? { x: saved.x, y: saved.y } : fallback));

    return {
      ...node,
      fixed: saved?.fixed,
      sizeOverride:
        saved?.width !== undefined && saved?.height !== undefined
          ? { width: saved.width, height: saved.height }
          : undefined,
      position: snapPosition(position, node.kind, structRole(node)),
    };
  });
  const packedGenerateLayout =
    elkLayout.regionBounds.size > 0
      ? { nodes: initialPositioned, movedNodeIds: new Set<string>() }
      : packGenerateRegionSiblings(armRegions, initialPositioned, moduleLayout);
  // A pristine layout (nothing dragged, nothing released back to Auto Layout
  // yet) is the only state this "free preset" columnizing applies to;
  // touching the diagram at all opts a module out until a full Reset clears
  // moduleLayout.nodes and restores it. This can no longer check for
  // `moduleLayout.nodes` being empty: mergeNodeSnapshot now populates it with
  // unfixed positions on every render as a durability snapshot, so presence
  // alone no longer means "touched". It can't check for `fixed` alone either:
  // mergeRelayoutSelection ("Auto Layout") deliberately writes released nodes
  // with `fixed: false` rather than deleting them, so a module that's had
  // Auto Layout run on it (but nothing pinned) must still count as touched.
  // The distinguishing signal is whether `fixed` was ever explicitly set —
  // mergeNodeSnapshot's entries always omit the key entirely.
  const isPristineLayout = !Object.values(moduleLayout.nodes).some(
    (node) => node.fixed !== undefined,
  );
  const positioned = isPristineLayout
    ? columnizeFullyCutBoundaryPorts(designModule, activeCuts, packedGenerateLayout.nodes)
    : packedGenerateLayout.nodes;
  const positionedRegions = positionGenerateRegions(
    generateRegions,
    positioned,
    moduleLayout,
    elkLayout.regionBounds,
  );

  const externalBlockIds = findExternalBlockIds(positionedRegions, positioned);
  const positionedWithWarnings =
    externalBlockIds.size > 0
      ? positioned.map((node) =>
          externalBlockIds.has(node.id)
            ? { ...node, invalid: true, warningNote: GENERATE_REGION_EXTERNAL_BLOCK_WARNING }
            : node,
        )
      : positioned;

  const nodesById = new Map<string, DiagramNode>(
    positionedWithWarnings.map((node) => [node.id, node]),
  );
  // The net-cut projection and the routing pass below derive geometry (port
  // lead points, collision boxes, obstacles) from these nodes — like the ELK
  // pass above, they must see each node at its rendered box, so a transient
  // elkSizeOverride (an expanded instance's frame during Auto Layout) applies
  // here too. Geometry-only: the returned view's nodes stay clean of it.
  const withGeometryOverrides = (geometryNodes: PositionedNode[]): PositionedNode[] => {
    const overrides = options?.elkSizeOverrides;
    if (!overrides) return geometryNodes;
    return geometryNodes.map((node) => {
      const override = overrides[node.id];
      return override ? { ...node, sizeOverride: override } : node;
    });
  };
  const cutProjection = buildNetCutProjection(
    designModule,
    moduleLayout,
    activeCuts,
    withGeometryOverrides(positioned),
  );
  const routingNodes = [...withGeometryOverrides(positionedWithWarnings), ...cutProjection.nodes];
  const routingNodesById = new Map<string, DiagramNode>(
    routingNodes.map((node) => [node.id, node]),
  );
  const routingNodePositions = new Map(routingNodes.map((node) => [node.id, node.position]));
  const candidates = routedDesignEdges.filter(
    (edge) => !moduleLayout.edges?.[edge.id]?.routePoints,
  );
  const result = await routeDiagramWithLibavoid(
    // Dangling ends are real visual obstacles too. Build them before routing
    // so ordinary nets cannot pass through a cut label that happens to land
    // in their otherwise-clear corridor.
    routingNodes,
    candidates,
    (nodeId, portId, includeLeadMargins, role) =>
      renderedLeadPoint(
        nodeId,
        portId,
        routingNodesById,
        routingNodePositions,
        includeLeadMargins,
        role,
      ),
  );
  const edgeLabels = assignEdgeNetLabels(routedDesignEdges, nodesById);

  return {
    moduleName: designModule.name,
    parameters: designModule.parameters,
    nodes: [...positionedWithWarnings, ...cutProjection.nodes],
    edges: [
      ...routedDesignEdges.map((edge) => ({
        ...edge,
        metadata: edge.metadata
          ? {
              ...edge.metadata,
              aliasNames: visibleAliasNames(edge.metadata.aliasNames, edge, nodesById),
            }
          : edge.metadata,
        label: edgeLabels.get(edge.id),
        waypoint: moduleLayout.edges?.[edge.id]?.waypoint,
        routePoints:
          moduleLayout.edges?.[edge.id]?.routePoints ??
          result.routes.get(edge.id) ??
          (edgeTouchesMovedNode(edge, packedGenerateLayout.movedNodeIds)
            ? undefined
            : elkLayout.routes.get(edge.id)) ??
          moduleLayout.edges?.[edge.id]?.routeSnapshot,
      })),
      ...cutProjection.edges.map((edge) => ({
        ...edge,
        routePoints:
          cutStubRouteAroundSizeOverrides(
            edge,
            options?.elkSizeOverrides,
            routingNodesById,
            routingNodePositions,
          ) ?? edge.routePoints,
      })),
    ],
    generateRegions: positionedRegions,
    diagnostics: graph.diagnostics,
  };
}

// A fanout net (one source, several sinks) shares the same declared name
// across every branch — labeling every single branch would just repeat the
// same text several times over. Only the first branch (by edge id, so the
// choice is stable across rebuilds) carries the label; the rest carry none.
function assignEdgeNetLabels(
  edges: DiagramEdge[],
  nodesById: Map<string, DiagramNode>,
): Map<string, string> {
  const labelByEdgeId = new Map<string, string>();
  const labeledNetKeys = new Set<string>();
  const sorted = [...edges].sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of sorted) {
    const netKey = edgeNetKey(edge);
    if (labeledNetKeys.has(netKey)) continue;
    labeledNetKeys.add(netKey);
    const label = edgeDeclaredNetLabel(edge, nodesById);
    if (label) {
      labelByEdgeId.set(edge.id, label);
    }
  }
  return labelByEdgeId;
}

// A node's own displayed title can already say everything a name would
// (e.g. an interface instance's block title is its instance name),
// independently of whatever the specific connected port happens to be
// called — so both are checked, not just whichever one exists.
function nodeOwnNames(
  nodeId: string,
  portId: string | undefined,
  nodesById: Map<string, DiagramNode>,
): Set<string> {
  const names = new Set<string>();
  const node = nodesById.get(nodeId);
  if (!node) return names;
  if (node.label) names.add(node.label);
  const portName = portId ? node.ports.find((port) => port.id === portId)?.name : undefined;
  if (portName) names.add(portName);
  return names;
}

// An ordinary (uncut) wire has no label by default — its identity is already
// visible at both ends. But when the net's actual SV-declared name (e.g. an
// explicit `wire x;` in an alias chain) differs from what's shown at *both*
// its source and target endpoints, that name would otherwise be invisible
// anywhere in the diagram, so it's worth surfacing directly on the wire.
function edgeDeclaredNetLabel(
  edge: DiagramEdge,
  nodesById: Map<string, DiagramNode>,
): string | undefined {
  const declaredNetName = edge.metadata?.declaredNetName;
  if (!declaredNetName) {
    return undefined;
  }

  const ownNames = new Set([
    ...nodeOwnNames(edge.source, edge.sourcePort, nodesById),
    ...nodeOwnNames(edge.target, edge.targetPort, nodesById),
  ]);
  if (ownNames.has(declaredNetName)) {
    return undefined;
  }

  return declaredNetName;
}

// The alias popover exists to surface identities a chain passed through that
// aren't shown anywhere else in the diagram. A name that merely repeats one
// of this exact edge's own two endpoints (already visible as the block/port
// at that end) tells the viewer nothing new, so it's dropped from the list —
// same reasoning as `edgeDeclaredNetLabel` applies to the primary label.
function visibleAliasNames(
  aliasNames: string[] | undefined,
  edge: { source: string; sourcePort?: string; target: string; targetPort?: string },
  nodesById: Map<string, DiagramNode>,
): string[] | undefined {
  if (!aliasNames || aliasNames.length === 0) return aliasNames;
  const ownNames = new Set([
    ...nodeOwnNames(edge.source, edge.sourcePort, nodesById),
    ...nodeOwnNames(edge.target, edge.targetPort, nodesById),
  ]);
  const filtered = aliasNames.filter((name) => !ownNames.has(name));
  return filtered.length > 0 ? filtered : undefined;
}

interface RegionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const REGION_INSET = diagramSizing.gridSize * 2;
const REGION_LABEL_BAND = diagramSizing.gridSize;
const REGION_TOP_INSET = REGION_INSET + REGION_LABEL_BAND;
const REGION_MIN_WIDTH = diagramSizing.gridSize * 8;
const REGION_MIN_HEIGHT = diagramSizing.gridSize * 5;
const REGION_GAP = diagramSizing.gridSize;

function packGenerateRegionSiblings(
  regions: GenerateRegion[],
  positionedNodes: PositionedNode[],
  moduleLayout: SavedModuleLayout,
): { nodes: PositionedNode[]; movedNodeIds: Set<string> } {
  if (regions.length === 0) {
    return { nodes: positionedNodes, movedNodeIds: new Set() };
  }

  const nodes = positionedNodes.map((node) => ({ ...node, position: { ...node.position } }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const movedNodeIds = new Set<string>();
  const rootGroups = siblingGroupsByParent(regions);

  for (let pass = 0; pass < regions.length; pass += 1) {
    const positionedRegions = positionGenerateRegions(regions, nodes, moduleLayout);
    const positionedById = new Map(positionedRegions.map((region) => [region.id, region]));
    let shifted = false;

    for (const group of rootGroups) {
      let cursorY: number | undefined;
      for (const region of group) {
        const positioned = positionedById.get(region.id);
        if (!positioned) continue;

        if (
          cursorY !== undefined &&
          positioned.bounds.y < cursorY &&
          canAutoShiftRegion(region, regions, moduleLayout)
        ) {
          const dy =
            Math.ceil((cursorY - positioned.bounds.y) / diagramSizing.gridSize) *
            diagramSizing.gridSize;
          if (dy > 0) {
            for (const nodeId of generateDescendantNodeIds(region, regions)) {
              const node = nodeById.get(nodeId);
              if (!node) continue;
              node.position = {
                x: node.position.x,
                y: snapToGrid(node.position.y + dy, node.kind, structRole(node)),
              };
              movedNodeIds.add(node.id);
            }
            shifted = true;
          }
        }

        const shiftedRegion = shifted
          ? positionGenerateRegions(regions, nodes, moduleLayout).find(
              (candidate) => candidate.id === region.id,
            )
          : positioned;
        cursorY = Math.max(
          cursorY ?? Number.NEGATIVE_INFINITY,
          (shiftedRegion ?? positioned).bounds.y +
            (shiftedRegion ?? positioned).bounds.height +
            REGION_GAP,
        );
      }
    }

    if (!shifted) break;
  }

  return { nodes, movedNodeIds };
}

function edgeTouchesMovedNode(edge: DiagramEdge, movedNodeIds: Set<string>): boolean {
  return movedNodeIds.has(edge.source) || movedNodeIds.has(edge.target);
}

function siblingGroupsByParent(regions: GenerateRegion[]): GenerateRegion[][] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const childrenByParent = new Map<string, GenerateRegion[]>();
  for (const region of [...regions].sort(compareGenerateRegions)) {
    const parent =
      region.parentRegionId && byId.has(region.parentRegionId) ? region.parentRegionId : '';
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(region);
    childrenByParent.set(parent, siblings);
  }

  return Array.from(childrenByParent.values()).flatMap((children) =>
    groupRegionsBySibling(children),
  );
}

function canAutoShiftRegion(
  region: GenerateRegion,
  regions: GenerateRegion[],
  moduleLayout: SavedModuleLayout,
): boolean {
  if (moduleLayout.regions?.[region.id]?.fixed) return false;
  const nodeIds = generateDescendantNodeIds(region, regions);
  return nodeIds.length > 0 && nodeIds.every((nodeId) => !moduleLayout.nodes[nodeId]?.fixed);
}

function generateDescendantNodeIds(region: GenerateRegion, regions: GenerateRegion[]): string[] {
  const ids = new Set(region.nodeIds ?? []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of regions) {
      if (!candidate.parentRegionId) continue;
      if (ids.size === 0 && candidate.parentRegionId !== region.id) continue;
      let parent: string | undefined = candidate.parentRegionId;
      let isDescendant = parent === region.id;
      while (!isDescendant && parent) {
        const parentRegion = regions.find((item) => item.id === parent);
        parent = parentRegion?.parentRegionId;
        isDescendant = parent === region.id;
      }
      if (!isDescendant) continue;
      for (const nodeId of candidate.nodeIds ?? []) {
        if (!ids.has(nodeId)) {
          ids.add(nodeId);
          changed = true;
        }
      }
    }
  }
  return Array.from(ids);
}

function positionGenerateRegions(
  regions: GenerateRegion[],
  positionedNodes: PositionedNode[],
  moduleLayout: SavedModuleLayout,
  nativeRegionBounds: Map<string, RegionBounds> = new Map(),
): PositionedGenerateRegion[] {
  if (regions.length === 0) return [];

  const sorted = [...regions].sort(compareGenerateRegions);
  const byId = new Map(sorted.map((region) => [region.id, region]));
  const childrenByParent = new Map<string, GenerateRegion[]>();
  for (const region of sorted) {
    const key =
      region.parentRegionId && byId.has(region.parentRegionId) ? region.parentRegionId : '';
    const children = childrenByParent.get(key) ?? [];
    children.push(region);
    childrenByParent.set(key, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareGenerateRegions);
  }

  const nodeById = new Map(positionedNodes.map((node) => [node.id, node]));
  const graphBounds = boundsForPositionedNodes(positionedNodes) ?? {
    x: 0,
    y: 0,
    width: diagramSizing.nodeWidth,
    height: diagramSizing.nodeHeight,
  };

  if (nativeRegionBounds.size > 0) {
    const visualRegionBounds = computeVisualGenerateRegionBounds(
      sorted,
      childrenByParent,
      nodeById,
      graphBounds,
      nativeRegionBounds,
      moduleLayout.regions,
    );
    const result = sorted.map((region, index): PositionedGenerateRegion => {
      const nodeIds = region.nodeIds ?? [];
      const fallbackBounds =
        boundsForRegionNodes(nodeIds, nodeById) ??
        snapRegionBounds({
          x: graphBounds.x + graphBounds.width + diagramSizing.columnGap,
          y: graphBounds.y + index * (REGION_MIN_HEIGHT + REGION_GAP),
          width: REGION_MIN_WIDTH,
          height: REGION_MIN_HEIGHT,
        });
      const saved = moduleLayout.regions?.[region.id];
      const autoBounds =
        visualRegionBounds.get(region.id) ??
        snapRegionBounds(nativeRegionBounds.get(region.id) ?? fallbackBounds);
      const bounds = saved ? expandSavedRegionBounds(saved, autoBounds) : autoBounds;
      return {
        ...region,
        nodeIds,
        edgeIds: region.edgeIds,
        bounds,
        fixed: saved?.fixed,
        stale: saved?.stale,
      };
    });

    return annotateGenerateRegionWarnings(result, positionedNodes);
  }

  const computed = new Map<string, PositionedGenerateRegion>();
  const rootGroups = groupRegionsBySibling(childrenByParent.get('') ?? []);
  let rootX = snapToGrid(graphBounds.x + graphBounds.width + diagramSizing.columnGap);
  const rootY = snapToGrid(graphBounds.y);

  for (const group of rootGroups) {
    let cursorY = rootY;
    let groupWidth = REGION_MIN_WIDTH;
    for (const region of group) {
      const positioned = layoutRegion(region, rootX, cursorY);
      computed.set(region.id, positioned);
      cursorY = positioned.bounds.y + positioned.bounds.height + REGION_GAP;
      groupWidth = Math.max(groupWidth, positioned.bounds.width);
    }
    rootX += groupWidth + REGION_GAP * 2;
  }

  const result = sorted
    .map((region) => computed.get(region.id))
    .filter((region): region is PositionedGenerateRegion => region !== undefined);

  return annotateGenerateRegionWarnings(result, positionedNodes);

  function layoutRegion(region: GenerateRegion, x: number, y: number): PositionedGenerateRegion {
    const existing = computed.get(region.id);
    if (existing) return existing;

    const nodeIds = region.nodeIds ?? [];
    const tightNodeBounds = tightBoundsForRegionNodes(nodeIds, nodeById);

    // Lay out child regions first — arms position themselves by their own nodes, so a
    // wrapper (no direct nodes) hugs the union of its children rather than a fallback slot.
    const childGroups = groupRegionsBySibling(childrenByParent.get(region.id) ?? []);
    const childRects: RegionBounds[] = [];
    const stackX = (tightNodeBounds?.x ?? x) + REGION_INSET;
    let stackCursorY = (tightNodeBounds?.y ?? y) + REGION_INSET;
    for (const group of childGroups) {
      let groupCursorY = stackCursorY;
      for (const child of group) {
        const childRegion = layoutRegion(child, stackX, groupCursorY);
        computed.set(child.id, childRegion);
        childRects.push(childRegion.bounds);
        groupCursorY = childRegion.bounds.y + childRegion.bounds.height + REGION_GAP;
      }
      stackCursorY = groupCursorY;
    }

    const contentRects: RegionBounds[] = [];
    if (tightNodeBounds) contentRects.push(tightNodeBounds);
    contentRects.push(...childRects);
    const contentBounds: RegionBounds =
      contentRects.length > 0
        ? expandRegionContentBounds(unionBounds(contentRects))
        : snapRegionBounds({ x, y, width: REGION_MIN_WIDTH, height: REGION_MIN_HEIGHT });

    const saved = moduleLayout.regions?.[region.id];
    const autoBounds = snapRegionBounds(contentBounds);
    const bounds = saved ? expandSavedRegionBounds(saved, autoBounds) : autoBounds;

    const positioned: PositionedGenerateRegion = {
      ...region,
      nodeIds,
      edgeIds: region.edgeIds,
      bounds,
      fixed: saved?.fixed,
      stale: saved?.stale,
    };
    computed.set(region.id, positioned);
    return positioned;
  }
}

function compareGenerateRegions(a: GenerateRegion, b: GenerateRegion): number {
  if ((a.siblingGroupId || a.id) === (b.siblingGroupId || b.id)) {
    const aArm = a.armIndex ?? Number.MAX_SAFE_INTEGER;
    const bArm = b.armIndex ?? Number.MAX_SAFE_INTEGER;
    if (aArm !== bArm) return aArm - bArm;
  }

  const aLine = a.source?.startLine ?? a.bodySource?.startLine ?? Number.MAX_SAFE_INTEGER;
  const bLine = b.source?.startLine ?? b.bodySource?.startLine ?? Number.MAX_SAFE_INTEGER;
  if (aLine !== bLine) return aLine - bLine;
  const aCol = a.source?.startColumn ?? a.bodySource?.startColumn ?? 0;
  const bCol = b.source?.startColumn ?? b.bodySource?.startColumn ?? 0;
  if (aCol !== bCol) return aCol - bCol;
  return (a.armIndex ?? 0) - (b.armIndex ?? 0) || a.id.localeCompare(b.id);
}

function groupRegionsBySibling(regions: GenerateRegion[]): GenerateRegion[][] {
  const groups: GenerateRegion[][] = [];
  const groupById = new Map<string, GenerateRegion[]>();
  for (const region of regions) {
    const key = region.siblingGroupId || region.id;
    let group = groupById.get(key);
    if (!group) {
      group = [];
      groupById.set(key, group);
      groups.push(group);
    }
    group.push(region);
  }
  for (const group of groups) {
    group.sort(compareGenerateRegions);
  }
  return groups;
}

function computeVisualGenerateRegionBounds(
  sortedRegions: GenerateRegion[],
  childrenByParent: Map<string, GenerateRegion[]>,
  nodeById: Map<string, PositionedNode>,
  graphBounds: RegionBounds,
  nativeRegionBounds: Map<string, RegionBounds>,
  savedRegions: SavedModuleLayout['regions'],
): Map<string, RegionBounds> {
  const computed = new Map<string, RegionBounds>();

  const compute = (region: GenerateRegion, index: number): RegionBounds => {
    const existing = computed.get(region.id);
    if (existing) return existing;

    const contentBounds: RegionBounds[] = [];
    const nodeBounds = tightBoundsForRegionNodes(region.nodeIds ?? [], nodeById);
    if (nodeBounds) {
      contentBounds.push(nodeBounds);
    }
    for (const child of childrenByParent.get(region.id) ?? []) {
      contentBounds.push(compute(child, index));
    }

    const autoBounds =
      contentBounds.length > 0
        ? expandRegionContentBounds(unionBounds(contentBounds))
        : snapRegionBounds(
            nativeRegionBounds.get(region.id) ?? {
              x: graphBounds.x + graphBounds.width + diagramSizing.columnGap,
              y: graphBounds.y + index * (REGION_MIN_HEIGHT + REGION_GAP),
              width: REGION_MIN_WIDTH,
              height: REGION_MIN_HEIGHT,
            },
          );
    // Fold in a resized/moved region's saved bounds so a parent (e.g. a generate block)
    // grows to keep surrounding an arm that the user has enlarged past its auto size.
    const saved = savedRegions?.[region.id];
    const bounds = saved ? expandSavedRegionBounds(saved, autoBounds) : autoBounds;
    computed.set(region.id, bounds);
    return bounds;
  };

  sortedRegions.forEach((region, index) => compute(region, index));
  return computed;
}

function boundsForRegionNodes(
  nodeIds: string[],
  nodeById: Map<string, PositionedNode>,
): RegionBounds | undefined {
  const bounds = tightBoundsForRegionNodes(nodeIds, nodeById);
  return bounds ? expandRegionContentBounds(bounds) : undefined;
}

function tightBoundsForRegionNodes(
  nodeIds: string[],
  nodeById: Map<string, PositionedNode>,
): RegionBounds | undefined {
  const bounds: RegionBounds = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    width: 0,
    height: 0,
  };
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const size = resolvedNodeDimensions(node);
    bounds.x = Math.min(bounds.x, node.position.x);
    bounds.y = Math.min(bounds.y, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }

  if (!Number.isFinite(bounds.x)) return undefined;

  return {
    x: bounds.x,
    y: bounds.y,
    width: maxX - bounds.x,
    height: maxY - bounds.y,
  };
}

function expandRegionContentBounds(bounds: RegionBounds): RegionBounds {
  return snapRegionBounds({
    x: bounds.x - REGION_INSET,
    y: bounds.y - REGION_INSET,
    width: bounds.width + REGION_INSET * 2,
    height: bounds.height + REGION_INSET * 2,
  });
}

function boundsForPositionedNodes(nodes: PositionedNode[]): RegionBounds | undefined {
  if (nodes.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const size = resolvedNodeDimensions(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// A module's own top-level I/O ports that lost every edge to a first-open
// cut (register clock/reset, or any other declared net) have nothing left to
// place them relative to, so ELK just drops them wherever its isolated-node
// heuristic lands — usually not near where they'd read best. As a one-time
// default arrangement (see the `isPristineLayout` gate at the call site),
// stack them into two columns flanking the rest of the design instead: every
// disconnected source-direction port on the left, every disconnected
// sink-direction port on the right. A port that still carries at least one
// surviving edge is left exactly where ELK placed it.
function columnizeFullyCutBoundaryPorts(
  designModule: DesignModule,
  activeCuts: Map<string, ActiveNetCut>,
  positioned: PositionedNode[],
): PositionedNode[] {
  const activeCutKeys = new Set(activeCuts.keys());
  const edgesByNodeId = new Map<string, DiagramEdge[]>();
  for (const edge of designModule.edges) {
    for (const nodeId of [edge.source, edge.target]) {
      const touching = edgesByNodeId.get(nodeId) ?? [];
      touching.push(edge);
      edgesByNodeId.set(nodeId, touching);
    }
  }
  const isFullyCut = (nodeId: string): boolean => {
    const touching = edgesByNodeId.get(nodeId);
    return (
      Boolean(touching?.length) && touching!.every((edge) => activeCutKeys.has(edgeNetKey(edge)))
    );
  };

  const detached = positioned.filter((node) => node.kind === 'port' && isFullyCut(node.id));
  if (detached.length === 0) {
    return positioned;
  }

  const detachedIds = new Set(detached.map((node) => node.id));
  const survivingBodyBounds = boundsForPositionedNodes(
    positioned.filter((node) => !detachedIds.has(node.id)),
  );
  // When every node in the module is a fully-cut boundary port (a pure
  // pass-through with nothing left uncut to anchor against), there's no
  // surviving body to flank. Collapse the anchor to a zero-width point at
  // the detached ports' own ELK center instead of reserving body-sized
  // space that's no longer occupied by anything.
  const bodyBounds =
    survivingBodyBounds ??
    (() => {
      const allBounds = boundsForPositionedNodes(positioned);
      return allBounds && { ...allBounds, x: allBounds.x + allBounds.width / 2, width: 0 };
    })();
  if (!bodyBounds) {
    return positioned;
  }

  const sideFor = (node: DiagramNode): 'input' | 'output' =>
    node.ports[0]?.direction === 'output' ? 'output' : 'input';
  const detachedSideById = new Map(detached.map((node) => [node.id, sideFor(node)]));
  const bySide = (side: 'input' | 'output') =>
    detached.filter((node) => sideFor(node) === side).sort((a, b) => a.position.y - b.position.y);

  const rowGap = diagramSizing.sameLayerNodeSeparation;
  const stack = (
    nodes: PositionedNode[],
    anchorX: (width: number) => number,
  ): Map<string, { x: number; y: number }> => {
    const result = new Map<string, { x: number; y: number }>();
    let y = bodyBounds.y;
    for (const node of nodes) {
      const size = resolvedNodeDimensions(node);
      result.set(node.id, snapPosition({ x: anchorX(size.width), y }, node.kind, structRole(node)));
      y += size.height + rowGap;
    }
    return result;
  };

  const pairGapFor = (cut: SavedNetCut): number => {
    const labelWidth = diagramNodeDimensions({
      id: 'cut-label-column-gap',
      kind: 'netLabel',
      label: cut.label,
      ports: [],
    }).width;
    return diagramSizing.edgeLeadLength * 2 + labelWidth * 2 + diagramSizing.gridSize;
  };

  let inputGap = survivingBodyBounds ? diagramSizing.columnGap : 0;
  let outputGap = diagramSizing.columnGap;
  for (const { cut, edges } of activeCuts.values()) {
    const sourceSide = detachedSideById.get(cut.source.nodeId);
    for (const edge of edges) {
      const targetSide = detachedSideById.get(edge.target);
      const pairGap = pairGapFor(cut);
      if (!survivingBodyBounds && sourceSide && targetSide && sourceSide !== targetSide) {
        // With no body, the two boundary-port columns face each other
        // directly. Reserve both labels, both leads, and one clear grid
        // between the dangling ends as part of the column gap itself.
        outputGap = Math.max(outputGap, pairGap);
      } else if (survivingBodyBounds && sourceSide === 'input' && !targetSide) {
        inputGap = Math.max(inputGap, pairGap);
      } else if (survivingBodyBounds && !sourceSide && targetSide === 'output') {
        outputGap = Math.max(outputGap, pairGap);
      }
    }
  }

  // A real body needs clearance on both sides. With no body, there is only
  // one relationship left — input column to output column — so reserve one
  // column gap total instead of two gaps around an empty point.
  const overrides = new Map([
    ...stack(bySide('input'), (width) => bodyBounds.x - inputGap - width),
    ...stack(bySide('output'), () => bodyBounds.x + bodyBounds.width + outputGap),
  ]);

  return positioned.map((node) => {
    const override = overrides.get(node.id);
    return override ? { ...node, position: override } : node;
  });
}

function unionBounds(boundsList: RegionBounds[]): RegionBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const bounds of boundsList) {
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function snapRegionBounds(bounds: RegionBounds): RegionBounds {
  const x = Math.floor(bounds.x / diagramSizing.gridSize) * diagramSizing.gridSize;
  const y = Math.floor(bounds.y / diagramSizing.gridSize) * diagramSizing.gridSize;
  const right =
    Math.ceil((bounds.x + Math.max(REGION_MIN_WIDTH, bounds.width)) / diagramSizing.gridSize) *
    diagramSizing.gridSize;
  const bottom =
    Math.ceil((bounds.y + Math.max(REGION_MIN_HEIGHT, bounds.height)) / diagramSizing.gridSize) *
    diagramSizing.gridSize;
  return {
    x,
    y,
    width: Math.max(REGION_MIN_WIDTH, right - x),
    height: Math.max(REGION_MIN_HEIGHT, bottom - y),
  };
}

function expandSavedRegionBounds(saved: RegionBounds, autoBounds: RegionBounds): RegionBounds {
  const minX = Math.min(saved.x, autoBounds.x);
  const minY = Math.min(saved.y, autoBounds.y);
  const maxX = Math.max(saved.x + saved.width, autoBounds.x + autoBounds.width);
  const maxY = Math.max(saved.y + saved.height, autoBounds.y + autoBounds.height);
  return snapRegionBounds({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  });
}

interface ActiveNetCut {
  cut: SavedNetCut;
  edges: DiagramEdge[];
}

function activeNetCuts(
  designModule: DesignModule,
  moduleLayout: SavedModuleLayout,
): Map<string, ActiveNetCut> {
  const active = new Map<string, ActiveNetCut>();

  for (const [netKey, cut] of Object.entries(moduleLayout.netCuts ?? {})) {
    const sourceNode = designModule.nodes.find((node) => node.id === cut.source.nodeId);
    if (
      !sourceNode ||
      (cut.source.portId &&
        !sourceNode.ports.some(
          (port) => port.id === cut.source.portId || port.name === cut.source.portId,
        ))
    ) {
      continue;
    }

    const edges = designModule.edges.filter(
      (edge) =>
        edgeNetKey(edge) === netKey &&
        edge.source === cut.source.nodeId &&
        edge.sourcePort === cut.source.portId,
    );
    if (edges.length > 0) {
      active.set(netKey, { cut, edges });
    }
  }

  return active;
}

function buildNetCutProjection(
  designModule: DesignModule,
  moduleLayout: SavedModuleLayout,
  activeCuts: Map<string, ActiveNetCut>,
  positionedNodes: PositionedNode[],
): { nodes: PositionedNode[]; edges: DiagramEdge[] } {
  const nodes: PositionedNode[] = [];
  const edges: DiagramEdge[] = [];
  const deferredNodeIds = new Set<string>();
  const endpointByLabelId = new Map<string, string>();
  const nodesById = new Map<string, DiagramNode>(positionedNodes.map((node) => [node.id, node]));
  const nodePositions = new Map(positionedNodes.map((node) => [node.id, node.position]));

  // Mutually exclusive generate arms can each carry their own edge to the
  // same declared target (e.g. two case arms both driving the module's
  // output) — every such edge still gets its own cut, same as any other
  // declared net, so each arm's driver keeps a dead-end source label. But
  // stacking a sink cut-net-end from every arm onto that one shared target
  // port adds no extra meaning over a single one, so only the first cut to
  // reach a given (target, label) pair gets a sink label/stub.
  const seenSinkTargets = new Set<string>();

  // Deterministic across nets too: which arm's sink label "wins" a shared
  // target shouldn't depend on Map insertion order, so sort net entries by
  // their own first (sorted) edge id, same tie-break used within a net.
  //
  // The target port a shared sink dedupes onto is always driven by exactly
  // one of the mutually exclusive arms — never none of them — so the
  // surviving label must come from whichever arm is actually elaborated
  // active, not whichever arm's edge id happens to sort first. An inactive
  // arm only wins when every arm reaching that target is inactive (dead
  // code some other pass should be flagging, not this dedupe).
  const netIsActive = (edges: DiagramEdge[]) =>
    edges.some((edge) => edge.metadata?.generateActiveState !== 'inactive');
  const sortedActiveCuts = [...activeCuts].sort(([, a], [, b]) => {
    const aActive = netIsActive(a.edges) ? 0 : 1;
    const bActive = netIsActive(b.edges) ? 0 : 1;
    if (aActive !== bActive) {
      return aActive - bActive;
    }
    const aFirst = [...a.edges].sort((x, y) => x.id.localeCompare(y.id))[0]?.id ?? '';
    const bFirst = [...b.edges].sort((x, y) => x.id.localeCompare(y.id))[0]?.id ?? '';
    return aFirst.localeCompare(bFirst);
  });

  for (const [netKey, { cut, edges: cutEdges }] of sortedActiveCuts) {
    const sortedCutEdges = [...cutEdges].sort((a, b) => a.id.localeCompare(b.id));
    const firstEdge = sortedCutEdges[0];
    if (!firstEdge) {
      continue;
    }
    // The default label (whatever it was right when the net was cut) is
    // still the net's legitimate name — only a label the user has actively
    // typed something else into renders differently.
    const isRenamed = cut.defaultLabel !== undefined && cut.label !== cut.defaultLabel;

    const sourceLead = renderedLeadPoint(
      cut.source.nodeId,
      cut.source.portId,
      nodesById,
      nodePositions,
      true,
      'source',
    );
    if (!sourceLead) {
      continue;
    }

    const sourceNode = nodesById.get(cut.source.nodeId);
    const isSourceStacked = sourceNode ? nodeIsArrayNode(sourceNode) : false;

    const sourceLabelId = cutLabelNodeId(netKey, 'source');
    if (cut.deferLabelPlacement) {
      deferredNodeIds.add(sourceLabelId);
    }
    const sourceHandleSide = oppositeHandleSide(elkSideToHandleSide(sourceLead.side));
    const sourceLabelNode = makeCutLabelNode(
      sourceLabelId,
      cut.label,
      designModule.name,
      {
        netKey,
        role: 'source',
        align: 'end',
        originalEdgeId: firstEdge.id,
        handleSide: sourceHandleSide,
        edgeStyle: cutLabelEdgeStyle(firstEdge, nodesById),
        isSourceStacked,
        origin: cut.origin,
        isRenamed,
        aliasNames: visibleAliasNames(firstEdge.metadata?.aliasNames, firstEdge, nodesById),
      },
      moduleLayout,
      labelPositionForHandlePoint(sourceLead.point, sourceHandleSide, cut.label),
      firstEdge,
    );
    nodes.push(sourceLabelNode);
    endpointByLabelId.set(sourceLabelId, endpointKey(cut.source.nodeId, cut.source.portId));

    edges.push(
      makeCutStubEdge({
        id: cutStubEdgeId(netKey, 'source'),
        template: firstEdge,
        source: cut.source.nodeId,
        sourcePort: cut.source.portId,
        target: sourceLabelId,
        targetPort: 'cut',
        netKey,
        role: 'source',
        originalEdgeId: firstEdge.id,
        moduleLayout,
      }),
    );

    for (const edge of sortedCutEdges) {
      const sinkDedupeKey = `${endpointKey(edge.target, edge.targetPort)}::${cut.label}`;
      if (seenSinkTargets.has(sinkDedupeKey)) {
        continue;
      }

      const targetLead = renderedLeadPoint(
        edge.target,
        edge.targetPort,
        nodesById,
        nodePositions,
        true,
        'target',
      );
      if (!targetLead) {
        continue;
      }
      seenSinkTargets.add(sinkDedupeKey);

      const sinkLabelId = cutLabelNodeId(netKey, 'sink', edge.id);
      if (cut.deferLabelPlacement) {
        deferredNodeIds.add(sinkLabelId);
      }
      const sinkHandleSide = oppositeHandleSide(elkSideToHandleSide(targetLead.side));
      const sinkLabelNode = makeCutLabelNode(
        sinkLabelId,
        cut.label,
        designModule.name,
        {
          netKey,
          role: 'sink',
          align: 'start',
          originalEdgeId: edge.id,
          handleSide: sinkHandleSide,
          edgeStyle: cutLabelEdgeStyle(edge, nodesById),
          isSourceStacked,
          origin: cut.origin,
          isRenamed,
          aliasNames: visibleAliasNames(edge.metadata?.aliasNames, edge, nodesById),
        },
        moduleLayout,
        labelPositionForHandlePoint(targetLead.point, sinkHandleSide, cut.label),
        edge,
      );
      nodes.push(sinkLabelNode);
      endpointByLabelId.set(sinkLabelId, endpointKey(edge.target, edge.targetPort));

      edges.push(
        makeCutStubEdge({
          id: cutStubEdgeId(netKey, 'sink', edge.id),
          template: edge,
          source: sinkLabelId,
          sourcePort: 'cut',
          target: edge.target,
          targetPort: edge.targetPort,
          netKey,
          role: 'sink',
          originalEdgeId: edge.id,
          moduleLayout,
        }),
      );
    }
  }

  const resolvedNodes = resolveCutLabelCollisions(
    nodes.filter((node) => !deferredNodeIds.has(node.id)),
    positionedNodes,
    endpointByLabelId,
  );
  const resolvedById = new Map(resolvedNodes.map((node) => [node.id, node]));
  return {
    // A manual cut should look exactly like a wire split in place. Its ends
    // therefore stay at their canonical port-lead positions and do not act as
    // blockers for already-placed labels until Auto Layout activates them.
    nodes: nodes.map((node) => resolvedById.get(node.id) ?? node),
    edges,
  };
}

interface NodeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodeBounds(node: PositionedNode, position = node.position): NodeBounds {
  const dimensions = resolvedNodeDimensions(node);
  return { ...position, width: dimensions.width, height: dimensions.height };
}

function boundsOverlap(a: NodeBounds, b: NodeBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function resolveCutLabelCollisions(
  nodes: PositionedNode[],
  positionedNodes: PositionedNode[],
  endpointByLabelId: Map<string, string>,
): PositionedNode[] {
  // Preserve user-pinned labels. For label/label collisions, keep distinct
  // endpoints level with their ports while staggering labels that share one
  // endpoint across its axis. If a canonical position hits a design node,
  // search both axes for the nearest clear grid position.
  const resolved = new Map<string, PositionedNode>();
  const designBounds = positionedNodes.map((node) => nodeBounds(node));
  const occupiedLabels: Array<NodeBounds & { id: string }> = [];
  const ordered = [...nodes].sort((a, b) => {
    if (Boolean(a.fixed) !== Boolean(b.fixed)) return a.fixed ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  for (const node of ordered) {
    const overlaps = (position: { x: number; y: number }, occupied: NodeBounds[]) => {
      const bounds = nodeBounds(node, position);
      return occupied.some((other) => boundsOverlap(bounds, other));
    };
    const isBlocked = (position: { x: number; y: number }) =>
      overlaps(position, designBounds) || overlaps(position, occupiedLabels);

    let position = node.position;
    if (!node.fixed && isBlocked(position)) {
      const side = node.metadata?.cutNet?.handleSide;
      const crossAxisIsVertical = side === 'left' || side === 'right';
      const overlapsDesignNode = overlaps(position, designBounds);
      const maxOffset = diagramSizing.gridSize * (designBounds.length + occupiedLabels.length + 8);
      const axisCandidates = (offset: number, alongHandle: boolean) => {
        const moveVertically = alongHandle ? !crossAxisIsVertical : crossAxisIsVertical;
        return [1, -1].map((direction) =>
          moveVertically
            ? { x: node.position.x, y: node.position.y + offset * direction }
            : { x: node.position.x + offset * direction, y: node.position.y },
        );
      };
      const firstClearAlongAxis = (alongHandle: boolean) => {
        for (
          let offset = diagramSizing.gridSize;
          offset <= maxOffset;
          offset += diagramSizing.gridSize
        ) {
          const candidate = axisCandidates(offset, alongHandle).find(
            (position) => !isBlocked(position),
          );
          if (candidate) return candidate;
        }
        return undefined;
      };

      if (!overlapsDesignNode) {
        const endpoint = endpointByLabelId.get(node.id);
        const sharesEndpoint =
          endpoint !== undefined &&
          occupiedLabels.some(
            (bounds) =>
              boundsOverlap(nodeBounds(node, node.position), bounds) &&
              endpointByLabelId.get(bounds.id) === endpoint,
          );
        // Labels on adjacent port rows commonly overlap even though there is
        // ample room farther out from the owning node. Keep each label on its
        // port's axis before considering a cross-axis dogleg. Multiple labels
        // attached to the exact same endpoint have no distinct axes to
        // preserve, so stagger those across the endpoint instead.
        const preferHandleAxis = !sharesEndpoint;
        position =
          firstClearAlongAxis(preferHandleAxis) ??
          firstClearAlongAxis(!preferHandleAxis) ??
          position;
      } else {
        search: for (
          let offset = diagramSizing.gridSize;
          offset <= maxOffset;
          offset += diagramSizing.gridSize
        ) {
          const crossAxisCandidates = axisCandidates(offset, false);
          const handleAxisCandidates = axisCandidates(offset, true);
          for (const candidate of [...crossAxisCandidates, ...handleAxisCandidates]) {
            if (!isBlocked(candidate)) {
              position = candidate;
              break search;
            }
          }
        }
      }
    }

    const positioned = position === node.position ? node : { ...node, position };
    resolved.set(node.id, positioned);
    occupiedLabels.push({ ...nodeBounds(node, position), id: node.id });
  }

  return nodes.map((node) => resolved.get(node.id) ?? node);
}

function cutLabelNodeId(netKey: string, role: 'source' | 'sink', edgeId?: string): string {
  return role === 'source'
    ? `cut-label:${netKey}:source`
    : `cut-label:${netKey}:sink:${edgeId ?? ''}`;
}

function isCutLabelNodeId(id: string): boolean {
  return id.startsWith('cut-label:');
}

function isCutStubEdgeId(id: string): boolean {
  return id.startsWith('cut-stub:');
}

function cutStubEdgeId(netKey: string, role: 'source' | 'sink', edgeId?: string): string {
  return role === 'source'
    ? `cut-stub:${netKey}:source`
    : `cut-stub:${netKey}:sink:${edgeId ?? ''}`;
}

export function cutLabelEdgeStyle(
  edge: DiagramEdge,
  nodesById: Map<string, DiagramNode>,
): NonNullable<NonNullable<DiagramNode['metadata']>['cutNet']>['edgeStyle'] | undefined {
  const aggregate = edge.metadata?.aggregate;
  const isStacked = edge.isStacked === true;
  const thick = edgeIsThick(edge, nodesById.get(edge.source), nodesById.get(edge.target));
  if (!aggregate && !isStacked && !thick) {
    return undefined;
  }
  return {
    ...(aggregate ? { aggregate } : {}),
    ...(isStacked ? { isStacked } : {}),
    ...(thick ? { thick } : {}),
  };
}

function makeCutLabelNode(
  id: string,
  label: string,
  moduleName: string,
  cutNet: NonNullable<DiagramNode['metadata']>['cutNet'],
  moduleLayout: SavedModuleLayout,
  fallbackPosition: { x: number; y: number },
  template: DiagramEdge,
): PositionedNode {
  const saved = moduleLayout.nodes[id];
  // Only a *pinned* (fixed) save wins over the geometry-derived fallback — a
  // released/un-pinned save (e.g. an auto-layout hint) must keep tracking the
  // owning block's current lead point, exactly like a real node whose `fixed`
  // is false falls through to its freshly computed position instead of a
  // stale saved one.
  const position = saved?.fixed ? { x: saved.x, y: saved.y } : fallbackPosition;

  return {
    id,
    kind: 'netLabel',
    label,
    parentModule: moduleName,
    ports: [
      {
        id: 'cut',
        name: 'cut',
        direction: cutNet?.role === 'source' ? 'input' : 'output',
      },
    ],
    metadata: {
      cutNet,
      // A cut end on a wire that lives inside an inactive generate arm must
      // dim the same way the rest of that route does — otherwise the stub
      // label is the one piece of the wire left at full opacity.
      generateActiveState: template.metadata?.generateActiveState,
      generateRegionId: template.metadata?.generateRegionId,
    },
    position,
    fixed: saved?.fixed,
  };
}

function makeCutStubEdge({
  id,
  template,
  source,
  sourcePort,
  target,
  targetPort,
  netKey,
  role,
  originalEdgeId,
  moduleLayout,
}: {
  id: string;
  template: DiagramEdge;
  source: string;
  sourcePort?: string;
  target: string;
  targetPort?: string;
  netKey: string;
  role: 'source' | 'sink';
  originalEdgeId?: string;
  moduleLayout: SavedModuleLayout;
}): DiagramEdge {
  return {
    id,
    source,
    target,
    sourcePort,
    targetPort,
    signal: template.signal,
    width: template.width,
    isStacked: template.isStacked,
    sourceRange: template.sourceRange,
    metadata: {
      ...(template.metadata ?? {}),
      forceStraight: true,
      cutStub: {
        netKey,
        role,
        originalEdgeId,
      },
    },
    routePoints: moduleLayout.edges?.[id]?.routePoints,
  };
}

export function elkSideToHandleSide(side: ElkPortSide): 'left' | 'right' | 'top' | 'bottom' {
  if (side === 'WEST') return 'left';
  if (side === 'EAST') return 'right';
  if (side === 'NORTH') return 'top';
  return 'bottom';
}

function oppositeHandleSide(
  side: 'left' | 'right' | 'top' | 'bottom',
): 'left' | 'right' | 'top' | 'bottom' {
  if (side === 'left') return 'right';
  if (side === 'right') return 'left';
  if (side === 'top') return 'bottom';
  return 'top';
}

function labelPositionForHandlePoint(
  point: { x: number; y: number },
  handleSide: 'left' | 'right' | 'top' | 'bottom',
  label: string,
): { x: number; y: number } {
  const dimensions = diagramNodeDimensions({
    id: 'label',
    kind: 'netLabel',
    label,
    ports: [],
  });

  if (handleSide === 'left') {
    return { x: point.x, y: point.y - dimensions.height / 2 };
  }
  if (handleSide === 'right') {
    return { x: point.x - dimensions.width, y: point.y - dimensions.height / 2 };
  }
  if (handleSide === 'top') {
    return { x: point.x - dimensions.width / 2, y: point.y };
  }
  return { x: point.x - dimensions.width / 2, y: point.y - dimensions.height };
}

// A cut net's dangling end (a `netLabel` node) is never a node ELK lays out —
// its position is always re-derived from the owning port's rendered lead
// point after layout finishes (see makeCutLabelNode). Left alone, ELK has no
// idea that extra room needs to stay clear there, so a tightly packed row of
// released nodes can place a neighbor right on top of a label sticking out of
// the node behind it. Rather than making the label an independent ELK graph
// node — which would let ELK's automatic layering push it into a different
// layer than the port it belongs to — fold the label's own bounding box into
// the *owning* node's ELK margin on the side the label protrudes from, the
// same mechanism already used to reserve room for a port's wire lead. This
// keeps the label pinned to its port (same layer, deterministic offset) while
// still using its real footprint to keep ELK's spacing honest.
function netCutPortMargins(
  designModule: DesignModule,
  activeCuts: Map<string, ActiveNetCut>,
): Map<string, Map<string, { width: number; height: number }>> {
  const byNode = new Map<string, Map<string, { width: number; height: number }>>();
  const reserve = (nodeId: string, portId: string | undefined, label: string) => {
    if (!portId) return;
    const dimensions = diagramNodeDimensions({
      id: 'cut-label-margin',
      kind: 'netLabel',
      label,
      ports: [],
    });
    const byPort = byNode.get(nodeId) ?? new Map<string, { width: number; height: number }>();
    byPort.set(portId, dimensions);
    byNode.set(nodeId, byPort);
  };

  for (const { cut, edges: cutEdges } of activeCuts.values()) {
    reserve(cut.source.nodeId, cut.source.portId, cut.label);
    for (const edge of cutEdges) {
      reserve(edge.target, edge.targetPort, cut.label);
    }
  }

  return byNode;
}

async function autoLayoutMissingNodes(
  rawNodes: DiagramNode[],
  edges: DiagramEdge[],
  moduleLayout: SavedModuleLayout,
  generateRegions: GenerateRegion[] = [],
  netCutMargins: Map<string, Map<string, { width: number; height: number }>> = new Map(),
  sizeOverrides?: Record<string, { width: number; height: number }>,
): Promise<AutoLayoutResult> {
  const positions = new Map<string, { x: number; y: number }>();
  const routes = new Map<string, Array<{ x: number; y: number }>>();
  const regionBounds = new Map<string, RegionBounds>();
  const routePositions = new Map<string, { x: number; y: number }>();
  // ELK must place against each node's *rendered* box: a saved manual resize
  // (SavedNodeLayout.width/height) or a caller-supplied transient override
  // (e.g. an expanded instance's frame during Auto Layout — see
  // BuildViewModelOptions.elkSizeOverrides) grows the node past its
  // canonical size, and laying neighbors out against the canonical box would
  // place them underneath it. Annotated once here so every geometry
  // derivation below (ELK boxes, layout offsets, gap enforcement) agrees.
  const nodes = rawNodes.map((node) => {
    const override = sizeOverrides?.[node.id];
    if (override) {
      return { ...node, sizeOverride: { width: override.width, height: override.height } };
    }
    const saved = moduleLayout.nodes[node.id];
    if (saved?.width !== undefined && saved?.height !== undefined) {
      return { ...node, sizeOverride: { width: saved.width, height: saved.height } };
    }
    return node;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const elkEdgeNodesById = new Map(nodes.map((node) => [node.id, node]));
  if (nodes.length === 0 && generateRegions.length === 0) {
    return { positions, routes, regionBounds };
  }

  try {
    const elkModule = await import('elkjs/lib/elk.bundled.js');
    const Elk = elkModule.default;
    const elk = new Elk();
    const useCompoundGenerateLayout = canUseCompoundGenerateLayout(generateRegions, moduleLayout);
    const graph = await elk.layout({
      id: 'root',
      layoutOptions: nodePlacementLayoutOptions(useCompoundGenerateLayout),
      children: useCompoundGenerateLayout
        ? buildGenerateCompoundElkChildren(nodes, generateRegions, moduleLayout, {
            includeLeadMargins: true,
            netCutMargins,
          })
        : nodes.map((node) =>
            elkNodeForLayout(node, moduleLayout, {
              includeLeadMargins: true,
              useSavedPosition: true,
              extraPortMargins: netCutMargins.get(node.id),
            }),
          ),
      edges: buildNodePlacementElkEdges(edges, nodeIds, elkEdgeNodesById),
    });

    if (useCompoundGenerateLayout) {
      collectElkPositionsAndRegionBounds(graph, nodes, positions, regionBounds, netCutMargins);
    } else {
      for (const child of graph.children ?? []) {
        if (child.id && child.x !== undefined && child.y !== undefined) {
          const node = nodes.find((n) => n.id === child.id);
          // Must mirror the extraPortMargins passed when this same node's ELK
          // box was built above — otherwise a node with a net-cut-inflated
          // left/top margin would have its ELK-relative x/y de-offset by the
          // wrong (smaller) amount and visually drift.
          const offset = node
            ? elkNodeForDiagramNode(node, true, netCutMargins.get(node.id)).layoutOffset
            : { x: 0, y: 0 };
          positions.set(
            child.id,
            snapPosition(
              { x: child.x + offset.x, y: child.y + offset.y },
              node?.kind,
              node ? structRole(node) : undefined,
            ),
          );
        }
      }
    }
    alignSimpleLeafNodes(nodes, edges, positions, moduleLayout);
    if (!useCompoundGenerateLayout) {
      enforceMinimumBlockGaps(nodes, positions, moduleLayout);
      alignSimpleLeafNodes(nodes, edges, positions, moduleLayout);
    }

    const fixedRoutePositions = new Map<string, { x: number; y: number }>();
    for (const [index, node] of nodes.entries()) {
      const saved = moduleLayout.nodes[node.id];
      const fallback = defaultPosition(index, node.kind);
      const position = saved?.fixed
        ? { x: saved.x, y: saved.y }
        : (positions.get(node.id) ?? (saved ? { x: saved.x, y: saved.y } : undefined) ?? fallback);
      routePositions.set(node.id, position);
      fixedRoutePositions.set(node.id, position);
    }

    const routeLayoutOptions = routingLayoutOptions(useCompoundGenerateLayout);
    const routeChildren = useCompoundGenerateLayout
      ? buildGenerateCompoundElkChildren(nodes, generateRegions, moduleLayout, {
          includeLeadMargins: true,
          includeRoutingObstacleMargins: true,
          forceFixed: true,
          nodePositions: fixedRoutePositions,
          regionBounds,
          netCutMargins,
        })
      : nodes.map((node) =>
          elkNodeForLayout(node, moduleLayout, {
            includeLeadMargins: true,
            includeRoutingObstacleMargins: true,
            forceFixed: true,
            nodePositions: fixedRoutePositions,
            extraPortMargins: netCutMargins.get(node.id),
          }),
        );

    let routeGraph;
    try {
      routeGraph = await elk.layout({
        id: 'root',
        layoutOptions: routeLayoutOptions,
        children: routeChildren,
        edges: buildRoutingElkEdges(edges, nodeIds, elkEdgeNodesById),
      });
    } catch {
      // Hyperedge routing can fail in FIXED-position mode for some fan-out topologies
      // (e.g. a register Q port feeding multiple stacked mux inputs that ELK reversed
      // into forward edges). Retry with individual edges so each edge still gets a route.
      routeGraph = await elk.layout({
        id: 'root',
        layoutOptions: routeLayoutOptions,
        children: routeChildren,
        edges: buildNodePlacementElkEdges(edges, nodeIds, elkEdgeNodesById),
      });
    }

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const projectedRoutes = projectElkRoutes(routeGraph.edges ?? [], edges, nodesById);
    for (const [edgeId, route] of projectedRoutes) {
      if (!moduleLayout.edges?.[edgeId]?.routePoints) {
        const edge = edges.find((candidate) => candidate.id === edgeId);
        routes.set(
          edgeId,
          edge ? routeWithRenderedLeads(edge, route, nodesById, routePositions) : route,
        );
      }
    }
    for (const edge of edges) {
      if (!moduleLayout.edges?.[edge.id]?.routePoints && !routes.has(edge.id)) {
        const route = directRenderedLeadRoute(edge, nodesById, routePositions);
        if (route) {
          routes.set(edge.id, route);
        }
      }
    }
    repairSourceStems(edges, routes, nodesById, routePositions);
  } catch {
    return { positions, routes, regionBounds };
  }

  return { positions, routes, regionBounds };
}

const GENERATE_REGION_ELK_ID_PREFIX = 'generate-region:';

function generateRegionElkId(regionId: string): string {
  return `${GENERATE_REGION_ELK_ID_PREFIX}${regionId}`;
}

function generateRegionIdFromElkId(elkId: string): string | undefined {
  return elkId.startsWith(GENERATE_REGION_ELK_ID_PREFIX)
    ? elkId.slice(GENERATE_REGION_ELK_ID_PREFIX.length)
    : undefined;
}

function canUseCompoundGenerateLayout(
  regions: GenerateRegion[],
  moduleLayout: SavedModuleLayout,
): boolean {
  if (regions.length === 0) return false;
  if (Object.values(moduleLayout.nodes).some((node) => node.fixed)) return false;
  if (Object.values(moduleLayout.regions ?? {}).some((region) => region.fixed)) return false;
  return true;
}

function nodePlacementLayoutOptions(useCompoundGenerateLayout: boolean): Record<string, string> {
  const rootPaddingTop = useCompoundGenerateLayout
    ? diagramSizing.gridSize * 3
    : diagramSizing.gridSize;
  return {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': diagramSizing.sameLayerNodeSeparation.toString(),
    // Must stay a grid multiple: snapPosition() assumes grid-quantized raw
    // positions, and ELK's default component spacing (20) is not one, which
    // let adjacent disconnected nodes collapse to a 0px gap after snapping.
    'elk.spacing.componentComponent': diagramSizing.sameLayerNodeSeparation.toString(),
    'elk.layered.spacing.nodeNodeBetweenLayers': diagramSizing.minNodeSeparation.toString(),
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.interactive': 'true',
    'elk.layered.crossingMinimization.semiInteractive': 'true',
    'elk.layered.concentrateEdges': 'true',
    'elk.layered.improveHyperedgeRoutes': 'true',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.spacing.edgeNode': diagramSizing.gridSize.toString(),
    'elk.padding': `[top=${rootPaddingTop}, left=${diagramSizing.gridSize}, bottom=${diagramSizing.gridSize}, right=${diagramSizing.gridSize}]`,
    ...(useCompoundGenerateLayout ? compoundGenerateLayoutOptions() : {}),
  };
}

function routingLayoutOptions(useCompoundGenerateLayout: boolean): Record<string, string> {
  const rootPaddingTop = useCompoundGenerateLayout
    ? diagramSizing.gridSize * 3
    : diagramSizing.gridSize;
  return {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.interactive': 'true',
    'elk.layered.concentrateEdges': 'true',
    'elk.layered.improveHyperedgeRoutes': 'true',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.spacing.nodeNode': diagramSizing.sameLayerNodeSeparation.toString(),
    'elk.layered.spacing.nodeNodeBetweenLayers': diagramSizing.minNodeSeparation.toString(),
    'elk.layered.spacing.edgeNode': diagramSizing.gridSize.toString(),
    'elk.layered.spacing.edgeEdge': (diagramSizing.gridSize / 2).toString(),
    'elk.spacing.portPort': (diagramSizing.gridSize / 2).toString(),
    'elk.padding': `[top=${rootPaddingTop}, left=${diagramSizing.gridSize}, bottom=${diagramSizing.gridSize}, right=${diagramSizing.gridSize}]`,
    ...(useCompoundGenerateLayout ? compoundGenerateLayoutOptions() : {}),
  };
}

function compoundGenerateLayoutOptions(): Record<string, string> {
  return {
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    'elk.layered.mergeHierarchyEdges': 'true',
  };
}

function generateRegionLayoutOptions(forceFixed: boolean): Record<string, string> {
  return {
    'elk.padding': `[top=${REGION_TOP_INSET}, left=${REGION_INSET}, bottom=${REGION_INSET}, right=${REGION_INSET}]`,
    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
    'elk.nodeSize.minimum': `(${REGION_MIN_WIDTH},${REGION_MIN_HEIGHT})`,
    ...(forceFixed
      ? {
          'elk.position': 'FIXED',
          'org.eclipse.elk.position': 'FIXED',
        }
      : {}),
  };
}

function generateRegionProperties(forceFixed: boolean): Record<string, string> {
  return forceFixed ? { 'org.eclipse.elk.position': 'FIXED' } : {};
}

function elkNodeForLayout(
  node: DiagramNode,
  moduleLayout: SavedModuleLayout,
  options: {
    includeLeadMargins: boolean;
    includeRoutingObstacleMargins?: boolean;
    useSavedPosition?: boolean;
    forceFixed?: boolean;
    nodePositions?: Map<string, { x: number; y: number }>;
    parentBounds?: RegionBounds;
    extraPortMargins?: Map<string, { width: number; height: number }>;
  },
): ElkLayoutNode {
  const geometry = options.includeRoutingObstacleMargins
    ? elkRoutingNodeForDiagramNode(node, options.extraPortMargins)
    : elkNodeForDiagramNode(node, options.includeLeadMargins, options.extraPortMargins);
  const { layoutOffset, ...elkNode } = geometry;
  const saved = moduleLayout.nodes[node.id];
  const position =
    options.nodePositions?.get(node.id) ??
    (options.useSavedPosition && saved ? { x: saved.x, y: saved.y } : undefined);
  const forceFixed = options.forceFixed || saved?.fixed === true;
  const parentX = options.parentBounds?.x ?? 0;
  const parentY = options.parentBounds?.y ?? 0;

  return {
    ...elkNode,
    properties: {
      ...elkNode.properties,
      ...(forceFixed
        ? {
            'org.eclipse.elk.position': 'FIXED',
          }
        : {}),
    },
    layoutOptions: {
      ...elkNode.layoutOptions,
      ...(forceFixed
        ? {
            'elk.position': 'FIXED',
            'org.eclipse.elk.position': 'FIXED',
          }
        : {}),
    },
    ...(position
      ? {
          x: position.x - layoutOffset.x - parentX,
          y: position.y - layoutOffset.y - parentY,
        }
      : {}),
  };
}

function buildGenerateCompoundElkChildren(
  nodes: DiagramNode[],
  regions: GenerateRegion[],
  moduleLayout: SavedModuleLayout,
  options: {
    includeLeadMargins: boolean;
    includeRoutingObstacleMargins?: boolean;
    forceFixed?: boolean;
    nodePositions?: Map<string, { x: number; y: number }>;
    regionBounds?: Map<string, RegionBounds>;
    netCutMargins?: Map<string, Map<string, { width: number; height: number }>>;
  },
): ElkLayoutNode[] {
  const sortedRegions = [...regions].sort(compareGenerateRegions);
  const regionById = new Map(sortedRegions.map((region) => [region.id, region]));
  const childrenByParent = new Map<string, GenerateRegion[]>();
  for (const region of sortedRegions) {
    const parent =
      region.parentRegionId && regionById.has(region.parentRegionId) ? region.parentRegionId : '';
    const children = childrenByParent.get(parent) ?? [];
    children.push(region);
    childrenByParent.set(parent, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareGenerateRegions);
  }

  const nodeOwner = new Map<string, string>();
  for (const node of nodes) {
    const owner = deepestOwningGenerateRegion(node.id, sortedRegions, regionById);
    if (owner) {
      nodeOwner.set(node.id, owner.id);
    }
  }

  const nodesByOwner = new Map<string, DiagramNode[]>();
  const rootNodes: DiagramNode[] = [];
  for (const node of nodes) {
    const ownerId = nodeOwner.get(node.id);
    if (!ownerId) {
      rootNodes.push(node);
      continue;
    }
    const ownedNodes = nodesByOwner.get(ownerId) ?? [];
    ownedNodes.push(node);
    nodesByOwner.set(ownerId, ownedNodes);
  }

  const buildNode = (node: DiagramNode, parentBounds?: RegionBounds): ElkLayoutNode =>
    elkNodeForLayout(node, moduleLayout, {
      includeLeadMargins: options.includeLeadMargins,
      includeRoutingObstacleMargins: options.includeRoutingObstacleMargins,
      forceFixed: options.forceFixed,
      nodePositions: options.nodePositions,
      parentBounds,
      extraPortMargins: options.netCutMargins?.get(node.id),
    });

  const buildRegion = (region: GenerateRegion, parentBounds?: RegionBounds): ElkLayoutNode => {
    const bounds = options.regionBounds?.get(region.id);
    const regionChildren = [
      ...(nodesByOwner.get(region.id) ?? []).map((node) => buildNode(node, bounds)),
      ...(childrenByParent.get(region.id) ?? []).map((child) => buildRegion(child, bounds)),
    ];
    const parentX = parentBounds?.x ?? 0;
    const parentY = parentBounds?.y ?? 0;

    return {
      id: generateRegionElkId(region.id),
      width: bounds?.width ?? REGION_MIN_WIDTH,
      height: bounds?.height ?? REGION_MIN_HEIGHT,
      ...(bounds
        ? {
            x: bounds.x - parentX,
            y: bounds.y - parentY,
          }
        : {}),
      children: regionChildren,
      layoutOptions: generateRegionLayoutOptions(options.forceFixed === true),
      properties: generateRegionProperties(options.forceFixed === true),
    };
  };

  const sourcePorts = rootNodes.filter(isSourceBoundaryPortNode);
  const sinkPorts = rootNodes.filter(isSinkBoundaryPortNode);
  const middleNodes = rootNodes.filter(
    (node) => !isSourceBoundaryPortNode(node) && !isSinkBoundaryPortNode(node),
  );
  const rootRegions = childrenByParent.get('') ?? [];

  return [
    ...sourcePorts.map((node) => buildNode(node)),
    ...middleNodes.map((node) => buildNode(node)),
    ...rootRegions.map((region) => buildRegion(region)),
    ...sinkPorts.map((node) => buildNode(node)),
  ];
}

function deepestOwningGenerateRegion(
  nodeId: string,
  regions: GenerateRegion[],
  regionById: Map<string, GenerateRegion>,
): GenerateRegion | undefined {
  const owners = regions.filter((region) => (region.nodeIds ?? []).includes(nodeId));
  if (owners.length === 0) return undefined;
  owners.sort((a, b) => generateRegionDepth(b, regionById) - generateRegionDepth(a, regionById));
  return owners[0];
}

function generateRegionDepth(
  region: GenerateRegion,
  regionById: Map<string, GenerateRegion>,
): number {
  let depth = 0;
  let parent = region.parentRegionId ? regionById.get(region.parentRegionId) : undefined;
  while (parent) {
    depth += 1;
    parent = parent.parentRegionId ? regionById.get(parent.parentRegionId) : undefined;
  }
  return depth;
}

function isSourceBoundaryPortNode(node: DiagramNode): boolean {
  return node.kind === 'port' && node.ports.some(isInputSidePort);
}

function isSinkBoundaryPortNode(node: DiagramNode): boolean {
  return (
    node.kind === 'port' &&
    node.ports.length > 0 &&
    node.ports.every((port) => port.direction === 'output')
  );
}

function collectElkPositionsAndRegionBounds(
  graph: ElkLayoutNode,
  nodes: DiagramNode[],
  positions: Map<string, { x: number; y: number }>,
  regionBounds: Map<string, RegionBounds>,
  netCutMargins: Map<string, Map<string, { width: number; height: number }>> = new Map(),
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const visit = (node: ElkLayoutNode, origin: { x: number; y: number }) => {
    const x = origin.x + (node.x ?? 0);
    const y = origin.y + (node.y ?? 0);
    const regionId = generateRegionIdFromElkId(node.id);
    if (regionId) {
      if (node.width !== undefined && node.height !== undefined) {
        regionBounds.set(
          regionId,
          snapRegionBounds({
            x,
            y,
            width: node.width,
            height: node.height,
          }),
        );
      }
      for (const child of node.children ?? []) {
        visit(child, { x, y });
      }
      return;
    }

    const diagramNode = nodesById.get(node.id);
    if (diagramNode && node.x !== undefined && node.y !== undefined) {
      // Must mirror the extraPortMargins used to build this node's ELK box
      // (see buildGenerateCompoundElkChildren/buildNode) or a net-cut-inflated
      // left/top margin will de-offset by the wrong amount and drift visually.
      const offset = elkNodeForDiagramNode(
        diagramNode,
        true,
        netCutMargins.get(diagramNode.id),
      ).layoutOffset;
      positions.set(
        node.id,
        snapPosition(
          { x: x + offset.x, y: y + offset.y },
          diagramNode.kind,
          structRole(diagramNode),
        ),
      );
    }

    for (const child of node.children ?? []) {
      visit(child, { x, y });
    }
  };

  for (const child of graph.children ?? []) {
    visit(child, { x: 0, y: 0 });
  }
}

export function elkNodeForDiagramNode(
  node: DiagramNode,
  includeLeadMargins = false,
  extraPortMargins?: Map<string, { width: number; height: number }>,
): ElkDiagramNode {
  const { width, height } = resolvedNodeDimensions(node);
  const grid = diagramSizing.gridSize;
  const role = structRole(node);
  const visiblePorts =
    node.kind === 'interface'
      ? node.ports.filter(
          (port) =>
            port.width !== 'interface' ||
            role === 'modport' ||
            port.preferredSide ||
            port.id.endsWith(':left') ||
            port.id.endsWith(':right'),
        )
      : node.ports;
  const inputs = visiblePorts.filter(isInputSidePort);
  const outputs = visiblePorts.filter((port) => port.direction === 'output');

  const portGeometry = visiblePorts.flatMap((port, index) => {
    let side: ElkPortSide = port.direction === 'output' ? 'EAST' : 'WEST';
    if (node.kind === 'port') {
      side = port.direction === 'output' ? 'WEST' : 'EAST';
    }

    let portX = side === 'WEST' ? 0 : width;
    let portY = height / 2;
    let leadOverride: number | undefined;

    if (node.kind === 'netLabel') {
      const handleSide = node.metadata?.cutNet?.handleSide;
      if (handleSide === 'right') {
        side = 'EAST';
        portX = width;
      } else if (handleSide === 'top') {
        side = 'NORTH';
        portX = width / 2;
        portY = 0;
      } else if (handleSide === 'bottom') {
        side = 'SOUTH';
        portX = width / 2;
        portY = height;
      } else {
        side = 'WEST';
        portX = 0;
      }
      // A cut stub reserves one grid immediately outside the label handle,
      // independent of whether that handle is horizontal or vertical.
      leadOverride = grid;
    } else if (node.kind === 'register') {
      const clockSignal = registerClockSignal(node);
      const resetSignal = registerResetSignal(node);
      const inputs = node.ports.filter(isInputSidePort);
      const isReset = port.name === 'R' || port.name === resetSignal;
      const isClock =
        port.name === clockSignal ||
        (!isReset &&
          port.name !== 'D' &&
          port.name !== 'Q' &&
          port.name !== 'RV' &&
          inputs.indexOf(port) === 1);
      const isRv = port.name === 'RV';

      if (port.name === 'D') {
        portY = diagramSizing.nodeHeaderHeight + grid / 2;
      } else if (port.name === 'Q') {
        portY = diagramSizing.nodeHeaderHeight + grid / 2;
      } else if (isClock) {
        portY = diagramSizing.nodeHeaderHeight + grid + grid / 2;
      } else if (isRv) {
        portY = diagramSizing.nodeHeaderHeight + grid * 2 + grid / 2;
      } else if (isReset) {
        side = 'SOUTH';
        portX = width / 2;
        portY = height;
      }
    } else if (node.kind === 'mux') {
      // Mirrors MuxNodeSvg's own muxTopPorts/sideInputs split: the port named
      // `sel` renders on top regardless of its position in `node.ports`,
      // falling back to the first input only when nothing is named `sel`.
      const inputs = node.ports.filter(isInputSidePort);
      const selectPort = inputs.find((candidate) => candidate.name === 'sel') ?? inputs[0];
      const isSelect = port.id === selectPort?.id;
      if (isSelect) {
        side = 'NORTH';
        portX = width / 2;
        portY = diagramSizing.gridSize;
      } else if (port.direction === 'output') {
        portY = height / 2;
      } else {
        const sideInputs = inputs.filter((candidate) => candidate.id !== selectPort?.id);
        const sideInputIndex = sideInputs.indexOf(port);
        const heightUnits = Math.max(1, Math.round(height / grid));
        const startUnit = Math.max(1, Math.ceil((heightUnits - (inputs.length - 1) + 1) / 2));
        portY = grid * (startUnit + sideInputIndex);
      }
    } else if (node.kind === 'select') {
      const allInputs = node.ports.filter(isInputSidePort);
      const topPorts = allInputs.filter(
        (p) => p.name === 's' || p.name === 'sel' || p.name === 'width',
      );
      const portIndex = topPorts.indexOf(port);
      if (portIndex >= 0) {
        side = 'NORTH';
        portX = (width * (portIndex + 1)) / (topPorts.length + 1);
        portY = diagramSizing.gridSize;
      } else if (port.direction === 'output') {
        portY = height / 2;
      } else {
        portY = height / 2;
      }
    } else if (node.kind === 'alu' || node.kind === 'comparator') {
      if (port.direction === 'output') {
        side = 'EAST';
        portX = width;
        portY = height / 2;
      } else {
        side = 'WEST';
        portX = 0;
        const inputIndex = Math.max(0, inputs.indexOf(port));
        portY = inputIndex === 0 ? grid : grid * 3;
      }
    } else if (node.kind === 'zext') {
      side = port.direction === 'output' ? 'EAST' : 'WEST';
      portX = side === 'EAST' ? width : 0;
      portY = height / 2;
    } else if (node.kind === 'inverter') {
      if (port.direction === 'output') {
        side = 'EAST';
        portX = inverterGeometryWidth();
      } else {
        side = 'WEST';
        portX = 0;
      }
      portY = height / 2;
    } else if (node.kind === 'gate') {
      if (port.direction === 'output') {
        side = 'EAST';
        portX = width;
        portY = height / 2;
      } else {
        side = 'WEST';
        portX = 0;
        const inputIndex = Math.max(0, inputs.indexOf(port));
        portY = gateInputPortCenterY(inputIndex, inputs.length, height);
      }
    } else if (node.kind === 'port' || (node.kind === 'interface' && role === 'port')) {
      portY = height / 2;
    } else if (node.kind === 'bus' || node.kind === 'struct' || node.kind === 'interface') {
      const isInterfaceModport = node.kind === 'interface' && role === 'modport';
      const isInterfaceInstance =
        node.kind === 'interface' && role !== 'modport' && role !== 'port';
      const shiftY = isInterfaceInstance ? diagramSizing.interfaceInstanceShiftY : 0;
      const bottomPortsOnSide = isInterfaceInstance
        ? visiblePorts.filter((p) => p.direction === 'output' && p.width !== 'interface')
        : [];
      const bottomHatHeight = isInterfaceInstance
        ? interfaceTopHatHeight(bottomPortsOnSide.length > 0)
        : 0;
      const unshiftedHeight = Math.max(grid, height - shiftY);

      if (isInterfaceInstance && port.direction === 'input' && port.width !== 'interface') {
        side = 'NORTH';
        const topPorts = visiblePorts.filter(
          (p) => p.direction === 'input' && p.width !== 'interface',
        );
        const portIndex = topPorts.indexOf(port);
        portX = interfaceTopPortX(
          width,
          topPorts.length,
          portIndex,
          Math.max(topPorts.length, bottomPortsOnSide.length),
        );
        portY = 0;
        // The hat sits below the layout-box top, so the box itself already
        // provides the vertical approach; no extra lead margin above it.
        leadOverride = 0;
      } else if (isInterfaceInstance && port.direction === 'output' && port.width !== 'interface') {
        side = 'SOUTH';
        const portIndex = bottomPortsOnSide.indexOf(port);
        const topPorts = visiblePorts.filter(
          (p) => p.direction === 'input' && p.width !== 'interface',
        );
        portX = interfaceTopPortX(
          width,
          bottomPortsOnSide.length,
          portIndex,
          Math.max(topPorts.length, bottomPortsOnSide.length),
        );
        portY = height;
      } else {
        const sidePorts = isInterfaceInstance
          ? visiblePorts.filter(
              (p) =>
                p.width === 'interface' || (p.direction !== 'input' && p.direction !== 'output'),
            )
          : visiblePorts;
        const sideInputs = sidePorts.filter(isInputSidePort);
        const sideOutputs = sidePorts.filter((p) => p.direction === 'output');

        const isComposition =
          node.kind === 'struct'
            ? role === 'composition'
            : node.kind === 'interface'
              ? false
              : inputs.length > 1;
        const isArrayComposition =
          node.kind === 'bus' && isComposition && node.metadata?.aggregateKind === 'array';
        const isArrayBreakout =
          node.kind === 'bus' && !isComposition && node.metadata?.aggregateKind === 'array';

        if (isInterfaceModport && port.width === 'interface') {
          const isModuleInterfaceModport = node.label !== node.metadata?.typeName;
          if (isModuleInterfaceModport) {
            side = 'NORTH';
            portX = width / 2;
            portY = 0;
            leadOverride = grid; // hat stem: keep the boundary one grid above the node
          } else {
            side = port.direction === 'output' ? 'EAST' : 'WEST';
            portX = side === 'EAST' ? width : 0;
            portY = height / 2;
          }
        } else if (isInterfaceInstance && port.width === 'interface') {
          const pref = port.preferredSide;
          side = pref === 'left' ? 'WEST' : 'EAST';
          portX = side === 'EAST' ? width : 0;
          const sidePortsOnSide = visiblePorts.filter(
            (p) => p.width === 'interface' || (p.direction !== 'input' && p.direction !== 'output'),
          );
          const centers = interfaceSidePortCenters(
            sidePortsOnSide,
            unshiftedHeight,
            interfaceTopHatHeight(
              visiblePorts.some((p) => p.direction === 'input' && p.width !== 'interface'),
            ),
            bottomHatHeight,
          );
          portY = (centers.get(port.id) ?? unshiftedHeight / 2) + shiftY;
        } else {
          const taps = isInterfaceModport
            ? sidePorts.filter((p) => p.width !== 'interface')
            : node.kind === 'interface'
              ? [...sideInputs, ...sideOutputs]
              : isComposition
                ? inputs
                : outputs;
          const singlePort = isComposition ? outputs[0] : inputs[0];
          const tapIndex = taps.indexOf(port);
          if (isInterfaceModport) {
            const pref = port.preferredSide;
            if (pref) {
              side = pref === 'left' ? 'WEST' : 'EAST';
            } else {
              side = port.direction === 'output' ? 'EAST' : 'WEST';
            }
            portX = side === 'EAST' ? width : 0;
          }

          if (port.id === singlePort?.id) {
            if (isArrayComposition) {
              side = 'EAST';
              portX = width;
            } else if (isArrayBreakout) {
              side = 'WEST';
              portX = 0;
            }
          }

          if (tapIndex >= 0) {
            portY = isInterfaceInstance
              ? (interfaceSidePortCenters(
                  sidePorts,
                  unshiftedHeight,
                  interfaceTopHatHeight(
                    visiblePorts.some((p) => p.direction === 'input' && p.width !== 'interface'),
                  ),
                  bottomHatHeight,
                ).get(port.id) ?? unshiftedHeight / 2) + shiftY
              : grid * (tapIndex * 2 + (isInterfaceModport ? 2 : 1));
          } else if (!isInterfaceModport && port.id === singlePort?.id) {
            if (isArrayComposition || isArrayBreakout) {
              const lastTapCenter = grid * ((taps.length - 1) * 2 + 1);
              portY = lastTapCenter + grid;
            } else {
              portY = grid; // firstTapCenter
            }
          } else {
            portY = height / 2;
          }
        }
      }
    } else if (node.kind === 'literal' || node.kind === 'replicate') {
      portY = height / 2;
    } else {
      const sidePorts = port.direction === 'output' ? outputs : inputs;
      portY = genericNodePortTop(node) + grid * Math.max(0, sidePorts.indexOf(port)) + grid / 2;
    }

    const base = {
      leadLength: includeLeadMargins ? (leadOverride ?? elkLeadLengthForPort(side, port.id)) : 0,
      index,
      y: portY,
      // The footprint of a net-cut label reserved on this port, if any — see
      // netCutPortMargins. Only ever set when includeLeadMargins is true;
      // extraPortMargins itself is only ever passed for the layout passes.
      cutLabelSize: includeLeadMargins ? extraPortMargins?.get(port.id) : undefined,
    };

    // A boundary inout port gets two ELK ports instead of one: the driven
    // side (WEST/left) and the read side (EAST/right) — see endpointId.
    if (node.kind === 'port' && port.direction === 'inout') {
      return [
        {
          ...base,
          id: endpointId(node.id, port.id, node, 'target'),
          side: 'WEST' as ElkPortSide,
          x: 0,
        },
        {
          ...base,
          id: endpointId(node.id, port.id, node, 'source'),
          side: 'EAST' as ElkPortSide,
          x: width,
        },
      ];
    }

    return [{ ...base, id: endpointId(node.id, port.id), side, x: portX }];
  });

  const arrayLayerPad = nodeIsArrayNode(node)
    ? nodeStackIsWide(node)
      ? ARRAY_STACK_WIDE_LANE_OFFSET
      : ARRAY_STACK_LANE_OFFSET
    : 0;
  // Reserve only the part of each lead that extends past the node outline:
  // ports inset into the node (mux/select top selects, the inverter output
  // bubble) consume part of their lead inside the node, so the ELK box must
  // not also pad for it. A port with an active net-cut label additionally
  // reserves the label's own footprint beyond the lead (in the lead's
  // direction) and straddling the lead perpendicular to it (the label is
  // centered on the lead point), so a tightly packed neighbor can't land on
  // top of it. With no label, cutExtra/cutCross are both 0 and this reduces
  // to exactly the original lead-only computation.
  const margins = portGeometry.reduce(
    (current, port) => {
      const cutExtra =
        port.side === 'WEST' || port.side === 'EAST'
          ? (port.cutLabelSize?.width ?? 0)
          : (port.cutLabelSize?.height ?? 0);
      const cutCross =
        (port.side === 'WEST' || port.side === 'EAST'
          ? port.cutLabelSize?.height
          : port.cutLabelSize?.width) ?? 0;
      if (port.side === 'WEST') {
        current.left = Math.max(current.left, port.leadLength + cutExtra - port.x);
        current.top = Math.max(current.top, cutCross / 2 - port.y);
        current.bottom = Math.max(current.bottom, cutCross / 2 - (height - port.y));
      } else if (port.side === 'EAST') {
        current.right = Math.max(current.right, port.leadLength + cutExtra - (width - port.x));
        current.top = Math.max(current.top, cutCross / 2 - port.y);
        current.bottom = Math.max(current.bottom, cutCross / 2 - (height - port.y));
      } else if (port.side === 'NORTH') {
        current.top = Math.max(current.top, port.leadLength + cutExtra - port.y);
        current.left = Math.max(current.left, cutCross / 2 - port.x);
        current.right = Math.max(current.right, cutCross / 2 - (width - port.x));
      } else if (port.side === 'SOUTH') {
        current.bottom = Math.max(current.bottom, port.leadLength + cutExtra - (height - port.y));
        current.left = Math.max(current.left, cutCross / 2 - port.x);
        current.right = Math.max(current.right, cutCross / 2 - (width - port.x));
      }
      return current;
    },
    { left: arrayLayerPad, right: arrayLayerPad, top: arrayLayerPad, bottom: arrayLayerPad },
  );

  const ports = portGeometry.map((port) => {
    const leadX =
      port.side === 'WEST' ? -port.leadLength : port.side === 'EAST' ? port.leadLength : 0;
    const leadY =
      port.side === 'NORTH' ? -port.leadLength : port.side === 'SOUTH' ? port.leadLength : 0;

    return {
      id: port.id,
      width: 1,
      height: 1,
      x: margins.left + port.x + leadX,
      y: margins.top + port.y + leadY,
      layoutOptions: {
        'elk.port.side': port.side,
        'elk.port.index': port.index.toString(),
        'org.eclipse.elk.port.side': port.side,
        'org.eclipse.elk.port.index': port.index.toString(),
      },
      properties: {
        'org.eclipse.elk.port.side': port.side,
        'org.eclipse.elk.port.index': port.index.toString(),
      },
    };
  });

  return {
    id: node.id,
    width: width + margins.left + margins.right,
    height: height + margins.top + margins.bottom,
    ports,
    layoutOptions: {
      'elk.portConstraints': 'FIXED_POS',
      'org.eclipse.elk.portConstraints': 'FIXED_POS',
    },
    properties: {
      'org.eclipse.elk.portConstraints': 'FIXED_POS',
    },
    layoutOffset: { x: margins.left, y: margins.top },
  };
}

export function elkRoutingNodeForDiagramNode(
  node: DiagramNode,
  extraPortMargins?: Map<string, { width: number; height: number }>,
): ElkDiagramNode {
  const elkNode = elkNodeForDiagramNode(node, true, extraPortMargins);
  const portSides = elkNode.ports.map(
    (port) => port.properties['org.eclipse.elk.port.side'] ?? port.layoutOptions['elk.port.side'],
  );
  const margins = routingObstacleMargins(node, portSides);

  return {
    ...elkNode,
    width: elkNode.width + margins.left + margins.right,
    height: elkNode.height + margins.top + margins.bottom,
    ports: elkNode.ports.map((port) => ({
      ...port,
      x: port.x === undefined ? undefined : port.x + margins.left,
      y: port.y === undefined ? undefined : port.y + margins.top,
    })),
    layoutOffset: {
      x: elkNode.layoutOffset.x + margins.left,
      y: elkNode.layoutOffset.y + margins.top,
    },
  };
}

function elkLeadLengthForPort(side: ElkPortSide, portId?: string): number {
  if (side === 'NORTH' || side === 'SOUTH') {
    return portId === 'reset' ? diagramSizing.gridSize : diagramSizing.gridSize * 2;
  }
  return diagramSizing.edgeLeadLength;
}

function leafBounds(node: DiagramNode, position: { x: number; y: number }): NodeBounds {
  const dimensions = resolvedNodeDimensions(node);
  return { x: position.x, y: position.y, width: dimensions.width, height: dimensions.height };
}

function alignSimpleLeafNodes(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  positions: Map<string, { x: number; y: number }>,
  moduleLayout: SavedModuleLayout,
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  // A leaf port is normally aligned to sit right beside the single node that
  // drives or reads it. But when ELK's own (already non-overlapping) layer
  // assignment puts that peer far away — e.g. a structural feedback loop,
  // where cycle-breaking can land the peer in a much earlier layer — sliding
  // the port straight onto the peer's row can drop it on top of an unrelated
  // node that ELK placed in between. Guard the realignment with a collision
  // check against every other node's current bounds and skip it when it
  // would introduce an overlap, leaving ELK's own placement in effect.
  const wouldOverlapOtherNode = (
    node: DiagramNode,
    candidate: { x: number; y: number },
  ): boolean => {
    const candidateBounds = leafBounds(node, candidate);
    return nodes.some((other) => {
      if (other.id === node.id) return false;
      const otherPosition = positions.get(other.id);
      if (!otherPosition) return false;
      return boundsOverlap(candidateBounds, leafBounds(other, otherPosition));
    });
  };

  for (const node of nodes) {
    if (moduleLayout.nodes[node.id]?.fixed || node.kind !== 'port') {
      continue;
    }

    const connected = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    if (connected.length !== 1) {
      continue;
    }

    const edge = connected[0];
    const isSource = edge.source === node.id;
    const peer = nodesById.get(isSource ? edge.target : edge.source);
    if (!peer || peer.kind === 'port' || peer.kind === 'register' || peer.kind === 'latch') {
      continue;
    }

    const peerRole: 'source' | 'target' = isSource ? 'target' : 'source';
    const ownRole: 'source' | 'target' = isSource ? 'source' : 'target';
    const peerPortId = isSource ? edge.targetPort : edge.sourcePort;
    if (!canAlignSimpleLeafToPeer(peer, peerPortId, peerRole)) {
      continue;
    }

    const nodePosition = positions.get(node.id);
    const peerPosition = positions.get(peer.id);
    if (!nodePosition || !peerPosition) {
      continue;
    }

    const ownPortId = isSource ? edge.sourcePort : edge.targetPort;
    const ownOffset = renderedPortOffset(node, ownPortId, ownRole);
    const peerOffset = renderedPortOffset(peer, peerPortId, peerRole);
    if (!ownOffset || !peerOffset) {
      continue;
    }

    const peerElkNode = elkNodeForDiagramNode(peer, false);
    const peerElkPort = peerElkNode.ports.find(
      (candidate) => candidate.id === endpointId(peer.id, peerPortId, peer, peerRole),
    );
    const peerSide = peerElkPort?.properties['org.eclipse.elk.port.side'];
    if ((peerSide === 'NORTH' || peerSide === 'SOUTH') && node.kind === 'port') {
      const ownElkNode = elkNodeForDiagramNode(node, false);
      const ownElkPort = ownElkNode.ports.find(
        (candidate) => candidate.id === endpointId(node.id, ownPortId, node, ownRole),
      );
      const ownSide = ownElkPort?.properties['org.eclipse.elk.port.side'];
      const ownLeadOffset =
        ownSide === 'EAST'
          ? diagramSizing.edgeLeadLength
          : ownSide === 'WEST'
            ? -diagramSizing.edgeLeadLength
            : 0;
      const sameSidePorts = peerElkNode.ports.filter(
        (candidate) => candidate.properties['org.eclipse.elk.port.side'] === peerSide,
      );
      const sideIndex = Math.max(
        0,
        sameSidePorts.findIndex((candidate) => candidate.id === peerElkPort?.id),
      );
      const verticalGap =
        diagramSizing.gridSize * (peerSide === 'NORTH' ? 3 + sideIndex * 2 : 2 + sideIndex * 2);
      const candidate = {
        x: snapToGrid(peerPosition.x + peerOffset.x - ownOffset.x - ownLeadOffset),
        y: snapToGrid(
          peerSide === 'NORTH'
            ? peerPosition.y - ownOffset.y - verticalGap
            : peerPosition.y + peerOffset.y + verticalGap,
          node.kind,
        ),
      };
      if (!wouldOverlapOtherNode(node, candidate)) {
        positions.set(node.id, candidate);
      }
      continue;
    }

    const candidate = {
      ...nodePosition,
      y: snapToGrid(peerPosition.y + peerOffset.y - ownOffset.y, node.kind),
    };
    if (!wouldOverlapOtherNode(node, candidate)) {
      positions.set(node.id, candidate);
    }
  }
}

function canAlignSimpleLeafToPeer(
  node: DiagramNode,
  portId: string | undefined,
  role: 'source' | 'target',
): boolean {
  const elkNode = elkNodeForDiagramNode(node, false);
  const port = elkNode.ports.find(
    (candidate) => candidate.id === endpointId(node.id, portId, node, role),
  );
  const side = port?.properties['org.eclipse.elk.port.side'] as ElkPortSide | undefined;
  if (!side || (side !== 'WEST' && side !== 'EAST')) {
    return false;
  }

  return (
    elkNode.ports.filter((candidate) => candidate.properties['org.eclipse.elk.port.side'] === side)
      .length === 1
  );
}

export function enforceMinimumBlockGaps(
  nodes: DiagramNode[],
  positions: Map<string, { x: number; y: number }>,
  moduleLayout: SavedModuleLayout,
): void {
  const blocks = nodes.filter(
    (node) => isBlockSpacingNode(node) && !moduleLayout.nodes[node.id]?.fixed,
  );
  const geometries = new Map(
    blocks.map((node) => {
      const elkNode = elkNodeForDiagramNode(node, true);
      return [
        node.id,
        {
          width: elkNode.width,
          height: elkNode.height,
          offset: elkNode.layoutOffset,
        },
      ];
    }),
  );
  const minGap = diagramSizing.gridSize;

  const boundsFor = (node: DiagramNode): RegionBounds | undefined => {
    const position = positions.get(node.id);
    const geometry = geometries.get(node.id);
    if (!position || !geometry) return undefined;
    return {
      x: position.x - geometry.offset.x,
      y: position.y - geometry.offset.y,
      width: geometry.width,
      height: geometry.height,
    };
  };

  for (let pass = 0; pass < blocks.length; pass++) {
    let moved = false;
    const ordered = [...blocks].sort((a, b) => (boundsFor(a)?.y ?? 0) - (boundsFor(b)?.y ?? 0));

    for (let i = 1; i < ordered.length; i++) {
      const node = ordered[i];
      const pos = positions.get(node.id);
      const geometry = geometries.get(node.id);
      const bounds = boundsFor(node);
      if (!pos || !geometry || !bounds) continue;

      let requiredTop = bounds.y;
      for (let j = 0; j < i; j++) {
        const previous = ordered[j];
        const previousBounds = boundsFor(previous);
        if (!previousBounds || !horizontallyOverlaps(bounds, previousBounds)) continue;

        const gap = requiredTop - (previousBounds.y + previousBounds.height);
        if (gap < minGap) {
          requiredTop = previousBounds.y + previousBounds.height + minGap;
        }
      }

      if (requiredTop > bounds.y) {
        const requiredY = requiredTop + geometry.offset.y;
        positions.set(node.id, {
          ...pos,
          y: snapToGridAtOrAfter(requiredY, node.kind, structRole(node)),
        });
        moved = true;
      }
    }

    if (!moved) break;
  }
}

function isBlockSpacingNode(node: DiagramNode): boolean {
  return node.kind !== 'port' && node.kind !== 'replicate';
}

function horizontallyOverlaps(
  a: { x: number; width: number },
  b: { x: number; width: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

function genericNodePortTop(node: DiagramNode): number {
  return diagramSizing.nodeHeaderHeight + diagramSizing.gridSize * instanceParameterRows(node);
}

export function renderedPortGeometry(
  node: DiagramNode,
  portId?: string,
  includeLeadMargins = false,
  role: 'source' | 'target' = 'target',
): { offset: { x: number; y: number }; side: ElkPortSide } | undefined {
  const elkNode = elkNodeForDiagramNode(node, includeLeadMargins);
  const port = elkNode.ports.find(
    (candidate) => candidate.id === endpointId(node.id, portId, node, role),
  );
  if (!port || port.x === undefined || port.y === undefined) {
    return undefined;
  }
  return {
    offset: {
      x: port.x - elkNode.layoutOffset.x,
      y: port.y - elkNode.layoutOffset.y,
    },
    side: (port.properties['org.eclipse.elk.port.side'] ?? 'EAST') as ElkPortSide,
  };
}

export function renderedPortOffset(
  node: DiagramNode,
  portId?: string,
  role: 'source' | 'target' = 'target',
): { x: number; y: number } | undefined {
  const elkNode = elkNodeForDiagramNode(node, false);
  const port = elkNode.ports.find(
    (candidate) => candidate.id === endpointId(node.id, portId, node, role),
  );
  if (!port || port.x === undefined || port.y === undefined) {
    return undefined;
  }
  return { x: port.x, y: port.y };
}

function routeWithRenderedLeads(
  edge: DiagramEdge,
  route: Array<{ x: number; y: number }>,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const sourceLead = renderedLeadPoint(
    edge.source,
    edge.sourcePort,
    nodesById,
    nodePositions,
    true,
    'source',
  );
  const targetLead = renderedLeadPoint(
    edge.target,
    edge.targetPort,
    nodesById,
    nodePositions,
    true,
    'target',
  );
  if (!sourceLead || !targetLead) {
    return route;
  }

  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const isSimpleVerticalFeed =
    (sourceNode?.kind === 'port' && (targetLead.side === 'NORTH' || targetLead.side === 'SOUTH')) ||
    (targetNode?.kind === 'port' && (sourceLead.side === 'NORTH' || sourceLead.side === 'SOUTH'));
  if (isSimpleVerticalFeed) {
    const sourceHandle = renderedLeadPoint(
      edge.source,
      edge.sourcePort,
      nodesById,
      nodePositions,
      false,
      'source',
    );
    const targetHandle = renderedLeadPoint(
      edge.target,
      edge.targetPort,
      nodesById,
      nodePositions,
      false,
      'target',
    );
    if (sourceHandle && targetHandle) {
      const candidate = directLeadRoute(
        insetVerticalBoundaryLead(sourceHandle, sourceNode?.kind === 'port'),
        insetVerticalBoundaryLead(targetHandle, targetNode?.kind === 'port'),
      );
      // Only take the shortcut when the drop is monotonic (the wire approaches
      // a NORTH anchor from above / a SOUTH anchor from below) and the direct
      // route doesn't cut through unrelated nodes. Otherwise keep the ELK
      // route, which already avoids the boxes.
      if (
        verticalFeedIsMonotonic(sourceHandle, targetHandle) &&
        !routeIntersectsNodeInterior(
          candidate,
          nodesById,
          nodePositions,
          new Set([edge.source, edge.target]),
        )
      ) {
        return candidate;
      }
    }
  }

  const internal = route.slice(1, -1);
  if (internal.length === 0) {
    return repairForwardHorizontalRoute(
      directLeadRoute(sourceLead, targetLead),
      sourceLead,
      targetLead,
      nodesById,
      nodePositions,
    );
  }

  const points = [sourceLead.point];
  const first = internal[0];
  const sourceConnector = leadExtensionConnector(sourceLead.point, first, sourceLead.side);
  if (sourceConnector) {
    points.push(sourceConnector);
  }
  points.push(...internal);

  const last = internal[internal.length - 1];
  const targetConnector = leadExtensionConnector(targetLead.point, last, targetLead.side);
  if (targetConnector) {
    points.push(targetConnector);
  }
  points.push(targetLead.point);

  const stitched = removeRedundantRoutePoints(makeOrthogonalRoute(points));
  const smoothed = smoothInitialForwardHierarchyStair(
    stitched,
    sourceLead,
    targetLead,
    nodesById,
    nodePositions,
  );
  return repairForwardHorizontalRoute(smoothed, sourceLead, targetLead, nodesById, nodePositions);
}

function verticalFeedIsMonotonic(
  sourceHandle: { point: { x: number; y: number }; side: ElkPortSide },
  targetHandle: { point: { x: number; y: number }; side: ElkPortSide },
): boolean {
  for (const [handle, other] of [
    [sourceHandle, targetHandle.point],
    [targetHandle, sourceHandle.point],
  ] as const) {
    if (handle.side === 'NORTH' && other.y > handle.point.y) {
      return false;
    }
    if (handle.side === 'SOUTH' && other.y < handle.point.y) {
      return false;
    }
  }
  return true;
}

function smoothInitialForwardHierarchyStair(
  route: Array<{ x: number; y: number }>,
  sourceLead: { point: { x: number; y: number }; side: ElkPortSide },
  targetLead: { point: { x: number; y: number }; side: ElkPortSide },
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const direction = forwardHorizontalDirection(sourceLead, targetLead);
  if (!direction || route.length < 5 || !pointsEqual(route[0], sourceLead.point)) {
    return route;
  }

  const [source, first, second, third, fourth] = route;
  const isInitialStair =
    first.y === source.y &&
    second.x === first.x &&
    third.y === second.y &&
    fourth.x === third.x &&
    second.y !== source.y &&
    ((direction > 0 && third.x > first.x) || (direction < 0 && third.x < first.x)) &&
    Math.abs(third.x - first.x) <= diagramSizing.gridSize * 2;
  if (!isInitialStair) {
    return route;
  }

  const candidate = removeRedundantRoutePoints(
    makeOrthogonalRoute([source, { x: third.x, y: source.y }, ...route.slice(4)]),
  );
  return routeIntersectsNodeInterior(candidate, nodesById, nodePositions) ? route : candidate;
}

function insetVerticalBoundaryLead(
  lead: { point: { x: number; y: number }; side: ElkPortSide },
  isPortNode: boolean,
): { point: { x: number; y: number }; side: ElkPortSide } {
  if (isPortNode || (lead.side !== 'NORTH' && lead.side !== 'SOUTH')) {
    return lead;
  }

  return {
    ...lead,
    point: {
      x: lead.point.x,
      y:
        lead.point.y +
        (lead.side === 'NORTH' ? diagramSizing.gridSize / 2 : -diagramSizing.gridSize / 2),
    },
  };
}

function directRenderedLeadRoute(
  edge: DiagramEdge,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> | undefined {
  const sourceLead = renderedLeadPoint(
    edge.source,
    edge.sourcePort,
    nodesById,
    nodePositions,
    true,
    'source',
  );
  const targetLead = renderedLeadPoint(
    edge.target,
    edge.targetPort,
    nodesById,
    nodePositions,
    true,
    'target',
  );
  if (!sourceLead || !targetLead) {
    return undefined;
  }
  return directLeadRoute(sourceLead, targetLead);
}

// A cut stub normally has no explicit route: its label is derived beside the
// owning port and `forceStraight` makes the two look like a wire split in
// place. An expanded instance can grow between a previously pinned label and
// that port, though, or over another stub's straight corridor. In that one
// case synthesize the shortest single-lane detour around the transient frame
// rectangles. Keeping this scoped to size overrides preserves the ordinary
// cut appearance everywhere else.
function cutStubRouteAroundSizeOverrides(
  edge: DiagramEdge,
  sizeOverrides: Record<string, { width: number; height: number }> | undefined,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> | undefined {
  if (!sizeOverrides || Object.keys(sizeOverrides).length === 0) return undefined;
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  // Match normalizeRoutePoints' forceStraight cut-stub convention exactly:
  // the real block keeps its outward lead, while the cut label terminates at
  // the label handle itself. If the synthesized route started one grid past
  // a label, endpoint reconciliation would discard its first detour leg.
  const sourceLead = renderedLeadPoint(
    edge.source,
    edge.sourcePort,
    nodesById,
    nodePositions,
    sourceNode?.kind !== 'netLabel',
    'source',
  );
  const targetLead = renderedLeadPoint(
    edge.target,
    edge.targetPort,
    nodesById,
    nodePositions,
    targetNode?.kind !== 'netLabel',
    'target',
  );
  if (!sourceLead || !targetLead) return undefined;
  const direct = directLeadRoute(sourceLead, targetLead);

  const obstacles = Object.keys(sizeOverrides).flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    const position = nodePositions.get(nodeId);
    if (!node || !position) return [];
    const dimensions = resolvedNodeDimensions(node);
    return [{ ...position, ...dimensions }];
  });
  const intersects = (route: Array<{ x: number; y: number }>) =>
    route
      .slice(0, -1)
      .some((point, index) =>
        obstacles.some((rect) => segmentIntersectsRectInterior(point, route[index + 1], rect)),
      );
  const currentRoute = edge.routePoints?.length ? edge.routePoints : direct;
  if (!intersects(currentRoute)) return undefined;

  const source = direct[0];
  const target = direct[direct.length - 1];
  const grid = diagramSizing.gridSize;
  const laneYs = uniqueNumbers(
    obstacles.flatMap((rect) => [
      snapToGrid(rect.y - grid),
      snapToGrid(rect.y + rect.height + grid),
    ]),
  );
  const laneXs = uniqueNumbers(
    obstacles.flatMap((rect) => [
      snapToGrid(rect.x - grid),
      snapToGrid(rect.x + rect.width + grid),
    ]),
  );
  const candidates = [
    ...laneYs.map((y) =>
      removeRedundantRoutePoints(
        makeOrthogonalRoute([source, { x: source.x, y }, { x: target.x, y }, target]),
      ),
    ),
    ...laneXs.map((x) =>
      removeRedundantRoutePoints(
        makeOrthogonalRoute([source, { x, y: source.y }, { x, y: target.y }, target]),
      ),
    ),
  ].sort((a, b) => routeManhattanLength(a) - routeManhattanLength(b));

  return candidates.find((candidate) => !intersects(candidate));
}

function directLeadRoute(
  sourceLead: { point: { x: number; y: number }; side: ElkPortSide },
  targetLead: { point: { x: number; y: number }; side: ElkPortSide },
): Array<{ x: number; y: number }> {
  const sourceSideIsHorizontal = sourceLead.side === 'EAST' || sourceLead.side === 'WEST';
  const targetSideIsHorizontal = targetLead.side === 'EAST' || targetLead.side === 'WEST';
  if (
    sourceSideIsHorizontal &&
    targetSideIsHorizontal &&
    sourceLead.point.y !== targetLead.point.y
  ) {
    const midX = snapToGrid((sourceLead.point.x + targetLead.point.x) / 2);
    return removeRedundantRoutePoints(
      makeOrthogonalRoute([
        sourceLead.point,
        { x: midX, y: sourceLead.point.y },
        { x: midX, y: targetLead.point.y },
        targetLead.point,
      ]),
    );
  }

  const sourceSideIsVertical = sourceLead.side === 'NORTH' || sourceLead.side === 'SOUTH';
  const targetSideIsVertical = targetLead.side === 'NORTH' || targetLead.side === 'SOUTH';
  if (sourceSideIsVertical && targetSideIsVertical && sourceLead.point.x !== targetLead.point.x) {
    const midY = snapToGrid((sourceLead.point.y + targetLead.point.y) / 2);
    return removeRedundantRoutePoints(
      makeOrthogonalRoute([
        sourceLead.point,
        { x: sourceLead.point.x, y: midY },
        { x: targetLead.point.x, y: midY },
        targetLead.point,
      ]),
    );
  }

  // Mixed sides with a non-monotonic approach: a plain L-corner would reach a
  // NORTH lead from below (or a SOUTH lead from above) and backtrack through
  // the node. Dogleg through an approach corridor one grid outside the lead.
  if (
    !sourceSideIsVertical &&
    targetSideIsVertical &&
    !verticalFeedIsMonotonic(sourceLead, targetLead)
  ) {
    const corridorY =
      targetLead.point.y +
      (targetLead.side === 'NORTH' ? -diagramSizing.gridSize : diagramSizing.gridSize);
    const midX = snapToGrid((sourceLead.point.x + targetLead.point.x) / 2);
    return removeRedundantRoutePoints(
      makeOrthogonalRoute([
        sourceLead.point,
        { x: midX, y: sourceLead.point.y },
        { x: midX, y: corridorY },
        { x: targetLead.point.x, y: corridorY },
        targetLead.point,
      ]),
    );
  }
  if (
    sourceSideIsVertical &&
    !targetSideIsVertical &&
    !verticalFeedIsMonotonic(sourceLead, targetLead)
  ) {
    const corridorY =
      sourceLead.point.y +
      (sourceLead.side === 'NORTH' ? -diagramSizing.gridSize : diagramSizing.gridSize);
    const midX = snapToGrid((sourceLead.point.x + targetLead.point.x) / 2);
    return removeRedundantRoutePoints(
      makeOrthogonalRoute([
        sourceLead.point,
        { x: sourceLead.point.x, y: corridorY },
        { x: midX, y: corridorY },
        { x: midX, y: targetLead.point.y },
        targetLead.point,
      ]),
    );
  }

  return removeRedundantRoutePoints(makeOrthogonalRoute([sourceLead.point, targetLead.point]));
}

function repairForwardHorizontalRoute(
  route: Array<{ x: number; y: number }>,
  sourceLead: { point: { x: number; y: number }; side: ElkPortSide },
  targetLead: { point: { x: number; y: number }; side: ElkPortSide },
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const direction = forwardHorizontalDirection(sourceLead, targetLead);
  if (!direction) {
    return route;
  }

  if (!routeIntersectsNodeInterior(route, nodesById, nodePositions)) {
    return route;
  }

  const candidates = forwardHorizontalCandidates(
    sourceLead.point,
    targetLead.point,
    direction,
    nodesById,
    nodePositions,
  );
  return (
    candidates.find(
      (candidate) => !routeIntersectsNodeInterior(candidate, nodesById, nodePositions),
    ) ?? route
  );
}

function repairSourceStems(
  edges: DiagramEdge[],
  routes: Map<string, Array<{ x: number; y: number }>>,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): void {
  for (const edge of edges) {
    const route = routes.get(edge.id);
    const sourceLead = renderedLeadPoint(
      edge.source,
      edge.sourcePort,
      nodesById,
      nodePositions,
      true,
      'source',
    );
    const targetLead = renderedLeadPoint(
      edge.target,
      edge.targetPort,
      nodesById,
      nodePositions,
      true,
      'target',
    );
    if (!route || !sourceLead || !targetLead) {
      continue;
    }

    const repaired = repairSourceStem(route, sourceLead, targetLead, nodesById, nodePositions);
    if (repaired) {
      routes.set(edge.id, repaired);
    }
  }
}

function repairSourceStem(
  route: Array<{ x: number; y: number }>,
  sourceLead: { point: { x: number; y: number }; side: ElkPortSide },
  targetLead: { point: { x: number; y: number }; side: ElkPortSide },
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> | undefined {
  const direction = forwardHorizontalDirection(sourceLead, targetLead);
  if (!direction || route.length < 3) {
    return undefined;
  }

  const source = sourceLead.point;
  if (!pointsEqual(route[0], source)) {
    return undefined;
  }

  const deduped = removeConsecutiveDuplicatePoints(route);
  if (deduped.length < 3 || !pointsEqual(deduped[0], source)) {
    return undefined;
  }

  const first = deduped[1];
  if (first.x !== source.x || first.y === source.y) {
    return undefined;
  }

  const stemX = source.x + direction * diagramSizing.gridSize * 2;
  if (
    (direction > 0 && stemX >= targetLead.point.x) ||
    (direction < 0 && stemX <= targetLead.point.x)
  ) {
    return undefined;
  }

  const candidate = removeRedundantRoutePoints(
    makeOrthogonalRoute([
      source,
      { x: stemX, y: source.y },
      ...deduped.slice(1).map((point) => (point.x === source.x ? { ...point, x: stemX } : point)),
    ]),
  );

  return routeIntersectsNodeInterior(candidate, nodesById, nodePositions) ? undefined : candidate;
}

function forwardHorizontalDirection(
  sourceLead: { point: { x: number; y: number }; side: ElkPortSide },
  targetLead: { point: { x: number; y: number }; side: ElkPortSide },
): 1 | -1 | undefined {
  if (
    sourceLead.side === 'EAST' &&
    targetLead.side === 'WEST' &&
    sourceLead.point.x < targetLead.point.x
  ) {
    return 1;
  }
  if (
    sourceLead.side === 'WEST' &&
    targetLead.side === 'EAST' &&
    sourceLead.point.x > targetLead.point.x
  ) {
    return -1;
  }
  return undefined;
}

function forwardHorizontalCandidates(
  source: { x: number; y: number },
  target: { x: number; y: number },
  direction: 1 | -1,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
): Array<Array<{ x: number; y: number }>> {
  const candidateXs = uniqueNumbers([target.x, snapToGrid((source.x + target.x) / 2), source.x]);
  const doglegs = candidateXs.map((x) =>
    removeRedundantRoutePoints(
      makeOrthogonalRoute([source, { x, y: source.y }, { x, y: target.y }, target]),
    ),
  );

  const minX = Math.min(source.x, target.x);
  const maxX = Math.max(source.x, target.x);
  const obstacles = routeObstacles(nodesById, nodePositions).filter(
    (rect) => rect.x < maxX && rect.x + rect.width > minX,
  );
  if (obstacles.length === 0) {
    return doglegs;
  }

  const turnX = source.x + direction * diagramSizing.gridSize;
  const laneYs = uniqueNumbers([
    snapToGrid(Math.max(...obstacles.map((rect) => rect.y + rect.height)) + diagramSizing.gridSize),
    snapToGrid(Math.min(...obstacles.map((rect) => rect.y)) - diagramSizing.gridSize),
  ]);
  const laneRoutes = laneYs
    .map((laneY) =>
      removeRedundantRoutePoints(
        makeOrthogonalRoute([
          source,
          { x: turnX, y: source.y },
          { x: turnX, y: laneY },
          { x: target.x, y: laneY },
          target,
        ]),
      ),
    )
    .sort((a, b) => routeManhattanLength(a) - routeManhattanLength(b));

  return [...doglegs, ...laneRoutes];
}

function routeManhattanLength(route: Array<{ x: number; y: number }>): number {
  return route.slice(0, -1).reduce((total, point, index) => {
    const next = route[index + 1];
    return total + Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
  }, 0);
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function routeIntersectsNodeInterior(
  route: Array<{ x: number; y: number }>,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
  excludeNodeIds?: Set<string>,
): boolean {
  const obstacles = routeObstacles(nodesById, nodePositions, excludeNodeIds);
  return route.slice(0, -1).some((point, index) => {
    const next = route[index + 1];
    return obstacles.some((rect) => segmentIntersectsRectInterior(point, next, rect));
  });
}

function routeObstacles(
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
  excludeNodeIds?: Set<string>,
): Array<{ x: number; y: number; width: number; height: number }> {
  const obstacles: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const [nodeId, node] of nodesById) {
    const position = nodePositions.get(nodeId);
    if (!position || excludeNodeIds?.has(nodeId)) {
      continue;
    }
    const dimensions = resolvedNodeDimensions(node);
    obstacles.push({ ...position, ...dimensions });
  }
  return obstacles;
}

function segmentIntersectsRectInterior(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const epsilon = 0.5;
  if (start.y === end.y) {
    const y = start.y;
    if (y <= rect.y + epsilon || y >= rect.y + rect.height - epsilon) {
      return false;
    }
    return (
      Math.min(start.x, end.x) < rect.x + rect.width - epsilon &&
      Math.max(start.x, end.x) > rect.x + epsilon
    );
  }
  if (start.x === end.x) {
    const x = start.x;
    if (x <= rect.x + epsilon || x >= rect.x + rect.width - epsilon) {
      return false;
    }
    return (
      Math.min(start.y, end.y) < rect.y + rect.height - epsilon &&
      Math.max(start.y, end.y) > rect.y + epsilon
    );
  }
  return false;
}

export function renderedLeadPoint(
  nodeId: string,
  portId: string | undefined,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>,
  includeLeadMargins = true,
  role: 'source' | 'target' = 'target',
): { point: { x: number; y: number }; side: ElkPortSide } | undefined {
  const node = nodesById.get(nodeId);
  const position = nodePositions.get(nodeId);
  if (!node || !position) {
    return undefined;
  }

  const elkNode = elkNodeForDiagramNode(node, includeLeadMargins);
  const port = elkNode.ports.find(
    (candidate) => candidate.id === endpointId(nodeId, portId, node, role),
  );
  if (!port || port.x === undefined || port.y === undefined) {
    return undefined;
  }

  const side = (port.properties['org.eclipse.elk.port.side'] ?? 'EAST') as ElkPortSide;
  return {
    point: {
      x: position.x - elkNode.layoutOffset.x + port.x,
      y: position.y - elkNode.layoutOffset.y + port.y,
    },
    side,
  };
}

function leadExtensionConnector(
  lead: { x: number; y: number },
  next: { x: number; y: number },
  side: ElkPortSide,
): { x: number; y: number } | undefined {
  if (side === 'EAST' || side === 'WEST') {
    if (lead.y === next.y) {
      return undefined;
    }
    const direction = side === 'EAST' ? 1 : -1;
    const nextIsOutward = direction > 0 ? next.x > lead.x : next.x < lead.x;
    return {
      x: nextIsOutward ? next.x : lead.x + direction * diagramSizing.gridSize,
      y: lead.y,
    };
  }
  if (lead.x === next.x) {
    return undefined;
  }
  const direction = side === 'SOUTH' ? 1 : -1;
  const nextIsOutward = direction > 0 ? next.y > lead.y : next.y < lead.y;
  return {
    x: lead.x,
    y: nextIsOutward ? next.y : lead.y + direction * diagramSizing.gridSize,
  };
}

function makeOrthogonalRoute(
  points: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  if (points.length < 2) {
    return points;
  }

  const orthogonal = [{ ...points[0] }];
  for (const point of points.slice(1)) {
    const previous = orthogonal[orthogonal.length - 1];
    if (previous.x === point.x || previous.y === point.y) {
      orthogonal.push({ ...point });
    } else {
      orthogonal.push({ x: point.x, y: previous.y }, { ...point });
    }
  }
  return orthogonal;
}

function removeRedundantRoutePoints(
  points: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  return removeConsecutiveDuplicatePoints(points).filter((point, index, deduped) => {
    if (index === 0 || index === deduped.length - 1) {
      return true;
    }
    const previous = deduped[index - 1];
    const next = deduped[index + 1];
    return (
      !(previous.x === point.x && point.x === next.x) &&
      !(previous.y === point.y && point.y === next.y)
    );
  });
}

// A boundary `port` node's `inout` direction exposes two independent attach
// points on its hexagonal skin (see PortNodeSvg): driving edges land on the
// left notch, edges reading the net leave from the right point. Every other
// node/port keeps its single base id — only this one case needs a second ELK
// port, so the suffix is opt-in via `node` + `role` rather than baked into
// every caller.
function endpointId(
  nodeId: string,
  portId: string | undefined,
  node?: DiagramNode,
  role?: 'source' | 'target',
): string {
  const base = endpointKey(nodeId, portId);
  if (role && node?.kind === 'port' && node.ports[0]?.direction === 'inout') {
    return `${base}::${role === 'target' ? 'in' : 'out'}`;
  }
  return base;
}

function netKey(edge: DiagramEdge): string {
  return edgeNetKey(edge);
}

function buildNodePlacementElkEdges(
  edges: DiagramEdge[],
  nodeIds: Set<string>,
  nodesById: Map<string, DiagramNode>,
): Array<{ id: string; sources: string[]; targets: string[] }> {
  return edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      sources: [endpointId(edge.source, edge.sourcePort, nodesById.get(edge.source), 'source')],
      targets: [endpointId(edge.target, edge.targetPort, nodesById.get(edge.target), 'target')],
    }));
}

function buildRoutingElkEdges(
  edges: DiagramEdge[],
  nodeIds: Set<string>,
  nodesById: Map<string, DiagramNode>,
): Array<{ id: string; sources: string[]; targets: string[] }> {
  const validEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const byNet = new Map<string, DiagramEdge[]>();
  for (const edge of validEdges) {
    const netEdges = byNet.get(netKey(edge)) ?? [];
    netEdges.push(edge);
    byNet.set(netKey(edge), netEdges);
  }

  const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
  for (const [key, netEdges] of byNet) {
    if (netEdges.length > 1) {
      elkEdges.push({
        id: `net:${key}`,
        sources: [
          endpointId(
            netEdges[0].source,
            netEdges[0].sourcePort,
            nodesById.get(netEdges[0].source),
            'source',
          ),
        ],
        targets: netEdges.map((edge) =>
          endpointId(edge.target, edge.targetPort, nodesById.get(edge.target), 'target'),
        ),
      });
    } else {
      const edge = netEdges[0];
      elkEdges.push({
        id: edge.id,
        sources: [endpointId(edge.source, edge.sourcePort, nodesById.get(edge.source), 'source')],
        targets: [endpointId(edge.target, edge.targetPort, nodesById.get(edge.target), 'target')],
      });
    }
  }
  return elkEdges;
}

type ElkEdgeWithSections = {
  id?: string;
  sources?: string[];
  targets?: string[];
  sections?: Array<{
    id?: string;
    startPoint?: { x: number; y: number };
    endPoint?: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
    incomingShape?: string;
    outgoingShape?: string;
    incomingSections?: string[];
    outgoingSections?: string[];
  }>;
};

function sectionPoints(
  section: NonNullable<ElkEdgeWithSections['sections']>[number],
): Array<{ x: number; y: number }> {
  if (!section.startPoint || !section.endPoint) {
    return [];
  }
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({
    x: snapToGrid(point.x),
    y: snapToGrid(point.y),
  }));
}

function stitchSections(
  sections: NonNullable<ElkEdgeWithSections['sections']>,
  sourceEndpoint: string,
  targetEndpoint: string,
): Array<{ x: number; y: number }> | undefined {
  const byId = new Map(
    sections.filter((section) => section.id).map((section) => [section.id!, section]),
  );
  const targetSections = sections.filter((section) => section.outgoingShape === targetEndpoint);

  for (const targetSection of targetSections) {
    const chain = [targetSection];
    let current = targetSection;
    const seen = new Set<string>();

    while (current.incomingShape !== sourceEndpoint && current.incomingSections?.length) {
      const previousId = current.incomingSections[0];
      if (!previousId || seen.has(previousId)) {
        break;
      }
      seen.add(previousId);
      const previous = byId.get(previousId);
      if (!previous) {
        break;
      }
      chain.unshift(previous);
      current = previous;
    }

    if (chain[0].incomingShape !== sourceEndpoint) {
      continue;
    }

    const stitched: Array<{ x: number; y: number }> = [];
    for (const section of chain) {
      const points = sectionPoints(section);
      if (points.length === 0) {
        continue;
      }
      if (stitched.length > 0) {
        points.shift();
      }
      stitched.push(...points);
    }

    if (stitched.length >= 2) {
      return removeConsecutiveDuplicatePoints(stitched);
    }
  }

  return undefined;
}

function removeConsecutiveDuplicatePoints(
  points: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  return points.filter((point, index) => {
    if (index === 0) {
      return true;
    }
    const previous = points[index - 1];
    return !pointsEqual(previous, point);
  });
}

function pointsEqual(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

export function projectElkRoutes(
  elkEdges: ElkEdgeWithSections[],
  diagramEdges: DiagramEdge[],
  nodesById?: Map<string, DiagramNode>,
): Map<string, Array<{ x: number; y: number }>> {
  const byNet = new Map<string, DiagramEdge[]>();
  for (const edge of diagramEdges) {
    const netEdges = byNet.get(netKey(edge)) ?? [];
    netEdges.push(edge);
    byNet.set(netKey(edge), netEdges);
  }

  const routes = new Map<string, Array<{ x: number; y: number }>>();
  for (const elkEdge of elkEdges) {
    if (!elkEdge.id || !elkEdge.sections?.length) {
      continue;
    }

    const candidates = elkEdge.id.startsWith('net:')
      ? (byNet.get(elkEdge.id.slice('net:'.length)) ?? [])
      : diagramEdges.filter((edge) => edge.id === elkEdge.id);

    for (const edge of candidates) {
      const source = endpointId(
        edge.source,
        edge.sourcePort,
        nodesById?.get(edge.source),
        'source',
      );
      const target = endpointId(
        edge.target,
        edge.targetPort,
        nodesById?.get(edge.target),
        'target',
      );
      const route = stitchSections(elkEdge.sections, source, target);
      if (route && route.length >= 2) {
        routes.set(edge.id, route);
      }
    }
  }
  return routes;
}

export function defaultNetCutLabel(
  edge: DiagramEdge,
  designModule: DesignModule,
  moduleLayout: SavedModuleLayout,
): string {
  // A name genuinely declared in the SV source always wins: it is the net's
  // real identity, and takes priority over any structural (port/instance/
  // register/bus) heuristic below, which only ever guesses a description.
  if (edge.metadata?.declaredNetName) {
    return edge.metadata.declaredNetName;
  }

  const sourceNode = designModule.nodes.find((node) => node.id === edge.source);
  const sourcePort = sourceNode ? sourcePortForEdge(sourceNode, edge) : undefined;
  const sourcePortLabel = cleanVisualLabel(
    sourcePort?.label ?? sourcePort?.name ?? edge.sourcePort,
  );

  if (sourceNode?.kind === 'port' && sourcePortLabel) {
    return sourcePortLabel;
  }

  if (sourceNode?.kind === 'instance') {
    const instanceLabel = cleanVisualLabel(sourceNode.label);
    if (instanceLabel && sourcePortLabel) {
      return `${instanceLabel}.${sourcePortLabel}`;
    }
  }

  if (sourceNode?.kind === 'register' || sourceNode?.kind === 'latch') {
    const label =
      cleanVisualLabel(sourceNode.label) ?? cleanVisualLabel(sourcePort?.connectedSignal);
    if (label) {
      return label;
    }
  }

  if (
    sourceNode?.kind === 'bus' ||
    sourceNode?.kind === 'struct' ||
    sourceNode?.kind === 'interface'
  ) {
    const label =
      cleanVisualLabel(edge.signal) ??
      cleanVisualLabel(sourcePort?.connectedSignal) ??
      cleanVisualLabel(sourceNode.label);
    if (label) {
      return label;
    }
  }

  return allocateNetLabel(moduleLayout);
}

// A label is 'declared' provenance only when it actually came from the SV
// source's own declared name for this net (see defaultNetCutLabel above) —
// every other branch (port/instance/register/bus heuristics, NET_n fallback)
// produces a tool-composed description that stays freely renameable.
function netCutOrigin(edge: DiagramEdge, label: string): 'declared' | 'synthetic' {
  return edge.metadata?.declaredNetName && edge.metadata.declaredNetName === label
    ? 'declared'
    : 'synthetic';
}

function mergeNetCutState(
  layout: SavedLayout,
  moduleName: string,
  edge: DiagramEdge,
  designModule: DesignModule,
  nodes?: PositionedNode[],
): SavedLayout {
  const netKey = edgeNetKey(edge);
  const existing = layout.modules[moduleName] ?? { nodes: {} };
  if (existing.netCuts?.[netKey]) {
    return layout;
  }

  // A manual cut freezes every real node currently on screen so the operation
  // does not disturb an established layout. First-open automatic cuts omit
  // `nodes`, allowing ELK to compute the initial layout with the cuts active.
  const next = nodes
    ? mergeNodePositions(
        layout,
        moduleName,
        nodes.map((node) => ({
          ...node,
          fixed: node.kind === 'netLabel' ? node.fixed : true,
        })),
      )
    : { version: 1 as const, modules: { ...layout.modules } };
  const nextModule = next.modules[moduleName] ?? { nodes: {} };
  const label = defaultNetCutLabel(edge, designModule, nextModule);
  next.modules[moduleName] = {
    ...nextModule,
    netCuts: {
      ...(nextModule.netCuts ?? {}),
      [netKey]: {
        label,
        source: {
          nodeId: edge.source,
          ...(edge.sourcePort ? { portId: edge.sourcePort } : {}),
        },
        ...(nodes ? { deferLabelPlacement: true } : {}),
        origin: netCutOrigin(edge, label),
        defaultLabel: label,
      },
    },
  };

  return next;
}

export function mergeNetCut(
  layout: SavedLayout,
  moduleName: string,
  edge: DiagramEdge,
  designModule: DesignModule,
  nodes: PositionedNode[],
): SavedLayout {
  return mergeNetCutState(layout, moduleName, edge, designModule, nodes);
}

// Cuts every one of the given edges' nets in one pass (used when the user
// batch-cuts a multi-wire selection), sharing a single node-position freeze so
// the rest of the diagram doesn't get re-frozen/re-read once per edge.
export function mergeNetCuts(
  layout: SavedLayout,
  moduleName: string,
  edges: DiagramEdge[],
  designModule: DesignModule,
  nodes: PositionedNode[],
): SavedLayout {
  return edges.reduce(
    (acc, edge) => mergeNetCut(acc, moduleName, edge, designModule, nodes),
    layout,
  );
}

/** Adds first-open cuts without pinning a pre-cut set of node positions. */
export function mergeFirstOpenNetCuts(
  layout: SavedLayout,
  moduleName: string,
  edges: DiagramEdge[],
  designModule: DesignModule,
): SavedLayout {
  return edges.reduce((acc, edge) => mergeNetCutState(acc, moduleName, edge, designModule), layout);
}

/**
 * Marks that the first-open auto net-cut decision has run for this module,
 * whether or not it found anything to cut. This is the explicit signal
 * callers must check instead of "no saved layout exists" — full-render
 * snapshots (mergeNodeSnapshot) make that condition true almost immediately,
 * well before a module has genuinely been opened and decided on.
 */
export function markFirstOpenHandled(layout: SavedLayout, moduleName: string): SavedLayout {
  const existing: SavedModuleLayout = layout.modules[moduleName] ?? { nodes: {} };
  if (existing.firstOpenHandled) {
    return layout;
  }
  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: { ...existing, firstOpenHandled: true },
    },
  };
}

/** Register ports (by `nodeId\0portId` and `nodeId\0portName`) whose net is that
 * register's own clock or reset signal, per the module's own node list only —
 * no hierarchy traversal. */
function directRegisterControlPorts(designModule: DesignModule): Set<string> {
  const registerControlPorts = new Set<string>();
  for (const node of designModule.nodes) {
    if (node.kind !== 'register') continue;
    const signals = [registerClockSignal(node), registerResetSignal(node)].filter(
      (signal): signal is string => Boolean(signal),
    );
    for (const port of node.ports) {
      if (
        signals.some(
          (signal) => port.name === signal || port.id === signal || port.connectedSignal === signal,
        )
      ) {
        registerControlPorts.add(`${node.id}\0${port.id}`);
        registerControlPorts.add(`${node.id}\0${port.name}`);
      }
    }
  }
  return registerControlPorts;
}

/**
 * Whether a net entering `instanceNode` at `targetPort` is that instance's
 * clock or reset control — determined by following the net into the
 * instantiated module and checking whether it lands on a register's own
 * clock/reset pin there, recursively through further instance boundaries.
 * This only recognizes genuine register-control nets (never guesses from an
 * instance port's name), so arbitrary instance inputs are never mistaken for
 * clock/reset.
 */
function instancePortFeedsRegisterControl(
  instanceNode: DiagramNode,
  targetPort: string,
  modules: Record<string, DesignModule>,
  visitedModules: Set<string>,
): boolean {
  if (instanceNode.kind !== 'instance' || !instanceNode.instanceOf) return false;
  if (visitedModules.has(instanceNode.instanceOf)) return false;

  const childModule = modules[instanceNode.instanceOf];
  if (!childModule) return false;

  const portName =
    instanceNode.ports.find((port) => port.id === targetPort || port.name === targetPort)?.name ??
    targetPort;
  const boundaryNode = childModule.nodes.find(
    (node) => node.kind === 'port' && node.ports.some((port) => port.name === portName),
  );
  if (!boundaryNode) return false;

  const childVisited = new Set(visitedModules).add(instanceNode.instanceOf);
  const childControlPorts = directRegisterControlPorts(childModule);
  const childNodesById = new Map(childModule.nodes.map((node) => [node.id, node]));

  for (const edge of childModule.edges) {
    if (edge.source !== boundaryNode.id || edge.targetPort === undefined) continue;
    if (childControlPorts.has(`${edge.target}\0${edge.targetPort}`)) {
      return true;
    }
    const childTargetNode = childNodesById.get(edge.target);
    if (
      childTargetNode &&
      instancePortFeedsRegisterControl(childTargetNode, edge.targetPort, modules, childVisited)
    ) {
      return true;
    }
  }
  return false;
}

/** Nets that form the computed default for a module with no saved layout.
 * `modules` (the rest of the design, keyed by module name) lets clock/reset
 * nets that terminate on a hierarchical instance port still get recognized,
 * by following the net into the instantiated module. */
export function firstOpenAutoCutEdges(
  designModule: DesignModule,
  includeClockAndReset: boolean,
  modules: Record<string, DesignModule> = {},
): DiagramEdge[] {
  const registerControlPorts = includeClockAndReset
    ? directRegisterControlPorts(designModule)
    : new Set<string>();

  const nodesById = new Map(designModule.nodes.map((node) => [node.id, node]));

  const selected: DiagramEdge[] = [];
  const selectedNets = new Set<string>();
  for (const edge of designModule.edges) {
    // Interface links (modport connections, member taps) stay whole on first
    // open — cutting them hides the interface's own port/modport grouping,
    // which is the whole point of looking at an interface node.
    const touchesInterface =
      nodesById.get(edge.source)?.kind === 'interface' ||
      nodesById.get(edge.target)?.kind === 'interface';
    if (touchesInterface) continue;
    let isRegisterControl =
      edge.targetPort !== undefined &&
      registerControlPorts.has(`${edge.target}\0${edge.targetPort}`);
    if (!isRegisterControl && includeClockAndReset && edge.targetPort !== undefined) {
      const targetNode = nodesById.get(edge.target);
      if (targetNode?.kind === 'instance') {
        isRegisterControl = instancePortFeedsRegisterControl(
          targetNode,
          edge.targetPort,
          modules,
          new Set(),
        );
      }
    }
    const isDeclared = Boolean(edge.metadata?.declaredNetName);
    const netKey = edgeNetKey(edge);
    if ((isRegisterControl || isDeclared) && !selectedNets.has(netKey)) {
      selected.push(edge);
      selectedNets.add(netKey);
    }
  }
  return selected;
}

export function renameCutNet(
  layout: SavedLayout,
  moduleName: string,
  netKey: string,
  label: string,
): SavedLayout {
  const trimmed = label.trim();
  if (!trimmed) {
    return layout;
  }

  const existing = layout.modules[moduleName];
  const cut = existing?.netCuts?.[netKey];
  if (!existing || !cut) {
    return layout;
  }

  // Declared nets keep their exact SV source name — renaming would make the
  // label lie about what the net is actually called in the design.
  if (cut.origin === 'declared') {
    return layout;
  }

  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: {
        ...existing,
        netCuts: {
          ...(existing.netCuts ?? {}),
          [netKey]: {
            ...cut,
            label: trimmed,
          },
        },
      },
    },
  };
}

// Resets a cut net's label back to whatever it defaulted to right after the
// cut — a no-op for a declared net (it was never allowed to diverge in the
// first place) or one that's already at its default.
export function revertCutNetLabel(
  layout: SavedLayout,
  moduleName: string,
  netKey: string,
): SavedLayout {
  const existing = layout.modules[moduleName];
  const cut = existing?.netCuts?.[netKey];
  if (!existing || !cut || cut.defaultLabel === undefined || cut.label === cut.defaultLabel) {
    return layout;
  }

  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: {
        ...existing,
        netCuts: {
          ...(existing.netCuts ?? {}),
          [netKey]: {
            ...cut,
            label: cut.defaultLabel,
          },
        },
      },
    },
  };
}

export function removeNetCut(layout: SavedLayout, moduleName: string, netKey: string): SavedLayout {
  const existing = layout.modules[moduleName];
  if (!existing?.netCuts?.[netKey]) {
    return layout;
  }

  const netCuts = { ...(existing.netCuts ?? {}) };
  delete netCuts[netKey];

  const sourceLabelId = cutLabelNodeId(netKey, 'source');
  const sinkLabelPrefix = cutLabelNodeId(netKey, 'sink');
  const sourceStubId = cutStubEdgeId(netKey, 'source');
  const sinkStubPrefix = cutStubEdgeId(netKey, 'sink');

  const nodes = Object.fromEntries(
    Object.entries(existing.nodes).filter(
      ([id]) => id !== sourceLabelId && !id.startsWith(sinkLabelPrefix),
    ),
  );
  const edges = existing.edges
    ? Object.fromEntries(
        Object.entries(existing.edges).filter(
          ([id]) => id !== sourceStubId && !id.startsWith(sinkStubPrefix),
        ),
      )
    : undefined;

  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: {
        ...existing,
        nodes,
        ...(Object.keys(netCuts).length > 0 ? { netCuts } : { netCuts: undefined }),
        ...(edges && Object.keys(edges).length > 0 ? { edges } : { edges: undefined }),
      },
    },
  };
}

// The "Reroute" control on a cut net's stub wire — unlike a real edge, there's
// no route to recompute (the stub is always a straight line), so this instead
// un-pins the dangling end's saved position, snapping it back to the
// geometry-derived spot right beside the port it's attached to (see
// makeCutLabelNode). Everything else in the saved layout is untouched.
export function resetCutLabelPosition(
  layout: SavedLayout,
  moduleName: string,
  labelNodeId: string,
): SavedLayout {
  const existing = layout.modules[moduleName];
  if (!existing?.nodes[labelNodeId]) {
    return layout;
  }

  const nodes = { ...existing.nodes };
  delete nodes[labelNodeId];

  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: {
        ...existing,
        nodes,
      },
    },
  };
}

function sourcePortForEdge(
  node: DiagramNode,
  edge: DiagramEdge,
): DiagramNode['ports'][number] | undefined {
  return (
    node.ports.find((port) => port.id === edge.sourcePort) ??
    node.ports.find((port) => port.name === edge.sourcePort) ??
    node.ports.find((port) => port.direction === 'output') ??
    node.ports[0]
  );
}

function cleanVisualLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function allocateNetLabel(moduleLayout: SavedModuleLayout): string {
  const used = new Set(Object.values(moduleLayout.netCuts ?? {}).map((cut) => cut.label.trim()));
  for (let index = 1; ; index += 1) {
    const candidate = `NET_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function mergeNodePositions(
  layout: SavedLayout,
  moduleName: string,
  nodes: PositionedNode[],
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules },
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  const activeIds = new Set(nodes.map((node) => node.id));
  const mergedNodes: SavedModuleLayout['nodes'] = {};

  for (const [id, value] of Object.entries(existing.nodes)) {
    // A cut-net label's saved entry only exists because *it* was explicitly
    // pinned (dragged); it must never be preserved (even as "stale") as a
    // side effect of some unrelated node no longer being in this batch — that
    // would silently convert a still-active, dynamically-tracked dangling
    // end into a permanently stuck one the next time anything else moves.
    if (!activeIds.has(id) && value.fixed && !isCutLabelNodeId(id)) {
      mergedNodes[id] = { ...value, stale: true };
    }
  }

  for (const node of nodes) {
    const isFixed = node.fixed || existing.nodes[node.id]?.fixed;
    if (isFixed) {
      mergedNodes[node.id] = {
        ...snapPosition(node.position, node.kind, structRole(node)),
        fixed: true,
        // `node.sizeOverride` reflects this node's full current resize state
        // (set, or explicitly absent after a revert) in every caller that
        // threads a complete node list through here — so it's safe to persist
        // verbatim rather than fall back to whatever was previously saved.
        ...(node.sizeOverride
          ? { width: node.sizeOverride.width, height: node.sizeOverride.height }
          : {}),
      };
    }
  }

  next.modules[moduleName] = {
    ...existing,
    nodes: mergedNodes,
  };
  return next;
}

/**
 * Full-render safety net: records every node's just-resolved position (not
 * only the ones the user has explicitly pinned) so a module that's been
 * looked at, but never dragged, still has a local record to recover from
 * after a crash. Unlike mergeNodePositions, this never marks anything
 * `fixed` — it only ever supplies a fallback position, never overriding Auto
 * Layout on the next render (see the `saved?.fixed` check in buildViewModel).
 * A node already pinned (`fixed: true`) is left untouched; synthetic net-cut
 * label nodes are skipped entirely — those are only ever meaningful once
 * pinned (see mergeNodePositions).
 */
export function mergeNodeSnapshot(
  layout: SavedLayout,
  moduleName: string,
  nodes: PositionedNode[],
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules },
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  const mergedNodes: SavedModuleLayout['nodes'] = {};

  for (const [id, value] of Object.entries(existing.nodes)) {
    if (value.fixed) {
      mergedNodes[id] = value;
    }
  }

  for (const node of nodes) {
    if (mergedNodes[node.id]?.fixed || isCutLabelNodeId(node.id)) {
      continue;
    }
    mergedNodes[node.id] = snapPosition(node.position, node.kind, structRole(node));
  }

  next.modules[moduleName] = {
    ...existing,
    nodes: mergedNodes,
  };
  return next;
}

/**
 * Edge counterpart to mergeNodeSnapshot: records every rendered edge's
 * just-computed route into `routeSnapshot`, never into `routePoints` — a
 * user-fixed `routePoints` entry (see mergeEdgeRoutePoints) always wins and
 * is left untouched, and `routeSnapshot` is only ever consulted in
 * buildViewModel as the last-resort fallback when neither libavoid nor ELK
 * produced a route this render. A cut-net stub edge is always a synthetic,
 * per-render straight line (see makeCutStubEdge), never something worth
 * snapshotting.
 */
export function mergeEdgeSnapshot(
  layout: SavedLayout,
  moduleName: string,
  edges: DiagramEdge[],
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules },
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  const mergedEdges: NonNullable<SavedModuleLayout['edges']> = { ...(existing.edges ?? {}) };

  for (const edge of edges) {
    if (isCutStubEdgeId(edge.id) || !edge.routePoints) continue;
    const saved = mergedEdges[edge.id];
    if (saved?.routePoints) continue;
    mergedEdges[edge.id] = { ...saved, routeSnapshot: edge.routePoints };
  }

  next.modules[moduleName] = {
    ...existing,
    edges: Object.keys(mergedEdges).length > 0 ? mergedEdges : undefined,
  };
  return next;
}

/**
 * Clears a node's manual resize override (the "revert to canonical" control)
 * while leaving its saved position/fixed state untouched — resizing and
 * position-pinning are orthogonal, so reverting size alone must not release
 * the node back to auto-layout.
 */
export function revertNodeSize(
  layout: SavedLayout,
  moduleName: string,
  nodeId: string,
): SavedLayout {
  const existing = layout.modules[moduleName];
  const saved = existing?.nodes[nodeId];
  if (!existing || !saved || (saved.width === undefined && saved.height === undefined)) {
    return layout;
  }

  const { width: _width, height: _height, ...rest } = saved;
  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: {
        ...existing,
        nodes: { ...existing.nodes, [nodeId]: rest },
      },
    },
  };
}

/** Clears the manual size override from every selected node in one update. */
export function revertNodeSizes(
  layout: SavedLayout,
  moduleName: string,
  nodeIds: string[],
): SavedLayout {
  return nodeIds.reduce(
    (nextLayout, nodeId) => revertNodeSize(nextLayout, moduleName, nodeId),
    layout,
  );
}

export function mergeRegionBounds(
  layout: SavedLayout,
  moduleName: string,
  regions: PositionedGenerateRegion[],
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules },
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  const activeIds = new Set(regions.map((region) => region.id));
  const mergedRegions: NonNullable<SavedModuleLayout['regions']> = {};

  for (const [id, value] of Object.entries(existing.regions ?? {})) {
    if (!activeIds.has(id) && value.fixed) {
      mergedRegions[id] = { ...value, stale: true };
    }
  }

  for (const region of regions) {
    if (region.fixed || existing.regions?.[region.id]?.fixed) {
      mergedRegions[region.id] = {
        x: Math.round(region.bounds.x),
        y: Math.round(region.bounds.y),
        width: Math.round(region.bounds.width),
        height: Math.round(region.bounds.height),
        fixed: true,
      };
    }
  }

  next.modules[moduleName] = {
    ...existing,
    regions: Object.keys(mergedRegions).length > 0 ? mergedRegions : undefined,
  };
  return next;
}

export function mergeRerouteLayout(
  layout: SavedLayout,
  moduleName: string,
  nodes: PositionedNode[],
): SavedLayout {
  // See mergeNetCut: freezing "the rest of the diagram" while rerouting must
  // not implicitly pin a net-cut label that was tracking its port dynamically.
  const fixedNodes = nodes.map((node) => ({
    ...node,
    fixed: node.kind === 'netLabel' ? node.fixed : true,
  }));
  const next = mergeNodePositions(layout, moduleName, fixedNodes);
  const existing = next.modules[moduleName] ?? { nodes: {} };
  const { edges: _edges, ...withoutEdges } = existing;

  next.modules[moduleName] = withoutEdges;
  return next;
}

export function mergeRerouteSingleEdge(
  layout: SavedLayout,
  moduleName: string,
  edgeId: string,
  nodes: PositionedNode[],
): SavedLayout {
  return mergeRerouteEdges(layout, moduleName, [edgeId], nodes);
}

// Like mergeRerouteSingleEdge but clears the saved route of every given edge in
// one pass (used when the user batch-reroutes a multi-wire selection).
export function mergeRerouteEdges(
  layout: SavedLayout,
  moduleName: string,
  edgeIds: string[],
  nodes: PositionedNode[],
): SavedLayout {
  // See mergeNetCut: freezing "the rest of the diagram" while rerouting must
  // not implicitly pin a net-cut label that was tracking its port dynamically.
  const fixedNodes = nodes.map((node) => ({
    ...node,
    fixed: node.kind === 'netLabel' ? node.fixed : true,
  }));
  const next = mergeNodePositions(layout, moduleName, fixedNodes);
  const existing = next.modules[moduleName] ?? { nodes: {} };
  const removeIds = new Set(edgeIds);
  const remainingEdges = Object.fromEntries(
    Object.entries(existing.edges ?? {}).filter(([edgeId]) => !removeIds.has(edgeId)),
  );

  next.modules[moduleName] = {
    ...existing,
    edges: Object.keys(remainingEdges).length > 0 ? remainingEdges : undefined,
  };
  return next;
}

// Releases just the given nodes back to ELK's auto-layout — their saved position
// is kept as a placement hint (not "fixed"), so ELK's interactive layered mode
// tends to settle them nearby unless the area is genuinely congested — while
// every other node in `nodes` (the webview's current on-screen positions) is
// (re-)frozen exactly where it is, the same way "Reroute All" freezes the whole
// diagram. Any edge touching a released node has its saved route cleared too, so
// it gets rerouted alongside the block(s) it connects to. This is the "Auto
// Layout" / localized re-layout action.
export function mergeRelayoutSelection(
  layout: SavedLayout,
  moduleName: string,
  nodeIds: string[],
  nodes: PositionedNode[],
  designModule: DesignModule,
): SavedLayout {
  const released = new Set(nodeIds);
  const existing: SavedModuleLayout = layout.modules[moduleName] ?? { nodes: {} };
  const activeIds = new Set(nodes.map((node) => node.id));
  const mergedNodes: SavedModuleLayout['nodes'] = {};

  for (const [id, value] of Object.entries(existing.nodes)) {
    if (released.has(id)) continue;
    // See mergeNodePositions: a cut-net label's pin must never be preserved
    // as a side effect of it not being part of this batch.
    if (!activeIds.has(id) && value.fixed && !isCutLabelNodeId(id)) {
      mergedNodes[id] = { ...value, stale: true };
    }
  }

  for (const node of nodes) {
    if (released.has(node.id)) {
      mergedNodes[node.id] = {
        ...snapPosition(node.position, node.kind, structRole(node)),
        fixed: false,
        ...(node.sizeOverride
          ? { width: node.sizeOverride.width, height: node.sizeOverride.height }
          : {}),
      };
      continue;
    }
    const isFixed = node.fixed || existing.nodes[node.id]?.fixed;
    if (isFixed) {
      mergedNodes[node.id] = {
        ...snapPosition(node.position, node.kind, structRole(node)),
        fixed: true,
        ...(node.sizeOverride
          ? { width: node.sizeOverride.width, height: node.sizeOverride.height }
          : {}),
      };
    }
  }

  const touchedEdgeIds = new Set(
    designModule.edges
      .filter((edge) => released.has(edge.source) || released.has(edge.target))
      .map((edge) => edge.id),
  );
  const remainingEdges = Object.fromEntries(
    Object.entries(existing.edges ?? {}).filter(([edgeId]) => !touchedEdgeIds.has(edgeId)),
  );

  // A manual cut deliberately leaves its ends where the wire was split, even
  // if the labels overlap. Auto Layout is the explicit point at which those
  // ends may start participating in placement. Activate a cut when the
  // selection contains one of its synthetic labels or either real endpoint.
  const placedCutKeys = new Set<string>();
  for (const node of nodes) {
    if (!released.has(node.id)) continue;
    const netKey = node.metadata?.cutNet?.netKey;
    if (netKey) placedCutKeys.add(netKey);
  }
  for (const [netKey, cut] of Object.entries(existing.netCuts ?? {})) {
    if (!cut.deferLabelPlacement) continue;
    if (
      released.has(cut.source.nodeId) ||
      designModule.edges.some(
        (edge) =>
          edgeNetKey(edge) === netKey &&
          edge.source === cut.source.nodeId &&
          edge.sourcePort === cut.source.portId &&
          released.has(edge.target),
      )
    ) {
      placedCutKeys.add(netKey);
    }
  }
  const netCuts =
    existing.netCuts &&
    Object.fromEntries(
      Object.entries(existing.netCuts).map(([netKey, cut]) => {
        if (!placedCutKeys.has(netKey)) return [netKey, cut];
        const { deferLabelPlacement: _deferred, ...placed } = cut;
        return [netKey, placed];
      }),
    );

  return {
    version: 1,
    modules: {
      ...layout.modules,
      [moduleName]: {
        ...existing,
        nodes: mergedNodes,
        edges: Object.keys(remainingEdges).length > 0 ? remainingEdges : undefined,
        netCuts,
      },
    },
  };
}

export function mergeEdgeWaypoint(
  layout: SavedLayout,
  moduleName: string,
  edgeId: string,
  waypoint: { x: number; y: number },
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules },
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  next.modules[moduleName] = {
    ...existing,
    edges: {
      ...(existing.edges ?? {}),
      [edgeId]: {
        waypoint: {
          x: Math.round(waypoint.x),
          y: Math.round(waypoint.y),
        },
      },
    },
  };
  return next;
}

export function mergeEdgeRoutePoints(
  layout: SavedLayout,
  moduleName: string,
  edgeId: string,
  routePoints: Array<{ x: number; y: number }>,
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules },
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  next.modules[moduleName] = {
    ...existing,
    edges: {
      ...(existing.edges ?? {}),
      [edgeId]: {
        routePoints: routePoints.map((point) => ({
          x: Math.round(point.x),
          y: Math.round(point.y),
        })),
      },
    },
  };
  return next;
}

function defaultPosition(index: number, kind: string): { x: number; y: number } {
  const column = kind === 'port' ? 0 : 1 + (index % 3);
  const row = Math.floor(index / 3);
  return {
    x: column * diagramSizing.columnGap,
    y: row * diagramSizing.rowGap + (kind === 'port' ? 0 : diagramSizing.nodeHeight / 2),
  };
}

export const diagramNodeSize = {
  width: diagramSizing.nodeWidth,
  height: diagramSizing.nodeHeight,
  gridSize: diagramSizing.gridSize,
};

function snapToGrid(value: number, kind?: string, role?: string): number {
  const grid = diagramSizing.gridSize;
  // port/literal nodes snap to half-grid (same formula as the webview snap formula).
  const isHalfGrid =
    kind === 'port' || kind === 'literal' || (kind === 'interface' && role === 'port');
  if (isHalfGrid) {
    return Math.round((value - grid / 2) / grid) * grid + grid / 2;
  }
  return Math.round(value / grid) * grid;
}

function snapToGridAtOrAfter(value: number, kind?: string, role?: string): number {
  const snapped = snapToGrid(value, kind, role);
  return snapped < value ? snapped + diagramSizing.gridSize : snapped;
}

function snapPosition(
  position: { x: number; y: number },
  kind?: string,
  role?: string,
): { x: number; y: number } {
  return {
    x: snapToGrid(position.x),
    y: snapToGrid(position.y, kind, role),
  };
}
