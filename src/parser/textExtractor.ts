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

interface ContinuousAssignExtraction {
  nodes: DiagramNode[];
  edges: DesignModule['edges'];
}

interface SignalRef {
  signal: string;
  sourceSignal: string;
  select?: string;
  label?: string;
  width?: string;
}

interface RegisterTimingInfo {
  clockSignal: string;
  resetSignal?: string;
  resetKind: 'none' | 'async' | 'sync';
  resetActiveLow?: boolean;
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
  const ports = extractPorts(match);
  const signalWidths = extractSignalWidths(match.header, match.body, ports);
  const nodes: DiagramNode[] = [
    ...ports.map((port): DiagramNode => ({
      id: stableId('port', match.name, port.name),
      kind: 'port',
      label: port.name,
      parentModule: match.name,
      ports: [port],
      source: port.source ?? {
        file: match.file,
        startLine: match.startLine
      }
    }))
  ];

  const edges: DesignModule['edges'] = [];
  const instances = extractInstances(match);
  const registers = extractRegisters(match, ports, signalWidths);
  const continuousAssigns = extractContinuousAssigns(match, ports, [...nodes, ...instances, ...registers.nodes], signalWidths);
  const muxes = extractMuxes(match, ports, [...nodes, ...instances, ...registers.nodes, ...continuousAssigns.nodes], signalWidths);
  nodes.push(...instances);
  nodes.push(...registers.nodes);
  nodes.push(...continuousAssigns.nodes);
  nodes.push(...muxes.nodes);
  nodes.push(...extractUnknowns(match, nodes));
  edges.push(...registers.edges);
  edges.push(...continuousAssigns.edges);
  edges.push(...muxes.edges);

  return {
    name: match.name,
    file: match.file,
    ports,
    nodes,
    edges
  };
}

function extractPorts(match: ModuleMatch): DiagramPort[] {
  const ports = new Map<string, DiagramPort>();
  const headerPortList = match.header.match(/\(([\s\S]*)\)/)?.[1] ?? '';
  const declaredPortRegex = /\b(input|output|inout)\b\s*(?:(wire|logic|reg)\s*)?(\[[^\]]+\]\s*)?([A-Za-z_$][\w$]*)/g;
  let declared: RegExpExecArray | null;

  let portIndex = 0;
  for (const [text, offset] of [[headerPortList, match.header.indexOf(headerPortList)], [match.body, match.header.length + 1]] as const) {
    if (!text || offset === -1) continue;
    while ((declared = declaredPortRegex.exec(text as string))) {
      const name = declared[4];
      const combined = match.header + ';' + match.body;
      const startLine = match.startLine + lineAt(combined, (offset as number) + declared.index) - 1;
      const endLine = match.startLine + lineAt(combined, (offset as number) + declared.index + declared[0].length) - 1;
      const startColumn = columnAt(combined, (offset as number) + declared.index);
      const endColumn = columnAt(combined, (offset as number) + declared.index + declared[0].length);
      ports.set(name, {
        id: stableId('port', name),
        name,
        direction: declared[1] as DiagramPort['direction'],
        width: declared[3]?.trim(),
        position: portIndex++,
        source: {
          file: match.file,
          startLine,
          startColumn,
          endLine,
          endColumn
        }
      });
    }
  }

  const rawPortsMatch = match.header.match(/\(([\s\S]*)\)/);
  if (rawPortsMatch) {
    const rawPortsList = rawPortsMatch[1];
    const offset = rawPortsMatch.index! + 1;
    let currentOffset = 0;
    for (const raw of rawPortsList.split(',')) {
      const nameMatch = raw.trim().match(/([A-Za-z_$][\w$]*)$/);
      if (nameMatch) {
        const name = nameMatch[1];
        if (!KEYWORDS.has(name) && !ports.has(name)) {
          const combined = match.header + ';' + match.body;
          const nameIndex = raw.indexOf(name);
          const startLine = match.startLine + lineAt(combined, offset + currentOffset + nameIndex) - 1;
          const endLine = match.startLine + lineAt(combined, offset + currentOffset + nameIndex + name.length) - 1;
          const startColumn = columnAt(combined, offset + currentOffset + nameIndex);
          const endColumn = columnAt(combined, offset + currentOffset + nameIndex + name.length);
          ports.set(name, {
            id: stableId('port', name),
            name,
            direction: 'unknown',
            position: portIndex++,
            source: { file: match.file, startLine, startColumn, endLine, endColumn }
          });
        }
      }
      currentOffset += raw.length + 1; // +1 for the comma
    }
  }

  return [...ports.values()];
}


