import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { threadId } from 'node:worker_threads';
import type {
  DesignGraph,
  DesignModule,
  DesignCallable,
  DiagramNode,
  DiagramPort,
  DiagramEdge,
  DiagramNodeMetadata,
  DiagramEdgeMetadata,
  GenerateRegion,
  InstanceParameter,
  ParameterDecl,
  ParameterRef,
  SourceRange,
} from '../ir/types';
import { edgeId, stableId } from '../ir/ids';
import { annotateWireStyles, widthIsPotentiallyMultiBit } from '../ir/edgeStyle';
import { orderGraphModules } from './moduleOrdering';
import { extractDesignFromText } from './textExtractor';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

// Set only by CI coverage jobs, pointing at a scratch directory to collect
// per-invocation gcov output. Unset in production, so normal spawns are
// untouched.
const backendCoverageRoot = process.env.SVSCH_BACKEND_GCOV_ROOT;
let backendInvocationCounter = 0;

// Unit/BDD/visual CI jobs run many concurrent workers, each spawning its own
// backend subprocess against the same coverage-instrumented binary. Without
// isolation, concurrent processes would race writing the same .gcda files.
// Giving every single invocation its own GCOV_PREFIX subdirectory (keyed by
// pid + thread id + a per-module counter, so it's unique across worker
// processes, worker threads, and concurrent calls within one thread) makes
// each write target distinct — no invocation ever shares a target with
// another, so there's nothing to race on. The collect_backend_coverage CI
// job is responsible for merging these many per-invocation directories back
// into one coverage report.
function backendExecOptions(): { maxBuffer: number; env?: NodeJS.ProcessEnv } {
  const options = { maxBuffer: 100 * 1024 * 1024 };
  if (!backendCoverageRoot) {
    return options;
  }
  const invocationId = `${process.pid}-${threadId}-${backendInvocationCounter++}`;
  return {
    ...options,
    env: {
      ...process.env,
      GCOV_PREFIX: path.join(backendCoverageRoot, invocationId),
    },
  };
}

// ---------------------------------------------------------------------------
// UHDM cache helpers
// ---------------------------------------------------------------------------

interface CacheFingerprint {
  version: number;
  surelogPath: string;
  files: Array<{ path: string; mtime: number }>;
  includePaths: string[];
  defines: Record<string, string>;
}

async function computeFingerprint(
  surelogPath: string,
  files: string[],
  includePaths: string[],
  defines: Record<string, string>,
  fileListPath?: string,
): Promise<CacheFingerprint> {
  // Track the filelist's own mtime too (in addition to its listed sources' mtimes) so that
  // editing directives inside it (e.g. -I/+define+) that don't change the listed sources
  // still invalidates the cache, not just edits to the listed sources themselves.
  const fingerprintedFiles = fileListPath ? [...files, fileListPath] : files;
  const entries = await Promise.all(
    fingerprintedFiles.map(async (f) => ({
      path: f,
      mtime: (await fs.stat(f)).mtimeMs,
    })),
  );
  return {
    version: 1,
    surelogPath,
    files: entries,
    includePaths: [...includePaths].sort(),
    defines,
  };
}

function fingerprintsMatch(a: CacheFingerprint, b: CacheFingerprint): boolean {
  if (a.version !== b.version || a.surelogPath !== b.surelogPath) return false;
  if (a.files.length !== b.files.length) return false;
  if (JSON.stringify(a.includePaths) !== JSON.stringify(b.includePaths)) return false;
  if (JSON.stringify(a.defines) !== JSON.stringify(b.defines)) return false;
  return a.files.every((f, i) => f.path === b.files[i].path && f.mtime === b.files[i].mtime);
}

// Run Surelog as a spawned child process, streaming stderr to drive progress reports.
// Progress callback receives (message, increment) where increment is 0-80 (Surelog's share).
async function runSurelog(
  surelogPath: string,
  args: string[],
  sourceFiles: string[],
  onProgress?: (message: string, increment: number) => void,
  cwd?: string,
): Promise<void> {
  const basenames = sourceFiles.map((f) => path.basename(f));
  const seen = new Set<string>();
  let reportedPct = 0;

  return new Promise((resolve, reject) => {
    const proc = spawn(surelogPath, args, cwd ? { cwd } : undefined);
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    let buf = '';

    const handleLine = (line: string) => {
      if (!onProgress || sourceFiles.length === 0) return;
      for (const bn of basenames) {
        if (!seen.has(bn) && line.includes(bn)) {
          seen.add(bn);
          const targetPct = Math.round((seen.size / sourceFiles.length) * 80);
          const inc = targetPct - reportedPct;
          if (inc > 0) {
            onProgress(`Parsing sources (${seen.size}/${sourceFiles.length})`, inc);
            reportedPct = targetPct;
          }
          break;
        }
      }
    };

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        const stdout = Buffer.concat(stdoutChunks).toString();
        reject(
          new Error(
            `Surelog failed with exit code ${code}\nStdout:\n${stdout}\nStderr:\n${stderr}`,
          ),
        );
      } else {
        resolve();
      }
    });
    proc.on('error', reject);
  });
}

// Serializes work keyed by an arbitrary string (here, cacheDir) so that concurrent callers
// never run their `fn` at the same time. A later caller's `fn` starts only after the earlier
// one's has settled (resolved or rejected), and each caller still gets its own result/error.
const exclusiveQueues = new Map<string, Promise<void>>();

