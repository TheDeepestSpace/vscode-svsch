import type { DesignGraph, DesignModule, DiagramNode, DiagramPort } from '../ir/types';
import { edgeId, stableId } from '../ir/ids';

interface SourceFile {
  file: string;
  text: string;
}

interface ModuleMatch {
  name: string;
  header: string;
  body: string;
  file: string;
  startLine: number;
}

interface RegisterExtraction {
  nodes: DiagramNode[];
  edges: DesignModule['edges'];
}

interface MuxExtraction {
  nodes: DiagramNode[];
  edges: DesignModule['edges'];
}

const KEYWORDS = new Set([
  'always',
  'always_comb',
  'always_ff',
  'assign',
  'begin',
  'case',
  'default',
  'else',
  'end',
  'endcase',
  'endmodule',
  'for',
  'generate',
  'if',
  'initial',
  'input',
  'inout',
  'logic',
  'module',
  'output',
  'reg',
  'wire'
]);

export function extractDesignFromText(sources: SourceFile[]): DesignGraph {
  const graph: DesignGraph = {
    rootModules: [],
    modules: {},
    diagnostics: [],
    generatedAt: new Date().toISOString()
  };

  const allModules = sources.flatMap(findModules);
  for (const match of allModules) {
    graph.modules[match.name] = extractModule(match);
  }
  enrichInstanceConnections(graph);
  graph.diagnostics.push(...detectMultipleDrivers(graph));

  const instantiated = new Set<string>();
  for (const designModule of Object.values(graph.modules)) {
    for (const node of designModule.nodes) {
      if (node.kind === 'instance' && node.instanceOf) {
        instantiated.add(node.instanceOf);
      }
    }
  }

  graph.rootModules = Object.keys(graph.modules).filter((name) => !instantiated.has(name));
  if (graph.rootModules.length === 0) {
    graph.rootModules = Object.keys(graph.modules).slice(0, 1);
  }

  for (const source of sources) {
    if (!findModules(source).length && source.text.trim()) {
      graph.diagnostics.push({
        severity: 'warning',
        message: `No module declarations found in ${source.file}; represented content may be incomplete.`,
        source: { file: source.file }
      });
    }
  }

  return graph;
}

function findModules(source: SourceFile): ModuleMatch[] {
  const text = stripComments(source.text);
  const matches: ModuleMatch[] = [];
  const moduleRegex = /\bmodule\s+([A-Za-z_$][\w$]*)\b([\s\S]*?)\bendmodule\b/g;
  let match: RegExpExecArray | null;

  while ((match = moduleRegex.exec(text))) {
    const full = match[0];
    const name = match[1];
    const firstSemi = full.indexOf(';');
    const header = firstSemi >= 0 ? full.slice(0, firstSemi) : full;
    const body = firstSemi >= 0 ? full.slice(firstSemi + 1, -'endmodule'.length) : '';
    matches.push({
      name,
      header,
      body,
      file: source.file,
      startLine: lineAt(source.text, match.index)
    });
  }

  if (matches.length === 0) {
    const partial = /\bmodule\s+([A-Za-z_$][\w$]*)\b([\s\S]*)/m.exec(text);
    if (partial) {
      const full = partial[0];
      const firstSemi = full.indexOf(';');
      matches.push({
        name: partial[1],
        header: firstSemi >= 0 ? full.slice(0, firstSemi) : full,
        body: firstSemi >= 0 ? full.slice(firstSemi + 1) : '',
        file: source.file,
        startLine: lineAt(source.text, partial.index)
      });
    }
  }

  return matches;
}

function extractModule(match: ModuleMatch): DesignModule {
  const ports = extractPorts(match.header, match.body);
  const nodes: DiagramNode[] = [
    ...ports.map((port): DiagramNode => ({
      id: stableId('port', match.name, port.name),
      kind: 'port',
      label: port.name,
      parentModule: match.name,
      ports: [port],
      source: {
        file: match.file,
        startLine: match.startLine
      }
    }))
  ];

  const edges: DesignModule['edges'] = [];
  const instances = extractInstances(match);
  const registers = extractRegisters(match, ports);
  const muxes = extractMuxes(match, ports);
  nodes.push(...instances);
  nodes.push(...registers.nodes);
  nodes.push(...muxes.nodes);
  nodes.push(...extractUnknowns(match, nodes));
  edges.push(...registers.edges);
  edges.push(...muxes.edges);

  return {
    name: match.name,
    file: match.file,
    ports,
    nodes,
    edges
  };
}