function extractSignalWidths(header: string, body: string, ports: DiagramPort[]): Map<string, string> {
  const widths = new Map<string, string>();
  for (const port of ports) {
    if (port.width) {
      widths.set(port.name, port.width);
    }
  }

  const declarationRegex = /\b(?:wire|logic|reg)\b\s*(\[[^\]]+\]\s*)?([^;]+);/g;
  for (const text of [header, body]) {
    let declaration: RegExpExecArray | null;
    while ((declaration = declarationRegex.exec(text))) {
      const width = declaration[1]?.trim();
      if (!width) {
        continue;
      }

      for (const rawName of declaration[2].split(',')) {
        const name = rawName.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
        if (name) {
          widths.set(name, width);
        }
      }
    }
  }

  return widths;
}

function extractInstances(match: ModuleMatch): DiagramNode[] {
  const nodes: DiagramNode[] = [];
  const instanceRegex = /^\s*([A-Za-z_$][\w$]*)\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)\s*;/gm;
  let instance: RegExpExecArray | null;

  while ((instance = instanceRegex.exec(match.body))) {
    const typeName = instance[1];
    const instanceName = instance[2];
    const rawPortList = instance[3];
    if (KEYWORDS.has(typeName)) {
      continue;
    }

    const ports: DiagramPort[] = [];
    const parts = rawPortList.split(',');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;

      const namedMatch = part.match(/^\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)$/);
      if (namedMatch) {
        const portName = namedMatch[1];
        const signalExpr = namedMatch[2].trim();
        ports.push({
          id: stableId('port', portName),
          name: portName,
          direction: 'unknown',
          connectedSignal: firstIdentifier(signalExpr) ?? portName
        });
      } else {
        // Positional
        const signalExpr = part;
        ports.push({
          id: stableId('port', `pos_${i}`),
          name: `pos_${i}`,
          direction: 'unknown',
          connectedSignal: firstIdentifier(signalExpr),
          position: i
        });
      }
    }

    const combined = match.header + ';' + match.body;
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
        startLine: match.startLine + lineAt(combined, match.header.length + 1 + instance.index) - 1,
        startColumn: columnAt(combined, match.header.length + 1 + instance.index),
        endLine: match.startLine + lineAt(combined, match.header.length + 1 + instance.index + instance[0].length) - 1,
        endColumn: columnAt(combined, match.header.length + 1 + instance.index + instance[0].length)
      }
    });
  }

  return nodes;
}

