import type {
  DesignGraph,
  DesignModule,
  DiagramEdge,
  DiagramNode,
  DiagramViewModel,
  PositionedNode,
} from '../ir/types';
import type { SavedLayout, SavedModuleLayout } from '../storage/layoutStore';
import { edgeNetKey, endpointKey } from '../ir/edgeNet';
import { resolvedNodeDimensions } from '../diagram/nodeSizing';
import {
  buildViewModel,
  cutLabelEdgeStyle,
  cutLabelNodeId,
  cutStubEdgeId,
  defaultNetCutLabel,
  elkSideToHandleSide,
  labelPositionForHandlePoint,
  makeCutLabelNode,
  makeCutStubEdge,
  oppositeHandleSide,
  renderedLeadPoint,
  resolveCutLabelCollisions,
} from './mergeLayout';

/**
 * The whole state of one "Partial Diagram" pane (issue #403), living entirely
 * in the extension host and fully discarded when the pane closes — nothing
 * here is ever persisted. The partial is a derived, ephemeral view over a
 * single source module: a subset of its nodes, with every net cut except the
 * ones the user explicitly tied back together via the "extend" arrow.
 */
export interface PartialDiagramState {
  sourceModuleName: string;
  /** In insertion order — first entry is the node the pane was opened with. */
  includedNodeIds: string[];
  /**
   * Nets (by edgeNetKey over the *source* module's edge list) the user has
   * tied inside the partial. An edge is drawn as a real wire only when its
   * net is tied AND both its endpoints are included; every other edge
   * touching an included node renders as a cut end.
   */
  tiedNetKeys: string[];
}

interface PartialCutNet {
  netKey: string;
  label: string;
  origin: 'declared' | 'synthetic';
  /** Sorted by edge id, so label metadata is deterministic across rebuilds. */
  edges: DiagramEdge[];
}

interface PartialCutPlan {
  keptEdges: DiagramEdge[];
  cutNets: PartialCutNet[];
}

/**
 * Splits the source module's edges (restricted to those touching an included
 * node) into edges kept as real wires and nets rendered as cut ends. Label
 * text follows the same conventions as a manual net cut (defaultNetCutLabel),
 * with anonymous fallback labels (NET_n) deduplicated across the plan's nets.
 */
