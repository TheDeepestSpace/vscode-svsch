import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesignGraph, DesignModule, DiagramNode, DiagramPort, DiagramEdge } from '../ir/types';
import { stableId } from '../ir/ids';
import { extractDesignFromText } from './textExtractor';
import { orderGraphModules } from './moduleOrdering';

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

    await execFileAsync(surelogPath, surelogArgs);

    const uhdmFile = path.join(tmpDir, 'slpp_all', 'surelog.uhdm');
    if (!(await fileExists(uhdmFile))) {
      return {
        success: false,
        graph: emptyGraph(),
        error: 'Surelog failed to generate .uhdm file'
      };
    }

    // 2. Run C++ backend to extract IR
    const { stdout, stderr } = await execFileAsync(backendPath, [uhdmFile]);
    if (stderr && !stdout) {
        return {
            success: false,
            graph: emptyGraph(),
            error: `Backend error: ${stderr}`
        };
    }

    const rawIr = JSON.parse(stdout);
    const graph = transformToDesignGraph(rawIr, workspaceRoot);
    const sourceGraph = await extractSourceAwareGraph(files, workspaceRoot);

    // Multi-driver check
    for (const module of Object.values(graph.modules)) {
        const drivers = new Map<string, string[]>();
        for (const edge of module.edges) {
            if (edge.signal) {
                // Determine if this edge is a driver for the signal
                // (source is a node, target is 'self' port OR target is a node input)
                // Simplification: if source is NOT 'self', it's a driver
                if (!edge.source.startsWith('port:')) {
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
                    message: `${module.name}.${signal} has multiple drivers: ${sources.join(', ')}`
                });
            }
        }
    }

    return {
      success: true,
      graph: sourceGraph ?? graph
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
                label: n.label.replace(/^work@/, ''),
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
                    } else if (n.kind === 'mux') {
                         if (p.direction === 'output') portId = stableId('out');
                         else portId = p.name; // 'sel', 'default', etc.
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

        const module: DesignModule = {
            name: modName,
            file: moduleFile,
            ports: rawMod.ports.map((p, i) => ({
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
            })),
            nodes: nodes,
            edges: rawMod.edges.map((e, i) => {
                const sourceId = e.source === 'self' ? stableId('port', modName, e.sourcePort) : e.source;
                const targetId = e.target === 'self' ? stableId('port', modName, e.targetPort) : e.target;
                
                // Lookup the created nodes to find the actual port ID
                let sourcePortId = e.sourcePort;
                if (e.source === 'self') {
                    sourcePortId = stableId('port', e.sourcePort);
                } else {
                    const srcNode = nodes.find(n => n.id === e.source);
                    const p = srcNode?.ports.find(p => p.name === e.sourcePort || p.connectedSignal === e.signal);
                    if (p) sourcePortId = p.id;
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
                    signal: e.signal
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