function extractRegisters(match: ModuleMatch, modulePorts: DiagramPort[], signalWidths: Map<string, string>): RegisterExtraction {
  const nodes: DiagramNode[] = [];
  const edges: DesignModule['edges'] = [];
  const combNodes: DiagramNode[] = [];
  const pendingAssignments: Array<{
    nodeId: string;
    target: string;
    expression: string;
    clk: string;
    reset?: string;
    sourceRange: { file: string; startLine: number; endLine: number };
  }> = [];
  const alwaysRegex = /\balways_ff\b\s*@\s*\(([^)]*)\)([\s\S]*?)(?=\balways_|\balways\b|\bassign\b|\bendmodule\b|$)/g;
  let alwaysMatch: RegExpExecArray | null;

  while ((alwaysMatch = alwaysRegex.exec(match.body))) {
    const eventExpression = alwaysMatch[1];
    const block = alwaysMatch[2];
    const timing = parseAlwaysFfTiming(eventExpression, block);
    const assignmentsByTarget = new Map<string, string[]>();

    for (const assignment of block.matchAll(/\b([A-Za-z_$][\w$]*)\s*<=\s*([^;]+);/g)) {
      const target = assignment[1];
      const expression = assignment[2].trim();
      const existing = assignmentsByTarget.get(target) ?? [];
      existing.push(expression);
      assignmentsByTarget.set(target, existing);
    }

    const targets: Array<[string, string[]]> = assignmentsByTarget.size
      ? [...assignmentsByTarget.entries()]
      : [[`reg_${nodes.length}`, ['']]];
    const combined = match.header + ';' + match.body;
    const trimmedMatch = alwaysMatch[0].trimEnd();
    const sourceRange = {
      file: match.file,
      startLine: match.startLine + lineAt(combined, match.header.length + 1 + alwaysMatch.index) - 1,
      startColumn: columnAt(combined, match.header.length + 1 + alwaysMatch.index),
      endLine: match.startLine + lineAt(combined, match.header.length + 1 + alwaysMatch.index + trimmedMatch.length) - 1,
      endColumn: columnAt(combined, match.header.length + 1 + alwaysMatch.index + trimmedMatch.length)
    };
    for (const [target, expressions] of targets) {
      const dataExpression = chooseRegisterDataExpression(expressions, timing.resetSignal);
      const nodeId = stableId('reg', match.name, target);
      const registerPorts: DiagramPort[] = [
        { id: stableId('d'), name: 'D', direction: 'input', width: signalWidths.get(target) },
        { id: stableId('q'), name: 'Q', direction: 'output', width: signalWidths.get(target) },
        { id: stableId('clk'), name: timing.clockSignal, direction: 'input' }
      ];
      if (timing.resetSignal) {
        registerPorts.push({ id: stableId('reset'), name: timing.resetSignal, direction: 'input' });
      }

      nodes.push({
        id: nodeId,
        kind: 'register',
        label: target,
        parentModule: match.name,
        ports: registerPorts,
        metadata: {
          width: signalWidths.get(target),
          clockSignal: timing.clockSignal,
          resetSignal: timing.resetSignal,
          resetKind: timing.resetKind,
          resetActiveLow: timing.resetActiveLow
        },
        source: sourceRange
      });
      pendingAssignments.push({
        nodeId,
        target,
        expression: dataExpression,
        clk: timing.clockSignal,
        reset: timing.resetSignal,
        sourceRange
      });
    }
  }

  for (const assignment of pendingAssignments) {
    const refs = expressionSignalRefs(assignment.expression);
    const sourceSignal = refs[0]?.signal;
    if (sourceSignal) {
      const selected = parseSelectExpression(assignment.expression);
      if (selected) {
        const source = ensureBusTap(edges, match.name, modulePorts, nodes, nodes, signalWidths, selected.base, selected.select);
        if (source) {
          pushUniqueEdge(edges, {
            id: edgeId(source.nodeId, assignment.nodeId, sourceSignal),
            source: source.nodeId,
            target: assignment.nodeId,
            sourcePort: source.portId,
            targetPort: stableId('d'),
            label: undefined,
            signal: sourceSignal,
            width: selected.width
          });
        }
      } else if (!isSimpleIdentifierExpression(assignment.expression, sourceSignal)) {
        const comb = createCombNode(match, assignment.target, assignment.expression, refs, assignment.nodeId, signalWidths.get(assignment.target), assignment.sourceRange);
        combNodes.push(comb);
        connectSignalRefsToNode(edges, match.name, refs, modulePorts, combNodes, [...nodes, ...combNodes], signalWidths, comb.id);

        pushUniqueEdge(edges, {
          id: edgeId(comb.id, assignment.nodeId, assignment.target),
          source: comb.id,
          target: assignment.nodeId,
          sourcePort: stableId('out', assignment.target),
          targetPort: stableId('d'),
          label: assignment.target,
          signal: assignment.target,
          width: signalWidths.get(assignment.target)
        });
      } else {
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
          signal: sourceSignal,
          width: signalWidths.get(sourceSignal)
        });
      } else if (sourceRegister) {
        edges.push({
          id: edgeId(sourceRegister.id, assignment.nodeId, sourceSignal),
          source: sourceRegister.id,
          target: assignment.nodeId,
          sourcePort: stableId('q'),
          targetPort: stableId('d'),
          label: sourceSignal,
          signal: sourceSignal,
          width: signalWidths.get(sourceSignal)
        });
      }
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

    if (assignment.reset) {
      const resetPort = modulePorts.find((port) => port.name === assignment.reset);
      if (resetPort) {
        edges.push({
          id: edgeId(stableId('port', match.name, resetPort.name), assignment.nodeId, 'reset'),
          source: stableId('port', match.name, resetPort.name),
          target: assignment.nodeId,
          sourcePort: resetPort.id,
          targetPort: stableId('reset'),
          label: assignment.reset,
          signal: assignment.reset
        });
      }
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
        signal: assignment.target,
        width: signalWidths.get(assignment.target)
      });
    }
  }

  return { nodes: [...nodes, ...combNodes], edges };
}

