import type { DesignGraph, DiagramEdge, DiagramNode, DiagramViewModel, PositionedNode } from '../ir/types';
import type { SavedLayout, SavedModuleLayout } from '../storage/layoutStore';
import { diagramSizing } from '../diagram/constants';
import { diagramNodeDimensions } from '../diagram/nodeSizing';

interface AutoLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  routes: Map<string, Array<{ x: number; y: number }>>;
}

type ElkPortSide = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

interface ElkDiagramNode {
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
  const routePositions = new Map<string, { x: number; y: number }>();
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
        'elk.layered.crossingMinimization.semiInteractive': 'true',
        'elk.layered.concentrateEdges': 'true',
        'elk.layered.improveHyperedgeRoutes': 'true',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS'
      },
      children: nodes.map((node) => {
        const { layoutOffset, ...elkNode } = elkNodeForDiagramNode(node, true);
        const saved = moduleLayout.nodes[node.id];
        return {
          ...elkNode,
          properties: {
            ...elkNode.properties,
            ...(saved?.fixed
              ? {
                'org.eclipse.elk.position': 'FIXED'
              }
              : {})
          },
          layoutOptions: {
            ...elkNode.layoutOptions,
            ...(saved?.fixed
              ? {
                'elk.position': 'FIXED',
                'org.eclipse.elk.position': 'FIXED'
              }
              : {})
          },
          ...(saved
            ? {
              x: saved.x - layoutOffset.x,
              y: saved.y - layoutOffset.y
            }
            : {})
        };
      }),
      edges: buildNodePlacementElkEdges(edges, nodeIds)
    });

    for (const child of graph.children ?? []) {
      if (child.id && child.x !== undefined && child.y !== undefined) {
        const node = nodes.find((n) => n.id === child.id);
        const offset = node ? elkNodeForDiagramNode(node, true).layoutOffset : { x: 0, y: 0 };
        positions.set(child.id, snapPosition({ x: child.x + offset.x, y: child.y + offset.y }, node?.kind));
      }
    }
    alignSimpleLeafNodes(nodes, edges, positions, moduleLayout);

    const routeGraph = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.interactive': 'true',
        'elk.layered.concentrateEdges': 'true',
        'elk.layered.improveHyperedgeRoutes': 'true',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
        'elk.layered.spacing.edgeEdge': (diagramSizing.gridSize / 2).toString(),
        'elk.spacing.portPort': (diagramSizing.gridSize / 2).toString()
      },
      children: nodes.map((node, index) => {
        const graphChild = graph.children?.find((child) => child.id === node.id);
        const saved = moduleLayout.nodes[node.id];
        const fallback = defaultPosition(index, node.kind);
        const position = saved?.fixed
          ? { x: saved.x, y: saved.y }
          : positions.get(node.id) ?? (saved ? { x: saved.x, y: saved.y } : undefined) ?? (graphChild?.x !== undefined && graphChild.y !== undefined
            ? { x: graphChild.x, y: graphChild.y }
            : fallback);
        routePositions.set(node.id, position);
        const { layoutOffset, ...elkNode } = elkNodeForDiagramNode(node, true);
        return {
          ...elkNode,
          x: position.x - layoutOffset.x,
          y: position.y - layoutOffset.y,
          properties: {
            ...elkNode.properties,
            'org.eclipse.elk.position': 'FIXED'
          },
          layoutOptions: {
            ...elkNode.layoutOptions,
            'elk.position': 'FIXED',
            'org.eclipse.elk.position': 'FIXED'
          }
        };
      }),
      edges: buildRoutingElkEdges(edges, nodeIds)
    });

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const projectedRoutes = projectElkRoutes(routeGraph.edges ?? [], edges);
    for (const [edgeId, route] of projectedRoutes) {
      if (!moduleLayout.edges?.[edgeId]?.routePoints) {
        const edge = edges.find((candidate) => candidate.id === edgeId);
        routes.set(edgeId, edge ? routeWithRenderedLeads(edge, route, nodesById, routePositions) : route);
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
  } catch {
    return { positions, routes };
  }

  return { positions, routes };
}

