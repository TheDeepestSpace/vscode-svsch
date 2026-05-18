import type { DiagramNode } from '../ir/types';
import { normalizeWidth } from './constants';

function bitSizeFromWidth(width?: string): number {
  const normalized = normalizeWidth(width);
  const match = normalized?.match(/^\[(-?\d+)(?::(-?\d+))?\]$/);
  if (!match) return 0;

  const left = Number.parseInt(match[1], 10);
  const right = match[2] === undefined ? left : Number.parseInt(match[2], 10);
  return Math.abs(left - right) + 1;
}

export function selectNodeHasVectorOutput(node: DiagramNode): boolean {
  if (node.kind !== 'select') return false;
  const output = node.ports.find((port) => port.direction === 'output');
  return bitSizeFromWidth(output?.width) > 1;
}

export function selectPortLabel(node: DiagramNode, portOrLabel: string | { name: string, label?: string, direction: string, width?: string }): string {
  const label = typeof portOrLabel === 'string' ? portOrLabel : (portOrLabel.label ?? portOrLabel.name);
  const direction = typeof portOrLabel === 'string' ? 'input' : portOrLabel.direction;
  if (direction === 'output') {
    return selectNodeHasVectorOutput(node) ? `${label}[]` : label;
  }
  // Selector and base input are almost always vectors/buses for select blocks
  return `${label}[]`;
}
