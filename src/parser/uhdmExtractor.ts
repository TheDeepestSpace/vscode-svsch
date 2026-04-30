import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesignGraph, DesignModule, DiagramNode, DiagramPort, DiagramEdge } from '../ir/types';
import { stableId } from '../ir/ids';
import { extractDesignFromText } from './textExtractor';
import { orderGraphModules } from './moduleOrdering';

import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export interface UhdmExtractionResult {
  success: boolean;
  graph: DesignGraph;
  error?: string;
}

export async function extractDesignWithUhdm(
  files: string[],
  surelogPath: string,
  backendPath: string,
  workspaceRoot: string
): Promise<UhdmExtractionResult> {
  const tmpDir = path.join(workspaceRoot, '.svsch', 'uhdm_tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // 1. Run Surelog to generate UHDM
    // We use -parse -sverilog and -o to specify output dir
    // We might need to handle top modules if multiple files are provided
    const surelogArgs = [
      '-parse',
      '-sverilog',
      ...files,
      '-o', tmpDir
    ];

    logger.log(`Executing Surelog: ${surelogPath} ${surelogArgs.join(' ')}`);
    try {
        await execFileAsync(surelogPath, surelogArgs);
    } catch (e: any) {
        logger.error(`Surelog execution failed: ${e.message}`, e);
        return {
            success: false,
            graph: emptyGraph(),
            error: `Surelog failed: ${e.message}`
        };
    }

    const uhdmFile = path.join(tmpDir, 'slpp_all', 'surelog.uhdm');
    if (!(await fileExists(uhdmFile))) {
      logger.error(`Surelog failed to generate .uhdm file at ${uhdmFile}`);
      return {
        success: false,
        graph: emptyGraph(),
        error: 'Surelog failed to generate .uhdm file'
      };
    }

    // 2. Run C++ backend to extract IR
    logger.log(`Executing Backend: ${backendPath} ${uhdmFile}`);
    const { stdout, stderr } = await execFileAsync(backendPath, [uhdmFile]);
    if (stderr) logger.log(`Backend Stderr: ${stderr}`);
    
    const stdoutJson = stdout.trim();
    if (!stdoutJson) {
        logger.error('Backend returned empty output');
        return {
            success: false,
            graph: emptyGraph(),
            error: 'Backend returned empty output'
        };
    }
    const rawIr = JSON.parse(stdoutJson);
    const graph = transformToDesignGraph(rawIr, workspaceRoot);
        
        // Post-process: simplify trivial comb nodes (aliases like assign y = b_q)
    for (const module of Object.values(graph.modules)) {
        const trivialNodes = module.nodes.filter(n => n.kind === 'comb' && n.metadata?.expression === '[alias]');

        for (const node of trivialNodes) {
            module.nodes = module.nodes.filter(n => n.id !== node.id);
            const incomingEdges = module.edges.filter(e => e.target === node.id);
            const outgoingEdges = module.edges.filter(e => e.source === node.id);

            for (const outEdge of outgoingEdges) {
                for (const inEdge of incomingEdges) {
                    module.edges.push({
                        ...outEdge,
                        id: stableId('edge', inEdge.source, outEdge.target, inEdge.signal || outEdge.id),
                        source: inEdge.source,
                        target: outEdge.target,
                        sourcePort: inEdge.sourcePort,
                        targetPort: outEdge.targetPort,
                        signal: inEdge.signal || outEdge.signal,
                        label: inEdge.label || outEdge.label || inEdge.signal
                    });
                }
            }
            module.edges = module.edges.filter(e => e.source !== node.id && e.target !== node.id);
        }
    }

    const sourceGraph = await extractSourceAwareGraph(files, workspaceRoot);
    mergeBusNodesFromSourceGraph(graph, sourceGraph);

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
                // For now, if there are ANY good ones, we can probably drop the placeholders
                // that were added just to force a breakout.
                bus.ports = bus.ports.filter(p => !placeholders.includes(p));
                
                // Also need to update edges that used the placeholder ports
                for (const ph of placeholders) {
                    const edges = module.edges.filter(e => e.source === bus.id && e.sourcePort === ph.id);
                    for (const edge of edges) {
                        // Find a good port that might be the intended one?
                        // This is hard without more info.
                        // But wait, if textExtractor added the good ones, it should also have added the edges.
                        // So we can just drop the edges from the placeholder.
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
    }

    // Multi-driver check
    for (const module of Object.values(graph.modules)) {
        const drivers = new Map<string, string[]>();
        for (const edge of module.edges) {
            if (edge.signal) {
                // Determine if this edge is a driver for the signal
                // Sources that are module input ports are NOT considered 'drivers' in this context
                // because we are looking for internal logic conflicts.
                const isPortSource = edge.source.startsWith('port:') && edge.source.split(':').length === 3;
                if (!isPortSource) {
                    const existing = drivers.get(edge.signal) || [];
                    if (!existing.includes(edge.source)) {
                        existing.push(edge.source);
                        drivers.set(edge.signal, existing);
                    }
                }
            }
        }

        for (const [signal, sources] of drivers.entries()) {
            if (sources.length > 1) {
                graph.diagnostics.push({
                    severity: 'warning',
                    message: `Signal ${module.name}.${signal} has multiple diagram drivers: ${sources.join(', ')}.`
                });
            }
        }
    }

    return {
      success: true,
      graph: graph ?? sourceGraph
    };
  } catch (e: any) {
    return {
      success: false,
      graph: emptyGraph(),
      error: e.message
    };
  } finally {
    // Optional: clean up tmpDir
    // await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function extractSourceAwareGraph(files: string[], workspaceRoot: string): Promise<DesignGraph | undefined> {
  const sources = await Promise.all(files.map(async (file) => ({
    file: path.relative(workspaceRoot, file),
    text: await fs.readFile(file, 'utf8')
  })));
  const graph = extractDesignFromText(sources);
  return Object.keys(graph.modules).length > 0 ? graph : undefined;
}

function mergeBusNodesFromSourceGraph(graph: DesignGraph, sourceGraph?: DesignGraph): void {
  if (!sourceGraph) {
    return;
  }

  for (const [moduleName, sourceModule] of Object.entries(sourceGraph.modules)) {
    const targetModule = graph.modules[moduleName];
    if (!targetModule) {
      continue;
    }

    // Merge port widths from sourceModule into targetModule
    for (const sourcePort of sourceModule.ports) {
      const targetPort = targetModule.ports.find((p) => p.name === sourcePort.name);
      if (targetPort && (!targetPort.width || targetPort.width === '[0:0]')) {
        targetPort.width = sourcePort.width;
      }
    }

    // Update port kind nodes with the merged widths
    for (const node of targetModule.nodes) {
      if (node.kind === 'port') {
        const port = targetModule.ports.find((p) => p.name === node.label);
        if (port && port.width && node.ports[0]) {
          node.ports[0].width = port.width;
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
        for (const port of node.ports) {
          if (!existing.ports.some((p) => p.id === port.id || (p.label === port.label && p.direction === port.direction))) {
            existing.ports.push(port);
          }
        }
      }
    }

    for (const edge of sourceModule.edges) {
      if (!busNodeIds.has(edge.source) && !busNodeIds.has(edge.target)) {
        continue;
      }

      const duplicate = targetModule.edges.some((existing) =>
        existing.source === edge.source
        && existing.target === edge.target
        && existing.sourcePort === edge.sourcePort
        && existing.targetPort === edge.targetPort
        && existing.signal === edge.signal
      );

      if (!duplicate) {
        targetModule.edges.push(edge);
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
        ports: Array<{ name: string; direction: string; width: string; source: { file: string; line: number; col: number; endLine: number; endCol: number } }>;
        nodes: Array<{
            id: string;
            kind: string;
            label: string;
            instanceOf?: string;
            moduleName?: string;
            metadata?: { expression?: string };
            ports: Array<{ name: string; direction: string; signal: string; width: string; label?: string }>;
            source: { file: string; line: number; col: number; endLine: number; endCol: number };
        }>;
        edges: Array<{
            source: string;
            target: string;
            sourcePort: string;
            targetPort: string;
            signal: string;
        }>;
    }>;
    rootModules?: string[];
}

function transformToDesignGraph(raw: RawUhdmIr, workspaceRoot: string): DesignGraph {
    const graph: DesignGraph = emptyGraph();

    for (const rawMod of raw.modules) {
        // Remove 'work@' prefix if present
        const modName = rawMod.name.replace(/^work@/, '');
        
        let moduleFile = '';

        const nodes: DiagramNode[] = rawMod.nodes.map(n => {
            const node: DiagramNode = {
                id: n.id === 'self' ? stableId('port', modName, n.label) : n.id,
                kind: n.kind as any,
                label: (n.label || '').replace(/^work@/, ''),
                moduleName: n.instanceOf?.replace(/^work@/, ''),
                instanceOf: n.instanceOf?.replace(/^work@/, ''),
                parentModule: modName,
                metadata: n.metadata,

                ports: n.ports.map(p => {
                    let portId = p.name;
                    if (n.kind === 'instance') {
                        portId = stableId('port', p.name);
                    } else if (n.kind === 'comb' && p.direction === 'output') {
                        portId = stableId('out', p.name);
                    } else if (n.kind === 'register') {
                        portId = p.name.toLowerCase(); // 'd', 'q', 'clk', 'reset'
                    } else if (n.kind === 'bus') {
                        if (p.direction === 'input') portId = stableId('in', p.name);
                        else portId = stableId('out', p.name);
                    } else if (n.kind === 'mux') {
                         if (p.direction === 'output') portId = stableId('out');
                         else if (p.name === 'sel') portId = 'sel';
                         else portId = stableId('in', p.name);
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
            if (!moduleFile && n.source.file) moduleFile = path.relative(workspaceRoot, n.source.file);
            return node;
        });

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

        const module: DesignModule = {
            name: modName,
            file: moduleFile,
            ports: ports,
            nodes: nodes,
            edges: rawMod.edges.map((e, i) => {
                const sourceId = e.source === 'self' ? stableId('port', modName, e.sourcePort) : e.source;
                const targetId = e.target === 'self' ? stableId('port', modName, e.targetPort) : e.target;
                
                // Lookup the created nodes to find the actual port ID
                let sourcePortId = e.sourcePort;
                let width: string | undefined;
                if (e.source === 'self') {
                    sourcePortId = stableId('port', e.sourcePort);
                    width = ports.find(p => p.name === e.sourcePort)?.width;
                } else {
                    const srcNode = nodes.find(n => n.id === e.source);
                    const p = srcNode?.ports.find(p => p.name === e.sourcePort || p.connectedSignal === e.signal);
                    if (p) {
                        sourcePortId = p.id;
                        width = p.width;
                    }
                }

                let targetPortId = e.targetPort;
                if (e.target === 'self') {
                    targetPortId = stableId('port', e.targetPort);
                } else {
                    const tgtNode = nodes.find(n => n.id === e.target);
                    const p = tgtNode?.ports.find(p => p.name === e.targetPort || p.connectedSignal === e.signal);
                    if (p) targetPortId = p.id;
                }

                return {
                    id: stableId('edge', sourceId, targetId, e.signal || `e${i}`),
                    source: sourceId,
                    target: targetId,
                    sourcePort: sourcePortId,
                    targetPort: targetPortId,
                    label: e.signal,
                    signal: e.signal,
                    width: width
                };
            })
        };
        
        // Add port nodes for the module ports themselves (matching textExtractor behavior)
        for (const p of module.ports) {
            module.nodes.push({
                id: stableId('port', modName, p.name),
                kind: 'port',
                label: p.name,
                parentModule: modName,
                ports: [p],
                source: { file: module.file, startLine: 1 }
            });
        }
        
        graph.modules[modName] = module;
    }
    
    // 1. Identify root modules
    if (raw.rootModules) {
        graph.rootModules = raw.rootModules.map(m => m.replace(/^work@/, ''));
    } else {
        // Fallback detection
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