function extractPorts(header: string, body: string): DiagramPort[] {
  const ports = new Map<string, DiagramPort>();
  const headerPortList = header.match(/\(([\s\S]*)\)/)?.[1] ?? '';
  const declaredPortRegex = /\b(input|output|inout)\b\s*(?:(wire|logic|reg)\s*)?(\[[^\]]+\]\s*)?([A-Za-z_$][\w$]*)/g;
  let declared: RegExpExecArray | null;

  for (const text of [headerPortList, body]) {
    while ((declared = declaredPortRegex.exec(text))) {
      const name = declared[4];
      ports.set(name, {
        id: stableId('port', name),
        name,
        direction: declared[1] as DiagramPort['direction'],
        width: declared[3]?.trim()
      });
    }
  }

  for (const raw of headerPortList.split(',')) {
    const name = raw.trim().match(/([A-Za-z_$][\w$]*)$/)?.[1];
    if (name && !KEYWORDS.has(name) && !ports.has(name)) {
      ports.set(name, {
        id: stableId('port', name),
        name,
        direction: 'unknown'
      });
    }
  }

  return [...ports.values()];
}

function extractInstances(match: ModuleMatch): DiagramNode[] {
  const nodes: DiagramNode[] = [];
  const instanceRegex = /^\s*([A-Za-z_$][\w$]*)\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)\s*;/gm;
  let instance: RegExpExecArray | null;

  while ((instance = instanceRegex.exec(match.body))) {
    const typeName = instance[1];
    const instanceName = instance[2];
    if (KEYWORDS.has(typeName)) {
      continue;
    }

    const ports = [...instance[3].matchAll(/\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)].map((port) => ({
      id: stableId('port', port[1]),
      name: port[1],
      direction: 'unknown' as const,
      connectedSignal: firstIdentifier(port[2].trim()) ?? port[1]
    }));
    nodes.push({
      id: stableId('instance', match.name, instanceName),
      kind: 'instance',
      label: instanceName,
      parentModule: match.name,
      instanceOf: typeName,
      moduleName: typeName,
      ports,
      source: {
        file: match.file,
        startLine: match.startLine + lineAt(match.body, instance.index) - 1
      }
    });
  }

  return nodes;
}

function extractRegisters(match: ModuleMatch, modulePorts: DiagramPort[]): RegisterExtraction {
  const nodes: DiagramNode[] = [];
  const edges: DesignModule['edges'] = [];
  const pendingAssignments: Array<{
    nodeId: string;
    target: string;
    expression: string;
    clk: string;
  }> = [];
  const alwaysRegex = /\balways_ff\b\s*@\s*\(([^)]*)\)([\s\S]*?)(?=\balways_|\balways\b|\bassign\b|\bendmodule\b|$)/g;
  let alwaysMatch: RegExpExecArray | null;

  while ((alwaysMatch = alwaysRegex.exec(match.body))) {
    const block = alwaysMatch[2];
    const clk = alwaysMatch[1].match(/\b(?:posedge|negedge)\s+([A-Za-z_$][\w$]*)/)?.[1] ?? 'clk';
    const assignments = [...block.matchAll(/\b([A-Za-z_$][\w$]*)\s*<=\s*([^;]+);/g)].map((assignment) => ({
      target: assignment[1],
      expression: assignment[2].trim()
    }));
    const targets = assignments.length ? assignments : [{ target: `reg_${nodes.length}`, expression: '' }];
    for (const assignment of targets) {
      const target = assignment.target;
      const nodeId = stableId('reg', match.name, target);
      nodes.push({
        id: nodeId,
        kind: 'register',
        label: target,
        parentModule: match.name,
        ports: [
          { id: stableId('d'), name: 'D', direction: 'input' },
          { id: stableId('q'), name: 'Q', direction: 'output' },
          { id: stableId('clk'), name: clk, direction: 'input' }
        ],
        source: {
          file: match.file,
          startLine: match.startLine + lineAt(match.body, alwaysMatch.index) - 1
        }
      });
      pendingAssignments.push({
        nodeId,
        target,
        expression: assignment.expression,
        clk
      });
    }
  }

  for (const assignment of pendingAssignments) {
    const sourceSignal = firstIdentifier(assignment.expression);
    if (sourceSignal) {
      const sourcePort = modulePorts.find((port) => port.name === sourceSignal);
      const sourceRegister = nodes.find((node) => node.label === sourceSignal);
      if (sourcePort) {
        edges.push({
          id: edgeId(stableId('port', match.name, sourcePort.name), assignment.nodeId, 'D'),
          source: stableId('port', match.name, sourcePort.name),
          target: assignment.nodeId,
          sourcePort: sourcePort.id,
          targetPort: stableId('d'),
          label: sourceSignal,
          signal: sourceSignal
        });
      } else if (sourceRegister) {
        edges.push({
          id: edgeId(sourceRegister.id, assignment.nodeId, sourceSignal),
          source: sourceRegister.id,
          target: assignment.nodeId,
          sourcePort: stableId('q'),
          targetPort: stableId('d'),
          label: sourceSignal,
          signal: sourceSignal
        });
      }
    }

    const clkPort = modulePorts.find((port) => port.name === assignment.clk);
    if (clkPort) {
      edges.push({
        id: edgeId(stableId('port', match.name, clkPort.name), assignment.nodeId, 'clk'),
        source: stableId('port', match.name, clkPort.name),
        target: assignment.nodeId,
        sourcePort: clkPort.id,
        targetPort: stableId('clk'),
        label: assignment.clk,
        signal: assignment.clk
      });
    }

    const targetPort = modulePorts.find((port) => port.name === assignment.target);
    if (targetPort) {
      edges.push({
        id: edgeId(assignment.nodeId, stableId('port', match.name, targetPort.name), 'Q'),
        source: assignment.nodeId,
        target: stableId('port', match.name, targetPort.name),
        sourcePort: stableId('q'),
        targetPort: targetPort.id,
        label: assignment.target,
        signal: assignment.target
      });
    }
  }

  return { nodes, edges };
}

