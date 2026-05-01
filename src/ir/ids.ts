export function stableId(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.replace(/[^A-Za-z0-9_$.-:]+/g, '_'))
    .join(':');
}

export function edgeId(source: string, target: string, label?: string): string {
  return stableId('edge', source, target, label);
}
