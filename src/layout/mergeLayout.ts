import type { DesignGraph, DiagramNode, DiagramViewModel, PositionedNode } from '../ir/types';
import type { SavedLayout, SavedModuleLayout } from '../storage/layoutStore';
import { diagramSizing, nodeHeightForPortRows } from '../diagram/constants';

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
  const elkPositions = await autoLayoutMissingNodes(designModule.nodes, designModule.edges, moduleLayout);
  const positioned = designModule.nodes.map((node, index): PositionedNode => {
    const saved = moduleLayout.nodes[node.id];
    const elk = elkPositions.get(node.id);
    const contextual = contextualPosition(node.id, designModule.edges, moduleLayout);
    const usableElk = elk && (!contextual || (elk.x > 100 && elk.y > 100)) ? elk : undefined;
    const fallback = defaultPosition(index, node.kind);
    return {
      ...node,
      position: snapPosition(saved ? { x: saved.x, y: saved.y } : usableElk ?? contextual ?? fallback)
    };
  });

  return {
    moduleName: designModule.name,
    nodes: positioned,
    edges: designModule.edges.map((edge) => ({
      ...edge,
      waypoint: moduleLayout.edges?.[edge.id]?.waypoint,
      routePoints: moduleLayout.edges?.[edge.id]?.routePoints
    })),
    diagnostics: graph.diagnostics
  };
}

function contextualPosition(
  nodeId: string,
  edges: Array<{ source: string; target: string }>,
  moduleLayout: SavedModuleLayout
): { x: number; y: number } | undefined {
  const neighbors = edges
    .flatMap((edge) => {
      if (edge.source === nodeId) {
        return [edge.target];
      }
      if (edge.target === nodeId) {
        return [edge.source];
      }
      return [];
    })
    .map((id) => moduleLayout.nodes[id])
    .filter((position): position is { x: number; y: number } => Boolean(position && !position.stale));

  if (neighbors.length === 0) {
    return undefined;
  }

  return {
    x: Math.round(neighbors.reduce((sum, neighbor) => sum + neighbor.x, 0) / neighbors.length),
    y: Math.round(neighbors.reduce((sum, neighbor) => sum + neighbor.y, 0) / neighbors.length)
  };
}

async function autoLayoutMissingNodes(
  nodes: DiagramNode[],
  edges: Array<{ source: string; target: string }>,
  moduleLayout: SavedModuleLayout
): Promise<Map<string, { x: number; y: number }>> {
  const positions = new Map<string, { x: number; y: number }>();
  const missingIds = new Set(nodes.filter((node) => !moduleLayout.nodes[node.id]).map((node) => node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (missingIds.size === 0) {
    return positions;
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
        'elk.interactive': 'true'
      },
      children: nodes.map((node) => ({
        id: node.id,
        width: nodeWidthForNode(node),
        height: nodeHeightForNode(node),
        ...(moduleLayout.nodes[node.id]
          ? {
            x: moduleLayout.nodes[node.id].x,
            y: moduleLayout.nodes[node.id].y,
            properties: {
              'org.eclipse.elk.position': 'FIXED'
            }
          }
          : {})
      })),
      edges: edges
        .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
        .map((edge) => ({
          id: `${edge.source}-${edge.target}`,
          sources: [edge.source],
          targets: [edge.target]
        }))
    });

    for (const child of graph.children ?? []) {
      if (missingIds.has(child.id) && child.x !== undefined && child.y !== undefined) {
        positions.set(child.id, snapPosition({ x: child.x, y: child.y }));
      }
    }
  } catch {
    return positions;
  }

  return positions;
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
    if (!activeIds.has(id)) {
      mergedNodes[id] = { ...value, stale: true };
    }
  }

  for (const node of nodes) {
    mergedNodes[node.id] = {
      x: snapToGrid(node.position.x),
      y: snapToGrid(node.position.y)
    };
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

function snapToGrid(value: number): number {
  return Math.round(value / diagramSizing.gridSize) * diagramSizing.gridSize;
}

function snapPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: snapToGrid(position.x),
    y: snapToGrid(position.y)
  };
}

function nodeHeightForNode(node: DiagramNode): number {
  if (node.kind === 'port') {
    return diagramSizing.portHeight;
  }

  const inputs = node.ports.filter((port) => port.direction === 'input' || port.direction === 'inout' || port.direction === 'unknown').length;
  const outputs = node.ports.filter((port) => port.direction === 'output').length;
  const sideInputs = node.kind === 'mux' ? Math.max(0, inputs - 1) : inputs;
  return nodeHeightForPortRows(Math.max(sideInputs, outputs));
}

function nodeWidthForNode(node: DiagramNode): number {
  if (node.kind === 'port') {
    return diagramSizing.portWidth;
  }

  return node.kind === 'mux' ? diagramSizing.muxWidth : diagramSizing.nodeWidth;
}