function elkNodeForDiagramNode(node: DiagramNode, includeLeadMargins = false): ElkDiagramNode {
  const { width, height } = diagramNodeDimensions(node);
  const grid = diagramSizing.gridSize;
  const inputs = node.ports.filter((port) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown');
  const outputs = node.ports.filter((port) => port.direction === 'output');

  const portGeometry = node.ports.map((port, index) => {
    let side: ElkPortSide = port.direction === 'output' ? 'EAST' : 'WEST';
    if (node.kind === 'port') {
      side = port.direction === 'output' ? 'WEST' : 'EAST';
    }

    let portX = side === 'WEST' ? 0 : width;
    let portY = height / 2;

    if (node.kind === 'register') {
      const registerClockSignal = typeof node.metadata?.clockSignal === 'string' ? node.metadata.clockSignal : undefined;
      const registerResetSignal = typeof node.metadata?.resetSignal === 'string' ? node.metadata.resetSignal : undefined;
      const inputs = node.ports.filter((p) => p.direction === 'input' || p.direction === 'inout' || p.direction === 'unknown');
      const isReset = port.name === 'R' || port.name === registerResetSignal;
      const isClock = port.name === registerClockSignal || (!isReset && port.name !== 'D' && port.name !== 'Q' && port.name !== 'RV' && inputs.indexOf(port) === 1);
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
      const inputs = node.ports.filter(p => p.direction !== 'output');
      const isSelect = port.id === inputs[0]?.id;
      if (isSelect) {
        side = 'NORTH';
        portX = width / 2;
        portY = 0;
      } else if (port.direction === 'output') {
        portY = height / 2;
      } else {
        const sideInputIndex = inputs.indexOf(port) - 1;
        const heightUnits = Math.max(1, Math.round(height / grid));
        const startUnit = Math.max(1, Math.ceil((heightUnits - (inputs.length - 1) + 1) / 2));
        portY = grid * (startUnit + sideInputIndex);
      }
    } else if (node.kind === 'port') {
      portY = diagramSizing.portHeight / 2;
    } else if (node.kind === 'bus' || node.kind === 'struct') {
      const structRole = typeof node.metadata?.role === 'string' ? node.metadata.role : undefined;
      const isComposition = node.kind === 'struct'
        ? structRole === 'composition'
        : inputs.length > 1;
      const taps = isComposition ? inputs : outputs;
      const singlePort = isComposition ? outputs[0] : inputs[0];
      const tapIndex = taps.indexOf(port);
      portY = tapIndex >= 0 || port.id === singlePort?.id
        ? grid * ((Math.max(0, tapIndex) * 2) + 1)
        : height / 2;
    } else if (node.kind === 'literal') {
      portY = height / 2;
    } else {
      const sidePorts = port.direction === 'output' ? outputs : inputs;
      portY = diagramSizing.nodeHeaderHeight + grid * Math.max(0, sidePorts.indexOf(port)) + grid / 2;
    }

    return {
      id: endpointId(node.id, port.id),
      side,
      leadLength: includeLeadMargins ? elkLeadLengthForPort(side, port.id) : 0,
      index,
      x: portX,
      y: portY
    };
  });

  const margins = portGeometry.reduce((current, port) => {
    if (port.side === 'WEST') {
      current.left = Math.max(current.left, port.leadLength);
    } else if (port.side === 'EAST') {
      current.right = Math.max(current.right, port.leadLength);
    } else if (port.side === 'NORTH') {
      current.top = Math.max(current.top, port.leadLength);
    } else {
      current.bottom = Math.max(current.bottom, port.leadLength);
    }
    return current;
  }, { left: 0, right: 0, top: 0, bottom: 0 });

  const ports = portGeometry.map((port) => {
    const leadX = port.side === 'WEST'
      ? -port.leadLength
      : port.side === 'EAST'
        ? port.leadLength
        : 0;
    const leadY = port.side === 'NORTH'
      ? -port.leadLength
      : port.side === 'SOUTH'
        ? port.leadLength
        : 0;

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
        'org.eclipse.elk.port.index': port.index.toString()
      },
      properties: {
        'org.eclipse.elk.port.side': port.side,
        'org.eclipse.elk.port.index': port.index.toString()
      }
    };
  });

  return {
    id: node.id,
    width: width + margins.left + margins.right,
    height: height + margins.top + margins.bottom,
    ports,
    layoutOptions: {
      'elk.portConstraints': 'FIXED_POS',
      'org.eclipse.elk.portConstraints': 'FIXED_POS'
    },
    properties: {
      'org.eclipse.elk.portConstraints': 'FIXED_POS'
    },
    layoutOffset: { x: margins.left, y: margins.top }
  };
}

