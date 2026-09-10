import { diagramSizing } from '../diagram/constants';
import type { DiagramNode } from '../ir/types';

export const ROUTING_OBSTACLE_MARGIN = diagramSizing.gridSize / 2;

export interface RoutingObstacleMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function routingObstacleMargins(
  node: DiagramNode,
  portSides: Array<string | undefined>,
): RoutingObstacleMargins {
  const vertical = {
    top: portSides.includes('NORTH') ? 0 : ROUTING_OBSTACLE_MARGIN,
    bottom: portSides.includes('SOUTH') ? 0 : ROUTING_OBSTACLE_MARGIN,
  };

  if (node.kind === 'literal') {
    return {
      left: diagramSizing.gridSize,
      right: 0,
      ...vertical,
    };
  }

  // The label's lead already reserves its connected side, just like a module
  // port lead does. Keep a full grid on the other three sides so snapped
  // routes cannot run directly along the label's outline.
  if (node.kind === 'netLabel') {
    const handleSide =
      node.metadata?.cutNet?.handleSide ??
      (portSides.includes('WEST')
        ? 'left'
        : portSides.includes('EAST')
          ? 'right'
          : portSides.includes('NORTH')
            ? 'top'
            : portSides.includes('SOUTH')
              ? 'bottom'
              : undefined);
    return {
      left: handleSide === 'left' ? 0 : diagramSizing.gridSize,
      right: handleSide === 'right' ? 0 : diagramSizing.gridSize,
      top: handleSide === 'top' ? 0 : diagramSizing.gridSize,
      bottom: handleSide === 'bottom' ? 0 : diagramSizing.gridSize,
    };
  }

  // An expanded module instance's frame is a much larger obstacle than a
  // collapsed one, so unrelated routes that merely skirt past it (rather
  // than connecting to one of its ports) need the same full-grid clearance
  // literal/netLabel obstacles reserve on their unconnected sides — without
  // it, routes end up snapping flush against the ghost frame's border.
  if (node.kind === 'instance' && node.metadata?.expandGhost) {
    return {
      left: diagramSizing.gridSize,
      right: diagramSizing.gridSize,
      top: diagramSizing.gridSize,
      bottom: diagramSizing.gridSize,
    };
  }

  if (node.kind !== 'port') {
    return { left: 0, right: 0, ...vertical };
  }

  // A terminal's lead already reserves the connection side. Keep one full
  // grid clear behind the port so returning feedback routes do not hug it.
  // An inout boundary port has leads on BOTH sides (driven from the left,
  // read from the right) — neither side is a "dead" back to pad behind.
  const isDualSided = portSides.includes('WEST') && portSides.includes('EAST');
  return {
    left: !isDualSided && portSides.includes('EAST') ? diagramSizing.gridSize : 0,
    right: !isDualSided && portSides.includes('WEST') ? diagramSizing.gridSize : 0,
    ...vertical,
  };
}

export function routingVerticalMargins(
  node: DiagramNode,
  portSides: Array<string | undefined>,
): { top: number; bottom: number } {
  const { top, bottom } = routingObstacleMargins(node, portSides);
  return { top, bottom };
}