function extractMuxes(match: ModuleMatch, modulePorts: DiagramPort[]): MuxExtraction {
  const nodes: DiagramNode[] = [];
  const edges: DesignModule['edges'] = [];
  const muxKeyCounts = new Map<string, number>();
  const caseRegex = /\bcase\s*\(([^)]*)\)([\s\S]*?)\bendcase\b/g;
  let caseMatch: RegExpExecArray | null;

  while ((caseMatch = caseRegex.exec(match.body))) {
    const selector = caseMatch[1].trim() || 'sel';
    const assignments = [...caseMatch[2].matchAll(/:\s*([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)].map((assignment) => ({
      target: assignment[1],
      expression: assignment[2].trim()
    }));
    const outputSignal = assignments[0]?.target ?? 'out';
    const inputSignals = unique([
      selector,
      ...assignments.map((assignment) => firstIdentifier(assignment.expression)).filter((signal): signal is string => Boolean(signal))
    ]);
    const muxKey = stableId('mux', match.name, outputSignal, selector);
    const muxKeyCount = muxKeyCounts.get(muxKey) ?? 0;
    muxKeyCounts.set(muxKey, muxKeyCount + 1);
    const nodeId = muxKeyCount === 0 ? muxKey : stableId(muxKey, muxKeyCount.toString());
    nodes.push({
      id: nodeId,
      kind: 'mux',
      label: `case ${selector}`,
      parentModule: match.name,
      ports: [
        ...inputSignals.map((signal) => ({ id: stableId('in', signal), name: signal, direction: 'input' as const })),
        { id: stableId('out', outputSignal), name: outputSignal, direction: 'output' }
      ],
      source: {
        file: match.file,
        startLine: match.startLine + lineAt(match.body, caseMatch.index) - 1
      }
    });

    for (const signal of inputSignals) {
      const sourcePort = modulePorts.find((port) => port.name === signal);
      if (sourcePort) {
        pushUniqueEdge(edges, {
          id: edgeId(stableId('port', match.name, sourcePort.name), nodeId, signal),
          source: stableId('port', match.name, sourcePort.name),
          target: nodeId,
          sourcePort: sourcePort.id,
          targetPort: stableId('in', signal),
          label: signal,
          signal
        });
      }
    }

    const targetPort = modulePorts.find((port) => port.name === outputSignal);
    if (targetPort) {
      pushUniqueEdge(edges, {
        id: edgeId(nodeId, stableId('port', match.name, targetPort.name), outputSignal),
        source: nodeId,
        target: stableId('port', match.name, targetPort.name),
        sourcePort: stableId('out', outputSignal),
        targetPort: targetPort.id,
        label: outputSignal,
        signal: outputSignal
      });
    }
  }

  return { nodes, edges };
}

function extractUnknowns(match: ModuleMatch, knownNodes: DiagramNode[]): DiagramNode[] {
  const nodes: DiagramNode[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bgenerate\b[\s\S]*?\bendgenerate\b/g, 'generate'],
    [/\binterface\b[\s\S]*?\bendinterface\b/g, 'interface'],
    [/\balways_comb\b[\s\S]*?(?=\balways_|\balways\b|\bassign\b|$)/g, 'always_comb'],
    [/\binitial\b[\s\S]*?(?=\balways_|\balways\b|\bassign\b|$)/g, 'initial']
  ];
  const occupiedLines = new Set(knownNodes.map((node) => node.source?.startLine).filter(Boolean));

  for (const [regex, label] of patterns) {
    let unknown: RegExpExecArray | null;
    while ((unknown = regex.exec(match.body))) {
      if (label === 'always_comb' && /\bcase\b/.test(unknown[0])) {
        continue;
      }
      const line = match.startLine + lineAt(match.body, unknown.index) - 1;
      if (occupiedLines.has(line)) {
        continue;
      }
      nodes.push({
        id: stableId('unknown', match.name, label, line.toString()),
        kind: 'unknown',
        label,
        parentModule: match.name,
        ports: [],
        metadata: {
          reason: 'Unsupported SV construct in MVP toy subset'
        },
        source: {
          file: match.file,
          startLine: line
        }
      });
    }
  }

  return nodes;
}