function elkLeadLengthForPort(side: ElkPortSide, portId?: string): number {
  if (side === 'NORTH' || side === 'SOUTH') {
    return portId === 'reset' ? diagramSizing.gridSize : diagramSizing.gridSize * 2;
  }
  return diagramSizing.edgeLeadLength;
}

function alignSimpleLeafNodes(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  positions: Map<string, { x: number; y: number }>,
  moduleLayout: SavedModuleLayout
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

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

    const peerPortId = isSource ? edge.targetPort : edge.sourcePort;
    if (!canAlignSimpleLeafToPeer(peer, peerPortId)) {
      continue;
    }

    const nodePosition = positions.get(node.id);
    const peerPosition = positions.get(peer.id);
    if (!nodePosition || !peerPosition) {
      continue;
    }

    const ownPortId = isSource ? edge.sourcePort : edge.targetPort;
    const ownOffset = renderedPortOffset(node, ownPortId);
    const peerOffset = renderedPortOffset(peer, peerPortId);
    if (!ownOffset || !peerOffset) {
      continue;
    }

    positions.set(node.id, {
      ...nodePosition,
      y: snapToGrid(peerPosition.y + peerOffset.y - ownOffset.y, node.kind)
    });
  }
}

function canAlignSimpleLeafToPeer(node: DiagramNode, portId?: string): boolean {
  if (node.kind !== 'mux' && node.kind !== 'comb' && node.kind !== 'loop') {
    return true;
  }

  const elkNode = elkNodeForDiagramNode(node, false);
  const port = elkNode.ports.find((candidate) => candidate.id === endpointId(node.id, portId));
  const side = port?.properties['org.eclipse.elk.port.side'];
  if (!side || (side !== 'WEST' && side !== 'EAST')) {
    return false;
  }

  return elkNode.ports.filter((candidate) => candidate.properties['org.eclipse.elk.port.side'] === side).length === 1;
}

function renderedPortOffset(node: DiagramNode, portId?: string): { x: number; y: number } | undefined {
  const elkNode = elkNodeForDiagramNode(node, false);
  const port = elkNode.ports.find((candidate) => candidate.id === endpointId(node.id, portId));
  if (!port || port.x === undefined || port.y === undefined) {
    return undefined;
  }
  return { x: port.x, y: port.y };
}

