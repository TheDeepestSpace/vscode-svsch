import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesignGraph, DesignModule, DiagramNode, DiagramPort, DiagramEdge } from '../ir/types';
import { edgeId, stableId } from '../ir/ids';
import { orderGraphModules } from './moduleOrdering';
import { extractDesignFromText } from './textExtractor';

const execFileAsync = promisify(execFile);

export async function extractDesignWithUhdm(
  files: string[],
  workspaceRoot: string,
  surelogPath: string,
  backendPath: string
): Promise<DesignGraph> {
  const tmpDir = path.join(workspaceRoot, '.svsch', 'uhdm_tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const surelogArgs = [
      '-parse',
      '-sverilog',
      ...files,
      '-o', tmpDir
    ];

    await execFileAsync(surelogPath, surelogArgs);

    const uhdmFile = path.join(tmpDir, 'slpp_all', 'surelog.uhdm');
    if (!(await fileExists(uhdmFile))) {
      throw new Error(`Surelog failed to generate UHDM file at ${uhdmFile}`);
    }

    const { stdout, stderr } = await execFileAsync(backendPath, [uhdmFile]);
    if (stderr) {
        console.error(`[SVSCH] Backend Stderr: ${stderr}`);
    }

    const raw: RawUhdmIr = JSON.parse(stdout);
    const graph = transformToDesignGraph(raw, workspaceRoot);

    const sourceGraph = await extractSourceAwareGraph(files, workspaceRoot);
    mergeBusNodesFromSourceGraph(graph, workspaceRoot, sourceGraph);

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
                    const betterEdge = edgesToTarget.find(e => e.signal && !e.signal.includes('?'));
                    if (betterEdge) {
                        module.edges = module.edges.filter(e => !(e.source === bus.id && e.target === target && e !== betterEdge));
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
        
        // Special matching for combinational blocks if no label match
        if (!targetNode && sourceNode.kind === 'comb') {
            const sourceOutput = sourceNode.ports.find(p => p.direction === 'output')?.name;
            if (sourceOutput) {
                targetNode = targetModule.nodes.find(n => 
                    n.kind === 'comb' && 
                    n.ports.some(p => p.name === sourceOutput && p.direction === 'output')
                );
            }
        }
        
        if (targetNode) {
            nodeIdMap.set(sourceNode.id, targetNode.id);
            // Merge source info: always trust text parser more for matched nodes
            if (sourceNode.source) {
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

    const busNodeIds = new Set(busNodes.map((node) => node.id));

    for (const node of busNodes) {
      const existing = targetModule.nodes.find((e) => e.id === node.id);
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

interface RawUhdmIr {
    modules: Array<{
        name: string;
        file: string;
        ports: Array<{ name: string; direction: string; width: string; source: { file: string; line: number; col: number; endLine: number; endCol: number } }>;
        nodes: Array<{
            id: string;
            kind: string;
            label: string;
            instanceOf?: string;
            moduleName?: string;
            metadata?: { expression?: string; resetKind?: string; resetActiveLow?: boolean; isProcedural?: boolean; inferred?: boolean; reason?: string };
            ports: Array<{ name: string; direction: string; signal: string; width: string; label?: string }>;
            source: { file: string; line: number; col: number; endLine: number; endCol: number };
        }>;
        edges: Array<{
            source: string;
            target: string;
            sourcePort: string;
            targetPort: string;
            signal: string;
            width?: string;
        }>;
    }>;
    rootModules?: string[];
}

function transformToDesignGraph(raw: RawUhdmIr, workspaceRoot: string): DesignGraph {
    const graph: DesignGraph = emptyGraph();

    for (const rawMod of raw.modules) {
        // Remove 'work@' prefix if present
        const modName = rawMod.name.replace(/^work@/, '');
        
        const nodes: DiagramNode[] = rawMod.nodes.map(n => {
            const node: DiagramNode = {
                id: n.id === 'self' ? stableId('port', modName, n.label) : n.id,
                kind: n.kind as any,
                label: (n.label || '').replace(/^work@/, ''),
                moduleName: n.instanceOf?.replace(/^work@/, ''),
                instanceOf: n.instanceOf?.replace(/^work@/, ''),
                parentModule: modName,
                metadata: n.metadata as any,

                ports: n.ports.map(p => {
                    let portId = p.name;
                    if (n.kind === 'instance') {
                        portId = stableId('port', p.name);
                    } else if (n.kind === 'comb' && p.direction === 'output') {
                        portId = stableId('out', p.name);
                    } else if (n.kind === 'register' || n.kind === 'latch') {
                        portId = p.name.toLowerCase(); // 'd', 'q', 'clk', 'reset'
                    } else if (n.kind === 'bus') {
                        if (p.direction === 'input') portId = stableId('in', p.name);
                        else portId = stableId('out', p.name);
                    } else if (n.kind === 'mux') {
                         if (p.direction === 'output') portId = stableId('out');
                         else if (p.name === 'sel') portId = 'sel';
                         else portId = stableId('in', p.name);
                    } else if (n.kind === 'port') {
                        portId = 'handle';
                    } else {
                        portId = stableId('port', p.name);
                    }

                    return {
                        id: portId,
                        name: p.name,
                        direction: p.direction as any,
                        width: p.width || undefined,
                        label: p.label || undefined,
                        connectedSignal: p.signal
                    };
                }),

                source: {
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
            nodes.push({
                id: stableId('port', modName, p.name),
                kind: 'port',
                label: p.name,
                parentModule: modName,
                ports: [p],
                source: p.source || { file: moduleFile, startLine: 1 }
            });
        }

        const module: DesignModule = {
            name: modName,
            file: moduleFile,
            ports: ports,
            nodes: nodes,
            edges: rawMod.edges.map((e, i) => {
                let targetPortId = e.targetPort;
                if (e.target === 'self') {
                    targetPortId = stableId('port', e.targetPort);
                } else {
                    const tgtNode = nodes.find(n => n.id === e.target);
                    if (tgtNode) {
                        const tgtPort = tgtNode.ports.find(p => p.name === e.targetPort);
                        if (tgtPort) targetPortId = tgtPort.id;
                    }
                }

                let sourcePortId = e.sourcePort;
                if (e.source === 'self') {
                    sourcePortId = stableId('port', e.sourcePort);
                } else {
                    const srcNode = nodes.find(n => n.id === e.source);
                    if (srcNode) {
                        const srcPort = srcNode.ports.find(p => p.name === e.sourcePort);
                        if (srcPort) sourcePortId = srcPort.id;
                    }
                }

                const sourceNodeId = e.source === 'self' ? stableId('port', modName, e.sourcePort) : e.source;
                const targetNodeId = e.target === 'self' ? stableId('port', modName, e.targetPort) : e.target;
                const duplicateEndpointSignal = rawMod.edges.some((other, otherIndex) => (
                    otherIndex !== i
                    && other.source === e.source
                    && other.target === e.target
                    && (other.signal || '') === (e.signal || '')
                ));
                const edgeLabel = duplicateEndpointSignal
                    ? stableId(e.signal || i.toString(), sourcePortId, targetPortId)
                    : e.signal || i.toString();

                const edge: DiagramEdge = {
                    id: edgeId(sourceNodeId, targetNodeId, edgeLabel),
                    source: sourceNodeId,
                    target: targetNodeId,
                    sourcePort: sourcePortId,
                    targetPort: targetPortId,
                    signal: e.signal,
                    width: e.width
                };
                return edge;
            })
        };

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
                                { id: base, direction: 'output', name: base, connectedSignal: base, width: '[0:0]' } // width will be patched later if needed
                            ],
                            source: { file: '', startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }
                        };
                        
                        for (const driver of drivers) {
                            if (!compNode.ports.some(p => p.name === driver.slice)) {
                                compNode.ports.push({
                                    id: driver.slice,
                                    direction: 'input',
                                    name: driver.slice,
                                    connectedSignal: base + driver.slice,
                                    width: driver.width,
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
                                width: driver.width
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
