import type { DesignGraph, DiagramEdge, DiagramNode, DiagramViewModel, PositionedNode } from '../ir/types';
import type { SavedLayout, SavedModuleLayout } from '../storage/layoutStore';
import { diagramSizing } from '../diagram/constants';
import { diagramNodeDimensions } from '../diagram/nodeSizing';

interface AutoLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  routes: Map<string, Array<{ x: number; y: number }>>;
}

export async function buildViewModel(graph: DesignGraph, moduleName: string, layout: SavedLayout): Promise<DiagramViewModel> {
  const designModule = graph.modules[moduleName] ?? graph.modules[graph.rootModules[0]];
  if (!designModule) {
    return {
      moduleName,
      nodes: [],
      edges: [],
      diagnostics: graph.diagnostics
    };
  }

  const moduleLayout = layout.modules[designModule.name] ?? { nodes: {} };
  const elkLayout = await autoLayoutMissingNodes(designModule.nodes, designModule.edges, moduleLayout);
  const positioned = designModule.nodes.map((node, index): PositionedNode => {
    const saved = moduleLayout.nodes[node.id];
    const elk = elkLayout.positions.get(node.id);
    const fallback = defaultPosition(index, node.kind);

    const position = (saved?.fixed) 
      ? { x: saved.x, y: saved.y }
      : (elk ?? (saved ? { x: saved.x, y: saved.y } : fallback));

    return {
      ...node,
      fixed: saved?.fixed,
      position: snapPosition(position, node.kind)
    };
  });

  return {
    moduleName: designModule.name,
    nodes: positioned,
    edges: designModule.edges.map((edge) => ({
      ...edge,
      waypoint: moduleLayout.edges?.[edge.id]?.waypoint,
      routePoints: moduleLayout.edges?.[edge.id]?.routePoints ?? elkLayout.routes.get(edge.id)
    })),
    diagnostics: graph.diagnostics
  };
}

async function autoLayoutMissingNodes(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  moduleLayout: SavedModuleLayout
): Promise<AutoLayoutResult> {
  const positions = new Map<string, { x: number; y: number }>();
  const routes = new Map<string, Array<{ x: number; y: number }>>();
  const missingIds = new Set(nodes.filter((node) => !moduleLayout.nodes[node.id]).map((node) => node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodes.length === 0) {
    return { positions, routes };
  }

  try {
    const elkModule = await import('elkjs/lib/elk.bundled.js');
    const Elk = elkModule.default;
    const elk = new Elk();
    const graph = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': diagramSizing.sameLayerNodeSeparation.toString(),
        'elk.layered.spacing.nodeNodeBetweenLayers': diagramSizing.minNodeSeparation.toString(),
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.interactive': 'true',
        'elk.layered.crossingMinimization.semiInteractive': 'true'
      },
      children: nodes.map((node) => ({
        id: node.id,
        width: diagramNodeDimensions(node).width,
        height: diagramNodeDimensions(node).height,
        ports: node.ports.map((port, index) => {
          let side = port.direction === 'output' ? 'EAST' : 'WEST';
          if (node.kind === 'port') {
            side = port.direction === 'output' ? 'WEST' : 'EAST';
          }
          return {
            id: node.id + ':' + port.id,
            width: 1,
            height: 1,
            properties: {
              'org.eclipse.elk.port.side': side,
              'org.eclipse.elk.port.index': side === 'EAST' ? index : node.ports.length - index
            }
          };
        }),
        properties: {
          'org.eclipse.elk.portConstraints': 'FIXED_ORDER',
          ...(moduleLayout.nodes[node.id]?.fixed
            ? {
              'org.eclipse.elk.position': 'FIXED'
            }
            : {})
        },
        ...(moduleLayout.nodes[node.id]
          ? {
            x: moduleLayout.nodes[node.id].x,
            y: moduleLayout.nodes[node.id].y
          }
          : {})
      })),
      edges: buildNodePlacementElkEdges(edges, nodeIds)
    });

    for (const child of graph.children ?? []) {
      if (child.id && child.x !== undefined && child.y !== undefined) {
        const node = nodes.find((n) => n.id === child.id);
        positions.set(child.id, snapPosition({ x: child.x, y: child.y }, node?.kind));
      }
    }

    const branchedEdgeIds = branchedNetEdgeIds(edges);
    const routeGraph = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.interactive': 'true'
      },
      children: nodes.map((node, index) => {
        const graphChild = graph.children?.find((child) => child.id === node.id);
        const saved = moduleLayout.nodes[node.id];
        const fallback = defaultPosition(index, node.kind);
        const position = saved
          ? { x: saved.x, y: saved.y }
          : graphChild?.x !== undefined && graphChild.y !== undefined
            ? { x: graphChild.x, y: graphChild.y }
            : fallback;
        return {
          ...elkNodeForDiagramNode(node),
          x: position.x,
          y: position.y,
          properties: {
            ...elkNodeForDiagramNode(node).properties,
            'org.eclipse.elk.position': 'FIXED'
          }
        };
      }),
      edges: buildBranchedElkEdges(edges, nodeIds)
    });

    for (const [edgeId, route] of projectElkRoutes(routeGraph.edges ?? [], edges)) {
      if (!moduleLayout.edges?.[edgeId]?.routePoints) {
        if (branchedEdgeIds.has(edgeId)) {
          routes.set(edgeId, route);
        }
      }
    }
  } catch {
    return { positions, routes };
  }

  return { positions, routes };
}