function enrichInstanceConnections(graph: DesignGraph): void {
  for (const designModule of Object.values(graph.modules)) {
    for (const instance of designModule.nodes.filter((node) => node.kind === 'instance')) {
      const childModule = instance.instanceOf ? graph.modules[instance.instanceOf] : undefined;
      instance.ports = instance.ports.map((port) => {
        const childPort = childModule?.ports.find((candidate) => candidate.name === port.name);
        return {
          ...port,
          direction: childPort?.direction ?? port.direction,
          width: childPort?.width ?? port.width
        };
      });

      for (const port of instance.ports) {
        const signal = port.connectedSignal ?? port.name;
        const modulePort = designModule.ports.find((candidate) => candidate.name === signal);
        if (!modulePort) {
          continue;
        }

        if (port.direction === 'output') {
          pushUniqueEdge(designModule.edges, {
            id: edgeId(instance.id, stableId('port', designModule.name, modulePort.name), signal),
            source: instance.id,
            target: stableId('port', designModule.name, modulePort.name),
            sourcePort: port.id,
            targetPort: modulePort.id,
            label: signal,
            signal
          });
        } else {
          pushUniqueEdge(designModule.edges, {
            id: edgeId(stableId('port', designModule.name, modulePort.name), instance.id, signal),
            source: stableId('port', designModule.name, modulePort.name),
            target: instance.id,
            sourcePort: modulePort.id,
            targetPort: port.id,
            label: signal,
            signal
          });
        }
      }
    }
  }
}

function detectMultipleDrivers(graph: DesignGraph): DesignGraph['diagnostics'] {
  const diagnostics: DesignGraph['diagnostics'] = [];

  for (const designModule of Object.values(graph.modules)) {
    const drivers = new Map<string, DesignModule['edges']>();
    for (const edge of designModule.edges) {
      const targetPort = designModule.ports.find((port) => stableId('port', designModule.name, port.name) === edge.target);
      if (!targetPort || targetPort.direction !== 'output') {
        continue;
      }
      const signal = edge.signal ?? targetPort.name;
      const existing = drivers.get(signal) ?? [];
      existing.push(edge);
      drivers.set(signal, existing);
    }

    for (const [signal, edges] of drivers) {
      if (edges.length > 1) {
        diagnostics.push({
          severity: 'warning',
          message: `Signal ${designModule.name}.${signal} has multiple diagram drivers: ${edges.map((edge) => edge.source).join(', ')}.`
        });
      }
    }
  }

  return diagnostics;
}

function pushUniqueEdge(edges: DesignModule['edges'], edge: DesignModule['edges'][number]): void {
  if (!edges.some((candidate) => candidate.id === edge.id)) {
    edges.push(edge);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function firstIdentifier(expression: string): string | undefined {
  return expression.match(/\b[A-Za-z_$][\w$]*\b/)?.[0];
}