function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = exclusiveQueues.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  exclusiveQueues.set(key, tail);
  void tail.finally(() => {
    if (exclusiveQueues.get(key) === tail) {
      exclusiveQueues.delete(key);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------

export async function extractDesignWithUhdm(
  files: string[],
  workspaceRoot: string,
  surelogPath: string,
  backendPath: string,
  includePaths?: string[],
  defines?: Record<string, string>,
  moduleName?: string,
  onProgress?: (message: string, increment: number) => void,
  fileListPath?: string,
): Promise<DesignGraph> {
  const cacheDir = path.join(workspaceRoot, '.svsch', 'uhdm_cache');
  const fingerprintFile = path.join(cacheDir, 'fingerprint.json');
  await fs.mkdir(cacheDir, { recursive: true });

  const fingerprint = await computeFingerprint(
    surelogPath,
    files,
    includePaths ?? [],
    defines ?? {},
    fileListPath,
  );

  // Concurrent calls for the same cacheDir (e.g. a spurious watcher-triggered rebuild racing
  // the initial one) must never spawn two Surelog processes against it at once — Surelog isn't
  // safe for concurrent invocations against the same output dir and will corrupt/crash reading
  // each other's partial .uhdm output. Run the cache-check + Surelog spawn exclusively per
  // cacheDir; a waiting caller re-checks the cache once it's their turn, so if the run that
  // just finished already produced a matching fingerprint, they skip Surelog entirely instead
  // of spawning a redundant/racy one.
  // The backend also reads the shared .uhdm file, so it must stay inside the same
  // exclusive section: releasing the lock before the backend has read the file would let a
  // waiting caller with a different fingerprint start a new Surelog run against cacheDir
  // and overwrite/corrupt the file while this caller's backend is still reading it.
  const raw = await runExclusive(cacheDir, async () => {
    // --- Cache check ---
    let cacheHit = false;
    try {
      const saved = JSON.parse(await fs.readFile(fingerprintFile, 'utf-8')) as CacheFingerprint;
      const uhdmFile = await findSurelogUhdmFile(cacheDir);
      if (fingerprintsMatch(fingerprint, saved) && (await fileExists(uhdmFile))) {
        cacheHit = true;
      }
    } catch {
      /* no cache */
    }

    // --- Surelog (skipped on cache hit) ---
    let surelogReportedPct = 0;
    if (!cacheHit) {
      const surelogArgs = ['-parse', '-sverilog', '-fileunit', '-nopython', '-o', cacheDir];

      if (includePaths) {
        for (const inc of includePaths) {
          const absPath = path.isAbsolute(inc) ? inc : path.resolve(workspaceRoot, inc);
          surelogArgs.push('-I' + absPath);
        }
      }

      if (defines) {
        for (const [key, val] of Object.entries(defines)) {
          surelogArgs.push(`+define+${key}=${val}`);
        }
      }

      if (fileListPath) {
        surelogArgs.push('-f', fileListPath);
      } else {
        surelogArgs.push(...files);
      }

      onProgress?.('Elaborating project...', 0);

      // Surelog resolves relative paths inside a `-f` filelist against its own process cwd,
      // not against the filelist's location. Run it from the filelist's directory so those
      // paths resolve the same way parseFileList (backend.ts) already resolves them.
      const surelogCwd = fileListPath ? path.dirname(fileListPath) : undefined;

      await runSurelog(
        surelogPath,
        surelogArgs,
        files,
        (msg, inc) => {
          surelogReportedPct += inc;
          onProgress?.(msg, inc);
        },
        surelogCwd,
      );

      // Ensure we've consumed Surelog's 80% budget before moving on
      const surelogRemainder = 80 - surelogReportedPct;
      if (surelogRemainder > 0) onProgress?.('Elaborating project...', surelogRemainder);

      // Persist fingerprint only after successful Surelog run
      await fs.writeFile(fingerprintFile, JSON.stringify(fingerprint), 'utf-8');
    } else {
      onProgress?.('Using cached design data', 80);
    }

    const uhdmFile = await findSurelogUhdmFile(cacheDir);
    if (!(await fileExists(uhdmFile))) {
      throw new Error(`Surelog failed to generate UHDM file under ${cacheDir}`);
    }

    onProgress?.('Extracting design graph...', 10);

    const backendArgs = [uhdmFile];
    if (moduleName) {
      backendArgs.push(moduleName);
    } else {
      backendArgs.push(''); // empty targetModule means extract all
    }
    backendArgs.push(workspaceRoot);

    const { stdout, stderr } = await execFileAsync(backendPath, backendArgs, backendExecOptions());
    if (stderr) {
      logger.error(`Backend Stderr: ${stderr}`);
    }

    return JSON.parse(stdout) as RawUhdmIr;
  });

  const graph = transformToDesignGraph(raw, workspaceRoot);

  const sourceGraph = await extractSourceAwareGraph(files);
  mergeBusNodesFromSourceGraph(graph, workspaceRoot, sourceGraph);

  // Array aggregate bus nodes: UHDM reports full-element taps (arr[i]) as
  // [0:0]; they carry one whole element, so inherit the element width from
  // the aggregate-side port for correct wire/tap styling.
  for (const module of Object.values(graph.modules)) {
    for (const node of module.nodes) {
      if (node.kind !== 'bus' || node.metadata?.aggregateKind !== 'array') continue;
      const aggregatePort = node.ports.find((p) => !p.name.includes('['));
      const elementWidth = aggregatePort?.width;
      if (!elementWidth || elementWidth === '[0:0]') continue;
      const fullElementPattern = /^[^[\]]+\[[^\]]+\]$/;
      for (const port of node.ports) {
        if (port === aggregatePort) continue;
        if (port.width && port.width !== '[0:0]') continue;
        if (fullElementPattern.test(port.name)) {
          port.width = elementWidth;
        }
      }
    }
  }

  // Mark edges connected to array nodes as stacked appropriately
  for (const module of Object.values(graph.modules)) {
    for (const edge of module.edges) {
      if (edge.isStacked) continue;

      const sourceNode = module.nodes.find((n) => n.id === edge.source);
      const targetNode = module.nodes.find((n) => n.id === edge.target);

      const sourceIsArray =
        sourceNode?.isArrayNode ||
        sourceNode?.metadata?.isArrayNode ||
        (sourceNode?.kind === 'bus' &&
          sourceNode.metadata?.aggregateKind === 'array' &&
          sourceNode.metadata?.role === 'composition');
      const targetIsArrayBreakout =
        targetNode?.kind === 'bus' &&
        targetNode.metadata?.aggregateKind === 'array' &&
        targetNode.metadata?.role !== 'composition';
      const targetIsArray =
        targetNode?.isArrayNode || targetNode?.metadata?.isArrayNode || targetIsArrayBreakout;

      if (sourceIsArray || targetIsArray) {
        const sourcePort = sourceNode?.ports.find((p) => p.id === edge.sourcePort);
        const targetPort = targetNode?.ports.find((p) => p.id === edge.targetPort);
        const sourceIsScalarTap = !!(
          sourceNode?.kind === 'bus' &&
          (sourcePort?.label?.includes('[') || sourcePort?.name?.includes('['))
        );
        const targetIsScalarTap = !!(
          targetNode?.kind === 'bus' &&
          (targetPort?.label?.includes('[') || targetPort?.name?.includes('['))
        );
        // A breakout tap whose own net is multi-bit (e.g. `wire [7:0] a
        // [0:1]`) is one wide wire per element, not a bundle of scalar
        // lanes — don't force it stacked just because it fans out of a
        // breakout bus node. This only applies to edges *leaving* a
        // breakout node: the hub edge *feeding* a breakout node still
        // carries N distinct array elements bundled onto one wire and
        // stays stacked regardless of per-element width, same as other
        // array-flagged nodes (registers, muxes, ports, and composition
        // bus nodes), which represent N distinct same-named elements.
        const sourceIsArrayBreakout =
          sourceNode?.kind === 'bus' &&
          sourceNode.metadata?.aggregateKind === 'array' &&
          sourceNode.metadata?.role !== 'composition';
        let breakoutTapIsMultiBit = false;
        if (sourceIsArrayBreakout) {
          // The tap's own width (and, for taps feeding a mux selector, the
          // consumer's declared width) are often unreliable placeholders
          // ("[0:0]") — UHDM doesn't carry the per-element width on either
          // side. The hub edge feeding this same breakout node from its
          // source signal does carry the correct element width, so use it
          // both to decide stacking here and to correct the tap edge's own
          // width for downstream thick-wire rendering.
          const hubEdge = module.edges.find((e) => e.target === sourceNode.id);
          const elementWidth = hubEdge?.width;
          if (elementWidth && elementWidth !== '[0:0]') {
            if (!edge.width || edge.width === '[0:0]') {
              edge.width = elementWidth;
            }
            // The breakout node's own tap port (rendered as the node's port
            // lead) carries the same unreliable placeholder width as the
            // edge did — correct it too so the lead line renders with the
            // same thickness as the wire now leaving it.
            if (sourcePort && (!sourcePort.width || sourcePort.width === '[0:0]')) {
              sourcePort.width = elementWidth;
            }
            breakoutTapIsMultiBit = widthIsPotentiallyMultiBit(elementWidth);
          }
        }

        if (!sourceIsScalarTap && !targetIsScalarTap && !breakoutTapIsMultiBit) {
          edge.isStacked = true;
        }
      }
    }
  }

  // Pass: suppress unused modport breakout fields/nodes
  for (const module of Object.values(graph.modules)) {
    const finalUsedNodePorts = new Set<string>();
    for (const edge of module.edges) {
      finalUsedNodePorts.add(`${edge.source}:${edge.sourcePort}`);
      finalUsedNodePorts.add(`${edge.target}:${edge.targetPort}`);
    }

    const nodesToKeep = new Set<string>();
    const nodesToRemove = new Set<string>();

    for (const node of module.nodes) {
      const isModportBreakout = node.kind === 'interface' && node.metadata?.role === 'modport';
      if (isModportBreakout) {
        const hasUsedFields = node.ports.some(
          (p) =>
            p.width !== 'interface' &&
            (finalUsedNodePorts.has(`${node.id}:${p.id}`) ||
              module.edges.some(
                (e) =>
                  (e.source === node.id || e.target === node.id) &&
                  (e.signal === `${node.label}.${p.name}` ||
                    e.signal === `${node.label}.${p.label}` ||
                    e.signal === p.name ||
                    e.signal?.endsWith('.' + p.name)),
              )),
        );
        if (!hasUsedFields) {
          nodesToRemove.add(node.id);
        } else {
          nodesToKeep.add(node.id);
        }
      } else {
        nodesToKeep.add(node.id);
      }
    }

    if (nodesToRemove.size > 0) {
      const newEdges: DiagramEdge[] = [];
      for (const removedId of nodesToRemove) {
        const incoming = module.edges.filter((e) => e.target === removedId);
        const outgoing = module.edges.filter((e) => e.source === removedId);

        for (const inEdge of incoming) {
          const sourceNode = module.nodes.find((n) => n.id === inEdge.source);
          const isSourcePortHandle =
            sourceNode?.kind === 'interface' && (sourceNode.metadata as any)?.role === 'port';

          for (const outEdge of outgoing) {
            const targetNode = module.nodes.find((n) => n.id === outEdge.target);
            const isTargetPortHandle =
              targetNode?.kind === 'interface' && (targetNode.metadata as any)?.role === 'port';

            // If it's an interface connection passing through, create direct edge
            if (inEdge.width === 'interface' && outEdge.width === 'interface') {
              newEdges.push({
                ...outEdge,
                id: edgeId(inEdge.source, outEdge.target, outEdge.signal || inEdge.signal),
                source: inEdge.source,
                sourcePort: inEdge.sourcePort,
                metadata: {
                  ...outEdge.metadata,
                  aggregate: isSourcePortHandle || isTargetPortHandle ? undefined : 'interface',
                },
              });
            }
          }
        }
      }
      module.nodes = module.nodes.filter((n) => !nodesToRemove.has(n.id));
      module.edges = module.edges.filter(
        (e) => !nodesToRemove.has(e.source) && !nodesToRemove.has(e.target),
      );
      module.edges.push(...newEdges);
    }
  }

  // Final cleanup: remove redundant edges with placeholder signals/ports if better ones exist
  // AND remove direct port-to-port connections that are already represented via a bus node.
  for (const module of Object.values(graph.modules)) {
    const busNodes = module.nodes.filter((n) => n.kind === 'bus');

    // 0. Remove placeholder ports ([?]) if better ones exist
    for (const bus of busNodes) {
      const outputs = bus.ports.filter((p) => p.direction === 'output');
      const placeholders = outputs.filter((p) => (p.label || '').includes('?'));
      const goodOnes = outputs.filter((p) => !(p.label || '').includes('?'));

      if (placeholders.length > 0 && goodOnes.length > 0) {
        // If we have a placeholder and at least one good port,
        // try to see if any placeholder is redundant.
        bus.ports = bus.ports.filter((p) => !placeholders.includes(p));

        // Also need to update edges that used the placeholder ports
        for (const ph of placeholders) {
          const edges = module.edges.filter((e) => e.source === bus.id && e.sourcePort === ph.id);
          for (const edge of edges) {
            module.edges = module.edges.filter((e) => e !== edge);
          }
        }
      }
    }

    // 1. Remove redundant edges from same bus to same target
    for (const bus of busNodes) {
      const outgoing = module.edges.filter((e) => e.source === bus.id);
      const targets = new Set(outgoing.map((e) => e.target));

      for (const target of targets) {
        const edgesToTarget = outgoing.filter((e) => e.target === target);
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
              const betterEdge = group.find((e) => e.signal && !e.signal.includes('?'));
              if (betterEdge) {
                module.edges = module.edges.filter(
                  (e) =>
                    !(
                      e.source === bus.id &&
                      e.target === target &&
                      e.targetPort === betterEdge.targetPort &&
                      e !== betterEdge
                    ),
                );
              }
            }
          }
        }
      }
    }

    // 2. Remove direct port-to-port connections if they are redundant with a bus node path
    for (const bus of busNodes) {
      const incoming = module.edges.filter((e) => e.target === bus.id);
      const outgoing = module.edges.filter((e) => e.source === bus.id);

      for (const inEdge of incoming) {
        for (const outEdge of outgoing) {
          // Path: inEdge.source -> bus -> outEdge.target
          // Look for a direct edge inEdge.source -> outEdge.target
          const directEdgeIndex = module.edges.findIndex(
            (e) =>
              e.source === inEdge.source &&
              e.target === outEdge.target &&
              !busNodes.some((b) => b.id === e.target || b.id === e.source), // Not another bus node
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
          return (
            outgoing.length > 0 &&
            outgoing.every((edge) => {
              return module.edges.some(
                (candidate) =>
                  candidate.source !== bus.id &&
                  busNodes.some(
                    (candidateBus) =>
                      candidateBus.id === candidate.source &&
                      candidateBus.label !== 'expr' &&
                      candidateBus.label !== '?',
                  ) &&
                  candidate.target === edge.target &&
                  candidate.targetPort === edge.targetPort,
              );
            })
          );
        })
        .map((bus) => bus.id),
    );

    if (placeholderBusIds.size > 0) {
      module.edges = module.edges.filter(
        (edge) => !placeholderBusIds.has(edge.source) && !placeholderBusIds.has(edge.target),
      );
      module.nodes = module.nodes.filter((node) => !placeholderBusIds.has(node.id));
    }
  }

  // Multi-driver check
  for (const module of Object.values(graph.modules)) {
    const drivers = new Map<string, string[]>();
    for (const edge of module.edges) {
      if (edge.metadata?.generateRegionId) continue;
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
          message:
            `${module.name}.${signal} has multiple diagram drivers: ` +
            `${uniqueSources.join(', ')}`,
        });
      }
    }
  }

  // Stamp wire-style classification (thick wires, wide array stacks) so
  // renderers do not re-derive it from widths at draw time.
  for (const module of [
    ...Object.values(graph.modules),
    ...Object.values(graph.functions ?? {}),
    ...Object.values(graph.tasks ?? {}),
  ]) {
    annotateWireStyles(module);
  }

  onProgress?.('Finalizing...', 10);
  return orderGraphModules(graph);
}