function elkNodeForDiagramNode(node: DiagramNode): {
  id: string;
  width: number;
  height: number;
  ports: Array<{
    id: string;
    width: number;
    height: number;
    properties: Record<string, string>;
  }>;
  properties: Record<string, string>;
} {
  return {
    id: node.id,
    width: diagramNodeDimensions(node).width,
    height: diagramNodeDimensions(node).height,
    ports: node.ports.map((port, index) => {
      let side = port.direction === 'output' ? 'EAST' : 'WEST';
      if (node.kind === 'port') {
        side = port.direction === 'output' ? 'WEST' : 'EAST';
      }
      return {
        id: node.id + ':' + port.id,
        width: 1,
        height: 1,
        properties: {
          'org.eclipse.elk.port.side': side,
          'org.eclipse.elk.port.index': (side === 'EAST' ? index : node.ports.length - index).toString()
        }
      };
    }),
    properties: {
      'org.eclipse.elk.portConstraints': 'FIXED_ORDER'
    }
  };
}

function endpointId(nodeId: string, portId?: string): string {
  return portId ? `${nodeId}:${portId}` : nodeId;
}

function netKey(edge: DiagramEdge): string {
  return endpointId(edge.source, edge.sourcePort);
}

function buildNodePlacementElkEdges(edges: DiagramEdge[], nodeIds: Set<string>): Array<{ id: string; sources: string[]; targets: string[] }> {
  return edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      sources: [endpointId(edge.source, edge.sourcePort)],
      targets: [endpointId(edge.target, edge.targetPort)]
    }));
}

function buildBranchedElkEdges(edges: DiagramEdge[], nodeIds: Set<string>): Array<{ id: string; sources: string[]; targets: string[] }> {
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
        sources: [endpointId(netEdges[0].source, netEdges[0].sourcePort)],
        targets: netEdges.map((edge) => endpointId(edge.target, edge.targetPort))
      });
    }
  }
  return elkEdges;
}

