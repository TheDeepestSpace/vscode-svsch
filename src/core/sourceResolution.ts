import type { BaseDiagramNode, DesignGraph, DiagramEdge, SourceRange } from '../ir/types';

interface SourcePosition {
  line: number;
  column: number;
}

interface IndexedNodeSourceRange {
  nodeId: string;
  start: SourcePosition;
  end: SourcePosition;
}

/**
 * In-memory lookup for the source spans of one module's diagram nodes.
 *
 * SourceRange lines are one-based and columns are zero-based, matching the
 * extractor output. Files are normalized to forward slashes so ranges built
 * on Windows still match workspace-relative editor paths.
 */
export class SourceRangeIndex {
  private readonly rangesByFile = new Map<string, IndexedNodeSourceRange[]>();

  constructor(nodes: ReadonlyArray<Pick<BaseDiagramNode, 'id' | 'source'>>) {
    for (const node of nodes) {
      const indexed = normalizeIndexedRange(node.id, node.source);
      if (!indexed || !node.source) continue;
      const file = normalizeSourceFile(node.source.file);
      const ranges = this.rangesByFile.get(file) ?? [];
      ranges.push(indexed);
      this.rangesByFile.set(file, ranges);
    }

    for (const ranges of this.rangesByFile.values()) {
      ranges.sort(
        (a, b) =>
          comparePositions(a.start, b.start) ||
          comparePositions(a.end, b.end) ||
          a.nodeId.localeCompare(b.nodeId),
      );
    }
  }

  findNodeIds(selection: SourceRange): string[] {
    const query = normalizeQueryRange(selection);
    if (!query) return [];

    const matches = new Set<string>();
    for (const candidate of this.rangesByFile.get(normalizeSourceFile(selection.file)) ?? []) {
      if (comparePositions(candidate.start, query.end) > 0) break;
      if (rangesIntersect(candidate, query)) matches.add(candidate.nodeId);
    }
    return [...matches];
  }
}

function normalizeSourceFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function normalizeIndexedRange(
  nodeId: string,
  source: SourceRange | undefined,
): IndexedNodeSourceRange | undefined {
  const range = normalizeRange(source);
  return range ? { nodeId, ...range } : undefined;
}

function normalizeQueryRange(
  source: SourceRange,
): Omit<IndexedNodeSourceRange, 'nodeId'> | undefined {
  return normalizeRange(source);
}

function normalizeRange(
  source: SourceRange | undefined,
): Omit<IndexedNodeSourceRange, 'nodeId'> | undefined {
  if (!source?.file || !source.startLine || source.startLine < 1) return undefined;
  const start = { line: source.startLine, column: Math.max(0, source.startColumn ?? 0) };
  let end = {
    line: Math.max(1, source.endLine ?? source.startLine),
    column: Math.max(0, source.endColumn ?? Number.MAX_SAFE_INTEGER),
  };
  if (comparePositions(end, start) < 0) end = start;
  return { start, end };
}

function comparePositions(a: SourcePosition, b: SourcePosition): number {
  return a.line - b.line || a.column - b.column;
}

function rangesIntersect(
  candidate: Omit<IndexedNodeSourceRange, 'nodeId'>,
  query: Omit<IndexedNodeSourceRange, 'nodeId'>,
): boolean {
  const candidateIsPoint = comparePositions(candidate.start, candidate.end) === 0;
  const queryIsCursor = comparePositions(query.start, query.end) === 0;
  if (queryIsCursor) {
    return (
      comparePositions(query.start, candidate.start) >= 0 &&
      (comparePositions(query.start, candidate.end) < 0 ||
        (candidateIsPoint && comparePositions(query.start, candidate.end) === 0))
    );
  }
  if (candidateIsPoint) {
    return (
      comparePositions(candidate.start, query.start) >= 0 &&
      comparePositions(candidate.start, query.end) < 0
    );
  }
  return (
    comparePositions(candidate.start, query.end) < 0 &&
    comparePositions(query.start, candidate.end) < 0
  );
}

/**
 * Resolves the source range for a given edge (signal) within a module.
 * Checks the edge's sourceRange, then ports, and falls back to internal nodes
 * (register, comb, alu, inverter).
 */
export function resolveSignalSource(
  graph: DesignGraph,
  moduleName: string,
  edge: DiagramEdge,
): SourceRange | undefined {
  if (!edge.signal) {
    return undefined;
  }

  if (edge.sourceRange) {
    return edge.sourceRange;
  }

  const module = graph.modules[moduleName];
  if (!module) {
    return undefined;
  }

  // Try to find the signal declaration in ports
  const port = module.ports.find((p) => p.name === edge.signal);
  if (port?.source) {
    return port.source;
  }

  // Try finding an internal node representing this signal. Gate nodes carry
  // an empty label (the C++ extractor always sets it to "") and store the
  // real signal name on their output port instead, so label matching alone
  // never resolves them.
  const sourceNode = module.nodes.find(
    (n) =>
      (n.label === edge.signal ||
        n.ports.some(
          (port) =>
            port.direction === 'output' &&
            (port.name === edge.signal || port.connectedSignal === edge.signal),
        )) &&
      (n.kind === 'register' ||
        n.kind === 'comb' ||
        n.kind === 'alu' ||
        n.kind === 'inverter' ||
        n.kind === 'gate'),
  );
  if (sourceNode?.source) {
    return sourceNode.source;
  }

  return undefined;
}
