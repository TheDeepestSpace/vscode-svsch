import type { DiagramNode } from '../ir/types';
import { normalizeWidth } from './constants';

export function selectNodeHasVectorOutput(node: DiagramNode): boolean {
  if (node.kind !== 'select') return false;
  const output = node.ports.find((port) => port.direction === 'output');
  return normalizeWidth(output?.width) !== undefined;
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