function routeWithRenderedLeads(
  edge: DiagramEdge,
  route: Array<{ x: number; y: number }>,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>
): Array<{ x: number; y: number }> {
  const sourceLead = renderedLeadPoint(edge.source, edge.sourcePort, nodesById, nodePositions);
  const targetLead = renderedLeadPoint(edge.target, edge.targetPort, nodesById, nodePositions);
  if (!sourceLead || !targetLead) {
    return route;
  }

  const internal = route.slice(1, -1);
  if (internal.length === 0) {
    return directLeadRoute(sourceLead, targetLead);
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

  return removeRedundantRoutePoints(makeOrthogonalRoute(points));
}

function directRenderedLeadRoute(
  edge: DiagramEdge,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>
): Array<{ x: number; y: number }> | undefined {
  const sourceLead = renderedLeadPoint(edge.source, edge.sourcePort, nodesById, nodePositions);
  const targetLead = renderedLeadPoint(edge.target, edge.targetPort, nodesById, nodePositions);
  if (!sourceLead || !targetLead) {
    return undefined;
  }
  return directLeadRoute(sourceLead, targetLead);
}

function directLeadRoute(
  sourceLead: { point: { x: number; y: number }; side: ElkPortSide },
  targetLead: { point: { x: number; y: number }; side: ElkPortSide }
): Array<{ x: number; y: number }> {
  const sourceSideIsHorizontal = sourceLead.side === 'EAST' || sourceLead.side === 'WEST';
  const targetSideIsHorizontal = targetLead.side === 'EAST' || targetLead.side === 'WEST';
  if (sourceSideIsHorizontal && targetSideIsHorizontal && sourceLead.point.y !== targetLead.point.y) {
    const midX = snapToGrid((sourceLead.point.x + targetLead.point.x) / 2);
    return removeRedundantRoutePoints(makeOrthogonalRoute([
      sourceLead.point,
      { x: midX, y: sourceLead.point.y },
      { x: midX, y: targetLead.point.y },
      targetLead.point
    ]));
  }

  const sourceSideIsVertical = sourceLead.side === 'NORTH' || sourceLead.side === 'SOUTH';
  const targetSideIsVertical = targetLead.side === 'NORTH' || targetLead.side === 'SOUTH';
  if (sourceSideIsVertical && targetSideIsVertical && sourceLead.point.x !== targetLead.point.x) {
    const midY = snapToGrid((sourceLead.point.y + targetLead.point.y) / 2);
    return removeRedundantRoutePoints(makeOrthogonalRoute([
      sourceLead.point,
      { x: sourceLead.point.x, y: midY },
      { x: targetLead.point.x, y: midY },
      targetLead.point
    ]));
  }

  return removeRedundantRoutePoints(makeOrthogonalRoute([sourceLead.point, targetLead.point]));
}

function renderedLeadPoint(
  nodeId: string,
  portId: string | undefined,
  nodesById: Map<string, DiagramNode>,
  nodePositions: Map<string, { x: number; y: number }>
): { point: { x: number; y: number }; side: ElkPortSide } | undefined {
  const node = nodesById.get(nodeId);
  const position = nodePositions.get(nodeId);
  if (!node || !position) {
    return undefined;
  }

  const elkNode = elkNodeForDiagramNode(node, true);
  const port = elkNode.ports.find((candidate) => candidate.id === endpointId(nodeId, portId));
  if (!port || port.x === undefined || port.y === undefined) {
    return undefined;
  }

  const side = (port.properties['org.eclipse.elk.port.side'] ?? 'EAST') as ElkPortSide;
  return {
    point: {
      x: snapToGrid(position.x - elkNode.layoutOffset.x + port.x),
      y: snapToGrid(position.y - elkNode.layoutOffset.y + port.y)
    },
    side
  };
}

function leadExtensionConnector(
  lead: { x: number; y: number },
  next: { x: number; y: number },
  side: ElkPortSide
): { x: number; y: number } | undefined {
  if (side === 'EAST' || side === 'WEST') {
    if (lead.y === next.y) {
      return undefined;
    }
    const direction = side === 'EAST' ? 1 : -1;
    const nextIsOutward = direction > 0 ? next.x > lead.x : next.x < lead.x;
    return {
      x: nextIsOutward ? next.x : lead.x + direction * diagramSizing.gridSize,
      y: lead.y
    };
  }
  if (lead.x === next.x) {
    return undefined;
  }
  const direction = side === 'SOUTH' ? 1 : -1;
  const nextIsOutward = direction > 0 ? next.y > lead.y : next.y < lead.y;
  return {
    x: lead.x,
    y: nextIsOutward ? next.y : lead.y + direction * diagramSizing.gridSize
  };
}

function makeOrthogonalRoute(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
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

function removeRedundantRoutePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return removeConsecutiveDuplicatePoints(points).filter((point, index, deduped) => {
    if (index === 0 || index === deduped.length - 1) {
      return true;
    }
    const previous = deduped[index - 1];
    const next = deduped[index + 1];
    return !(previous.x === point.x && point.x === next.x) && !(previous.y === point.y && point.y === next.y);
  });
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

function buildRoutingElkEdges(edges: DiagramEdge[], nodeIds: Set<string>): Array<{ id: string; sources: string[]; targets: string[] }> {
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
    } else {
      const edge = netEdges[0];
      elkEdges.push({
        id: edge.id,
        sources: [endpointId(edge.source, edge.sourcePort)],
        targets: [endpointId(edge.target, edge.targetPort)]
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