function parseAlwaysFfTiming(eventExpression: string, block: string): RegisterTimingInfo {
  const edgeTerms = [...eventExpression.matchAll(/\b(posedge|negedge)\s+([A-Za-z_$][\w$]*)/g)].map((term) => ({
    edge: term[1],
    signal: term[2]
  }));

  const fallbackClock = edgeTerms[0]?.signal ?? 'clk';
  const clockTerm = edgeTerms.find((term) => /^c/i.test(term.signal)) ?? edgeTerms[0];
  const clockSignal = clockTerm?.signal ?? fallbackClock;
  const resetTerm = edgeTerms.find((term) => term.signal !== clockSignal);
  if (resetTerm) {
    return {
      clockSignal,
      resetSignal: resetTerm.signal,
      resetKind: 'async',
      resetActiveLow: resetTerm.edge === 'negedge'
    };
  }

  const syncReset = detectSynchronousReset(block, clockSignal);
  if (syncReset) {
    return {
      clockSignal,
      resetSignal: syncReset.signal,
      resetKind: 'sync',
      resetActiveLow: syncReset.activeLow
    };
  }

  return {
    clockSignal,
    resetKind: 'none'
  };
}

function detectSynchronousReset(block: string, clockSignal: string): { signal: string; activeLow: boolean } | undefined {
  const condition = block.match(/\bif\s*\(([^)]*)\)/)?.[1];
  if (!condition) {
    return undefined;
  }

  const identifiers = expressionIdentifiers(condition).filter((identifier) => identifier !== clockSignal);
  if (identifiers.length === 0) {
    return undefined;
  }

  const resetSignal = identifiers.find((identifier) => !/^c/i.test(identifier)) ?? identifiers[0];
  return {
    signal: resetSignal,
    activeLow: isActiveLowResetCondition(condition, resetSignal)
  };
}

