import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesignGraph, DesignModule, DiagramNode, DiagramPort, DiagramEdge, DiagramNodeMetadata, DiagramEdgeMetadata, SourceRange } from '../ir/types';
import { edgeId, stableId } from '../ir/ids';
import { orderGraphModules } from './moduleOrdering';
import { extractDesignFromText } from './textExtractor';

const execFileAsync = promisify(execFile);

export async function extractDesignWithUhdm(
  files: string[],
  workspaceRoot: string,
  surelogPath: string,
  backendPath: string,
  includePaths?: string[],
  defines?: Record<string, string>
): Promise<DesignGraph> {
  const tmpDir = path.join(workspaceRoot, '.svsch', 'uhdm_tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const surelogArgs = [
      '-parse',
      '-sverilog',
      '-fileunit',
      '-nopython',
      '-o', tmpDir
    ];

    if (includePaths) {
      for (const inc of includePaths) {
        // Resolve relative to workspace root if not absolute
        const absPath = path.isAbsolute(inc) ? inc : path.resolve(workspaceRoot, inc);
        surelogArgs.push('-I' + absPath);
      }
    }

    if (defines) {
      for (const [key, val] of Object.entries(defines)) {
        surelogArgs.push(`+define+${key}=${val}`);
      }
    }

    surelogArgs.push(...files);

    try {
        await execFileAsync(surelogPath, surelogArgs);
    } catch (e: any) {
        const errorDetails = [
            `Surelog failed with exit code ${e.code}`,
            e.stderr ? `Stderr:\n${e.stderr}` : '',
            e.stdout ? `Stdout:\n${e.stdout}` : ''
        ].filter(Boolean).join('\n\n');
        throw new Error(errorDetails);
    }

    const uhdmFile = await findSurelogUhdmFile(tmpDir);
    if (!(await fileExists(uhdmFile))) {
      throw new Error(`Surelog failed to generate UHDM file under ${tmpDir}`);
    }

    const { stdout, stderr } = await execFileAsync(backendPath, [uhdmFile]);
    if (stderr) {
        console.error(`[SVSCH] Backend Stderr: ${stderr}`);
    }

    const raw: RawUhdmIr = JSON.parse(stdout);
    const graph = transformToDesignGraph(raw, workspaceRoot);

    const sourceGraph = await extractSourceAwareGraph(files, workspaceRoot);
    mergeBusNodesFromSourceGraph(graph, workspaceRoot, sourceGraph);
    repairResolvedExplicitBusCompositions(graph);
    repairResolvedBusCompositionSlices(graph);
    repairAggregateAssignmentBuses(graph);
    repairInterfaceFieldBitBreakouts(graph);

    // Final cleanup: remove redundant edges with placeholder signals/ports if better ones exist
    // AND remove direct port-to-port connections that are already represented via a bus node.
    for (const module of Object.values(graph.modules)) {
        const busNodes = module.nodes.filter(n => n.kind === 'bus');

        // 0. Remove placeholder ports ([?]) if better ones exist
        for (const bus of busNodes) {
            const outputs = bus.ports.filter(p => p.direction === 'output');
            const placeholders = outputs.filter(p => (p.label || '').includes('?'));
            const goodOnes = outputs.filter(p => !(p.label || '').includes('?'));

            if (placeholders.length > 0 && goodOnes.length > 0) {
                // If we have a placeholder and at least one good port,
                // try to see if any placeholder is redundant.
                bus.ports = bus.ports.filter(p => !placeholders.includes(p));
                
                // Also need to update edges that used the placeholder ports
                for (const ph of placeholders) {
                    const edges = module.edges.filter(e => e.source === bus.id && e.sourcePort === ph.id);
                    for (const edge of edges) {
                        module.edges = module.edges.filter(e => e !== edge);
                    }
                }
            }
        }

        // 1. Remove redundant edges from same bus to same target
        for (const bus of busNodes) {
            const outgoing = module.edges.filter(e => e.source === bus.id);
            const targets = new Set(outgoing.map(e => e.target));
            
            for (const target of targets) {
                const edgesToTarget = outgoing.filter(e => e.target === target);
                if (edgesToTarget.length > 1) {
                    // Group by target port to avoid collapsing different field/slice connections
                    const portGroups = new Map<string | undefined, DiagramEdge[]>();
                    for (const edge of edgesToTarget) {
                        const group = portGroups.get(edge.targetPort) || [];
                        group.push(edge);
                        portGroups.set(edge.targetPort, group);
                    }

                    for (const group of portGroups.values()) {
                        if (group.length > 1) {
                            const betterEdge = group.find(e => e.signal && !e.signal.includes('?'));
                            if (betterEdge) {
                                module.edges = module.edges.filter(e => !(e.source === bus.id && e.target === target && e.targetPort === betterEdge.targetPort && e !== betterEdge));
                            }
                        }
                    }
                }
            }
        }

        // 2. Remove direct port-to-port connections if they are redundant with a bus node path
        for (const bus of busNodes) {
            const incoming = module.edges.filter(e => e.target === bus.id);
            const outgoing = module.edges.filter(e => e.source === bus.id);
            
            for (const inEdge of incoming) {
                for (const outEdge of outgoing) {
                    // Path: inEdge.source -> bus -> outEdge.target
                    // Look for a direct edge inEdge.source -> outEdge.target
                    const directEdgeIndex = module.edges.findIndex(e => 
                        e.source === inEdge.source && 
                        e.target === outEdge.target &&
                        !busNodes.some(b => b.id === e.target || b.id === e.source) // Not another bus node
                    );

                    if (directEdgeIndex !== -1) {
                        // Found a direct edge that is redundant with this bus path
                        module.edges.splice(directEdgeIndex, 1);
                    }
                }
            }
        }

        // 3. Remove placeholder expression bus nodes when the source-aware graph has
        // recovered a concrete bus tap feeding the same node input.
        const placeholderBusIds = new Set(
            busNodes
                .filter((bus) => bus.label === 'expr' || bus.label === '?')
                .filter((bus) => {
                    const outgoing = module.edges.filter((edge) => edge.source === bus.id);
                    return outgoing.length > 0 && outgoing.every((edge) => {
                        return module.edges.some((candidate) => (
                            candidate.source !== bus.id
                            && busNodes.some((candidateBus) => candidateBus.id === candidate.source && candidateBus.label !== 'expr' && candidateBus.label !== '?')
                            && candidate.target === edge.target
                            && candidate.targetPort === edge.targetPort
                        ));
                    });
                })
                .map((bus) => bus.id)
        );

        if (placeholderBusIds.size > 0) {
            module.edges = module.edges.filter((edge) => !placeholderBusIds.has(edge.source) && !placeholderBusIds.has(edge.target));
            module.nodes = module.nodes.filter((node) => !placeholderBusIds.has(node.id));
        }
    }

    removeUnconnectedLiteralNodes(graph);

    // Multi-driver check
    for (const module of Object.values(graph.modules)) {
        const drivers = new Map<string, string[]>();
        for (const edge of module.edges) {
            if (edge.signal) {
                if (!drivers.has(edge.signal)) drivers.set(edge.signal, []);
                drivers.get(edge.signal)!.push(edge.source);
            }
        }

        for (const [signal, sources] of drivers.entries()) {
            const uniqueSources = Array.from(new Set(sources));
            if (uniqueSources.length > 1) {
                graph.diagnostics.push({
                    severity: 'error',
                    message: `${module.name}.${signal} has multiple diagram drivers: ${uniqueSources.join(', ')}`
                });
            }
        }
    }

    return orderGraphModules(graph);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function extractSourceAwareGraph(files: string[], workspaceRoot: string): Promise<DesignGraph | undefined> {
  try {
    const sourceFiles = await Promise.all(files.map(async (f) => ({
      file: f,
      text: await fs.readFile(f, 'utf-8')
    })));
    return extractDesignFromText(sourceFiles);
  } catch (err) {
    console.error(`[SVSCH] Failed to extract source-aware graph: ${err}`);
    return undefined;
  }
}

function mergeBusNodesFromSourceGraph(graph: DesignGraph, workspaceRoot: string, sourceGraph?: DesignGraph): void {
  if (!sourceGraph) {
    return;
  }

  for (const [moduleName, sourceModule] of Object.entries(sourceGraph.modules)) {
    const targetModule = graph.modules[moduleName];
    if (!targetModule) {
      continue;
    }

    // Map of source node IDs to target node IDs (to fix edges later)
    const nodeIdMap = new Map<string, string>();

    // Merge port widths and source locations from sourceModule into targetModule
    for (const sourcePort of sourceModule.ports) {
      const targetPort = targetModule.ports.find((p) => p.name === sourcePort.name);
      if (targetPort) {
        nodeIdMap.set(stableId('port', moduleName, sourcePort.name), stableId('port', moduleName, targetPort.name));
        if (!targetPort.width || targetPort.width === '[0:0]') {
          targetPort.width = sourcePort.width;
          
          // Propagate width to edges from this module port
          for (const edge of targetModule.edges) {
              if (edge.source === stableId('port', moduleName, targetPort.name)) {
                  edge.width = targetPort.width;
              }
          }
        }
        if (targetPort.width) {
          for (const node of targetModule.nodes) {
            if (node.kind !== 'replicate') continue;
            for (const port of node.ports) {
              if (port.connectedSignal === targetPort.name && (!port.width || port.width === '[0:0]')) {
                port.width = targetPort.width;
              }
            }
          }
        }
        // If UHDM reported line 1 (module header) but source parser found a body declaration,
        // or if UHDM has no source info at all.
        if (sourcePort.source && (!targetPort.source || targetPort.source.startLine === 1)) {
            targetPort.source = {
                ...sourcePort.source,
                file: path.relative(workspaceRoot, sourcePort.source.file)
            };
        }
      }
    }

    // Merge node information (widths and sources)
    for (const sourceNode of sourceModule.nodes) {
        let targetNode = targetModule.nodes.find(n => n.label === sourceNode.label && n.kind === sourceNode.kind && n.label !== '');
        if (!targetNode) {
            targetNode = targetModule.nodes.find(n => n.id === sourceNode.id);
        }
        
        // Special matching for combinational/bus/struct blocks if no label match
        if (!targetNode && (sourceNode.kind === 'comb' || sourceNode.kind === 'alu' || sourceNode.kind === 'bus' || sourceNode.kind === 'struct')) {
            const sourceOutput = sourceNode.ports.find(p => p.direction === 'output')?.name;
            if (sourceOutput) {
                targetNode = targetModule.nodes.find(n => 
                    (n.kind === 'comb' || n.kind === 'alu' || n.kind === 'bus' || n.kind === 'struct') && 
                    n.ports.some(p => {
                        if (p.direction !== 'output') return false;
                        if (p.name === sourceOutput) return true;
                        // For registers, text parser might use 'y_ff' while UHDM uses 'y_ff_next'
                        if (sourceOutput.endsWith('_next') && p.name === sourceOutput.slice(0, -5)) return true;
                        if (p.name.endsWith('_next') && sourceOutput === p.name.slice(0, -5)) return true;
                        return false;
                    })
                );
            }
        }
        
        if (targetNode) {
            nodeIdMap.set(sourceNode.id, targetNode.id);
            // Merge source info: trust text parser for most nodes, but keep UHDM's 
            // refined ranges for bus/struct/alu compositions.
            if (sourceNode.source && targetNode.kind !== 'bus' && targetNode.kind !== 'struct' && targetNode.kind !== 'alu') {
                targetNode.source = {
                    ...sourceNode.source,
                    file: path.relative(workspaceRoot, sourceNode.source.file)
                };
            }
            
            // Merge metadata
            if (sourceNode.metadata?.width) {
                if (!targetNode.metadata) targetNode.metadata = {};
                targetNode.metadata.width = sourceNode.metadata.width;
            }

            // Merge widths and signals for ports
            for (const sourcePort of sourceNode.ports) {
                let targetPort = targetNode.ports.find(p => p.name === sourcePort.name);
                if (!targetPort && sourcePort.name.includes('[')) {
                    // Try fuzzy match for selects (UHDM might prefix with module name)
                    const selectPart = sourcePort.name.substring(sourcePort.name.indexOf('['));
                    targetPort = targetNode.ports.find(p => p.name.endsWith(selectPart));
                }

                if (targetPort) {
                    if (sourcePort.width) {
                        targetPort.width = sourcePort.width;
                        
                        // Propagate width to edges where this port is the driver
                        for (const edge of targetModule.edges) {
                            if (edge.source === targetNode.id && edge.sourcePort === targetPort.id) {
                                edge.width = targetPort.width;
                            }
                        }
                    }
                    if (sourcePort.label) {
                        targetPort.label = sourcePort.label;
                    }
                    if (!targetPort.connectedSignal && sourcePort.connectedSignal) {
                        targetPort.connectedSignal = sourcePort.connectedSignal;
                    }
                }
            }
        }
    }

    // Update port kind nodes with the merged widths and sources
    for (const node of targetModule.nodes) {
      if (node.kind === 'port') {
        const port = targetModule.ports.find((p) => p.name === node.label);
        if (port) {
            if (port.width && node.ports[0]) {
              node.ports[0].width = port.width;
            }
            if (port.source) {
                node.source = port.source;
            }
        }
      }
    }

    const busNodes = sourceModule.nodes.filter((node) => node.kind === 'bus');
    if (busNodes.length === 0) {
      continue;
    }

    for (const node of busNodes) {
      // Try to find if this bus node already exists in target graph (either by ID or by same output signal)
      let existing = targetModule.nodes.find((e) => e.id === node.id);
      if (!existing) {
          const sourceOutput = node.ports.find(p => p.direction === 'output')?.name;
          if (sourceOutput) {
              existing = targetModule.nodes.find(n => 
                  n.kind === 'bus' && 
                  n.ports.some(p => p.name === sourceOutput && p.direction === 'output')
              );
          }
      }

      if (!existing) {
        targetModule.nodes.push(node);
      } else {
        nodeIdMap.set(node.id, existing.id);
        // We have an existing UHDM bus node. We need to merge ports carefully.
        // If a port in the source (text) graph connects to the same target as a port
        // in the existing (UHDM) graph, they are likely the same tap.
        for (const sourcePort of node.ports) {
          if (sourcePort.direction === 'input') {
              if (!existing.ports.some(p => p.direction === 'input')) {
                  existing.ports.push(sourcePort);
              }
              continue;
          }

          // Outgoing tap. Check if this tap from text parser corresponds to an existing UHDM tap.
          const sourceEdge = sourceModule.edges.find(e => e.source === node.id && e.sourcePort === sourcePort.id);
          if (sourceEdge) {
              const matchingTargetEdge = targetModule.edges.find(e => e.source === existing.id && e.target === sourceEdge.target);
              if (matchingTargetEdge) {
                  // Found a match! The UHDM tap is likely a lower-quality version of the text tap.
                  // Update the UHDM edge to use the text parser's port ID and info.
                  const oldPortId = matchingTargetEdge.sourcePort;
                  matchingTargetEdge.sourcePort = sourcePort.id;
                  matchingTargetEdge.signal = sourceEdge.signal || matchingTargetEdge.signal;
                  matchingTargetEdge.width = sourcePort.width || matchingTargetEdge.width;

                  // Update or replace the port on the bus node
                  const existingPortIndex = existing.ports.findIndex(p => p.id === oldPortId);
                  if (existingPortIndex !== -1) {
                      existing.ports[existingPortIndex] = {
                          ...sourcePort,
                          id: sourcePort.id // Ensure we use the ID the edge now expects
                      };
                  } else {
                      existing.ports.push(sourcePort);
                  }
                  continue;
              }
          }

          // No match found, just add it if it doesn't exist by ID or label
          if (!existing.ports.some((p) => p.id === sourcePort.id || (p.label === sourcePort.label && p.direction === sourcePort.direction))) {
            existing.ports.push(sourcePort);
          }
        }
      }
    }

    const busNodeIds = new Set(busNodes.map((node) => node.id));

    for (const edge of sourceModule.edges) {
      if (!busNodeIds.has(edge.source) && !busNodeIds.has(edge.target)) {
        continue;
      }

      const mappedSource = nodeIdMap.get(edge.source) ?? edge.source;
      const mappedTarget = nodeIdMap.get(edge.target) ?? edge.target;
      
      const sourceNode = targetModule.nodes.find(n => n.id === mappedSource) || (mappedSource === 'self' ? { id: 'self', kind: 'port', label: '', ports: targetModule.ports.map(p => ({ id: stableId('port', moduleName, p.name), name: p.name, direction: p.direction, signal: p.name, width: p.width })) } as DiagramNode : null);
      const targetNode = targetModule.nodes.find(n => n.id === mappedTarget) || (mappedTarget === 'self' ? { id: 'self', kind: 'port', label: '', ports: targetModule.ports.map(p => ({ id: stableId('port', moduleName, p.name), name: p.name, direction: p.direction, signal: p.name, width: p.width })) } as DiagramNode : null);

      if (!sourceNode || !targetNode) {
          continue;
      }

      // Check if ports exist, otherwise try to map them or skip
      let mappedSourcePort = edge.sourcePort;
      if (!sourceNode.ports.some(p => p.id === mappedSourcePort)) {
          // Try to find a port with same name/label
          const sourceModuleNode = sourceModule.nodes.find(n => n.id === (edge.source === 'self' ? 'self' : edge.source));
          const sourcePortObj = sourceModuleNode?.ports.find(p => p.id === edge.sourcePort);
          if (sourcePortObj) {
              const matchingTargetPort = sourceNode.ports.find(p => p.name === sourcePortObj.name || (sourcePortObj.label && p.label === sourcePortObj.label));
              if (matchingTargetPort) {
                  mappedSourcePort = matchingTargetPort.id;
              } else {
                  continue; // Port not found in target
              }
          } else {
              continue;
          }
      }

      let mappedTargetPort = edge.targetPort;
      if (!targetNode.ports.some(p => p.id === mappedTargetPort)) {
          const sourceModuleNode = sourceModule.nodes.find(n => n.id === (edge.target === 'self' ? 'self' : edge.target));
          const targetPortObj = sourceModuleNode?.ports.find(p => p.id === edge.targetPort);
          if (targetPortObj) {
              const matchingTargetPort = targetNode.ports.find(p => p.name === targetPortObj.name || (targetPortObj.label && p.label === targetPortObj.label));
              if (matchingTargetPort) {
                  mappedTargetPort = matchingTargetPort.id;
              } else {
                  continue; // Port not found in target
              }
          } else {
              continue;
          }
      }

      // If it's a bus edge, check if it's already represented (perhaps under a different port ID merged above)
      const duplicate = targetModule.edges.some((existing) =>
        existing.source === mappedSource
        && existing.target === mappedTarget
        && (existing.sourcePort === mappedSourcePort || existing.target === mappedTarget) // Loose match for bus taps
        && existing.targetPort === mappedTargetPort
      );

      if (!duplicate) {
        targetModule.edges.push({
            ...edge,
            source: mappedSource,
            target: mappedTarget,
            sourcePort: mappedSourcePort,
            targetPort: mappedTargetPort,
            id: edgeId(mappedSource, mappedTarget, edge.signal || Math.random().toString())
        });
      }
    }
  }
}

function repairResolvedBusCompositionSlices(graph: DesignGraph): void {
  for (const module of Object.values(graph.modules)) {
    for (const node of module.nodes) {
      if (!isPromotedConcatBus(node)) continue;
      const inputPorts = node.ports.filter(port => port.direction === 'input');
      if (inputPorts.length === 0) continue;

      const inputWidths = inputPorts.map(port => (
        module.ports.find(modulePort => modulePort.name === port.connectedSignal)?.width
        ?? findNodeOutputWidth(module.nodes, port.connectedSignal)
        ?? port.width
        ?? '[0:0]'
      ));
      const totalSize = inputWidths.reduce((sum, width) => sum + bitSizeFromWidth(width), 0);
      if (totalSize <= 0) continue;

      const outputPort = node.ports.find(port => port.direction === 'output');
      if (outputPort && bitSizeFromWidth(outputPort.width) < totalSize) {
        outputPort.width = widthFromBitSize(totalSize);
      }
      const outputWidth = outputPort?.width;
      if (outputPort?.connectedSignal && outputWidth) {
        for (const consumer of module.nodes) {
          for (const port of consumer.ports) {
            if (port.direction === 'input' && port.connectedSignal === outputPort.connectedSignal) {
              port.width = outputWidth;
            }
          }
        }
      }

      let currentBit = totalSize - 1;
      inputPorts.forEach((port, index) => {
        const width = inputWidths[index];
        const size = bitSizeFromWidth(width);
        const label = concatSliceLabel(currentBit, size);
        if (port.name !== label) {
          (port as DiagramPort & { rawName?: string }).rawName = (port as DiagramPort & { rawName?: string }).rawName ?? port.name;
          port.name = label;
        }
        port.label = label;
        port.width = width;
        currentBit -= size;
      });

      for (const edge of module.edges) {
        if (edge.target === node.id && edge.targetPort) {
          const targetPort = inputPorts.find(port => port.id === edge.targetPort);
          if (targetPort?.width) edge.width = targetPort.width;
        }
        if (edge.source === node.id && edge.sourcePort && outputWidth) {
          const sourcePort = node.ports.find(port => port.id === edge.sourcePort);
          if (sourcePort?.direction === 'output') edge.width = outputWidth;
        }
      }
    }
  }
}

function repairInterfaceFieldBitBreakouts(graph: DesignGraph): void {
  for (const module of Object.values(graph.modules)) {
    const busNodes = module.nodes.filter((node) => node.kind === 'bus');
    if (busNodes.length === 0) continue;

    const additions: DiagramEdge[] = [];
    for (const edge of [...module.edges]) {
      if (!edge.signal?.includes('.')) continue;
      const sourceNode = module.nodes.find((node) => node.id === edge.source);
      const targetNode = module.nodes.find((node) => node.id === edge.target);
      if (sourceNode?.kind !== 'interface' || targetNode?.kind !== 'comb') continue;

      const fieldName = edge.signal.split('.').pop();
      if (!fieldName || !targetNode.metadata?.expression?.includes(`${edge.signal}[`)) continue;

      const breakout = busNodes.find((node) => (
        node.label === fieldName
        && node.ports.some((port) => port.direction === 'input')
        && node.ports.some((port) => port.direction === 'output')
      ));
      if (!breakout) continue;

      const input = breakout.ports.find((port) => port.direction === 'input');
      const output = breakout.ports.find((port) => port.direction === 'output');
      if (!input || !output) continue;

      const originalTarget = edge.target;
      const originalTargetPort = edge.targetPort;
      edge.target = breakout.id;
      edge.targetPort = input.id;
      edge.id = edgeId(edge.source, edge.target, edge.signal);

      const tapSignal = output.name.includes('[') ? `${edge.signal}${output.name.slice(output.name.indexOf('['))}` : edge.signal;
      if (!module.edges.some((candidate) => (
        candidate.source === breakout.id
        && candidate.sourcePort === output.id
        && candidate.target === originalTarget
        && candidate.targetPort === originalTargetPort
      ))) {
        additions.push({
          id: edgeId(breakout.id, originalTarget, tapSignal),
          source: breakout.id,
          sourcePort: output.id,
          target: originalTarget,
          targetPort: originalTargetPort,
          signal: tapSignal,
          width: output.width ?? edge.width,
          metadata: { aggregate: undefined }
        });
      }
    }

    module.edges.push(...additions);
  }
}

function repairResolvedExplicitBusCompositions(graph: DesignGraph): void {
  for (const module of Object.values(graph.modules)) {
    for (const node of module.nodes) {
      if (node.kind !== 'bus' || !node.id.startsWith(`bus_comp:${module.name}:`)) continue;
      const output = node.ports.find(port => port.direction === 'output');
      if (output?.connectedSignal) {
        const declaredWidth = module.ports.find(port => port.name === output.connectedSignal)?.width;
        if (declaredWidth) output.width = declaredWidth;
      }
      for (const port of node.ports) {
        if (port.direction !== 'input') continue;
        const sliceWidth = widthFromSlice(port.name);
        if (sliceWidth) port.width = sliceWidth;
      }
      for (const edge of module.edges) {
        if (edge.target === node.id && edge.targetPort) {
          const targetPort = node.ports.find(port => port.id === edge.targetPort || port.name === edge.targetPort);
          if (targetPort?.width) edge.width = targetPort.width;
        }
        if (edge.source === node.id && edge.sourcePort) {
          const sourcePort = node.ports.find(port => port.id === edge.sourcePort || port.name === edge.sourcePort);
          if (sourcePort?.width) edge.width = sourcePort.width;
        }
      }
    }
  }
}

function repairAggregateAssignmentBuses(graph: DesignGraph): void {
  for (const module of Object.values(graph.modules)) {
    repairAggregateReplicationWidths(module);

    for (const node of module.nodes) {
      if (node.kind !== 'bus' || node.metadata?.expression !== '[aggregate-compose]') continue;
      const output = node.ports.find(port => port.direction === 'output');
      const outputSize = bitSizeFromWidth(output?.width);
      const rhsInputs = node.ports.filter(port => port.direction === 'input' && port.name !== 'rhs_pad');
      const inputWidths = rhsInputs.map(port => (
        module.ports.find(modulePort => modulePort.name === port.connectedSignal)?.width
        ?? findNodeOutputWidth(module.nodes, port.connectedSignal)
        ?? port.width
        ?? '[0:0]'
      ));
      const rhsSize = inputWidths.reduce((sum, width) => sum + bitSizeFromWidth(width), 0);
      let leadingPadSize = 0;

      if (output && rhsSize > outputSize) {
        output.width = widthFromBitSize(rhsSize);
      }

      if (rhsSize >= outputSize) {
        const padPorts = node.ports.filter(port => port.direction === 'input' && port.name === 'rhs_pad');
        if (padPorts.length > 0) {
          const padIds = new Set(padPorts.map(port => port.id));
          node.ports = node.ports.filter(port => !padIds.has(port.id));
          module.edges = module.edges.filter(edge => !(edge.target === node.id && edge.targetPort && padIds.has(edge.targetPort)));
          const liveSignals = new Set(module.edges.flatMap(edge => [edge.signal]).filter(Boolean));
          module.nodes = module.nodes.filter(candidate => !(candidate.kind === 'literal' && candidate.id.includes('aggregate_pad') && !candidate.ports.some(port => liveSignals.has(port.connectedSignal))));
        }
        if (rhsSize === outputSize && node.metadata?.reason === 'rhs padded to lhs width') {
          delete node.metadata.reason;
        }
      } else {
        const pad = node.ports.find(port => port.direction === 'input' && port.name === 'rhs_pad');
        const padSize = outputSize - rhsSize;
        leadingPadSize = padSize;
        node.metadata = { ...node.metadata, reason: 'rhs padded to lhs width' };
        if (pad && padSize > 0) {
          pad.width = widthFromBitSize(padSize);
          pad.label = concatSliceLabel(outputSize - 1, padSize);
        }
      }

      let currentBit = Math.max(0, outputSize - leadingPadSize - 1);
      if (rhsSize > outputSize) currentBit = rhsSize - 1;
      for (let index = 0; index < rhsInputs.length; index++) {
        const port = rhsInputs[index];
        const width = inputWidths[index];
        const size = bitSizeFromWidth(width);
        port.width = width;
        port.label = concatSliceLabel(currentBit, size);
        currentBit -= size;
      }
      pruneDuplicateAggregateInputDrivers(module, node);

      for (const edge of module.edges) {
        if (edge.target === node.id && edge.targetPort) {
          const targetPort = node.ports.find(port => port.id === edge.targetPort || port.name === edge.targetPort);
          if (targetPort?.width) edge.width = targetPort.width;
        }
      }
    }

    for (const node of module.nodes) {
      if (node.kind !== 'bus' || node.metadata?.expression !== '[aggregate-breakout]') continue;
      const input = node.ports.find(port => port.direction === 'input');
      const outputs = node.ports.filter(port => port.direction === 'output');
      const outputWidths = outputs.map(port => (
        widthFromSignalSlice(port.connectedSignal)
        ?? module.ports.find(modulePort => modulePort.name === port.connectedSignal)?.width
        ?? findNodeOutputWidth(module.nodes, port.connectedSignal)
        ?? port.width
        ?? '[0:0]'
      ));
      const outputSize = outputWidths.reduce((sum, width) => sum + bitSizeFromWidth(width), 0);
      if (input && outputSize > bitSizeFromWidth(input.width)) {
        input.width = widthFromBitSize(outputSize);
        for (const edge of module.edges) {
          if (edge.target === node.id && edge.targetPort === input.id) edge.width = input.width;
        }
      }
      const inputSize = bitSizeFromWidth(input?.width);
      let currentBit = Math.max(0, inputSize - 1);
      outputs.forEach((port, index) => {
        const width = outputWidths[index];
        const size = bitSizeFromWidth(width);
        port.width = width;
        port.label = concatSliceLabel(currentBit, size);
        currentBit -= size;
      });
    }
  }
}

function repairAggregateReplicationWidths(module: DesignModule): void {
  for (const node of module.nodes) {
    if (node.kind !== 'replicate') continue;
    const repeatCount = Number(node.metadata?.repeatCount ?? 0);
    if (!Number.isFinite(repeatCount) || repeatCount <= 0) continue;

    const inputs = node.ports.filter(port => port.direction === 'input');
    const bodySize = inputs.reduce((sum, port) => {
      const declared = module.ports.find(modulePort => modulePort.name === port.connectedSignal)?.width;
      const width = declared ?? findNodeOutputWidth(module.nodes, port.connectedSignal) ?? port.width;
      if (declared) port.width = declared;
      return sum + Math.max(1, bitSizeFromWidth(width));
    }, 0);
    if (bodySize <= 0) continue;

    const repeatedWidth = widthFromBitSize(bodySize * repeatCount);
    for (const port of node.ports) {
      if (port.direction !== 'output') continue;
      if (bitSizeFromWidth(port.width) < bitSizeFromWidth(repeatedWidth)) {
        port.width = repeatedWidth;
      }
      for (const edge of module.edges) {
        if (edge.source === node.id && edge.sourcePort === port.id) {
          edge.width = port.width;
        }
      }
    }
  }
}

function pruneDuplicateAggregateInputDrivers(module: DesignModule, aggregateNode: DiagramNode): void {
  const inputsBySignal = new Map<string, DiagramPort[]>();
  for (const port of aggregateNode.ports) {
    if (port.direction !== 'input' || port.name === 'rhs_pad' || !port.connectedSignal) continue;
    const ports = inputsBySignal.get(port.connectedSignal) ?? [];
    ports.push(port);
    inputsBySignal.set(port.connectedSignal, ports);
  }

  for (const [signal, ports] of inputsBySignal) {
    if (ports.length < 2) continue;
    const producers = module.nodes.filter(node => (
      node.id !== aggregateNode.id
      && node.ports.some(port => port.direction === 'output' && port.connectedSignal === signal)
    ));
    if (producers.length < ports.length) continue;

    ports.forEach((port, index) => {
      const expectedProducer = producers[index];
      const producerIds = new Set(producers.map(producer => producer.id));
      module.edges = module.edges.filter(edge => !(
        edge.target === aggregateNode.id
        && edge.targetPort === port.id
        && producerIds.has(edge.source)
        && edge.source !== expectedProducer.id
      ));
    });
  }
}

function removeUnconnectedLiteralNodes(graph: DesignGraph): void {
  for (const module of Object.values(graph.modules)) {
    const connectedNodeIds = new Set<string>();
    for (const edge of module.edges) {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    }
    module.nodes = module.nodes.filter(node => (
      node.kind !== 'literal'
      || connectedNodeIds.has(node.id)
    ));
  }
}

function emptyGraph(): DesignGraph {
  return {
    rootModules: [],
    modules: {},
    diagnostics: [],
    generatedAt: new Date().toISOString()
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findSurelogUhdmFile(tmpDir: string): Promise<string> {
  const candidates = [
    path.join(tmpDir, 'slpp_unit', 'surelog.uhdm'),
    path.join(tmpDir, 'slpp_all', 'surelog.uhdm')
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

interface RawUhdmIr {
    modules: Array<{
        name: string;
        file: string;
        ports: Array<{
            name: string;
            direction: string;
            width: string;
            typeName?: string;
            typeSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
            modportName?: string;
            modportSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
            source: { file: string; line: number; col: number; endLine: number; endCol: number }
        }>;
        nodes: Array<{
            id: string;
            kind: string;
            label: string;
            instanceOf?: string;
            moduleName?: string;
            expression?: string;
            operation?: string;
            resetKind?: string;
            resetActiveLow?: boolean;
            clockSignal?: string;
            resetSignal?: string;
            isProcedural?: boolean;
            inferred?: boolean;
            reason?: string;
            role?: string;
            repeatCount?: number;
            repeatExpression?: string;
            typeName?: string;
            typeSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
            modportName?: string;
            modportSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
            packed?: boolean;
            width?: string;
            fields?: Array<{ name: string; width?: string; bitRange?: string; typeName?: string; direction?: 'input' | 'output' | 'inout' | 'unknown'; source?: { file: string; line: number; col: number; endLine: number; endCol: number } }>;
            aggregateKind?: string;
            metadata?: RawNodeMetadata;
            ports: Array<{
                name: string;
                direction: string;
                signal: string;
                width: string;
                typeName?: string;
                typeSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
                modportName?: string;
                modportSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
                label?: string;
                source?: { file: string; line: number; col: number; endLine: number; endCol: number }
            }>;
            source: { file: string; line: number; col: number; endLine: number; endCol: number };
        }>;
        edges: Array<{
            source: string;
            target: string;
            sourcePort: string;
            targetPort: string;
            signal: string;
            width?: string;
            sourceRange?: { file: string; line: number; col: number; endLine: number; endCol: number };
            metadata?: DiagramEdgeMetadata;
        }>;
    }>;
    rootModules?: string[];
}

type RawModule = RawUhdmIr['modules'][number];
type RawSourceRange = { file: string; line: number; col: number; endLine: number; endCol: number };
type RawNodeMetadata = Omit<DiagramNodeMetadata, 'typeSource' | 'repeatExpressionSource'> & {
    typeSource?: RawSourceRange;
    repeatExpressionSource?: RawSourceRange;
    modportSource?: RawSourceRange;
};
type RawNode = RawModule['nodes'][number];

function rawNodeMetadata(n: RawNode): RawNodeMetadata | undefined {
    const topLevel: RawNodeMetadata = {};
    if (n.expression !== undefined) topLevel.expression = n.expression;
    if (n.operation !== undefined) topLevel.operation = n.operation;
    if (n.resetKind !== undefined) topLevel.resetKind = n.resetKind;
    if (n.resetActiveLow !== undefined) topLevel.resetActiveLow = n.resetActiveLow;
    if (n.clockSignal !== undefined) topLevel.clockSignal = n.clockSignal;
    if (n.resetSignal !== undefined) topLevel.resetSignal = n.resetSignal;
    if (n.isProcedural !== undefined) topLevel.isProcedural = n.isProcedural;
    if (n.inferred !== undefined) topLevel.inferred = n.inferred;
    if (n.reason !== undefined) topLevel.reason = n.reason;
    if (n.role !== undefined) topLevel.role = n.role;
    if (n.repeatCount !== undefined) topLevel.repeatCount = n.repeatCount;
    if (n.repeatExpression !== undefined) topLevel.repeatExpression = n.repeatExpression;
    if (n.typeName !== undefined) topLevel.typeName = n.typeName;
    if (n.typeSource !== undefined) topLevel.typeSource = n.typeSource;
    if (n.modportName !== undefined) topLevel.modportName = n.modportName;
    if (n.modportSource !== undefined) topLevel.modportSource = n.modportSource;
    if (n.packed !== undefined) topLevel.packed = n.packed;
    if (n.width !== undefined) topLevel.width = n.width;
    if (n.fields !== undefined) topLevel.fields = n.fields;
    if (n.aggregateKind !== undefined) topLevel.aggregateKind = n.aggregateKind;
    return Object.keys(topLevel).length > 0 || n.metadata ? { ...n.metadata, ...topLevel } : undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidRawSource(source: RawSourceRange | undefined): source is RawSourceRange {
    if (!source?.file || source.line <= 0) return false;
    try {
        return fsSync.existsSync(source.file) && fsSync.statSync(source.file).isFile();
    } catch {
        return false;
    }
}

function sourceRangeFromRaw(source: RawSourceRange | undefined, workspaceRoot: string) {
    return source ? {
        file: path.relative(workspaceRoot, source.file),
        startLine: source.line,
        startColumn: source.col,
        endLine: source.endLine,
        endColumn: source.endCol
    } : undefined;
}

function findTypedefSource(
    cache: Map<string, string>,
    sourceFile: string | undefined,
    typeName: string | undefined
): RawSourceRange | undefined {
    if (!sourceFile || !typeName) return undefined;

    let text = cache.get(sourceFile);
    if (text === undefined) {
        try {
            text = fsSync.readFileSync(sourceFile, 'utf8');
        } catch {
            return undefined;
        }
        cache.set(sourceFile, text);
    }

    const pattern = new RegExp(`typedef\\s+(?:enum|struct)\\b[\\s\\S]*?\\b${escapeRegExp(typeName)}\\s*;`, 'm');
    const match = pattern.exec(text);
    if (!match) return undefined;

    const before = text.slice(0, match.index);
    const matched = match[0];
    const beforeLines = before.split('\n');
    const matchedLines = matched.split('\n');
    const line = beforeLines.length;
    const col = beforeLines[beforeLines.length - 1].length;
    const endLine = line + matchedLines.length - 1;
    const endCol = matchedLines.length === 1 ? col + matchedLines[0].length : matchedLines[matchedLines.length - 1].length;

    return { file: sourceFile, line, col, endLine, endCol };
}

function resolveTypeSource(
    cache: Map<string, string>,
    typeSource: RawSourceRange | undefined,
    fallbackFile: string | undefined,
    typeName: string | undefined
): RawSourceRange | undefined {
    if (isValidRawSource(typeSource)) return typeSource;
    return findTypedefSource(cache, fallbackFile, typeName);
}

function getSourceText(cache: Map<string, string>, sourceFile: string | undefined): string | undefined {
    if (!sourceFile) return undefined;
    let text = cache.get(sourceFile);
    if (text === undefined) {
        try {
            text = fsSync.readFileSync(sourceFile, 'utf8');
        } catch {
            return undefined;
        }
        cache.set(sourceFile, text);
    }
    return text;
}

function offsetToRawSource(text: string, file: string, startOffset: number, endOffset: number): RawSourceRange {
    const before = text.slice(0, startOffset);
    const selected = text.slice(startOffset, endOffset);
    const beforeLines = before.split('\n');
    const selectedLines = selected.split('\n');
    const line = beforeLines.length;
    const col = beforeLines[beforeLines.length - 1].length;
    const endLine = line + selectedLines.length - 1;
    const endCol = selectedLines.length === 1 ? col + selectedLines[0].length : selectedLines[selectedLines.length - 1].length;
    return { file, line, col, endLine, endCol };
}

function rawSourceFromRange(source: RawSourceRange | undefined): RawSourceRange | undefined {
    return source;
}

function findIdentifierDeclaration(
    cache: Map<string, string>,
    sourceFile: string | undefined,
    name: string,
    kind: 'parameter' | 'enum'
): { source: RawSourceRange; typeName?: string; typeSource?: RawSourceRange; width?: string } | undefined {
    const text = getSourceText(cache, sourceFile);
    if (!sourceFile || !text) return undefined;

    if (kind === 'enum') {
        const enumPattern = /typedef\s+enum\b(?:\s+\w+)*\s*(\[[^\]]+\])?[\s\S]*?\{([\s\S]*?)\}\s*(\w+)\s*;/g;
        for (const match of text.matchAll(enumPattern)) {
            const width = match[1];
            const members = match[2];
            const typeName = match[3];
            const membersStart = (match.index ?? 0) + match[0].indexOf(members);
            const memberPattern = new RegExp(`(?:^|,)\\s*(${escapeRegExp(name)})(?:\\s*=\\s*[^,}]+)?`, 'g');
            const memberMatch = memberPattern.exec(members);
            if (!memberMatch?.[1]) continue;

            const nameOffsetInMember = memberMatch[0].indexOf(memberMatch[1]);
            const startOffset = membersStart + memberMatch.index + nameOffsetInMember;
            const declaratorEnd = membersStart + memberMatch.index + memberMatch[0].replace(/^,/, '').length;
            return {
                source: offsetToRawSource(text, sourceFile, startOffset, declaratorEnd),
                typeName,
                typeSource: offsetToRawSource(text, sourceFile, match.index ?? 0, (match.index ?? 0) + match[0].length),
                width
            };
        }
        return undefined;
    }

    const parameterPattern = new RegExp(`(?:^|[;\\n])\\s*(?:localparam|parameter)\\b[^;]*\\b${escapeRegExp(name)}\\b[^;]*;`, 'g');
    const match = parameterPattern.exec(text);
    if (!match) return undefined;
    const leading = match[0].match(/^\s*;/)?.[0].length ?? 0;
    const newline = match[0].indexOf('\n');
    const startOffset = (match.index ?? 0) + (newline >= 0 ? newline + 1 : leading);
    const width = match[0].match(/\[[^\]]+\]/)?.[0];
    return { source: offsetToRawSource(text, sourceFile, startOffset, (match.index ?? 0) + match[0].length), width };
}

function findLiteralOccurrence(
    cache: Map<string, string>,
    sourceFile: string | undefined,
    label: string,
    source: RawSourceRange | undefined
): RawSourceRange | undefined {
    const text = getSourceText(cache, sourceFile);
    if (!sourceFile || !text || !label) return undefined;

    const lines = text.split('\n');
    const startLine = Math.max(1, source?.line ?? 1);
    const endLine = Math.max(startLine, source?.endLine && source.endLine > 0 ? source.endLine : startLine);
    let baseOffset = 0;
    for (let line = 1; line < startLine; line += 1) {
        baseOffset += (lines[line - 1]?.length ?? 0) + 1;
    }

    const snippet = lines.slice(startLine - 1, endLine).join('\n');
    const foundInSnippet = snippet.indexOf(label);
    if (foundInSnippet >= 0) {
        const startOffset = baseOffset + foundInSnippet;
        return offsetToRawSource(text, sourceFile, startOffset, startOffset + label.length);
    }

    const found = text.indexOf(label);
    if (found >= 0) {
        return offsetToRawSource(text, sourceFile, found, found + label.length);
    }
    return undefined;
}

function findDeclaredWidth(cache: Map<string, string>, sourceFile: string | undefined, name: string | undefined): string | undefined {
    const text = getSourceText(cache, sourceFile);
    if (!text || !name) return undefined;

    const pattern = new RegExp(`(?:input|output|inout|logic|wire|reg|localparam|parameter)\\b[^;\\n)]*?(\\[[^\\]]+\\])[^;\\n)]*?\\b${escapeRegExp(name)}\\b`, 'g');
    const match = pattern.exec(text);
    return match?.[1];
}

function bitSizeFromWidth(width: string | undefined): number {
    if (!width) return 1;
    const match = width.replace(/\s+/g, '').match(/^\[(-?\d+)(?::(-?\d+))?\]$/);
    if (!match) return 1;
    const left = Number.parseInt(match[1], 10);
    const right = match[2] === undefined ? left : Number.parseInt(match[2], 10);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 1;
    return Math.abs(left - right) + 1;
}

function widthFromBitSize(size: number): string {
    return size > 1 ? `[${size - 1}:0]` : '[0:0]';
}

function widthFromSlice(slice: string | undefined): string | undefined {
    if (!slice) return undefined;
    const match = slice.replace(/\s+/g, '').match(/^\[(-?\d+)(?::(-?\d+))?\]$/);
    if (!match) return undefined;
    const left = Number.parseInt(match[1], 10);
    const right = match[2] === undefined ? left : Number.parseInt(match[2], 10);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
    return widthFromBitSize(Math.abs(left - right) + 1);
}

function widthFromSignalSlice(signal: string | undefined): string | undefined {
    if (!signal) return undefined;
    const match = signal.replace(/\s+/g, '').match(/(\[-?\d+(?::-?\d+)?\])(?:_\w+)?$/);
    return widthFromSlice(match?.[1]);
}

function concatSliceLabel(highBit: number, size: number): string {
    return size > 1 ? `[${highBit}:${highBit - size + 1}]` : `[${highBit}]`;
}

function isPromotedConcatBus(node: DiagramNode): boolean {
    return node.kind === 'bus' && node.metadata?.expression === '[operation]';
}

function findNodeOutputWidth(nodes: DiagramNode[], signal: string | undefined): string | undefined {
    if (!signal) return undefined;
    let bestWidth: string | undefined;
    for (const node of nodes) {
        const output = node.ports.find(port => (
            port.direction === 'output'
            && (port.connectedSignal === signal || port.name === signal)
            && port.width
        ));
        if (output?.width && bitSizeFromWidth(output.width) > bitSizeFromWidth(bestWidth)) {
            bestWidth = output.width;
        }
    }
    return bestWidth;
}

function repairBusCompositionSlices(
    nodes: DiagramNode[],
    rawMod: RawModule,
    cache: Map<string, string>
): void {
    for (const node of nodes) {
        if (!isPromotedConcatBus(node)) continue;
        const inputPorts = node.ports.filter(port => port.direction === 'input');
        if (inputPorts.length === 0) continue;

        const inputWidths = inputPorts.map(port => (
            rawMod.ports.find(modulePort => modulePort.name === port.connectedSignal)?.width
            ?? findDeclaredWidth(cache, rawMod.file, port.connectedSignal)
            ?? findNodeOutputWidth(nodes, port.connectedSignal)
            ?? port.width
            ?? '[0:0]'
        ));
        const totalSize = inputWidths.reduce((sum, width) => sum + bitSizeFromWidth(width), 0);
        if (totalSize <= 0) continue;

        const outputPort = node.ports.find(port => port.direction === 'output');
        if (outputPort && bitSizeFromWidth(outputPort.width) < totalSize) {
            outputPort.width = widthFromBitSize(totalSize);
        }

        let currentBit = totalSize - 1;
        inputPorts.forEach((port, index) => {
            const width = inputWidths[index];
            const size = bitSizeFromWidth(width);
            const label = concatSliceLabel(currentBit, size);
            if (port.name !== label) {
                (port as DiagramPort & { rawName?: string }).rawName = port.name;
                port.name = label;
            }
            port.label = label;
            port.width = width;
            currentBit -= size;
        });
    }
}

function resolveLiteralDetails(
    cache: Map<string, string>,
    workspaceRoot: string,
    sourceFile: string | undefined,
    label: string,
    source: RawSourceRange | undefined
): { source?: SourceRange; metadata?: DiagramNodeMetadata; width?: string } {
    if (!label) return {};

    const enumDecl = findIdentifierDeclaration(cache, sourceFile, label, 'enum');
    if (enumDecl) {
        return {
            source: sourceRangeFromRaw(enumDecl.source, workspaceRoot) as SourceRange,
            metadata: {
                typeName: enumDecl.typeName,
                typeSource: sourceRangeFromRaw(enumDecl.typeSource, workspaceRoot)
            },
            width: enumDecl.width
        };
    }

    if (/^[A-Za-z_$][\w$]*$/.test(label)) {
        const parameterDecl = findIdentifierDeclaration(cache, sourceFile, label, 'parameter');
        if (parameterDecl) {
            return {
                source: sourceRangeFromRaw(parameterDecl.source, workspaceRoot) as SourceRange,
                width: parameterDecl.width
            };
        }
    }

    const literalOccurrence = findLiteralOccurrence(cache, sourceFile, label, source);
    return { source: sourceRangeFromRaw(literalOccurrence ?? rawSourceFromRange(source), workspaceRoot) as SourceRange };
}

function transformToDesignGraph(raw: RawUhdmIr, workspaceRoot: string): DesignGraph {
    const graph: DesignGraph = emptyGraph();
    const sourceTextCache = new Map<string, string>();

    for (const rawMod of raw.modules) {
        // Remove 'work@' prefix if present
        const modName = rawMod.name.replace(/^work@/, '');
        
        const nodes: DiagramNode[] = rawMod.nodes.map(n => {
            const rawMetadata = rawNodeMetadata(n);
            const metadata: DiagramNodeMetadata | undefined = rawMetadata ? { ...rawMetadata } : undefined;
            if (metadata?.typeName) {
                const resolvedTypeSource = resolveTypeSource(
                    sourceTextCache,
                    rawMetadata?.typeSource,
                    n.source?.file || rawMod.file,
                    metadata.typeName
                );
                if (resolvedTypeSource) {
                    metadata.typeSource = sourceRangeFromRaw(resolvedTypeSource, workspaceRoot);
                }
            }
            if (metadata?.modportSource && rawMetadata?.modportSource) {
                metadata.modportSource = sourceRangeFromRaw(rawMetadata.modportSource, workspaceRoot);
            }
            if (metadata?.repeatExpression && /^[A-Za-z_$][\w$]*$/.test(metadata.repeatExpression)) {
                const repeatSourceFile = rawMod.file || (n.source?.file && fsSync.existsSync(n.source.file) ? n.source.file : undefined);
                const repeatDecl = findIdentifierDeclaration(sourceTextCache, repeatSourceFile, metadata.repeatExpression, 'parameter');
                if (repeatDecl) {
                    metadata.repeatExpressionSource = sourceRangeFromRaw(repeatDecl.source, workspaceRoot);
                }
            }
            const literalDetails = n.kind === 'literal'
                ? resolveLiteralDetails(sourceTextCache, workspaceRoot, n.source?.file || rawMod.file, n.label, n.source)
                : undefined;
            const nodeMetadata = literalDetails?.metadata
                ? { ...(metadata ?? {}), ...literalDetails.metadata }
                : metadata;

            const node: DiagramNode = {
                id: n.id === 'self' ? stableId('port', modName, n.label) : n.id,
                kind: n.kind as any,
                label: (n.label || '').replace(/^work@/, ''),
                moduleName: n.instanceOf?.replace(/^work@/, ''),
                instanceOf: n.instanceOf?.replace(/^work@/, ''),
                parentModule: modName,
                ...(nodeMetadata ?? {}),
                metadata: nodeMetadata,

                ports: (() => {
                    const seenIds = new Set<string>();
                    return n.ports.map((p, i) => {
                        let portId = p.name;
                        if (n.kind === 'instance') {
                            portId = stableId('port', p.name);
                        } else if ((n.kind === 'comb' || n.kind === 'alu') && p.direction === 'output') {
                            portId = stableId('out', p.name);
                        } else if (n.kind === 'alu') {
                            portId = p.name;
                        } else if (n.kind === 'register' || n.kind === 'latch') {
                            const lowName = p.name.toLowerCase();
                            if (lowName === 'rv') {
                                portId = 'rv';
                            } else {
                                portId = lowName; // 'd', 'q', 'clk', 'reset'
                            }
                        } else if (n.kind === 'bus' || n.kind === 'struct' || n.kind === 'interface') {
                            if (p.direction === 'input') portId = stableId('in', p.name);
                            else portId = stableId('out', p.name);
                        } else if (n.kind === 'mux') {
                            if (p.direction === 'output') {
                                portId = stableId('out');
                            } else if (p.name === 'sel') {
                                portId = 'sel';
                            } else {
                                portId = stableId('in', p.name);
                                if (seenIds.has(portId)) {
                                    portId = stableId('in', p.name, p.label || i.toString());
                                }
                            }
                        } else if (n.kind === 'port') {
                            portId = 'handle';
                        } else {
                            portId = stableId('port', p.name);
                        }
                        seenIds.add(portId);

                        const isInterfaceInstance = n.kind === 'interface' && n.metadata?.role !== 'modport';
                        const common = {
                            name: p.name,
                            direction: p.direction as any,
                            width: n.kind === 'literal'
                                ? (literalDetails?.width
                                    ?? findDeclaredWidth(sourceTextCache, n.source?.file || rawMod.file, p.signal || p.name)
                                    ?? rawMod.ports.find((port) => port.name === p.signal || port.name === p.name)?.width
                                    ?? p.width
                                    ?? undefined)
                                : n.kind === 'replicate'
                                    ? (rawMod.ports.find((port) => port.name === p.signal || port.name === p.name)?.width
                                        ?? findDeclaredWidth(sourceTextCache, n.source?.file || rawMod.file, p.signal || p.name)
                                        ?? p.width
                                        ?? undefined)
                                : (p.width || undefined),
                            typeName: p.typeName,
                            typeSource: sourceRangeFromRaw(
                                resolveTypeSource(sourceTextCache, p.typeSource, p.source?.file || n.source?.file || rawMod.file, p.typeName),
                                workspaceRoot
                            ),
                            modportName: p.modportName,
                            modportSource: sourceRangeFromRaw(p.modportSource, workspaceRoot),
                            preferredSide: (p as any).preferredSide,
                            label: p.label || undefined,
                            connectedSignal: p.signal,
                            source: p.source ? {
                                file: path.relative(workspaceRoot, p.source.file),
                                startLine: p.source.line,
                                startColumn: p.source.col,
                                endLine: p.source.endLine,
                                endColumn: p.source.endCol
                            } : undefined
                        };

                        if (isInterfaceInstance && p.width === 'interface') {
                            const id = p.direction === 'input' ? stableId('in', p.name) : stableId('out', p.name);
                            return [{
                                ...common,
                                id: id,
                                preferredSide: (p as any).preferredSide
                            }];
                        }

                        return [{
                            id: portId,
                            ...common
                        }];
                    }).flat();
                })(),

                source: literalDetails?.source ?? {
                    file: path.relative(workspaceRoot, n.source.file),
                    startLine: n.source.line,
                    startColumn: n.source.col,
                    endLine: n.source.endLine,
                    endColumn: n.source.endCol
                }
            };
            return node;
        });

        const moduleFile = rawMod.file ? path.relative(workspaceRoot, rawMod.file) : '';

        const ports: DiagramPort[] = rawMod.ports.map((p, i) => ({
            id: stableId('port', p.name),
            name: p.name,
            direction: p.direction as any,
            position: i,
            width: p.width || undefined,
            typeName: p.typeName,
            typeSource: sourceRangeFromRaw(
                resolveTypeSource(sourceTextCache, p.typeSource, p.source?.file || rawMod.file, p.typeName),
                workspaceRoot
            ),
            modportName: p.modportName,
            modportSource: sourceRangeFromRaw(p.modportSource, workspaceRoot),
            source: p.source ? {
                file: path.relative(workspaceRoot, p.source.file),
                startLine: p.source.line,
                startColumn: p.source.col,
                endLine: p.source.endLine,
                endColumn: p.source.endCol
            } : undefined
        }));

        // Add port nodes for the module ports themselves (matching textExtractor behavior)
        for (const p of ports) {
            if (p.typeName && p.modportName) {
                continue;
            }
            nodes.push({
                id: stableId('port', modName, p.name),
                kind: 'port',
                label: p.name,
                parentModule: modName,
                ports: [p],
                source: p.source || { file: moduleFile, startLine: 1 }
            });
        }

        repairBusCompositionSlices(nodes, rawMod, sourceTextCache);

        const module: DesignModule = {
            name: modName,
            file: moduleFile,
            ports: ports,
            nodes: nodes,
            edges: rawMod.edges.map((e, i) => {
                const sourceNodeId = e.source === 'self' ? stableId('port', modName, e.sourcePort) : e.source;
                const targetNodeId = e.target === 'self' ? stableId('port', modName, e.targetPort) : e.target;
                
                const sourceNode = nodes.find(n => n.id === sourceNodeId);
                const targetNode = nodes.find(n => n.id === targetNodeId);

                let sourcePortId = e.sourcePort;
                if (e.source === 'self') {
                    sourcePortId = stableId('port', e.sourcePort);
                } else {
                    if (sourceNode) {
                        const srcPort = sourceNode.ports.find(p => p.name === e.sourcePort || (p as DiagramPort & { rawName?: string }).rawName === e.sourcePort);
                        if (srcPort) sourcePortId = srcPort.id;
                    }
                }

                let targetPortId = e.targetPort;
                if (e.target === 'self') {
                    targetPortId = stableId('port', e.targetPort);
                } else {
                    if (targetNode) {
                        const tgtPort = targetNode.ports.find(p => p.name === e.targetPort || (p as DiagramPort & { rawName?: string }).rawName === e.targetPort);
                        if (tgtPort) targetPortId = tgtPort.id;
                    }
                }
                
                const isInterfaceInstanceSource = sourceNode?.kind === 'interface' && sourceNode.metadata?.role !== 'modport';
                const isInterfaceInstanceTarget = targetNode?.kind === 'interface' && targetNode.metadata?.role !== 'modport';

                const duplicateEndpointSignal = rawMod.edges.some((other, otherIndex) => (
                    otherIndex !== i
                    && other.source === e.source
                    && other.target === e.target
                    && (other.signal || '') === (e.signal || '')
                ));
                const edgeLabel = duplicateEndpointSignal
                    ? stableId(e.signal || i.toString(), sourcePortId, targetPortId)
                    : e.signal || i.toString();

                const isStructComposition = sourceNode?.kind === 'struct' && sourceNode?.metadata?.role === 'composition';

                const edge: DiagramEdge = {
                    id: edgeId(sourceNodeId, targetNodeId, edgeLabel),
                    source: sourceNodeId,
                    target: targetNodeId,
                    sourcePort: sourcePortId,
                    targetPort: targetPortId,
                    signal: e.signal,
                    width: e.width,
                    sourceRange: e.sourceRange ? {
                        file: path.relative(workspaceRoot, e.sourceRange.file),
                        startLine: e.sourceRange.line,
                        startColumn: e.sourceRange.col,
                        endLine: e.sourceRange.endLine,
                        endColumn: e.sourceRange.endCol
                    } : undefined,
                    metadata: {
                        ...e.metadata,
                        aggregate: isStructComposition ? 'struct' : e.metadata?.aggregate
                    }
                };
                return edge;
            })
        };

        for (const node of module.nodes) {
            if (node.kind !== 'replicate') continue;
            for (const port of node.ports) {
                const declaredWidth = module.ports.find((modulePort) => modulePort.name === port.connectedSignal)?.width
                    ?? findDeclaredWidth(sourceTextCache, rawMod.file, port.connectedSignal);
                if (declaredWidth && (!port.width || port.width === '[0:0]')) {
                    port.width = declaredWidth;
                }
            }
        }

        for (const node of module.nodes) {
            if (node.kind === 'latch' && node.metadata?.inferred) {
                graph.diagnostics.push({
                    severity: 'warning',
                    message: `${modName}.${node.label} inferred latch from incomplete combinational assignment`,
                    source: node.source
                });
            }
        }

        // Synthesize Bus Composition Nodes
        // Group output ports of nodes by their base signal
        const sliceDrivers = new Map<string, Array<{ nodeId: string, portId: string, slice: string, width: string }>>();
        for (const n of module.nodes) {
            // Do not consider output ports of bus breakout nodes (which are inputs sliced into pieces)
            if (n.kind === 'bus') continue;
            // Do not consider simple alias combinational nodes that are used for bus breakouts (they have a single input)
            if (n.kind === 'comb' && n.metadata?.expression === '[alias]' && !n.metadata?.isProcedural) continue;

            for (const p of n.ports) {
                if (p.direction === 'output' && p.connectedSignal && p.connectedSignal.includes('[')) {
                    const bracketIdx = p.connectedSignal.indexOf('[');
                    const base = p.connectedSignal.substring(0, bracketIdx);
                    const slice = p.connectedSignal.substring(bracketIdx);
                    if (!sliceDrivers.has(base)) sliceDrivers.set(base, []);
                    sliceDrivers.get(base)!.push({ nodeId: n.id, portId: p.id, slice, width: p.width || '' });
                }
            }
        }
        for (const [base, drivers] of sliceDrivers.entries()) {
            // Check if the full bus is already driven (e.g. it's an input port or fully assigned wire)
            const hasFullDriver = module.ports.some(p => p.name === base && p.direction === 'input') ||
                                  module.nodes.some(n => n.ports.some(p => p.direction === 'output' && p.connectedSignal === base));
            
            if (!hasFullDriver && (drivers.length > 1 || module.ports.some(p => p.name === base))) {
                // Determine if there is actually a consumer for the full bus.
                // A consumer could be an input port of another node, or a module output port.
                const hasFullBusConsumer = module.nodes.some(n => n.ports.some(p => p.direction === 'input' && p.connectedSignal === base))
                    || module.ports.some(p => p.name === base && p.direction === 'output');
                
                if (hasFullBusConsumer) {
                    const compNodeId = `bus_comp:${modName}:${base}`;
                    if (!module.nodes.some(n => n.id === compNodeId)) {

                        const compNode: DiagramNode = {
                            id: compNodeId,
                            kind: 'bus',
                            label: base,
                            metadata: { expression: base },
                            ports: [
                                {
                                    id: base,
                                    direction: 'output',
                                    name: base,
                                    connectedSignal: base,
                                    width: module.ports.find(p => p.name === base)?.width ?? findDeclaredWidth(sourceTextCache, rawMod.file, base) ?? '[0:0]'
                                }
                            ],
                            source: { file: '', startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }
                        };
                        
                        for (const driver of drivers) {
                            const driverWidth = widthFromSlice(driver.slice) ?? driver.width;
                            if (!compNode.ports.some(p => p.name === driver.slice)) {
                                compNode.ports.push({
                                    id: driver.slice,
                                    direction: 'input',
                                    name: driver.slice,
                                    connectedSignal: base + driver.slice,
                                    width: driverWidth,
                                    label: driver.slice
                                });
                            }
                            module.edges.push({
                                id: edgeId(driver.nodeId, compNodeId, base + driver.slice),
                                source: driver.nodeId,
                                sourcePort: driver.portId,
                                target: compNodeId,
                                targetPort: driver.slice,
                                signal: base + driver.slice,
                                width: driverWidth
                            });
                        }
                        
                        module.nodes.push(compNode);
                        
                        // Also, any consumer of the base bus needs an edge from this composition node.
                        for (const n of module.nodes) {
                            if (n.id === compNodeId) continue;
                            for (const p of n.ports) {
                                if (p.direction === 'input' && p.connectedSignal === base) {
                                    module.edges.push({
                                        id: edgeId(compNodeId, n.id, base),
                                        source: compNodeId,
                                        sourcePort: base,
                                        target: n.id,
                                        targetPort: p.id,
                                        signal: base,
                                        width: compNode.ports[0].width
                                    });
                                }
                            }
                        }
                        for (const p of module.ports) {
                            if (p.direction === 'output' && p.name === base) {
                                const targetNodeId = stableId('port', modName, p.name);
                                module.edges.push({
                                    id: edgeId(compNodeId, targetNodeId, base),
                                    source: compNodeId,
                                    sourcePort: base,
                                    target: targetNodeId,
                                    targetPort: p.id,
                                    signal: base,
                                    width: p.width
                                });
                            }
                        }
                    }
                }
            }
        }

        for (const node of module.nodes) {
            if (node.kind !== 'bus' || !node.id.startsWith(`bus_comp:${modName}:`)) continue;
            const output = node.ports.find(port => port.direction === 'output');
            if (output?.connectedSignal) {
                const declaredWidth = module.ports.find(port => port.name === output.connectedSignal)?.width
                    ?? findDeclaredWidth(sourceTextCache, rawMod.file, output.connectedSignal);
                if (declaredWidth) output.width = declaredWidth;
            }
            for (const port of node.ports) {
                if (port.direction !== 'input') continue;
                const sliceWidth = widthFromSlice(port.name);
                if (sliceWidth) port.width = sliceWidth;
            }
            for (const edge of module.edges) {
                if (edge.target === node.id && edge.targetPort) {
                    const targetPort = node.ports.find(port => port.id === edge.targetPort || port.name === edge.targetPort);
                    if (targetPort?.width) edge.width = targetPort.width;
                }
                if (edge.source === node.id && edge.sourcePort) {
                    const sourcePort = node.ports.find(port => port.id === edge.sourcePort || port.name === edge.sourcePort);
                    if (sourcePort?.width) edge.width = sourcePort.width;
                }
            }
        }

        // Collapse alias comb nodes (but NOT if they are procedural)
        const aliasNodes = module.nodes.filter(n => n.kind === 'comb' && n.metadata?.expression === '[alias]' && !n.metadata?.isProcedural);
        for (const alias of aliasNodes) {
            const inPort = alias.ports.find(p => p.direction === 'input');
            const outPort = alias.ports.find(p => p.direction === 'output');
            if (inPort && outPort) {
                const incomingEdges = module.edges.filter(e => e.target === alias.id && e.targetPort === inPort.id);
                const outgoingEdges = module.edges.filter(e => e.source === alias.id && e.sourcePort === outPort.id);
                
                if (incomingEdges.length > 0) {
                    // Bypass alias node
                    for (const inc of incomingEdges) {
                        for (const outg of outgoingEdges) {
                            module.edges.push({
                                id: edgeId(inc.source, outg.target, outg.signal || inc.signal),
                                source: inc.source,
                                target: outg.target,
                                sourcePort: inc.sourcePort,
                                targetPort: outg.targetPort,
                                signal: outg.signal || inc.signal,
                                width: outg.width || inc.width
                            });
                        }
                    }
                    
                    // Remove old edges and node
                    module.edges = module.edges.filter(e => !incomingEdges.includes(e) && !outgoingEdges.includes(e));
                    module.nodes = module.nodes.filter(n => n.id !== alias.id);
                }
            }
        }
        
        graph.modules[modName] = module;
    }

    if (raw.rootModules) {
        graph.rootModules = raw.rootModules.map(m => m.replace(/^work@/, ''));
    } else {
        const instantiated = new Set<string>();
        for (const m of Object.values(graph.modules)) {
            for (const n of m.nodes) {
                if (n.kind === 'instance' && n.instanceOf) instantiated.add(n.instanceOf);
            }
        }
        graph.rootModules = Object.keys(graph.modules).filter(m => !instantiated.has(m));
    }

    return orderGraphModules(graph);
}
