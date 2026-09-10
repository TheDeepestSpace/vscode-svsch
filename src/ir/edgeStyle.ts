import type { DiagramEdge, DiagramNode, DiagramPort } from './types';

/**
 * True when a declared range can span more than one bit: a numeric range like
 * [7:0], or a symbolic range like [X:0] whose parameter may still exceed zero
 * at elaboration time. A constant single-bit range ([0:0], [3:3]) stays false.
 */
export function widthIsPotentiallyMultiBit(width: string | undefined): boolean {
  if (!width || width === 'interface') {
    return false;
  }
  const range = width.match(/^\s*\[\s*([^:[\]]+?)\s*:\s*([^:[\]]+?)\s*\]\s*$/);
  if (!range) {
    // Multi-dimensional packed ranges (e.g. [7:0][3:0]) are always multi-bit.
    return width.includes('][');
  }
  const msb = Number(range[1]);
  const lsb = Number(range[2]);
  if (Number.isFinite(msb) && Number.isFinite(lsb)) {
    return msb !== lsb;
  }
  return true;
}

export function portSuggestsThickWire(port: DiagramPort | undefined): boolean {
  if (!port || port.width === 'interface' || port.modportName !== undefined) {
    return false;
  }
  // Named typedefs (enums in particular) carry no width on the port itself.
  if (port.typeName !== undefined) {
    return true;
  }
  return widthIsPotentiallyMultiBit(port.width) || widthIsPotentiallyMultiBit(port.widthExpression);
}

function findPort(
  node: Pick<DiagramNode, 'ports'> | undefined,
  portId: string | undefined,
): DiagramPort | undefined {
  if (!node || !portId) {
    return undefined;
  }
  return (
    node.ports.find((port) => port.id === portId) ?? node.ports.find((port) => port.name === portId)
  );
}

/**
 * Array nodes whose elements are (or can be) wider than one bit render their
 * stacked layers with a wider diagonal spread, matching the thicker wires.
 *
 * The graph pipeline stamps `metadata.stackWide` via {@link annotateWireStyles};
 * the port heuristic below only backs up views built without that pass
 * (synthetic test fixtures).
 */
export function nodeStackIsWide(
  node: Pick<DiagramNode, 'ports' | 'metadata'> | undefined,
): boolean {
  if (!node) {
    return false;
  }
  if (node.metadata?.stackWide !== undefined) {
    return node.metadata.stackWide === true;
  }
  const cutStyle = node.metadata?.cutNet?.edgeStyle;
  if (cutStyle) {
    return cutStyle.thick === true;
  }
  return node.ports.some(portSuggestsThickWire);
}

/**
 * Wires that are (or can be) wider than one bit render with a thicker stroke.
 * Struct and interface aggregates are excluded — they have their own striped style.
 *
 * The graph pipeline stamps `metadata.thick` via {@link annotateWireStyles};
 * the width/port heuristic below only backs up views built without that pass.
 */
export function edgeIsThick(
  edge: DiagramEdge | undefined,
  sourceNode?: Pick<DiagramNode, 'ports'>,
  targetNode?: Pick<DiagramNode, 'ports'>,
): boolean {
  if (!edge) {
    return false;
  }
  const aggregate = edge.metadata?.aggregate;
  if (aggregate === 'struct' || aggregate === 'interface') {
    return false;
  }
  if (edge.metadata?.thick !== undefined) {
    return edge.metadata.thick === true;
  }
  if (widthIsPotentiallyMultiBit(edge.width)) {
    return true;
  }
  return (
    portSuggestsThickWire(findPort(sourceNode, edge.sourcePort)) ||
    portSuggestsThickWire(findPort(targetNode, edge.targetPort))
  );
}

function nodeIsArrayLike(node: DiagramNode): boolean {
  return (
    node.isArrayNode === true ||
    node.metadata?.isArrayNode === true ||
    (node.kind === 'bus' && node.metadata?.aggregateKind === 'array')
  );
}