function isActiveLowResetCondition(condition: string, signal: string): boolean {
  const escapedSignal = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:!|~)\\s*${escapedSignal}\\b`).test(condition)
    || new RegExp(`\\b${escapedSignal}\\s*==\\s*(?:1'?b0|1'?d0|0)\\b`).test(condition)
    || new RegExp(`\\b${escapedSignal}\\s*!=\\s*(?:1'?b1|1'?d1|1)\\b`).test(condition);
}

function chooseRegisterDataExpression(expressions: string[], resetSignal?: string): string {
  if (expressions.length === 0) {
    return '';
  }

  if (resetSignal) {
    const preferred = expressions.find((expression) => !expressionIdentifiers(expression).includes(resetSignal));
    if (preferred) {
      return preferred;
    }
  }

  return expressions[expressions.length - 1];
}

function extractMuxes(
  match: ModuleMatch,
  modulePorts: DiagramPort[],
  existingNodes: DiagramNode[] = [],
  signalWidths: Map<string, string> = new Map()
): MuxExtraction {
  const nodes: DiagramNode[] = [];
  const edges: DesignModule['edges'] = [];
  const muxKeyCounts = new Map<string, number>();
  const caseRegex = /\bcase\s*\(([^)]*)\)([\s\S]*?)\bendcase\b/g;
  let caseMatch: RegExpExecArray | null;

  while ((caseMatch = caseRegex.exec(match.body))) {
    const selector = caseMatch[1].trim() || 'sel';
    const selectorIdentifiers = expressionIdentifiers(selector);
    const selectorSignal = isSimpleIdentifierExpression(selector, selectorIdentifiers[0] ?? '') ? selectorIdentifiers[0] : undefined;
    const selectorPortName = selectorSignal ?? 's';
    const assignments = [...caseMatch[2].matchAll(/([^:;]+):\s*([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)].map((assignment) => ({
      caseLabel: assignment[1].trim(),
      target: assignment[2],
      expression: assignment[3].trim()
    }));
    const outputSignal = assignments[0]?.target ?? 'out';
    const inputCases = uniqueBy(
      assignments
        .map((assignment) => ({
          signal: firstIdentifier(assignment.expression),
          label: assignment.caseLabel
        }))
        .filter((input): input is { signal: string; label: string } => Boolean(input.signal)),
      (input) => input.signal
    );
    const inputSignals = unique([
      selectorSignal,
      ...inputCases.map((input) => input.signal)
    ].filter((signal): signal is string => Boolean(signal)));
    const muxKey = stableId('mux', match.name, outputSignal, selector);
    const muxKeyCount = muxKeyCounts.get(muxKey) ?? 0;
    muxKeyCounts.set(muxKey, muxKeyCount + 1);
    const nodeId = muxKeyCount === 0 ? muxKey : stableId(muxKey, muxKeyCount.toString());
    const combined = match.header + ';' + match.body;
    const selectedSelector = parseSelectExpression(selector);
    if (selectedSelector) {
      const source = ensureBusTap(edges, match.name, modulePorts, nodes, [...existingNodes, ...nodes], signalWidths, selectedSelector.base, selectedSelector.select);
      if (source) {
        pushUniqueEdge(edges, {
          id: edgeId(source.nodeId, nodeId, selectorPortName),
          source: source.nodeId,
          target: nodeId,
          sourcePort: source.portId,
          targetPort: stableId('in', selectorPortName),
          label: undefined,
          signal: selectedSelector.signal,
          width: selectedSelector.width
        });
      }
    } else if (!selectorSignal && selectorIdentifiers.length > 0) {
      const sourceRange = {
        file: match.file,
        startLine: match.startLine + lineAt(combined, match.header.length + 1 + caseMatch.index) - 1,
        startColumn: columnAt(combined, match.header.length + 1 + caseMatch.index),
        endLine: match.startLine + lineAt(combined, match.header.length + 1 + caseMatch.index + caseMatch[0].length) - 1,
        endColumn: columnAt(combined, match.header.length + 1 + caseMatch.index + caseMatch[0].length)
      };
      const selectorComb = createCombNode(match, selectorPortName, selector, selectorIdentifiers, stableId(nodeId, 'selector'), undefined, sourceRange);
      nodes.push(selectorComb);
      connectSignalsToNode(edges, match.name, selectorIdentifiers, modulePorts, [...existingNodes, ...nodes], selectorComb.id);
      pushUniqueEdge(edges, {
        id: edgeId(selectorComb.id, nodeId, selectorPortName),
        source: selectorComb.id,
        target: nodeId,
        sourcePort: stableId('out', selectorPortName),
        targetPort: stableId('in', selectorPortName),
        label: selectorPortName,
        signal: selectorPortName
      });
    }
    nodes.push({
      id: nodeId,
      kind: 'mux',
      label: `case ${selector}`,
      parentModule: match.name,
      ports: [
        { id: stableId('in', selectorPortName), name: selectorPortName, label: 's', direction: 'input' as const, width: selectedSelector?.width ?? signalWidths.get(selectorPortName) },
        ...inputCases.map((input) => ({
          id: stableId('in', input.signal),
          name: input.signal,
          label: input.label,
          direction: 'input' as const,
          width: signalWidths.get(input.signal)
        })),
        { id: stableId('out', outputSignal), name: outputSignal, direction: 'output', width: signalWidths.get(outputSignal) }
      ],
      source: {
        file: match.file,
        startLine: match.startLine + lineAt(combined, match.header.length + 1 + caseMatch.index) - 1,
        startColumn: columnAt(combined, match.header.length + 1 + caseMatch.index),
        endLine: match.startLine + lineAt(combined, match.header.length + 1 + caseMatch.index + caseMatch[0].length) - 1,
        endColumn: columnAt(combined, match.header.length + 1 + caseMatch.index + caseMatch[0].length)
      }
    });

    for (const signal of inputSignals) {
      if (selectedSelector && signal === selectedSelector.signal) {
        continue;
      }
      const source = signalSource(match.name, signal, modulePorts, [...existingNodes, ...nodes]);
      if (source) {
        pushUniqueEdge(edges, {
          id: edgeId(source.nodeId, nodeId, signal),
          source: source.nodeId,
          target: nodeId,
          sourcePort: source.portId,
          targetPort: stableId('in', signal),
          label: signal,
          signal,
          width: signalWidths.get(signal)
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
        signal: outputSignal,
        width: signalWidths.get(outputSignal)
      });
    }
  }

  return { nodes, edges };
}

function extractContinuousAssigns(
  match: ModuleMatch,
  modulePorts: DiagramPort[],
  nodes: DiagramNode[],
  signalWidths: Map<string, string>
): ContinuousAssignExtraction {
  const combNodes: DiagramNode[] = [];
  const edges: DesignModule['edges'] = [];
  const assignRegex = /\bassign\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  let assignment: RegExpExecArray | null;

  while ((assignment = assignRegex.exec(match.body))) {
    const targetSignal = assignment[1];
    const expression = assignment[2].trim();
    const refs = expressionSignalRefs(expression);
    const sourceSignal = refs[0]?.signal;
    if (!sourceSignal) {
      continue;
    }

    const selected = parseSelectExpression(expression);
    if (selected) {
      const source = ensureBusTap(edges, match.name, modulePorts, combNodes, [...nodes, ...combNodes], signalWidths, selected.base, selected.select);
      const target = signalTarget(match.name, targetSignal, modulePorts, nodes);
      if (source && target) {
        pushUniqueEdge(edges, {
          id: edgeId(source.nodeId, target.nodeId, selected.signal),
          source: source.nodeId,
          target: target.nodeId,
          sourcePort: source.portId,
          targetPort: target.portId,
          label: undefined,
          signal: selected.signal,
          width: selected.width
        });
      }
      continue;
    }

    if (!isSimpleIdentifierExpression(expression, sourceSignal)) {
      const combined = match.header + ';' + match.body;
      const sourceRange = {
        file: match.file,
        startLine: match.startLine + lineAt(combined, match.header.length + 1 + assignment.index) - 1,
        startColumn: columnAt(combined, match.header.length + 1 + assignment.index),
        endLine: match.startLine + lineAt(combined, match.header.length + 1 + assignment.index + assignment[0].length) - 1,
        endColumn: columnAt(combined, match.header.length + 1 + assignment.index + assignment[0].length)
      };
      const comb = createCombNode(match, targetSignal, expression, refs, assignRegex.lastIndex.toString(), signalWidths.get(targetSignal), sourceRange);
      combNodes.push(comb);
      connectSignalRefsToNode(edges, match.name, refs, modulePorts, combNodes, [...nodes, ...combNodes], signalWidths, comb.id);

      const target = signalTarget(match.name, targetSignal, modulePorts, nodes);
      if (target) {
        pushUniqueEdge(edges, {
          id: edgeId(comb.id, target.nodeId, targetSignal),
          source: comb.id,
          target: target.nodeId,
          sourcePort: stableId('out', targetSignal),
          targetPort: target.portId,
          label: targetSignal,
          signal: targetSignal,
          width: signalWidths.get(targetSignal)
        });
      }
      continue;
    }

    const source = signalSource(match.name, sourceSignal, modulePorts, nodes);
    const target = signalTarget(match.name, targetSignal, modulePorts, nodes);
    if (!source || !target) {
      continue;
    }

    pushUniqueEdge(edges, {
      id: edgeId(source.nodeId, target.nodeId, sourceSignal),
      source: source.nodeId,
      target: target.nodeId,
      sourcePort: source.portId,
      targetPort: target.portId,
      label: sourceSignal,
      signal: sourceSignal,
      width: signalWidths.get(sourceSignal)
    });
  }

  return { nodes: combNodes, edges };
}

function createCombNode(
  match: ModuleMatch,
  targetSignal: string,
  expression: string,
  signals: Array<string | SignalRef>,
  discriminator: string,
  outputWidth?: string,
  sourceRange?: { file: string; startLine: number; endLine: number }
): DiagramNode {
  const refs = signals.map((signal) => typeof signal === 'string'
    ? signalRef(signal)
    : signal);
  return {
    id: stableId('comb', match.name, targetSignal, discriminator),
    kind: 'comb',
    label: '',
    parentModule: match.name,
    ports: [
      ...refs.map((ref) => ({
        id: stableId('in', ref.signal),
        name: ref.signal,
        label: ref.label,
        direction: 'input' as const,
        width: ref.width
      })),
      { id: stableId('out', targetSignal), name: targetSignal, direction: 'output', width: outputWidth }
    ],
    metadata: {
      expression,
      width: outputWidth
    },
    source: sourceRange ?? {
      file: match.file,
      startLine: match.startLine
    }
  };
}

function connectSignalRefsToNode(
  edges: DesignModule['edges'],
  moduleName: string,
  refs: SignalRef[],
  modulePorts: DiagramPort[],
  mutableNodes: DiagramNode[],
  sourceNodes: DiagramNode[],
  signalWidths: Map<string, string>,
  targetNodeId: string
): void {
  for (const ref of refs) {
    const source = ref.select
      ? ensureBusTap(edges, moduleName, modulePorts, mutableNodes, sourceNodes, signalWidths, ref.sourceSignal, ref.select)
      : signalSource(moduleName, ref.sourceSignal, modulePorts, sourceNodes);
    if (source) {
      pushUniqueEdge(edges, {
        id: edgeId(source.nodeId, targetNodeId, ref.signal),
        source: source.nodeId,
        target: targetNodeId,
        sourcePort: source.portId,
        targetPort: stableId('in', ref.signal),
        label: ref.select ? undefined : ref.label ?? ref.signal,
        signal: ref.signal,
        width: ref.width ?? signalWidths.get(ref.sourceSignal)
      });
    }
  }
}

function connectSignalsToNode(
  edges: DesignModule['edges'],
  moduleName: string,
  identifiers: string[],
  modulePorts: DiagramPort[],
  nodes: DiagramNode[],
  targetNodeId: string
): void {
  for (const identifier of identifiers) {
    const source = signalSource(moduleName, identifier, modulePorts, nodes);
    if (source) {
      pushUniqueEdge(edges, {
        id: edgeId(source.nodeId, targetNodeId, identifier),
        source: source.nodeId,
        target: targetNodeId,
        sourcePort: source.portId,
        targetPort: stableId('in', identifier),
        label: identifier,
        signal: identifier
      });
    }
  }
}

function ensureBusTap(
  edges: DesignModule['edges'],
  moduleName: string,
  modulePorts: DiagramPort[],
  mutableNodes: DiagramNode[],
  sourceNodes: DiagramNode[],
  signalWidths: Map<string, string>,
  baseSignal: string,
  select: string
): { nodeId: string; portId: string } | undefined {
  const nodeId = stableId('bus', moduleName, baseSignal);
  const signal = `${baseSignal}${select}`;
  const outputPortId = stableId('out', signal);
  let busNode = mutableNodes.find((node) => node.id === nodeId) ?? sourceNodes.find((node) => node.id === nodeId);

  if (!busNode) {
    busNode = {
      id: nodeId,
      kind: 'bus',
      label: baseSignal,
      parentModule: moduleName,
      ports: [
        {
          id: stableId('in', baseSignal),
          name: baseSignal,
          direction: 'input',
          width: signalWidths.get(baseSignal)
        }
      ],
      metadata: {
        width: signalWidths.get(baseSignal)
      }
    };
    mutableNodes.push(busNode);
  }

  if (!busNode.ports.some((port) => port.id === outputPortId)) {
    busNode.ports.push({
      id: outputPortId,
      name: signal,
      label: select,
      direction: 'output',
      width: widthForSelect(select)
    });
  }

  const source = signalSource(moduleName, baseSignal, modulePorts, sourceNodes.filter((node) => node.id !== nodeId));
  if (source) {
    pushUniqueEdge(edges, {
      id: edgeId(source.nodeId, nodeId, baseSignal),
      source: source.nodeId,
      target: nodeId,
      sourcePort: source.portId,
      targetPort: stableId('in', baseSignal),
      label: undefined,
      signal: baseSignal,
      width: signalWidths.get(baseSignal)
    });
  }

  return {
    nodeId,
    portId: outputPortId
  };
}

function signalSource(
  moduleName: string,
  signal: string,
  modulePorts: DiagramPort[],
  nodes: DiagramNode[]
): { nodeId: string; portId: string } | undefined {
  const sourceMux = nodes.find((node) => node.kind === 'mux' && node.ports.some((port) => port.direction === 'output' && port.name === signal));
  if (sourceMux) {
    return {
      nodeId: sourceMux.id,
      portId: stableId('out', signal)
    };
  }

  const sourceRegister = nodes.find((node) => node.kind === 'register' && node.label === signal);
  if (sourceRegister) {
    return {
      nodeId: sourceRegister.id,
      portId: stableId('q')
    };
  }

  const sourceComb = nodes.find((node) => node.kind === 'comb' && node.ports.some((port) => port.direction === 'output' && port.name === signal));
  if (sourceComb) {
    return {
      nodeId: sourceComb.id,
      portId: stableId('out', signal)
    };
  }

  const sourceInstance = nodes.find((node) => node.kind === 'instance' && node.ports.some((port) => port.direction === 'output' && (port.connectedSignal ?? port.name) === signal));
  if (sourceInstance) {
    const port = sourceInstance.ports.find((port) => port.direction === 'output' && (port.connectedSignal ?? port.name) === signal);
    return {
      nodeId: sourceInstance.id,
      portId: port!.id
    };
  }

  const sourceBus = nodes.find((node) => node.kind === 'bus' && node.ports.some((port) => port.direction === 'output' && port.name === signal));
  if (sourceBus) {
    return {
      nodeId: sourceBus.id,
      portId: stableId('out', signal)
    };
  }

  const sourcePort = modulePorts.find((port) => port.name === signal);
  if (sourcePort) {
    return {
      nodeId: stableId('port', moduleName, sourcePort.name),
      portId: sourcePort.id
    };
  }

  return undefined;
}

function signalTarget(
  moduleName: string,
  signal: string,
  modulePorts: DiagramPort[],
  nodes: DiagramNode[]
): { nodeId: string; portId: string } | undefined {
  const targetRegister = nodes.find((node) => node.kind === 'register' && node.label === signal);
  if (targetRegister) {
    return {
      nodeId: targetRegister.id,
      portId: stableId('d')
    };
  }

  const targetPort = modulePorts.find((port) => port.name === signal);
  if (targetPort) {
    return {
      nodeId: stableId('port', moduleName, targetPort.name),
      portId: targetPort.id
    };
  }

  return undefined;
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
      const combined = match.header + ';' + match.body;
      const line = match.startLine + lineAt(combined, match.header.length + 1 + unknown.index) - 1;
      const column = columnAt(combined, match.header.length + 1 + unknown.index);
      if (occupiedLines.has(line)) {
        continue;
      }
      const trimmedMatch = unknown[0].trimEnd();
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
          startLine: line,
          startColumn: column,
          endLine: line + lineAt(trimmedMatch, trimmedMatch.length) - 1,
          endColumn: columnAt(trimmedMatch, trimmedMatch.length)
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
        let childPort: DiagramPort | undefined;
        if (port.position !== undefined) {
          childPort = childModule?.ports.find((candidate) => candidate.position === port.position);
        } else {
          childPort = childModule?.ports.find((candidate) => candidate.name === port.name);
        }

        if (childPort) {
          return {
            ...port,
            id: stableId('port', childPort.name),
            name: childPort.name,
            direction: childPort.direction,
            width: childPort.width
          };
        }
        return port;
      });
    }
  }

  for (const designModule of Object.values(graph.modules)) {
    for (const instance of designModule.nodes.filter((node) => node.kind === 'instance')) {
      for (const port of instance.ports) {
        const signal = port.connectedSignal ?? port.name;
        const modulePort = designModule.ports.find((candidate) => candidate.name === signal);

        if (port.direction === 'output') {
          if (!modulePort) {
            continue;
          }
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
          const source = signalSource(designModule.name, signal, designModule.ports, designModule.nodes);
          if (!source) {
            continue;
          }
          pushUniqueEdge(designModule.edges, {
            id: edgeId(source.nodeId, instance.id, signal),
            source: source.nodeId,
            target: instance.id,
            sourcePort: source.portId,
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

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const uniqueValues: T[] = [];
  for (const value of values) {
    const valueKey = key(value);
    if (seen.has(valueKey)) {
      continue;
    }
    seen.add(valueKey);
    uniqueValues.push(value);
  }
  return uniqueValues;
}

function expressionSignalRefs(expression: string): SignalRef[] {
  const refs: SignalRef[] = [];
  let masked = expression;
  for (const select of expression.matchAll(/\b([A-Za-z_$][\w$]*)\s*(\[[^\]]+\])/g)) {
    const base = select[1];
    const range = normalizeSelect(select[2]);
    const full = `${base}${range}`;
    refs.push({
      signal: full,
      sourceSignal: base,
      select: range,
      label: range,
      width: widthForSelect(range)
    });
    masked = masked.replace(select[0], ' '.repeat(select[0].length));
  }

  for (const identifier of expressionIdentifiers(masked)) {
    refs.push(signalRef(identifier));
  }

  return uniqueBy(refs, (ref) => ref.signal);
}

function signalRef(signal: string): SignalRef {
  return {
    signal,
    sourceSignal: signal
  };
}

function parseSelectExpression(expression: string): { base: string; select: string; signal: string; width?: string } | undefined {
  const selected = expression.trim().match(/^([A-Za-z_$][\w$]*)\s*(\[[^\]]+\])$/);
  if (!selected) {
    return undefined;
  }

  const select = normalizeSelect(selected[2]);
  return {
    base: selected[1],
    select,
    signal: `${selected[1]}${select}`,
    width: widthForSelect(select)
  };
}

function normalizeSelect(select: string): string {
  return `[${select.slice(1, -1).replace(/\s+/g, '')}]`;
}

function widthForSelect(select: string): string | undefined {
  const range = select.match(/^\[(\d+):(\d+)\]$/);
  if (range) {
    const msb = Number(range[1]);
    const lsb = Number(range[2]);
    return `[${Math.abs(msb - lsb)}:0]`;
  }

  return select.match(/^\[\d+\]$/) ? '[0:0]' : undefined;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function columnAt(text: string, index: number): number {
  const before = text.slice(0, index);
  const lastLine = before.split(/\r?\n/).pop()!;
  return lastLine.length;
}

function firstIdentifier(expression: string): string | undefined {
  return expression.match(/\b[A-Za-z_$][\w$]*\b/)?.[0];
}

function expressionIdentifiers(expression: string): string[] {
  return unique(
    [...expression.matchAll(/\b[A-Za-z_$][\w$]*\b/g)]
      .map((match) => match[0])
      .filter((identifier) => !KEYWORDS.has(identifier))
  );
}

function isSimpleIdentifierExpression(expression: string, identifier: string): boolean {
  return expression.trim() === identifier;
}
