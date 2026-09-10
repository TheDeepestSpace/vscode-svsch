import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { DesignGraph, DiagramViewModel } from '../ir/types';
import { buildViewModel } from '../layout/mergeLayout';
import { applyExpandedInstances } from '../layout/expandSpliceView';
import { buildDesignGraph, type ParserOptions } from '../parser/backend';
import type { SavedLayout, SavedModuleLayout } from '../storage/layoutStore';

export interface RenderDiagramOptions {
  layoutFile?: string;
  topModule?: string;
  noLayout?: boolean;
  workspaceRoot?: string;
  projectFolder?: string;
  /**
   * Directory containing the `layouts/` subfolder written by the VS Code
   * extension's LayoutStore (i.e. the `.svsch` directory itself). Defaults to
   * `<workspaceRoot>/.svsch` so users don't need to spell out the full path
   * to a specific module's layout file.
   */
  svschDataDir?: string;
  surelogPath?: string;
  backendPath?: string;
  includePaths?: string[];
  defines?: Record<string, string>;
  onProgress?: ParserOptions['onProgress'];
}

export interface RenderedModule {
  view: DiagramViewModel;
  /** Absolute path of the layout file that was used, if any was found. */
  layoutSource?: string;
}

const EMPTY_LAYOUT: SavedLayout = { version: 1, modules: {} };

export async function renderDiagram(
  svFile: string,
  opts: RenderDiagramOptions = {},
): Promise<DiagramViewModel> {
  const svFilePath = path.resolve(svFile);
  await assertReadableFile(svFilePath);

  const { workspaceRoot, projectFolder } = resolveProjectScope(svFilePath, opts);
  const graph = await buildDesignGraph({
    workspaceRoot,
    projectFolder,
    backend: 'uhdm',
    veriblePath: 'verible-verilog-syntax',
    surelogPath: resolveSurelogPath(opts.surelogPath),
    backendPath: resolveBackendPath(opts.backendPath),
    includePaths: opts.includePaths,
    defines: opts.defines,
    includeExternalDiagnostics: true,
    onProgress: opts.onProgress,
  });

  const rendered = await renderModuleFromGraph(graph, svFilePath, workspaceRoot, opts);
  return rendered.view;
}

export async function renderModuleFromGraph(
  graph: DesignGraph,
  svFilePath: string,
  workspaceRoot: string,
  opts: RenderDiagramOptions,
): Promise<RenderedModule> {
  let moduleName = opts.topModule;
  if (moduleName) {
    if (!graph.modules[moduleName]) {
      throw new Error(`Top module "${moduleName}" not found in project graph.`);
    }
  } else {
    // Try to find modules defined in the input file within the graph
    const modulesInFile = Object.values(graph.modules).filter(
      (m) => path.resolve(workspaceRoot, m.file) === svFilePath,
    );
    if (modulesInFile.length > 0) {
      const rootsInFile = modulesInFile.filter((m) => graph.rootModules.includes(m.name));
      moduleName = rootsInFile[0]?.name ?? modulesInFile[0].name;
    } else {
      // If the input file has no modules in the graph (e.g. excluded by project folder),
      // and no explicit top module was requested, error out instead of picking an unrelated module.
      throw new Error(
        `No modules from "${path.basename(svFilePath)}" were found in the project graph. ` +
          `Check --project-folder or --workspace.`,
      );
    }
  }

  const {
    layout,
    source: layoutSource,
    svschDir,
  } = opts.noLayout
    ? { layout: EMPTY_LAYOUT, source: undefined, svschDir: undefined }
    : readLayoutForFileSync(
        svFilePath,
        workspaceRoot,
        moduleName,
        opts.layoutFile,
        opts.svschDataDir,
      );

  let view = await buildViewModel(graph, moduleName, layout);
  if (svschDir) {
    // A spliced sub-diagram mirrors the child module's own saved diagram,
    // expansions included (recursively) — pull in the layouts of every module
    // the expand chain reaches, not just the top module's own file.
    const closureLayout = loadExpandedLayoutClosureSync(layout, graph, svschDir, moduleName);
    view = await applyExpandedInstances({ graph, layout: closureLayout, view });
  }
  return { view, layoutSource };
}

export function resolveProjectScope(
  svFilePath: string,
  opts: RenderDiagramOptions,
): { workspaceRoot: string; projectFolder: string } {
  if (opts.workspaceRoot || opts.projectFolder) {
    const workspaceRoot = path.resolve(opts.workspaceRoot ?? process.cwd());
    return {
      workspaceRoot,
      projectFolder:
        opts.projectFolder ?? relativeProjectFolder(workspaceRoot, path.dirname(svFilePath)),
    };
  }

  const cwd = process.cwd();
  const projectFolder = relativeProjectFolder(cwd, path.dirname(svFilePath));
  if (projectFolder.startsWith('..') || path.isAbsolute(projectFolder)) {
    return { workspaceRoot: path.dirname(svFilePath), projectFolder: '.' };
  }
  return { workspaceRoot: cwd, projectFolder };
}

export { buildDesignGraph };
export { resolveSignalSource, SourceRangeIndex } from './sourceResolution';

async function assertReadableFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath).catch((error) => {
    throw new Error(`Unable to read ${filePath}: ${(error as Error).message}`);
  });
  if (!stat.isFile()) {
    throw new Error(`Expected a SystemVerilog file, got ${filePath}`);
  }
}