async function extractSourceAwareGraph(files: string[]): Promise<DesignGraph | undefined> {
  try {
    const sourceFiles = await Promise.all(
      files.map(async (f) => ({
        file: f,
        text: await fs.readFile(f, 'utf-8'),
      })),
    );
    return extractDesignFromText(sourceFiles);
  } catch (err) {
    console.error(`[SVSCH] Failed to extract source-aware graph: ${err}`);
    return undefined;
  }
}

function mergeBusNodesFromSourceGraph(
  graph: DesignGraph,
  workspaceRoot: string,
  sourceGraph?: DesignGraph,
): void {
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
        nodeIdMap.set(
          stableId('port', moduleName, sourcePort.name),
          stableId('port', moduleName, targetPort.name),
        );
        if (!targetPort.width || targetPort.width === '[0:0]') {
          targetPort.width = sourcePort.width;
          if (
            !targetPort.widthExpression &&
            sourcePort.width &&
            /[A-Za-z_$]/.test(sourcePort.width)
          ) {
            targetPort.widthExpression = sourcePort.width;
            targetPort.parameterRefs = refsForWidthExpression(
              sourcePort.width,
              targetModule.parameters,
            );
          }

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
              if (
                port.connectedSignal === targetPort.name &&
                (!port.width || port.width === '[0:0]')
              ) {
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
            file: path.relative(workspaceRoot, sourcePort.source.file),
          };
        }
      }
    }

    // Merge node information (widths and sources)
    for (const sourceNode of sourceModule.nodes) {
      let targetNode = targetModule.nodes.find(
        (n) => n.label === sourceNode.label && n.kind === sourceNode.kind && n.label !== '',
      );
      if (!targetNode) {
        targetNode = targetModule.nodes.find((n) => n.id === sourceNode.id);
      }

      // Special matching for combinational/bus/struct blocks if no label match
      if (
        !targetNode &&
        (sourceNode.kind === 'comb' ||
          sourceNode.kind === 'alu' ||
          sourceNode.kind === 'inverter' ||
          sourceNode.kind === 'gate' ||
          sourceNode.kind === 'bus' ||
          sourceNode.kind === 'struct')
      ) {
        const sourceOutput = sourceNode.ports.find((p) => p.direction === 'output')?.name;
        if (sourceOutput) {
          targetNode = targetModule.nodes.find(
            (n) =>
              (n.kind === 'comb' ||
                n.kind === 'alu' ||
                n.kind === 'inverter' ||
                n.kind === 'gate' ||
                n.kind === 'bus' ||
                n.kind === 'struct') &&
              n.ports.some((p) => {
                if (p.direction !== 'output') return false;
                if (p.name === sourceOutput) return true;
                // For registers, text parser might use 'y_ff' while UHDM uses 'y_ff_next'
                if (sourceOutput.endsWith('_next') && p.name === sourceOutput.slice(0, -5))
                  return true;
                if (p.name.endsWith('_next') && sourceOutput === p.name.slice(0, -5)) return true;
                return false;
              }),
          );
        }
      }

      if (targetNode) {
        nodeIdMap.set(sourceNode.id, targetNode.id);
        // Merge source info: trust text parser for most nodes, but keep UHDM's
        // refined ranges for bus/struct/alu/gate compositions.
        if (
          sourceNode.source &&
          targetNode.kind !== 'bus' &&
          targetNode.kind !== 'struct' &&
          targetNode.kind !== 'alu' &&
          targetNode.kind !== 'gate'
        ) {
          targetNode.source = {
            ...sourceNode.source,
            file: path.relative(workspaceRoot, sourceNode.source.file),
          };
        }

        // Merge metadata
        if (sourceNode.metadata?.width) {
          if (!targetNode.metadata) targetNode.metadata = {};
          targetNode.metadata.width = sourceNode.metadata.width;
        }

        // Merge widths and signals for ports
        for (const sourcePort of sourceNode.ports) {
          let targetPort = targetNode.ports.find((p) => p.name === sourcePort.name);
          if (!targetPort && sourcePort.name.includes('[')) {
            // Try fuzzy match for selects (UHDM might prefix with module name)
            const selectPart = sourcePort.name.substring(sourcePort.name.indexOf('['));
            targetPort = targetNode.ports.find((p) => p.name.endsWith(selectPart));
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
            node.ports[0].widthExpression = port.widthExpression;
            node.ports[0].parameterRefs = port.parameterRefs;
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
      // Try to find if this bus node already exists in target graph (either by ID or by
      // same output signal)
      let existing = targetModule.nodes.find((e) => e.id === node.id);
      if (!existing) {
        const sourceOutput = node.ports.find((p) => p.direction === 'output')?.name;
        if (sourceOutput) {
          existing = targetModule.nodes.find(
            (n) =>
              n.kind === 'bus' &&
              n.ports.some((p) => p.name === sourceOutput && p.direction === 'output'),
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
            if (!existing.ports.some((p) => p.direction === 'input')) {
              existing.ports.push(sourcePort);
            }
            continue;
          }

          // Outgoing tap. Check if this tap from text parser corresponds to an existing UHDM tap.
          const sourceEdge = sourceModule.edges.find(
            (e) => e.source === node.id && e.sourcePort === sourcePort.id,
          );
          if (sourceEdge) {
            const matchingTargetEdge = targetModule.edges.find(
              (e) => e.source === existing.id && e.target === sourceEdge.target,
            );
            if (matchingTargetEdge) {
              // Found a match! The UHDM tap is likely a lower-quality version of the text tap.
              // Update all UHDM edges using this tap to use the text parser's port ID and info.
              const oldPortId = matchingTargetEdge.sourcePort;

              for (const e of targetModule.edges) {
                if (e.source === existing.id && e.sourcePort === oldPortId) {
                  e.sourcePort = sourcePort.id;
                  e.signal = sourceEdge.signal || e.signal;
                  e.width = sourcePort.width || e.width;
                }
              }

              // Update or replace the port on the bus node
              const existingPortIndex = existing.ports.findIndex((p) => p.id === oldPortId);
              if (existingPortIndex !== -1) {
                existing.ports[existingPortIndex] = {
                  ...sourcePort,
                  id: sourcePort.id, // Ensure we use the ID the edge now expects
                };
              } else {
                existing.ports.push(sourcePort);
              }
              continue;
            }
          }

          // No match found, just add it if it doesn't exist by ID or label
          if (
            !existing.ports.some(
              (p) =>
                p.id === sourcePort.id ||
                (p.label === sourcePort.label && p.direction === sourcePort.direction),
            )
          ) {
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

      const sourceNode =
        targetModule.nodes.find((n) => n.id === mappedSource) ||
        (mappedSource === 'self'
          ? ({
              id: 'self',
              kind: 'port',
              label: '',
              ports: targetModule.ports.map((p) => ({
                id: stableId('port', moduleName, p.name),
                name: p.name,
                direction: p.direction,
                signal: p.name,
                width: p.width,
              })),
            } as DiagramNode)
          : null);
      const targetNode =
        targetModule.nodes.find((n) => n.id === mappedTarget) ||
        (mappedTarget === 'self'
          ? ({
              id: 'self',
              kind: 'port',
              label: '',
              ports: targetModule.ports.map((p) => ({
                id: stableId('port', moduleName, p.name),
                name: p.name,
                direction: p.direction,
                signal: p.name,
                width: p.width,
              })),
            } as DiagramNode)
          : null);

      if (!sourceNode || !targetNode) {
        continue;
      }

      // Check if ports exist, otherwise try to map them or skip
      let mappedSourcePort = edge.sourcePort;
      if (!sourceNode.ports.some((p) => p.id === mappedSourcePort)) {
        // Try to find a port with same name/label
        const sourceModuleNode = sourceModule.nodes.find(
          (n) => n.id === (edge.source === 'self' ? 'self' : edge.source),
        );
        const sourcePortObj = sourceModuleNode?.ports.find((p) => p.id === edge.sourcePort);
        if (sourcePortObj) {
          const matchingTargetPort = sourceNode.ports.find(
            (p) =>
              p.name === sourcePortObj.name ||
              (sourcePortObj.label && p.label === sourcePortObj.label),
          );
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
      if (!targetNode.ports.some((p) => p.id === mappedTargetPort)) {
        const sourceModuleNode = sourceModule.nodes.find(
          (n) => n.id === (edge.target === 'self' ? 'self' : edge.target),
        );
        const targetPortObj = sourceModuleNode?.ports.find((p) => p.id === edge.targetPort);
        if (targetPortObj) {
          const matchingTargetPort = targetNode.ports.find(
            (p) =>
              p.name === targetPortObj.name ||
              (targetPortObj.label && p.label === targetPortObj.label),
          );
          if (matchingTargetPort) {
            mappedTargetPort = matchingTargetPort.id;
          } else {
            continue; // Port not found in target
          }
        } else {
          continue;
        }
      }

      // If it's a bus edge, check if it's already represented (perhaps under a different
      // port ID merged above)
      const duplicate = targetModule.edges.some(
        (existing) =>
          existing.source === mappedSource &&
          existing.target === mappedTarget &&
          // Loose match for bus taps
          (existing.sourcePort === mappedSourcePort || existing.target === mappedTarget) &&
          existing.targetPort === mappedTargetPort,
      );

      if (!duplicate) {
        targetModule.edges.push({
          ...edge,
          source: mappedSource,
          target: mappedTarget,
          sourcePort: mappedSourcePort,
          targetPort: mappedTargetPort,
          // `edge.id` is already unique within sourceModule.edges, so it's a stable
          // disambiguator when there's no declared signal name to key on — using
          // Math.random() here made this merge (and anything keyed off the result,
          // like a saved edge route) non-deterministic across otherwise-identical runs.
          id: edgeId(mappedSource, mappedTarget, edge.signal || edge.id),
        });
      }
    }
  }
}

function emptyGraph(): DesignGraph {
  return {
    rootModules: [],
    modules: {},
    functions: {},
    tasks: {},
    diagnostics: [],
    generatedAt: new Date().toISOString(),
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
    path.join(tmpDir, 'slpp_all', 'surelog.uhdm'),
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
    parameters?: Array<{
      name: string;
      kind: 'parameter' | 'localparam';
      defaultValue?: string;
      width?: string;
      source?: RawSourceRange;
      valueSource?: RawSourceRange;
    }>;
    ports?: Array<{
      name: string;
      direction: string;
      width: string;
      widthExpression?: string;
      parameterRefs?: RawParameterRef[];
      typeName?: string;
      typeSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
      modportName?: string;
      modportSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
      isArrayNode?: boolean;
      arrayDimension?: string;
      arraySize?: number;
      source: { file: string; line: number; col: number; endLine: number; endCol: number };
    }>;
    nodes?: Array<{
      id: string;
      kind: string;
      label: string;
      instanceOf?: string;
      moduleName?: string;
      functionId?: string;
      functionName?: string;
      taskId?: string;
      taskName?: string;
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
      fields?: Array<{
        name: string;
        width?: string;
        bitRange?: string;
        typeName?: string;
        direction?: 'input' | 'output' | 'inout' | 'unknown';
        source?: { file: string; line: number; col: number; endLine: number; endCol: number };
      }>;
      aggregateKind?: string;
      preferredSide?: string;
      isArrayNode?: boolean;
      arrayDimension?: string;
      arraySize?: number;
      arrayIndexSignal?: string;
      metadata?: RawNodeMetadata;
      ports: Array<{
        name: string;
        direction: string;
        signal: string;
        width: string;
        widthExpression?: string;
        parameterRefs?: RawParameterRef[];
        typeName?: string;
        typeSource?: { file: string; line: number; col: number; endLine: number; endCol: number };
        modportName?: string;
        modportSource?: {
          file: string;
          line: number;
          col: number;
          endLine: number;
          endCol: number;
        };
        label?: string;
        isArrayNode?: boolean;
        arrayDimension?: string;
        arraySize?: number;
        source?: { file: string; line: number; col: number; endLine: number; endCol: number };
      }>;
      source: { file: string; line: number; col: number; endLine: number; endCol: number };
    }>;
    edges?: Array<{
      source: string;
      target: string;
      sourcePort: string;
      targetPort: string;
      signal: string;
      width?: string;
      isStacked?: boolean;
      sourceRange?: { file: string; line: number; col: number; endLine: number; endCol: number };
      metadata?: DiagramEdgeMetadata;
    }>;
    generateRegions?: Array<{
      id: string;
      kind: string;
      label: string;
      condition?: string;
      selector?: string;
      caseValue?: string;
      blockLabel?: string;
      fullBlockLabel?: string;
      parentRegionId?: string;
      siblingGroupId?: string;
      activeState?: string;
      armIndex?: number;
      source?: RawSourceRange;
      bodySource?: RawSourceRange;
      groupSource?: RawSourceRange;
      nodeIds?: string[];
      edgeIds?: string[];
      warnings?: string[];
    }>;
  }>;
  functions?: RawCallable[];
  tasks?: RawCallable[];
  rootModules?: string[];
}

type RawModule = RawUhdmIr['modules'][number];
interface RawCallable extends RawModule {
  functionName?: string;
  taskName?: string;
  parentModule: string;
}
type RawSourceRange = { file: string; line: number; col: number; endLine: number; endCol: number };
type RawParameterRef = {
  name: string;
  source?: RawSourceRange;
  declarationSource?: RawSourceRange;
};
type RawInstanceParameter = {
  name: string;
  value?: string;
  isOverride?: boolean;
  source?: RawSourceRange;
  valueSource?: RawSourceRange;
  parameterRefs?: RawParameterRef[];
};
type RawNodeMetadata = Omit<
  DiagramNodeMetadata,
  'typeSource' | 'repeatExpressionSource' | 'parameterRefs' | 'instanceParameters'
> & {
  typeSource?: RawSourceRange;
  repeatExpressionSource?: RawSourceRange;
  modportSource?: RawSourceRange;
  parameterRefs?: RawParameterRef[];
  instanceParameters?: RawInstanceParameter[];
};
type RawNode = NonNullable<RawModule['nodes']>[number];

function parameterRefFromRaw(ref: RawParameterRef, workspaceRoot: string): ParameterRef {
  return {
    name: ref.name,
    source: sourceRangeFromRaw(ref.source, workspaceRoot),
    declarationSource: sourceRangeFromRaw(ref.declarationSource, workspaceRoot),
  };
}

function parameterDeclFromRaw(
  param: NonNullable<RawModule['parameters']>[number],
  workspaceRoot: string,
): ParameterDecl {
  return {
    name: param.name,
    kind: param.kind,
    defaultValue: param.defaultValue,
    width: param.width,
    source: sourceRangeFromRaw(param.source, workspaceRoot),
    valueSource: sourceRangeFromRaw(param.valueSource, workspaceRoot),
  };
}

function instanceParameterFromRaw(
  param: RawInstanceParameter,
  workspaceRoot: string,
): InstanceParameter {
  return {
    name: param.name,
    value: param.value,
    isOverride: param.isOverride,
    source: sourceRangeFromRaw(param.source, workspaceRoot),
    valueSource: sourceRangeFromRaw(param.valueSource, workspaceRoot),
    parameterRefs: param.parameterRefs?.map((ref) => parameterRefFromRaw(ref, workspaceRoot)),
  };
}

function generateRegionFromRaw(
  region: NonNullable<RawModule['generateRegions']>[number],
  workspaceRoot: string,
): GenerateRegion {
  return {
    id: region.id,
    kind: region.kind,
    label: region.label,
    condition: region.condition || undefined,
    selector: region.selector || undefined,
    caseValue: region.caseValue || undefined,
    blockLabel: region.blockLabel || undefined,
    fullBlockLabel: region.fullBlockLabel || undefined,
    parentRegionId: region.parentRegionId || undefined,
    siblingGroupId: region.siblingGroupId || undefined,
    activeState: region.activeState || undefined,
    armIndex: region.armIndex,
    source: sourceRangeFromRaw(region.source, workspaceRoot),
    bodySource: sourceRangeFromRaw(region.bodySource, workspaceRoot),
    groupSource: sourceRangeFromRaw(region.groupSource, workspaceRoot),
    nodeIds: region.nodeIds?.length ? region.nodeIds : undefined,
    edgeIds: region.edgeIds?.length ? region.edgeIds : undefined,
    warnings: region.warnings?.length ? region.warnings : undefined,
  };
}

// Wrap each generate expression's arms in a synthesized "generate block" region so the
// UI can group them. Arms are reparented under the wrapper, so the existing nested-region
// mechanics (move-together, auto-expand, ancestor/descendant overlap) apply for free.
function synthesizeGenerateBlockRegions(arms: GenerateRegion[]): GenerateRegion[] {
  if (arms.length === 0) return arms;

  const groups = new Map<string, GenerateRegion[]>();
  for (const arm of arms) {
    const key = arm.siblingGroupId || arm.id;
    const list = groups.get(key) ?? [];
    list.push(arm);
    groups.set(key, list);
  }

  const wrappers: GenerateRegion[] = [];
  const reparentedById = new Map<string, GenerateRegion>();
  for (const [key, groupArms] of groups) {
    const wrapperId = `generate-block:${key}`;
    const isCase = groupArms.some((arm) => arm.kind === 'case' || arm.kind === 'case-default');
    const selector = groupArms
      .map((arm) => arm.selector)
      .find((value): value is string => Boolean(value));
    const label = isCase
      ? selector
        ? `generate case (${selector})`
        : 'generate case'
      : 'generate if';
    const anchor = groupArms.reduce(
      (earliest, arm) =>
        (arm.source?.startLine ?? Infinity) < (earliest.source?.startLine ?? Infinity)
          ? arm
          : earliest,
      groupArms[0],
    );
    wrappers.push({
      id: wrapperId,
      kind: isCase ? 'generate-case' : 'generate-if',
      label,
      isGenerateBlock: true,
      parentRegionId: anchor.parentRegionId,
      siblingGroupId: wrapperId,
      activeState: 'active',
      // Navigation target: the whole if/else chain or case..endcase statement.
      source: anchor.groupSource ?? anchor.source,
      nodeIds: [],
    });
    for (const arm of groupArms) {
      reparentedById.set(arm.id, { ...arm, parentRegionId: wrapperId });
    }
  }

  // Wrappers first so they render behind their arms.
  return [...wrappers, ...arms.map((arm) => reparentedById.get(arm.id) ?? arm)];
}

function refsForWidthExpression(
  expression: string,
  parameters: ParameterDecl[] | undefined,
): ParameterRef[] | undefined {
  if (!parameters?.length) return undefined;
  const refs = parameters
    .filter((param) =>
      new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(param.name)}([^A-Za-z0-9_$]|$)`).test(
        expression,
      ),
    )
    .map((param) => ({
      name: param.name,
      declarationSource: param.source,
    }));
  return refs.length > 0 ? refs : undefined;
}

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
  if (n.preferredSide !== undefined) topLevel.preferredSide = n.preferredSide;
  if (n.isArrayNode !== undefined) topLevel.isArrayNode = n.isArrayNode;
  if (n.arrayDimension !== undefined) topLevel.arrayDimension = n.arrayDimension;
  if (n.arraySize !== undefined) topLevel.arraySize = n.arraySize;
  if (n.arrayIndexSignal !== undefined) topLevel.arrayIndexSignal = n.arrayIndexSignal;
  if (n.metadata?.preferredSide !== undefined) topLevel.preferredSide = n.metadata.preferredSide;
  if (n.metadata?.parameterRefs !== undefined) topLevel.parameterRefs = n.metadata.parameterRefs;
  if (n.metadata?.instanceParameters !== undefined)
    topLevel.instanceParameters = n.metadata.instanceParameters;
  return Object.keys(topLevel).length > 0 || n.metadata
    ? { ...n.metadata, ...topLevel }
    : undefined;
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
  return source
    ? {
        file: path.relative(workspaceRoot, source.file),
        startLine: source.line,
        startColumn: source.col,
        endLine: source.endLine,
        endColumn: source.endCol,
      }
    : undefined;
}

function findTypedefSource(
  cache: Map<string, string>,
  sourceFile: string | undefined,
  typeName: string | undefined,
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

  const pattern = new RegExp(
    `typedef\\s+(?:enum|struct)\\b[\\s\\S]*?\\b${escapeRegExp(typeName)}\\s*;`,
    'm',
  );
  const match = pattern.exec(text);
  if (!match) return undefined;

  const before = text.slice(0, match.index);
  const matched = match[0];
  const beforeLines = before.split('\n');
  const matchedLines = matched.split('\n');
  const line = beforeLines.length;
  const col = beforeLines[beforeLines.length - 1].length;
  const endLine = line + matchedLines.length - 1;
  const endCol =
    matchedLines.length === 1
      ? col + matchedLines[0].length
      : matchedLines[matchedLines.length - 1].length;

  return { file: sourceFile, line, col, endLine, endCol };
}

function resolveTypeSource(
  cache: Map<string, string>,
  typeSource: RawSourceRange | undefined,
  fallbackFile: string | undefined,
  typeName: string | undefined,
): RawSourceRange | undefined {
  if (isValidRawSource(typeSource)) return typeSource;
  return findTypedefSource(cache, fallbackFile, typeName);
}

function getSourceText(
  cache: Map<string, string>,
  sourceFile: string | undefined,
): string | undefined {
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

function offsetToRawSource(
  text: string,
  file: string,
  startOffset: number,
  endOffset: number,
): RawSourceRange {
  const before = text.slice(0, startOffset);
  const selected = text.slice(startOffset, endOffset);
  const beforeLines = before.split('\n');
  const selectedLines = selected.split('\n');
  const line = beforeLines.length;
  const col = beforeLines[beforeLines.length - 1].length;
  const endLine = line + selectedLines.length - 1;
  const endCol =
    selectedLines.length === 1
      ? col + selectedLines[0].length
      : selectedLines[selectedLines.length - 1].length;
  return { file, line, col, endLine, endCol };
}

function rawSourceFromRange(source: RawSourceRange | undefined): RawSourceRange | undefined {
  return source;
}

function findIdentifierDeclaration(
  cache: Map<string, string>,
  sourceFile: string | undefined,
  name: string,
  kind: 'parameter' | 'enum',
):
  | { source: RawSourceRange; typeName?: string; typeSource?: RawSourceRange; width?: string }
  | undefined {
  const text = getSourceText(cache, sourceFile);
  if (!sourceFile || !text) return undefined;

  if (kind === 'enum') {
    const enumPattern =
      /typedef\s+enum\b(?:\s+\w+)*\s*(\[[^\]]+\])?[\s\S]*?\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    for (const match of text.matchAll(enumPattern)) {
      const width = match[1];
      const members = match[2];
      const typeName = match[3];
      const membersStart = (match.index ?? 0) + match[0].indexOf(members);
      const memberPattern = new RegExp(
        `(?:^|,)\\s*(${escapeRegExp(name)})(?:\\s*=\\s*[^,}]+)?`,
        'g',
      );
      const memberMatch = memberPattern.exec(members);
      if (!memberMatch?.[1]) continue;

      const nameOffsetInMember = memberMatch[0].indexOf(memberMatch[1]);
      const startOffset = membersStart + memberMatch.index + nameOffsetInMember;
      const declaratorEnd =
        membersStart + memberMatch.index + memberMatch[0].replace(/^,/, '').length;
      return {
        source: offsetToRawSource(text, sourceFile, startOffset, declaratorEnd),
        typeName,
        typeSource: offsetToRawSource(
          text,
          sourceFile,
          match.index ?? 0,
          (match.index ?? 0) + match[0].length,
        ),
        width,
      };
    }
    return undefined;
  }

  const parameterPattern = new RegExp(
    `(?:^|[;\\n])\\s*(?:localparam|parameter)\\b[^;]*\\b${escapeRegExp(name)}\\b[^;]*;`,
    'g',
  );
  const match = parameterPattern.exec(text);
  if (!match) return undefined;
  const leading = match[0].match(/^\s*;/)?.[0].length ?? 0;
  const newline = match[0].indexOf('\n');
  const startOffset = (match.index ?? 0) + (newline >= 0 ? newline + 1 : leading);
  const width = match[0].match(/\[[^\]]+\]/)?.[0];
  return {
    source: offsetToRawSource(text, sourceFile, startOffset, (match.index ?? 0) + match[0].length),
    width,
  };
}

function findInterfaceMemberDeclaration(
  cache: Map<string, string>,
  sourceFile: string | undefined,
  interfaceName: string | undefined,
  memberName: string | undefined,
): { source: RawSourceRange; width?: string } | undefined {
  const text = getSourceText(cache, sourceFile);
  if (!sourceFile || !text || !interfaceName || !memberName) return undefined;

  const interfacePattern = new RegExp(
    `\\binterface\\s+(?:automatic\\s+)?${escapeRegExp(interfaceName)}` +
      `\\b[\\s\\S]*?\\bendinterface\\b`,
    'm',
  );
  const interfaceMatch = interfacePattern.exec(text);
  if (!interfaceMatch) return undefined;

  const interfaceOffset = interfaceMatch.index ?? 0;
  const interfaceText = interfaceMatch[0];
  const escapedMember = escapeRegExp(memberName);
  const headerEnd = interfaceText.indexOf(';');
  const headerText = headerEnd >= 0 ? interfaceText.slice(0, headerEnd) : '';
  const headerPattern = new RegExp(
    `\\b(?:input|output|inout)\\b[^,;)]*\\b${escapedMember}\\b[^,;)]*`,
    'g',
  );
  const headerMatch = headerPattern.exec(headerText);
  if (headerMatch) {
    const startOffset = interfaceOffset + (headerMatch.index ?? 0);
    return {
      source: offsetToRawSource(text, sourceFile, startOffset, startOffset + headerMatch[0].length),
      width: headerMatch[0].match(/\[[^\]]+\]/)?.[0],
    };
  }

  const bodyOffset = headerEnd >= 0 ? headerEnd + 1 : 0;
  const bodyText = interfaceText.slice(bodyOffset);
  const declarationPattern = new RegExp(
    `(?:^|[;\\n])\\s*(?:(?:input|output|inout)\\b\\s*)?` +
      `(?:(?:wire|logic|reg|bit)\\b\\s*)?(?:\\[[^\\]]+\\]\\s*)?` +
      `(?:[A-Za-z_$][\\w$]*\\s+)?(?:\\[[^\\]]+\\]\\s*)?` +
      `[^;\\n()]*\\b${escapedMember}\\b[^;\\n()]*;`,
    'g',
  );
  const declarationMatch = declarationPattern.exec(bodyText);
  if (!declarationMatch) return undefined;

  const leading = declarationMatch[0].search(/[^\s;]/);
  const startInMatch = leading >= 0 ? leading : 0;
  const startOffset = interfaceOffset + bodyOffset + (declarationMatch.index ?? 0) + startInMatch;
  const endOffset =
    interfaceOffset + bodyOffset + (declarationMatch.index ?? 0) + declarationMatch[0].length;
  return {
    source: offsetToRawSource(text, sourceFile, startOffset, endOffset),
    width: declarationMatch[0].match(/\[[^\]]+\]/)?.[0],
  };
}

function findLiteralOccurrence(
  cache: Map<string, string>,
  sourceFile: string | undefined,
  label: string,
  source: RawSourceRange | undefined,
): RawSourceRange | undefined {
  const text = getSourceText(cache, sourceFile);
  if (!sourceFile || !text || !label) return undefined;

  const lines = text.split('\n');
  const startLine = Math.max(1, source?.line ?? 1);
  const endLine = Math.max(
    startLine,
    source?.endLine && source.endLine > 0 ? source.endLine : startLine,
  );
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

function findDeclaredWidth(
  cache: Map<string, string>,
  sourceFile: string | undefined,
  name: string | undefined,
): string | undefined {
  const text = getSourceText(cache, sourceFile);
  if (!text || !name) return undefined;

  return findDeclaredWidthInText(text, name);
}

function findDeclaredWidthInModule(
  cache: Map<string, string>,
  sourceFile: string | undefined,
  moduleName: string | undefined,
  name: string | undefined,
): string | undefined {
  const text = getSourceText(cache, sourceFile);
  if (!text || !moduleName || !name) return undefined;

  const normalizedName = moduleName.replace(/^work@/, '');
  const modulePattern = new RegExp(
    `\\bmodule\\s+(?:automatic\\s+)?${escapeRegExp(normalizedName)}\\b[\\s\\S]*?\\bendmodule\\b`,
    'm',
  );
  const moduleMatch = modulePattern.exec(text);
  return findDeclaredWidthInText(moduleMatch?.[0] ?? text, name);
}

function findDeclaredWidthInText(text: string, name: string): string | undefined {
  const pattern = new RegExp(
    `(?:input|output|inout|logic|wire|reg|localparam|parameter)\\b[^,;\\n)]*?(\\[[^\\]]+\\])` +
      `[^,;\\n)]*?\\b${escapeRegExp(name)}\\b`,
    'g',
  );
  const keywords = ['input', 'output', 'inout', 'logic', 'wire', 'reg', 'localparam', 'parameter'];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const widthPart = match[1];
    const widthIndex = fullMatch.indexOf(widthPart);
    const intermediate = fullMatch.slice(widthIndex + widthPart.length);
    const hasKeyword = keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(intermediate));
    if (!hasKeyword) {
      return widthPart;
    }
  }
  return undefined;
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

function resolveLiteralDetails(
  cache: Map<string, string>,
  workspaceRoot: string,
  sourceFile: string | undefined,
  label: string,
  source: RawSourceRange | undefined,
): { source?: SourceRange; metadata?: DiagramNodeMetadata; width?: string } {
  if (!label) return {};

  const enumDecl = findIdentifierDeclaration(cache, sourceFile, label, 'enum');
  if (enumDecl) {
    return {
      source: sourceRangeFromRaw(enumDecl.source, workspaceRoot) as SourceRange,
      metadata: {
        typeName: enumDecl.typeName,
        typeSource: sourceRangeFromRaw(enumDecl.typeSource, workspaceRoot),
      },
      width: enumDecl.width,
    };
  }

  if (/^[A-Za-z_$][\w$]*$/.test(label)) {
    const parameterDecl = findIdentifierDeclaration(cache, sourceFile, label, 'parameter');
    if (parameterDecl) {
      return {
        source: sourceRangeFromRaw(parameterDecl.source, workspaceRoot) as SourceRange,
        width: parameterDecl.width,
      };
    }
  }

  const literalOccurrence = findLiteralOccurrence(cache, sourceFile, label, source);
  return {
    source: sourceRangeFromRaw(
      literalOccurrence ?? rawSourceFromRange(source),
      workspaceRoot,
    ) as SourceRange,
  };
}

function transformToDesignGraph(raw: RawUhdmIr, workspaceRoot: string): DesignGraph {
  const graph: DesignGraph = emptyGraph();
  const sourceTextCache = new Map<string, string>();
  const structTypeNames = new Set(
    raw.modules.filter((m) => m.name.startsWith('struct ')).map((m) => m.name.slice(7)),
  );

  const rawFunctions = new Set<RawModule>(raw.functions ?? []);
  const rawTasks = new Set<RawModule>(raw.tasks ?? []);
  for (const rawMod of [...raw.modules, ...(raw.functions ?? []), ...(raw.tasks ?? [])]) {
    // Remove 'work@' prefix if present
    const modName = rawMod.name.replace(/^work@/, '');

    const usedNodePorts = new Set<string>();
    for (const e of rawMod.edges || []) {
      usedNodePorts.add(`${e.source}:${e.sourcePort}`);
      usedNodePorts.add(`${e.target}:${e.targetPort}`);
    }

    const moduleFile = rawMod.file ? path.relative(workspaceRoot, rawMod.file) : '';
    const parameters = rawMod.parameters?.map((param) =>
      parameterDeclFromRaw(param, workspaceRoot),
    );
    const ports: DiagramPort[] = (rawMod.ports || []).map((p, i) => {
      // C++ typespec fix now provides accurate widths for constant-ranged ports.
      // For parametric widths (e.g. [WIDTH-1:0]) the symbolic expression must still
      // come from source text, since UHDM evaluates parameters at elaboration time.
      // Derive widthExpression from source text when C++ didn't provide it.
      // C++ evaluates parametric ranges (e.g. [WIDTH-1:0] → [7:0]), so we need
      // source text to recover the symbolic form for IDE navigation and display.
      const declaredWidth = !p.widthExpression
        ? findDeclaredWidthInModule(sourceTextCache, rawMod.file, modName, p.name)
        : undefined;
      // Use C++ width when it's a real constant range; fall back to declared for
      // ports where C++ still reports [0:0] (unevaluated or scalar).
      const width = p.width && p.width !== '[0:0]' ? p.width : (declaredWidth ?? p.width);
      const widthExpression =
        p.widthExpression ||
        (declaredWidth && /[A-Za-z_$]/.test(declaredWidth) ? declaredWidth : undefined) ||
        (p.width && /[A-Za-z_$]/.test(p.width) ? p.width : undefined);
      const rawParameterRefs = p.parameterRefs?.map((ref) =>
        parameterRefFromRaw(ref, workspaceRoot),
      );
      return {
        id: stableId('port', p.name),
        name: p.name,
        direction: p.direction as any,
        position: i,
        width: width || undefined,
        widthExpression,
        parameterRefs: rawParameterRefs?.length
          ? rawParameterRefs
          : widthExpression
            ? refsForWidthExpression(widthExpression, parameters)
            : undefined,
        typeName: p.typeName,
        typeSource: sourceRangeFromRaw(
          resolveTypeSource(
            sourceTextCache,
            p.typeSource,
            p.source?.file || rawMod.file,
            p.typeName,
          ),
          workspaceRoot,
        ),
        modportName: p.modportName,
        modportSource: sourceRangeFromRaw(p.modportSource, workspaceRoot),
        preferredSide: (p as any).preferredSide || undefined,
        isArrayNode: p.isArrayNode,
        arrayDimension: p.arrayDimension,
        arraySize: p.arraySize,
        source: p.source
          ? {
              file: path.relative(workspaceRoot, p.source.file),
              startLine: p.source.line,
              startColumn: p.source.col,
              endLine: p.source.endLine,
              endColumn: p.source.endCol,
            }
          : undefined,
      };
    });

    const nodes: DiagramNode[] = (rawMod.nodes || []).map((n) => {
      const rawMetadata = rawNodeMetadata(n);
      const metadata: DiagramNodeMetadata | undefined = rawMetadata
        ? { ...rawMetadata }
        : undefined;
      // ... (rest of metadata logic remains same)
      if (metadata?.typeName) {
        const resolvedTypeSource = resolveTypeSource(
          sourceTextCache,
          rawMetadata?.typeSource,
          n.source?.file || rawMod.file,
          metadata.typeName,
        );
        if (resolvedTypeSource) {
          metadata.typeSource = sourceRangeFromRaw(resolvedTypeSource, workspaceRoot);
        }
      }
      if (metadata?.modportSource && rawMetadata?.modportSource) {
        metadata.modportSource = sourceRangeFromRaw(rawMetadata.modportSource, workspaceRoot);
      }
      if (rawMetadata?.parameterRefs) {
        metadata!.parameterRefs = rawMetadata.parameterRefs.map((ref) =>
          parameterRefFromRaw(ref, workspaceRoot),
        );
      }
      if (rawMetadata?.instanceParameters) {
        metadata!.instanceParameters = rawMetadata.instanceParameters.map((param) =>
          instanceParameterFromRaw(param, workspaceRoot),
        );
      }
      // repeatExpressionSource: C++ backend now emits this directly for symbolic repeat counts.
      // Only fall back to source-text search when C++ didn't provide it.
      if (
        metadata?.repeatExpression &&
        /^[A-Za-z_$][\w$]*$/.test(metadata.repeatExpression) &&
        !metadata.repeatExpressionSource
      ) {
        const repeatSourceFile =
          rawMod.file ||
          (n.source?.file && fsSync.existsSync(n.source.file) ? n.source.file : undefined);
        const repeatDecl = findIdentifierDeclaration(
          sourceTextCache,
          repeatSourceFile,
          metadata.repeatExpression,
          'parameter',
        );
        if (repeatDecl) {
          metadata.repeatExpressionSource = sourceRangeFromRaw(repeatDecl.source, workspaceRoot);
        }
      }
      // For literal nodes: C++ now provides typeName, typeSource, and accurate declaration
      // source for enum members and parameter literals. Merge with any remaining TS resolution.
      const literalDetails =
        n.kind === 'literal' && (!metadata?.typeName || !isValidRawSource(n.source))
          ? resolveLiteralDetails(
              sourceTextCache,
              workspaceRoot,
              n.source?.file || rawMod.file,
              n.label,
              n.source,
            )
          : undefined;
      const nodeMetadata = literalDetails?.metadata
        ? { ...(metadata ?? {}), ...literalDetails.metadata }
        : metadata;

      if (nodeMetadata && rawMetadata?.preferredSide) {
        nodeMetadata.preferredSide = rawMetadata.preferredSide;
      }

      const isInterfaceInstance = n.kind === 'interface' && nodeMetadata?.role !== 'modport';
      const isModportBreakout = isInterfaceInstance && nodeMetadata?.modportName !== undefined;
      const hasUsedFields =
        isInterfaceInstance &&
        n.ports.some((p) => p.width !== 'interface' && usedNodePorts.has(`${n.id}:${p.name}`));
      const shouldSuppressFields = isModportBreakout && !hasUsedFields;

      const node: DiagramNode = {
        id: n.id === 'self' ? stableId('port', modName, n.label) : n.id,
        kind: n.kind as any,
        label: (n.label || '').replace(/^work@/, ''),
        moduleName: n.instanceOf?.replace(/^work@/, ''),
        instanceOf: n.instanceOf?.replace(/^work@/, ''),
        functionId: n.functionId?.replace(/^work@/, ''),
        functionName: n.functionName?.replace(/^work@/, ''),
        taskId: n.taskId?.replace(/^work@/, ''),
        taskName: n.taskName?.replace(/^work@/, ''),
        parentModule: modName,
        preferredSide: n.preferredSide || nodeMetadata?.preferredSide,
        ...(nodeMetadata ?? {}),
        metadata: nodeMetadata
          ? {
              ...nodeMetadata,
              preferredSide: n.preferredSide || nodeMetadata.preferredSide,
            }
          : undefined,
        // Ensure preferredSide on the node itself is correctly assigned last to override spread
        ...(n.preferredSide || nodeMetadata?.preferredSide
          ? { preferredSide: n.preferredSide || nodeMetadata?.preferredSide }
          : {}),

        ports: (() => {
          const seenIds = new Set<string>();
          return n.ports
            .map((p, i) => {
              if (shouldSuppressFields && p.width !== 'interface') {
                return [];
              }
              let portId: string;
              if (n.kind === 'instance' || n.kind === 'funcCall' || n.kind === 'taskCall') {
                portId = stableId('port', p.name);
              } else if (
                (n.kind === 'comb' ||
                  n.kind === 'alu' ||
                  n.kind === 'inverter' ||
                  n.kind === 'gate') &&
                p.direction === 'output'
              ) {
                portId = stableId('out', p.name);
              } else if (n.kind === 'alu') {
                portId = p.name;
              } else if (n.kind === 'inverter') {
                portId = stableId('in', p.name);
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

              const modulePortWidth = ports.find(
                (port) => port.name === p.signal || port.name === p.name,
              )?.width;
              const rawPortWidth =
                modulePortWidth ??
                (rawMod.ports || []).find((port) => port.name === p.signal || port.name === p.name)
                  ?.width;
              const sourceDeclaredWidth = findDeclaredWidthInModule(
                sourceTextCache,
                n.source?.file || rawMod.file,
                modName,
                p.signal || p.name,
              );
              const declaredSignalWidth =
                rawPortWidth && rawPortWidth !== '[0:0]'
                  ? rawPortWidth
                  : (sourceDeclaredWidth ?? rawPortWidth);
              const resolvedInterfaceMember =
                n.kind === 'interface' && p.width !== 'interface'
                  ? findInterfaceMemberDeclaration(
                      sourceTextCache,
                      p.source?.file || n.source?.file || rawMod.file,
                      nodeMetadata?.typeName || n.label,
                      p.label || p.name,
                    )
                  : undefined;
              const portSource = resolvedInterfaceMember?.source ?? p.source;
              // UHDM reports interface members as [0:0]; recover the declared
              // range from the interface body so styling reflects the width.
              const interfaceMemberWidth =
                !p.width || p.width === '[0:0]' ? resolvedInterfaceMember?.width : undefined;

              const common = {
                name: p.name,
                direction: p.direction as any,
                width:
                  n.kind === 'literal'
                    ? (literalDetails?.width ?? declaredSignalWidth ?? p.width ?? undefined)
                    : n.kind === 'replicate'
                      ? (declaredSignalWidth ?? p.width ?? undefined)
                      : n.kind === 'inverter'
                        ? (declaredSignalWidth ?? p.width ?? undefined)
                        : n.kind === 'interface'
                          ? (interfaceMemberWidth ?? p.width ?? undefined)
                          : p.width || undefined,
                widthExpression: p.widthExpression || undefined,
                parameterRefs: p.parameterRefs?.map((ref) =>
                  parameterRefFromRaw(ref, workspaceRoot),
                ),
                typeName: p.typeName,
                typeSource: sourceRangeFromRaw(
                  resolveTypeSource(
                    sourceTextCache,
                    p.typeSource,
                    p.source?.file || n.source?.file || rawMod.file,
                    p.typeName,
                  ),
                  workspaceRoot,
                ),
                modportName: p.modportName,
                modportSource: sourceRangeFromRaw(p.modportSource, workspaceRoot),
                preferredSide: (p as any).preferredSide || undefined,
                label: p.label || undefined,
                isArrayNode: p.isArrayNode,
                arrayDimension: p.arrayDimension,
                arraySize: p.arraySize,
                connectedSignal: p.signal,
                source: portSource
                  ? {
                      file: path.relative(workspaceRoot, portSource.file),
                      startLine: portSource.line,
                      startColumn: portSource.col,
                      endLine: portSource.endLine,
                      endColumn: portSource.endCol,
                    }
                  : undefined,
              };

              if (isInterfaceInstance && p.width === 'interface') {
                const id =
                  p.direction === 'input' ? stableId('in', p.name) : stableId('out', p.name);
                return [
                  {
                    ...common,
                    id: id,
                    preferredSide: (p as any).preferredSide || undefined,
                  },
                ];
              }

              return [
                {
                  id: portId,
                  ...common,
                },
              ];
            })
            .flat();
        })(),

        source: literalDetails?.source ?? {
          file: path.relative(workspaceRoot, n.source.file),
          startLine: n.source.line,
          startColumn: n.source.col,
          endLine: n.source.endLine,
          endColumn: n.source.endCol,
        },
      };
      return node;
    });

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
        isArrayNode: p.isArrayNode,
        arrayDimension: p.arrayDimension,
        arraySize: p.arraySize,
        ports: [p],
        source: p.source || { file: moduleFile, startLine: 1 },
      });
    }

    // Downgrade `!`-tagged inverters whose input is wider than 1 bit to
    // comb nodes.  The C++ backend can't reliably check port widths for
    // logical NOT from UHDM metadata, so we do it here where the source
    // text is available for an accurate declared-width lookup.
    for (const node of nodes) {
      if (node.kind !== 'inverter' || node.metadata?.operation !== '!') continue;
      const inputPort = node.ports.find((p) => p.direction === 'input');
      if (inputPort && bitSizeFromWidth(inputPort.width) > 1) {
        (node as any).kind = 'comb';
        if (node.metadata) (node.metadata as any).operation = undefined;
      }
    }

    const armRegions = rawMod.generateRegions?.map((region) =>
      generateRegionFromRaw(region, workspaceRoot),
    );
    const generateRegions = armRegions ? synthesizeGenerateBlockRegions(armRegions) : armRegions;

    const module: DesignModule = {
      name: modName,
      file: moduleFile,
      parameters,
      ports: ports,
      nodes: nodes,
      generateRegions,
      edges: (rawMod.edges || []).map((e, i) => {
        const sourceNodeId =
          e.source === 'self' ? stableId('port', modName, e.sourcePort) : e.source;
        const targetNodeId =
          e.target === 'self' ? stableId('port', modName, e.targetPort) : e.target;

        const sourceNode = nodes.find((n) => n.id === sourceNodeId);
        const targetNode = nodes.find((n) => n.id === targetNodeId);

        let sourcePortId = e.sourcePort;
        if (e.source === 'self') {
          sourcePortId = stableId('port', e.sourcePort);
        } else {
          if (sourceNode) {
            const srcPort =
              sourceNode.ports.find(
                (p) =>
                  (p.name === e.sourcePort ||
                    (p as DiagramPort & { rawName?: string }).rawName === e.sourcePort) &&
                  p.direction !== 'input',
              ) ||
              sourceNode.ports.find(
                (p) =>
                  p.name === e.sourcePort ||
                  (p as DiagramPort & { rawName?: string }).rawName === e.sourcePort,
              );
            if (srcPort) sourcePortId = srcPort.id;
          }
        }

        let targetPortId = e.targetPort;
        if (e.target === 'self') {
          targetPortId = stableId('port', e.targetPort);
        } else {
          if (targetNode) {
            const tgtPort =
              targetNode.ports.find(
                (p) =>
                  (p.name === e.targetPort ||
                    (p as DiagramPort & { rawName?: string }).rawName === e.targetPort) &&
                  p.direction !== 'output',
              ) ||
              targetNode.ports.find(
                (p) =>
                  p.name === e.targetPort ||
                  (p as DiagramPort & { rawName?: string }).rawName === e.targetPort,
              );
            if (tgtPort) targetPortId = tgtPort.id;
          }
        }

        const isInterfaceInstanceSource =
          sourceNode?.kind === 'interface' &&
          sourceNode.metadata?.role !== 'modport' &&
          sourceNode.metadata?.role !== 'port';
        const isInterfaceInstanceTarget =
          targetNode?.kind === 'interface' &&
          targetNode.metadata?.role !== 'modport' &&
          targetNode.metadata?.role !== 'port';

        const duplicateEndpointSignal = (rawMod.edges || []).some(
          (other, otherIndex) =>
            otherIndex !== i &&
            other.source === e.source &&
            other.target === e.target &&
            (other.signal || '') === (e.signal || ''),
        );
        const edgeLabel = duplicateEndpointSignal
          ? stableId(e.signal || i.toString(), sourcePortId, targetPortId)
          : e.signal || i.toString();

        const isStructComposition =
          sourceNode?.kind === 'struct' && sourceNode?.metadata?.role === 'composition';
        const srcPort = sourceNode?.ports.find((p) => p.id === sourcePortId);
        const tgtPort = targetNode?.ports.find((p) => p.id === targetPortId);
        const hasStructTypedPort = (node: DiagramNode | undefined) =>
          node?.kind === 'port' &&
          node.ports.some((p) => p.typeName && !p.modportName && structTypeNames.has(p.typeName));
        const nodeIsStructTyped = (node: DiagramNode | undefined) => {
          const typeName = node?.typeName ?? node?.metadata?.typeName;
          return Boolean(typeName && structTypeNames.has(typeName));
        };
        const targetIsStructTyped =
          Boolean(tgtPort?.typeName && structTypeNames.has(tgtPort.typeName)) ||
          hasStructTypedPort(targetNode) ||
          nodeIsStructTyped(targetNode);
        // SV semantics: assigning a struct composition to a plain vector
        // is an implicit cast — struct styling only continues while the
        // receiving declaration is itself struct-typed.
        const isStructEdge = isStructComposition
          ? targetIsStructTyped
          : (srcPort?.typeName && structTypeNames.has(srcPort.typeName)) ||
            (tgtPort?.typeName && structTypeNames.has(tgtPort.typeName)) ||
            hasStructTypedPort(sourceNode) ||
            hasStructTypedPort(targetNode);

        const edge: DiagramEdge = {
          id: edgeId(sourceNodeId, targetNodeId, edgeLabel),
          source: sourceNodeId,
          target: targetNodeId,
          sourcePort: sourcePortId,
          targetPort: targetPortId,
          signal: e.signal,
          width: e.width,
          isStacked: e.isStacked || undefined,
          sourceRange: e.sourceRange
            ? {
                file: path.relative(workspaceRoot, e.sourceRange.file),
                startLine: e.sourceRange.line,
                startColumn: e.sourceRange.col,
                endLine: e.sourceRange.endLine,
                endColumn: e.sourceRange.endCol,
              }
            : undefined,
          metadata: {
            ...e.metadata,
            aggregate:
              (isInterfaceInstanceSource || isInterfaceInstanceTarget) &&
              e.source !== 'self' &&
              e.target !== 'self'
                ? 'interface'
                : isStructEdge
                  ? 'struct'
                  : // The backend stamps struct by signal name; a composition
                    // feeding a plain vector is an implicit cast, so drop it.
                    isStructComposition && !targetIsStructTyped
                    ? undefined
                    : e.metadata?.aggregate,
          },
        };
        return edge;
      }),
    };
    for (const node of module.nodes) {
      if (node.kind === 'replicate' || node.kind === 'select') {
        for (const port of node.ports) {
          if (port.direction === 'input' && port.connectedSignal) {
            const declaredWidth =
              module.ports.find((modulePort) => modulePort.name === port.connectedSignal)?.width ??
              findDeclaredWidth(sourceTextCache, rawMod.file, port.connectedSignal);
            if (declaredWidth && (!port.width || port.width === '[0:0]')) {
              port.width = declaredWidth;
            }
          }
        }
      }

      if (node.kind === 'latch' && node.metadata?.inferred) {
        graph.diagnostics.push({
          severity: 'warning',
          message:
            `${modName}.${node.label} inferred latch from incomplete ` + `combinational assignment`,
          source: node.source,
        });
      }

      // Mirrors the inferred-latch warning above: the backend synthesizes a
      // register-kind node standing in for a declared array/memory that's
      // read somewhere but never procedurally written, so its "in" port has
      // a source to connect to instead of dangling. Surface why that stand-in
      // exists rather than leaving it looking like an ordinary register.
      if (node.kind === 'register' && node.metadata?.isArrayNode && node.metadata?.inferred) {
        graph.diagnostics.push({
          severity: 'warning',
          message: `${modName}.${node.label}: ${node.metadata.reason ?? 'declared but never written'}`,
          source: node.source,
        });
      }
    }

    for (const edge of module.edges) {
      const sourceNode = module.nodes.find((node) => node.id === edge.source);
      const sourcePort = sourceNode?.ports.find(
        (port) => port.id === edge.sourcePort || port.name === edge.sourcePort,
      );
      if (sourcePort?.width) {
        edge.width = sourcePort.width;
      }
    }

    // The backend stamps combFeedback on edges that close a purely
    // combinational cycle (no register/latch in the loop) — e.g. a
    // cross-coupled NAND SR latch. Surface one warning per independent loop,
    // mirroring the inferred-latch warning above; the loop still renders as a
    // normal cyclic (feedback) edge.
    {
      const feedbackEdges = module.edges.filter((edge) => edge.metadata?.combFeedback);
      const loopOf = new Map<string, string>();
      const findLoop = (id: string): string => {
        let root = id;
        while (loopOf.get(root) !== root) root = loopOf.get(root)!;
        return root;
      };
      for (const edge of feedbackEdges) {
        for (const id of [edge.source, edge.target]) {
          if (!loopOf.has(id)) loopOf.set(id, id);
        }
        loopOf.set(findLoop(edge.source), findLoop(edge.target));
      }
      const loops = new Map<string, DiagramEdge[]>();
      for (const edge of feedbackEdges) {
        const root = findLoop(edge.source);
        loops.set(root, [...(loops.get(root) ?? []), edge]);
      }
      for (const loopEdges of loops.values()) {
        const signals = [...new Set(loopEdges.map((edge) => edge.signal).filter(Boolean))];
        graph.diagnostics.push({
          severity: 'warning',
          message:
            `${modName} has a combinational feedback loop` +
            (signals.length ? ` through ${signals.join(', ')}` : ''),
          source: loopEdges[0].sourceRange,
        });
      }
    }

    if (rawFunctions.has(rawMod) || rawTasks.has(rawMod)) {
      const callable = rawMod as RawCallable;
      const callableKind = rawFunctions.has(rawMod) ? 'function' : 'task';
      const callableName = callableKind === 'function' ? callable.functionName : callable.taskName;
      const designCallable: DesignCallable = {
        ...module,
        parentModule: callable.parentModule.replace(/^work@/, ''),
        callableName: (callableName ?? modName.split('.').pop() ?? modName).replace(/^work@/, ''),
        callableKind,
      };
      if (callableKind === 'function') graph.functions![modName] = designCallable;
      else graph.tasks![modName] = designCallable;
    } else {
      graph.modules[modName] = module;
    }
  }

  if (raw.rootModules) {
    graph.rootModules = raw.rootModules.map((m) => m.replace(/^work@/, ''));
  } else {
    const instantiated = new Set<string>();
    for (const m of Object.values(graph.modules)) {
      for (const n of m.nodes) {
        if (n.kind === 'instance' && n.instanceOf) instantiated.add(n.instanceOf);
      }
    }
    graph.rootModules = Object.keys(graph.modules).filter((m) => !instantiated.has(m));
  }

  return orderGraphModules(graph);
}