function buildPartialCutPlan(
  sourceModule: DesignModule,
  state: PartialDiagramState,
): PartialCutPlan {
  const included = new Set(state.includedNodeIds);
  const tied = new Set(state.tiedNetKeys);
  const keptEdges: DiagramEdge[] = [];
  const cutEdgesByNet = new Map<string, DiagramEdge[]>();
  const nodeIds = new Set(sourceModule.nodes.map((node) => node.id));

  for (const edge of sourceModule.edges) {
    // The extractor can leave edges whose endpoint node doesn't exist — e.g.
    // a struct breakout's boundary hub edge (`self.<base> -> struct:...`)
    // when the struct is really an internal net driven by an instance. The
    // main layout silently drops those (buildRoutingElkEdges filters on node
    // existence); apply the same validity rule here so a phantom endpoint
    // can't surface as a dangling cut end on the breakout's input.
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      continue;
    }
    const sourceIncluded = included.has(edge.source);
    const targetIncluded = included.has(edge.target);
    if (!sourceIncluded && !targetIncluded) {
      continue;
    }
    const netKey = edgeNetKey(edge);
    if (sourceIncluded && targetIncluded && tied.has(netKey)) {
      keptEdges.push(edge);
      continue;
    }
    const edges = cutEdgesByNet.get(netKey) ?? [];
    edges.push(edge);
    cutEdgesByNet.set(netKey, edges);
  }

  // Deterministic net order (and thus NET_n allocation order): by each net's
  // first sorted edge id, the same tie-break buildNetCutProjection uses.
  const sortedNets = [...cutEdgesByNet.entries()]
    .map(([netKey, edges]) => ({
      netKey,
      edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.edges[0].id.localeCompare(b.edges[0].id));

  const labelAccumulator: SavedModuleLayout = { nodes: {}, netCuts: {} };
  const cutNets: PartialCutNet[] = sortedNets.map(({ netKey, edges }) => {
    const first = edges[0];
    const label = defaultNetCutLabel(first, sourceModule, labelAccumulator);
    labelAccumulator.netCuts![netKey] = {
      label,
      source: { nodeId: first.source, ...(first.sourcePort ? { portId: first.sourcePort } : {}) },
    };
    const origin: 'declared' | 'synthetic' =
      first.metadata?.declaredNetName && first.metadata.declaredNetName === label
        ? 'declared'
        : 'synthetic';
    return { netKey, label, origin, edges };
  });

  return { keptEdges, cutNets };
}

/**
 * ELK margins reserving room next to each included endpoint for the cut
 * label about to be synthesized there — same idea as netCutPortMargins in
 * mergeLayout.ts, but for the partial's own (netCuts-independent) cut ends.
 */
function partialCutLabelMargins(
  plan: PartialCutPlan,
  includedNodeIds: ReadonlySet<string>,
): Map<string, Map<string, { width: number; height: number }>> {
  const byNode = new Map<string, Map<string, { width: number; height: number }>>();
  const reserve = (nodeId: string, portId: string | undefined, label: string) => {
    if (!portId || !includedNodeIds.has(nodeId)) return;
    const dimensions = resolvedNodeDimensions({
      id: 'cut-label-margin',
      kind: 'netLabel',
      label,
      ports: [],
    });
    const byPort = byNode.get(nodeId) ?? new Map<string, { width: number; height: number }>();
    byPort.set(portId, dimensions);
    byNode.set(nodeId, byPort);
  };
  for (const net of plan.cutNets) {
    for (const edge of net.edges) {
      reserve(edge.source, edge.sourcePort, net.label);
      reserve(edge.target, edge.targetPort, net.label);
    }
  }
  return byNode;
}

/**
 * Builds the partial pane's full render view: the included subset of the
 * source module laid out by the normal buildViewModel pipeline (nodes with a
 * `fixed` saved position stay locked — ELK's interactive mode only places
 * newcomers — and libavoid routes the tied wires), then the cut ends
 * synthesized in place at each included endpoint's rendered lead point.
 *
 * The cut ends deliberately bypass the module layout's netCuts mechanism:
 * that path requires the net's *source* node to be part of the module, but a
 * partial routinely includes only a net's sink side.
 */
export async function buildPartialViewModel(
  sourceModule: DesignModule,
  state: PartialDiagramState,
  layout: SavedLayout,
): Promise<DiagramViewModel> {
  const included = new Set(state.includedNodeIds);
  const plan = buildPartialCutPlan(sourceModule, state);

  const partialModule: DesignModule = {
    ...sourceModule,
    nodes: sourceModule.nodes.filter((node) => included.has(node.id)),
    edges: plan.keptEdges,
    // v1 keeps generate-region chrome out of the partial — regions reference
    // node sets that are mostly not included.
    generateRegions: undefined,
  };
  const graph: DesignGraph = {
    rootModules: [partialModule.name],
    modules: { [partialModule.name]: partialModule },
    diagnostics: [],
    generatedAt: '',
  };

  const moduleLayout = layout.modules[partialModule.name] ?? { nodes: {} };

  return buildViewModel(graph, partialModule.name, layout, {
    extraPortMargins: partialCutLabelMargins(plan, included),
    enforceFixedPeerPortSeparation: true,
    // Synthesized inside buildViewModel's own pre-routing pass (rather than
    // appended after it returns) so the cut-end labels become libavoid
    // obstacles for the tied wires — see buildNetCutProjection for the
    // regular-diagram equivalent this mirrors.
    extraCutObstacles: (positionedNodes) =>
      buildPartialCutObstacles(plan, included, partialModule.name, moduleLayout, positionedNodes),
  });
}

/**
 * Synthesizes the partial's cut-end labels and stub edges from the module's
 * post-ELK, pre-routing node positions, so buildViewModel can fold them into
 * the routing pass as obstacles — mirroring buildNetCutProjection, but keyed
 * off buildPartialCutPlan's cut nets instead of the module's saved netCuts.
 */
function buildPartialCutObstacles(
  plan: PartialCutPlan,
  included: ReadonlySet<string>,
  moduleName: string,
  moduleLayout: SavedModuleLayout,
  positionedNodes: PositionedNode[],
): { nodes: PositionedNode[]; edges: DiagramEdge[] } {
  const nodesById = new Map<string, DiagramNode>(positionedNodes.map((node) => [node.id, node]));
  const positions = new Map(positionedNodes.map((node) => [node.id, node.position]));
  const labels: PositionedNode[] = [];
  const stubs: DiagramEdge[] = [];
  const endpointByLabelId = new Map<string, string>();
  const seenSinkTargets = new Set<string>();

  for (const net of plan.cutNets) {
    const firstEdge = net.edges[0];

    if (included.has(firstEdge.source)) {
      const sourceLead = renderedLeadPoint(
        firstEdge.source,
        firstEdge.sourcePort,
        nodesById,
        positions,
        true,
        'source',
      );
      if (sourceLead) {
        const handleSide = oppositeHandleSide(elkSideToHandleSide(sourceLead.side));
        const labelId = cutLabelNodeId(net.netKey, 'source');
        labels.push(
          makeCutLabelNode(
            labelId,
            net.label,
            moduleName,
            {
              netKey: net.netKey,
              role: 'source',
              align: 'end',
              originalEdgeId: firstEdge.id,
              handleSide,
              edgeStyle: cutLabelEdgeStyle(firstEdge, nodesById),
              origin: net.origin,
            },
            moduleLayout,
            labelPositionForHandlePoint(sourceLead.point, handleSide, net.label),
            firstEdge,
          ),
        );
        endpointByLabelId.set(labelId, endpointKey(firstEdge.source, firstEdge.sourcePort));
        stubs.push(
          makeCutStubEdge({
            id: cutStubEdgeId(net.netKey, 'source'),
            template: firstEdge,
            source: firstEdge.source,
            sourcePort: firstEdge.sourcePort,
            target: labelId,
            targetPort: 'cut',
            netKey: net.netKey,
            role: 'source',
            originalEdgeId: firstEdge.id,
            moduleLayout,
          }),
        );
      }
    }

    for (const edge of net.edges) {
      if (!included.has(edge.target)) {
        continue;
      }
      const sinkDedupeKey = `${endpointKey(edge.target, edge.targetPort)}::${net.label}`;
      if (seenSinkTargets.has(sinkDedupeKey)) {
        continue;
      }
      const targetLead = renderedLeadPoint(
        edge.target,
        edge.targetPort,
        nodesById,
        positions,
        true,
        'target',
      );
      if (!targetLead) {
        continue;
      }
      seenSinkTargets.add(sinkDedupeKey);
      const handleSide = oppositeHandleSide(elkSideToHandleSide(targetLead.side));
      const labelId = cutLabelNodeId(net.netKey, 'sink', edge.id);
      labels.push(
        makeCutLabelNode(
          labelId,
          net.label,
          moduleName,
          {
            netKey: net.netKey,
            role: 'sink',
            align: 'start',
            originalEdgeId: edge.id,
            handleSide,
            edgeStyle: cutLabelEdgeStyle(edge, nodesById),
            origin: net.origin,
          },
          moduleLayout,
          labelPositionForHandlePoint(targetLead.point, handleSide, net.label),
          edge,
        ),
      );
      endpointByLabelId.set(labelId, endpointKey(edge.target, edge.targetPort));
      stubs.push(
        makeCutStubEdge({
          id: cutStubEdgeId(net.netKey, 'sink', edge.id),
          template: edge,
          source: labelId,
          sourcePort: 'cut',
          target: edge.target,
          targetPort: edge.targetPort,
          netKey: net.netKey,
          role: 'sink',
          originalEdgeId: edge.id,
          moduleLayout,
        }),
      );
    }
  }

  const resolvedLabels = resolveCutLabelCollisions(labels, positionedNodes, endpointByLabelId);

  return { nodes: resolvedLabels, edges: stubs };
}

/**
 * Drops one or more nodes from the partial (issue #408's "Remove" action).
 * Filtering includedNodeIds is the only state change needed: buildPartialCutPlan
 * re-derives cut vs. tied per edge from the current included set on every
 * rebuild, so a net that was tied through a removed node naturally reverts to
 * a cut end on its still-included peer, and a cut end that only pointed at
 * the removed node (an unexpanded net end of its own) simply stops rendering
 * — nothing else in the plan references it. tiedNetKeys is left untouched: if
 * the removed node is added back later, a net that was already tied through
 * it reties automatically, the same way any other already-tied net does the
 * moment both its ends are included again.
 */
export function removeNodesFromState(
  state: PartialDiagramState,
  nodeIds: readonly string[],
): PartialDiagramState {
  const remove = new Set(nodeIds);
  return {
    ...state,
    includedNodeIds: state.includedNodeIds.filter((id) => !remove.has(id)),
  };
}

/**
 * Resolves what an "extend" click on a cut end means against the *source*
 * module's full edge list: which node the clicked label was derived from
 * (used to pick the label's rendered edge style), and which nodes join the
 * partial when this net is tied. Since a net is either fully cut or fully
 * tied — there's no partially-cut-net mechanic — tying a fanout net brings in
 * *every* node it touches in one step, not just the branch the user clicked;
 * otherwise the still-outside branches would be left with a hanging cut end
 * on an already-tied net. Prefers the exact edge the clicked label was
 * derived from (originalEdgeId) for that display edge; falls back to the
 * net's first boundary edge. `newNodeIds` is empty when every node on the net
 * is already included — the extend then just ties the net.
 */
export function resolveExtendTarget(
  sourceModule: DesignModule,
  state: PartialDiagramState,
  netKey: string,
  originalEdgeId?: string,
): { edge: DiagramEdge; newNodeIds: string[] } | undefined {
  const included = new Set(state.includedNodeIds);
  const nodeIds = new Set(sourceModule.nodes.map((node) => node.id));
  // Same edge-validity rule as buildPartialCutPlan: an edge referencing a
  // node that doesn't exist never rendered anywhere, so it can't inform the
  // extend either.
  const netEdges = sourceModule.edges
    .filter(
      (edge) => edgeNetKey(edge) === netKey && nodeIds.has(edge.source) && nodeIds.has(edge.target),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (netEdges.length === 0) {
    return undefined;
  }
  const preferred = originalEdgeId
    ? netEdges.find((edge) => edge.id === originalEdgeId)
    : undefined;
  const boundary = netEdges.find((edge) => included.has(edge.source) !== included.has(edge.target));
  const edge = preferred ?? boundary ?? netEdges[0];
  const newNodeIds = [...new Set(netEdges.flatMap((e) => [e.source, e.target]))].filter(
    (id) => !included.has(id),
  );
  return { edge, newNodeIds };
}