/**
 * Graph-pipeline pass: stamp the wire-style classification onto the graph so
 * renderers read a single authoritative flag instead of re-deriving it from
 * widths and type names in every code path.
 *
 * - `edge.metadata.thick`: the wire is (or can be) wider than one bit. This is
 *   derived per edge from its own width/ports — it never spreads across a
 *   stacked component, so a single-bit control wire (e.g. a shared `clk`)
 *   that happens to fan into a wide array node stays thin.
 * - `node.metadata.stackWide`: an array node whose stacked layers spread with
 *   the wide offset. A stacked component qualifies through any port or edge
 *   with a known multi-bit width; the classification then reaches synthesized
 *   mux/register nodes whose element widths are missing. Unstacked edges keep
 *   scalarization boundaries from joining components.
 */
export function annotateWireStyles(module: { nodes: DiagramNode[]; edges: DiagramEdge[] }): void {
  const nodesById = new Map(module.nodes.map((node) => [node.id, node]));
  const thickEdges = new Set<DiagramEdge>();

  // Connections that carry a whole interface (module interface port to an
  // interface-typed instance pin) route in the interface style even without
  // an interface instance endpoint. Runs before the thick pass so aggregate
  // edges are excluded from it.
  for (const edge of module.edges) {
    if (edge.metadata?.aggregate) {
      continue;
    }
    const src = findPort(nodesById.get(edge.source), edge.sourcePort);
    const tgt = findPort(nodesById.get(edge.target), edge.targetPort);
    const carriesInterface =
      edge.width === 'interface' ||
      src?.width === 'interface' ||
      tgt?.width === 'interface' ||
      src?.modportName !== undefined ||
      tgt?.modportName !== undefined;
    if (carriesInterface) {
      edge.metadata = { ...(edge.metadata ?? {}), aggregate: 'interface' };
    }
  }

  for (const edge of module.edges) {
    if (edgeIsThick(edge, nodesById.get(edge.source), nodesById.get(edge.target))) {
      thickEdges.add(edge);
      // Only positive stamps: absence falls back to the render-time heuristic,
      // which reaches the same verdict, so baselines stay free of noise.
      edge.metadata = { ...(edge.metadata ?? {}), thick: true };
    }
  }

  // A stacked edge represents the same array-valued path on both sides of an
  // array node. Synthesized mux/register ports can lose the element width, so
  // treating each edge independently makes a wide stack become narrow partway
  // through a chain. Normalize every connected component made exclusively of
  // stacked edges instead; ordinary edges remain hard component boundaries.
  const stackedEdgesByNode = new Map<string, DiagramEdge[]>();
  for (const edge of module.edges) {
    if (edge.isStacked !== true) {
      continue;
    }
    for (const nodeId of [edge.source, edge.target]) {
      const incident = stackedEdgesByNode.get(nodeId) ?? [];
      incident.push(edge);
      stackedEdgesByNode.set(nodeId, incident);
    }
  }

  const visited = new Set<DiagramEdge>();
  for (const firstEdge of module.edges) {
    if (firstEdge.isStacked !== true || visited.has(firstEdge)) {
      continue;
    }

    const componentEdges: DiagramEdge[] = [];
    const componentNodeIds = new Set<string>();
    const pending = [firstEdge];
    let wide = false;

    while (pending.length > 0) {
      const edge = pending.pop()!;
      if (visited.has(edge)) {
        continue;
      }
      visited.add(edge);
      componentEdges.push(edge);
      wide ||= thickEdges.has(edge);

      for (const nodeId of [edge.source, edge.target]) {
        if (componentNodeIds.has(nodeId)) {
          continue;
        }
        componentNodeIds.add(nodeId);
        const node = nodesById.get(nodeId);
        wide ||= node?.ports.some(portSuggestsThickWire) === true;
        for (const incident of stackedEdgesByNode.get(nodeId) ?? []) {
          if (!visited.has(incident)) {
            pending.push(incident);
          }
        }
      }
    }

    if (!wide) {
      continue;
    }

    // Only the array nodes' layer spacing spreads across the whole component.
    // Each edge's own thick-wire classification (computed above from its own
    // width/ports) is left alone — a stacked component can carry a mix of
    // wide data edges and narrow control edges (e.g. a shared `clk` fanning
    // into every element of a wide register array), and only the former
    // should render as thick wires.
    for (const nodeId of componentNodeIds) {
      const node = nodesById.get(nodeId);
      if (node && nodeIsArrayLike(node)) {
        node.metadata = { ...(node.metadata ?? {}), stackWide: true };
      }
    }
  }
}