function readLayoutForFileSync(
  svFilePath: string,
  workspaceRoot: string,
  moduleName: string,
  explicitLayoutFile?: string,
  svschDataDir?: string,
): { layout: SavedLayout; source?: string; svschDir?: string } {
  if (explicitLayoutFile) {
    const resolved = path.resolve(explicitLayoutFile);
    return { layout: readLayoutSync(resolved), source: resolved };
  }

  // The VS Code extension saves each module's live layout under
  // <svschDataDir>/layouts/<module>.json (see LayoutStore, default
  // svschDataDir is `<workspaceRoot>/.svsch`) — check that ahead of the
  // legacy sidecar/monolithic candidates so a plain `svsch render` picks up
  // whatever the user last dragged in the diagram, same as before the split.
  const svschDir = svschDataDir ? path.resolve(svschDataDir) : path.join(workspaceRoot, '.svsch');
  const splitLayoutPath = path.join(svschDir, 'layouts', `${encodeURIComponent(moduleName)}.json`);
  if (fsSync.existsSync(splitLayoutPath)) {
    return {
      layout: readSplitModuleLayoutSync(splitLayoutPath, moduleName),
      source: splitLayoutPath,
      svschDir,
    };
  }

  const ext = path.extname(svFilePath);
  const stem = ext ? svFilePath.slice(0, -ext.length) : svFilePath;
  const candidates = uniquePaths([
    `${stem}.svsch-layout.json`,
    `${svFilePath}.svsch-layout.json`,
    path.join(svschDir, 'layout.json'),
    path.join(process.cwd(), '.svsch', 'layout.json'),
  ]);

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return { layout: readLayoutSync(candidate), source: candidate, svschDir };
    }
  }

  return { layout: EMPTY_LAYOUT, source: undefined, svschDir };
}

function readLayoutSync(layoutFile: string): SavedLayout {
  try {
    const raw = fsSync.readFileSync(layoutFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedLayout>;
    return {
      version: 1,
      modules: parsed.modules ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY_LAYOUT;
    }
    throw new Error(`Unable to read layout ${layoutFile}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function readSplitModuleLayoutSync(layoutFile: string, moduleName: string): SavedLayout {
  try {
    const raw = fsSync.readFileSync(layoutFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedModuleLayout>;
    return {
      version: 1,
      modules: { [moduleName]: { ...parsed, nodes: parsed.nodes ?? {} } },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return EMPTY_LAYOUT;
    }
    throw new Error(`Unable to read layout ${layoutFile}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Extends an already-read layout with the saved layouts of every module the
 * expand chain reaches: starting from the rendered module, each module whose
 * `expanded` flags point at further child modules pulls those children's
 * `<svschDir>/layouts/<module>.json` files in too, so
 * `applyExpandedInstances`' recursion (see buildExpandSpliceLayout) sees the
 * same per-module state the live extension holds in memory.
 */
function loadExpandedLayoutClosureSync(
  layout: SavedLayout,
  graph: DesignGraph,
  svschDir: string,
  rootModule: string,
): SavedLayout {
  const modules = { ...layout.modules };
  const visited = new Set<string>();
  const queue = [rootModule];
  while (queue.length > 0) {
    const moduleName = queue.shift()!;
    if (visited.has(moduleName)) {
      continue;
    }
    visited.add(moduleName);
    const module = graph.modules[moduleName];
    if (!module) {
      continue;
    }
    if (!modules[moduleName]) {
      const layoutFile = path.join(svschDir, 'layouts', `${encodeURIComponent(moduleName)}.json`);
      const read = readSplitModuleLayoutSync(layoutFile, moduleName).modules[moduleName];
      if (read) {
        modules[moduleName] = read;
      }
    }
    const expanded = modules[moduleName]?.expanded ?? {};
    for (const instanceId of Object.keys(expanded)) {
      if (!expanded[instanceId]) {
        continue;
      }
      const node = module.nodes.find((candidate) => candidate.id === instanceId);
      if (node?.kind === 'instance' && node.moduleName) {
        queue.push(node.moduleName);
      }
    }
  }
  return { version: 1, modules };
}

function relativeProjectFolder(workspaceRoot: string, projectDir: string): string {
  const relative = path.relative(workspaceRoot, projectDir);
  return relative.length > 0 ? relative : '.';
}

export function resolveBackendPath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return (
    findBundledFile(['dist', 'svsch_backend']) ??
    findBundledFile(['svsch_backend']) ??
    'svsch_backend'
  );
}

export function resolveSurelogPath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return (
    findBundledFile(['dist', 'surelog', 'bin', 'surelog']) ??
    findBundledFile(['surelog', 'bin', 'surelog']) ??
    'surelog'
  );
}

function findBundledFile(relativeParts: string[]): string | undefined {
  const starts = uniquePaths(
    [
      process.cwd(),
      typeof __dirname === 'string' ? __dirname : undefined,
      path.dirname(process.execPath),
    ].filter((candidate): candidate is string => Boolean(candidate)),
  );

  for (const start of starts) {
    const found = findUp(start, relativeParts);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findUp(start: string, relativeParts: string[]): string | undefined {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ...relativeParts);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((candidate) => path.resolve(candidate))));
}
