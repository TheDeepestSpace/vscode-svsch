import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignGraph } from '../ir/types';
import { extractDesignWithUhdm } from './uhdmExtractor';
import { logger } from '../logger';

export interface ParserOptions {
  workspaceRoot: string;
  projectFolder: string;
  backend: 'uhdm';
  veriblePath: string;
  surelogPath?: string;
  backendPath?: string;
  includePaths?: string[];
  defines?: Record<string, string>;
  moduleName?: string;
  listOnly?: boolean;
  onProgress?: (message: string, increment: number) => void;
  overlays?: Array<{
    file: string;
    text: string;
  }>;
  includeExternalDiagnostics?: boolean;
  // Workspace-relative path to a Surelog filelist (-f). When set, this overrides
  // folder-based source selection entirely: collectHdlFiles's directory walk (and its
  // auto include-path detection) is skipped, and Surelog is invoked with `-f <path>`
  // instead of a positional file list.
  fileList?: string;
}

export async function buildDesignGraph(options: ParserOptions): Promise<DesignGraph> {
  let graph: DesignGraph = {
    rootModules: [],
    modules: {},
    functions: {},
    tasks: {},
    diagnostics: [],
    generatedAt: new Date().toISOString(),
  };

  let sources: string[];
  let headers: string[] = [];
  let fileListPath: string | undefined;

  if (options.fileList) {
    fileListPath = path.resolve(options.workspaceRoot, options.fileList);
    if (!(await fileExists(fileListPath))) {
      graph.diagnostics.push({
        severity: 'error',
        message: `svsch.fileList points to a nonexistent file: ${options.fileList}`,
      });
      return graph;
    }
    sources = await parseFileList(fileListPath);
  } else {
    const projectRoot = path.resolve(options.workspaceRoot, options.projectFolder || '.');
    const collected = await collectHdlFiles(projectRoot);
    sources = collected.sources;
    headers = collected.headers;
  }

  if (sources.length === 0) {
    graph.diagnostics.push({
      severity: 'warning',
      message: options.fileList
        ? `No source files found in file list ${options.fileList}.`
        : `No SystemVerilog or Verilog source files found in ${options.projectFolder || '.'}.`,
    });
    return graph;
  }

  // Only use UHDM backend, no fallbacks
  if (!options.surelogPath || !options.backendPath) {
    graph.diagnostics.push({
      severity: 'error',
      message: 'UHDM backend requires surelogPath and backendPath to be configured.',
    });
    return graph;
  }

  // Automatically add directories containing headers to include paths (folder-walk mode only;
  // fileList mode never walks, so this can't apply — users must supply their own -I/+incdir+).
  const autoIncludePaths = Array.from(new Set(headers.map((h) => path.dirname(h))));
  const allIncludePaths = [...(options.includePaths || []), ...autoIncludePaths];

  try {
    graph = await extractDesignWithUhdm(
      sources,
      options.workspaceRoot,
      options.surelogPath,
      options.backendPath,
      allIncludePaths,
      options.defines,
      options.listOnly ? '--list-only' : options.moduleName,
      options.onProgress,
      fileListPath,
    );
  } catch (e: any) {
    logger.error('UHDM Extraction Crashed', e);
    graph.diagnostics.push({
      severity: 'error',
      message: `UHDM extraction crashed: ${e.message}`,
    });
  }

  return graph;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Minimal Surelog filelist parser: extracts the listed source paths purely for cache
// fingerprinting and the "no sources found" check. Surelog itself still receives the raw
// `-f <path>` flag and does its own (fuller) parsing of the file. Lines are one path per
// line; blank lines, `#`/`//` comments, and flag/define directives (`-I`, `+incdir+`, etc.)
// are skipped since those aren't source files. Relative paths resolve against the filelist's
// own directory, matching how Surelog itself resolves paths inside a filelist.
async function parseFileList(fileListPath: string): Promise<string[]> {
  const dir = path.dirname(fileListPath);
  const content = await fs.readFile(fileListPath, 'utf-8');
  const sources: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.startsWith('-') || line.startsWith('+')) continue;
    sources.push(path.isAbsolute(line) ? line : path.resolve(dir, line));
  }

  return sources.sort();
}

async function collectHdlFiles(root: string): Promise<{ sources: string[]; headers: string[] }> {
  const sources: string[] = [];
  const headers: string[] = [];
  const SRC_EXT = new Set(['.sv', '.v']);
  const HDR_EXT = new Set(['.svh', '.vh']);

  async function walk(dir: string): Promise<void> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svsch') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = path.extname(entry.name);
        if (SRC_EXT.has(ext)) {
          sources.push(fullPath);
        } else if (HDR_EXT.has(ext)) {
          headers.push(fullPath);
        }
      }
    }
  }

  await walk(root);
  return {
    sources: sources.sort(),
    headers: headers.sort(),
  };
}