function branchedNetEdgeIds(edges: DiagramEdge[]): Set<string> {
  const byNet = new Map<string, DiagramEdge[]>();
  for (const edge of edges) {
    const netEdges = byNet.get(netKey(edge)) ?? [];
    netEdges.push(edge);
    byNet.set(netKey(edge), netEdges);
  }

  const ids = new Set<string>();
  for (const netEdges of byNet.values()) {
    if (netEdges.length <= 1) {
      continue;
    }
    for (const edge of netEdges) {
      ids.add(edge.id);
    }
  }
  return ids;
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

function sectionPoints(section: NonNullable<ElkEdgeWithSections['sections']>[number]): Array<{ x: number; y: number }> {
  if (!section.startPoint || !section.endPoint) {
    return [];
  }
  return [
    section.startPoint,
    ...(section.bendPoints ?? []),
    section.endPoint
  ].map((point) => ({
    x: snapToGrid(point.x),
    y: snapToGrid(point.y)
  }));
}

function stitchSections(
  sections: NonNullable<ElkEdgeWithSections['sections']>,
  sourceEndpoint: string,
  targetEndpoint: string
): Array<{ x: number; y: number }> | undefined {
  const byId = new Map(sections.filter((section) => section.id).map((section) => [section.id!, section]));
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

function removeConsecutiveDuplicatePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return points.filter((point, index) => {
    if (index === 0) {
      return true;
    }
    const previous = points[index - 1];
    return previous.x !== point.x || previous.y !== point.y;
  });
}

export function projectElkRoutes(
  elkEdges: ElkEdgeWithSections[],
  diagramEdges: DiagramEdge[]
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
      ? byNet.get(elkEdge.id.slice('net:'.length)) ?? []
      : diagramEdges.filter((edge) => edge.id === elkEdge.id);

    for (const edge of candidates) {
      const source = endpointId(edge.source, edge.sourcePort);
      const target = endpointId(edge.target, edge.targetPort);
      const route = stitchSections(elkEdge.sections, source, target);
      if (route && route.length >= 2) {
        routes.set(edge.id, route);
      }
    }
  }
  return routes;
}

export function mergeNodePositions(layout: SavedLayout, moduleName: string, nodes: PositionedNode[]): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules }
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  const activeIds = new Set(nodes.map((node) => node.id));
  const mergedNodes: SavedModuleLayout['nodes'] = {};

  for (const [id, value] of Object.entries(existing.nodes)) {
    if (!activeIds.has(id) && value.fixed) {
      mergedNodes[id] = { ...value, stale: true };
    }
  }

  for (const node of nodes) {
    const isFixed = node.fixed || existing.nodes[node.id]?.fixed;
    if (isFixed) {
      mergedNodes[node.id] = {
        x: snapToGrid(node.position.x),
        y: snapToGrid(node.position.y, node.kind),
        fixed: true
      };
    }
  }

  next.modules[moduleName] = {
    ...existing,
    nodes: mergedNodes
  };
  return next;
}

export function mergeEdgeWaypoint(
  layout: SavedLayout,
  moduleName: string,
  edgeId: string,
  waypoint: { x: number; y: number }
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules }
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  next.modules[moduleName] = {
    ...existing,
    edges: {
      ...(existing.edges ?? {}),
      [edgeId]: {
        waypoint: {
          x: Math.round(waypoint.x),
          y: Math.round(waypoint.y)
        }
      }
    }
  };
  return next;
}

export function mergeEdgeRoutePoints(
  layout: SavedLayout,
  moduleName: string,
  edgeId: string,
  routePoints: Array<{ x: number; y: number }>
): SavedLayout {
  const next: SavedLayout = {
    version: 1,
    modules: { ...layout.modules }
  };
  const existing: SavedModuleLayout = next.modules[moduleName] ?? { nodes: {} };
  next.modules[moduleName] = {
    ...existing,
    edges: {
      ...(existing.edges ?? {}),
      [edgeId]: {
        routePoints: routePoints.map((point) => ({
          x: Math.round(point.x),
          y: Math.round(point.y)
        }))
      }
    }
  };
  return next;
}

function defaultPosition(index: number, kind: string): { x: number; y: number } {
  const column = kind === 'port' ? 0 : 1 + (index % 3);
  const row = Math.floor(index / 3);
  return {
    x: column * diagramSizing.columnGap,
    y: row * diagramSizing.rowGap + (kind === 'port' ? 0 : diagramSizing.nodeHeight / 2)
  };
}

export const diagramNodeSize = {
  width: diagramSizing.nodeWidth,
  height: diagramSizing.nodeHeight,
  gridSize: diagramSizing.gridSize
};

function snapToGrid(value: number, kind?: string): number {
  const grid = diagramSizing.gridSize;
  if (kind === 'port' || kind === 'literal') {
    return Math.round((value - grid / 2) / grid) * grid + grid / 2;
  }
  return Math.round(value / grid) * grid;
}

function snapPosition(position: { x: number; y: number }, kind?: string): { x: number; y: number } {
  return {
    x: snapToGrid(position.x),
    y: snapToGrid(position.y, kind)
  };
}
